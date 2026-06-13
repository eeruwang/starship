// =====================================================================
// StarShip — MFM motion setting (handoff snippet)
// 무한 애니메이션 피로 제어. <html data-mfm="hover|auto|off">.
// 기본값 'hover' (호버 시에만 재생). reduced-motion 이면 'off' 강제.
// =====================================================================

export function initMfmMotion() {
  const root = document.documentElement;
  let mode = 'hover';
  try { mode = localStorage.getItem('starship:mfm') || 'hover'; } catch (_) {}
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) mode = 'off';
  root.setAttribute('data-mfm', mode);
}

export function setMfmMotion(mode) {
  document.documentElement.setAttribute('data-mfm', mode);
  try { localStorage.setItem('starship:mfm', mode); } catch (_) {}
}

/* 동반 CSS (mfm.css 에 추가):
   [data-mfm="off"]   .mfm-animated { animation: none !important; }
   [data-mfm="hover"] .mfm-animated { animation-play-state: paused; }
   [data-mfm="hover"] .post-card:hover .mfm-animated,
   [data-mfm="hover"] .mfm-animated:hover { animation-play-state: running; }
   [data-mfm="auto"]  .mfm-animated { animation-play-state: running; }
*/
