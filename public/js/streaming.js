/**
 * Streaming Manager
 * Real-time WebSocket connections to Fediverse instances.
 *
 * Two modes:
 *   1. Relay mode (preferred): Single WebSocket to the Durable Object relay
 *      at /api/stream. The DO maintains upstream connections to all Fediverse
 *      instances and fans out events. Benefits: shared across tabs, fewer
 *      connections to instances, event buffering on reconnect.
 *
 *   2. Direct mode (fallback): Each account gets its own WebSocket directly
 *      to its Fediverse instance. Used when the user is not logged in or
 *      the relay is unavailable.
 *
 * The public API (on/off/connect/disconnect/isConnected) is identical in
 * both modes. The StreamingMixin doesn't need to know which mode is active.
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
    this.listeners = new Map();   // event → Set<callback>

    // Account registry: accountId → { account, client }
    this._accounts = new Map();

    // Mode: null = undetermined, 'relay', 'direct'
    this._mode = null;
    this._intentionalClose = false;

    // --- Relay state ---
    this._relayWs = null;
    this._relayConnecting = false;
    this._relayReconnectTimer = null;
    this._relayReconnectDelay = 2000;
    this._relayPingInterval = null;
    this._relayConnectedAccounts = new Set();
    this._lastEventTimestamp = 0;

    // --- Direct state ---
    this._directConnections = new Map(); // accountId → ConnectionState

    // --- Lifecycle handlers ---
    this._heartbeatInterval = null;
    this._visibilityHandler = null;
    this._pageshowHandler = null;
    this._pagehideHandler = null;
    this._onlineHandler = null;
    this._lastHiddenAt = 0;
  }

  // ===== Event system =====

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

  // ===== Public API =====

  connect(account, client) {
    if (this._accounts.has(account.id)) return;
    this._accounts.set(account.id, { account, client });
    this._intentionalClose = false;

    if (this._mode === 'direct') {
      this._connectDirect(account, client);
    } else {
      // Try relay (first connect triggers mode detection)
      this._ensureRelay();
    }

    this._ensureLifecycle();
  }

  disconnect(accountId) {
    this._accounts.delete(accountId);
    this._relayConnectedAccounts.delete(accountId);

    // Notify relay
    if (this._relayWs?.readyState === WebSocket.OPEN) {
      try { this._relayWs.send(JSON.stringify({ type: 'unsubscribe', accountId })); } catch {}
    }

    // Close direct connection if any
    this._disconnectDirect(accountId);
  }

  disconnectAll() {
    this._intentionalClose = true;

    // Close relay
    this._closeRelay();

    // Close all direct connections
    for (const id of [...this._directConnections.keys()]) {
      this._disconnectDirect(id);
    }

    this._accounts.clear();
    this._relayConnectedAccounts.clear();
    this._mode = null;
    this._stopLifecycle();
  }

  isConnected(accountId) {
    if (this._mode === 'relay') {
      return this._relayConnectedAccounts.has(accountId);
    }
    const state = this._directConnections.get(accountId);
    return state?.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Detailed per-account connection status.
   * Returns 'connected' | 'connecting' | 'disconnected'.
   */
  getAccountStatus(accountId) {
    if (!this._accounts.has(accountId)) return 'disconnected';

    if (this._mode === 'relay') {
      if (this._relayConnectedAccounts.has(accountId)) return 'connected';
      if (this._relayWs?.readyState === WebSocket.OPEN || this._relayConnecting) return 'connecting';
      return 'disconnected';
    }

    if (this._mode === 'direct') {
      const state = this._directConnections.get(accountId);
      if (!state?.ws) return state?.reconnectTimer ? 'connecting' : 'disconnected';
      if (state.ws.readyState === WebSocket.OPEN) return 'connected';
      if (state.ws.readyState === WebSocket.CONNECTING) return 'connecting';
      return 'disconnected';
    }

    // Mode not yet determined (initial relay connection attempt)
    if (this._relayConnecting) return 'connecting';
    return 'disconnected';
  }

  get connectedCount() {
    if (this._mode === 'relay') {
      return this._relayConnectedAccounts.size;
    }
    let count = 0;
    for (const state of this._directConnections.values()) {
      if (state.ws?.readyState === WebSocket.OPEN) count++;
    }
    return count;
  }

  // ===== Relay mode =====

  _ensureRelay() {
    if (this._relayWs || this._relayConnecting) return;
    this._relayConnecting = true;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/api/stream`;

    try {
      const ws = new WebSocket(wsUrl);
      this._relayWs = ws;

      // Timeout: if not connected within 5s, fall back to direct
      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          console.warn('[Stream] Relay timeout, falling back to direct');
          ws.onclose = null;
          ws.onerror = null;
          try { ws.close(); } catch {}
          this._relayWs = null;
          this._relayConnecting = false;
          this._fallbackToDirect();
        }
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        this._relayConnecting = false;
        this._mode = 'relay';
        this._relayReconnectDelay = 2000;
        console.log('[Stream] Relay connected');

        // Subscribe all registered accounts
        const accounts = Array.from(this._accounts.values()).map(({ account }) => ({
          id: account.id,
          instanceUrl: account.instanceUrl,
          accessToken: account.accessToken,
          platform: account.platform,
        }));

        if (accounts.length > 0) {
          ws.send(JSON.stringify({
            type: 'subscribe',
            accounts,
            since: this._lastEventTimestamp || undefined,
          }));
          // Query upstream status periodically to sync connection states
          // and fall back to direct mode if relay upstreams never connect
          this._relayStatusFailCount = 0;
          this._relayStatusInterval = setInterval(() => {
            if (this._relayWs?.readyState === WebSocket.OPEN) {
              try { this._relayWs.send('{"type":"status"}'); } catch {}
            }
          }, 5000);
        }

        // Keep-alive ping every 30s
        this._relayPingInterval = setInterval(() => {
          if (this._relayWs?.readyState === WebSocket.OPEN) {
            try { this._relayWs.send('{"type":"ping"}'); } catch {}
          }
        }, 30_000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._handleRelayMessage(msg);
        } catch {}
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        this._relayWs = null;
        this._relayConnecting = false;
        this._clearRelayPing();
        if (this._relayStatusInterval) {
          clearInterval(this._relayStatusInterval);
          this._relayStatusInterval = null;
        }

        if (this._mode === null) {
          // Never connected — fall back to direct
          this._fallbackToDirect();
        } else if (!this._intentionalClose) {
          // Was working — try to reconnect
          // Mark all accounts as disconnected
          for (const accountId of this._relayConnectedAccounts) {
            this._emit('disconnected', { accountId });
          }
          this._relayConnectedAccounts.clear();
          this._scheduleRelayReconnect();
        }
      };

      ws.onerror = () => {
        // onclose fires after onerror
      };
    } catch {
      this._relayConnecting = false;
      this._fallbackToDirect();
    }
  }

  _handleRelayMessage(msg) {
    if (msg.type === 'event') {
      this._lastEventTimestamp = Math.max(this._lastEventTimestamp, msg.timestamp || 0);

      const data = this._accounts.get(msg.accountId);
      if (!data) return;

      const { account, client } = data;

      // Normalize using platform-specific client (same as direct mode)
      if (msg.platform === 'mastodon') {
        this._handleMastodon(account, client, msg.raw);
      } else {
        this._handleMisskey(account, client, msg.raw);
      }
    } else if (msg.type === 'connected') {
      this._relayConnectedAccounts.add(msg.accountId);
      this._emit('connected', { accountId: msg.accountId });
    } else if (msg.type === 'disconnected') {
      this._relayConnectedAccounts.delete(msg.accountId);
      this._emit('disconnected', { accountId: msg.accountId });
    } else if (msg.type === 'status' && msg.accounts) {
      // Sync upstream connection statuses from relay server
      const entries = Object.entries(msg.accounts);
      let anyConnected = false;
      for (const [accountId, connected] of entries) {
        if (connected) anyConnected = true;
        const wasConnected = this._relayConnectedAccounts.has(accountId);
        if (connected && !wasConnected) {
          this._relayConnectedAccounts.add(accountId);
          this._emit('connected', { accountId });
        } else if (!connected && wasConnected) {
          this._relayConnectedAccounts.delete(accountId);
          this._emit('disconnected', { accountId });
        }
      }
      // If relay has subscribed accounts but none connected upstream,
      // track consecutive failures and fall back to direct mode
      if (entries.length > 0 && !anyConnected) {
        this._relayStatusFailCount = (this._relayStatusFailCount || 0) + 1;
        if (this._relayStatusFailCount >= 3) {
          console.warn('[Stream] Relay upstreams persistently disconnected, falling back to direct');
          this._closeRelay();
          this._fallbackToDirect();
        }
      } else {
        this._relayStatusFailCount = 0;
      }
    }
    // 'pong' — just a keep-alive ack, no action needed
  }

  _scheduleRelayReconnect() {
    if (this._relayReconnectTimer || this._intentionalClose) return;

    this._relayReconnectTimer = setTimeout(() => {
      this._relayReconnectTimer = null;
      this._relayReconnectDelay = Math.min(this._relayReconnectDelay * 1.5, 60000);
      this._ensureRelay();
    }, this._relayReconnectDelay);
  }

  _closeRelay() {
    if (this._relayReconnectTimer) {
      clearTimeout(this._relayReconnectTimer);
      this._relayReconnectTimer = null;
    }
    this._clearRelayPing();
    if (this._relayStatusInterval) {
      clearInterval(this._relayStatusInterval);
      this._relayStatusInterval = null;
    }
    if (this._relayWs) {
      this._relayWs.onclose = null;
      try { this._relayWs.close(); } catch {}
      this._relayWs = null;
    }
    this._relayConnecting = false;
  }

  _clearRelayPing() {
    if (this._relayPingInterval) {
      clearInterval(this._relayPingInterval);
      this._relayPingInterval = null;
    }
  }

  _fallbackToDirect() {
    console.log('[Stream] Falling back to direct connections');
    this._mode = 'direct';

    for (const [, { account, client }] of this._accounts) {
      this._connectDirect(account, client);
    }
  }

  // ===== Direct mode (original behavior) =====

  _connectDirect(account, client) {
    if (this._directConnections.has(account.id)) return;

    const state = {
      account,
      client,
      ws: null,
      reconnectTimer: null,
      reconnectDelay: 2000,
      intentionalClose: false,
    };
    this._directConnections.set(account.id, state);
    this._openDirect(state);
    this._ensureDirectHeartbeat();
  }

  _openDirect(state) {
    const { account } = state;

    try {
      const host = new URL(account.instanceUrl).host;
      let wsUrl;

      if (account.platform === 'mastodon') {
        wsUrl = `wss://${host}/api/v1/streaming?access_token=${encodeURIComponent(account.accessToken)}&stream=user`;
      } else {
        wsUrl = `wss://${host}/streaming?i=${encodeURIComponent(account.accessToken)}`;
      }

      const ws = new WebSocket(wsUrl);
      state.ws = ws;

      ws.onopen = () => {
        console.log(`[Stream] Connected: ${account.label}`);
        state.reconnectDelay = 2000;
        state.lastActivity = Date.now();
        state.awaitingPong = false;
        state._pongSupported = false;
        state._lastBuffered = null;

        if (account.platform !== 'mastodon') {
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
          if (msg.type === 'pong') { state._pongSupported = true; return; }
          this._handleDirectMessage(state, msg);
        } catch {
          // ignore non-JSON
        }
      };

      ws.onclose = () => {
        state.ws = null;
        if (!state.intentionalClose) {
          this._emit('disconnected', { accountId: account.id });
          this._scheduleDirectReconnect(state);
        }
      };

      ws.onerror = (e) => {
        console.warn(`[Stream] Error: ${account.label}`, e);
      };
    } catch (e) {
      console.error(`[Stream] Connection failed: ${account.label}`, e);
      this._scheduleDirectReconnect(state);
    }
  }

  _safeSend(state, data) {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(data);
      return true;
    } catch {
      console.warn(`[Stream] send() failed (zombie?): ${state.account.label}`);
      this._forceDirectReconnect(state);
      return false;
    }
  }

  _handleDirectMessage(state, msg) {
    const { account, client } = state;
    if (account.platform === 'mastodon') {
      this._handleMastodon(account, client, msg);
    } else {
      this._handleMisskey(account, client, msg);
    }
  }

  _scheduleDirectReconnect(state) {
    if (state.intentionalClose || state.reconnectTimer) return;

    const delay = state.reconnectDelay;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (!state.intentionalClose) {
        state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, 60000);
        this._openDirect(state);
      }
    }, delay);
  }

  _disconnectDirect(accountId) {
    const state = this._directConnections.get(accountId);
    if (!state) return;

    state.intentionalClose = true;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.ws) {
      state.ws.onclose = null;
      try { state.ws.close(); } catch {}
      state.ws = null;
    }
    this._directConnections.delete(accountId);
  }

  _forceDirectReconnect(state) {
    const ws = state.ws;
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch {}
    }
    state.ws = null;
    state.awaitingPong = false;
    state._pongSupported = false;
    state._lastBuffered = null;
    this._emit('disconnected', { accountId: state.account.id });
    state.reconnectDelay = 2000;
    this._scheduleDirectReconnect(state);
  }

  // ===== Shared: Platform message handlers =====
  // Used by both relay and direct modes.

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
          console.debug(`[Stream] ${account.label} main:${eventType}`, body.type || body.id || '');
        }
      } else {
        console.debug(`[Stream] ${account.label} unhandled: ch=${channelId} ev=${eventType}`);
      }
    } catch (e) {
      console.error(`[Stream] Misskey parse error (${eventType}):`, e);
    }
  }

  // ===== Lifecycle handlers =====
  // In relay mode: manage the single relay WebSocket.
  // In direct mode: manage per-account WebSockets with heartbeat.

  _ensureLifecycle() {
    // Tab visibility: probe connections on resume, refresh if hidden long
    if (!this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (document.visibilityState === 'hidden') {
          this._lastHiddenAt = Date.now();
        } else if (document.visibilityState === 'visible') {
          this._probeAllConnections();
          // If hidden for >5s, emit event so mixin can refresh timelines
          // to catch any events silently lost during background
          const hiddenDuration = this._lastHiddenAt ? Date.now() - this._lastHiddenAt : 0;
          if (hiddenDuration > 5_000) {
            this._emit('resumeFromBackground', { hiddenMs: hiddenDuration });
          }
          this._lastHiddenAt = 0;
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }

    // bfcache: page restored → all sockets are dead
    if (!this._pageshowHandler) {
      this._pageshowHandler = (e) => {
        if (e.persisted) {
          console.log('[Stream] Restored from bfcache, reconnecting all');
          this._reconnectAll();
        }
      };
      window.addEventListener('pageshow', this._pageshowHandler);
    }

    // bfcache: close sockets cleanly only when entering bfcache,
    // so normal app-switches keep connections alive on desktop.
    if (!this._pagehideHandler) {
      this._pagehideHandler = (e) => {
        if (!e.persisted) return;   // not entering bfcache → keep sockets open
        if (this._mode === 'relay' && this._relayWs) {
          this._relayWs.onclose = null;
          try { this._relayWs.close(1000, 'pagehide'); } catch {}
          this._relayWs = null;
          this._clearRelayPing();
        }
        for (const state of this._directConnections.values()) {
          if (state.ws) {
            state.ws.onclose = null;
            try { state.ws.close(1000, 'pagehide'); } catch {}
            state.ws = null;
          }
        }
      };
      window.addEventListener('pagehide', this._pagehideHandler);
    }

    // Network transition: WiFi→cellular kills sockets silently
    if (!this._onlineHandler) {
      this._onlineHandler = () => {
        setTimeout(() => this._probeAllConnections(), 1500);
      };
      window.addEventListener('online', this._onlineHandler);
    }
  }

  _stopLifecycle() {
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

  _ensureDirectHeartbeat() {
    if (this._heartbeatInterval) return;
    this._heartbeatInterval = setInterval(() => this._directHeartbeatTick(), 30_000);
  }

  _probeAllConnections() {
    if (this._mode === 'relay') {
      // Probe relay WebSocket
      const ws = this._relayWs;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        this._relayWs = null;
        this._clearRelayPing();
        if (!this._relayReconnectTimer && !this._intentionalClose) {
          this._relayReconnectDelay = 2000;
          this._scheduleRelayReconnect();
        }
        return;
      }
      // Send probe ping
      try { ws.send('{"type":"ping"}'); } catch {
        this._closeRelay();
        this._scheduleRelayReconnect();
      }
      return;
    }

    // Direct mode: probe each connection
    const now = Date.now();
    for (const state of this._directConnections.values()) {
      if (state.intentionalClose) continue;

      const ws = state.ws;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        state.ws = null;
        if (!state.reconnectTimer) {
          state.reconnectDelay = 2000;
          this._scheduleDirectReconnect(state);
        }
        continue;
      }

      const probeOk = this._safeSend(state, '{"type":"ping"}');
      if (!probeOk) continue;

      if (state.account.platform === 'mastodon' || !state._pongSupported) {
        state.lastActivity = now;
      }

      const sinceActivity = state.lastActivity ? now - state.lastActivity : Infinity;
      if (sinceActivity > 60_000) {
        console.warn(`[Stream] Probe: stale ${state.account.label} (${Math.round(sinceActivity / 1000)}s), reconnecting`);
        this._forceDirectReconnect(state);
        continue;
      }

      if (state.account.platform !== 'mastodon' && state._pongSupported) {
        state.awaitingPong = true;
      }
    }
  }

  _reconnectAll() {
    if (this._mode === 'relay') {
      this._closeRelay();
      this._relayReconnectDelay = 2000;
      this._ensureRelay();
      return;
    }

    for (const state of this._directConnections.values()) {
      if (state.intentionalClose) continue;
      this._forceDirectReconnect(state);
    }
  }

  _directHeartbeatTick() {
    const now = Date.now();
    const staleThreshold = 90_000;

    for (const state of this._directConnections.values()) {
      if (state.intentionalClose) continue;

      const ws = state.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (!state.reconnectTimer) this._scheduleDirectReconnect(state);
        continue;
      }

      if (state.account.platform !== 'mastodon' && state.awaitingPong) {
        if (state._pongSupported) {
          console.warn(`[Stream] No pong from: ${state.account.label}, reconnecting`);
          this._forceDirectReconnect(state);
          continue;
        }
        state.awaitingPong = false;
      }

      if (state.account.platform !== 'mastodon') {
        if (this._safeSend(state, '{"type":"ping"}')) {
          state.awaitingPong = true;
          if (!state._pongSupported) state.lastActivity = now;
        }
      } else {
        if (this._safeSend(state, '{"type":"ping"}')) {
          state.lastActivity = now;
        }
      }

      if (state._lastBuffered != null && ws.bufferedAmount >= state._lastBuffered && state._lastBuffered > 0) {
        console.warn(`[Stream] Socket stuck: ${state.account.label}, reconnecting`);
        this._forceDirectReconnect(state);
        continue;
      }
      state._lastBuffered = ws.bufferedAmount;

      if (state.lastActivity && now - state.lastActivity > staleThreshold) {
        console.warn(`[Stream] Stale connection: ${state.account.label}, reconnecting`);
        this._forceDirectReconnect(state);
      }
    }
  }
}
