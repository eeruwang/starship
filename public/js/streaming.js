/**
 * Streaming Manager
 * Real-time WebSocket connections to Fediverse instances.
 * - Misskey/Iceshrimp/CherryPick: wss://{host}/streaming?i={token}
 * - Mastodon: wss://{host}/api/v1/streaming?access_token={token}&stream=user
 */

export class StreamManager {
  constructor() {
    this.connections = new Map(); // accountId → ConnectionState
    this.listeners = new Map();   // event → Set<callback>
    this._heartbeatInterval = null;
    this._visibilityHandler = null;
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

        if (account.platform !== 'mastodon') {
          // Misskey: subscribe to homeTimeline + main (notifications)
          ws.send(JSON.stringify({
            type: 'connect',
            body: { channel: 'homeTimeline', id: 'ht' },
          }));
          ws.send(JSON.stringify({
            type: 'connect',
            body: { channel: 'main', id: 'mn' },
          }));
        }

        this._emit('connected', { accountId: account.id });
      };

      ws.onmessage = (event) => {
        state.lastActivity = Date.now();
        try {
          const msg = JSON.parse(event.data);
          // Misskey pong — just an activity signal, no further handling
          if (msg.type === 'pong') return;
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
      } else if (channelId === 'mn' && eventType === 'notification') {
        const notif = client.normalizeNotification(body);
        this._emit('notification', { account, notif });
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
      state.ws.close();
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
   * Start heartbeat interval if not already running.
   * Every 30s: sends Misskey ping and checks all connections for staleness.
   */
  _ensureHeartbeat() {
    if (this._heartbeatInterval) return;

    this._heartbeatInterval = setInterval(() => this._heartbeatTick(), 30_000);

    // Reconnect stale connections when tab becomes visible again
    if (!this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (document.visibilityState === 'visible') this._heartbeatTick();
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
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

      // Send Misskey application-level ping
      if (state.account.platform !== 'mastodon') {
        try { ws.send('{"type":"ping"}'); } catch { /* closing */ }
      }

      // Force reconnect if no activity for too long
      if (state.lastActivity && now - state.lastActivity > staleThreshold) {
        console.warn(`[Stream] Stale connection: ${state.account.label}, reconnecting`);
        ws.onclose = null;
        ws.close();
        state.ws = null;
        this._emit('disconnected', { accountId: state.account.id });
        state.reconnectDelay = 2000;
        this._scheduleReconnect(state);
      }
    }
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
