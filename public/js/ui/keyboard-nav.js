// =====================================================================
// StarShip — keyboard navigation
// J/K 이동은 현재 컬럼 안에서만. 컬럼 사이 이동은 H/L (Vim 관례) 또는
// ← / → (기존 arrow key와 동일 콜백).
// =====================================================================

const SHORTCUTS = {
  j: 'next', k: 'prev',
  h: 'colLeft', l: 'colRight',
  r: 'reply', b: 'boost', f: 'fav', q: 'quote',
  n: 'compose', '?': 'help',
};

// Element reference — survives cross-column moves and renders. When the
// referenced card is removed from the DOM, `.isConnected` reports false and
// we re-anchor.
let focusedCard = null;

function cardsInColumn(col) {
  if (!col) return [];
  return [...col.querySelectorAll('.post-card, .notif-card')];
}

function currentColumn() {
  // Prefer the focused card's owning column (survives when the user switches
  // columns via H/L); fall back to the app-marked focused column.
  if (focusedCard && focusedCard.isConnected) {
    return focusedCard.closest('.column');
  }
  return document.querySelector('.column.focused') || document.querySelector('.column');
}

function _applyFocus(el) {
  if (!el) return;
  // Clear focus classes across ALL cards, not just this column, so a stale
  // .kb-focus can't linger on a card the user left behind in another column.
  document.querySelectorAll('.kb-focus').forEach(c => c.classList.remove('kb-focus'));
  focusedCard = el;
  el.classList.add('kb-focus');
  const cont = el.closest('.column-content');
  if (cont) {
    const top = el.offsetTop - cont.offsetTop - 12;
    cont.scrollTo({ top, behavior: 'smooth' });
  }
}

function focusFirstInColumn(col) {
  const list = cardsInColumn(col?.querySelector('.column-content'));
  if (list.length) _applyFocus(list[0]);
}

function moveWithinColumn(direction) {
  const col = currentColumn();
  if (!col) return;
  const content = col.querySelector('.column-content');
  const list = cardsInColumn(content);
  if (list.length === 0) return;

  // First press (or focus went stale) → anchor at first card of current column.
  if (!focusedCard || !focusedCard.isConnected || !content.contains(focusedCard)) {
    _applyFocus(list[0]);
    return;
  }
  const idx = list.indexOf(focusedCard);
  // Stop at boundary — no wrap, no cross-column jump. Users use H/L / ← → to
  // switch columns explicitly.
  const nextIdx = Math.max(0, Math.min(list.length - 1, idx + direction));
  if (nextIdx === idx) return;
  _applyFocus(list[nextIdx]);
}

function triggerAction(action) {
  if (!focusedCard || !focusedCard.isConnected) return;
  const btn = focusedCard.querySelector(`[data-action="${action}"]`);
  if (btn) btn.click();
}

export function initKeyboardNav({ onCompose, onHelp, onColumnLeft, onColumnRight } = {}) {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.matches('input, textarea, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const cmd = SHORTCUTS[e.key.toLowerCase()] || SHORTCUTS[e.key];
    if (!cmd) return;
    e.preventDefault();
    switch (cmd) {
      case 'next': moveWithinColumn(1); break;
      case 'prev': moveWithinColumn(-1); break;
      case 'colLeft':
        onColumnLeft?.();
        // After the column switch, place focus at the top of the new column.
        // Deferred a frame so navigateColumn's scroll/focus class runs first.
        requestAnimationFrame(() => focusFirstInColumn(document.querySelector('.column.focused')));
        break;
      case 'colRight':
        onColumnRight?.();
        requestAnimationFrame(() => focusFirstInColumn(document.querySelector('.column.focused')));
        break;
      case 'reply': triggerAction('reply'); break;
      case 'boost': triggerAction('boost'); break;
      case 'fav': triggerAction('fav'); break;
      case 'quote': triggerAction('quote'); break;
      case 'compose': onCompose?.(); break;
      case 'help': onHelp?.(); break;
    }
  });
}
