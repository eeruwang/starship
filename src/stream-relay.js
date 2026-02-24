/**
 * StreamRelay Durable Object
 *
 * Maintains persistent WebSocket connections to Fediverse instances and
 * fans out real-time events to all connected browser tabs.
 *
 * Architecture:
 *   Browser Tab A ─┐                    ┌─ wss://mastodon.social/streaming
 *   Browser Tab B ─┼── DO (per-user) ───┼─ wss://misskey.io/streaming
 *   Browser Tab C ─┘                    └─ wss://iceshrimp.dev/streaming
 *
 * One DO instance per authenticated user (keyed by user ID).
 * The Worker authenticates via session cookie before forwarding to the DO.
 *
 * Protocol (client ↔ DO):
 *   Client → DO:
 *     { type: "subscribe", accounts: [{ id, instanceUrl, accessToken, platform }], since?: timestamp }
 *     { type: "unsubscribe", accountId: "..." }
 *     { type: "ping" }
 *
 *   DO → Client:
 *     { type: "event", accountId, platform, raw: <original message>, timestamp }
 *     { type: "connected", accountId }
 *     { type: "disconnected", accountId }
 *     { type: "pong" }
 */

const BUFFER_SIZE = 50;               // recent events per account
const IDLE_TIMEOUT = 5 * 60 * 1000;   // 5 min with no clients → close upstreams
const HEARTBEAT_INTERVAL = 30_000;     // 30s
const STALE_THRESHOLD = 90_000;        // 90s without activity → reconnect

export class StreamRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // Downstream: browser tab WebSockets
    // Map<WebSocket, { subscriptions: Set<accountId> }>
    this.clients = new Map();

    // Upstream: Fediverse instance WebSockets
    // Map<accountId, UpstreamState>
    this.upstreams = new Map();

    // Recent event buffer for catch-up on reconnect
    // Map<accountId, Array<{ type, accountId, platform, raw, timestamp }>>
    this.eventBuffer = new Map();

    this.idleTimer = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);

    serverWs.accept();

    const clientState = { subscriptions: new Set() };
    this.clients.set(serverWs, clientState);

    // Cancel idle shutdown
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Inform new client of already-connected upstreams
    for (const [accountId, upstream] of this.upstreams) {
      if (upstream.connected) {
        this._sendTo(serverWs, { type: 'connected', accountId });
      }
    }

    serverWs.addEventListener('message', (event) => {
      this._onClientMessage(serverWs, clientState, event.data);
    });

    serverWs.addEventListener('close', () => {
      this._onClientClose(serverWs, clientState);
    });

    serverWs.addEventListener('error', () => {
      this._onClientClose(serverWs, clientState);
    });

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  // ===== Client message handling =====

  _onClientMessage(ws, clientState, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'subscribe' && Array.isArray(msg.accounts)) {
      for (const account of msg.accounts) {
        if (!account.id || !account.instanceUrl || !account.accessToken || !account.platform) continue;
        clientState.subscriptions.add(account.id);
        this._ensureUpstream(account);
      }
      // Send buffered events for catch-up
      if (msg.since) {
        this._sendBuffered(ws, clientState, msg.since);
      }
    } else if (msg.type === 'unsubscribe' && msg.accountId) {
      clientState.subscriptions.delete(msg.accountId);
      this._maybeCloseUpstream(msg.accountId);
    } else if (msg.type === 'status') {
      // Report upstream connection status for all subscribed accounts
      const statuses = {};
      for (const accountId of clientState.subscriptions) {
        const upstream = this.upstreams.get(accountId);
        statuses[accountId] = upstream?.connected || false;
      }
      this._sendTo(ws, { type: 'status', accounts: statuses });
    } else if (msg.type === 'ping') {
      this._sendTo(ws, { type: 'pong' });
    }
  }

  _onClientClose(ws, clientState) {
    this.clients.delete(ws);

    // Close upstreams that no longer have subscribers
    for (const accountId of clientState.subscriptions) {
      this._maybeCloseUpstream(accountId);
    }

    // Start idle timer if no clients remain
    if (this.clients.size === 0) {
      this.idleTimer = setTimeout(() => {
        this._closeAllUpstreams();
      }, IDLE_TIMEOUT);
    }
  }

  // ===== Upstream (Fediverse instance) management =====

  _ensureUpstream(account) {
    const existing = this.upstreams.get(account.id);
    if (existing) {
      // Reconnect if access token changed
      if (existing.account.accessToken !== account.accessToken) {
        this._closeUpstream(account.id);
        this._openUpstream(account);
      } else {
        existing.account = account;
      }
      return;
    }
    this._openUpstream(account);
  }

  _openUpstream(account) {
    const state = {
      account,
      ws: null,
      connected: false,
      reconnectTimer: null,
      reconnectDelay: 2000,
      heartbeatTimer: null,
      lastActivity: null,
      awaitingPong: false,
      pongSupported: false,
    };
    this.upstreams.set(account.id, state);

    if (!this.eventBuffer.has(account.id)) {
      this.eventBuffer.set(account.id, []);
    }

    this._connectUpstream(state);
  }

  async _connectUpstream(state) {
    const { account } = state;
    const host = new URL(account.instanceUrl).host;
    let wsUrl;

    if (account.platform === 'mastodon') {
      wsUrl = `wss://${host}/api/v1/streaming?access_token=${encodeURIComponent(account.accessToken)}&stream=user`;
    } else {
      wsUrl = `wss://${host}/streaming?i=${encodeURIComponent(account.accessToken)}`;
    }

    try {
      const resp = await fetch(wsUrl, {
        headers: { 'Upgrade': 'websocket' },
      });

      const ws = resp.webSocket;
      if (!ws) {
        this._scheduleUpstreamReconnect(state);
        return;
      }

      ws.accept();
      state.ws = ws;
      state.connected = true;
      state.lastActivity = Date.now();
      state.reconnectDelay = 2000;
      state.awaitingPong = false;
      state.pongSupported = false;

      // Misskey/Iceshrimp/CherryPick: subscribe to channels
      if (account.platform !== 'mastodon') {
        ws.send(JSON.stringify({ type: 'connect', body: { channel: 'homeTimeline', id: 'ht' } }));
        ws.send(JSON.stringify({ type: 'connect', body: { channel: 'main', id: 'mn' } }));
      }

      // Notify subscribed clients
      this._broadcastToSubscribers(account.id, {
        type: 'connected', accountId: account.id,
      });

      this._startHeartbeat(state);

      ws.addEventListener('message', (event) => {
        state.lastActivity = Date.now();
        state.awaitingPong = false;

        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') {
            state.pongSupported = true;
            return;
          }

          const eventData = {
            type: 'event',
            accountId: account.id,
            platform: account.platform,
            raw: msg,
            timestamp: Date.now(),
          };

          this._bufferEvent(account.id, eventData);
          this._broadcastToSubscribers(account.id, eventData);
        } catch {
          // non-JSON (protocol-level ping frames, etc.)
        }
      });

      ws.addEventListener('close', () => {
        state.ws = null;
        state.connected = false;
        this._stopHeartbeat(state);
        this._broadcastToSubscribers(account.id, {
          type: 'disconnected', accountId: account.id,
        });

        // Reconnect if still tracked
        if (this.upstreams.has(account.id)) {
          this._scheduleUpstreamReconnect(state);
        }
      });

      ws.addEventListener('error', () => {
        // close event follows — reconnection handled there
      });
    } catch (e) {
      this._scheduleUpstreamReconnect(state);
    }
  }

  _scheduleUpstreamReconnect(state) {
    if (state.reconnectTimer) return;

    // Don't reconnect if no clients need this upstream
    let needed = false;
    for (const [, cs] of this.clients) {
      if (cs.subscriptions.has(state.account.id)) { needed = true; break; }
    }
    if (!needed) return;

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, 60000);
      this._connectUpstream(state);
    }, state.reconnectDelay);
  }

  _maybeCloseUpstream(accountId) {
    // Keep upstream alive if any client is still subscribed
    for (const [, cs] of this.clients) {
      if (cs.subscriptions.has(accountId)) return;
    }
    this._closeUpstream(accountId);
  }

  _closeUpstream(accountId) {
    const state = this.upstreams.get(accountId);
    if (!state) return;

    this._stopHeartbeat(state);
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.ws) {
      try { state.ws.close(); } catch {}
      state.ws = null;
    }
    this.upstreams.delete(accountId);
  }

  _closeAllUpstreams() {
    for (const accountId of [...this.upstreams.keys()]) {
      this._closeUpstream(accountId);
    }
    this.eventBuffer.clear();
  }

  // ===== Heartbeat (upstream health) =====

  _startHeartbeat(state) {
    this._stopHeartbeat(state);

    state.heartbeatTimer = setInterval(() => {
      if (!state.ws || !state.connected) return;

      const now = Date.now();

      // Misskey: check pong from previous tick
      if (state.account.platform !== 'mastodon' && state.awaitingPong && state.pongSupported) {
        this._forceReconnectUpstream(state);
        return;
      }

      // Send application-level ping
      try {
        state.ws.send('{"type":"ping"}');
        if (state.account.platform !== 'mastodon') {
          state.awaitingPong = true;
          if (!state.pongSupported) state.lastActivity = now;
        } else {
          state.lastActivity = now;
        }
      } catch {
        this._forceReconnectUpstream(state);
        return;
      }

      // Stale connection check
      if (state.lastActivity && now - state.lastActivity > STALE_THRESHOLD) {
        this._forceReconnectUpstream(state);
      }
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat(state) {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  _forceReconnectUpstream(state) {
    this._stopHeartbeat(state);
    if (state.ws) {
      try { state.ws.close(); } catch {}
      state.ws = null;
    }
    state.connected = false;
    state.awaitingPong = false;
    state.pongSupported = false;

    this._broadcastToSubscribers(state.account.id, {
      type: 'disconnected', accountId: state.account.id,
    });

    state.reconnectDelay = 2000;
    this._scheduleUpstreamReconnect(state);
  }

  // ===== Event buffer =====

  _bufferEvent(accountId, event) {
    const buf = this.eventBuffer.get(accountId) || [];
    buf.push(event);
    if (buf.length > BUFFER_SIZE) buf.shift();
    this.eventBuffer.set(accountId, buf);
  }

  _sendBuffered(ws, clientState, sinceTimestamp) {
    for (const [accountId, buf] of this.eventBuffer) {
      if (!clientState.subscriptions.has(accountId)) continue;
      for (const event of buf) {
        if (event.timestamp >= sinceTimestamp) {
          this._sendTo(ws, event);
        }
      }
    }
  }

  // ===== Broadcasting =====

  _broadcastToSubscribers(accountId, message) {
    const raw = JSON.stringify(message);
    const failed = [];
    for (const [ws, clientState] of this.clients) {
      if (clientState.subscriptions.has(accountId)) {
        try { ws.send(raw); } catch { failed.push(ws); }
      }
    }
    for (const ws of failed) this.clients.delete(ws);
  }

  _sendTo(ws, message) {
    try { ws.send(JSON.stringify(message)); } catch {
      this.clients.delete(ws);
    }
  }
}
