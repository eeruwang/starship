/**
 * Columns Mixin
 * Column rendering, toggle bar, column lifecycle, auto-refresh, modals, and toast.
 */
import { escapeHtml } from '../ui/utils.js';
import { iconRefresh, iconClose, timeAgo } from '../ui/dashboard.js';
import { watchColumnGrouping } from '../ui/author-grouping.js';

export const ColumnsMixin = {

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
    const pagesBtn = document.getElementById('btn-pages-header');
    if (pagesBtn) pagesBtn.style.display = (loggedIn && this.store.getPagesAccounts().length > 0) ? '' : 'none';

    // Ensure all accounts have a column state entry
    for (const account of this.store.getAll()) {
      if (!(account.id in this.columnState.accounts)) {
        this.columnState.accounts[account.id] = false; // Not shown by default
      }
    }
    this.saveColumnState();

    this.renderToggleBar();
    this.renderColumns();

    // Refresh account profiles in the background on initial load
    // so follower counts and display names stay up to date
    if (hasAccounts) {
      this.store.refreshAllProfiles().then(() => {
        this.renderToggleBar();
        this._refreshColumnHeaders();
      }).catch(() => {});
    }
  },

  renderToggleBar() {
    this.toggleBar.innerHTML = '';
    const accounts = this.store.getAll();

    const makeFilterBtn = (type, label, active) => {
      const b = document.createElement('button');
      b.className = active ? 'active' : '';
      b.dataset.toggleType = type;
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      b.textContent = label;
      return b;
    };

    // 필터 세그먼트 (전체/알림/북마크/DM/페이지)
    const filterSeg = document.createElement('div');
    filterSeg.className = 'filter-segment';
    filterSeg.setAttribute('role', 'group');
    filterSeg.setAttribute('aria-label', '필터');
    filterSeg.appendChild(makeFilterBtn('all', '전체', this.columnState.all));
    filterSeg.appendChild(makeFilterBtn('notifications', '알림', this.columnState.notifications));
    filterSeg.appendChild(makeFilterBtn('bookmarks', '북마크', this.columnState.bookmarks));
    filterSeg.appendChild(makeFilterBtn('dm', 'DM', this.columnState.dm));
    if (this.store.getPagesAccounts().length > 0) {
      filterSeg.appendChild(makeFilterBtn('pages', '페이지', this.columnState.pages));
    }
    this.toggleBar.appendChild(filterSeg);

    if (accounts.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'toggle-group-sep';
      this.toggleBar.appendChild(sep);

      // 계정 칩
      for (const account of accounts) {
        const toggle = document.createElement('button');
        const isActive = this.columnState.accounts[account.id] === true;
        const isHidden = !!account.hidden;
        toggle.className = `account-chip${isActive ? ' active' : ''}${isHidden ? ' account-hidden' : ''}`;
        toggle.dataset.toggleType = 'account';
        toggle.dataset.accountId = account.id;
        toggle.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        const avatarUrl = account.profile?.avatarUrl;
        const acColor = this._accountColor(account);
        const borderStyle = acColor ? `style="border-color:${acColor}"` : '';
        const avatarHtml = avatarUrl
          ? `<img class="account-chip-avatar" ${borderStyle} src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer" data-fb="hide">`
          : `<span class="account-chip-dot" style="background:${acColor || 'var(--text-muted)'}"></span>`;
        toggle.innerHTML = `${avatarHtml}${escapeHtml(account.label || account.profile.displayName)}`;
        this.toggleBar.appendChild(toggle);
      }
    }

    // 스레드 칩
    const threads = this.columnState.threads;
    if (threads && Object.keys(threads).length > 0) {
      const sep2 = document.createElement('div');
      sep2.className = 'toggle-group-sep';
      this.toggleBar.appendChild(sep2);

      for (const [threadKey, info] of Object.entries(threads)) {
        const toggle = document.createElement('button');
        toggle.className = 'account-chip active thread-toggle';
        toggle.dataset.toggleType = 'thread';
        toggle.dataset.threadKey = threadKey;
        toggle.setAttribute('aria-pressed', 'true');
        const cached = this.postCache.get(`${info.platform}:${info.postId}`);
        const label = cached?.author?.displayName || '스레드';
        toggle.innerHTML = `<span class="account-chip-dot" style="background:var(--accent-primary)"></span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>${escapeHtml(label)}`;
        this.toggleBar.appendChild(toggle);
      }
    }
  },

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
    } else if (type === 'bookmarks') {
      this.columnState.bookmarks = !this.columnState.bookmarks;
      this.updateColumnOrder('bookmarks', this.columnState.bookmarks);
      this.saveColumnState();
      this.renderToggleBar();
      this.toggleColumnSmooth('bookmarks', this.columnState.bookmarks);
    } else if (type === 'dm') {
      this.columnState.dm = !this.columnState.dm;
      this.updateColumnOrder('dm', this.columnState.dm);
      this.saveColumnState();
      this.renderToggleBar();
      this.toggleColumnSmooth('dm', this.columnState.dm);
    } else if (type === 'pages') {
      this.columnState.pages = !this.columnState.pages;
      this.updateColumnOrder('pages', this.columnState.pages);
      this.saveColumnState();
      this.renderToggleBar();
      this.toggleColumnSmooth('pages', this.columnState.pages);
    } else if (type === 'account') {
      const accountId = toggle.dataset.accountId;
      this.columnState.accounts[accountId] = !this.columnState.accounts[accountId];
      this.updateColumnOrder(`account:${accountId}`, this.columnState.accounts[accountId]);
      this.saveColumnState();
      this.renderToggleBar();
      this.toggleColumnSmooth('account', this.columnState.accounts[accountId], accountId);
    } else if (type === 'thread') {
      const threadKey = toggle.dataset.threadKey;
      this.unpinThreadColumn(threadKey);
    }
  },

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
  },

  toggleColumnSmooth(type, visible, accountId = null, threadKey = null) {
    if (visible) {
      // Build and insert column at the correct position
      const col = this.buildSingleColumn(type, accountId, threadKey);
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
      const col = this.findColumnElement(type, accountId, threadKey);
      if (!col) return;

      col.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      col.style.opacity = '0';
      col.style.transform = 'scale(0.95)';
      setTimeout(() => col.remove(), 260);
    }
  },

  buildSingleColumn(type, accountId, threadKey) {
    if (type === 'all') {
      return this.createColumn('전체', 'all', null);
    } else if (type === 'notifications') {
      return this.createColumn('알림', 'notifications', null);
    } else if (type === 'bookmarks') {
      return this.createColumn('북마크', 'bookmarks', null);
    } else if (type === 'dm') {
      return this.createColumn('DM', 'dm', null);
    } else if (type === 'pages') {
      return this.createColumn('페이지', 'pages', null);
    } else if (type === 'account' && accountId) {
      const account = this.store.getById(accountId);
      if (!account) return null;
      const name = escapeHtml(account.label || account.profile.displayName);
      return this.createColumn(name, 'account', account.id);
    } else if (type === 'thread' && threadKey) {
      const info = this.columnState.threads?.[threadKey];
      if (!info) return null;
      const col = this.createColumn('스레드', 'thread', null);
      col.dataset.threadKey = threadKey;
      col.dataset.threadPostId = info.postId;
      col.dataset.threadPlatform = info.platform;
      col.dataset.threadAccountId = info.accountId;
      return col;
    }
    return null;
  },

  loadColumnData(col, type, accountId) {
    const content = col.querySelector('.column-content');
    const accounts = this.store.getVisible();
    if (type === 'all') {
      this.loadTimelineForColumn(content, accounts);
    } else if (type === 'notifications') {
      this.loadNotificationsForColumn(content, accounts);
    } else if (type === 'account' && accountId) {
      const account = this.store.getById(accountId);
      if (account) {
        this.loadTimelineForColumn(content, [account]);
      }
    } else if (type === 'bookmarks') {
      this.loadBookmarksForColumn(content, accounts);
    } else if (type === 'dm') {
      this.loadConversationsForColumn(content, accounts);
    } else if (type === 'pages') {
      this.loadPagesFeedForColumn(content, accounts);
    } else if (type === 'thread') {
      this.loadThreadForColumn(col);
    }
  },

  findColumnElement(type, accountId, threadKey) {
    const columns = this.columnsContainer.querySelectorAll('.column');
    for (const col of columns) {
      if (col.dataset.columnType === type) {
        if (type === 'account') {
          if (col.dataset.accountId === accountId) return col;
        } else if (type === 'thread') {
          if (col.dataset.threadKey === threadKey) return col;
        } else {
          return col;
        }
      }
    }
    return null;
  },

  // Determine correct insertion position using the saved toggle order
  getColumnInsertionPoint(type, accountId, threadKey) {
    const existing = [...this.columnsContainer.querySelectorAll('.column')];
    const order = this.columnState.order || [];

    const myKey = type === 'account' ? `account:${accountId}`
      : type === 'thread' ? (threadKey || type) : type;
    const myIndex = order.indexOf(myKey);

    const _colKey = (col) => {
      if (col.dataset.columnType === 'account') return `account:${col.dataset.accountId}`;
      if (col.dataset.columnType === 'thread') return col.dataset.threadKey;
      return col.dataset.columnType;
    };

    // Find the first existing column that should come AFTER this one in the order
    for (let i = myIndex + 1; i < order.length; i++) {
      const key = order[i];
      for (const col of existing) {
        if (_colKey(col) === key) return col;
      }
    }
    return null; // append to end
  },

  renderColumns() {
    this.columnsContainer.innerHTML = '';
    const allAccounts = this.store.getAll();
    if (allAccounts.length === 0) return;

    const visibleAccounts = this.store.getVisible();
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
      } else if (key === 'bookmarks' && this.columnState.bookmarks) {
        const col = this.createColumn('북마크', 'bookmarks', null);
        this.columnsContainer.appendChild(col);
        this.loadBookmarksForColumn(col.querySelector('.column-content'), visibleAccounts);
      } else if (key === 'dm' && this.columnState.dm) {
        const col = this.createColumn('DM', 'dm', null);
        this.columnsContainer.appendChild(col);
        this.loadConversationsForColumn(col.querySelector('.column-content'), visibleAccounts);
      } else if (key === 'pages' && this.columnState.pages) {
        const col = this.createColumn('페이지', 'pages', null);
        this.columnsContainer.appendChild(col);
        this.loadPagesFeedForColumn(col.querySelector('.column-content'), visibleAccounts);
      } else if (key.startsWith('account:')) {
        const accountId = key.slice('account:'.length);
        if (this.columnState.accounts[accountId]) {
          const account = this.store.getById(accountId);
          if (account) {
            const name = escapeHtml(account.label || account.profile.displayName);
            const col = this.createColumn(name, 'account', account.id);
            this.columnsContainer.appendChild(col);
            this.loadTimelineForColumn(col.querySelector('.column-content'), [account]);
          }
        }
      } else if (key.startsWith('thread:')) {
        const threadKey = key;
        const info = this.columnState.threads?.[threadKey];
        if (info) {
          const col = this.buildSingleColumn('thread', null, threadKey);
          if (col) {
            this.columnsContainer.appendChild(col);
            this.loadThreadForColumn(col);
          }
        }
      }
    }
    this._renderPagerDots();
  },

  _renderPagerDots() {
    const dots = document.getElementById('column-pager-dots');
    if (!dots) return;
    const cols = this.columnsContainer?.querySelectorAll('.column') || [];
    if (cols.length <= 1) { dots.innerHTML = ''; return; }
    dots.innerHTML = Array.from(cols).map((_, i) =>
      `<span class="dot${i === this.focusedColumnIndex ? ' active' : ''}"></span>`
    ).join('');
  },

  createColumn(title, type, accountId) {
    const col = document.createElement('section');
    col.className = 'column';
    col.dataset.columnType = type;
    if (accountId) col.dataset.accountId = accountId;
    col.setAttribute('role', 'region');
    col.setAttribute('aria-label', title);

    let avatarHtml = '';
    if (type === 'account' && accountId) {
      const account = this.store.getById(accountId);
      if (account?.profile?.avatarUrl) {
        const acColor = this._accountColor(account);
        const borderStyle = acColor ? `style="border-color:${acColor}"` : '';
        avatarHtml = `<img class="column-header-avatar" width="22" height="22" ${borderStyle} src="${escapeHtml(account.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" data-fb="hide" data-profile-account-id="${accountId}" data-profile-user-id="${account.profile.id}" data-platform="${account.platform}">`;
      }
    } else if (type === 'all' || type === 'notifications') {
      // Show visible account avatars stacked horizontally
      const accounts = this.store.getVisible();
      if (accounts.length > 0) {
        const avatars = accounts.map(a => {
          if (!a.profile?.avatarUrl) return '';
          const acColor = this._accountColor(a);
          const borderStyle = acColor ? `style="border-color:${acColor}"` : '';
          return `<img class="column-header-avatar stacked" width="22" height="22" ${borderStyle} src="${escapeHtml(a.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" data-fb="hide" data-profile-account-id="${a.id}" data-profile-user-id="${a.profile.id}" data-platform="${a.platform}">`;
        }).filter(Boolean).join('');
        avatarHtml = `<span class="column-header-avatars">${avatars}</span>`;
      }
    }

    const iconPlus = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    const headerActions = type === 'pages'
      ? `<button class="btn btn-icon btn-small" data-action="add-page" title="새 페이지">${iconPlus}</button>`
      : `<button class="btn btn-icon btn-small" data-action="refresh-column" data-column-type="${type}" ${accountId ? `data-account-id="${accountId}"` : ''} title="새로고침">${iconRefresh}</button>`;

    col.innerHTML = `
      <div class="column-header">
        <h2>${avatarHtml}${title}</h2>
        <div class="column-header-actions">
          ${headerActions}
          <button class="btn btn-icon btn-small" data-action="close-column" data-column-type="${type}" ${accountId ? `data-account-id="${accountId}"` : ''} title="닫기">${iconClose}</button>
        </div>
      </div>
      <div class="column-content" role="feed"></div>
    `;

    // Same-author grouping (renders .post-grouped on consecutive cards)
    watchColumnGrouping(col.querySelector('.column-content'));

    return col;
  },

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
          const name = escapeHtml(account.label || account.profile.displayName);
          let avatarHtml = '';
          if (account.profile?.avatarUrl) {
            const acColor = this._accountColor(account);
            const borderStyle = acColor ? `style="border-color:${acColor}"` : '';
            avatarHtml = `<img class="column-header-avatar" width="22" height="22" ${borderStyle} src="${escapeHtml(account.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" data-fb="hide" data-profile-account-id="${accountId}" data-profile-user-id="${account.profile.id}" data-platform="${account.platform}">`;
          }
          h2.innerHTML = `${avatarHtml}${name}`;
        }
      } else if (type === 'all' || type === 'notifications') {
        const title = type === 'all' ? '전체' : '알림';
        const accounts = this.store.getVisible();
        let avatarHtml = '';
        if (accounts.length > 0) {
          const avatars = accounts.map(a => {
            if (!a.profile?.avatarUrl) return '';
            const acColor = this._accountColor(a);
            const borderStyle = acColor ? `style="border-color:${acColor}"` : '';
            return `<img class="column-header-avatar stacked" width="22" height="22" ${borderStyle} src="${escapeHtml(a.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" data-fb="hide" data-profile-account-id="${a.id}" data-profile-user-id="${a.profile.id}" data-platform="${a.platform}">`;
          }).filter(Boolean).join('');
          avatarHtml = `<span class="column-header-avatars">${avatars}</span>`;
        }
        h2.innerHTML = `${avatarHtml}${title}`;
      }
    }
  },

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
            await this.loadTimelineForColumn(content, this.store.getVisible());
          } else if (colType === 'notifications') {
            await this.loadNotificationsForColumn(content, this.store.getVisible());
          } else if (colType === 'account' && accountId) {
            const account = this.store.getById(accountId);
            if (account) {
              await this.loadTimelineForColumn(content, [account]);
            }
          } else if (colType === 'bookmarks') {
            await this.loadBookmarksForColumn(content, this.store.getVisible());
          } else if (colType === 'dm') {
            await this.loadConversationsForColumn(content, this.store.getVisible());
          } else if (colType === 'pages') {
            await this.loadPagesFeedForColumn(content, this.store.getVisible());
          } else if (colType === 'thread') {
            await this.loadThreadForColumn(col);
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
  },

  startAutoRefresh() {
    this.stopAutoRefresh();
    if (!this.AUTO_REFRESH_INTERVAL || this.AUTO_REFRESH_INTERVAL <= 0) return;
    this.autoRefreshTimer = setInterval(() => {
      if (!this.store.isEmpty()) {
        this.refreshAll(false, { skipColumnTypes: ['thread'] });
        // Drive the reaction-enrichment retry queue on the same tick — picks
        // up notifs whose previous fetch was rate-limited or federation-lagged.
        this._processEnrichmentRetries?.();
      }
    }, this.AUTO_REFRESH_INTERVAL);

    // Refresh immediately when the tab becomes visible again, so posts
    // missed during background throttling appear without waiting for the
    // next polling interval.
    if (!this._visibilityRefreshHandler) {
      this._lastHiddenAt = null;
      this._visibilityRefreshHandler = () => {
        if (document.visibilityState === 'hidden') {
          this._lastHiddenAt = Date.now();
        } else if (document.visibilityState === 'visible' && this._lastHiddenAt) {
          const away = Date.now() - this._lastHiddenAt;
          this._lastHiddenAt = null;
          // Refresh displayed times immediately (background throttling stalls our interval)
          this.refreshDisplayedTimes?.();
          // Only refresh if tab was hidden for more than 5 seconds
          if (away > 5_000 && !this.store.isEmpty()) {
            this.refreshAll(false, { skipColumnTypes: ['thread'] });
          }
        }
      };
      document.addEventListener('visibilitychange', this._visibilityRefreshHandler);
    }
  },

  stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
    if (this._visibilityRefreshHandler) {
      document.removeEventListener('visibilitychange', this._visibilityRefreshHandler);
      this._visibilityRefreshHandler = null;
    }
  },

  startTimeUpdater() {
    if (this._timeUpdaterTimer) return;
    // Update visible timestamps every minute. Skip when the tab is hidden to
    // avoid burning the background throttle budget.
    this._timeUpdaterTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      this.refreshDisplayedTimes();
    }, 60_000);
  },

  refreshDisplayedTimes() {
    const nodes = document.querySelectorAll('[data-time] .time-text');
    if (nodes.length === 0) return;
    for (const textEl of nodes) {
      const wrap = textEl.parentElement;
      const iso = wrap?.dataset?.time;
      if (!iso) continue;
      const d = new Date(iso);
      if (isNaN(d.getTime())) continue;
      const next = timeAgo(d);
      if (textEl.textContent !== next) textEl.textContent = next;
    }
  },

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
    // Increment generation to invalidate any pending closeModal transitionend handlers
    overlay._modalGen = (overlay._modalGen || 0) + 1;
    // Accessibility: mark the overlay as a modal dialog and remember the
    // previously-focused element so we can restore focus on close.
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay._previouslyFocused = document.activeElement;
    overlay.style.display = 'flex';
    void overlay.offsetHeight;
    overlay.classList.add('visible');
    this._updateBodyScroll();
    // Focus the first focusable child so keyboard / screen-reader users land
    // inside the modal. Defer one frame so layout / autofocus settles first.
    requestAnimationFrame(() => {
      if (!overlay.classList.contains('visible')) return;
      if (overlay.contains(document.activeElement)) return;
      const target = this._firstFocusableInside(overlay);
      if (target) target.focus({ preventScroll: true });
    });
    // Install focus trap (capture phase, scoped to this overlay)
    if (!overlay._focusTrap) {
      overlay._focusTrap = (e) => {
        if (e.key !== 'Tab') return;
        if (!overlay.classList.contains('visible')) return;
        const focusables = this._focusableInside(overlay);
        if (focusables.length === 0) { e.preventDefault(); return; }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && active === last) { first.focus(); e.preventDefault(); }
      };
      overlay.addEventListener('keydown', overlay._focusTrap);
    }
  },

  closeModal(overlay) {
    if (!overlay || overlay.style.display === 'none') return;
    const gen = overlay._modalGen || 0;
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', () => {
      if ((overlay._modalGen || 0) !== gen) return;
      if (!overlay.classList.contains('visible')) {
        overlay.style.display = 'none';
        overlay.style.zIndex = '';
        // Restore focus to whatever was focused before opening, if it's still
        // attached and focusable.
        const prev = overlay._previouslyFocused;
        if (prev && prev.isConnected && typeof prev.focus === 'function') {
          try { prev.focus({ preventScroll: true }); } catch {}
        }
        overlay._previouslyFocused = null;
      }
      this._updateBodyScroll();
    }, { once: true });
  },

  _focusableInside(root) {
    const sel = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return [...root.querySelectorAll(sel)].filter(el => {
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    });
  },

  _firstFocusableInside(root) {
    const list = this._focusableInside(root);
    return list[0] || null;
  },

  /** Prevent/restore body scroll depending on whether any modal is open. */
  _updateBodyScroll() {
    const anyVisible = [...document.querySelectorAll('.modal-overlay')]
      .some(m => m.style.display !== 'none' && m.classList.contains('visible'));
    document.body.style.overflow = anyVisible ? 'hidden' : '';
  },

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
  },

  showToast(message, type = 'error') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      toast.addEventListener('transitionend', () => toast.remove());
      // Fallback: remove after 1s even if transitionend doesn't fire
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 1000);
    }, 3500);
  },
};
