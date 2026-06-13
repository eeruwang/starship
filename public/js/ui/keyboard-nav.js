// =====================================================================
// StarShip — keyboard navigation (handoff snippet)
// J/K 이동, R 답글, B 부스트, F 좋아요, N 새글, ? 도움말.
// 기존 main.js 의 액션 디스패치(클릭 핸들러)를 재사용하도록 셀렉터만 맞추세요.
// =====================================================================

const SHORTCUTS = {
  j: 'next', k: 'prev',
  r: 'reply', b: 'boost', f: 'fav', q: 'quote',
  n: 'compose', '?': 'help',
};

let focusIdx = -1;

function cards() {
  // 현재 보이는(활성) 컬럼의 글 카드들
  return [...document.querySelectorAll('.column-content .post-card, .column-content .notif-card')];
}

function focusCard(i) {
  const list = cards();
  if (!list.length) return;
  focusIdx = Math.max(0, Math.min(i, list.length - 1));
  list.forEach(c => c.classList.remove('kb-focus'));
  const el = list[focusIdx];
  el.classList.add('kb-focus');
  // scrollIntoView 금지 — 컨테이너 기준 수동 스크롤
  const cont = el.closest('.column-content');
  if (cont) {
    const top = el.offsetTop - cont.offsetTop - 12;
    cont.scrollTo({ top, behavior: 'smooth' });
  }
}

function triggerAction(action) {
  const el = cards()[focusIdx];
  if (!el) return;
  const btn = el.querySelector(`[data-action="${action}"]`);
  if (btn) btn.click();
}

export function initKeyboardNav({ onCompose, onHelp } = {}) {
  document.addEventListener('keydown', (e) => {
    // 입력 중에는 무시
    const t = e.target;
    if (t.matches('input, textarea, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const cmd = SHORTCUTS[e.key.toLowerCase()] || SHORTCUTS[e.key];
    if (!cmd) return;
    e.preventDefault();
    switch (cmd) {
      case 'next': focusCard(focusIdx + 1); break;
      case 'prev': focusCard(focusIdx - 1); break;
      case 'reply': triggerAction('reply'); break;
      case 'boost': triggerAction('boost'); break;
      case 'fav': triggerAction('fav'); break;
      case 'quote': triggerAction('quote'); break;
      case 'compose': onCompose?.(); break;
      case 'help': onHelp?.(); break;
    }
  });
}
