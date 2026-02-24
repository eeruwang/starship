/**
 * StarShip - Main Application
 * Fediverse multi-account dashboard for Misskey, Iceshrimp, CherryPick, and Mastodon.
 */
import { AccountStore } from './accounts.js';
import { iconRefresh, iconClose } from './ui/dashboard.js';
import { startMastodonOAuth, startMiAuth, waitForAuthCallback, clearPendingAuth } from './auth.js';

// Mixins
import { PostActionsMixin } from './mixins/post-actions.js';
import { ComposeMixin } from './mixins/compose.js';
import { DataLoadingMixin } from './mixins/data-loading.js';
import { AuthUIMixin } from './mixins/auth-ui.js';
import { AccountSetupMixin } from './mixins/account-setup.js';
import { ThreadViewMixin } from './mixins/thread-view.js';
import { ProfileModalMixin } from './mixins/profile-modal.js';

const COLUMN_STATE_KEY = 'starship_column_state';
const SETTINGS_KEY = 'starship_settings';

class StarShipApp {
  constructor() {
    this.store = new AccountStore();
    this.autoRefreshTimer = null;
    this.focusedColumnIndex = 0;
    this.postCache = new Map(); // key: `${platform}:${id}`, value: post
    this.POST_CACHE_MAX = 500;
    this._ogCache = new Map(); // URL → { title, description, image, siteName }
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
    this._siteInfo = { registrationMode: 'open', turnstileSiteKey: null };
    this._turnstileWidgetId = null;
    this._turnstileToken = null;
    this.fetchSiteInfo();
    this.checkAuth();
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
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    this.debouncedSaveToCloud();
  }

  applySettings() {
    document.documentElement.style.setProperty('--column-width', `${this.settings.columnWidth}px`);
    document.documentElement.style.fontSize = `${this.settings.fontSize}px`;
    document.documentElement.setAttribute('data-theme', this.settings.theme || 'dark');
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
    localStorage.setItem(COLUMN_STATE_KEY, JSON.stringify(this.columnState));
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
  }

  bindEvents() {
    this._bindHeaderEvents();
    this._bindAuthEvents();
    this._bindModalEvents();
    this._bindAccountSetupEvents();
    this._bindToggleBarDrag();
    this._bindDelegatedEvents();
    this._bindComposeEvents();
    this._bindColumnEvents();
    this._bindKeyboardEvents();
  }

  _bindHeaderEvents() {
    this.btnAddAccount?.addEventListener('click', () => this.openAddAccountModal());
    this.btnAddFirst?.addEventListener('click', () => this.openAddAccountModal());
    document.getElementById('btn-welcome-login')?.addEventListener('click', () => this.handleAuthButtonClick());
    document.getElementById('btn-compose-header').addEventListener('click', () => {
      const accountId = this.getFocusedColumnAccountId();
      this.openComposeModal(null, accountId || null);
    });
    this.btnRefreshAll.addEventListener('click', () => this.refreshAll(true));
    this.btnSettings.addEventListener('click', () => this.openSettingsModal());
  }

  _bindAuthEvents() {
    this.btnAuth.addEventListener('click', () => this.handleAuthButtonClick());
    this.btnAuthSubmit.addEventListener('click', () => this.handleAuthSubmit());
    this.btnAuthSwitch.addEventListener('click', () => this.toggleAuthMode());
    this.authPassword.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleAuthSubmit();
    });

    document.querySelectorAll('.user-menu-item[data-action]').forEach(item => {
      item.addEventListener('click', () => this.handleUserMenuAction(item.dataset.action));
    });
    document.querySelectorAll('.reg-mode-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setRegistrationMode(btn.dataset.regMode);
      });
    });
    document.getElementById('import-file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (data.accounts?.length) { this.store.replaceAll(data.accounts); }
        if (data.settings) { this.settings = { ...this.settings, ...data.settings }; this.saveSettings(); this.applySettings(); }
        if (data.columnState) { this.columnState = data.columnState; this.saveColumnState(); }
        this.render();
        this.debouncedSaveToCloud();
      } catch (err) { console.error('Import failed:', err); this.showToast('파일을 읽을 수 없습니다.'); }
      e.target.value = '';
    });
  }

  _bindModalEvents() {
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.closeModal;
        this.closeModal(document.getElementById(modalId));
        if (modalId === 'modal-compose') { this.closeComposeEmojiPicker(); this.closeComposeVisibilityPicker(); }
      });
    });
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          this.closeModal(overlay);
          this.closeComposeEmojiPicker();
          this.closeComposeVisibilityPicker();
        }
      });
    });
  }

  _bindAccountSetupEvents() {
    this.instanceUrl.addEventListener('input', () => this.updateOAuthButton());
    this.instanceUrl.addEventListener('blur', () => this.autoDetectPlatform());
    this.btnOAuthLogin.addEventListener('click', () => this.handleOAuthLogin());
    this.btnConfirmAdd.addEventListener('click', () => this.handleAddAccount());
  }

  _bindToggleBarDrag() {
    let isDragging = false, startX = 0, startY = 0, scrollStart = 0, moved = false;
    let directionLocked = false;
    const getX = (e) => e.touches ? e.touches[0].pageX : e.pageX;
    const getY = (e) => e.touches ? e.touches[0].pageY : e.pageY;

    const onStart = (e) => {
      isDragging = true;
      directionLocked = false;
      startX = getX(e);
      startY = e.touches ? getY(e) : 0;
      scrollStart = this.toggleBar.scrollLeft;
      moved = false;
      if (!e.touches) {
        this.toggleBar.style.cursor = 'grabbing';
        e.preventDefault();
      }
    };
    const onMove = (e) => {
      if (!isDragging) return;
      const x = e.touches ? e.touches[0].pageX : e.pageX;

      if (e.touches && !directionLocked) {
        const y = e.touches[0].pageY;
        const dx = Math.abs(x - startX);
        const dy = Math.abs(y - startY);
        if (dx + dy > 5) {
          if (dx > dy) {
            directionLocked = true;
          } else {
            isDragging = false;
            return;
          }
        } else {
          return;
        }
      }

      if (e.cancelable) e.preventDefault();
      const dx = x - startX;
      if (Math.abs(dx) > 3) {
        moved = true;
        this.toggleBar.scrollLeft = scrollStart - dx;
      }
    };
    const onEnd = () => {
      if (isDragging) {
        isDragging = false;
        directionLocked = false;
        this.toggleBar.style.cursor = '';
      }
    };

    this.toggleBar.addEventListener('mousedown', onStart);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    this.toggleBar.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', (e) => {
      const wasDrag = moved;
      onEnd();
      if (!wasDrag && e.changedTouches && e.changedTouches.length) {
        const touch = e.changedTouches[0];
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const toggle = el && el.closest('.col-toggle');
        if (toggle && this.toggleBar.contains(toggle)) {
          this.handleToggleClick(toggle);
        }
      }
    });

    this.toggleBar.addEventListener('click', (e) => {
      if (moved) {
        e.stopPropagation();
        moved = false;
        return;
      }
      const toggle = e.target.closest('.col-toggle');
      if (!toggle) return;
      this.handleToggleClick(toggle);
    }, true);
  }

  _bindDelegatedEvents() {
    // CW toggle
    document.addEventListener('click', (e) => {
      if (e.target.matches('.cw-toggle')) {
        const cwWarning = e.target.closest('.cw-warning, .reply-context-cw');
        const target = cwWarning?.nextElementSibling;
        if (target && (target.classList.contains('cw-content') || target.id?.startsWith('reply-ctx-'))) {
          target.classList.toggle('visible');
          e.target.textContent = target.classList.contains('visible') ? '숨기기' : '내용 보기';
        }
      }
    });

    // Expand toggle for long content
    document.addEventListener('click', (e) => {
      if (e.target.matches('.expand-toggle')) {
        const target = e.target.previousElementSibling;
        if (target) {
          target.classList.toggle('collapsed');
          e.target.textContent = target.classList.contains('collapsed') ? '더보기' : '접기';
        }
      }
    });

    // Post actions
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.post-action');
      if (!btn) return;
      const card = btn.closest('.post-card');
      if (!card) return;

      const action = btn.dataset.action;
      const postId = card.dataset.postId;
      const platform = card.dataset.platform;
      const accountId = card.dataset.accountId;

      if (action === 'open') {
        const postUrl = this.findPostUrl(postId, platform);
        if (postUrl) window.open(postUrl, '_blank', 'noopener');
      } else if (action === 'fav') {
        this.handlePostAction('fav', postId, platform, accountId, btn);
      } else if (action === 'boost') {
        this.handlePostAction('boost', postId, platform, accountId, btn);
      } else if (action === 'reply') {
        this.handlePostAction('reply', postId, platform, accountId, btn);
      } else if (action === 'quote') {
        this.handlePostAction('quote', postId, platform, accountId, btn);
      } else if (action === 'reaction') {
        this.handlePostAction('reaction', postId, platform, accountId, btn);
      } else if (action === 'edit') {
        this.openEditModal(postId, platform, accountId);
      } else if (action === 'delete') {
        this.handleDeletePost(postId, platform, accountId, btn);
      }
    });

    // Notification action buttons
    document.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('.notif-action-btn');
      if (actionBtn) {
        e.stopPropagation();
        e.preventDefault();
        const card = actionBtn.closest('.notif-card');
        if (!card) return;
        const postId = card.dataset.postId;
        const accountId = card.dataset.accountId;
        const platform = card.dataset.platform;
        const action = actionBtn.dataset.action;
        if (!postId || !accountId || !action) return;
        if (action === 'reply') {
          this.openComposeModal(postId, accountId);
        } else {
          this.handlePostAction(action, postId, platform, accountId, actionBtn);
        }
        return;
      }
    });

    // Notification card click: open thread view
    document.addEventListener('click', (e) => {
      const card = e.target.closest('.notif-clickable');
      if (!card) return;
      if (e.target.closest('.notif-avatar') || e.target.closest('[data-lightbox]') || e.target.closest('.expand-toggle') || e.target.closest('.notif-action-btn')) return;
      const postId = card.dataset.postId;
      const accountId = card.dataset.accountId;
      const platform = card.dataset.platform;
      if (postId && accountId && platform) {
        this.openThreadView(postId, platform, accountId);
      }
    });

    // Avatar click: open profile modal
    document.addEventListener('click', (e) => {
      const avatar = e.target.closest('.post-avatar, .notif-avatar');
      if (!avatar) return;
      e.stopPropagation();
      e.preventDefault();
      const card = avatar.closest('.post-card, .notif-card');
      if (!card) return;
      const platform = card.dataset.platform;
      const accountId = card.dataset.accountId;
      if (!platform || !accountId) return;

      if (avatar.classList.contains('notif-avatar')) {
        const actorId = card.dataset.actorId;
        if (actorId) {
          const minimalAuthor = {
            id: actorId,
            avatarUrl: avatar.src || '',
            displayName: card.dataset.actorName || '',
            acct: card.dataset.actorAcct || card.dataset.actorUsername || '',
            username: card.dataset.actorUsername || '',
          };
          this.openProfileModal(minimalAuthor, platform, accountId);
        }
        return;
      }

      const postId = card.dataset.postId;
      if (postId) {
        const post = this.postCache.get(`${platform}:${postId}`);
        if (post) {
          const displayPost = post.reblog || post;
          this.openProfileModal(displayPost.author, platform, accountId);
          return;
        }
      }
    });

    // Reaction badge click: show who reacted
    document.addEventListener('click', (e) => {
      const badge = e.target.closest('.reaction-badge');
      if (!badge) return;
      e.stopPropagation();
      const card = badge.closest('.post-card');
      if (!card) return;
      const postId = card.dataset.postId;
      const platform = card.dataset.platform;
      const accountId = card.dataset.accountId;
      const reaction = badge.dataset.reaction;
      const cached = this.postCache.get(`${platform}:${postId}`);
      const reactionPostId = cached?.reblog?.id || postId;
      this.showReactionUsers(badge, reactionPostId, platform, accountId, reaction);
    });

    // Post card click: open thread view
    document.addEventListener('click', (e) => {
      if (e.target.closest('.post-action, .reaction-badge, a, button, [data-lightbox], .expand-toggle, .cw-toggle, .post-media, img')) return;
      const card = e.target.closest('.post-card');
      if (!card) return;
      if (card.closest('.thread-content')) return;
      const platform = card.dataset.platform;
      const accountId = card.dataset.accountId;
      if (!platform || !accountId) return;

      const quotePart = e.target.closest('.quote-post');
      if (quotePart && quotePart.dataset.quoteId) {
        this.openThreadView(quotePart.dataset.quoteId, platform, accountId);
        return;
      }

      const postId = card.dataset.postId;
      if (postId) {
        this.openThreadView(postId, platform, accountId);
      }
    });

    // Sensitive media reveal/hide
    document.addEventListener('click', (e) => {
      const revealBtn = e.target.closest('.sensitive-reveal');
      if (revealBtn) {
        e.preventDefault();
        e.stopPropagation();
        const media = revealBtn.closest('.post-media');
        if (media) media.classList.add('media-revealed');
        return;
      }
      const hideBtn = e.target.closest('.sensitive-hide');
      if (hideBtn) {
        e.preventDefault();
        e.stopPropagation();
        const media = hideBtn.closest('.post-media');
        if (media) media.classList.remove('media-revealed');
      }
    });

    // Image lightbox
    document.addEventListener('click', (e) => {
      const img = e.target.closest('img[data-lightbox="true"]');
      if (!img) return;
      e.preventDefault();
      e.stopPropagation();
      const fullUrl = img.dataset.fullUrl || img.src;
      this.openLightbox(fullUrl, img);
    });

    // Lightbox close
    this.lightboxClose.addEventListener('click', () => this.closeLightbox());
    this.lightbox.addEventListener('click', (e) => {
      if (e.target === this.lightbox || e.target === this.lightboxImg) {
        this.closeLightbox();
      }
    });
  }

  _bindComposeEvents() {
    this.btnComposeAttach.addEventListener('click', () => this.composeFilesInput.click());
    this.btnComposeSensitive.addEventListener('click', () => {
      this.composeSensitive = !this.composeSensitive;
      this.btnComposeSensitive.classList.toggle('active', this.composeSensitive);
    });
    this.btnComposeEmoji.addEventListener('click', () => this.showComposeEmojiPicker());
    this.btnComposeVisibility.addEventListener('click', () => this.showComposeVisibilityPicker());
    this.composeFilesInput.addEventListener('change', () => this.handleComposeFileSelect());
    this.btnComposeSubmit.addEventListener('click', () => this.handleComposeSubmit());
    this.composeText.addEventListener('input', () => this._updateComposeWordCount());

    // Drag-and-drop image upload
    this.composeEditor.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.composeEditor.classList.add('drag-over');
    });
    this.composeEditor.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.composeEditor.contains(e.relatedTarget)) {
        this.composeEditor.classList.remove('drag-over');
      }
    });
    this.composeEditor.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.composeEditor.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
      for (const file of files) {
        if (this.composeFiles.length >= 4) break;
        this.composeFiles.push(file);
      }
      if (files.length > 0) this.renderComposeImagePreview();
    });

    // Cmd/Ctrl+Enter to submit
    this.composeText.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        this.handleComposeSubmit();
      }
    });

    // Paste image from clipboard
    this.composeText.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imageFiles = items
        .filter(item => item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter(Boolean);
      if (imageFiles.length > 0) {
        for (const file of imageFiles) {
          if (this.composeFiles.length >= 4) break;
          this.composeFiles.push(file);
        }
        this.renderComposeImagePreview();
      }
    });
  }

  _bindColumnEvents() {
    // Horizontal scroll with mouse wheel
    this.columnsContainer.addEventListener('wheel', (e) => {
      const columnContent = e.target.closest('.column-content');
      if (columnContent) {
        const canScrollVertically = columnContent.scrollHeight > columnContent.clientHeight;
        if (canScrollVertically) {
          const atTop = columnContent.scrollTop <= 0;
          const atBottom = columnContent.scrollTop + columnContent.clientHeight >= columnContent.scrollHeight - 1;
          if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) {
            return;
          }
        }
      }
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        this.columnsContainer.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Infinite scroll
    this.columnsContainer.addEventListener('scroll', (e) => {
      const columnContent = e.target;
      if (!columnContent.classList.contains('column-content')) return;
      const distFromBottom = columnContent.scrollHeight - columnContent.scrollTop - columnContent.clientHeight;
      if (distFromBottom < 300) {
        this.loadOlderPosts(columnContent);
      }
    }, { passive: true, capture: true });

    // Column headers: drag to scroll with momentum
    this._bindColumnHeaderDrag();

    // Column header avatar click: open profile modal
    this.columnsContainer.addEventListener('click', (e) => {
      const avatar = e.target.closest('.column-header-avatar');
      if (!avatar) return;
      e.stopPropagation();
      const accountId = avatar.dataset.profileAccountId;
      const userId = avatar.dataset.profileUserId;
      const platform = avatar.dataset.platform;
      if (!accountId || !userId) return;
      const account = this.store.getById(accountId);
      if (!account?.profile) return;
      const author = {
        id: account.profile.id,
        displayName: account.profile.displayName,
        displayNameHtml: this.escapeHtml(account.profile.displayName),
        username: account.profile.username,
        acct: account.profile.acct || account.profile.username,
        avatarUrl: account.profile.avatarUrl,
      };
      this.openProfileModal(author, platform, accountId);
    });

    // Column close/refresh buttons
    this.columnsContainer.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-action="close-column"]');
      if (closeBtn) {
        const colType = closeBtn.dataset.columnType;
        const accountId = closeBtn.dataset.accountId;
        const orderKey = colType === 'account' ? `account:${accountId}` : colType;
        if (colType === 'all') {
          this.columnState.all = false;
        } else if (colType === 'notifications') {
          this.columnState.notifications = false;
        } else if (accountId) {
          this.columnState.accounts[accountId] = false;
        }
        this.updateColumnOrder(orderKey, false);
        this.saveColumnState();
        this.renderToggleBar();
        this.toggleColumnSmooth(colType, false, accountId);
      }

      const refreshBtn = e.target.closest('[data-action="refresh-column"]');
      if (refreshBtn) {
        const colType = refreshBtn.dataset.columnType;
        const accountId = refreshBtn.dataset.accountId;
        this.refreshColumn(colType, accountId);
      }
    });
  }

  _bindColumnHeaderDrag() {
    let isDragging = false, startX = 0, startY = 0, scrollStart = 0, moved = false;
    let velocity = 0, momentumId = null;
    let prevX = 0, prevTime = 0;
    let directionLocked = false;
    const getX = (e) => e.touches ? e.touches[0].pageX : e.pageX;
    const getY = (e) => e.touches ? e.touches[0].pageY : e.pageY;
    const SMOOTHING = 0.5;

    const startDrag = (e, isTouch) => {
      const header = e.target.closest('.column-header');
      if (!header || e.target.closest('button') || e.target.closest('.column-header-avatar')) return;
      if (momentumId) { cancelAnimationFrame(momentumId); momentumId = null; }
      isDragging = true;
      directionLocked = false;
      const x = getX(e);
      startX = x;
      startY = isTouch ? getY(e) : 0;
      prevX = x;
      prevTime = performance.now();
      velocity = 0;
      scrollStart = this.columnsContainer.scrollLeft;
      moved = false;
      if (!isTouch) {
        this.columnsContainer.style.cursor = 'grabbing';
        e.preventDefault();
      }
    };
    const onMove = (e) => {
      if (!isDragging) return;
      const x = e.touches ? e.touches[0].pageX : e.pageX;
      const now = performance.now();

      if (e.touches && !directionLocked) {
        const y = e.touches[0].pageY;
        const dx = Math.abs(x - startX);
        const dy = Math.abs(y - startY);
        if (dx + dy > 5) {
          if (dx > dy) {
            directionLocked = true;
          } else {
            isDragging = false;
            return;
          }
        } else {
          return;
        }
      }

      if (e.cancelable) e.preventDefault();

      const dt = now - prevTime;
      if (dt > 0) {
        const instantV = (x - prevX) / dt;
        velocity = velocity * (1 - SMOOTHING) + instantV * SMOOTHING;
      }
      prevX = x;
      prevTime = now;
      this.columnsContainer.scrollLeft = scrollStart - (x - startX);
      if (Math.abs(x - startX) > 3) moved = true;
    };
    const onEnd = (e) => {
      if (!isDragging) return;
      isDragging = false;
      directionLocked = false;
      this.columnsContainer.style.cursor = '';
      if (Math.abs(velocity) > 0.1) {
        let v = -velocity * 16;
        const decel = 0.96;
        const step = () => {
          if (Math.abs(v) < 0.3) { momentumId = null; return; }
          this.columnsContainer.scrollLeft += v;
          v *= decel;
          momentumId = requestAnimationFrame(step);
        };
        momentumId = requestAnimationFrame(step);
      }
    };

    this.columnsContainer.addEventListener('mousedown', (e) => startDrag(e, false));
    this.columnsContainer.addEventListener('touchstart', (e) => startDrag(e, true), { passive: true });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);

    this.columnsContainer.addEventListener('click', (e) => {
      if (moved) return;
      const header = e.target.closest('.column-header');
      if (!header || e.target.closest('button')) return;
      const col = header.closest('.column');
      if (!col) return;
      this.focusColumn(col);
    });
  }

  _bindKeyboardEvents() {
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        e.stopPropagation();
        const accountId = this.getFocusedColumnAccountId();
        this.openComposeModal(null, accountId || null);
        return;
      }

      if (e.key === 'Escape') {
        if (this.closeTopmostModal()) return;
        this.closeLightbox();
        this.closeAccountPicker();
        this.closeReactionPicker();
        this.closeReactionPopup();
        return;
      }

      if (e.target.matches('input, textarea, select')) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.navigateColumn(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.navigateColumn(1);
      }
    });
  }

  // ===== Column Navigation =====

  navigateColumn(direction) {
    const columns = this.columnsContainer.querySelectorAll('.column');
    if (columns.length === 0) return;

    this.focusedColumnIndex += direction;
    if (this.focusedColumnIndex < 0) this.focusedColumnIndex = 0;
    if (this.focusedColumnIndex >= columns.length) this.focusedColumnIndex = columns.length - 1;

    this.focusColumn(columns[this.focusedColumnIndex]);
  }

  focusColumn(col) {
    const columns = this.columnsContainer.querySelectorAll('.column');
    columns.forEach(c => c.classList.remove('focused'));
    col.classList.add('focused');
    // Update index
    this.focusedColumnIndex = [...columns].indexOf(col);
    col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  // Get the account ID of the currently focused column (null if 'all' or 'notifications')
  getFocusedColumnAccountId() {
    const columns = this.columnsContainer.querySelectorAll('.column');
    const focused = columns[this.focusedColumnIndex];
    if (!focused) return null;
    if (focused.dataset.columnType === 'account') return focused.dataset.accountId || null;
    return null;
  }

  // ===== Lightbox =====

  openLightbox(url, sourceImg) {
    this._lightboxSourceImg = sourceImg || null;
    this.lightboxImg.src = url;
    this.lightbox.style.display = 'flex';
    // Animate from source thumbnail position
    if (sourceImg) {
      const rect = sourceImg.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      this.lightboxImg.style.transformOrigin = `${cx}px ${cy}px`;
      this.lightboxImg.classList.remove('lb-enter', 'lb-exit');
      void this.lightboxImg.offsetWidth;
      this.lightboxImg.classList.add('lb-enter');
    }
    requestAnimationFrame(() => this.lightbox.classList.add('visible'));
  }

  closeLightbox() {
    this.lightbox.classList.remove('visible');
    this.lightboxImg.classList.remove('lb-enter');
    this.lightboxImg.classList.add('lb-exit');
    const onDone = () => {
      this.lightboxImg.removeEventListener('animationend', onDone);
      this.lightbox.style.display = 'none';
      this.lightboxImg.src = '';
      this.lightboxImg.classList.remove('lb-exit');
      this.lightboxImg.style.transformOrigin = '';
      this._lightboxSourceImg = null;
    };
    this.lightboxImg.addEventListener('animationend', onDone);
    // Fallback if animation doesn't fire
    setTimeout(onDone, 200);
  }

  // ===== Rendering =====

  render() {
    const hasAccounts = !this.store.isEmpty();
    const loggedIn = !!this._currentUser;
    this.emptyState.style.display = hasAccounts ? 'none' : 'flex';
    this.columnsContainer.style.display = hasAccounts ? 'flex' : 'none';
    this.toggleBar.style.display = hasAccounts ? 'flex' : 'none';

    // Welcome vs add-account prompt
    const welcome = document.getElementById('welcome-screen');
    const addPrompt = document.getElementById('add-account-prompt');
    if (!hasAccounts) {
      if (loggedIn) {
        welcome.style.display = 'none';
        addPrompt.style.display = 'flex';
      } else {
        welcome.style.display = 'flex';
        addPrompt.style.display = 'none';
      }
    }

    // Hide/show header action buttons based on login state
    document.getElementById('btn-compose-header').style.display = loggedIn ? '' : 'none';
    document.getElementById('btn-refresh-all').style.display = loggedIn ? '' : 'none';

    // Ensure all accounts have a column state entry
    for (const account of this.store.getAll()) {
      if (!(account.id in this.columnState.accounts)) {
        this.columnState.accounts[account.id] = false; // Not shown by default
      }
    }
    this.saveColumnState();

    this.renderToggleBar();
    this.renderColumns();
  }

  renderToggleBar() {
    this.toggleBar.innerHTML = '';
    const accounts = this.store.getAll();

    // "전체" toggle
    const allToggle = document.createElement('button');
    allToggle.className = `col-toggle fixed ${this.columnState.all ? 'active' : ''}`;
    allToggle.dataset.toggleType = 'all';
    allToggle.textContent = '전체';
    this.toggleBar.appendChild(allToggle);

    // "알림" toggle
    const notifToggle = document.createElement('button');
    notifToggle.className = `col-toggle fixed ${this.columnState.notifications ? 'active' : ''}`;
    notifToggle.dataset.toggleType = 'notifications';
    notifToggle.textContent = '알림';
    this.toggleBar.appendChild(notifToggle);

    if (accounts.length > 0) {
      // Separator
      const sep = document.createElement('div');
      sep.className = 'col-toggle-separator';
      this.toggleBar.appendChild(sep);

      // Account toggles
      for (const account of accounts) {
        const toggle = document.createElement('button');
        const isActive = this.columnState.accounts[account.id] === true;
        toggle.className = `col-toggle ${isActive ? 'active' : ''}`;
        toggle.dataset.toggleType = 'account';
        toggle.dataset.accountId = account.id;
        const dotStyle = account.themeColor ? `style="background:${account.themeColor}"` : '';
        toggle.innerHTML = `<span class="platform-dot ${account.platform}" ${dotStyle}></span>${this.escapeHtml(account.label || account.profile.displayName)}`;
        this.toggleBar.appendChild(toggle);
      }
    }

  }

  handleToggleClick(toggle) {
    const type = toggle.dataset.toggleType;

    if (type === 'all') {
      this.columnState.all = !this.columnState.all;
      this.updateColumnOrder('all', this.columnState.all);
      this.saveColumnState();
      this.renderToggleBar();
      this.toggleColumnSmooth('all', this.columnState.all);
    } else if (type === 'notifications') {
      this.columnState.notifications = !this.columnState.notifications;
      this.updateColumnOrder('notifications', this.columnState.notifications);
      this.saveColumnState();
      this.renderToggleBar();
      this.toggleColumnSmooth('notifications', this.columnState.notifications);
    } else if (type === 'account') {
      const accountId = toggle.dataset.accountId;
      this.columnState.accounts[accountId] = !this.columnState.accounts[accountId];
      this.updateColumnOrder(`account:${accountId}`, this.columnState.accounts[accountId]);
      this.saveColumnState();
      this.renderToggleBar();
      this.toggleColumnSmooth('account', this.columnState.accounts[accountId], accountId);
    }
  }

  updateColumnOrder(key, visible) {
    if (!this.columnState.order) this.columnState.order = [];
    const idx = this.columnState.order.indexOf(key);
    if (visible) {
      // Add to end if not already present
      if (idx === -1) this.columnState.order.push(key);
    } else {
      // Remove from order
      if (idx !== -1) this.columnState.order.splice(idx, 1);
    }
  }

  toggleColumnSmooth(type, visible, accountId = null) {
    if (visible) {
      // Build and insert column at the correct position
      const col = this.buildSingleColumn(type, accountId);
      if (!col) return;

      const refNode = this.getColumnInsertionPoint(type, accountId);
      this.columnsContainer.insertBefore(col, refNode);

      // Animate in
      col.style.opacity = '0';
      col.style.transform = 'scale(0.95)';
      col.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      requestAnimationFrame(() => {
        col.style.opacity = '1';
        col.style.transform = 'scale(1)';
        setTimeout(() => { col.style.transition = ''; col.style.transform = ''; }, 350);
      });

      // Load data
      this.loadColumnData(col, type, accountId);
    } else {
      // Find and animate out
      const col = this.findColumnElement(type, accountId);
      if (!col) return;

      col.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      col.style.opacity = '0';
      col.style.transform = 'scale(0.95)';
      setTimeout(() => col.remove(), 260);
    }
  }

  buildSingleColumn(type, accountId) {
    if (type === 'all') {
      return this.createColumn('전체', 'all', null);
    } else if (type === 'notifications') {
      return this.createColumn('알림', 'notifications', null);
    } else if (type === 'account' && accountId) {
      const account = this.store.getById(accountId);
      if (!account) return null;
      const name = this.escapeHtml(account.label || account.profile.displayName);
      return this.createColumn(name, 'account', account.id);
    }
    return null;
  }

  loadColumnData(col, type, accountId) {
    const content = col.querySelector('.column-content');
    const visibleAccounts = this.getVisibleAccounts();
    if (type === 'all') {
      this.loadTimelineForColumn(content, visibleAccounts);
    } else if (type === 'notifications') {
      this.loadNotificationsForColumn(content, visibleAccounts);
    } else if (type === 'account' && accountId) {
      const account = this.store.getById(accountId);
      if (account) {
        this.loadTimelineForColumn(content, [account]);
      }
    }
  }

  findColumnElement(type, accountId) {
    const columns = this.columnsContainer.querySelectorAll('.column');
    for (const col of columns) {
      if (col.dataset.columnType === type) {
        if (type === 'account') {
          if (col.dataset.accountId === accountId) return col;
        } else {
          return col;
        }
      }
    }
    return null;
  }

  // Determine correct insertion position using the saved toggle order
  getColumnInsertionPoint(type, accountId) {
    const existing = [...this.columnsContainer.querySelectorAll('.column')];
    const order = this.columnState.order || [];

    const myKey = type === 'account' ? `account:${accountId}` : type;
    const myIndex = order.indexOf(myKey);

    // Find the first existing column that should come AFTER this one in the order
    for (let i = myIndex + 1; i < order.length; i++) {
      const key = order[i];
      for (const col of existing) {
        const colKey = col.dataset.columnType === 'account'
          ? `account:${col.dataset.accountId}`
          : col.dataset.columnType;
        if (colKey === key) return col;
      }
    }
    return null; // append to end
  }

  getVisibleAccounts() {
    return this.store.getAll().filter(a => this.columnState.accounts[a.id] === true);
  }

  renderColumns() {
    this.columnsContainer.innerHTML = '';
    const allAccounts = this.store.getAll();
    if (allAccounts.length === 0) return;

    const visibleAccounts = this.getVisibleAccounts();
    const order = this.columnState.order || [];

    // Render columns in saved toggle order
    for (const key of order) {
      if (key === 'all' && this.columnState.all) {
        const col = this.createColumn('전체', 'all', null);
        this.columnsContainer.appendChild(col);
        this.loadTimelineForColumn(col.querySelector('.column-content'), visibleAccounts);
      } else if (key === 'notifications' && this.columnState.notifications) {
        const col = this.createColumn('알림', 'notifications', null);
        this.columnsContainer.appendChild(col);
        this.loadNotificationsForColumn(col.querySelector('.column-content'), visibleAccounts);
      } else if (key.startsWith('account:')) {
        const accountId = key.slice('account:'.length);
        if (this.columnState.accounts[accountId]) {
          const account = this.store.getById(accountId);
          if (account) {
            const name = this.escapeHtml(account.label || account.profile.displayName);
            const col = this.createColumn(name, 'account', account.id);
            this.columnsContainer.appendChild(col);
            this.loadTimelineForColumn(col.querySelector('.column-content'), [account]);
          }
        }
      }
    }
  }

  createColumn(title, type, accountId) {
    const col = document.createElement('section');
    col.className = 'column';
    col.dataset.columnType = type;
    if (accountId) col.dataset.accountId = accountId;

    let avatarHtml = '';
    if (type === 'account' && accountId) {
      const account = this.store.getById(accountId);
      if (account?.profile?.avatarUrl) {
        const borderStyle = account.themeColor ? `style="border-color:${account.themeColor}"` : '';
        avatarHtml = `<img class="column-header-avatar" ${borderStyle} src="${this.escapeHtml(account.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" data-profile-account-id="${accountId}" data-profile-user-id="${account.profile.id}" data-platform="${account.platform}">`;
      }
    } else if (type === 'all' || type === 'notifications') {
      // Show all account avatars stacked horizontally
      const accounts = this.store.getAll();
      if (accounts.length > 0) {
        const avatars = accounts.map(a => {
          if (!a.profile?.avatarUrl) return '';
          const borderStyle = a.themeColor ? `style="border-color:${a.themeColor}"` : '';
          return `<img class="column-header-avatar stacked" ${borderStyle} src="${this.escapeHtml(a.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" data-profile-account-id="${a.id}" data-profile-user-id="${a.profile.id}" data-platform="${a.platform}">`;
        }).filter(Boolean).join('');
        avatarHtml = `<span class="column-header-avatars">${avatars}</span>`;
      }
    }

    col.innerHTML = `
      <div class="column-header">
        <h2>${avatarHtml}${title}</h2>
        <div class="column-header-actions">
          <button class="btn btn-icon btn-small" data-action="refresh-column" data-column-type="${type}" ${accountId ? `data-account-id="${accountId}"` : ''} title="새로고침">${iconRefresh}</button>
          <button class="btn btn-icon btn-small" data-action="close-column" data-column-type="${type}" ${accountId ? `data-account-id="${accountId}"` : ''} title="닫기">${iconClose}</button>
        </div>
      </div>
      <div class="column-content"></div>
    `;

    return col;
  }

  _refreshColumnHeaders() {
    // Update toggle bar (account names)
    this.renderToggleBar();
    // Update column header titles and avatars in-place (no timeline reload)
    const columns = this.columnsContainer.querySelectorAll('.column');
    for (const col of columns) {
      const type = col.dataset.columnType;
      const h2 = col.querySelector('.column-header h2');
      if (!h2) continue;

      if (type === 'account') {
        const accountId = col.dataset.accountId;
        const account = this.store.getById(accountId);
        if (account) {
          const name = this.escapeHtml(account.label || account.profile.displayName);
          let avatarHtml = '';
          if (account.profile?.avatarUrl) {
            const borderStyle = account.themeColor ? `style="border-color:${account.themeColor}"` : '';
            avatarHtml = `<img class="column-header-avatar" ${borderStyle} src="${this.escapeHtml(account.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" data-profile-account-id="${accountId}" data-profile-user-id="${account.profile.id}" data-platform="${account.platform}">`;
          }
          h2.innerHTML = `${avatarHtml}${name}`;
        }
      } else if (type === 'all' || type === 'notifications') {
        const title = type === 'all' ? '전체' : '알림';
        const accounts = this.store.getAll();
        let avatarHtml = '';
        if (accounts.length > 0) {
          const avatars = accounts.map(a => {
            if (!a.profile?.avatarUrl) return '';
            const borderStyle = a.themeColor ? `style="border-color:${a.themeColor}"` : '';
            return `<img class="column-header-avatar stacked" ${borderStyle} src="${this.escapeHtml(a.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" data-profile-account-id="${a.id}" data-profile-user-id="${a.profile.id}" data-platform="${a.platform}">`;
          }).filter(Boolean).join('');
          avatarHtml = `<span class="column-header-avatars">${avatars}</span>`;
        }
        h2.innerHTML = `${avatarHtml}${title}`;
      }
    }
  }

  async refreshColumn(colType, accountId) {
    const columns = this.columnsContainer.querySelectorAll('.column');
    for (const col of columns) {
      if (col.dataset.columnType === colType &&
          (!accountId || col.dataset.accountId === accountId)) {
        // Visual feedback: start refresh animation
        col.classList.add('refreshing');
        const refreshBtn = col.querySelector('[data-action="refresh-column"]');
        if (refreshBtn) refreshBtn.classList.add('spinning');

        const content = col.querySelector('.column-content');
        try {
          if (colType === 'all') {
            await this.loadTimelineForColumn(content, this.store.getAll());
          } else if (colType === 'notifications') {
            await this.loadNotificationsForColumn(content, this.store.getAll());
          } else if (colType === 'account' && accountId) {
            const account = this.store.getById(accountId);
            if (account) {
              await this.loadTimelineForColumn(content, [account]);
            }
          }
        } finally {
          // End refresh animation with a brief flash
          if (refreshBtn) refreshBtn.classList.remove('spinning');
          col.classList.remove('refreshing');
          col.classList.add('refresh-done');
          setTimeout(() => col.classList.remove('refresh-done'), 600);
        }
      }
    }
  }

  // ===== Auto Refresh =====

  startAutoRefresh() {
    this.stopAutoRefresh();
    if (!this.AUTO_REFRESH_INTERVAL || this.AUTO_REFRESH_INTERVAL <= 0) return;
    this.autoRefreshTimer = setInterval(() => {
      if (!this.store.isEmpty()) {
        this.refreshAll();
      }
    }, this.AUTO_REFRESH_INTERVAL);
  }

  stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  // ===== Helpers =====

  openModal(overlay) {
    // Dynamically set z-index above all currently visible modals
    const visibleModals = [...document.querySelectorAll('.modal-overlay')]
      .filter(m => m.style.display !== 'none' && m.classList.contains('visible'));
    if (visibleModals.length > 0) {
      const maxZ = Math.max(...visibleModals.map(m => parseInt(getComputedStyle(m).zIndex) || 600));
      overlay.style.zIndex = String(maxZ + 1);
    } else {
      overlay.style.zIndex = '';
    }
    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('visible'));
  }

  closeModal(overlay) {
    if (!overlay || overlay.style.display === 'none') return;
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', () => {
      if (!overlay.classList.contains('visible')) {
        overlay.style.display = 'none';
        overlay.style.zIndex = '';
      }
    }, { once: true });
  }

  /** Close only the topmost visible modal (highest z-index). Returns true if a modal was closed. */
  closeTopmostModal() {
    const visibleModals = [...document.querySelectorAll('.modal-overlay')]
      .filter(m => m.style.display !== 'none' && m.classList.contains('visible'));
    if (visibleModals.length === 0) return false;
    // Sort by computed z-index descending → close the topmost
    visibleModals.sort((a, b) => {
      const zA = parseInt(getComputedStyle(a).zIndex) || 0;
      const zB = parseInt(getComputedStyle(b).zIndex) || 0;
      if (zB !== zA) return zB - zA;
      // Same z-index: later in DOM = visually on top
      return Array.from(a.parentNode.children).indexOf(b) - Array.from(a.parentNode.children).indexOf(a);
    });
    const top = visibleModals[0];
    this.closeModal(top);
    if (top.id === 'modal-compose') { this.closeComposeEmojiPicker(); this.closeComposeVisibilityPicker(); }
    return true;
  }

  // Profile modal methods are in mixins/profile-modal.js

  /** Fetch OG metadata for link cards that lack title/image and update DOM */
  enrichLinkCards(container) {
    // Resolve fediverse post links first
    const fediCards = container.querySelectorAll('.link-card[data-fedi-pending]');
    for (const card of fediCards) {
      const url = card.dataset.fediUrl;
      if (!url) continue;
      card.removeAttribute('data-fedi-pending');
      this._enrichSingleCard(card, url);
    }
    // Then handle regular OG cards
    const cards = container.querySelectorAll('.link-card[data-og-pending]');
    for (const card of cards) {
      const url = card.dataset.ogUrl;
      if (!url) continue;
      card.removeAttribute('data-og-pending');
      this._enrichSingleCard(card, url);
    }
  }

  _isFediPostUrl(url) {
    try {
      const u = new URL(url);
      // Misskey: /notes/xxxx
      if (/^\/notes\/[a-zA-Z0-9]+$/.test(u.pathname)) return true;
      // Mastodon: /@user/123456 or /@user@host/123456
      if (/^\/@[^/]+\/\d+$/.test(u.pathname)) return true;
      // Pleroma/Akkoma: /notice/xxxx or /objects/xxxx
      if (/^\/(notice|objects)\/[a-zA-Z0-9\-]+$/.test(u.pathname)) return true;
      return false;
    } catch { return false; }
  }

  async _resolveAsFediPost(url) {
    // Try resolving via any available account
    const accounts = this.store.getAll();
    for (const account of accounts) {
      const client = this.store.getClient(account.id);
      if (!client?.resolveUrl) continue;
      try {
        const post = await client.resolveUrl(url);
        if (post) return { post, accountId: account.id };
      } catch { /* try next */ }
    }
    return null;
  }

  _buildFediEmbedHtml(post) {
    const dp = post.reblog || post;
    const author = dp.author || {};
    const avatarUrl = this.escapeHtml(author.avatarUrl || '');
    const displayName = author.displayNameHtml || this.escapeHtml(author.displayName || '');
    const acct = this.escapeHtml(author.acct || '');
    const content = dp.content || '';
    const media = dp.media || [];
    const images = media.filter(m => m.type !== 'video').slice(0, 4);

    let html = `
      <div class="quote-post fedi-embed" data-fedi-url="${this.escapeHtml(dp.url || '')}" data-post-id="${this.escapeHtml(dp.id || '')}" data-platform="${dp.platform || ''}">
        <div class="quote-post-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" opacity="0.6"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg> 연합 글</div>
        <div class="quote-post-body">
          <div class="quote-post-text-area">
            <div class="quote-post-header">
              <img class="quote-post-avatar" src="${avatarUrl}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
              <span class="quote-post-author">${displayName}</span>
              <span class="quote-post-handle">@${acct}</span>
            </div>`;

    if (dp.contentWarning) {
      html += `<div class="quote-post-cw"><span class="icon-inline cw-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span> ${this.escapeHtml(dp.contentWarning)}</div>`;
    } else {
      html += `<div class="quote-post-content">${content}</div>`;
    }

    html += `</div>`;

    if (images.length === 1) {
      html += `<div class="quote-post-thumb"><img src="${images[0].previewUrl || images[0].url}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.style.display='none'"></div>`;
    }
    html += `</div>`;

    if (images.length > 1) {
      html += `<div class="quote-post-media media-${images.length}">${images.map(m => `<img src="${m.previewUrl || m.url}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`).join('')}</div>`;
    }

    html += `</div>`;
    return html;
  }

  async _enrichSingleCard(card, url) {
    // Try to resolve as fediverse post first
    if (this._isFediPostUrl(url)) {
      try {
        const result = await this._resolveAsFediPost(url);
        if (result) {
          const { post, accountId: resolvedAccountId } = result;
          const embedHtml = this._buildFediEmbedHtml(post);
          const wrapper = document.createElement('div');
          wrapper.innerHTML = embedHtml;
          const embed = wrapper.firstElementChild;
          // Make clickable to open thread
          embed.style.cursor = 'pointer';
          embed.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (post.id && resolvedAccountId) {
              this.openThreadView(post.id, post.platform, resolvedAccountId);
            } else {
              window.open(url, '_blank', 'noopener');
            }
          });
          card.replaceWith(embed);
          return;
        }
      } catch { /* fall through to OG */ }
    }

    let og = this._ogCache.get(url);
    if (!og) {
      try {
        const res = await fetch(`/api/og?url=${encodeURIComponent(url)}`);
        if (!res.ok) return;
        og = await res.json();
        if (og.error) return;
        this._ogCache.set(url, og);
      } catch { return; }
    }

    // Update the card DOM with OG data
    if (og.image) {
      const img = document.createElement('img');
      img.className = 'link-card-image';
      img.src = og.image;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function() {
        this.parentElement.classList.remove('link-card-has-image');
        this.style.display = 'none';
      };
      card.classList.add('link-card-has-image');
      card.prepend(img);
    }

    const infoEl = card.querySelector('.link-card-info');
    if (!infoEl) return;

    if (og.siteName) {
      const siteEl = infoEl.querySelector('.link-card-site');
      if (siteEl) siteEl.textContent = og.siteName;
    }
    if (og.title) {
      const urlEl = infoEl.querySelector('.link-card-url');
      if (urlEl) urlEl.remove();
      const titleEl = document.createElement('div');
      titleEl.className = 'link-card-title';
      titleEl.textContent = og.title;
      const siteEl = infoEl.querySelector('.link-card-site');
      if (siteEl) siteEl.after(titleEl);
    }
    if (og.description) {
      const descEl = document.createElement('div');
      descEl.className = 'link-card-desc';
      descEl.textContent = og.description;
      infoEl.appendChild(descEl);
    }
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  showToast(message, type = 'error') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      toast.addEventListener('transitionend', () => toast.remove());
    }, 3500);
  }
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
);

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  const app = new StarShipApp();
  window.app = app;

  // Redirect OAuth callback
  const authResult = localStorage.getItem('starship_auth_result');
  if (authResult) {
    localStorage.removeItem('starship_auth_result');
    try {
      const result = JSON.parse(authResult);
      await app.store.addAccount(result.platform, result.instanceUrl, result.accessToken);
      app.debouncedSaveToCloud();
      app.render();
    } catch (err) {
      console.error('OAuth 콜백 처리 실패:', err);
    }
  }
});
