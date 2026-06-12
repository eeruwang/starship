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

const COLUMN_STATE_KEY = 'starship_column_state';
const SETTINGS_KEY = 'starship_settings';

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
    // theme === 'system' → follow OS preference, hooked up below so future
    // changes (toggling dark/light at OS level) propagate live.
    const requested = this.settings.theme || 'dark';
    const resolved = requested === 'system'
      ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : requested;
    document.documentElement.setAttribute('data-theme', resolved);
    if (requested === 'system' && !this._systemThemeMql) {
      this._systemThemeMql = window.matchMedia?.('(prefers-color-scheme: light)');
      if (this._systemThemeMql) {
        const handler = (e) => {
          if (this.settings.theme === 'system') {
            document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
          }
        };
        this._systemThemeMql.addEventListener?.('change', handler);
      }
    }
    this.AUTO_REFRESH_INTERVAL = this.settings.refreshInterval;
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
