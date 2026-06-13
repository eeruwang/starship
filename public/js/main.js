/**
 * StarShip - Main Application
 * Fediverse multi-account dashboard for Misskey, Iceshrimp, CherryPick, and Mastodon.
 */
import { AccountStore } from './accounts.js';
import { StreamManager } from './streaming.js';

// Mixins
import { PostActionsMixin } from './mixins/post-actions.js';
import { ComposeMixin } from './mixins/compose.js';
import { DataLoadingMixin } from './mixins/data-loading.js';
import { AuthUIMixin } from './mixins/auth-ui.js';
import { AccountSetupMixin } from './mixins/account-setup.js';
import { ThreadViewMixin } from './mixins/thread-view.js';
import { ProfileModalMixin } from './mixins/profile-modal.js';
import { EventsMixin } from './mixins/events.js';
import { ColumnsMixin } from './mixins/columns.js';
import { LinkEnrichmentMixin } from './mixins/link-enrichment.js';
import { StreamingMixin } from './mixins/streaming.js';
import { PagesMixin } from './mixins/pages.js';
import { initKeyboardNav } from './ui/keyboard-nav.js';
import { initMfmMotion } from './ui/mfm-motion.js';
import { rememberHostPlatform } from './ui/dashboard.js';

const COLUMN_STATE_KEY = 'starship_column_state';
const SETTINGS_KEY = 'starship_settings';

// Delegated <img> error fallback handler. Replaces dozens of inline
// `onerror=` attributes that a strict CSP would block. Each <img> declares
// the fallback policy via `data-fb`, this listener applies it. `error`
// events don't bubble, so we use capture phase to catch them globally.
const FB_SVG_PLACEHOLDER = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23555%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2240%22>?</text></svg>';
document.addEventListener('error', (e) => {
  const t = e.target;
  if (!t || t.tagName !== 'IMG') return;
  const fb = t.dataset.fb;
  if (!fb || t.dataset.fbApplied === '1') return;
  t.dataset.fbApplied = '1';
  switch (fb) {
    case 'hide':
      t.style.display = 'none';
      break;
    case 'hide-parent':
      if (t.parentElement) t.parentElement.style.display = 'none';
      break;
    case 'link-card':
      if (t.parentElement) t.parentElement.classList.remove('link-card-has-image');
      t.style.display = 'none';
      break;
    case 'dim':
      t.style.opacity = '0.3';
      break;
    case 'reveal-next':
      t.style.display = 'none';
      if (t.nextElementSibling) t.nextElementSibling.style.display = '';
      break;
    case 'alt-text':
      t.replaceWith(document.createTextNode(t.alt || ''));
      break;
    case 'svg-placeholder':
      t.src = FB_SVG_PLACEHOLDER;
      break;
  }
}, true);

class StarShipApp {
  constructor() {
    this.store = new AccountStore();
    this.streamManager = new StreamManager();
    this.autoRefreshTimer = null;
    this.focusedColumnIndex = 0;
    this.postCache = new Map(); // key: `${platform}:${id}`, value: post
    this.POST_CACHE_MAX = 500;
    this.MAX_DOM_POSTS = 500; // max post-card elements per column before pruning
    this._ogCache = new Map(); // URL → { title, description, image, siteName }
    this._OG_CACHE_MAX = 200;
    this._columnPagination = new WeakMap();
    this.composeFiles = [];
    this.composeSelectedAccounts = new Set();
    this._currentUser = null; // { username } or null
    this._syncDebounce = null;

    // Settings
    this.settings = this.loadSettings();
    this.AUTO_REFRESH_INTERVAL = this.settings.refreshInterval;
    this.applySettings();

    // Column state
    this.columnState = this.loadColumnState();

    this.initElements();
    this.bindEvents();
    this.render();
    this.startAutoRefresh();
    this.startTimeUpdater();
    this._siteInfo = { registrationMode: 'open', turnstileSiteKey: null };
    this._turnstileWidgetId = null;
    this._turnstileToken = null;
    this.fetchSiteInfo();

    // 디자인 핸드오프 6단계: MFM 모션 정책 + 키보드 단축키
    initMfmMotion();
    // 알려진 계정의 host → software 매핑을 캐시에 시드 (작성자 배지 정확도)
    this._seedHostPlatformCache();
    // iOS 키보드 높이를 CSS 변수(--keyboard-h)로 노출 → 컴포즈 모달이 본문을 키보드
    // 위로 띄울 수 있게 한다.
    this._initVisualViewportShim();
    initKeyboardNav({
      onCompose: () => this.openComposeModal(),
      onHelp: () => document.getElementById('shortcut-overlay')?.classList.add('open'),
    });
    // ? 도움말 닫기 (Esc / 바깥 클릭)
    const overlay = document.getElementById('shortcut-overlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('open');
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) {
          overlay.classList.remove('open');
        }
      });
    }
    // checkAuth() is called in DOMContentLoaded after pending OAuth results are processed
  }

  loadSettings() {
    try {
      const data = localStorage.getItem(SETTINGS_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        return {
          refreshInterval: parsed.refreshInterval ?? 60000,
          columnWidth: parsed.columnWidth ?? 380,
          fontSize: parsed.fontSize ?? 14,
          postsCount: parsed.postsCount ?? 30,
          theme: parsed.theme ?? 'dark',
        };
      }
    } catch (err) { console.warn('Settings parse failed:', err); }
    return { refreshInterval: 60000, columnWidth: 380, fontSize: 14, postsCount: 30, theme: 'dark' };
  }

  saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch {}
    this.debouncedSaveToCloud();
  }

  applySettings() {
    document.documentElement.style.setProperty('--column-width', `${this.settings.columnWidth}px`);
    document.documentElement.style.fontSize = `${this.settings.fontSize}px`;
    document.documentElement.setAttribute('data-density', this.settings.density || 'comfortable');
    // MFM 모션 정책 동기화 (reduced-motion 시 initMfmMotion 이 off 로 덮어씀)
    if (this.settings.mfm) {
      document.documentElement.setAttribute('data-mfm', this.settings.mfm);
      try { localStorage.setItem('starship:mfm', this.settings.mfm); } catch (_) {}
    }
    // theme: 5종 팔레트 (indigo-night/arctic/moss/daylight/linen) 또는 system / 레거시 dark·light
    const requested = this.settings.theme || 'indigo-night';
    const isLegacy = (requested === 'dark' || requested === 'light' || requested === 'system');
    if (isLegacy) {
      // 레거시 호환: dark → indigo-night, light → daylight, system → OS 따름
      let resolved = requested;
      if (requested === 'system') {
        resolved = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'daylight' : 'indigo-night';
      } else if (requested === 'dark') {
        resolved = 'indigo-night';
      } else if (requested === 'light') {
        resolved = 'daylight';
      }
      this._applyThemeId(resolved);
      if (requested === 'system' && !this._systemThemeMql) {
        this._systemThemeMql = window.matchMedia?.('(prefers-color-scheme: light)');
        this._systemThemeMql?.addEventListener?.('change', (e) => {
          if (this.settings.theme === 'system') {
            this._applyThemeId(e.matches ? 'daylight' : 'indigo-night');
          }
        });
      }
    } else {
      this._applyThemeId(requested);
    }
    this.AUTO_REFRESH_INTERVAL = this.settings.refreshInterval;
  }

  // Sets data-theme + data-scheme. Schemes are pre-mapped from theme-switcher's
  // THEMES table so changing one place updates the other.
  _initVisualViewportShim() {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const sync = () => {
      const kbd = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--keyboard-h', `${kbd}px`);
    };
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
  }

  _seedHostPlatformCache() {
    for (const acc of (this.store?.getAll?.() || [])) {
      if (!acc.instanceUrl || !acc.software) continue;
      try { rememberHostPlatform(new URL(acc.instanceUrl).host, acc.software); }
      catch (_) {}
    }
  }

  _applyThemeId(themeId) {
    const map = {
      'indigo-night': 'dark',
      'arctic': 'dark',
      'moss': 'dark',
      'arctic-light': 'light',
      'moss-light': 'light',
      'daylight': 'light',
      'linen': 'light',
    };
    const scheme = map[themeId] || 'dark';
    document.documentElement.setAttribute('data-theme', themeId);
    document.documentElement.setAttribute('data-scheme', scheme);
    // Sync the mobile address-bar colour to the new palette
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
      if (bg) meta.setAttribute('content', bg);
    }
  }

  loadColumnState() {
    try {
      const data = localStorage.getItem(COLUMN_STATE_KEY);
      if (data) {
        const state = JSON.parse(data);
        // Ensure order array exists (migration from old format)
        if (!Array.isArray(state.order)) {
          state.order = [];
          if (state.all) state.order.push('all');
          if (state.notifications) state.order.push('notifications');
          if (state.accounts) {
            for (const id of Object.keys(state.accounts)) {
              if (state.accounts[id]) state.order.push(`account:${id}`);
            }
          }
        }
        return state;
      }
    } catch (err) { console.warn('Column state parse failed:', err); }
    return { all: true, notifications: true, accounts: {}, order: ['all', 'notifications'] };
  }

  saveColumnState() {
    try { localStorage.setItem(COLUMN_STATE_KEY, JSON.stringify(this.columnState)); } catch {}
    this.debouncedSaveToCloud();
  }

  initElements() {
    this.btnAddAccount = document.getElementById('btn-add-account');
    this.btnRefreshAll = document.getElementById('btn-refresh-all');
    this.btnSettings = document.getElementById('btn-settings');

    this.toggleBar = document.getElementById('column-toggle-bar');
    this.emptyState = document.getElementById('empty-state');
    this.columnsContainer = document.getElementById('columns-container');

    // Add account modal
    this.modalAddAccount = document.getElementById('modal-add-account');
    this.platformSelect = document.getElementById('platform-select');
    this.instanceUrl = document.getElementById('instance-url');
    this.accessToken = document.getElementById('access-token');
    this.accountLabel = document.getElementById('account-label');
    this.btnConfirmAdd = document.getElementById('btn-confirm-add');
    this.addAccountError = document.getElementById('add-account-error');
    this.tokenHint = document.getElementById('token-hint');
    this.btnAddFirst = document.getElementById('btn-add-first');
    this.btnOAuthLogin = document.getElementById('btn-oauth-login');

    // Compose modal
    this.modalCompose = document.getElementById('modal-compose');
    this.composeAccountsContainer = document.getElementById('compose-accounts');
    this.composeTitle = document.getElementById('compose-title');
    this.composeCw = document.getElementById('compose-cw');
    this.composeText = document.getElementById('compose-text');
    this.composeFilesInput = document.getElementById('compose-files');
    this.composeEditor = document.querySelector('.compose-editor');
    this.composeImagePreview = document.getElementById('compose-image-preview');
    this.btnComposeAttach = document.getElementById('btn-compose-attach');
    this.btnComposeSensitive = document.getElementById('btn-compose-sensitive');
    this.btnComposeEmoji = document.getElementById('btn-compose-emoji');
    this.btnComposeVisibility = document.getElementById('btn-compose-visibility');
    this.composeCharHint = document.getElementById('compose-char-hint');
    this.btnComposeSubmit = document.getElementById('btn-compose-submit');
    this.composeError = document.getElementById('compose-error');
    this.composeSensitive = false;
    this.composeVisibilityValue = 'public';

    // Auth modal
    this.btnAuth = document.getElementById('btn-auth');
    this.modalAuth = document.getElementById('modal-auth');
    this.authModalTitle = document.getElementById('auth-modal-title');
    this.authUsername = document.getElementById('auth-username');
    this.authPassword = document.getElementById('auth-password');
    this.authError = document.getElementById('auth-error');
    this.btnAuthSubmit = document.getElementById('btn-auth-submit');
    this.btnAuthSwitch = document.getElementById('btn-auth-switch');
    this.authSwitchText = document.getElementById('auth-switch-text');
    this.authSubtitle = document.querySelector('.auth-subtitle');
    this._authMode = 'login'; // 'login' or 'register'

    // Lightbox
    this.lightbox = document.getElementById('lightbox');
    this.lightboxImg = document.getElementById('lightbox-img');
    this.lightboxClose = document.getElementById('lightbox-close');
    this.lightboxPrev = document.getElementById('lightbox-prev');
    this.lightboxNext = document.getElementById('lightbox-next');
    this.lightboxCounter = document.getElementById('lightbox-counter');
  }

  // All other methods are provided by mixins:
  // - EventsMixin: bindEvents, event handlers, navigation, lightbox
  // - ColumnsMixin: render, columns, toggle bar, modals, auto-refresh, toast
  // - LinkEnrichmentMixin: enrichLinkCards, fedi embed
  // - PostActionsMixin: post actions (fav, boost, reaction, etc.)
  // - ComposeMixin: compose modal
  // - DataLoadingMixin: timeline/notification loading
  // - AuthUIMixin: auth, user menu, cloud sync
  // - AccountSetupMixin: account setup modal
  // - ThreadViewMixin: thread view
  // - ProfileModalMixin: profile modal
  // - StreamingMixin: real-time WebSocket streaming
}

// Apply mixins
Object.assign(StarShipApp.prototype,
  PostActionsMixin,
  ComposeMixin,
  DataLoadingMixin,
  AuthUIMixin,
  AccountSetupMixin,
  ThreadViewMixin,
  ProfileModalMixin,
  EventsMixin,
  ColumnsMixin,
  LinkEnrichmentMixin,
  StreamingMixin,
  PagesMixin,
);

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  const app = new StarShipApp();
  window.app = app;

  // 1. Check auth and load cloud data first (establishes _currentUser)
  await app.checkAuth();
  // Cloud accounts now loaded — refresh host→software cache.
  app._seedHostPlatformCache();

  // 2. Process any pending OAuth callback result (adds on top of cloud data)
  const authResult = localStorage.getItem('starship_auth_result');
  if (authResult) {
    localStorage.removeItem('starship_auth_result');
    try {
      const result = JSON.parse(authResult);
      await app.store.addAccount(result.platform, result.instanceUrl, result.accessToken);
      app.render();
      await app.saveToCloud();
    } catch (err) {
      console.error('OAuth 콜백 처리 실패:', err);
    }
  }

  // 3. Start real-time streaming for all connected accounts
  if (!app.store.isEmpty()) {
    app.startStreaming();
  }
});
