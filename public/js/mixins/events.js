/**
 * Events Mixin
 * All event binding, keyboard navigation, and lightbox.
 */
import { escapeHtml } from '../ui/utils.js';

export const EventsMixin = {

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
  },

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
  },

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
  },

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
  },

  _bindAccountSetupEvents() {
    this.instanceUrl.addEventListener('input', () => this.updateOAuthButton());
    this.instanceUrl.addEventListener('blur', () => this.autoDetectPlatform());
    this.btnOAuthLogin.addEventListener('click', () => this.handleOAuthLogin());
    this.btnConfirmAdd.addEventListener('click', () => this.handleAddAccount());
  },

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
    let touchHandled = false;
    document.addEventListener('touchend', (e) => {
      const wasDrag = moved;
      onEnd();
      if (!wasDrag && e.changedTouches && e.changedTouches.length) {
        const touch = e.changedTouches[0];
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const toggle = el && el.closest('.col-toggle');
        if (toggle && this.toggleBar.contains(toggle)) {
          touchHandled = true;
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
      // Prevent duplicate toggle from touchend + click on mobile
      if (touchHandled) {
        touchHandled = false;
        return;
      }
      const toggle = e.target.closest('.col-toggle');
      if (!toggle) return;
      this.handleToggleClick(toggle);
    }, true);
  },

  _bindDelegatedEvents() {
    // CW toggle
    document.addEventListener('click', (e) => {
      if (e.target.matches('.cw-toggle')) {
        // Support data-cw-target for ID-based lookup (more reliable in flex layouts)
        const targetId = e.target.dataset.cwTarget;
        let target;
        if (targetId) {
          // Search within the closest container first to avoid ID conflicts
          // (same post can exist in both column and thread view)
          const container = e.target.closest('.thread-content, .column-content, .notif-card, .post-card');
          target = container ? container.querySelector(`#${CSS.escape(targetId)}`) : document.getElementById(targetId);
        } else {
          const cwWarning = e.target.closest('.cw-warning, .reply-context-cw, .notif-cw-warning');
          target = cwWarning?.nextElementSibling;
        }
        if (target && (target.classList.contains('cw-content') || target.id?.startsWith('reply-ctx-') || target.id?.startsWith('notif-reply-ctx-'))) {
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

    // Post actions (works for post-card and mention-style notif-card)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.post-action');
      if (!btn) return;
      const card = btn.closest('.post-card') || btn.closest('.notif-card');
      if (!card) return;

      const action = btn.dataset.action;
      const postId = card.dataset.postId;
      const platform = card.dataset.platform;
      const accountId = card.dataset.accountId;

      if (action === 'open') {
        const postUrl = this.findPostUrl(postId, platform) || card.dataset.postUrl;
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
        this.handlePostAction(action, postId, platform, accountId, actionBtn);
        return;
      }
    });

    // Notification card click: open thread view
    document.addEventListener('click', (e) => {
      const card = e.target.closest('.notif-clickable');
      if (!card) return;
      if (e.target.closest('.notif-avatar') || e.target.closest('.post-avatar') || e.target.closest('[data-lightbox]') || e.target.closest('.expand-toggle') || e.target.closest('.notif-action-btn') || e.target.closest('.post-action') || e.target.closest('.cw-toggle') || e.target.closest('.sensitive-reveal') || e.target.closest('.sensitive-hide') || e.target.closest('.link-card') || e.target.closest('.reaction-badge') || e.target.closest('.post-media')) return;
      const platform = card.dataset.platform;
      const accountId = card.dataset.accountId;
      if (!platform || !accountId) return;
      const columnType = card.closest('.column')?.dataset.columnType;
      // Quote post inside notification: open quote's thread
      const quotePart = e.target.closest('.quote-post');
      if (quotePart && quotePart.dataset.quoteId) {
        this.openThreadView(quotePart.dataset.quoteId, platform, accountId, { columnType });
        return;
      }
      const postId = card.dataset.postId;
      if (postId) {
        this.openThreadView(postId, platform, accountId, { columnType });
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
      const card = badge.closest('.post-card') || badge.closest('.notif-card');
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
      const columnType = card.closest('.column')?.dataset.columnType;

      const quotePart = e.target.closest('.quote-post');
      if (quotePart && quotePart.dataset.quoteId) {
        this.openThreadView(quotePart.dataset.quoteId, platform, accountId, { columnType });
        return;
      }

      const postId = card.dataset.postId;
      if (postId) {
        this.openThreadView(postId, platform, accountId, { columnType });
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
  },

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
  },

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

    // Infinite scroll (timeline + notifications)
    this.columnsContainer.addEventListener('scroll', (e) => {
      const columnContent = e.target;
      if (!columnContent.classList.contains('column-content')) return;
      const distFromBottom = columnContent.scrollHeight - columnContent.scrollTop - columnContent.clientHeight;
      if (distFromBottom < 300) {
        const column = columnContent.closest('.column');
        if (column && column.dataset.columnType === 'notifications') {
          this.loadOlderNotifications(columnContent);
        } else {
          this.loadOlderPosts(columnContent);
        }
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
        displayNameHtml: escapeHtml(account.profile.displayName),
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
  },

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
  },

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
  },

  // ===== Column Navigation =====

  navigateColumn(direction) {
    const columns = this.columnsContainer.querySelectorAll('.column');
    if (columns.length === 0) return;

    this.focusedColumnIndex += direction;
    if (this.focusedColumnIndex < 0) this.focusedColumnIndex = 0;
    if (this.focusedColumnIndex >= columns.length) this.focusedColumnIndex = columns.length - 1;

    this.focusColumn(columns[this.focusedColumnIndex]);
  },

  focusColumn(col) {
    const columns = this.columnsContainer.querySelectorAll('.column');
    columns.forEach(c => c.classList.remove('focused'));
    col.classList.add('focused');
    // Update index
    this.focusedColumnIndex = [...columns].indexOf(col);
    col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  },

  // Get the account ID of the currently focused column (null if 'all' or 'notifications')
  getFocusedColumnAccountId() {
    const columns = this.columnsContainer.querySelectorAll('.column');
    const focused = columns[this.focusedColumnIndex];
    if (!focused) return null;
    if (focused.dataset.columnType === 'account') return focused.dataset.accountId || null;
    return null;
  },

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
  },

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
  },
};
