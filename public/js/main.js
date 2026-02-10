/**
 * StarShip - Main Application
 * Fediverse multi-account dashboard for Misskey, Iceshrimp, CherryPick, and Mastodon.
 */
import { AccountStore } from './accounts.js';
import { renderPost, renderNotification, renderAccountCard, renderLoading, renderLoadingText, iconRefresh, iconClose } from './ui/dashboard.js';
import { startMastodonOAuth, startMiAuth, waitForAuthCallback, clearPendingAuth } from './auth.js';

// Mixins
import { PostActionsMixin } from './mixins/post-actions.js';
import { ComposeMixin } from './mixins/compose.js';
import { DataLoadingMixin } from './mixins/data-loading.js';
import { AuthUIMixin } from './mixins/auth-ui.js';
import { AccountSetupMixin } from './mixins/account-setup.js';
import { ThreadViewMixin } from './mixins/thread-view.js';

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
    } catch {}
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

    // Header compose button: pre-select focused column's account
    document.getElementById('btn-compose-header').addEventListener('click', () => {
      const accountId = this.getFocusedColumnAccountId();
      this.openComposeModal(null, accountId || null);
    });

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
    // Registration mode buttons
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

    // Toggle bar: drag to scroll (mouse + touch)
    {
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

        // Touch direction lock
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
        // Touch tap: manually trigger toggle if it wasn't a drag
        if (!wasDrag && e.changedTouches && e.changedTouches.length) {
          const touch = e.changedTouches[0];
          const el = document.elementFromPoint(touch.clientX, touch.clientY);
          const toggle = el && el.closest('.col-toggle');
          if (toggle && this.toggleBar.contains(toggle)) {
            this.handleToggleClick(toggle);
          }
        }
      });

      // Prevent toggle click when dragging (mouse)
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

    // CW toggle (delegated) — use relative DOM instead of getElementById to avoid duplicate-id issues
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

    // Expand toggle for long content — use relative DOM
    document.addEventListener('click', (e) => {
      if (e.target.matches('.expand-toggle')) {
        const target = e.target.previousElementSibling;
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
      } else if (action === 'edit') {
        this.openEditModal(postId, platform, accountId);
      } else if (action === 'delete') {
        this.handleDeletePost(postId, platform, accountId, btn);
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

      const postId = card.dataset.postId;
      if (postId) {
        const post = this.postCache.get(`${platform}:${postId}`);
        if (post) {
          // Use displayPost author (correct for reblogs/renotes)
          const displayPost = post.reblog || post;
          this.openProfileModal(displayPost.author, platform, accountId);
          return;
        }
      }
      // Notification actor fallback: use actorId to open profile with minimal info
      const actorId = card.dataset.actorId;
      if (actorId) {
        const avatarUrl = avatar.src || '';
        const minimalAuthor = { id: actorId, avatarUrl, displayName: '', displayNameHtml: '', acct: '', username: '' };
        this.openProfileModal(minimalAuthor, platform, accountId);
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

    // Post card click: open thread view
    document.addEventListener('click', (e) => {
      // Skip if clicking interactive elements
      if (e.target.closest('.post-action, .reaction-badge, a, button, [data-lightbox], .expand-toggle, .cw-toggle, .post-media, img')) return;
      const card = e.target.closest('.post-card');
      if (!card) return;
      // Don't open thread from inside the thread modal itself
      if (card.closest('.thread-content')) return;
      const platform = card.dataset.platform;
      const accountId = card.dataset.accountId;
      if (!platform || !accountId) return;

      // If clicking inside a quote-post, open thread for the quoted post
      const quotePart = e.target.closest('.quote-post');
      if (quotePart && quotePart.dataset.quoteId) {
        this.openThreadView(quotePart.dataset.quoteId, platform, accountId);
        return;
      }

      // Otherwise open thread for the parent post
      const postId = card.dataset.postId;
      if (postId) {
        this.openThreadView(postId, platform, accountId);
      }
    });

    // Image lightbox (delegated)
    document.addEventListener('click', (e) => {
      const img = e.target.closest('img[data-lightbox="true"]');
      if (!img) return;
      e.preventDefault();
      e.stopPropagation();
      const fullUrl = img.dataset.fullUrl || img.src;
      this.openLightbox(fullUrl, img);
    });

    // Lightbox close: background, image, or close button
    this.lightboxClose.addEventListener('click', () => this.closeLightbox());
    this.lightbox.addEventListener('click', (e) => {
      if (e.target === this.lightbox || e.target === this.lightboxImg) {
        this.closeLightbox();
      }
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
        const accountId = this.getFocusedColumnAccountId();
        this.openComposeModal(null, accountId || null);
        return;
      }

      if (e.key === 'Escape') {
        // Close one layer at a time: topmost modal first
        if (this.closeTopmostModal()) return;
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

    // Column headers: drag to scroll columns container horizontally (with momentum)
    {
      let isDragging = false, startX = 0, startY = 0, scrollStart = 0, moved = false;
      let velocity = 0, momentumId = null;
      let prevX = 0, prevTime = 0;
      let directionLocked = false; // once locked horizontal, prevent vertical scroll
      const getX = (e) => e.touches ? e.touches[0].pageX : e.pageX;
      const getY = (e) => e.touches ? e.touches[0].pageY : e.pageY;
      const SMOOTHING = 0.5;

      const startDrag = (e, isTouch) => {
        const header = e.target.closest('.column-header');
        if (!header || e.target.closest('button')) return;
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

        // Touch: lock direction after small movement
        if (e.touches && !directionLocked) {
          const y = e.touches[0].pageY;
          const dx = Math.abs(x - startX);
          const dy = Math.abs(y - startY);
          if (dx + dy > 5) {
            if (dx > dy) {
              directionLocked = true; // horizontal drag confirmed
            } else {
              isDragging = false; // vertical scroll, release
              return;
            }
          } else {
            return; // wait for direction
          }
        }

        // Prevent default scroll once locked horizontal
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
        // Use last known velocity (changedTouches has no pageX for velocity)
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

      // Click on column header (not drag): focus the column
      this.columnsContainer.addEventListener('click', (e) => {
        if (moved) return; // was a drag, not a click
        const header = e.target.closest('.column-header');
        if (!header || e.target.closest('button')) return;
        const col = header.closest('.column');
        if (!col) return;
        this.focusColumn(col);
      });
    }

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

    let avatarHtml = '';
    if (type === 'account' && accountId) {
      const account = this.store.getById(accountId);
      if (account?.profile?.avatarUrl) {
        avatarHtml = `<img class="column-header-avatar" src="${this.escapeHtml(account.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">`;
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
    if (top.id === 'modal-compose') this.closeComposeEmojiPicker();
    return true;
  }

  async openProfileModal(author, platform, accountId) {
    const modal = document.getElementById('modal-profile');
    const banner = document.getElementById('profile-banner');
    const avatar = document.getElementById('profile-avatar');
    const nameEl = document.getElementById('profile-name');
    const handleEl = document.getElementById('profile-handle');
    const bioEl = document.getElementById('profile-bio');
    const statsEl = document.getElementById('profile-stats');
    const fieldsEl = document.getElementById('profile-fields');
    const actionsEl = document.getElementById('profile-actions');
    const editInline = document.getElementById('profile-edit-inline');
    const tabsEl = document.getElementById('profile-tabs');
    const postsEl = document.getElementById('profile-posts');
    const editBannerBtn = document.getElementById('profile-edit-banner-btn');
    const editBannerInput = document.getElementById('profile-edit-banner-input');
    const editAvatarBtn = document.getElementById('profile-edit-avatar-btn');
    const editAvatarInput = document.getElementById('profile-edit-avatar-input');
    const stickyHeader = document.getElementById('profile-sticky-header');
    const stickyAvatar = document.getElementById('profile-sticky-avatar');
    const stickyName = document.getElementById('profile-sticky-name');
    const stickyHandle = document.getElementById('profile-sticky-handle');

    // Cleanup previous scroll listeners
    const scrollEl = modal.querySelector('.profile-scroll');
    if (this._profileScrollHandler && scrollEl) {
      scrollEl.removeEventListener('scroll', this._profileScrollHandler);
      this._profileScrollHandler = null;
    }
    if (this._profileStickyScrollHandler && scrollEl) {
      scrollEl.removeEventListener('scroll', this._profileStickyScrollHandler);
      this._profileStickyScrollHandler = null;
    }
    this._profileState = null;

    // Reset
    banner.style.backgroundImage = '';
    banner.style.backgroundPosition = '';
    banner.style.backgroundSize = '';
    banner.style.background = 'linear-gradient(135deg, var(--accent-primary), #a78bfa)';
    avatar.src = author.avatarUrl || '';
    nameEl.innerHTML = author.displayNameHtml || this.escapeHtml(author.displayName);
    handleEl.textContent = `@${author.acct}`;
    bioEl.innerHTML = '';
    statsEl.innerHTML = '';
    fieldsEl.innerHTML = '';
    actionsEl.innerHTML = '';
    editInline.style.display = 'none';
    editBannerBtn.style.display = 'none';
    editAvatarBtn.style.display = 'none';
    editBannerInput.value = '';
    editAvatarInput.value = '';
    this._profileEditAvatarFile = null;
    this._profileEditBannerFile = null;
    tabsEl.style.display = 'none';
    postsEl.style.display = 'none';
    postsEl.innerHTML = '';

    // Reset sticky header
    stickyHeader.classList.remove('visible');
    stickyAvatar.src = author.avatarUrl || '';
    stickyName.innerHTML = author.displayNameHtml || this.escapeHtml(author.displayName);
    stickyHandle.textContent = `@${author.acct}`;

    // Scroll listener for sticky header
    const bannerHeight = 160; // matches CSS .profile-banner height
    const threshold = bannerHeight - 44; // show sticky when banner mostly scrolled away
    const onScroll = () => {
      const scrollTop = scrollEl.scrollTop;
      if (scrollTop >= threshold) {
        stickyHeader.classList.add('visible');
      } else {
        stickyHeader.classList.remove('visible');
      }
    };
    scrollEl.addEventListener('scroll', onScroll);
    this._profileStickyScrollHandler = onScroll;

    // Reset scroll position
    scrollEl.scrollTop = 0;

    this.openModal(modal);

    // Fetch full profile
    const client = this.store.getClient(accountId);
    if (!client) return;

    try {
      const user = await client.getUser(author.id);
      if (!user) return;

      // Banner
      const bannerUrl = user.bannerUrl || user.header;
      if (bannerUrl) {
        banner.style.background = 'none';
        banner.style.backgroundImage = `url(${bannerUrl})`;
        banner.style.backgroundPosition = 'center';
        banner.style.backgroundSize = 'cover';
        banner.style.backgroundColor = 'var(--bg-tertiary)';
      }

      // Avatar
      avatar.src = user.avatarUrl || user.avatar || author.avatarUrl;

      // Name with emoji
      const isMisskey = platform !== 'mastodon';
      if (isMisskey) {
        // Resolve custom emojis in Misskey display name
        const userEmojis = {};
        if (user.emojis && typeof user.emojis === 'object' && !Array.isArray(user.emojis)) {
          Object.assign(userEmojis, user.emojis);
        }
        if (Array.isArray(user.emojis)) {
          for (const e of user.emojis) {
            if (e.name && e.url) userEmojis[e.name] = e.url;
          }
        }
        nameEl.innerHTML = client.resolveNameEmojis(user.name || user.username, userEmojis);
      } else {
        // Resolve custom emojis in Mastodon display name
        let nameHtml = this.escapeHtml(user.display_name || user.username);
        if (user.emojis && user.emojis.length > 0) {
          for (const emoji of user.emojis) {
            nameHtml = nameHtml.replaceAll(`:${emoji.shortcode}:`,
              `<img class="inline-emoji" src="${emoji.url}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" referrerpolicy="no-referrer">`);
          }
        }
        nameEl.innerHTML = nameHtml;
      }

      // Handle
      const host = user.host || '';
      const acct = user.acct || (host ? `${user.username}@${host}` : user.username);
      handleEl.textContent = `@${acct}`;

      // Sync sticky header with full data
      stickyAvatar.src = avatar.src;
      stickyName.innerHTML = nameEl.innerHTML;
      stickyHandle.textContent = handleEl.textContent;

      // Bio - render with MFM (Misskey) or HTML (Mastodon)
      if (isMisskey) {
        const bio = user.description || '';
        if (bio) {
          const userEmojis = {};
          if (user.emojis && typeof user.emojis === 'object' && !Array.isArray(user.emojis)) {
            Object.assign(userEmojis, user.emojis);
          }
          if (Array.isArray(user.emojis)) {
            for (const e of user.emojis) {
              if (e.name && e.url) userEmojis[e.name] = e.url;
            }
          }
          bioEl.innerHTML = client.mfmToHtml(bio, userEmojis);
        }
      } else {
        const bio = user.note || '';
        if (bio) {
          bioEl.innerHTML = bio;
        }
      }

      // Stats
      const followers = user.followersCount ?? user.followers_count ?? 0;
      const following = user.followingCount ?? user.following_count ?? 0;
      const posts = user.notesCount ?? user.statuses_count ?? 0;
      statsEl.innerHTML = `
        <span class="profile-stat"><strong>${followers}</strong> 팔로워</span>
        <span class="profile-stat"><strong>${following}</strong> 팔로잉</span>
        <span class="profile-stat"><strong>${posts}</strong> ${isMisskey ? '노트' : '게시물'}</span>
      `;

      // Fields
      const fields = user.fields || [];
      if (fields.length > 0) {
        fieldsEl.innerHTML = fields.map(f => `
          <div class="profile-field">
            <span class="profile-field-name">${this.escapeHtml(f.name)}</span>
            <span class="profile-field-value">${f.value || this.escapeHtml(f.value)}</span>
          </div>
        `).join('');
      }

      // Check if this is my account
      const myAccount = this.store.getAll().find(a =>
        String(a.profile?.id) === String(user.id) && a.platform === platform
      );
      const account = this.store.getById(accountId);
      const instanceUrl = account?.instanceUrl || '';

      // Actions
      let actionsHtml = `<a class="btn btn-secondary btn-small" href="${instanceUrl}/@${user.username}" target="_blank" rel="noopener">인스턴스에서 보기</a>`;
      if (myAccount) {
        actionsHtml += `<button class="btn btn-primary btn-small" id="btn-profile-edit">프로필 수정</button>`;
      }
      actionsEl.innerHTML = actionsHtml;

      // Show notes tabs for own account
      if (myAccount) {
        tabsEl.style.display = 'flex';
        postsEl.style.display = 'block';
        this._loadProfileNotes(user.id, platform, accountId, client, isMisskey, account);
      }

      // Edit handlers
      if (myAccount) {
        const editBtn = document.getElementById('btn-profile-edit');
        const editName = document.getElementById('profile-edit-name');
        const editBio = document.getElementById('profile-edit-bio');

        const enterEditMode = () => {
          editName.value = isMisskey ? (user.name || '') : (user.display_name || '');
          editBio.value = isMisskey ? (user.description || '') : (user.source?.note || user.note?.replace(/<[^>]*>/g, '') || '');
          this._profileEditAvatarFile = null;
          this._profileEditBannerFile = null;
          editAvatarInput.value = '';
          editBannerInput.value = '';
          // Show inline edit fields, hide display fields
          editInline.style.display = 'block';
          nameEl.style.display = 'none';
          bioEl.style.display = 'none';
          // Show image overlays
          editBannerBtn.style.display = 'flex';
          editAvatarBtn.style.display = 'flex';
          // Swap action buttons
          actionsEl.innerHTML = `
            <button class="btn btn-secondary btn-small" id="btn-profile-edit-cancel">취소</button>
            <button class="btn btn-primary btn-small" id="btn-profile-edit-save">저장</button>
          `;
          document.getElementById('btn-profile-edit-cancel').addEventListener('click', exitEditMode);
          document.getElementById('btn-profile-edit-save').addEventListener('click', saveProfile);
        };

        const exitEditMode = () => {
          editInline.style.display = 'none';
          nameEl.style.display = '';
          bioEl.style.display = '';
          editBannerBtn.style.display = 'none';
          editAvatarBtn.style.display = 'none';
          // Restore original avatar/banner if changed but not saved
          if (this._profileEditAvatarFile) {
            avatar.src = this._profileOriginalAvatar || '';
          }
          if (this._profileEditBannerFile) {
            banner.style.cssText = this._profileOriginalBannerStyle || '';
          }
          // Restore action buttons
          let html = `<a class="btn btn-secondary btn-small" href="${instanceUrl}/@${user.username}" target="_blank" rel="noopener">인스턴스에서 보기</a>`;
          html += `<button class="btn btn-primary btn-small" id="btn-profile-edit">프로필 수정</button>`;
          actionsEl.innerHTML = html;
          document.getElementById('btn-profile-edit').addEventListener('click', enterEditMode);
        };

        const saveProfile = async () => {
          const saveBtn = document.getElementById('btn-profile-edit-save');
          saveBtn.disabled = true;
          saveBtn.textContent = '저장 중...';
          try {
            const myClient = this.store.getClient(myAccount.id);
            if (isMisskey) {
              const params = { name: editName.value, description: editBio.value };
              // Upload avatar/banner to drive first
              if (this._profileEditAvatarFile) {
                const file = await myClient.uploadFile(this._profileEditAvatarFile);
                params.avatarId = file.id;
              }
              if (this._profileEditBannerFile) {
                const file = await myClient.uploadFile(this._profileEditBannerFile);
                params.bannerId = file.id;
              }
              await myClient.updateProfile(params);
            } else {
              await myClient.updateProfile({
                displayName: editName.value,
                note: editBio.value,
                avatar: this._profileEditAvatarFile || undefined,
                header: this._profileEditBannerFile || undefined,
              });
            }
            // Update local profile
            myAccount.profile.displayName = editName.value || myAccount.profile.username;
            this.store.save();
            this.debouncedSaveToCloud();
            // Update display
            nameEl.textContent = editName.value || myAccount.profile.username;
            bioEl.innerHTML = this.escapeHtml(editBio.value).replace(/\n/g, '<br>');
            stickyName.textContent = editName.value || myAccount.profile.username;
            // Save new originals for next edit
            this._profileOriginalAvatar = avatar.src;
            this._profileOriginalBannerStyle = banner.style.cssText;
            // Exit edit mode
            editInline.style.display = 'none';
            nameEl.style.display = '';
            bioEl.style.display = '';
            editBannerBtn.style.display = 'none';
            editAvatarBtn.style.display = 'none';
            let html = `<a class="btn btn-secondary btn-small" href="${instanceUrl}/@${user.username}" target="_blank" rel="noopener">인스턴스에서 보기</a>`;
            html += `<button class="btn btn-primary btn-small" id="btn-profile-edit">프로필 수정</button>`;
            actionsEl.innerHTML = html;
            document.getElementById('btn-profile-edit').addEventListener('click', enterEditMode);
          } catch (err) {
            if (err.message.includes('PERMISSION_DENIED')) {
              alert('프로필 수정 권한이 없습니다.\n\nMisskey 설정 → API → 액세스 토큰에서 다음 권한을 포함한 토큰을 새로 발급하세요:\n• 계정 정보 수정 (write:account)\n• 드라이브 조작 (write:drive)');
            } else {
              alert('프로필 수정 실패: ' + err.message);
            }
          } finally {
            const btn = document.getElementById('btn-profile-edit-save');
            if (btn) { btn.disabled = false; btn.textContent = '저장'; }
          }
        };

        // Image upload handlers
        editBannerBtn.onclick = () => editBannerInput.click();
        editBannerInput.onchange = () => {
          const file = editBannerInput.files[0];
          if (!file) return;
          this._profileEditBannerFile = file;
          const url = URL.createObjectURL(file);
          banner.style.background = 'none';
          banner.style.backgroundImage = `url(${url})`;
          banner.style.backgroundSize = 'cover';
          banner.style.backgroundPosition = 'center';
        };
        editAvatarBtn.onclick = () => editAvatarInput.click();
        editAvatarInput.onchange = () => {
          const file = editAvatarInput.files[0];
          if (!file) return;
          this._profileEditAvatarFile = file;
          avatar.src = URL.createObjectURL(file);
        };

        // Store originals for cancel
        this._profileOriginalAvatar = avatar.src;
        this._profileOriginalBannerStyle = banner.style.cssText;

        editBtn.addEventListener('click', enterEditMode);
      }
    } catch (err) {
      bioEl.innerHTML = `<span style="color:var(--text-muted)">프로필을 불러올 수 없습니다</span>`;
    }
  }

  async _loadProfileNotes(userId, platform, accountId, client, isMisskey, account) {
    const postsEl = document.getElementById('profile-posts');
    const tabsEl = document.getElementById('profile-tabs');
    const scrollEl = document.querySelector('#modal-profile .profile-scroll');
    postsEl.innerHTML = '<div class="profile-posts-empty"><div class="spinner"></div></div>';

    // State for infinite scroll
    this._profileState = {
      userId, platform, accountId, client, isMisskey, account,
      tabData: { notes: [], renotes: [], replies: [] },
      activeTab: 'notes',
      loading: false,
      hasMore: true,
      lastRawId: null,
    };

    try {
      await this._fetchMoreProfileNotes();

      // Setup tabs
      const newTabs = tabsEl.cloneNode(true);
      tabsEl.replaceWith(newTabs);
      this._profileState.tabsEl = newTabs;
      this._updateProfileTabCounts();
      this._renderProfileTab('notes', postsEl);

      // Tab click
      newTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.profile-tab');
        if (!tab) return;
        const tabName = tab.dataset.profileTab;
        if (!tabName) return;
        newTabs.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this._profileState.activeTab = tabName;
        this._renderProfileTab(tabName, postsEl);
      });

      // Infinite scroll on the profile-scroll container
      if (this._profileScrollHandler) {
        scrollEl.removeEventListener('scroll', this._profileScrollHandler);
      }
      this._profileScrollHandler = () => {
        if (!this._profileState || this._profileState.loading || !this._profileState.hasMore) return;
        const { scrollTop, scrollHeight, clientHeight } = scrollEl;
        if (scrollTop + clientHeight >= scrollHeight - 100) {
          this._loadMoreProfileNotes();
        }
      };
      scrollEl.addEventListener('scroll', this._profileScrollHandler);
    } catch (err) {
      console.error('Failed to load profile notes:', err);
      postsEl.innerHTML = '<div class="profile-posts-empty">노트를 불러올 수 없습니다</div>';
    }
  }

  async _fetchMoreProfileNotes() {
    const s = this._profileState;
    if (!s || s.loading || !s.hasMore) return [];
    s.loading = true;

    try {
      let raw;
      if (s.isMisskey) {
        raw = await s.client.getUserNotes(s.userId, 20, s.lastRawId);
      } else {
        raw = await s.client.getUserStatuses(s.userId, 20, s.lastRawId);
      }
      if (!raw || raw.length === 0) {
        s.hasMore = false;
        return [];
      }
      s.lastRawId = raw[raw.length - 1].id;
      if (raw.length < 20) s.hasMore = false;

      const normalized = raw.map(n => s.client.normalizePost(n));
      normalized.forEach(post => {
        post.accountId = s.accountId;
        post.accountPlatform = s.platform;
        post.themeColor = s.account?.themeColor || null;
        const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
        post.isOwn = String(ownerId) === String(s.account?.profile?.id);
      });
      this.cachePosts(normalized);

      // Categorize and append
      for (const n of normalized) {
        if (n.rebloggedBy) s.tabData.renotes.push(n);
        else if (n.replyToId) s.tabData.replies.push(n);
        else s.tabData.notes.push(n);
      }
      return normalized;
    } finally {
      s.loading = false;
    }
  }

  async _loadMoreProfileNotes() {
    const s = this._profileState;
    if (!s) return;
    const postsEl = document.getElementById('profile-posts');
    const prevCounts = {
      notes: s.tabData.notes.length,
      renotes: s.tabData.renotes.length,
      replies: s.tabData.replies.length,
    };

    // Show loading indicator
    let loader = postsEl.querySelector('.profile-load-more');
    if (!loader) {
      loader = document.createElement('div');
      loader.className = 'profile-posts-empty profile-load-more';
      loader.innerHTML = '<div class="spinner"></div>';
      postsEl.appendChild(loader);
    }

    await this._fetchMoreProfileNotes();
    this._updateProfileTabCounts();

    // Remove loader
    loader = postsEl.querySelector('.profile-load-more');
    if (loader) loader.remove();

    // Append only new posts for active tab
    const tab = s.activeTab;
    const allPosts = s.tabData[tab] || [];
    const prevCount = prevCounts[tab] || 0;
    const newPosts = allPosts.slice(prevCount);
    for (const post of newPosts) {
      postsEl.appendChild(renderPost(post));
    }
    this.enrichLinkCards(postsEl);

    // Remove empty message if posts appeared
    if (allPosts.length > 0) {
      const empty = postsEl.querySelector('.profile-posts-empty:not(.profile-load-more)');
      if (empty) empty.remove();
    }
  }

  _updateProfileTabCounts() {
    const s = this._profileState;
    if (!s || !s.tabsEl) return;
    const tabLabels = { notes: '노트', renotes: '리노트', replies: '댓글' };
    s.tabsEl.querySelectorAll('.profile-tab').forEach(btn => {
      const key = btn.dataset.profileTab;
      const count = (s.tabData[key] || []).length;
      btn.innerHTML = `${tabLabels[key]} <span class="tab-count">${count}</span>`;
    });
  }

  _renderProfileTab(tabName, container) {
    const s = this._profileState;
    const posts = s ? (s.tabData[tabName] || []) : [];
    container.innerHTML = '';
    if (posts.length === 0) {
      const labels = { notes: '노트', renotes: '리노트', replies: '댓글' };
      container.innerHTML = `<div class="profile-posts-empty">${labels[tabName] || '게시물'}이 없습니다</div>`;
      return;
    }
    for (const post of posts) {
      container.appendChild(renderPost(post));
    }
    this.enrichLinkCards(container);
  }

  /** Fetch OG metadata for link cards that lack title/image and update DOM */
  enrichLinkCards(container) {
    const cards = container.querySelectorAll('.link-card[data-og-pending]');
    if (cards.length === 0) return;
    for (const card of cards) {
      const url = card.dataset.ogUrl;
      if (!url) continue;
      card.removeAttribute('data-og-pending');
      this._enrichSingleCard(card, url);
    }
  }

  async _enrichSingleCard(card, url) {
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
}

// Apply mixins
Object.assign(StarShipApp.prototype,
  PostActionsMixin,
  ComposeMixin,
  DataLoadingMixin,
  AuthUIMixin,
  AccountSetupMixin,
  ThreadViewMixin,
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
