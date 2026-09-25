/**
 * Cross-tab sync channel.
 *
 * When one StarShip tab mutates persistent state (accounts, columnState,
 * settings), other tabs open on the same origin must be told so their
 * in-memory state doesn't drift and their debounced cloud sync doesn't
 * overwrite the fresh cloud copy with a stale one.
 *
 * BroadcastChannel is same-origin only and doesn't loop back to the
 * sender, so no self-message filtering is needed.
 */

let _channel = null;

function _ensureChannel() {
  if (_channel !== null) return _channel;
  try {
    if (typeof BroadcastChannel === 'undefined') { _channel = false; return false; }
    _channel = new BroadcastChannel('starship_state_v1');
  } catch (_) {
    _channel = false;
  }
  return _channel;
}

export function broadcastChange(type) {
  const ch = _ensureChannel();
  if (!ch) return;
  try { ch.postMessage({ type, at: Date.now() }); } catch (_) {}
}

export function onChange(handler) {
  const ch = _ensureChannel();
  if (!ch) return () => {};
  const wrapped = (e) => {
    if (!e?.data || typeof e.data !== 'object') return;
    handler(e.data);
  };
  ch.addEventListener('message', wrapped);
  return () => ch.removeEventListener('message', wrapped);
}
