/**
 * Events Mixin
 * All event binding, keyboard navigation, and lightbox.
 */
import { escapeHtml, compressImage } from '../ui/utils.js';

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
    this._bindPagesEvents();
  },

  _bindHeaderEvents() {
    this.btnAddAccount?.addEventListener('click', () => this.openAddAccountModal());
    this.btnAddFirst?.addEventListener('click', () => this.openAddAccountModal());
    document.getElementById('btn-welcome-login')?.addEventListener('click', () => this.handleAuthButtonClick());
    document.getElementById('btn-pages-header')?.addEventListener('click', () => this.openPagesDashboard());
    document.getElementById('btn-compose-header').addEventListener('click', () => {
      const accountId = this.getFocusedColumnAccountId();
      this.openComposeModal(null, accountId || null);
    });
    this.btnRefreshAll.addEventListener('click', () => this.refreshAll(true));
    this.btnSettings.addEventListener('click', () => this.openSettingsModal());

    // 모바일 FAB → compose 모달 열기
    document.getElementById('mobile-compose-fab')?.addEventListener('click', () => {
      const accountId = this.getFocusedColumnAccountId();
      this.openComposeModal(null, accountId || null);
    });

    // 모바일 하단 탭바 → 앱 액션 디스패치 (알림/설정/사용자)
    document.getElementById('mobile-tabbar')?.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-mobile-tab]');
      if (!tab) return;
      const type = tab.dataset.mobileTab;
      switch (type) {
        case 'notifications':
        case 'bookmarks': {
          // 해당 컬럼으로 이동. 없으면 켜고 추가.
          let col = this.columnsContainer?.querySelector(`.column[data-column-type="${type}"]`);
          if (!col) {
            this.columnState[type] = true;
            this.updateColumnOrder(type, true);
            this.saveColumnState();
            this.renderToggleBar();
            this.renderColumns();
            col = this.columnsContainer?.querySelector(`.column[data-column-type="${type}"]`);
          }
          if (col) col.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
          break;
        }
        case 'settings': this.openSettingsModal(); break;
        case 'user': {
          // 로그인 안 한 상태면 auth 모달, 로그인 상태면 사용자 메뉴를 하단 시트처럼 띄움.
          if (!this._currentUser) {
            this.handleAuthButtonClick();
            break;
          }
          const menu = document.getElementById('user-menu');
          if (!menu) break;
          // 모바일 한정으로 메뉴를 body 로 옮기고 하단 고정 시트로 표시.
          // 데스크톱 .user-menu-wrap 자손 위치는 이 세션 동안 유지되지 않을 수 있으나
          // 모바일에선 헤더가 display:none 이라 어차피 wrap 안에서는 보이지 않는다.
          if (menu.parentElement !== document.body) {
            menu._originalParent = menu.parentElement;
            document.body.appendChild(menu);
          }
          // 시트 스타일 (display:none 인 .user-menu 기본값 덮어쓰기)
          menu.style.position = 'fixed';
          menu.style.left = '12px';
          menu.style.right = '12px';
          menu.style.bottom = 'calc(env(safe-area-inset-bottom) + 72px)';
          menu.style.top = 'auto';
          menu.style.minWidth = '0';
          const isOpen = menu.classList.contains('open');
          if (isOpen) {
            menu.classList.remove('open');
            setTimeout(() => { if (!menu.classList.contains('open')) menu.style.display = 'none'; }, 200);
            if (this._userMenuOutsideClick) {
              document.removeEventListener('click', this._userMenuOutsideClick, true);
              this._userMenuOutsideClick = null;
            }
          } else {
            menu.style.display = 'block';
            requestAnimationFrame(() => menu.classList.add('open'));
            // 바깥 클릭으로 닫기
            const handler = (ev) => {
              if (menu.contains(ev.target)) return;
              if (ev.target.closest?.('[data-mobile-tab="user"]')) return;
              menu.classList.remove('open');
              setTimeout(() => { if (!menu.classList.contains('open')) menu.style.display = 'none'; }, 200);
              document.removeEventListener('click', handler, true);
              this._userMenuOutsideClick = null;
            };
            this._userMenuOutsideClick = handler;
            setTimeout(() => document.addEventListener('click', handler, true), 0);
          }
          break;
        }
      }
    });

    // Double-tap / double-click app header: scroll ALL columns to top
    const appHeader = document.querySelector('.app-header');
    if (appHeader) {
      let lastTap = 0;
      appHeader.addEventListener('touchend', (e) => {
        // Ignore taps on buttons/links
        if (e.target.closest('button, a, input')) return;
        const now = Date.now();
        if (now - lastTap < 350) {
          e.preventDefault();
          this._scrollAllColumnsToTop();
          lastTap = 0;
        } else {
          lastTap = now;
        }
      });
      appHeader.addEventListener('dblclick', (e) => {
        if (e.target.closest('button, a, input')) return;
        this._scrollAllColumnsToTop();
      });
    }
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
        this.restartStreaming();
        this.debouncedSaveToCloud();
      } catch (err) { console.error('Import failed:', err); this.showToast('파일을 읽을 수 없습니다.'); }
      e.target.value = '';
    });
  },

  _bindModalEvents() {
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.closeModal;
        if (modalId === 'modal-compose') { this._saveComposeDraft(); this.closeComposeEmojiPicker(); this.closeComposeVisibilityPicker(); this._closeEmojiAutocomplete(); }
        this.closeModal(document.getElementById(modalId));
      });
    });
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          if (overlay.id === 'modal-compose') this._saveComposeDraft();
          this.closeModal(overlay);
          this.closeComposeEmojiPicker();
          this.closeComposeVisibilityPicker();
          this._closeEmojiAutocomplete();
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
        const toggle = el && el.closest('[data-toggle-type]');
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
      const toggle = e.target.closest('[data-toggle-type]');
      if (!toggle) return;
      this.handleToggleClick(toggle);
    }, true);
  },

  _bindDelegatedEvents() {
    // CW 토글 — 배너 알약 버튼. .cw-content 의 .visible + 부모 .post-card 의 .cw-open 동기화
    document.addEventListener('click', (e) => {
      if (!e.target.matches('.cw-toggle')) return;
      const targetId = e.target.dataset.cwTarget;
      let target;
      if (targetId) {
        const container = e.target.closest('.thread-content, .column-content, .notif-card, .post-card');
        target = container ? container.querySelector(`#${CSS.escape(targetId)}`) : document.getElementById(targetId);
      } else {
        const cwWarning = e.target.closest('.cw-warning, .reply-context-cw, .notif-cw-warning');
        target = cwWarning?.nextElementSibling;
      }
      if (target && (target.classList.contains('cw-content') || target.id?.startsWith('reply-ctx-') || target.id?.startsWith('notif-reply-ctx-'))) {
        target.classList.toggle('visible');
        const opened = target.classList.contains('visible');
        e.target.textContent = opened ? '숨기기' : '내용 보기';
        // v3 redesign-03 §6 의 .cw-open .cw-content { display: block } 매칭
        const card = e.target.closest('.post-card');
        if (card) card.classList.toggle('cw-open', opened);
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
      const overflowBtn = e.target.closest('.post-action-overflow > button');
      const btn = overflowBtn || e.target.closest('.post-action');
      if (!btn) return;
      const card = btn.closest('.post-card') || btn.closest('.notif-card');
      if (!card) return;

      const action = btn.dataset.action;
      const postId = card.dataset.postId;
      const platform = card.dataset.platform;
      const accountId = card.dataset.accountId;

      // Overflow menu toggle (no per-action handling)
      if (action === 'more') {
        const actions = btn.closest('.post-actions');
        const menu = actions?.querySelector('.post-action-overflow');
        if (!menu) return;
        const willOpen = menu.hasAttribute('hidden');
        // Close any other open overflow menus first
        document.querySelectorAll('.post-action-overflow:not([hidden])').forEach(m => {
          m.setAttribute('hidden', '');
          const trig = m.parentElement?.querySelector('[data-action="more"]');
          if (trig) trig.setAttribute('aria-expanded', 'false');
        });
        if (willOpen) {
          menu.removeAttribute('hidden');
          btn.setAttribute('aria-expanded', 'true');
        }
        return;
      }

      // Close overflow menu after selecting an item
      if (overflowBtn) {
        const menu = overflowBtn.closest('.post-action-overflow');
        if (menu) {
          menu.setAttribute('hidden', '');
          const trig = menu.parentElement?.querySelector('[data-action="more"]');
          if (trig) trig.setAttribute('aria-expanded', 'false');
        }
      }

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
      } else if (action === 'bookmark') {
        this.handlePostAction('bookmark', postId, platform, accountId, btn);
      } else if (action === 'pin') {
        this.handlePostAction('pin', postId, platform, accountId, btn);
      } else if (action === 'edit') {
        this.openEditModal(postId, platform, accountId);
      } else if (action === 'delete') {
        this.handleDeletePost(postId, platform, accountId, btn);
      }
    });

    // Close overflow menu on outside click / Esc
    document.addEventListener('click', (e) => {
      if (e.target.closest('.post-action-overflow') || e.target.closest('[data-action="more"]')) return;
      document.querySelectorAll('.post-action-overflow:not([hidden])').forEach(m => {
        m.setAttribute('hidden', '');
        const trig = m.parentElement?.querySelector('[data-action="more"]');
        if (trig) trig.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelectorAll('.post-action-overflow:not([hidden])');
      if (!open.length) return;
      open.forEach(m => {
        m.setAttribute('hidden', '');
        const trig = m.parentElement?.querySelector('[data-action="more"]');
        if (trig) trig.setAttribute('aria-expanded', 'false');
      });
    });

    // Poll vote button
    document.addEventListener('click', (e) => {
      const voteBtn = e.target.closest('.poll-vote-btn');
      if (!voteBtn) return;
      e.stopPropagation();
      const pollEl = voteBtn.closest('.post-poll');
      if (pollEl) this.handleVotePoll(pollEl);
    });

    // Follow request accept/reject buttons
    document.addEventListener('click', (e) => {
      const reqBtn = e.target.closest('.follow-req-btn');
      if (!reqBtn) return;
      e.stopPropagation();
      e.preventDefault();
      const action = reqBtn.dataset.action;
      const actorId = reqBtn.dataset.actorId;
      const accountId = reqBtn.dataset.accountId;
      const platform = reqBtn.dataset.platform;
      if (action && actorId && accountId) {
        this.handleFollowRequest(action, actorId, accountId, platform, reqBtn);
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
      if (e.target.closest('.notif-avatar') || e.target.closest('.post-avatar') || e.target.closest('[data-lightbox]') || e.target.closest('.expand-toggle') || e.target.closest('.notif-action-btn') || e.target.closest('.post-action') || e.target.closest('.cw-toggle') || e.target.closest('.post-action-overflow') || e.target.closest('.sensitive-reveal') || e.target.closest('.sensitive-hide') || e.target.closest('.link-card') || e.target.closest('.reaction-badge') || e.target.closest('.post-media')) return;
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
      if (e.target.closest('.post-action, .reaction-badge, a, button, [data-lightbox], .expand-toggle, .cw-toggle, .post-action-overflow, .post-media, img')) return;
      const card = e.target.closest('.post-card');
      if (!card) return;
      const inThreadModal = card.closest('.modal .thread-content');
      const platform = card.dataset.platform;
      const accountId = card.dataset.accountId;
      if (!platform || !accountId) return;
      const columnType = card.closest('.column')?.dataset.columnType;

      // Inside thread modal: allow quote-post clicks to navigate, block same-post clicks
      const quotePart = e.target.closest('.quote-post');
      if (quotePart && quotePart.dataset.quoteId) {
        this.openThreadView(quotePart.dataset.quoteId, platform, accountId, { columnType });
        return;
      }

      // Block non-quote clicks inside the thread modal (clicking the same post again)
      if (inThreadModal) return;

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
      // Collect all lightbox images in the same media container
      const mediaContainer = img.closest('.post-media, .reply-context-media');
      const allImages = mediaContainer
        ? [...mediaContainer.querySelectorAll('img[data-lightbox="true"]')]
        : [img];
      const mediaList = allImages.map(i => ({
        url: i.dataset.fullUrl || i.src,
        previewUrl: i.src,
        thumb: i,
      }));
      const index = allImages.indexOf(img);
      this.openLightbox(mediaList, Math.max(index, 0));
    });

    // Lightbox close
    this.lightboxClose.addEventListener('click', () => this.closeLightbox());
    this.lightbox.addEventListener('click', (e) => {
      if (e.target === this.lightbox || e.target === this.lightboxImg) {
        this.closeLightbox();
      }
    });

    // Lightbox nav buttons
    this.lightboxPrev.addEventListener('click', (e) => { e.stopPropagation(); this.navigateLightbox(-1); });
    this.lightboxNext.addEventListener('click', (e) => { e.stopPropagation(); this.navigateLightbox(1); });

    // Lightbox swipe
    this._bindLightboxSwipe();
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
    this.btnComposeSubmit.addEventListener('click', () => {
      if (this.btnComposeSubmit.disabled) return;
      this.btnComposeSubmit.disabled = true;
      this.handleComposeSubmit();
    });
    this.composeText.addEventListener('input', () => this._updateComposeWordCount());

    // Inline emoji autocomplete on ':' trigger
    this.composeText.addEventListener('input', () => this._handleEmojiAutocomplete());

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
    this.composeEditor.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.composeEditor.classList.remove('drag-over');
      try {
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        for (const file of files) {
          if (this.composeFiles.length >= 4) break;
          const compressed = await compressImage(file);
          this.composeFiles.push(compressed);
        }
        if (files.length > 0) this.renderComposeImagePreview();
      } catch (err) {
        console.error('Image drop error:', err);
        this.showToast('이미지 첨부에 실패했습니다');
      }
    });

    // Cmd/Ctrl+Enter to submit + emoji autocomplete keyboard navigation
    this.composeText.addEventListener('keydown', (e) => {
      // Emoji autocomplete keyboard navigation
      if (this._isEmojiAutocompleteOpen()) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this._navigateEmojiAutocomplete(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this._navigateEmojiAutocomplete(-1);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const idx = this._emojiAutocompleteIndex ?? 0;
          this._selectEmojiAutocomplete(idx);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this._closeEmojiAutocomplete();
          return;
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (this.btnComposeSubmit.disabled) return;
        this.btnComposeSubmit.disabled = true;
        this.handleComposeSubmit();
      }
    });

    // Paste image from clipboard
    this.composeText.addEventListener('paste', async (e) => {
      try {
        const items = Array.from(e.clipboardData?.items || []);
        const imageFiles = items
          .filter(item => item.type.startsWith('image/'))
          .map(item => item.getAsFile())
          .filter(Boolean);
        if (imageFiles.length > 0) {
          for (const file of imageFiles) {
            if (this.composeFiles.length >= 4) break;
            const compressed = await compressImage(file);
            this.composeFiles.push(compressed);
          }
          this.renderComposeImagePreview();
        }
      } catch (err) {
        console.error('Image paste error:', err);
        this.showToast('이미지 붙여넣기에 실패했습니다');
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

    // Infinite scroll (timeline + notifications) — rAF-throttled so the layout
    // reads (scrollHeight/scrollTop/clientHeight) don't fire on every pixel.
    const pendingScrollTargets = new Set();
    let scrollRafScheduled = false;
    const processScrollTargets = () => {
      scrollRafScheduled = false;
      for (const columnContent of pendingScrollTargets) {
        if (!columnContent.isConnected) continue;
        const distFromBottom = columnContent.scrollHeight - columnContent.scrollTop - columnContent.clientHeight;
        if (distFromBottom < 300) {
          const column = columnContent.closest('.column');
          if (column && column.dataset.columnType === 'notifications') {
            this.loadOlderNotifications(columnContent);
          } else {
            this.loadOlderPosts(columnContent);
          }
        }
      }
      pendingScrollTargets.clear();
    };
    this.columnsContainer.addEventListener('scroll', (e) => {
      const columnContent = e.target;
      if (!columnContent.classList?.contains('column-content')) return;
      pendingScrollTargets.add(columnContent);
      if (!scrollRafScheduled) {
        scrollRafScheduled = true;
        requestAnimationFrame(processScrollTargets);
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

    // Pin thread as column button
    document.getElementById('btn-pin-thread').addEventListener('click', () => {
      this.pinThreadAsColumn();
    });

    // Column close/refresh buttons
    this.columnsContainer.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-action="close-column"]');
      if (closeBtn) {
        const colType = closeBtn.dataset.columnType;
        const accountId = closeBtn.dataset.accountId;

        // Thread columns use unpinThreadColumn
        if (colType === 'thread') {
          const col = closeBtn.closest('.column');
          const threadKey = col?.dataset.threadKey;
          if (threadKey) this.unpinThreadColumn(threadKey);
          return;
        }

        const orderKey = colType === 'account' ? `account:${accountId}` : colType;
        if (colType === 'all') {
          this.columnState.all = false;
        } else if (colType === 'notifications') {
          this.columnState.notifications = false;
        } else if (colType === 'pages') {
          this.columnState.pages = false;
        } else if (colType === 'bookmarks') {
          this.columnState.bookmarks = false;
        } else if (colType === 'dm') {
          this.columnState.dm = false;
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

      const addPageBtn = e.target.closest('[data-action="add-page"]');
      if (addPageBtn) {
        this._showNewPageAccountPicker();
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

    // Double-click/tap column header: scroll that column to top
    this.columnsContainer.addEventListener('dblclick', (e) => {
      const header = e.target.closest('.column-header');
      if (!header || e.target.closest('button')) return;
      const col = header.closest('.column');
      const content = col?.querySelector('.column-content');
      if (content) content.scrollTo({ top: 0, behavior: 'smooth' });
    });
    // Touch double-tap support for column headers (dblclick doesn't fire on mobile)
    let lastColTap = 0, lastColTarget = null;
    this.columnsContainer.addEventListener('touchend', (e) => {
      const header = e.target.closest('.column-header');
      if (!header || e.target.closest('button')) return;
      const now = Date.now();
      if (now - lastColTap < 350 && lastColTarget === header) {
        e.preventDefault();
        const col = header.closest('.column');
        const content = col?.querySelector('.column-content');
        if (content) content.scrollTo({ top: 0, behavior: 'smooth' });
        lastColTap = 0;
        lastColTarget = null;
      } else {
        lastColTap = now;
        lastColTarget = header;
      }
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

      // Arrow keys: navigate lightbox images when open
      if (this._lightboxMedia && this._lightboxMedia.length > 1 && this.lightbox.style.display !== 'none') {
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.navigateLightbox(-1); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); this.navigateLightbox(1); return; }
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
    if (typeof this._renderPagerDots === 'function') this._renderPagerDots();
  },

  // Get the account ID of the currently focused column (null if 'all' or 'notifications')
  getFocusedColumnAccountId() {
    const columns = this.columnsContainer.querySelectorAll('.column');
    const focused = columns[this.focusedColumnIndex];
    if (!focused) return null;
    if (focused.dataset.columnType === 'account') return focused.dataset.accountId || null;
    return null;
  },

  _scrollAllColumnsToTop() {
    const columns = this.columnsContainer.querySelectorAll('.column');
    for (const col of columns) {
      const content = col.querySelector('.column-content');
      if (content) content.scrollTo({ top: 0, behavior: 'smooth' });
    }
  },

  // ===== Lightbox =====

  openLightbox(mediaList, index) {
    // mediaList: [{ url, previewUrl?, thumb }, ...]  index: which to show first
    this._lightboxMedia = mediaList;
    this._lightboxIndex = index || 0;
    const item = mediaList[this._lightboxIndex];
    this._lightboxSourceImg = item.thumb || null;

    // Progressive loading: show preview instantly, then swap to full image
    const preview = item.previewUrl || item.thumb?.src;
    if (preview && preview !== item.url) {
      this.lightboxImg.src = preview;
      this.lightboxImg.classList.add('lb-loading');
      this._loadFullImage(item.url);
    } else {
      this.lightboxImg.src = item.url;
    }
    this.lightbox.style.display = 'flex';

    // Animate from source thumbnail position
    if (item.thumb) {
      const rect = item.thumb.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      this.lightboxImg.style.transformOrigin = `${cx}px ${cy}px`;
      this.lightboxImg.classList.remove('lb-enter', 'lb-exit', 'lb-slide-left', 'lb-slide-right');
      void this.lightboxImg.offsetWidth;
      this.lightboxImg.classList.add('lb-enter');
    }

    this._updateLightboxNav();
    requestAnimationFrame(() => this.lightbox.classList.add('visible'));
  },

  // Load full-resolution image and swap when ready
  _loadFullImage(fullUrl) {
    if (this._fullImageLoader) {
      this._fullImageLoader.onload = null;
      this._fullImageLoader.onerror = null;
    }
    const loader = new Image();
    this._fullImageLoader = loader;
    loader.onload = () => {
      // Only swap if lightbox is still showing and index hasn't changed
      if (this.lightbox.style.display === 'flex' && loader === this._fullImageLoader) {
        this.lightboxImg.src = fullUrl;
        this.lightboxImg.classList.remove('lb-loading');
      }
    };
    loader.onerror = () => {
      this.lightboxImg.classList.remove('lb-loading');
    };
    loader.src = fullUrl;
    if (loader.complete) {
      this.lightboxImg.src = fullUrl;
      this.lightboxImg.classList.remove('lb-loading');
    }
  },

  navigateLightbox(direction) {
    if (!this._lightboxMedia || this._lightboxMedia.length <= 1) return;
    if (this._lightboxTransitioning) return;
    const newIndex = this._lightboxIndex + direction;
    if (newIndex < 0 || newIndex >= this._lightboxMedia.length) return;

    this._lightboxTransitioning = true;
    this._lightboxIndex = newIndex;
    const item = this._lightboxMedia[newIndex];
    this._lightboxSourceImg = item.thumb || null;

    // Snapshot the current image as a static backdrop
    const oldClone = this.lightboxImg.cloneNode(true);
    oldClone.removeAttribute('id');
    oldClone.className = 'lb-old-image';
    this.lightboxImg.parentNode.insertBefore(oldClone, this.lightboxImg);

    // Animate old image out
    const outClass = direction > 0 ? 'lb-exit-left' : 'lb-exit-right';
    void oldClone.offsetWidth;
    oldClone.classList.add(outClass);

    // Progressive: show preview immediately, then load full in background
    const preview = item.previewUrl || item.thumb?.src;
    const showSrc = (preview && preview !== item.url) ? preview : item.url;
    const doTransition = () => {
      this.lightboxImg.src = showSrc;
      this.lightboxImg.classList.remove('lb-enter', 'lb-exit', 'lb-slide-left', 'lb-slide-right', 'lb-loading');
      void this.lightboxImg.offsetWidth;
      this.lightboxImg.classList.add(direction > 0 ? 'lb-slide-left' : 'lb-slide-right');
      // Load full image in background after transition starts
      if (showSrc !== item.url) {
        this.lightboxImg.classList.add('lb-loading');
        this._loadFullImage(item.url);
      }
    };
    // Preload the preview/full image for smooth transition
    const preloader = new Image();
    preloader.onload = doTransition;
    preloader.onerror = doTransition;
    preloader.src = showSrc;
    if (preloader.complete) doTransition();

    // Clean up after transition
    const cleanup = () => {
      oldClone.remove();
      this._lightboxTransitioning = false;
    };
    oldClone.addEventListener('animationend', cleanup);
    setTimeout(cleanup, 350); // fallback

    this._updateLightboxNav();
  },

  _updateLightboxNav() {
    const count = this._lightboxMedia ? this._lightboxMedia.length : 0;
    const hasMultiple = count > 1;

    this.lightboxPrev.classList.toggle('visible', hasMultiple && this._lightboxIndex > 0);
    this.lightboxNext.classList.toggle('visible', hasMultiple && this._lightboxIndex < count - 1);

    if (hasMultiple) {
      this.lightboxCounter.textContent = `${this._lightboxIndex + 1} / ${count}`;
      this.lightboxCounter.classList.add('visible');
    } else {
      this.lightboxCounter.classList.remove('visible');
    }
  },

  _bindLightboxSwipe() {
    let startX = 0, startY = 0, tracking = false;

    this.lightbox.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });

    this.lightbox.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      // Allow vertical scroll but prevent horizontal page scroll during swipe
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx > dy && dx > 10) {
        e.preventDefault();
      }
    }, { passive: false });

    this.lightbox.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const dx = endX - startX;
      const dy = Math.abs(endY - startY);

      // Only treat as swipe if horizontal distance > 50px and more horizontal than vertical
      if (Math.abs(dx) > 50 && Math.abs(dx) > dy) {
        if (dx < 0) {
          this.navigateLightbox(1); // swipe left → next
        } else {
          this.navigateLightbox(-1); // swipe right → prev
        }
      }
    }, { passive: true });
  },

  closeLightbox() {
    this.lightbox.classList.remove('visible');
    this.lightboxImg.classList.remove('lb-enter', 'lb-slide-left', 'lb-slide-right', 'lb-loading');
    this.lightboxImg.classList.add('lb-exit');
    // Cancel any in-flight full image load
    if (this._fullImageLoader) {
      this._fullImageLoader.onload = null;
      this._fullImageLoader.onerror = null;
      this._fullImageLoader = null;
    }
    // Remove any lingering old-image clones
    this.lightbox.querySelectorAll('.lb-old-image').forEach(el => el.remove());
    this._lightboxTransitioning = false;
    const onDone = () => {
      this.lightboxImg.removeEventListener('animationend', onDone);
      this.lightbox.style.display = 'none';
      this.lightboxImg.src = '';
      this.lightboxImg.classList.remove('lb-exit');
      this.lightboxImg.style.transformOrigin = '';
      this._lightboxSourceImg = null;
      this._lightboxMedia = null;
      this._lightboxIndex = 0;
      this.lightboxPrev.classList.remove('visible');
      this.lightboxNext.classList.remove('visible');
      this.lightboxCounter.classList.remove('visible');
    };
    this.lightboxImg.addEventListener('animationend', onDone);
    // Fallback if animation doesn't fire
    setTimeout(onDone, 200);
  },
};
