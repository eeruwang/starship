/**
 * Streaming Manager
 * Real-time WebSocket connections to Fediverse instances.
 * - Misskey/Iceshrimp/CherryPick: wss://{host}/streaming?i={token}
 * - Mastodon: wss://{host}/api/v1/streaming?access_token={token}&stream=user
 *
 * Mobile browser considerations (iOS Safari, Firefox iOS, etc.):
 * - iOS kills WebSocket connections when a tab is backgrounded.
 * - readyState can show OPEN on a dead "zombie" socket after resume.
 * - ws.send() on a zombie socket can crash Safari → wrap in try-catch.
 * - setInterval is fully frozen in background tabs on iOS.
 * - WiFi→cellular network transitions kill sockets silently (no close event).
 * - bfcache (back-forward cache) restores pages with dead sockets.
 * All of these are handled below via visibility/pageshow/online listeners.
 */

export class StreamManager {
  constructor() {
    this.connections = new Map(); // accountId → ConnectionState
    this.listeners = new Map();   // event → Set<callback>
    this._heartbeatInterval = null;
    this._visibilityHandler = null;
    this._pageshowHandler = null;
    this._pagehideHandler = null;
    this._onlineHandler = null;
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(callback);
  }

  off(event, callback) {
    this.listeners.get(event)?.delete(callback);
  }

  _emit(event, data) {
    const cbs = this.listeners.get(event);
    if (!cbs) return;
    for (const cb of cbs) {
      try { cb(data); } catch (e) { console.error('[Stream] listener error:', e); }
    }
  }

  connect(account, client) {
    if (this.connections.has(account.id)) return;

    const state = {
      account,
      client,
      ws: null,
      reconnectTimer: null,
      reconnectDelay: 2000,
      intentionalClose: false,
    };
    this.connections.set(account.id, state);
    this._open(state);
    this._ensureHeartbeat();
  }

  _open(state) {
    const { account } = state;

    try {
      const host = new URL(account.instanceUrl).host;
      let wsUrl;

      if (account.platform === 'mastodon') {
        wsUrl = `wss://${host}/api/v1/streaming?access_token=${encodeURIComponent(account.accessToken)}&stream=user`;
      } else {
        // Misskey, Iceshrimp, CherryPick
        wsUrl = `wss://${host}/streaming?i=${encodeURIComponent(account.accessToken)}`;
      }

      const ws = new WebSocket(wsUrl);
      state.ws = ws;

      ws.onopen = () => {
        console.log(`[Stream] Connected: ${account.label}`);
        state.reconnectDelay = 2000;
        state.lastActivity = Date.now();
        state.awaitingPong = false;
        state._pongSupported = false;  // re-detect per connection
        state._lastBuffered = null;

        if (account.platform !== 'mastodon') {
          // Misskey: subscribe to homeTimeline + main (notifications)
          this._safeSend(state, JSON.stringify({
            type: 'connect',
            body: { channel: 'homeTimeline', id: 'ht' },
          }));
          this._safeSend(state, JSON.stringify({
            type: 'connect',
            body: { channel: 'main', id: 'mn' },
          }));
        }

        this._emit('connected', { accountId: account.id });
      };

      ws.onmessage = (event) => {
        state.lastActivity = Date.now();
        state.awaitingPong = false;
        try {
          const msg = JSON.parse(event.data);
          // Misskey pong — mark this connection as pong-capable
          if (msg.type === 'pong') { state._pongSupported = true; return; }
          this._handleMessage(state, msg);
        } catch {
          // ignore non-JSON (ping frames, etc.)
        }
      };

      ws.onclose = () => {
        state.ws = null;
        if (!state.intentionalClose) {
          this._emit('disconnected', { accountId: account.id });
          this._scheduleReconnect(state);
        }
      };

      ws.onerror = (e) => {
        console.warn(`[Stream] Error: ${account.label}`, e);
        // onclose fires after onerror — reconnection handled there
      };
    } catch (e) {
      console.error(`[Stream] Connection failed: ${account.label}`, e);
      this._scheduleReconnect(state);
    }
  }

  /**
   * Safe send: wraps ws.send() in try-catch to protect against
   * Safari crashing on zombie sockets after iOS suspend/resume.
   */
  _safeSend(state, data) {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(data);
      return true;
    } catch {
      // Zombie socket — force reconnect
      console.warn(`[Stream] send() failed (zombie?): ${state.account.label}`);
      this._forceReconnect(state);
      return false;
    }
  }

  _handleMessage(state, msg) {
    const { account, client } = state;

    if (account.platform === 'mastodon') {
      this._handleMastodon(account, client, msg);
    } else {
      this._handleMisskey(account, client, msg);
    }
  }

  _handleMastodon(account, client, msg) {
    if (!msg.event) return;

    const parsePayload = () =>
      typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;

    try {
      if (msg.event === 'update') {
        const post = client.normalizePost(parsePayload());
        this._emit('post', { account, post });
      } else if (msg.event === 'notification') {
        const notif = client.normalizeNotification(parsePayload());
        this._emit('notification', { account, notif });
      } else if (msg.event === 'status.update') {
        const post = client.normalizePost(parsePayload());
        this._emit('postUpdate', { account, post });
      } else if (msg.event === 'delete') {
        this._emit('postDelete', { account, postId: msg.payload });
      } else {
        console.debug(`[Stream] ${account.label} unhandled event: ${msg.event}`);
      }
    } catch (e) {
      console.error(`[Stream] Mastodon parse error (${msg.event}):`, e);
    }
  }

  _handleMisskey(account, client, msg) {
    if (msg.type !== 'channel' || !msg.body) return;

    const { id: channelId, type: eventType, body } = msg.body;
    if (!body) return;

    try {
      if (channelId === 'ht' && eventType === 'note') {
        const post = client.normalizePost(body);
        this._emit('post', { account, post });
      } else if (channelId === 'mn') {
        if (eventType === 'notification') {
          const notif = client.normalizeNotification(body);
          this._emit('notification', { account, notif });
        } else if (eventType === 'mention' || eventType === 'reply') {
          // Misskey main channel sends mention/reply as raw notes in addition to
          // notification events. Emit as posts so they appear in timelines even if
          // the notification event is missing or delayed.
          const post = client.normalizePost(body);
          this._emit('post', { account, post });
        } else {
          // Log unhandled main-channel events for debugging
          console.debug(`[Stream] ${account.label} main:${eventType}`, body.type || body.id || '');
        }
      } else {
        console.debug(`[Stream] ${account.label} unhandled: ch=${channelId} ev=${eventType}`);
      }
    } catch (e) {
      console.error(`[Stream] Misskey parse error (${eventType}):`, e);
    }
  }

  _scheduleReconnect(state) {
    if (state.intentionalClose || state.reconnectTimer) return;

    const delay = state.reconnectDelay;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (!state.intentionalClose) {
        state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, 60000);
        this._open(state);
      }
    }, delay);
  }

  disconnect(accountId) {
    const state = this.connections.get(accountId);
    if (!state) return;

    state.intentionalClose = true;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.ws) {
      state.ws.onclose = null;
      try { state.ws.close(); } catch { /* zombie */ }
      state.ws = null;
    }
    this.connections.delete(accountId);
  }

  disconnectAll() {
    for (const id of [...this.connections.keys()]) {
      this.disconnect(id);
    }
    this._stopHeartbeat();
  }

  /**
   * Start heartbeat interval and lifecycle listeners if not already running.
   * Handles:
   * - 30s heartbeat for connection health
   * - visibilitychange: probe connections on tab resume
   * - pageshow: reconnect after bfcache restore
   * - pagehide: clean close for bfcache eligibility
   * - online: reconnect after network transitions (WiFi→cellular)
   */
  _ensureHeartbeat() {
    if (this._heartbeatInterval) return;

    this._heartbeatInterval = setInterval(() => this._heartbeatTick(), 30_000);

    // Tab visibility: probe and reconnect on resume
    if (!this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (document.visibilityState === 'visible') {
          // On iOS Safari, connections are guaranteed dead after background.
          // On desktop, they may be stale. Probe all connections.
          this._probeAllConnections();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }

    // bfcache: page restored from back-forward cache → sockets are dead
    if (!this._pageshowHandler) {
      this._pageshowHandler = (e) => {
        if (e.persisted) {
          console.log('[Stream] Restored from bfcache, reconnecting all');
          this._reconnectAll();
        }
      };
      window.addEventListener('pageshow', this._pageshowHandler);
    }

    // bfcache: close sockets cleanly so the page is bfcache-eligible
    if (!this._pagehideHandler) {
      this._pagehideHandler = () => {
        for (const state of this.connections.values()) {
          if (state.ws) {
            state.ws.onclose = null;
            try { state.ws.close(1000, 'pagehide'); } catch { /* zombie */ }
            state.ws = null;
          }
        }
      };
      window.addEventListener('pagehide', this._pagehideHandler);
    }

    // Network: WiFi→cellular kills sockets silently (no close event)
    if (!this._onlineHandler) {
      this._onlineHandler = () => {
        // Small delay for the network to stabilize
        setTimeout(() => this._probeAllConnections(), 1500);
      };
      window.addEventListener('online', this._onlineHandler);
    }
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._pageshowHandler) {
      window.removeEventListener('pageshow', this._pageshowHandler);
      this._pageshowHandler = null;
    }
    if (this._pagehideHandler) {
      window.removeEventListener('pagehide', this._pagehideHandler);
      this._pagehideHandler = null;
    }
    if (this._onlineHandler) {
      window.removeEventListener('online', this._onlineHandler);
      this._onlineHandler = null;
    }
  }

  _heartbeatTick() {
    const now = Date.now();
    const staleThreshold = 90_000; // 90 seconds without activity

    for (const state of this.connections.values()) {
      if (state.intentionalClose) continue;

      const ws = state.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Not connected — schedule reconnect if not already pending
        if (!state.reconnectTimer) this._scheduleReconnect(state);
        continue;
      }

      // Misskey-family: check pong response from last tick
      if (state.account.platform !== 'mastodon' && state.awaitingPong) {
        if (state._pongSupported) {
          // This server previously responded to pings — no pong means dead
          console.warn(`[Stream] No pong from: ${state.account.label}, reconnecting`);
          this._forceReconnect(state);
          continue;
        }
        // Server never sent a pong (e.g. Iceshrimp.NET) — don't force-
        // reconnect; fall through to the stale threshold check below.
        state.awaitingPong = false;
      }

      // Send application-level ping per platform
      if (state.account.platform !== 'mastodon') {
        // Misskey/Iceshrimp/CherryPick: JSON ping
        if (this._safeSend(state, '{"type":"ping"}')) {
          state.awaitingPong = true;
          // For forks that don't respond with pong, treat a successful
          // send as a liveness signal (same approach as Mastodon).
          if (!state._pongSupported) {
            state.lastActivity = now;
          }
        }
      } else {
        // Mastodon: no app-level ping/pong, but the server sends WebSocket-
        // level pings (invisible to JS onmessage). Probe the transport with
        // a small send to detect zombie sockets and update lastActivity so
        // the stale check below doesn't false-positive on quiet timelines.
        if (this._safeSend(state, '{"type":"ping"}')) {
          state.lastActivity = now;
        }
      }

      // Check for stuck socket (bufferedAmount growing = data not being sent)
      if (state._lastBuffered != null && ws.bufferedAmount >= state._lastBuffered && state._lastBuffered > 0) {
        console.warn(`[Stream] Socket stuck: ${state.account.label}, reconnecting`);
        this._forceReconnect(state);
        continue;
      }
      state._lastBuffered = ws.bufferedAmount;

      // Force reconnect if no activity for too long (covers both platforms)
      if (state.lastActivity && now - state.lastActivity > staleThreshold) {
        console.warn(`[Stream] Stale connection: ${state.account.label}, reconnecting`);
        this._forceReconnect(state);
      }
    }
  }

  /**
   * Probe all connections to detect zombie sockets (iOS Safari resume,
   * network transitions). Sends a probe ping per platform and checks
   * staleness. Connections that are clearly dead are reconnected immediately.
   */
  _probeAllConnections() {
    const now = Date.now();

    for (const state of this.connections.values()) {
      if (state.intentionalClose) continue;

      const ws = state.ws;

      // Already disconnected — reconnect
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        state.ws = null;
        if (!state.reconnectTimer) {
          state.reconnectDelay = 2000;
          this._scheduleReconnect(state);
        }
        continue;
      }

      // readyState says OPEN — but it may be a zombie (especially on iOS).
      // Send a probe to detect zombie sockets first. If send fails,
      // _safeSend triggers _forceReconnect automatically.
      const probeOk = this._safeSend(state, '{"type":"ping"}');
      if (!probeOk) continue; // already reconnecting

      // Successful send — update lastActivity for platforms without pong
      // (Mastodon, or Misskey forks that don't respond to pings)
      if (state.account.platform === 'mastodon' || !state._pongSupported) {
        state.lastActivity = now;
      }

      // Check how long since last activity.
      const sinceActivity = state.lastActivity ? now - state.lastActivity : Infinity;

      if (sinceActivity > 60_000) {
        // Over 60s with no activity — highly likely dead, force reconnect
        console.warn(`[Stream] Probe: stale ${state.account.label} (${Math.round(sinceActivity / 1000)}s), reconnecting`);
        this._forceReconnect(state);
        continue;
      }

      // For Misskey-family with pong support, expect a response
      if (state.account.platform !== 'mastodon' && state._pongSupported) {
        state.awaitingPong = true;
      }
    }
  }

  /**
   * Force reconnect all connections (e.g. after bfcache restore).
   */
  _reconnectAll() {
    for (const state of this.connections.values()) {
      if (state.intentionalClose) continue;
      this._forceReconnect(state);
    }
  }

  /** Close and immediately schedule reconnect for a connection */
  _forceReconnect(state) {
    const ws = state.ws;
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch { /* zombie socket — ignore */ }
    }
    state.ws = null;
    state.awaitingPong = false;
    state._pongSupported = false;  // re-detect on next connection
    state._lastBuffered = null;
    this._emit('disconnected', { accountId: state.account.id });
    state.reconnectDelay = 2000;
    this._scheduleReconnect(state);
  }

  isConnected(accountId) {
    const state = this.connections.get(accountId);
    return state?.ws?.readyState === WebSocket.OPEN;
  }

  get connectedCount() {
    let count = 0;
    for (const state of this.connections.values()) {
      if (state.ws?.readyState === WebSocket.OPEN) count++;
    }
    return count;
  }
}
