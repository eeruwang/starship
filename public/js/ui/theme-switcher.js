// =====================================================================
// StarShip — theme switcher (handoff snippet)
// 기존 settings 모듈에 통합하세요. 색축(data-theme)과 명암축(data-scheme)을
// 함께 세팅합니다. localStorage 키는 기존 설정 스키마에 맞춰 조정.
// =====================================================================

export const THEMES = [
  { id: 'indigo-night', label: 'Indigo Night', scheme: 'dark'  },
  { id: 'arctic',       label: 'Arctic',       scheme: 'dark'  },
  { id: 'moss',         label: 'Moss',         scheme: 'dark'  },
  { id: 'daylight',     label: 'Daylight',     scheme: 'light' },
  { id: 'linen',        label: 'Linen',        scheme: 'light' },
];

const DEFAULT_THEME = 'indigo-night';

export function applyTheme(themeId) {
  const theme = THEMES.find(t => t.id === themeId) || THEMES[0];
  const root = document.documentElement;
  root.setAttribute('data-theme', theme.id);
  root.setAttribute('data-scheme', theme.scheme);
  try { localStorage.setItem('starship:theme', theme.id); } catch (_) {}
  // 모바일 주소창 색 동기화
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content',
      getComputedStyle(root).getPropertyValue('--bg-primary').trim());
  }
}

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('starship:theme'); } catch (_) {}
  applyTheme(saved || DEFAULT_THEME);
}

// 설정 모달 <select id="setting-theme"> 옵션을 THEMES 로 렌더하고
// change 시 applyTheme(e.target.value) 호출하세요.
