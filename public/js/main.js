/**
 * StarShip - Main Application
 * Fediverse multi-account dashboard for Misskey, Iceshrimp, CherryPick, and Mastodon.
 */
import { AccountStore } from './accounts.js';
import { renderPost, renderNotification, renderAccountCard, renderLoading, renderLoadingText, createColumn } from './ui/dashboard.js';
import { startMastodonOAuth, startMiAuth, waitForAuthCallback, clearPendingAuth } from './auth.js';

class StarShipApp {
  constructor() {
    this.store = new AccountStore();
    this.autoRefreshTimer = null;
    this.AUTO_REFRESH_INTERVAL = 60000;

    // Column management
    this.columns = []; // { id, type, title, accountId? }
    this.postMap = new Map(); // `${platform}_${id}` → post (with _seenBy)
    this.focusedColumnIndex = -1;

    // Compose
    this.composeImages = []; // File objects
    this.replyContext = null; // { post }

    // Action picker
    this.activeActionPicker = null;

    this.initElements();
    this.bindEvents();
    this.render();
    this.startAutoRefresh();
  }

  initElements() {
    this.btnAddAccount = document.getElementById('btn-add-account');
    this.btnRefreshAll = document.getElementById('btn-refresh-all');
    this.btnCompose = document.getElementById('btn-compose');
    this.btnAddColumn = document.getElementById('btn-add-column');
    this.accountTabs = document.getElementById('account-tabs');
    this.emptyState = document.getElementById('empty-state');
    this.columnsContainer = document.getElementById('columns-container');

    // Modal: Add account
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

    // Modal: Compose
    this.modalCompose = document.getElementById('modal-compose');
    this.composeText = document.getElementById('compose-text');
    this.composeCw = document.getElementById('compose-cw');
    this.composeAccounts = document.getElementById('compose-accounts');
    this.composeCount = document.getElementById('compose-count');
    this.btnComposeSubmit = document.getElementById('btn-compose-submit');
    this.composeError = document.getElementById('compose-error');
    this.composeImagesContainer = document.getElementById('compose-images');
    this.composeFileInput = document.getElementById('compose-file-input');
    this.btnComposeAddImage = document.getElementById('btn-compose-add-image');
    this.composeReplyContainer = document.getElementById('compose-reply-container');

    // Modal: Add column
    this.modalAddColumn = document.getElementById('modal-add-column');
  }

  bindEvents() {
    // Open modals
    this.btnAddAccount.addEventListener('click', () => this.openAddAccountModal());
    this.btnAddFirst?.addEventListener('click', () => this.openAddAccountModal());
    this.btnCompose?.addEventListener('click', () => this.openComposeModal());
    this.btnAddColumn?.addEventListener('click', () => this.openAddColumnModal());

    // Refresh
    this.btnRefreshAll.addEventListener('click', () => this.refreshAll());

    // Modal close
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.closeModal;
        document.getElementById(modalId).style.display = 'none';
      });
    });

    // Close modal on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.style.display = 'none';
      });
    });

    // Platform select
    this.platformSelect.addEventListener('change', () => {
      this.updateTokenHint();
      this.updateOAuthButton();
    });
    this.instanceUrl.addEventListener('input', () => this.updateOAuthButton());

    // OAuth login
    this.btnOAuthLogin.addEventListener('click', () => this.handleOAuthLogin());

    // Manual token add
    this.btnConfirmAdd.addEventListener('click', () => this.handleAddAccount());

    // Compose text counter
    this.composeText?.addEventListener('input', () => {
      if (this.composeCount) {
        this.composeCount.textContent = this.composeText.value.length;
      }
    });
    this.btnComposeSubmit?.addEventListener('click', () => this.handleCompose());

    // Compose image upload
    this.btnComposeAddImage?.addEventListener('click', () => this.composeFileInput?.click());
    this.composeFileInput?.addEventListener('change', (e) => this.handleComposeImageSelect(e));

    // Tab clicks (delegated)
    this.accountTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab-toggle');
      if (!tab) return;
      this.handleTabClick(tab);
    });

    // CW toggle (delegated)
    document.addEventListener('click', (e) => {
      if (e.target.matches('.cw-toggle')) {
        const target = document.getElementById(e.target.dataset.cwTarget);
        if (target) target.classList.toggle('visible');
        e.target.textContent = target?.classList.contains('visible') ? '숨기기' : '내용 보기';
      }
    });

    // Post action: open link (delegated)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.post-action[data-action="open"]');
      if (!btn) return;
      const card = btn.closest('.post-card');
      if (!card) return;
      const postUrl = this.findPostUrl(card.dataset.postId, card.dataset.platform);
      if (postUrl) window.open(postUrl, '_blank', 'noopener');
    });

    // Post actions: reply, boost, fav (delegated)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.post-action[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'open') return; // handled above

      const card = btn.closest('.post-card');
      if (!card) return;
      this.handlePostAction(card.dataset.postId, card.dataset.platform, action, btn);
    });

    // Column close button (delegated)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="close-column"]');
      if (!btn) return;
      const column = btn.closest('.column');
      if (!column) return;
      this.removeColumn(column.dataset.columnId);
    });

    // Column refresh buttons (delegated)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="refresh-column"]');
      if (!btn) return;
      const column = btn.closest('.column');
      if (!column) return;
      const colData = this.columns.find(c => c.id === column.dataset.columnId);
      if (!colData) return;
      if (colData.type === 'timeline') this.loadTimelineForColumn(colData.id, colData.accountId);
      if (colData.type === 'notifications') this.loadNotificationsForColumn(colData.id, colData.accountId);
      if (colData.type === 'accounts') this.renderAccountsColumn(colData.id);
    });

    // Double-click on column header → scroll to top
    document.addEventListener('dblclick', (e) => {
      const header = e.target.closest('.column-header');
      if (!header) return;
      const column = header.closest('.column');
      if (!column) return;
      const content = column.querySelector('.column-content');
      if (content) content.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // Image lightbox (delegated)
    document.addEventListener('click', (e) => {
      const img = e.target.closest('.lightbox-trigger');
      if (!img) return;
      e.preventDefault();
      e.stopPropagation();
      this.openLightbox(img.dataset.lightboxSrc || img.src);
    });

    // Close action picker on outside click
    document.addEventListener('mousedown', (e) => {
      if (this.activeActionPicker && !e.target.closest('.action-picker') && !e.target.closest('.post-action')) {
        this.closeActionPicker();
      }
    });

    // Horizontal wheel scroll on columns container
    this.columnsContainer.addEventListener('wheel', (e) => {
      // Only convert vertical scroll to horizontal when not over scrollable column content
      const columnContent = e.target.closest('.column-content');
      if (columnContent) return; // let column content scroll vertically normally
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        this.columnsContainer.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Arrow key navigation between columns
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
        this.closeLightbox();
        this.closeActionPicker();
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Don't navigate if modal is open or input is focused
        if (document.querySelector('.modal-overlay[style*="flex"]')) return;
        if (document.querySelector('.lightbox-overlay')) return;
        if (document.activeElement?.matches('input, textarea, select')) return;

        const columns = this.columnsContainer.querySelectorAll('.column');
        if (columns.length === 0) return;

        e.preventDefault();
        if (e.key === 'ArrowRight') {
          this.focusedColumnIndex = Math.min(this.focusedColumnIndex + 1, columns.length - 1);
        } else {
          this.focusedColumnIndex = Math.max(this.focusedColumnIndex - 1, 0);
        }

        columns.forEach(c => c.classList.remove('column-focused'));
        columns[this.focusedColumnIndex]?.classList.add('column-focused');
        columns[this.focusedColumnIndex]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    });
  }

  // ===== Column Management =====

  setupDefaultColumns() {
    this.columns = [];
    this.columnsContainer.innerHTML = '';
    // Default: timeline + notifications (both closable)
    this.addColumn('timeline', '타임라인', null);
    this.addColumn('notifications', '알림', null);
  }

  addColumn(type, title, accountId = null) {
    const id = `col-${type}-${accountId || 'all'}-${Date.now()}`;
    const col = { id, type, title, accountId };
    this.columns.push(col);

    const el = createColumn(id, title, { closable: true, refreshable: type !== 'accounts' });
    this.columnsContainer.appendChild(el);

    // Scroll new column into view
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', inline: 'end', block: 'nearest' }), 50);

    // Load data
    if (type === 'timeline') this.loadTimelineForColumn(id, accountId);
    if (type === 'notifications') this.loadNotificationsForColumn(id, accountId);
    if (type === 'accounts') this.renderAccountsColumn(id);

    this.renderTabs();
    return id;
  }

  removeColumn(columnId) {
    const idx = this.columns.findIndex(c => c.id === columnId);
    if (idx >= 0) this.columns.splice(idx, 1);
    const el = document.getElementById(columnId);
    if (el) el.remove();
    this.renderTabs();
  }

  toggleColumn(type, accountId = null) {
    const existing = this.columns.find(c => c.type === type && c.accountId === accountId);
    if (existing) {
      this.removeColumn(existing.id);
    } else {
      const title = this.getColumnTitle(type, accountId);
      this.addColumn(type, title, accountId);
    }
  }

  getColumnTitle(type, accountId) {
    if (type === 'timeline' && !accountId) return '타임라인';
    if (type === 'notifications') return '알림';
    if (accountId) {
      const acct = this.store.getById(accountId);
      return acct?.label || acct?.profile?.displayName || '?';
    }
    return type;
  }

  // ===== Tab Bar =====

  renderTabs() {
    this.accountTabs.innerHTML = '';

    // "전체" toggle
    const hasMainTimeline = this.columns.some(c => c.type === 'timeline' && !c.accountId);
    const allTab = document.createElement('button');
    allTab.className = `tab-toggle ${hasMainTimeline ? 'active' : ''}`;
    allTab.dataset.tabAction = 'toggle-timeline';
    allTab.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg> 전체`;
    this.accountTabs.appendChild(allTab);

    // "알림" toggle
    const hasNotifications = this.columns.some(c => c.type === 'notifications' && !c.accountId);
    const notifTab = document.createElement('button');
    notifTab.className = `tab-toggle ${hasNotifications ? 'active' : ''}`;
    notifTab.dataset.tabAction = 'toggle-notifications';
    notifTab.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg> 알림`;
    this.accountTabs.appendChild(notifTab);

    // Separator
    const accounts = this.store.getAll();
    if (accounts.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'tab-separator';
      this.accountTabs.appendChild(sep);
    }

    // Per-account toggles
    for (const account of accounts) {
      const hasColumn = this.columns.some(c => c.type === 'timeline' && c.accountId === account.id);
      const tab = document.createElement('button');
      tab.className = `tab-toggle ${hasColumn ? 'active' : ''} ${account.platform}`;
      tab.dataset.tabAction = 'toggle-account';
      tab.dataset.accountId = account.id;
      tab.innerHTML = `<span class="tab-dot" style="background: var(--accent-${account.platform})"></span>${this.escapeHtml(account.label || account.profile.displayName)}`;
      this.accountTabs.appendChild(tab);
    }
  }

  handleTabClick(tab) {
    const action = tab.dataset.tabAction;
    if (!action) return;

    if (action === 'toggle-timeline') {
      this.toggleColumn('timeline', null);
    } else if (action === 'toggle-notifications') {
      this.toggleColumn('notifications', null);
    } else if (action === 'toggle-account') {
      this.toggleColumn('timeline', tab.dataset.accountId);
    }
  }

  // ===== Rendering =====

  render() {
    const hasAccounts = !this.store.isEmpty();
    this.emptyState.style.display = hasAccounts ? 'none' : 'flex';
    this.columnsContainer.style.display = hasAccounts ? 'flex' : 'none';

    this.renderTabs();

    if (hasAccounts) {
      if (this.columns.length === 0) {
        this.setupDefaultColumns();
      }
      this.refreshAll();
    } else {
      this.columns = [];
      this.columnsContainer.innerHTML = '';
    }
  }

  renderAccountsColumn(columnId) {
    const col = document.getElementById(columnId);
    if (!col) return;
    const content = col.querySelector('.column-content');
    if (!content) return;

    content.innerHTML = '';
    const accounts = this.store.getAll();

    if (accounts.length === 0) {
      content.innerHTML = '<div class="loading-text">연결된 계정이 없습니다.</div>';
      return;
    }

    for (const account of accounts) {
      const card = renderAccountCard(account, (id) => {
        this.store.removeAccount(id);
        this.render();
      });
      content.appendChild(card);
    }
  }

  // ===== Data Loading =====

  async refreshAll() {
    const promises = [];
    for (const col of this.columns) {
      if (col.type === 'timeline') {
        promises.push(this.loadTimelineForColumn(col.id, col.accountId));
      } else if (col.type === 'notifications') {
        promises.push(this.loadNotificationsForColumn(col.id, col.accountId));
      } else if (col.type === 'accounts') {
        this.renderAccountsColumn(col.id);
      }
    }
    await Promise.all(promises);
  }

  async loadTimelineForColumn(columnId, accountId = null) {
    const col = document.getElementById(columnId);
    if (!col) return;
    const content = col.querySelector('.column-content');
    if (!content) return;

    // For specific account, get only that account. For "all", get all accounts.
    const accounts = accountId
      ? [this.store.getById(accountId)].filter(Boolean)
      : this.store.getAll();

    if (accounts.length === 0) {
      if (!content.querySelector('.post-card')) {
        content.innerHTML = '';
        content.appendChild(renderLoadingText('표시할 타임라인이 없습니다.'));
      }
      return;
    }

    const isFirstLoad = !content.querySelector('.post-card');
    if (isFirstLoad) {
      content.innerHTML = '';
      content.appendChild(renderLoading());
    }

    try {
      const allPosts = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];

          if (client.fetchEmojis) {
            await client.fetchEmojis();
          }

          const timeline = await client.getHomeTimeline(30);
          const posts = timeline.map(item => client.normalizePost(item));

          for (const post of posts) {
            post._seenBy = [{
              accountId: account.id,
              platform: account.platform,
              avatarUrl: account.profile.avatarUrl,
              label: account.label || account.profile.displayName,
              postId: post.id,
            }];
          }

          return posts;
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allPosts.push(...result.value);
        }
      }

      // Sort by date descending
      allPosts.sort((a, b) => b.createdAt - a.createdAt);

      // Deduplicate: merge posts with same content URI
      const seen = new Map();
      const uniquePosts = [];
      for (const post of allPosts) {
        const originalUri = post.reblog ? (post.reblog.uri || post.reblog.url) : null;
        const selfUri = post.uri || post.url;
        const key = originalUri || selfUri;

        if (!key) {
          uniquePosts.push(post);
          continue;
        }

        const existing = seen.get(key);
        if (existing) {
          if (post._seenBy) {
            existing._seenBy.push(...post._seenBy);
          }
          if (existing.reblog && !post.reblog) {
            post._seenBy = existing._seenBy;
            const idx = uniquePosts.indexOf(existing);
            if (idx >= 0) uniquePosts[idx] = post;
            seen.set(key, post);
          }
        } else {
          seen.set(key, post);
          uniquePosts.push(post);
          if (selfUri && selfUri !== key) {
            seen.set(selfUri, post);
          }
        }
      }

      // Update global post map for action lookups
      for (const post of uniquePosts) {
        const mapKey = `${post.platform}_${post.id}`;
        const existingPost = this.postMap.get(mapKey);
        if (existingPost && existingPost._seenBy) {
          // Merge seenBy from existing map entry
          const existingIds = new Set(existingPost._seenBy.map(s => s.accountId));
          for (const s of (post._seenBy || [])) {
            if (!existingIds.has(s.accountId)) {
              existingPost._seenBy.push(s);
            }
          }
          post._seenBy = existingPost._seenBy;
        }
        this.postMap.set(mapKey, post);
      }

      // Incremental update
      const existingIds = new Set();
      content.querySelectorAll('.post-card').forEach(el => {
        existingIds.add(`${el.dataset.platform}_${el.dataset.postId}`);
      });

      if (isFirstLoad || existingIds.size === 0) {
        content.innerHTML = '';
        if (uniquePosts.length === 0) {
          content.appendChild(renderLoadingText('타임라인에 표시할 게시물이 없습니다.'));
          return;
        }
        for (const post of uniquePosts) {
          content.appendChild(renderPost(post, false));
        }
      } else {
        const newPosts = uniquePosts.filter(p => !existingIds.has(`${p.platform}_${p.id}`));
        if (newPosts.length > 0) {
          const fragment = document.createDocumentFragment();
          for (const post of newPosts.reverse()) {
            fragment.prepend(renderPost(post, true));
          }
          content.prepend(fragment);

          setTimeout(() => {
            content.querySelectorAll('.post-new').forEach(el => {
              el.classList.remove('post-new');
            });
          }, 500);
        }
      }
    } catch (err) {
      console.error('Timeline load error:', err);
      if (isFirstLoad) {
        content.innerHTML = `<div class="loading-text">타임라인을 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
      }
    }
  }

  async loadNotificationsForColumn(columnId, accountId = null) {
    const col = document.getElementById(columnId);
    if (!col) return;
    const content = col.querySelector('.column-content');
    if (!content) return;

    const accounts = accountId
      ? [this.store.getById(accountId)].filter(Boolean)
      : this.store.getAll();

    if (accounts.length === 0) {
      if (!content.querySelector('.notif-card')) {
        content.innerHTML = '';
        content.appendChild(renderLoadingText('표시할 알림이 없습니다.'));
      }
      return;
    }

    const isFirstLoad = !content.querySelector('.notif-card');
    if (isFirstLoad) {
      content.innerHTML = '';
      content.appendChild(renderLoading());
    }

    try {
      const allNotifs = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];

          if (client.fetchEmojis) {
            await client.fetchEmojis();
          }

          const notifs = await client.getNotifications(30);
          return notifs.map(n => client.normalizeNotification(n));
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allNotifs.push(...result.value);
        }
      }

      allNotifs.sort((a, b) => b.createdAt - a.createdAt);

      const existingIds = new Set();
      content.querySelectorAll('.notif-card').forEach(el => {
        const id = el.dataset?.notifId;
        if (id) existingIds.add(id);
      });

      if (isFirstLoad || existingIds.size === 0) {
        content.innerHTML = '';
        if (allNotifs.length === 0) {
          content.appendChild(renderLoadingText('새 알림이 없습니다.'));
          return;
        }
        for (const notif of allNotifs) {
          const card = renderNotification(notif, false);
          card.dataset.notifId = `${notif.platform}_${notif.id}`;
          content.appendChild(card);
        }
      } else {
        const newNotifs = allNotifs.filter(n => !existingIds.has(`${n.platform}_${n.id}`));
        if (newNotifs.length > 0) {
          const fragment = document.createDocumentFragment();
          for (const notif of newNotifs.reverse()) {
            const card = renderNotification(notif, true);
            card.dataset.notifId = `${notif.platform}_${notif.id}`;
            fragment.prepend(card);
          }
          content.prepend(fragment);

          setTimeout(() => {
            content.querySelectorAll('.notif-new').forEach(el => {
              el.classList.remove('notif-new');
            });
          }, 500);
        }
      }
    } catch (err) {
      console.error('Notifications load error:', err);
      if (isFirstLoad) {
        content.innerHTML = `<div class="loading-text">알림을 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
      }
    }
  }

  findPostUrl(postId, platform) {
    const key = `${platform}_${postId}`;
    const post = this.postMap.get(key);
    return post?.url || null;
  }

  // ===== Post Actions =====

  handlePostAction(postId, platform, action, btnElement) {
    const key = `${platform}_${postId}`;
    const post = this.postMap.get(key);
    if (!post) return;

    const seenBy = post._seenBy || [];
    if (seenBy.length === 0) return;

    if (action === 'reply') {
      this.replyContext = { post };
      this.openComposeModal();
      return;
    }

    if (seenBy.length === 1) {
      this.performAction(seenBy[0], postId, platform, action, btnElement);
    } else {
      this.showActionPicker(seenBy, postId, platform, action, btnElement);
    }
  }

  async performAction(seenByEntry, postId, platform, action, btnElement) {
    const client = this.store.getClient(seenByEntry.accountId);
    if (!client) return;

    const noteId = seenByEntry.postId || postId;

    if (btnElement) {
      btnElement.classList.add('action-loading');
    }

    try {
      if (action === 'fav') {
        if (platform === 'mastodon') {
          await client.favourite(noteId);
        } else {
          await client.createReaction(noteId, '❤');
        }
        if (btnElement) btnElement.classList.add('done');
      } else if (action === 'boost') {
        if (platform === 'mastodon') {
          await client.reblog(noteId);
        } else {
          await client.renote(noteId);
        }
        if (btnElement) btnElement.classList.add('done');
      }
    } catch (err) {
      console.error(`Action ${action} failed:`, err);
    } finally {
      if (btnElement) btnElement.classList.remove('action-loading');
    }
  }

  showActionPicker(seenBy, postId, platform, action, anchorElement) {
    this.closeActionPicker();

    const picker = document.createElement('div');
    picker.className = 'action-picker';

    const actionLabels = {
      fav: '어느 계정으로 좋아요?',
      boost: '어느 계정으로 리노트/부스트?',
    };

    let html = `<div class="action-picker-title">${actionLabels[action] || '계정 선택'}</div>`;

    for (const entry of seenBy) {
      html += `<button class="action-picker-option" data-account-id="${entry.accountId}" data-post-id="${entry.postId || postId}">
        <img class="action-picker-avatar" src="${entry.avatarUrl || ''}" onerror="this.style.display='none'">
        <span class="action-picker-dot" style="background: var(--accent-${entry.platform})"></span>
        ${this.escapeHtml(entry.label)}
      </button>`;
    }

    picker.innerHTML = html;

    // Position near the button
    const rect = anchorElement.getBoundingClientRect();
    picker.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;
    picker.style.top = `${rect.bottom + 4}px`;

    document.body.appendChild(picker);
    this.activeActionPicker = picker;

    // Handle option clicks
    picker.addEventListener('click', (e) => {
      const option = e.target.closest('.action-picker-option');
      if (!option) return;

      const accountId = option.dataset.accountId;
      const optPostId = option.dataset.postId;
      const entry = seenBy.find(s => s.accountId === accountId);
      if (entry) {
        this.performAction(entry, optPostId, platform, action, anchorElement);
      }
      this.closeActionPicker();
    });
  }

  closeActionPicker() {
    if (this.activeActionPicker) {
      this.activeActionPicker.remove();
      this.activeActionPicker = null;
    }
  }

  // ===== Image Lightbox =====

  openLightbox(imageUrl) {
    this.closeLightbox();
    const overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    overlay.innerHTML = `
      <img src="${imageUrl}" alt="">
      <button class="lightbox-close">&times;</button>
    `;

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.classList.contains('lightbox-close')) {
        this.closeLightbox();
      }
    });

    document.body.appendChild(overlay);
  }

  closeLightbox() {
    document.querySelectorAll('.lightbox-overlay').forEach(el => el.remove());
  }

  // ===== Auto Refresh =====

  startAutoRefresh() {
    this.stopAutoRefresh();
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

  // ===== Compose =====

  openComposeModal() {
    if (!this.modalCompose) return;
    this.composeText.value = '';
    this.composeCw.value = '';
    this.composeImages = [];
    if (this.composeCount) this.composeCount.textContent = '0';
    if (this.composeError) this.composeError.style.display = 'none';
    if (this.composeImagesContainer) this.composeImagesContainer.innerHTML = '';

    // Reply context
    if (this.composeReplyContainer) {
      this.composeReplyContainer.innerHTML = '';
      if (this.replyContext) {
        const post = this.replyContext.post;
        const displayPost = post.reblog || post;
        this.composeReplyContainer.innerHTML = `
          <div class="compose-reply-context">
            <div class="compose-reply-info">
              <div class="compose-reply-author">${displayPost.author.displayNameHtml || this.escapeHtml(displayPost.author.displayName)}에게 답글</div>
              <div class="compose-reply-text">${displayPost.content}</div>
            </div>
            <button class="compose-reply-close" data-action="clear-reply">&times;</button>
          </div>
        `;
        // Clear reply handler
        this.composeReplyContainer.querySelector('[data-action="clear-reply"]')?.addEventListener('click', () => {
          this.replyContext = null;
          this.composeReplyContainer.innerHTML = '';
        });
        // Pre-fill @mention
        const acct = displayPost.author.acct;
        this.composeText.value = `@${acct} `;
      }
    }

    // Populate account checkboxes
    const accounts = this.store.getAll();
    this.composeAccounts.innerHTML = '';

    // If replying, filter to accounts that can see this post
    const replySeenBy = this.replyContext?.post?._seenBy;
    const availableAccountIds = replySeenBy ? new Set(replySeenBy.map(s => s.accountId)) : null;

    for (const account of accounts) {
      const isAvailable = !availableAccountIds || availableAccountIds.has(account.id);
      const label = document.createElement('label');
      label.className = 'compose-account-option';
      label.innerHTML = `
        <input type="checkbox" name="compose-account" value="${account.id}" ${isAvailable ? 'checked' : 'disabled'}>
        <img class="compose-account-avatar" src="${account.profile.avatarUrl || ''}" onerror="this.style.display='none'">
        <span class="compose-account-name">${this.escapeHtml(account.label || account.profile.displayName)}</span>
        <span class="platform-dot ${account.platform}"></span>
      `;
      this.composeAccounts.appendChild(label);
    }

    this.modalCompose.style.display = 'flex';
    this.composeText.focus();
    // Set cursor at end
    const len = this.composeText.value.length;
    this.composeText.setSelectionRange(len, len);
  }

  handleComposeImageSelect(e) {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      if (this.composeImages.length >= 4) break;
      if (!file.type.startsWith('image/')) continue;
      this.composeImages.push(file);
    }
    this.renderComposeImages();
    // Reset file input
    this.composeFileInput.value = '';
  }

  renderComposeImages() {
    if (!this.composeImagesContainer) return;
    this.composeImagesContainer.innerHTML = '';

    for (let i = 0; i < this.composeImages.length; i++) {
      const file = this.composeImages[i];
      const preview = document.createElement('div');
      preview.className = 'compose-image-preview';

      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.onload = () => URL.revokeObjectURL(img.src);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'compose-image-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.dataset.index = i;
      removeBtn.addEventListener('click', () => {
        this.composeImages.splice(i, 1);
        this.renderComposeImages();
      });

      preview.appendChild(img);
      preview.appendChild(removeBtn);
      this.composeImagesContainer.appendChild(preview);
    }
  }

  async handleCompose() {
    const text = this.composeText.value.trim();
    if (!text && this.composeImages.length === 0) {
      this.showComposeError('내용을 입력하거나 이미지를 추가하세요.');
      return;
    }

    const selectedAccounts = [];
    this.composeAccounts.querySelectorAll('input[name="compose-account"]:checked').forEach(cb => {
      const account = this.store.getById(cb.value);
      if (account) selectedAccounts.push(account);
    });

    if (selectedAccounts.length === 0) {
      this.showComposeError('게시할 계정을 선택하세요.');
      return;
    }

    const cw = this.composeCw.value.trim() || null;

    this.btnComposeSubmit.disabled = true;
    this.btnComposeSubmit.textContent = '게시 중...';
    if (this.composeError) this.composeError.style.display = 'none';

    try {
      const results = await Promise.allSettled(
        selectedAccounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) throw new Error('클라이언트를 찾을 수 없습니다.');

          // Upload images
          let mediaIds = [];
          if (this.composeImages.length > 0) {
            for (const file of this.composeImages) {
              if (account.platform === 'mastodon') {
                const result = await client.uploadMedia(file);
                mediaIds.push(result.id);
              } else {
                const result = await client.uploadFile(file);
                mediaIds.push(result.id);
              }
            }
          }

          // Determine replyId for this account
          let replyId = null;
          if (this.replyContext) {
            const seenBy = this.replyContext.post._seenBy || [];
            const entry = seenBy.find(s => s.accountId === account.id);
            if (entry) replyId = entry.postId;
          }

          if (account.platform === 'mastodon') {
            return client.createStatus(text, {
              cw,
              replyId,
              mediaIds: mediaIds.length > 0 ? mediaIds : undefined,
            });
          } else {
            return client.createNote(text, {
              cw,
              replyId,
              fileIds: mediaIds.length > 0 ? mediaIds : undefined,
            });
          }
        })
      );

      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        const msg = failures.map(f => f.reason?.message || '알 수 없는 오류').join(', ');
        this.showComposeError(`일부 계정에서 게시 실패: ${msg}`);
      } else {
        this.replyContext = null;
        this.modalCompose.style.display = 'none';
        setTimeout(() => this.refreshAll(), 1000);
      }
    } catch (err) {
      this.showComposeError(`게시 실패: ${err.message}`);
    } finally {
      this.btnComposeSubmit.disabled = false;
      this.btnComposeSubmit.textContent = '게시';
    }
  }

  showComposeError(message) {
    if (this.composeError) {
      this.composeError.textContent = message;
      this.composeError.style.display = 'block';
    }
  }

  // ===== Add Column Modal =====

  openAddColumnModal() {
    if (!this.modalAddColumn) return;
    const body = this.modalAddColumn.querySelector('.modal-body');
    if (!body) return;

    let html = '<div class="add-column-options">';

    html += '<h3 class="add-column-section">타임라인</h3>';
    html += `<button class="add-column-btn" data-add-column="timeline" data-column-title="전체 타임라인">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg>
      전체 타임라인
    </button>`;

    for (const account of this.store.getAll()) {
      html += `<button class="add-column-btn" data-add-column="timeline" data-account-id="${account.id}" data-column-title="${this.escapeHtml(account.label || account.profile.displayName)}">
        <span class="platform-dot ${account.platform}"></span>
        ${this.escapeHtml(account.label || account.profile.displayName)} 타임라인
      </button>`;
    }

    html += '<h3 class="add-column-section">알림</h3>';
    html += `<button class="add-column-btn" data-add-column="notifications" data-column-title="알림">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      전체 알림
    </button>`;

    html += '<h3 class="add-column-section">기타</h3>';
    html += `<button class="add-column-btn" data-add-column="accounts" data-column-title="계정 목록">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      계정 목록
    </button>`;

    html += '</div>';
    body.innerHTML = html;

    // Handle clicks
    body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-add-column]');
      if (!btn) return;
      const type = btn.dataset.addColumn;
      const accountId = btn.dataset.accountId || null;
      const title = btn.dataset.columnTitle || type;
      this.addColumn(type, title, accountId);
      this.modalAddColumn.style.display = 'none';
    }, { once: false });

    this.modalAddColumn.style.display = 'flex';
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
    document.getElementById('manual-token-section').removeAttribute('open');
    this.modalAddAccount.style.display = 'flex';
    this.platformSelect.focus();
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

  updateTokenHint() {
    const platform = this.platformSelect.value;
    const hints = {
      misskey: 'Misskey 인스턴스 → 설정 → API → 액세스 토큰 생성',
      iceshrimp: 'Iceshrimp 인스턴스 → 설정 → API → 액세스 토큰 생성',
      cherrypick: 'CherryPick 인스턴스 → 설정 → API → 액세스 토큰 생성',
      mastodon: 'Mastodon 인스턴스 → 설정 → 개발 → 새 애플리케이션 생성 후 액세스 토큰 복사',
    };
    this.tokenHint.textContent = hints[platform] || '인스턴스 설정에서 API 토큰을 생성하세요.';

    const placeholders = {
      misskey: 'https://misskey.io',
      iceshrimp: 'https://iceshrimp.example.com',
      cherrypick: 'https://cherrypick.example.com',
      mastodon: 'https://mastodon.social',
    };
    this.instanceUrl.placeholder = placeholders[platform] || 'https://example.com';
  }

  async handleOAuthLogin() {
    const platform = this.platformSelect.value;
    const instanceUrl = this.instanceUrl.value.trim();

    if (!platform) {
      this.showAddError('먼저 플랫폼을 선택하세요.');
      this.platformSelect.focus();
      return;
    }
    if (!instanceUrl) {
      this.showAddError('인스턴스 URL을 입력하세요. (예: https://misskey.io)');
      this.instanceUrl.focus();
      return;
    }

    try {
      new URL(instanceUrl);
    } catch {
      this.showAddError('올바른 URL 형식이 아닙니다. (예: https://misskey.io)');
      this.instanceUrl.focus();
      return;
    }

    this.btnOAuthLogin.disabled = true;
    this.btnOAuthLogin.textContent = '인증 페이지 여는 중...';
    this.addAccountError.style.display = 'none';

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
      this.modalAddAccount.style.display = 'none';
      this.render();
    } catch (err) {
      clearPendingAuth();
      this.showAddError(`인증 실패: ${err.message}`);
    } finally {
      this.btnOAuthLogin.disabled = false;
      this.updateOAuthButton();
    }
  }

  async handleAddAccount() {
    const platform = this.platformSelect.value;
    const instanceUrl = this.instanceUrl.value.trim();
    const accessToken = this.accessToken.value.trim();
    const label = this.accountLabel.value.trim();

    if (!platform) { this.showAddError('플랫폼을 선택하세요.'); return; }
    if (!instanceUrl) { this.showAddError('인스턴스 URL을 입력하세요.'); return; }
    if (!accessToken) { this.showAddError('액세스 토큰을 입력하세요.'); return; }

    try {
      new URL(instanceUrl);
    } catch {
      this.showAddError('올바른 URL 형식이 아닙니다. (예: https://misskey.io)');
      return;
    }

    this.btnConfirmAdd.disabled = true;
    this.btnConfirmAdd.textContent = '연결 확인 중...';
    this.addAccountError.style.display = 'none';

    try {
      await this.store.addAccount(platform, instanceUrl, accessToken, label);
      this.modalAddAccount.style.display = 'none';
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

  // ===== Helpers =====

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  const app = new StarShipApp();
  window.app = app;

  // 리다이렉트 방식 OAuth 콜백 처리
  const authResult = localStorage.getItem('starship_auth_result');
  if (authResult) {
    localStorage.removeItem('starship_auth_result');
    try {
      const result = JSON.parse(authResult);
      await app.store.addAccount(result.platform, result.instanceUrl, result.accessToken);
      app.render();
    } catch (err) {
      console.error('OAuth 콜백 처리 실패:', err);
    }
  }
});
