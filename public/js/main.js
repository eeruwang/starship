/**
 * StarShip - Main Application
 * Fediverse multi-account dashboard for Misskey, Iceshrimp, CherryPick, and Mastodon.
 */
import { AccountStore } from './accounts.js';
import { renderPost, renderNotification, renderAccountCard, renderLoading, renderLoadingText, iconRefresh, iconClose } from './ui/dashboard.js';
import { startMastodonOAuth, startMiAuth, waitForAuthCallback, clearPendingAuth } from './auth.js';

const COLUMN_STATE_KEY = 'starship_column_state';
const SETTINGS_KEY = 'starship_settings';

class StarShipApp {
  constructor() {
    this.store = new AccountStore();
    this.autoRefreshTimer = null;
    this.focusedColumnIndex = 0;
    this.postCache = new Map(); // key: `${platform}:${id}`, value: post
    this.POST_CACHE_MAX = 500;
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
    this._siteInfo = { registrationOpen: true, turnstileSiteKey: null };
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
        };
      }
    } catch {}
    return { refreshInterval: 60000, columnWidth: 380, fontSize: 14, postsCount: 30 };
  }

  saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    this.debouncedSaveToCloud();
  }

  applySettings() {
    document.documentElement.style.setProperty('--column-width', `${this.settings.columnWidth}px`);
    document.documentElement.style.fontSize = `${this.settings.fontSize}px`;
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
    } catch {}
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
    this.btnComposeEmoji = document.getElementById('btn-compose-emoji');
    this.btnComposeSubmit = document.getElementById('btn-compose-submit');
    this.composeError = document.getElementById('compose-error');

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
    // Open add account modal
    this.btnAddAccount?.addEventListener('click', () => this.openAddAccountModal());
    this.btnAddFirst?.addEventListener('click', () => this.openAddAccountModal());
    document.getElementById('btn-welcome-login')?.addEventListener('click', () => this.handleAuthButtonClick());

    // Header compose button
    document.getElementById('btn-compose-header').addEventListener('click', () => this.openComposeModal());

    // Refresh (full reload: re-fetch profiles + all content)
    this.btnRefreshAll.addEventListener('click', () => this.refreshAll(true));

    // Settings
    this.btnSettings.addEventListener('click', () => this.openSettingsModal());

    // Auth
    this.btnAuth.addEventListener('click', () => this.handleAuthButtonClick());
    this.btnAuthSubmit.addEventListener('click', () => this.handleAuthSubmit());
    this.btnAuthSwitch.addEventListener('click', () => this.toggleAuthMode());
    this.authPassword.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleAuthSubmit();
    });

    // User menu actions
    document.querySelectorAll('.user-menu-item[data-action]').forEach(item => {
      item.addEventListener('click', () => this.handleUserMenuAction(item.dataset.action));
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
      } catch (err) { console.error('Import failed:', err); alert('파일을 읽을 수 없습니다.'); }
      e.target.value = '';
    });

    // Modal close
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.closeModal;
        this.closeModal(document.getElementById(modalId));
        if (modalId === 'modal-compose') this.closeComposeEmojiPicker();
      });
    });

    // Close modal on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          this.closeModal(overlay);
          this.closeComposeEmojiPicker();
        }
      });
    });

    // Instance URL input: auto-detect platform on blur/change
    this.instanceUrl.addEventListener('input', () => {
      this.updateOAuthButton();
    });

    this.instanceUrl.addEventListener('blur', () => {
      this.autoDetectPlatform();
    });

    // OAuth login
    this.btnOAuthLogin.addEventListener('click', () => this.handleOAuthLogin());

    // Manual token add
    this.btnConfirmAdd.addEventListener('click', () => this.handleAddAccount());

    // Toggle bar clicks
    this.toggleBar.addEventListener('click', (e) => {
      const toggle = e.target.closest('.col-toggle');
      if (!toggle) return;
      this.handleToggleClick(toggle);
    });

    // CW toggle (delegated)
    document.addEventListener('click', (e) => {
      if (e.target.matches('.cw-toggle')) {
        const target = document.getElementById(e.target.dataset.cwTarget);
        if (target) target.classList.toggle('visible');
        e.target.textContent = target?.classList.contains('visible') ? '숨기기' : '내용 보기';
      }
    });

    // Expand toggle for long content (reply context, notification content)
    document.addEventListener('click', (e) => {
      if (e.target.matches('.expand-toggle')) {
        const target = document.getElementById(e.target.dataset.expandTarget);
        if (target) {
          target.classList.toggle('collapsed');
          e.target.textContent = target.classList.contains('collapsed') ? '더보기' : '접기';
        }
      }
    });

    // Post actions (delegated)
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
      }
    });

    // Notification reply: click whole card
    document.addEventListener('click', (e) => {
      const card = e.target.closest('.notif-clickable');
      if (!card) return;
      // Don't trigger on lightbox images or expand toggles
      if (e.target.closest('[data-lightbox]') || e.target.closest('.expand-toggle')) return;
      const postId = card.dataset.postId;
      const accountId = card.dataset.accountId;
      if (postId && accountId) {
        this.openComposeModal(postId, accountId);
      }
    });

    // Reaction badge hover/click: show who reacted
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
      this.showReactionUsers(badge, postId, platform, accountId, reaction);
    });

    // Image lightbox (delegated)
    document.addEventListener('click', (e) => {
      const img = e.target.closest('img[data-lightbox="true"]');
      if (!img) return;
      e.preventDefault();
      e.stopPropagation();
      const fullUrl = img.dataset.fullUrl || img.src;
      this.openLightbox(fullUrl);
    });

    // Lightbox close
    this.lightboxClose.addEventListener('click', () => this.closeLightbox());
    this.lightbox.addEventListener('click', (e) => {
      if (e.target === this.lightbox) this.closeLightbox();
    });

    // Horizontal scroll with mouse wheel
    this.columnsContainer.addEventListener('wheel', (e) => {
      // If the target is inside column-content that can scroll vertically, let it scroll
      const columnContent = e.target.closest('.column-content');
      if (columnContent) {
        const canScrollVertically = columnContent.scrollHeight > columnContent.clientHeight;
        if (canScrollVertically) {
          // Check if we're at scroll boundaries
          const atTop = columnContent.scrollTop <= 0;
          const atBottom = columnContent.scrollTop + columnContent.clientHeight >= columnContent.scrollHeight - 1;

          // If scrolling down and not at bottom, or scrolling up and not at top, let vertical scroll happen
          if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) {
            return; // Let vertical scroll happen naturally
          }
        }
      }

      // Otherwise, convert vertical wheel to horizontal scroll
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        this.columnsContainer.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Infinite scroll: load older posts when near bottom of a column
    this.columnsContainer.addEventListener('scroll', (e) => {
      const columnContent = e.target;
      if (!columnContent.classList.contains('column-content')) return;
      const distFromBottom = columnContent.scrollHeight - columnContent.scrollTop - columnContent.clientHeight;
      if (distFromBottom < 300) {
        this.loadOlderPosts(columnContent);
      }
    }, { passive: true, capture: true });

    // Arrow key navigation
    document.addEventListener('keydown', (e) => {
      // Cmd/Ctrl+N: open compose modal (override browser new-window)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        e.stopPropagation();
        this.openComposeModal();
        return;
      }

      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay').forEach(m => this.closeModal(m));
        this.closeLightbox();
        this.closeAccountPicker();
        this.closeReactionPopup();
        return;
      }

      // Don't handle arrows when focused on input elements
      if (e.target.matches('input, textarea, select')) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.navigateColumn(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.navigateColumn(1);
      }
    });

    // Compose modal
    this.btnComposeAttach.addEventListener('click', () => this.composeFilesInput.click());
    this.btnComposeEmoji.addEventListener('click', () => this.showComposeEmojiPicker());
    this.composeFilesInput.addEventListener('change', () => this.handleComposeFileSelect());
    this.btnComposeSubmit.addEventListener('click', () => this.handleComposeSubmit());

    // Drag-and-drop image upload on compose editor
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

    // Cmd/Ctrl+Enter to submit compose
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

    // Column close buttons (delegated)
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

      // Column refresh buttons
      const refreshBtn = e.target.closest('[data-action="refresh-column"]');
      if (refreshBtn) {
        const colType = refreshBtn.dataset.columnType;
        const accountId = refreshBtn.dataset.accountId;
        this.refreshColumn(colType, accountId);
      }
    });
  }

  // ===== Column Navigation =====

  navigateColumn(direction) {
    const columns = this.columnsContainer.querySelectorAll('.column');
    if (columns.length === 0) return;

    // Remove old focus
    columns.forEach(c => c.classList.remove('focused'));

    this.focusedColumnIndex += direction;
    if (this.focusedColumnIndex < 0) this.focusedColumnIndex = 0;
    if (this.focusedColumnIndex >= columns.length) this.focusedColumnIndex = columns.length - 1;

    const target = columns[this.focusedColumnIndex];
    target.classList.add('focused');
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  // ===== Lightbox =====

  openLightbox(url) {
    this.lightboxImg.src = url;
    this.lightbox.style.display = 'flex';
    requestAnimationFrame(() => this.lightbox.classList.add('visible'));
  }

  closeLightbox() {
    this.lightbox.classList.remove('visible');
    setTimeout(() => {
      this.lightbox.style.display = 'none';
      this.lightboxImg.src = '';
    }, 200);
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
    const accounts = this.store.getAll();
    if (type === 'all') {
      this.loadTimelineForColumn(content, accounts);
    } else if (type === 'notifications') {
      this.loadNotificationsForColumn(content, accounts);
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

  renderColumns() {
    this.columnsContainer.innerHTML = '';
    const allAccounts = this.store.getAll();
    if (allAccounts.length === 0) return;

    const order = this.columnState.order || [];

    // Render columns in saved toggle order
    for (const key of order) {
      if (key === 'all' && this.columnState.all) {
        const col = this.createColumn('전체', 'all', null);
        this.columnsContainer.appendChild(col);
        this.loadTimelineForColumn(col.querySelector('.column-content'), allAccounts);
      } else if (key === 'notifications' && this.columnState.notifications) {
        const col = this.createColumn('알림', 'notifications', null);
        this.columnsContainer.appendChild(col);
        this.loadNotificationsForColumn(col.querySelector('.column-content'), allAccounts);
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

    col.innerHTML = `
      <div class="column-header">
        <h2>${title}</h2>
        <div class="column-header-actions">
          <button class="btn btn-icon btn-small" data-action="refresh-column" data-column-type="${type}" ${accountId ? `data-account-id="${accountId}"` : ''} title="새로고침">${iconRefresh}</button>
          <button class="btn btn-icon btn-small" data-action="close-column" data-column-type="${type}" ${accountId ? `data-account-id="${accountId}"` : ''} title="닫기">${iconClose}</button>
        </div>
      </div>
      <div class="column-content"></div>
    `;

    return col;
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

  // ===== Data Loading =====

  async refreshAll(fullReload = false) {
    // Visual feedback on the top refresh button
    this.btnRefreshAll.classList.add('refreshing');
    this.btnRefreshAll.disabled = true;

    try {
      // Full reload: re-fetch all account profiles first
      if (fullReload) {
        await this.store.refreshAllProfiles();
        // Re-render toggle bar with updated names/avatars
        this.renderToggleBar();
      }

      // Refresh all visible columns with individual animations
      const columns = this.columnsContainer.querySelectorAll('.column');
      const promises = [];
      for (const col of columns) {
        col.classList.add('refreshing');
        const refreshBtn = col.querySelector('[data-action="refresh-column"]');
        if (refreshBtn) refreshBtn.classList.add('spinning');

        const content = col.querySelector('.column-content');
        const type = col.dataset.columnType;
        const accountId = col.dataset.accountId;

        let loadPromise;
        if (type === 'all') {
          loadPromise = this.loadTimelineForColumn(content, this.store.getAll());
        } else if (type === 'notifications') {
          loadPromise = this.loadNotificationsForColumn(content, this.store.getAll());
        } else if (type === 'account' && accountId) {
          const account = this.store.getById(accountId);
          if (account) {
            loadPromise = this.loadTimelineForColumn(content, [account]);
          }
        }

        if (loadPromise) {
          promises.push(loadPromise.finally(() => {
            if (refreshBtn) refreshBtn.classList.remove('spinning');
            col.classList.remove('refreshing');
            col.classList.add('refresh-done');
            setTimeout(() => col.classList.remove('refresh-done'), 600);
          }));
        }
      }
      await Promise.all(promises);
    } finally {
      this.btnRefreshAll.classList.remove('refreshing');
      this.btnRefreshAll.disabled = false;
    }
  }

  async loadTimelineForColumn(container, accounts) {
    if (accounts.length === 0) {
      container.innerHTML = '<div class="loading-text">표시할 타임라인이 없습니다.</div>';
      return;
    }

    const existingCards = container.querySelectorAll('.post-card');
    const isFirstLoad = existingCards.length === 0;

    if (isFirstLoad) {
      container.innerHTML = '';
      container.appendChild(renderLoading());
    }

    try {
      const allPosts = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];

          try {
            const items = await client.getHomeTimeline(this.settings.postsCount);
            return items.map(item => {
              const post = client.normalizePost(item);
              post.accountId = account.id;
              post.accountPlatform = account.platform;
              post.themeColor = account.themeColor || null;
              return post;
            });
          } catch (err) {
            console.error(`Timeline error for ${account.label}:`, err);
            return [];
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allPosts.push(...result.value);
        }
      }

      // Sort by time descending, with stable tiebreaker by accountId then post id
      allPosts.sort((a, b) => {
        const timeDiff = b.createdAt - a.createdAt;
        if (timeDiff !== 0) return timeDiff;
        // Stable tiebreaker: sort by accountId so dedup always picks the same winner
        if (a.accountId < b.accountId) return -1;
        if (a.accountId > b.accountId) return 1;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });

      // Deduplicate posts by canonical URI (same post seen from different accounts)
      // Renotes/reblogs are kept as separate timeline entries from the original
      if (accounts.length > 1) {
        const seen = new Map(); // key -> index in deduped
        const deduped = [];
        for (const post of allPosts) {
          const displayPost = post.reblog || post;
          const baseKey = displayPost.canonicalUri || `${displayPost.platform}:${displayPost.id}`;
          // Renotes/reblogs get a unique key so they don't merge with the original
          const key = post.rebloggedBy ? `reblog:${post.id}:${baseKey}` : baseKey;
          if (!seen.has(key)) {
            post.mergedAccounts = [{ id: post.accountId, platform: post.accountPlatform || post.platform, themeColor: post.themeColor }];
            seen.set(key, deduped.length);
            deduped.push(post);
          } else {
            // Merge: add this account's info to the existing post
            const idx = seen.get(key);
            const existing = deduped[idx];
            if (existing.mergedAccounts && !existing.mergedAccounts.some(a => a.id === post.accountId)) {
              existing.mergedAccounts.push({ id: post.accountId, platform: post.accountPlatform || post.platform, themeColor: post.themeColor });
            }
          }
        }
        allPosts.length = 0;
        allPosts.push(...deduped);
      }

      // Fetch missing reply parents
      await this.fetchMissingReplyParents(allPosts, accounts);

      // Cache posts
      this.cachePosts(allPosts);

      // Track oldest post IDs per account for pagination
      const oldestIds = new Map();
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
          const posts = result.value;
          const last = posts[posts.length - 1];
          oldestIds.set(last.accountId, last.id);
        }
      }
      this._columnPagination.set(container, {
        oldestIds,
        accounts,
        loading: false,
        hasMore: allPosts.length > 0,
      });

      if (allPosts.length === 0) {
        if (isFirstLoad) {
          container.innerHTML = '';
          container.appendChild(renderLoadingText('타임라인에 표시할 게시물이 없습니다.'));
        }
        return;
      }

      if (isFirstLoad) {
        // Full render on first load
        container.innerHTML = '';
        for (const post of allPosts) {
          container.appendChild(renderPost(post));
        }
      } else {
        // Smooth incremental update: prepend new posts with animation
        // Build a set of both platform:id keys AND canonical URIs for robust matching
        const existingKeys = new Set();
        for (const card of existingCards) {
          existingKeys.add(`${card.dataset.platform}:${card.dataset.postId}`);
          if (card.dataset.canonicalUri) {
            existingKeys.add(`uri:${card.dataset.canonicalUri}`);
          }
        }

        const newPosts = allPosts.filter(p => {
          // Check platform:id
          if (existingKeys.has(`${p.platform}:${p.id}`)) return false;
          // For non-renote posts, also check canonicalUri to avoid duplicates
          if (!p.rebloggedBy) {
            const displayPost = p.reblog || p;
            if (displayPost.canonicalUri && existingKeys.has(`uri:${displayPost.canonicalUri}`)) return false;
          }
          return true;
        });

        if (newPosts.length > 0) {
          const scrollTop = container.scrollTop;
          const fragment = document.createDocumentFragment();

          for (const post of newPosts) {
            const el = renderPost(post);
            el.classList.add('new-post');
            fragment.appendChild(el);
          }

          container.insertBefore(fragment, container.firstChild);

          // Keep scroll position stable if user was scrolled down
          if (scrollTop > 0) {
            let addedHeight = 0;
            const newCards = container.querySelectorAll('.post-card.new-post');
            for (const card of newCards) {
              addedHeight += card.offsetHeight + 8;
            }
            container.scrollTop = scrollTop + addedHeight;
          }

          // Remove animation class after animation completes
          setTimeout(() => {
            container.querySelectorAll('.new-post').forEach(el => el.classList.remove('new-post'));
          }, 400);
        }
      }
    } catch (err) {
      if (isFirstLoad) {
        container.innerHTML = `<div class="loading-text">타임라인을 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
      }
    }
  }

  async loadOlderPosts(container) {
    const pagination = this._columnPagination.get(container);
    if (!pagination || pagination.loading || !pagination.hasMore) return;

    pagination.loading = true;

    // Show loading indicator at bottom
    let loadingEl = container.querySelector('.load-more-spinner');
    if (!loadingEl) {
      loadingEl = document.createElement('div');
      loadingEl.className = 'load-more-spinner';
      loadingEl.innerHTML = '<div class="spinner"></div>';
      container.appendChild(loadingEl);
    }

    try {
      const { accounts, oldestIds } = pagination;
      const allPosts = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];
          const untilId = oldestIds.get(account.id);
          if (!untilId) return [];

          try {
            const items = await client.getHomeTimeline(this.settings.postsCount, untilId);
            return items.map(item => {
              const post = client.normalizePost(item);
              post.accountId = account.id;
              post.accountPlatform = account.platform;
              post.themeColor = account.themeColor || null;
              return post;
            });
          } catch (err) {
            console.error(`Older posts error for ${account.label}:`, err);
            return [];
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allPosts.push(...result.value);
        }
      }

      // Sort by time descending
      allPosts.sort((a, b) => b.createdAt - a.createdAt);

      // Deduplicate among fetched posts (multi-account)
      if (accounts.length > 1) {
        const seen = new Map();
        const deduped = [];
        for (const post of allPosts) {
          const displayPost = post.reblog || post;
          const baseKey = displayPost.canonicalUri || `${displayPost.platform}:${displayPost.id}`;
          const key = post.rebloggedBy ? `reblog:${post.id}:${baseKey}` : baseKey;
          if (!seen.has(key)) {
            post.mergedAccounts = [{ id: post.accountId, platform: post.accountPlatform || post.platform, themeColor: post.themeColor }];
            seen.set(key, deduped.length);
            deduped.push(post);
          } else {
            const idx = seen.get(key);
            const existing = deduped[idx];
            if (existing.mergedAccounts && !existing.mergedAccounts.some(a => a.id === post.accountId)) {
              existing.mergedAccounts.push({ id: post.accountId, platform: post.accountPlatform || post.platform, themeColor: post.themeColor });
            }
          }
        }
        allPosts.length = 0;
        allPosts.push(...deduped);
      }

      // Filter out posts already in the DOM
      const existingKeys = new Set();
      for (const card of container.querySelectorAll('.post-card')) {
        existingKeys.add(`${card.dataset.platform}:${card.dataset.postId}`);
      }
      const newPosts = allPosts.filter(p => !existingKeys.has(`${p.platform}:${p.id}`));

      // Update oldest IDs for next pagination
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
          const posts = result.value;
          const last = posts[posts.length - 1];
          oldestIds.set(last.accountId, last.id);
        }
      }

      // Cache and append
      this.cachePosts(newPosts);

      if (newPosts.length === 0) {
        pagination.hasMore = false;
      } else {
        for (const post of newPosts) {
          container.appendChild(renderPost(post));
        }
      }
    } catch (err) {
      console.error('Failed to load older posts:', err);
    } finally {
      pagination.loading = false;
      const spinner = container.querySelector('.load-more-spinner');
      if (spinner) spinner.remove();
    }
  }

  async loadNotificationsForColumn(container, accounts) {
    if (accounts.length === 0) {
      container.innerHTML = '<div class="loading-text">표시할 알림이 없습니다.</div>';
      return;
    }

    const existingCards = container.querySelectorAll('.notif-card');
    const isFirstLoad = existingCards.length === 0;

    if (isFirstLoad) {
      container.innerHTML = '';
      container.appendChild(renderLoading());
    }

    try {
      const allNotifs = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];

          try {
            const notifs = await client.getNotifications(this.settings.postsCount);
            return notifs.map(n => {
              const notif = client.normalizeNotification(n);
              notif.themeColor = account.themeColor || null;
              notif.accountId = account.id;
              return notif;
            });
          } catch (err) {
            console.error(`Notifications error for ${account.label}:`, err);
            return [];
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allNotifs.push(...result.value);
        }
      }

      allNotifs.sort((a, b) => b.createdAt - a.createdAt);

      // Cache notification posts for reply functionality
      const notifPosts = allNotifs
        .filter(n => n.post?.id)
        .map(n => ({ ...n.post, accountId: n.accountId, accountPlatform: n.platform }));
      if (notifPosts.length > 0) this.cachePosts(notifPosts);

      if (allNotifs.length === 0) {
        if (isFirstLoad) {
          container.innerHTML = '';
          container.appendChild(renderLoadingText('새 알림이 없습니다.'));
        }
        return;
      }

      if (isFirstLoad) {
        container.innerHTML = '';
        for (const notif of allNotifs) {
          container.appendChild(renderNotification(notif));
        }
      } else {
        // Smooth incremental update: prepend new notifications
        const existingIds = new Set();
        for (const card of existingCards) {
          existingIds.add(`${card.dataset.platform}:${card.dataset.notifId}`);
        }

        const newNotifs = allNotifs.filter(n => !existingIds.has(`${n.platform}:${n.id}`));

        if (newNotifs.length > 0) {
          const scrollTop = container.scrollTop;
          const fragment = document.createDocumentFragment();

          for (const notif of newNotifs) {
            const el = renderNotification(notif);
            el.classList.add('new-post');
            fragment.appendChild(el);
          }

          container.insertBefore(fragment, container.firstChild);

          if (scrollTop > 0) {
            let addedHeight = 0;
            const newCards = container.querySelectorAll('.notif-card.new-post');
            for (const card of newCards) {
              addedHeight += card.offsetHeight + 8;
            }
            container.scrollTop = scrollTop + addedHeight;
          }

          setTimeout(() => {
            container.querySelectorAll('.new-post').forEach(el => el.classList.remove('new-post'));
          }, 400);
        }
      }
    } catch (err) {
      if (isFirstLoad) {
        container.innerHTML = `<div class="loading-text">알림을 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
      }
    }
  }

  cachePosts(posts) {
    for (const post of posts) {
      this.postCache.set(`${post.platform}:${post.id}`, post);
    }
    // Evict oldest entries if over limit
    if (this.postCache.size > this.POST_CACHE_MAX) {
      const toDelete = this.postCache.size - this.POST_CACHE_MAX;
      const keys = this.postCache.keys();
      for (let i = 0; i < toDelete; i++) {
        this.postCache.delete(keys.next().value);
      }
    }
  }

  async fetchMissingReplyParents(posts, accounts) {
    // Find posts that have replyToId but no replyTo content
    const needsFetch = posts.filter(p => {
      const dp = p.reblog || p;
      return dp.replyToId && !dp.replyTo;
    });

    if (needsFetch.length === 0) return;

    // Limit to 10 concurrent fetches
    const toFetch = needsFetch.slice(0, 10);

    await Promise.allSettled(toFetch.map(async (post) => {
      const dp = post.reblog || post;
      try {
        const client = this.store.getClient(post.accountId);
        if (!client) return;

        const account = this.store.getById(post.accountId);
        if (!account) return;

        if (account.platform === 'mastodon') {
          const parent = await client.getStatus(dp.replyToId);
          if (parent) {
            const normalized = client.normalizePost(parent);
            dp.replyTo = {
              id: normalized.id,
              content: normalized.content,
              author: normalized.author,
            };
          }
        } else {
          const parent = await client.getNote(dp.replyToId);
          if (parent) {
            const normalized = client.normalizePost(parent);
            dp.replyTo = {
              id: normalized.id,
              content: normalized.content,
              author: normalized.author,
            };
          }
        }
      } catch (err) {
        // Silently fail - we'll just show the fallback indicator
      }
    }));
  }

  findPostUrl(postId, platform) {
    const post = this.postCache.get(`${platform}:${postId}`);
    return post?.url || null;
  }

  // ===== Post Actions =====

  async handlePostAction(action, postId, platform, accountId, btnElement) {
    const allAccounts = this.store.getAll();

    if (allAccounts.length === 0) return;

    // Reply/Quote: skip account picker, go directly to compose modal
    // The card's accountId tells us which account received this post
    if (action === 'reply') {
      this.openComposeModal(postId, accountId);
      return;
    }
    if (action === 'quote') {
      this.openQuoteModal(postId, platform, accountId);
      return;
    }

    // If the card is inside an account-specific column, use that account directly
    const column = btnElement.closest('.column');
    const columnAccountId = column?.dataset.columnType === 'account' ? column.dataset.accountId : null;
    if (columnAccountId) {
      await this.executePostAction(action, postId, platform, columnAccountId, btnElement);
      return;
    }

    // For the All column, only show accounts that actually loaded this post
    const cachedPost = this.postCache.get(`${platform}:${postId}`);
    let relevantAccounts;
    if (cachedPost?.mergedAccounts && cachedPost.mergedAccounts.length > 0) {
      const mergedIds = new Set(cachedPost.mergedAccounts.map(a => a.id));
      relevantAccounts = allAccounts.filter(a => mergedIds.has(a.id));
    } else if (accountId) {
      relevantAccounts = allAccounts.filter(a => a.id === accountId);
    } else {
      relevantAccounts = allAccounts;
    }
    if (relevantAccounts.length === 0) relevantAccounts = allAccounts;

    // Single relevant account: use it directly
    if (relevantAccounts.length === 1) {
      await this.executePostAction(action, postId, platform, relevantAccounts[0].id, btnElement);
      return;
    }

    // Multi-account: show picker so user can choose
    this.showAccountPicker(btnElement, relevantAccounts, async (selectedAccountId) => {
      try {
        await this.executePostAction(action, postId, platform, selectedAccountId, btnElement);
      } catch (err) {
        console.error('Post action failed:', err);
      }
    }, accountId);
  }

  async executePostAction(action, postId, platform, accountId, btnElement) {
    const client = this.store.getClient(accountId);
    if (!client) return;
    const account = this.store.getById(accountId);
    if (!account) return;
    const accountPlatform = account.platform;

    // Look up cached post to check current fav/boost state
    const cachedPost = this.postCache.get(`${platform}:${postId}`);
    // For renotes/reblogs, actions target the original post
    const actionPostId = cachedPost?.reblog?.id || postId;

    try {
      // Immediate visual feedback: add processing state
      btnElement.classList.add('processing');

      if (action === 'fav') {
        const alreadyFaved = cachedPost?.favourited || cachedPost?.myReaction;
        if (alreadyFaved) {
          // Unlike / unreact
          if (accountPlatform === 'mastodon') {
            await client.unfavourite(actionPostId);
          } else {
            await client.deleteReaction(actionPostId);
          }
          btnElement.classList.remove('processing', 'active');
        } else {
          if (accountPlatform === 'mastodon') {
            await client.favourite(actionPostId);
          } else {
            await client.createReaction(actionPostId, '❤');
          }
          btnElement.classList.remove('processing');
          btnElement.classList.add('active', 'just-activated');
          setTimeout(() => btnElement.classList.remove('just-activated'), 600);
        }
      } else if (action === 'boost') {
        const alreadyBoosted = cachedPost?.reblogged;
        if (alreadyBoosted) {
          if (accountPlatform === 'mastodon') {
            await client.unreblog(postId);
          }
          btnElement.classList.remove('processing', 'active');
          // Update cache
          if (cachedPost) cachedPost.reblogged = false;
        } else {
          if (accountPlatform === 'mastodon') {
            await client.reblog(actionPostId);
          } else {
            await client.renote(actionPostId);
          }
          btnElement.classList.remove('processing');
          btnElement.classList.add('active', 'just-activated');
          setTimeout(() => btnElement.classList.remove('just-activated'), 600);
          // Update cache
          if (cachedPost) cachedPost.reblogged = true;
        }
      } else if (action === 'reply') {
        btnElement.classList.remove('processing');
        this.openComposeModal(postId, accountId);
        return; // Don't refresh for reply
      } else if (action === 'quote') {
        btnElement.classList.remove('processing');
        this.openQuoteModal(postId, platform, accountId);
        return; // Don't refresh for quote
      } else if (action === 'reaction') {
        btnElement.classList.remove('processing');
        // Small delay to ensure any previous picker (account picker) is fully cleaned up
        await new Promise(r => setTimeout(r, 50));
        await this.showReactionPicker(btnElement, actionPostId, platform, accountId);
        return;
      }

      // Re-fetch the note and update the card in-place
      await this.refreshSinglePost(postId, platform, accountId);
    } catch (err) {
      console.error(`Action ${action} failed:`, err);
      btnElement.classList.remove('processing');
    }
  }

  async refreshSinglePost(postId, platform, accountId) {
    try {
      const client = this.store.getClient(accountId);
      const account = this.store.getById(accountId);
      if (!client || !account) return;

      let rawPost;
      if (account.platform === 'mastodon') {
        rawPost = await client.getStatus(postId);
      } else {
        rawPost = await client.getNote(postId);
      }
      if (!rawPost) return;

      const updatedPost = client.normalizePost(rawPost);
      updatedPost.accountId = accountId;
      updatedPost.accountPlatform = account.platform;
      updatedPost.themeColor = account.themeColor || null;

      // Find and update all matching cards in the DOM
      const cards = document.querySelectorAll(`.post-card[data-post-id="${postId}"][data-platform="${platform}"]`);
      for (const card of cards) {
        // Preserve state from cache
        const oldCacheKey = `${platform}:${postId}`;
        const cachedPost = this.postCache.get(oldCacheKey);
        if (cachedPost?.mergedAccounts) {
          updatedPost.mergedAccounts = cachedPost.mergedAccounts;
        }
        // Preserve reblogged state for Misskey (API doesn't report it)
        if (account.platform !== 'mastodon' && cachedPost?.reblogged) {
          updatedPost.reblogged = true;
        }

        const newCard = renderPost(updatedPost);
        card.replaceWith(newCard);
      }

      // Update cache
      this.postCache.set(`${platform}:${postId}`, updatedPost);
    } catch (err) {
      // Silently fail - the action already succeeded
    }
  }

  getReplyMention(postId, accountId) {
    const account = this.store.getById(accountId);
    const myUsername = account?.profile?.username;

    // Walk up the reply chain to collect non-self mentions
    const findPost = (id) => {
      for (const [, post] of this.postCache) {
        const dp = post.reblog || post;
        if (post.id === id || dp.id === id) return dp;
      }
      return null;
    };

    const mentions = [];
    const seen = new Set();
    let currentId = postId;
    let depth = 0;

    while (currentId && depth < 10) {
      const dp = findPost(currentId);
      if (!dp) break;

      const author = dp.author;
      if (author) {
        const acct = author.acct || author.username;
        // Add non-self, non-duplicate mentions
        if ((!myUsername || author.username !== myUsername) && !seen.has(acct)) {
          seen.add(acct);
          mentions.push(`@${acct}`);
        }
      }

      // Walk up to parent
      currentId = dp.replyTo?.id || dp.replyToId || null;
      depth++;
      // Stop after finding the first non-self mention
      if (mentions.length > 0) break;
    }

    return mentions.length > 0 ? mentions.join(' ') : null;
  }

  async showReactionPicker(anchorElement, postId, platform, accountId) {
    // Close any existing picker
    this.closeReactionPicker();

    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    picker.id = 'reaction-picker-popup';

    // Common unicode emoji reactions
    const commonReactions = [
      '👍', '❤️', '😆', '🎉', '😮', '🤔', '😢', '👀',
      '🔥', '⭐', '💯', '✨', '😂', '🙏', '💕', '😊',
    ];

    // Check if this is a Misskey-type account (needs instance emojis)
    const client = this.store.getClient(accountId);
    const account = this.store.getById(accountId);
    const isMisskeyType = account && account.platform !== 'mastodon';

    // Build initial HTML with unicode emojis + loading placeholder for instance emojis
    picker.innerHTML = `
      <div class="reaction-picker-section-label">이모지</div>
      <div class="reaction-picker-grid reaction-picker-unicode">
        ${commonReactions.map(r => `<button class="reaction-picker-item" data-reaction="${r}">${r}</button>`).join('')}
      </div>
      ${isMisskeyType ? '<div class="reaction-picker-loading">커스텀 이모지 로딩중...</div>' : ''}
      <div class="reaction-picker-custom">
        <input type="text" class="reaction-picker-input" placeholder=":emoji: 또는 이모지 입력" />
      </div>
    `;

    // Position near button
    const positionReactionPicker = (r) => {
      picker.style.bottom = `${window.innerHeight - r.top + 4}px`;
      picker.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 330))}px`;
    };
    const rect = anchorElement.getBoundingClientRect();
    picker.style.position = 'fixed';
    positionReactionPicker(rect);

    document.body.appendChild(picker);
    this._trackPopupScroll('reactionPicker', picker, anchorElement, positionReactionPicker);

    // Handle emoji click (delegated, works for dynamically added instance emojis too)
    picker.addEventListener('click', async (e) => {
      const item = e.target.closest('.reaction-picker-item');
      if (!item) return;
      const reaction = item.dataset.reaction;
      this.closeReactionPicker();
      await this.sendReaction(postId, platform, accountId, reaction, anchorElement);
    });

    // Handle custom emoji input
    const input = picker.querySelector('.reaction-picker-input');
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const value = input.value.trim();
        if (value) {
          this.closeReactionPicker();
          await this.sendReaction(postId, platform, accountId, value, anchorElement);
        }
      }
    });

    // Close on outside click (persistent listener)
    setTimeout(() => {
      const handler = (e) => {
        if (!picker.contains(e.target) && !anchorElement.contains(e.target)) {
          this.closeReactionPicker();
        }
      };
      document.addEventListener('click', handler);
      this._reactionPickerClose = handler;
    }, 0);

    // Async: fetch and insert instance custom emojis for Misskey accounts
    if (isMisskeyType && client?.getInstanceEmojis) {
      client.getInstanceEmojis().then(instanceEmojis => {
        // Picker might have been closed while loading
        if (!document.getElementById('reaction-picker-popup')) return;

        const loadingEl = picker.querySelector('.reaction-picker-loading');
        if (!instanceEmojis || instanceEmojis.length === 0) {
          if (loadingEl) loadingEl.textContent = '커스텀 이모지 없음';
          return;
        }

        // Build categories
        const categories = new Map();
        for (const emoji of instanceEmojis) {
          const cat = emoji.category || '기타';
          if (!categories.has(cat)) categories.set(cat, []);
          categories.get(cat).push(emoji);
        }

        const emojiSection = document.createElement('div');
        emojiSection.className = 'reaction-picker-instance-section';
        emojiSection.innerHTML = `
          <div class="reaction-picker-search">
            <input type="text" class="reaction-picker-search-input" placeholder="커스텀 이모지 검색..." />
          </div>
          <div class="reaction-picker-emojis">
            ${Array.from(categories.entries()).map(([cat, emojis]) => `
              <div class="reaction-picker-category" data-category="${cat}">
                <div class="reaction-picker-category-name">${this.escapeHtml(cat)}</div>
                <div class="reaction-picker-grid">
                  ${emojis.map(e => `<button class="reaction-picker-item instance-emoji" data-reaction=":${e.name}:" title=":${e.name}:"><img src="${this.escapeHtml(e.url)}" alt=":${e.name}:" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        `;

        // Replace loading element with emoji section
        if (loadingEl) loadingEl.replaceWith(emojiSection);

        // Attach search filter
        const searchInput = emojiSection.querySelector('.reaction-picker-search-input');
        if (searchInput) {
          searchInput.addEventListener('input', () => {
            const query = searchInput.value.trim().toLowerCase();
            const items = emojiSection.querySelectorAll('.instance-emoji');
            const cats = emojiSection.querySelectorAll('.reaction-picker-category');
            for (const item of items) {
              const name = (item.dataset.reaction || '').toLowerCase();
              item.style.display = (!query || name.includes(query)) ? '' : 'none';
            }
            for (const cat of cats) {
              const visibleItems = cat.querySelectorAll('.instance-emoji:not([style*="display: none"])');
              cat.style.display = visibleItems.length > 0 ? '' : 'none';
            }
          });
        }
      }).catch(err => {
        console.error('Failed to load instance emojis:', err);
        const loadingEl = picker.querySelector('.reaction-picker-loading');
        if (loadingEl) loadingEl.textContent = '이모지 로딩 실패';
      });
    }
  }

  closeReactionPicker() {
    const existing = document.getElementById('reaction-picker-popup');
    if (existing) existing.remove();
    if (this._reactionPickerClose) {
      document.removeEventListener('click', this._reactionPickerClose);
      this._reactionPickerClose = null;
    }
    this._removeScrollTracker('reactionPicker');
  }

  async sendReaction(postId, platform, accountId, reaction, btnElement) {
    const client = this.store.getClient(accountId);
    if (!client) return;
    try {
      btnElement.classList.add('processing');
      // If already reacted on Misskey, delete old reaction first
      const cachedPost = this.postCache.get(`${platform}:${postId}`);
      if (cachedPost?.myReaction) {
        await client.deleteReaction(postId);
      }
      await client.createReaction(postId, reaction);
      btnElement.classList.remove('processing');
      btnElement.classList.add('active', 'just-activated');
      setTimeout(() => btnElement.classList.remove('just-activated'), 600);
      await this.refreshSinglePost(postId, platform, accountId);
    } catch (err) {
      console.error('Reaction failed:', err);
      btnElement.classList.remove('processing');
    }
  }

  openQuoteModal(postId, platform, accountId) {
    // Find the original post URL for the quote
    let quoteUrl = '';
    for (const [key, post] of this.postCache) {
      const dp = post.reblog || post;
      if (post.id === postId || dp.id === postId) {
        quoteUrl = dp.url || dp.canonicalUri || '';
        break;
      }
    }

    this.openComposeModal(null, accountId);
    this.composeTitle.textContent = '인용';
    this.composeText.dataset.quoteId = postId;
    this.composeText.dataset.quotePlatform = platform;
    if (quoteUrl) {
      this.composeText.value = '\n\n' + quoteUrl;
      this.composeText.setSelectionRange(0, 0);
    }
    this.composeText.placeholder = '인용 내용을 작성하세요...';
  }

  // ===== Account Picker =====

  showAccountPicker(anchorElement, accounts, onSelect, preferredAccountId = null) {
    this.closeAccountPicker();

    const picker = document.createElement('div');
    picker.className = 'account-picker';
    picker.id = 'account-picker-popup';

    // Sort preferred account to top
    const sortedAccounts = [...accounts];
    if (preferredAccountId) {
      sortedAccounts.sort((a, b) => {
        if (a.id === preferredAccountId) return -1;
        if (b.id === preferredAccountId) return 1;
        return 0;
      });
    }

    let html = '<div class="account-picker-title">계정 선택</div>';
    for (const account of sortedAccounts) {
      const p = account.profile;
      const isPreferred = account.id === preferredAccountId;
      const dotColor = account.themeColor || '';
      const dotStyle = dotColor ? `style="background:${dotColor}"` : '';
      html += `
        <button class="account-picker-item${isPreferred ? ' preferred' : ''}" data-account-id="${account.id}"${isPreferred && account.themeColor ? ` style="border-left-color:${account.themeColor}"` : ''}>
          <img src="${p.avatarUrl || ''}" alt="" onerror="this.style.display='none'">
          <span class="picker-name">${this.escapeHtml(p.displayName)}</span>
          <span class="platform-dot ${account.platform}" ${dotStyle}></span>
        </button>
      `;
    }
    picker.innerHTML = html;

    // Position near the anchor
    const positionAccountPicker = (r) => {
      picker.style.left = `${r.left}px`;
      picker.style.top = `${r.bottom + 4}px`;
      // Adjust if goes off right
      const pw = picker.offsetWidth || 200;
      if (r.left + pw > window.innerWidth) {
        picker.style.left = `${window.innerWidth - pw - 8}px`;
      }
    };
    const rect = anchorElement.getBoundingClientRect();
    positionAccountPicker(rect);

    document.body.appendChild(picker);
    // Re-adjust after DOM append (now offsetWidth is real)
    positionAccountPicker(anchorElement.getBoundingClientRect());
    this._trackPopupScroll('accountPicker', picker, anchorElement, positionAccountPicker);

    picker.addEventListener('click', (e) => {
      const item = e.target.closest('.account-picker-item');
      if (!item) return;
      const selectedId = item.dataset.accountId;
      this.closeAccountPicker();
      onSelect(selectedId);
    });

    // Close on outside click (persistent listener)
    setTimeout(() => {
      const handler = (e) => {
        if (!picker.contains(e.target) && !anchorElement.contains(e.target)) {
          this.closeAccountPicker();
        }
      };
      document.addEventListener('click', handler);
      this._pickerOutsideClick = handler;
    }, 0);
  }

  closeAccountPicker() {
    const existing = document.getElementById('account-picker-popup');
    if (existing) existing.remove();
    if (this._pickerOutsideClick) {
      document.removeEventListener('click', this._pickerOutsideClick);
      this._pickerOutsideClick = null;
    }
    this._removeScrollTracker('accountPicker');
  }

  // ===== Compose =====

  openComposeModal(replyToId = null, preferredAccountId = null) {
    const accounts = this.store.getAll();
    if (accounts.length === 0) return;

    // Build account toggle buttons
    this.composeSelectedAccounts.clear();
    this.composeAccountsContainer.innerHTML = '';

    for (const account of accounts) {
      const p = account.profile;
      const btn = document.createElement('button');
      btn.className = 'compose-account-toggle';
      btn.dataset.accountId = account.id;
      const dotStyle = account.themeColor ? `style="background:${account.themeColor}"` : '';
      btn.innerHTML = `
        <img class="compose-account-avatar" src="${p.avatarUrl || ''}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
        <span class="compose-account-name">${this.escapeHtml(p.displayName)}</span>
        <span class="platform-dot ${account.platform}" ${dotStyle}></span>
      `;

      // Pre-select preferred account, or first account by default
      const isFirst = accounts.indexOf(account) === 0;
      if (preferredAccountId === account.id || (!preferredAccountId && isFirst)) {
        btn.classList.add('active');
        this.composeSelectedAccounts.add(account.id);
      }

      btn.addEventListener('click', () => {
        if (this.composeSelectedAccounts.has(account.id)) {
          this.composeSelectedAccounts.delete(account.id);
          btn.classList.remove('active');
        } else {
          this.composeSelectedAccounts.add(account.id);
          btn.classList.add('active');
        }
      });

      this.composeAccountsContainer.appendChild(btn);
    }

    // Reset
    this.composeCw.value = '';
    this.composeText.value = '';
    this.composeFiles = [];
    this.composeImagePreview.innerHTML = '';
    this.composeError.style.display = 'none';
    this.btnComposeSubmit.disabled = false;
    this.btnComposeSubmit.textContent = '게시';

    if (replyToId) {
      this.composeText.dataset.replyTo = replyToId;
      this.composeText.placeholder = '답글을 작성하세요...';
      this.composeTitle.textContent = '답글 작성';

      // Auto-fill mention of the original post author
      const replyMention = this.getReplyMention(replyToId, preferredAccountId);
      if (replyMention) {
        this.composeText.value = replyMention + ' ';
      }
    } else {
      delete this.composeText.dataset.replyTo;
      delete this.composeText.dataset.quoteId;
      this.composeText.placeholder = '무슨 일이 일어나고 있나요?';
      this.composeTitle.textContent = '새 글 작성';
    }

    this.openModal(this.modalCompose);
    this.composeText.focus();
  }

  showComposeEmojiPicker() {
    this.closeComposeEmojiPicker();

    const picker = document.createElement('div');
    picker.className = 'compose-emoji-picker';
    picker.id = 'compose-emoji-picker-popup';

    // Common unicode emojis
    const commonReactions = [
      '👍', '❤️', '😆', '🎉', '😮', '🤔', '😢', '👀',
      '🔥', '⭐', '💯', '✨', '😂', '🙏', '💕', '😊',
    ];

    // Determine first selected Misskey account for instance emojis
    let misskeyAccountId = null;
    for (const id of this.composeSelectedAccounts) {
      const acct = this.store.getById(id);
      if (acct && acct.platform !== 'mastodon') {
        misskeyAccountId = id;
        break;
      }
    }

    picker.innerHTML = `
      <div class="reaction-picker-section-label">이모지</div>
      <div class="reaction-picker-grid reaction-picker-unicode">
        ${commonReactions.map(r => `<button class="reaction-picker-item" data-emoji="${r}">${r}</button>`).join('')}
      </div>
      ${misskeyAccountId ? '<div class="reaction-picker-loading">커스텀 이모지 로딩중...</div>' : ''}
    `;

    // Position above the emoji button
    const btnRect = this.btnComposeEmoji.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.bottom = `${window.innerHeight - btnRect.top + 4}px`;
    picker.style.left = `${Math.max(8, Math.min(btnRect.left, window.innerWidth - 330))}px`;

    document.body.appendChild(picker);

    // Insert emoji into textarea
    const insertEmoji = (text) => {
      const ta = this.composeText;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.substring(0, start) + text + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + text.length;
      ta.focus();
    };

    picker.addEventListener('click', (e) => {
      const item = e.target.closest('.reaction-picker-item, .compose-emoji-item');
      if (!item) return;
      const emoji = item.dataset.emoji;
      if (emoji) {
        insertEmoji(emoji);
        this.closeComposeEmojiPicker();
      }
    });

    // Outside click to close
    setTimeout(() => {
      const handler = (e) => {
        if (!picker.contains(e.target) && !this.btnComposeEmoji.contains(e.target)) {
          this.closeComposeEmojiPicker();
        }
      };
      document.addEventListener('click', handler);
      this._composeEmojiClose = handler;
    }, 0);

    // Fetch instance emojis async
    if (misskeyAccountId) {
      const client = this.store.getClient(misskeyAccountId);
      client?.getInstanceEmojis?.().then(emojis => {
        if (!document.getElementById('compose-emoji-picker-popup')) return;
        const loadingEl = picker.querySelector('.reaction-picker-loading');
        if (!emojis || emojis.length === 0) {
          if (loadingEl) loadingEl.remove();
          return;
        }

        const categories = new Map();
        for (const emoji of emojis) {
          const cat = emoji.category || '기타';
          if (!categories.has(cat)) categories.set(cat, []);
          categories.get(cat).push(emoji);
        }

        const section = document.createElement('div');
        section.className = 'reaction-picker-instance-section';
        section.innerHTML = `
          <div class="reaction-picker-search">
            <input type="text" class="reaction-picker-search-input" placeholder="커스텀 이모지 검색..." />
          </div>
          <div class="reaction-picker-emojis">
            ${Array.from(categories.entries()).map(([cat, catEmojis]) => `
              <div class="reaction-picker-category" data-category="${cat}">
                <div class="reaction-picker-category-name">${this.escapeHtml(cat)}</div>
                <div class="reaction-picker-grid">
                  ${catEmojis.map(e => `<button class="compose-emoji-item" data-emoji=":${e.name}:" title=":${e.name}:"><img src="${this.escapeHtml(e.url)}" alt=":${e.name}:" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        `;

        if (loadingEl) loadingEl.replaceWith(section);

        const searchInput = section.querySelector('.reaction-picker-search-input');
        if (searchInput) {
          searchInput.addEventListener('input', () => {
            const query = searchInput.value.trim().toLowerCase();
            const items = section.querySelectorAll('.compose-emoji-item');
            const cats = section.querySelectorAll('.reaction-picker-category');
            for (const item of items) {
              const name = (item.dataset.emoji || '').toLowerCase();
              item.style.display = (!query || name.includes(query)) ? '' : 'none';
            }
            for (const cat of cats) {
              const visible = cat.querySelectorAll('.compose-emoji-item:not([style*="display: none"])');
              cat.style.display = visible.length > 0 ? '' : 'none';
            }
          });
        }
      }).catch(() => {
        const loadingEl = picker.querySelector('.reaction-picker-loading');
        if (loadingEl) loadingEl.remove();
      });
    }
  }

  closeComposeEmojiPicker() {
    const existing = document.getElementById('compose-emoji-picker-popup');
    if (existing) existing.remove();
    if (this._composeEmojiClose) {
      document.removeEventListener('click', this._composeEmojiClose);
      this._composeEmojiClose = null;
    }
  }

  handleComposeFileSelect() {
    const files = Array.from(this.composeFilesInput.files);
    for (const file of files) {
      if (this.composeFiles.length >= 4) break;
      this.composeFiles.push(file);
    }
    this.composeFilesInput.value = '';
    this.renderComposeImagePreview();
  }

  renderComposeImagePreview() {
    this.composeImagePreview.innerHTML = '';
    this.composeFiles.forEach((file, idx) => {
      const item = document.createElement('div');
      item.className = 'preview-item';

      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'preview-remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        this.composeFiles.splice(idx, 1);
        this.renderComposeImagePreview();
      });

      item.appendChild(img);
      item.appendChild(removeBtn);
      this.composeImagePreview.appendChild(item);
    });
  }

  async handleComposeSubmit() {
    const selectedIds = [...this.composeSelectedAccounts];
    const text = this.composeText.value.trim();
    const cw = this.composeCw.value.trim();
    const replyToId = this.composeText.dataset.replyTo;
    const quoteId = this.composeText.dataset.quoteId;
    const quotePlatform = this.composeText.dataset.quotePlatform;

    if (selectedIds.length === 0) {
      this.composeError.textContent = '게시할 계정을 하나 이상 선택하세요.';
      this.composeError.style.display = 'block';
      return;
    }

    if (!text && this.composeFiles.length === 0) {
      this.composeError.textContent = '내용을 입력하거나 이미지를 추가하세요.';
      this.composeError.style.display = 'block';
      return;
    }

    this.btnComposeSubmit.disabled = true;
    this.btnComposeSubmit.textContent = '게시 중...';
    this.composeError.style.display = 'none';

    const errors = [];

    for (const accountId of selectedIds) {
      const account = this.store.getById(accountId);
      const client = this.store.getClient(accountId);
      if (!account || !client) continue;

      try {
        // Upload files per account
        let fileIds = [];
        if (this.composeFiles.length > 0) {
          for (const file of this.composeFiles) {
            if (account.platform === 'mastodon') {
              const result = await client.uploadMedia(file);
              fileIds.push(result.id);
            } else {
              const result = await client.uploadFile(file);
              fileIds.push(result.id);
            }
          }
        }

        // Create post
        if (account.platform === 'mastodon') {
          await client.createStatus(text, {
            spoilerText: cw || undefined,
            mediaIds: fileIds.length > 0 ? fileIds : undefined,
            inReplyToId: replyToId || undefined,
          });
        } else {
          await client.createNote(text, {
            cw: cw || undefined,
            fileIds: fileIds.length > 0 ? fileIds : undefined,
            replyId: replyToId || undefined,
            renoteId: quoteId || undefined,
          });
        }
      } catch (err) {
        errors.push(`${account.profile.displayName}: ${err.message}`);
      }
    }

    if (errors.length > 0) {
      this.composeError.textContent = `일부 계정 게시 실패: ${errors.join('; ')}`;
      this.composeError.style.display = 'block';
    }

    if (errors.length < selectedIds.length) {
      // At least one succeeded
      this.closeModal(this.modalCompose);
      this.refreshAll();
    }

    this.btnComposeSubmit.disabled = false;
    this.btnComposeSubmit.textContent = '게시';
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

  // ===== Add Account Modal =====

  openAddAccountModal() {
    this.platformSelect.value = '';
    this.instanceUrl.value = '';
    this.accessToken.value = '';
    this.accountLabel.value = '';
    this.addAccountError.style.display = 'none';
    this.btnConfirmAdd.disabled = false;
    this.btnConfirmAdd.textContent = '수동 토큰으로 추가';
    this.btnOAuthLogin.textContent = '로그인으로 연결';
    this.detectedPlatformEl = document.getElementById('detected-platform');
    this.detectedPlatformEl.style.display = 'none';
    document.getElementById('manual-token-section').removeAttribute('open');
    this.openModal(this.modalAddAccount);
    this.instanceUrl.focus();
  }

  normalizeInstanceUrl(input) {
    let url = input.trim();
    if (!url) return '';
    // Remove trailing slashes
    url = url.replace(/\/+$/, '');
    // Add https:// if no protocol
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    return url;
  }

  updateOAuthButton() {
    const platform = this.platformSelect.value;
    const labels = {
      misskey: 'Misskey 로그인으로 연결',
      iceshrimp: 'Iceshrimp 로그인으로 연결',
      cherrypick: 'CherryPick 로그인으로 연결',
      mastodon: 'Mastodon 로그인으로 연결',
    };
    this.btnOAuthLogin.textContent = labels[platform] || '로그인으로 연결';
  }

  async autoDetectPlatform() {
    const instanceUrl = this.normalizeInstanceUrl(this.instanceUrl.value);
    if (!instanceUrl) return;

    try {
      new URL(instanceUrl);
    } catch {
      return;
    }

    const detectedEl = document.getElementById('detected-platform');
    detectedEl.style.display = 'block';
    detectedEl.textContent = '플랫폼 감지 중...';
    detectedEl.className = 'detected-platform detecting';

    try {
      const useProxy = window.location.hostname !== 'localhost';
      const buildUrl = (target) => useProxy ? `/proxy?url=${encodeURIComponent(target)}` : target;

      // Try Misskey API first (POST /api/meta)
      const misskeyRes = await fetch(buildUrl(`${instanceUrl}/api/meta`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => null);

      if (misskeyRes && misskeyRes.ok) {
        const meta = await misskeyRes.json();
        let platform = 'misskey';
        let platformName = 'Misskey';

        const name = (meta.name || '').toLowerCase();
        const version = (meta.version || '').toLowerCase();
        const softwareName = (meta.softwareName || '').toLowerCase();

        if (softwareName.includes('iceshrimp') || name.includes('iceshrimp') || version.includes('iceshrimp')) {
          platform = 'iceshrimp';
          platformName = 'Iceshrimp';
        } else if (softwareName.includes('cherrypick') || name.includes('cherrypick') || version.includes('cherrypick')) {
          platform = 'cherrypick';
          platformName = 'CherryPick';
        } else if (softwareName.includes('sharkey') || version.includes('sharkey')) {
          platform = 'misskey';
          platformName = 'Sharkey (Misskey 호환)';
        } else if (softwareName.includes('firefish') || version.includes('firefish')) {
          platform = 'iceshrimp';
          platformName = 'Firefish (Misskey 호환)';
        }

        this.platformSelect.value = platform;
        detectedEl.textContent = `${platformName} 감지됨`;
        detectedEl.className = `detected-platform detected platform-${platform}`;
        this.updateOAuthButton();
        return;
      }

      // Try Mastodon API (GET /api/v1/instance)
      const mastodonRes = await fetch(buildUrl(`${instanceUrl}/api/v1/instance`), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      }).catch(() => null);

      if (mastodonRes && mastodonRes.ok) {
        this.platformSelect.value = 'mastodon';
        detectedEl.textContent = 'Mastodon 감지됨';
        detectedEl.className = 'detected-platform detected platform-mastodon';
        this.updateOAuthButton();
        return;
      }

      detectedEl.textContent = '플랫폼을 감지할 수 없습니다. 인스턴스 주소를 확인하세요.';
      detectedEl.className = 'detected-platform detect-failed';
    } catch {
      detectedEl.textContent = '플랫폼을 감지할 수 없습니다.';
      detectedEl.className = 'detected-platform detect-failed';
    }
  }

  // ===== OAuth / MiAuth =====

  async handleOAuthLogin() {
    const instanceUrl = this.normalizeInstanceUrl(this.instanceUrl.value);

    if (!instanceUrl) {
      this.showAddError('인스턴스 주소를 입력하세요. (예: misskey.io)');
      this.instanceUrl.focus();
      return;
    }

    try {
      new URL(instanceUrl);
    } catch {
      this.showAddError('올바른 주소 형식이 아닙니다. (예: misskey.io)');
      this.instanceUrl.focus();
      return;
    }

    this.btnOAuthLogin.disabled = true;
    this.btnOAuthLogin.textContent = '플랫폼 감지 중...';
    this.addAccountError.style.display = 'none';

    // Auto-detect platform if not already detected
    let platform = this.platformSelect.value;
    if (!platform) {
      await this.autoDetectPlatform();
      platform = this.platformSelect.value;
    }

    if (!platform) {
      this.showAddError('플랫폼을 감지할 수 없습니다. 인스턴스 주소를 확인하세요.');
      this.btnOAuthLogin.disabled = false;
      this.btnOAuthLogin.textContent = '로그인으로 연결';
      return;
    }

    this.btnOAuthLogin.textContent = '인증 페이지 여는 중...';

    try {
      let popup;
      if (platform === 'mastodon') {
        popup = await startMastodonOAuth(instanceUrl);
      } else {
        popup = await startMiAuth(instanceUrl, platform);
      }

      if (popup) {
        this.btnOAuthLogin.textContent = '인증 대기 중... (팝업에서 로그인하세요)';
      } else {
        return;
      }

      const result = await waitForAuthCallback();

      await this.store.addAccount(result.platform, result.instanceUrl, result.accessToken);
      this.closeModal(this.modalAddAccount);
      this.debouncedSaveToCloud();
      this.render();
    } catch (err) {
      clearPendingAuth();
      this.showAddError(`인증 실패: ${err.message}`);
    } finally {
      this.btnOAuthLogin.disabled = false;
      this.updateOAuthButton();
    }
  }

  // ===== Manual Token =====

  async handleAddAccount() {
    const instanceUrl = this.normalizeInstanceUrl(this.instanceUrl.value);
    const accessToken = this.accessToken.value.trim();
    const label = this.accountLabel.value.trim();

    if (!instanceUrl) {
      this.showAddError('인스턴스 주소를 입력하세요.');
      return;
    }
    if (!accessToken) {
      this.showAddError('액세스 토큰을 입력하세요.');
      return;
    }

    try {
      new URL(instanceUrl);
    } catch {
      this.showAddError('올바른 주소 형식이 아닙니다. (예: misskey.io)');
      return;
    }

    this.btnConfirmAdd.disabled = true;
    this.btnConfirmAdd.textContent = '플랫폼 감지 중...';
    this.addAccountError.style.display = 'none';

    // Auto-detect platform if not already detected
    let platform = this.platformSelect.value;
    if (!platform) {
      await this.autoDetectPlatform();
      platform = this.platformSelect.value;
    }

    if (!platform) {
      this.showAddError('플랫폼을 감지할 수 없습니다. 인스턴스 주소를 확인하세요.');
      this.btnConfirmAdd.disabled = false;
      this.btnConfirmAdd.textContent = '수동 토큰으로 추가';
      return;
    }

    this.btnConfirmAdd.textContent = '연결 확인 중...';

    try {
      await this.store.addAccount(platform, instanceUrl, accessToken, label);
      this.closeModal(this.modalAddAccount);
      this.debouncedSaveToCloud();
      this.render();
    } catch (err) {
      this.showAddError(`연결 실패: ${err.message}`);
    } finally {
      this.btnConfirmAdd.disabled = false;
      this.btnConfirmAdd.textContent = '수동 토큰으로 추가';
    }
  }

  showAddError(message) {
    this.addAccountError.textContent = message;
    this.addAccountError.style.display = 'block';
  }

  // ===== Settings =====

  openSettingsModal() {
    const modal = document.getElementById('modal-settings');
    const refreshSelect = document.getElementById('setting-refresh-interval');
    const columnWidthSelect = document.getElementById('setting-column-width');
    const fontSizeSelect = document.getElementById('setting-font-size');
    const postsCountSelect = document.getElementById('setting-posts-count');
    const resetBtn = document.getElementById('btn-settings-reset');

    // Remove old listeners by cloning first, then set values on the new elements
    const newRefresh = refreshSelect.cloneNode(true);
    refreshSelect.replaceWith(newRefresh);
    newRefresh.value = String(this.settings.refreshInterval);
    newRefresh.addEventListener('change', () => {
      this.settings.refreshInterval = parseInt(newRefresh.value);
      this.AUTO_REFRESH_INTERVAL = this.settings.refreshInterval;
      this.saveSettings();
      this.startAutoRefresh();
    });

    const columnWidthValueLabel = document.getElementById('column-width-value');
    const newColWidth = columnWidthSelect.cloneNode(true);
    columnWidthSelect.replaceWith(newColWidth);
    newColWidth.value = String(this.settings.columnWidth);
    if (columnWidthValueLabel) columnWidthValueLabel.textContent = `${this.settings.columnWidth}px`;
    newColWidth.addEventListener('input', () => {
      if (columnWidthValueLabel) columnWidthValueLabel.textContent = `${newColWidth.value}px`;
      this.settings.columnWidth = parseInt(newColWidth.value);
      this.saveSettings();
      this.applySettings();
    });

    const newFontSize = fontSizeSelect.cloneNode(true);
    fontSizeSelect.replaceWith(newFontSize);
    newFontSize.value = String(this.settings.fontSize);
    newFontSize.addEventListener('change', () => {
      this.settings.fontSize = parseInt(newFontSize.value);
      this.saveSettings();
      this.applySettings();
    });

    const newPostsCount = postsCountSelect.cloneNode(true);
    postsCountSelect.replaceWith(newPostsCount);
    newPostsCount.value = String(this.settings.postsCount);
    newPostsCount.addEventListener('change', () => {
      this.settings.postsCount = parseInt(newPostsCount.value);
      this.saveSettings();
    });

    const newResetBtn = resetBtn.cloneNode(true);
    resetBtn.replaceWith(newResetBtn);
    newResetBtn.addEventListener('click', () => {
      if (confirm('정말로 모든 데이터를 초기화하시겠습니까?\n계정 정보, 설정이 모두 삭제됩니다.')) {
        localStorage.clear();
        location.reload();
      }
    });

    this.openModal(modal);
  }

  // ===== Reaction Users =====

  async showReactionUsers(badge, postId, platform, accountId, reaction) {
    // Close any existing popup
    this.closeReactionPopup();

    // Find a usable account for this platform
    const accounts = this.store.getAll();
    let useAccountId = accountId;
    if (!useAccountId) {
      const match = accounts.find(a => a.platform === platform);
      if (match) useAccountId = match.id;
    }
    if (!useAccountId) return;

    const client = this.store.getClient(useAccountId);
    if (!client) return;

    const popup = document.createElement('div');
    popup.className = 'reaction-users-popup';
    popup.id = 'reaction-users-popup';
    popup.innerHTML = '<div class="reaction-users-loading">불러오는 중...</div>';

    const positionReactionPopup = (r) => {
      popup.style.left = `${r.left}px`;
      popup.style.top = `${r.bottom + 4}px`;
      const pw = popup.offsetWidth || 180;
      if (r.left + pw > window.innerWidth) {
        popup.style.left = `${window.innerWidth - pw - 8}px`;
      }
    };
    const rect = badge.getBoundingClientRect();
    positionReactionPopup(rect);
    document.body.appendChild(popup);
    positionReactionPopup(badge.getBoundingClientRect());
    this._trackPopupScroll('reactionPopup', popup, badge, positionReactionPopup);

    try {
      let users = [];

      if (platform === 'mastodon') {
        // Mastodon doesn't have per-reaction users, skip
        popup.innerHTML = '<div class="reaction-users-loading">Mastodon은 리액션 사용자 조회를 지원하지 않습니다.</div>';
      } else {
        // Misskey: notes/reactions
        const reactions = await client.getReactions(postId, reaction || undefined);
        users = reactions.map(r => {
          const normalized = r.user ? client.normalizeUser(r.user) : null;
          return {
            displayNameHtml: normalized?.displayNameHtml || this.escapeHtml(r.user?.name || r.user?.username || '?'),
            username: normalized?.username || r.user?.username || '?',
            avatarUrl: normalized?.avatarUrl || r.user?.avatarUrl || '',
            reaction: r.type || '',
          };
        });

        if (users.length === 0) {
          popup.innerHTML = '<div class="reaction-users-loading">리액션한 사용자가 없습니다.</div>';
        } else {
          let html = '<div class="reaction-users-list">';
          for (const user of users) {
            html += `
              <div class="reaction-user-item">
                <img class="reaction-user-avatar" src="${this.escapeHtml(user.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
                <span class="reaction-user-name">${user.displayNameHtml}</span>
                <span class="reaction-user-handle">@${this.escapeHtml(user.username)}</span>
              </div>
            `;
          }
          html += '</div>';
          popup.innerHTML = html;
        }
      }
    } catch {
      popup.innerHTML = '<div class="reaction-users-loading">불러오기 실패</div>';
    }

    // Close on outside click (persistent listener)
    setTimeout(() => {
      const handler = (e) => {
        if (!popup.contains(e.target) && !badge.contains(e.target)) {
          this.closeReactionPopup();
        }
      };
      document.addEventListener('click', handler);
      this._reactionPopupClose = handler;
    }, 0);
  }

  closeReactionPopup() {
    const existing = document.getElementById('reaction-users-popup');
    if (existing) existing.remove();
    if (this._reactionPopupClose) {
      document.removeEventListener('click', this._reactionPopupClose);
      this._reactionPopupClose = null;
    }
    this._removeScrollTracker('reactionPopup');
  }

  // Track scroll on the column-content and reposition a fixed popup to follow the anchor
  _trackPopupScroll(key, popup, anchorElement, positionFn) {
    const scrollContainer = anchorElement.closest('.column-content');
    if (!scrollContainer) return;
    const handler = () => {
      const rect = anchorElement.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      // Hide popup if anchor scrolled out of view
      if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) {
        popup.style.visibility = 'hidden';
      } else {
        popup.style.visibility = '';
        positionFn(rect);
      }
    };
    scrollContainer.addEventListener('scroll', handler, { passive: true });
    if (!this._scrollTrackers) this._scrollTrackers = {};
    this._scrollTrackers[key] = { container: scrollContainer, handler };
  }

  _removeScrollTracker(key) {
    if (!this._scrollTrackers || !this._scrollTrackers[key]) return;
    const { container, handler } = this._scrollTrackers[key];
    container.removeEventListener('scroll', handler);
    delete this._scrollTrackers[key];
  }

  // ===== Helpers =====

  openModal(overlay) {
    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('visible'));
  }

  closeModal(overlay) {
    if (!overlay || overlay.style.display === 'none') return;
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', () => {
      if (!overlay.classList.contains('visible')) overlay.style.display = 'none';
    }, { once: true });
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ===== Auth & Cloud Sync =====

  async checkAuth() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const data = await res.json();
      if (data.loggedIn) {
        this._currentUser = { username: data.username, role: data.role };
        this.updateAuthButton();
        await this.loadCloudData();
      }
    } catch {}
  }

  async fetchSiteInfo() {
    try {
      const res = await fetch('/api/site-info');
      this._siteInfo = await res.json();
    } catch {}
  }

  updateAuthButton() {
    const isAdmin = this._currentUser?.role === 'admin';
    if (this._currentUser) {
      this.btnAuth.textContent = this._currentUser.username;
      this.btnAuth.classList.add('logged-in');
      this.btnAuth.title = '사용자 메뉴';
      document.getElementById('user-menu-header').textContent = `${this._currentUser.username} 님`;
    } else {
      this.btnAuth.textContent = '로그인';
      this.btnAuth.classList.remove('logged-in');
      this.btnAuth.title = '로그인';
    }
    // Show/hide admin items
    document.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = isAdmin ? '' : 'none';
    });
    if (isAdmin) this.updateAdminUI();
  }

  handleAuthButtonClick() {
    if (this._currentUser) {
      this.toggleUserMenu();
    } else {
      this._authMode = 'login';
      this.updateAuthModal();
      this.openModal(this.modalAuth);
      this.authUsername.focus();
    }
  }

  toggleUserMenu() {
    const menu = document.getElementById('user-menu');
    const wrap = document.getElementById('user-menu-wrap');
    const isOpen = menu.classList.contains('open');
    if (isOpen) {
      this.closeUserMenu();
    } else {
      menu.style.display = 'block';
      requestAnimationFrame(() => menu.classList.add('open'));
      if (this._userMenuOutsideClick) {
        document.removeEventListener('click', this._userMenuOutsideClick, true);
      }
      this._userMenuOutsideClick = (e) => {
        if (!wrap.contains(e.target)) {
          this.closeUserMenu();
        }
      };
      setTimeout(() => document.addEventListener('click', this._userMenuOutsideClick, true), 0);
    }
  }

  closeUserMenu() {
    const menu = document.getElementById('user-menu');
    menu.classList.remove('open');
    menu.addEventListener('transitionend', () => {
      if (!menu.classList.contains('open')) menu.style.display = 'none';
    }, { once: true });
    if (this._userMenuOutsideClick) {
      document.removeEventListener('click', this._userMenuOutsideClick, true);
      this._userMenuOutsideClick = null;
    }
  }

  async handleUserMenuAction(action) {
    this.closeUserMenu();
    switch (action) {
      case 'add-account':
        this.openAddAccountModal();
        break;
      case 'sync-now':
        await this.saveToCloud();
        break;
      case 'export-data': {
        const data = {
          accounts: this.store.getAll().map(a => ({
            id: a.id, platform: a.platform, instanceUrl: a.instanceUrl,
            accessToken: a.accessToken, themeColor: a.themeColor,
            label: a.label, profile: a.profile,
          })),
          settings: this.settings,
          columnState: this.columnState,
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `starship-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        break;
      }
      case 'import-data':
        document.getElementById('import-file-input').click();
        break;
      case 'toggle-registration':
        await this.toggleRegistration();
        break;
      case 'logout':
        if (confirm('로그아웃 하시겠습니까?')) {
          await this.logout();
        }
        break;
    }
  }

  async toggleRegistration() {
    const newVal = !this._siteInfo.registrationOpen;
    try {
      await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ registration_open: String(newVal) }),
      });
      this._siteInfo.registrationOpen = newVal;
      this.updateAdminUI();
    } catch {}
  }

  updateAdminUI() {
    const text = document.getElementById('toggle-reg-text');
    const icon = document.querySelector('#btn-toggle-reg svg line');
    if (this._siteInfo.registrationOpen) {
      text.textContent = '회원가입 닫기';
      if (icon) icon.setAttribute('x1', '23');
    } else {
      text.textContent = '회원가입 열기';
      if (icon) icon.setAttribute('x1', '20');
    }
  }

  toggleAuthMode() {
    this._authMode = this._authMode === 'login' ? 'register' : 'login';
    this.updateAuthModal();
  }

  updateAuthModal() {
    const isLogin = this._authMode === 'login';
    const regClosed = !isLogin && !this._siteInfo.registrationOpen;
    this.authModalTitle.textContent = isLogin ? '로그인' : '회원가입';
    this.authSubtitle.textContent = isLogin ? 'StarShip에 오신 것을 환영합니다'
      : regClosed ? '현재 회원가입이 비활성화되어 있습니다' : '새 계정을 만들어보세요';
    this.btnAuthSubmit.textContent = isLogin ? '로그인' : '가입하기';
    this.btnAuthSubmit.disabled = regClosed;
    this.authSwitchText.textContent = isLogin ? '계정이 없으신가요?' : '이미 계정이 있으신가요?';
    this.btnAuthSwitch.textContent = isLogin ? '회원가입' : '로그인';
    this.authError.style.display = 'none';
    this.authPassword.autocomplete = isLogin ? 'current-password' : 'new-password';
    // Turnstile
    const container = document.getElementById('turnstile-container');
    if (!isLogin && this._siteInfo.turnstileSiteKey && !regClosed) {
      container.style.display = 'flex';
      this.renderTurnstile();
    } else {
      container.style.display = 'none';
      this.removeTurnstile();
    }
  }

  renderTurnstile() {
    if (this._turnstileWidgetId != null || !window.turnstile) return;
    const container = document.getElementById('turnstile-container');
    container.innerHTML = '';
    this._turnstileToken = null;
    this._turnstileWidgetId = window.turnstile.render(container, {
      sitekey: this._siteInfo.turnstileSiteKey,
      theme: 'dark',
      callback: (token) => { this._turnstileToken = token; },
      'expired-callback': () => { this._turnstileToken = null; },
    });
  }

  removeTurnstile() {
    if (this._turnstileWidgetId != null && window.turnstile) {
      window.turnstile.remove(this._turnstileWidgetId);
      this._turnstileWidgetId = null;
      this._turnstileToken = null;
    }
  }

  async handleAuthSubmit() {
    const username = this.authUsername.value.trim();
    const password = this.authPassword.value;
    if (!username || !password) {
      this.authError.textContent = '아이디와 비밀번호를 입력해주세요';
      this.authError.style.display = 'block';
      return;
    }

    this.btnAuthSubmit.disabled = true;
    this.btnAuthSubmit.textContent = '처리 중...';

    try {
      const endpoint = this._authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username, password,
          ...(this._authMode === 'register' && this._turnstileToken ? { turnstileToken: this._turnstileToken } : {}),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        this.authError.textContent = data.error || '오류가 발생했습니다';
        this.authError.style.display = 'block';
        if (window.turnstile && this._turnstileWidgetId != null) {
          window.turnstile.reset(this._turnstileWidgetId);
          this._turnstileToken = null;
        }
        return;
      }

      this.removeTurnstile();
      this._currentUser = { username: data.username, role: data.role || 'user' };
      this.updateAuthButton();
      this.closeModal(this.modalAuth);
      this.authUsername.value = '';
      this.authPassword.value = '';

      if (this._authMode === 'register') {
        // New registration: save current local data to cloud
        await this.saveToCloud();
      } else {
        // Login: load cloud data
        await this.loadCloudData();
      }
    } catch (err) {
      this.authError.textContent = '서버 연결 오류';
      this.authError.style.display = 'block';
    } finally {
      this.btnAuthSubmit.disabled = false;
      this.updateAuthModal();
    }
  }

  async logout() {
    await this.saveToCloud();
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {}
    this._currentUser = null;
    // Clear local data
    this.store.replaceAll([]);
    this.columnState = { all: true, notifications: true, accounts: {}, columnOrder: [] };
    this.saveColumnState();
    this.columnsContainer.innerHTML = '';
    this.updateAuthButton();
    this.render();
  }

  async saveToCloud() {
    if (!this._currentUser) return;
    try {
      await fetch('/api/sync/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          accounts: this.store.getAll().map(a => ({
            id: a.id, platform: a.platform, instanceUrl: a.instanceUrl,
            accessToken: a.accessToken, themeColor: a.themeColor,
            label: a.label, profile: a.profile,
          })),
          settings: this.settings,
          columnState: this.columnState,
        }),
      });
    } catch (err) {
      console.error('Cloud save failed:', err);
    }
  }

  debouncedSaveToCloud() {
    if (!this._currentUser) return;
    clearTimeout(this._syncDebounce);
    this._syncDebounce = setTimeout(() => this.saveToCloud(), 2000);
  }

  async loadCloudData() {
    if (!this._currentUser) return;
    try {
      const res = await fetch('/api/sync/load', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();

      if (data.accounts && data.accounts.length > 0) {
        // Replace local accounts with cloud data
        this.store.replaceAll(data.accounts);
      }
      if (data.settings) {
        this.settings = { ...this.settings, ...data.settings };
        this.saveSettings();
        this.applySettings();
      }
      if (data.columnState) {
        this.columnState = data.columnState;
        this.saveColumnState();
      }
      // Re-render with cloud data
      this.render();
    } catch (err) {
      console.error('Cloud load failed:', err);
    }
  }
}

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
