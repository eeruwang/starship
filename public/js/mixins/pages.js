/**
 * Pages Mixin
 * Blog-like page management: dashboard, drafts, series, feed column, profile tab, sharing.
 * Handles non-Pages platforms gracefully.
 */
import { escapeHtml } from '../ui/utils.js';

const DRAFTS_KEY = 'starship_page_drafts';
const SERIES_KEY = 'starship_page_series';
const AUTOSAVE_INTERVAL = 15000; // 15 seconds

export const PagesMixin = {

  // ============================================================
  //  Pages Dashboard (Blog Management Panel)
  // ============================================================

  openPagesDashboard() {
    const pagesAccounts = this.store.getPagesAccounts();
    if (pagesAccounts.length === 0) {
      this.showToast('Pages를 지원하는 계정이 없습니다. Misskey 계정을 추가하세요.');
      return;
    }

    const overlay = document.getElementById('modal-pages');
    if (!overlay) return;

    // Set default selected account
    if (!this._pagesSelectedAccountId || !this.store.getById(this._pagesSelectedAccountId)) {
      this._pagesSelectedAccountId = pagesAccounts[0].id;
    }
    this._pagesCurrentTab = 'published'; // published | drafts | series
    this._pagesSortBy = 'updatedAt'; // updatedAt | likedCount | title

    this._renderPagesDashboard();
    this.openModal(overlay);
    this._loadPagesForAccount(this._pagesSelectedAccountId);
  },

  _renderPagesDashboard() {
    const body = document.getElementById('pages-dashboard-body');
    if (!body) return;

    const pagesAccounts = this.store.getPagesAccounts();
    const allAccounts = this.store.getAll();
    const nonPagesAccounts = allAccounts.filter(a => !a.hidden && !this.store.supportsPages(a));

    body.innerHTML = `
      <div class="pages-account-selector">
        ${pagesAccounts.map(a => {
          const active = a.id === this._pagesSelectedAccountId ? ' active' : '';
          const color = this._accountColor(a);
          const dotStyle = color ? `style="background:${color}"` : '';
          return `<button class="pages-account-btn${active}" data-pages-account="${a.id}">
            <img class="pages-account-avatar" src="${escapeHtml(a.profile?.avatarUrl || '')}" alt="" referrerpolicy="no-referrer">
            <span class="platform-dot ${a.software || a.platform}" ${dotStyle}></span>
            ${escapeHtml(a.label || a.profile?.displayName || '')}
          </button>`;
        }).join('')}
        ${nonPagesAccounts.length > 0 ? `<div class="pages-no-support-hint">
          ${nonPagesAccounts.map(a => `<span class="pages-no-support-badge" title="${escapeHtml(a.label || '')} — Pages 미지원">${escapeHtml(a.label || a.profile?.displayName || '')}</span>`).join('')}
        </div>` : ''}
      </div>
      <div class="pages-tabs">
        <button class="pages-tab${this._pagesCurrentTab === 'published' ? ' active' : ''}" data-pages-tab="published">내 페이지</button>
        <button class="pages-tab${this._pagesCurrentTab === 'drafts' ? ' active' : ''}" data-pages-tab="drafts">초안</button>
        <button class="pages-tab${this._pagesCurrentTab === 'series' ? ' active' : ''}" data-pages-tab="series">시리즈</button>
      </div>
      <div class="pages-toolbar">
        <select class="pages-sort input" id="pages-sort">
          <option value="updatedAt"${this._pagesSortBy === 'updatedAt' ? ' selected' : ''}>최신순</option>
          <option value="likedCount"${this._pagesSortBy === 'likedCount' ? ' selected' : ''}>인기순</option>
          <option value="title"${this._pagesSortBy === 'title' ? ' selected' : ''}>제목순</option>
        </select>
        <button class="btn btn-primary btn-small" id="btn-pages-new">+ 새 페이지</button>
      </div>
      <div class="pages-list" id="pages-list">
        <div class="pages-loading"><div class="spinner"></div></div>
      </div>
    `;
  },

  async _loadPagesForAccount(accountId) {
    const listEl = document.getElementById('pages-list');
    if (!listEl) return;

    if (this._pagesCurrentTab === 'drafts') {
      this._renderDraftsList(listEl, accountId);
      return;
    }
    if (this._pagesCurrentTab === 'series') {
      this._renderSeriesList(listEl, accountId);
      return;
    }

    listEl.innerHTML = '<div class="pages-loading"><div class="spinner"></div></div>';

    const client = this.store.getClient(accountId);
    if (!client || !client.getMyPages) {
      listEl.innerHTML = '<div class="pages-empty">이 계정은 Pages를 지원하지 않습니다.</div>';
      return;
    }

    try {
      let rawPages;
      try {
        rawPages = await client.getMyPages(50);
      } catch (permErr) {
        // i/pages requires read:pages permission – fall back to users/pages
        const account = this.store.getById(accountId);
        const userId = account?.profile?.id;
        if (userId) {
          rawPages = await client.getUserPages(userId, 50);
        } else {
          throw permErr;
        }
      }
      if (!rawPages || rawPages.length === 0) {
        listEl.innerHTML = '<div class="pages-empty">아직 작성한 페이지가 없습니다.</div>';
        return;
      }

      let pages = rawPages.map(p => client.normalizePage(p));

      // Sort
      if (this._pagesSortBy === 'likedCount') {
        pages.sort((a, b) => b.likedCount - a.likedCount);
      } else if (this._pagesSortBy === 'title') {
        pages.sort((a, b) => a.title.localeCompare(b.title));
      } else {
        pages.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
      }

      // Check series membership
      const seriesMap = this._getSeriesForAccount(accountId);

      listEl.innerHTML = '';
      for (const page of pages) {
        listEl.appendChild(this._createPageCard(page, accountId, seriesMap));
      }
    } catch (err) {
      console.error('Pages load error:', err);
      listEl.innerHTML = `<div class="pages-empty">페이지를 불러올 수 없습니다: ${escapeHtml(err.message)}</div>`;
    }
  },

  _createPageCard(page, accountId, seriesMap = {}) {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.pageId = page.id;
    card.dataset.accountId = accountId;

    const dateStr = (page.updatedAt || page.createdAt).toLocaleDateString('ko-KR');
    const eyeCatch = page.eyeCatchingImage
      ? `<img class="page-card-thumb" src="${escapeHtml(page.eyeCatchingImage.url || page.eyeCatchingImage.thumbnailUrl || '')}" alt="" referrerpolicy="no-referrer">`
      : '';

    // Find which series this page belongs to
    let seriesBadge = '';
    for (const [seriesId, series] of Object.entries(seriesMap)) {
      const idx = series.pageIds.indexOf(page.id);
      if (idx !== -1) {
        seriesBadge = `<span class="page-series-badge">${escapeHtml(series.name)} #${idx + 1}</span>`;
        break;
      }
    }

    card.innerHTML = `
      ${eyeCatch}
      <div class="page-card-body">
        <div class="page-card-title">${escapeHtml(page.title)}${seriesBadge}</div>
        <div class="page-card-meta">
          <span class="page-card-date">${dateStr}</span>
          <span class="page-card-likes">${page.likedCount > 0 ? `♥ ${page.likedCount}` : ''}</span>
        </div>
        ${page.summary ? `<div class="page-card-summary">${escapeHtml(page.summary)}</div>` : ''}
        <div class="page-card-actions">
          <button class="btn btn-secondary btn-small" data-page-action="view" data-page-id="${page.id}" data-account-id="${accountId}">보기</button>
          <button class="btn btn-secondary btn-small" data-page-action="copy-link" data-page-url="${escapeHtml(page.url)}">링크 복사</button>
          <button class="btn btn-secondary btn-small" data-page-action="share" data-page-id="${page.id}" data-page-title="${escapeHtml(page.title)}" data-page-url="${escapeHtml(page.url)}">노트로 공유</button>
          <button class="btn btn-danger btn-small" data-page-action="delete" data-page-id="${page.id}">삭제</button>
        </div>
      </div>
    `;

    return card;
  },

  // ============================================================
  //  Draft System (Local Auto-save)
  // ============================================================

  _loadDrafts() {
    try {
      const data = localStorage.getItem(DRAFTS_KEY);
      return data ? JSON.parse(data) : {};
    } catch { return {}; }
  },

  _saveDrafts(drafts) {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  },

  _getDraftsForAccount(accountId) {
    const all = this._loadDrafts();
    return Object.entries(all)
      .filter(([, d]) => d.accountId === accountId)
      .sort(([, a], [, b]) => b.savedAt - a.savedAt)
      .map(([id, d]) => ({ id, ...d }));
  },

  saveDraft(draftId, data) {
    const drafts = this._loadDrafts();
    drafts[draftId || `draft_${Date.now()}`] = {
      ...data,
      savedAt: Date.now(),
    };
    this._saveDrafts(drafts);
  },

  deleteDraft(draftId) {
    const drafts = this._loadDrafts();
    delete drafts[draftId];
    this._saveDrafts(drafts);
  },

  _renderDraftsList(container, accountId) {
    const drafts = this._getDraftsForAccount(accountId);
    if (drafts.length === 0) {
      container.innerHTML = '<div class="pages-empty">저장된 초안이 없습니다.</div>';
      return;
    }
    container.innerHTML = '';
    for (const draft of drafts) {
      const card = document.createElement('div');
      card.className = 'page-card draft-card';
      card.dataset.draftId = draft.id;
      const date = new Date(draft.savedAt).toLocaleString('ko-KR');
      card.innerHTML = `
        <div class="page-card-body">
          <div class="page-card-title">${escapeHtml(draft.title || '제목 없음')}
            <span class="draft-badge">초안</span>
          </div>
          <div class="page-card-meta">
            <span class="page-card-date">${date}</span>
          </div>
          ${draft.summary ? `<div class="page-card-summary">${escapeHtml(draft.summary)}</div>` : ''}
          <div class="page-card-actions">
            <button class="btn btn-primary btn-small" data-draft-action="publish" data-draft-id="${draft.id}">발행</button>
            <button class="btn btn-danger btn-small" data-draft-action="delete" data-draft-id="${draft.id}">삭제</button>
          </div>
        </div>
      `;
      container.appendChild(card);
    }
  },

  async _publishDraft(draftId) {
    const drafts = this._loadDrafts();
    const draft = drafts[draftId];
    if (!draft) return;

    const client = this.store.getClient(draft.accountId);
    if (!client) {
      this.showToast('계정을 찾을 수 없습니다.');
      return;
    }

    try {
      await client.createPage({
        title: draft.title || '제목 없음',
        name: draft.name || `page-${Date.now()}`,
        summary: draft.summary || null,
        content: draft.content || [{ id: '0', type: 'text', text: '' }],
        variables: draft.variables || [],
        script: draft.script || '',
        alignCenter: draft.alignCenter || false,
        font: draft.font || 'sans-serif',
      });

      this.deleteDraft(draftId);
      this.showToast('페이지가 발행되었습니다!');
      this._loadPagesForAccount(draft.accountId);
    } catch (err) {
      this.showToast('발행 실패: ' + err.message);
    }
  },

  // ============================================================
  //  Series (연재) Management
  // ============================================================

  _loadSeries() {
    try {
      const data = localStorage.getItem(SERIES_KEY);
      return data ? JSON.parse(data) : {};
    } catch { return {}; }
  },

  _saveSeries(series) {
    localStorage.setItem(SERIES_KEY, JSON.stringify(series));
  },

  _getSeriesForAccount(accountId) {
    const all = this._loadSeries();
    const result = {};
    for (const [id, s] of Object.entries(all)) {
      if (s.accountId === accountId) result[id] = s;
    }
    return result;
  },

  createSeries(accountId, name) {
    const series = this._loadSeries();
    const id = `series_${Date.now()}`;
    series[id] = {
      accountId,
      name,
      pageIds: [],
      createdAt: Date.now(),
    };
    this._saveSeries(series);
    return id;
  },

  deleteSeries(seriesId) {
    const series = this._loadSeries();
    delete series[seriesId];
    this._saveSeries(series);
  },

  addPageToSeries(seriesId, pageId) {
    const series = this._loadSeries();
    if (!series[seriesId]) return;
    if (!series[seriesId].pageIds.includes(pageId)) {
      series[seriesId].pageIds.push(pageId);
      this._saveSeries(series);
    }
  },

  removePageFromSeries(seriesId, pageId) {
    const series = this._loadSeries();
    if (!series[seriesId]) return;
    series[seriesId].pageIds = series[seriesId].pageIds.filter(id => id !== pageId);
    this._saveSeries(series);
  },

  reorderSeriesPages(seriesId, pageIds) {
    const series = this._loadSeries();
    if (!series[seriesId]) return;
    series[seriesId].pageIds = pageIds;
    this._saveSeries(series);
  },

  _renderSeriesList(container, accountId) {
    const seriesMap = this._getSeriesForAccount(accountId);
    const entries = Object.entries(seriesMap);

    container.innerHTML = `
      <div class="series-create-row">
        <input type="text" class="input series-name-input" id="series-name-input" placeholder="새 시리즈 이름">
        <button class="btn btn-primary btn-small" id="btn-series-create">만들기</button>
      </div>
      ${entries.length === 0 ? '<div class="pages-empty">시리즈가 없습니다. 새 시리즈를 만들어보세요.</div>' : ''}
    `;

    for (const [seriesId, series] of entries) {
      const el = document.createElement('div');
      el.className = 'series-card';
      el.dataset.seriesId = seriesId;
      el.innerHTML = `
        <div class="series-card-header">
          <div class="series-card-title">${escapeHtml(series.name)}</div>
          <div class="series-card-meta">${series.pageIds.length}편</div>
          <button class="btn btn-danger btn-small" data-series-action="delete" data-series-id="${seriesId}">삭제</button>
        </div>
        <div class="series-card-pages">
          ${series.pageIds.length === 0
            ? '<div class="series-empty-hint">페이지 목록에서 시리즈에 추가할 수 있습니다.</div>'
            : series.pageIds.map((pid, i) => `<div class="series-page-item" data-page-id="${pid}"><span class="series-page-num">${i + 1}</span> <span class="series-page-id">${pid}</span></div>`).join('')
          }
        </div>
      `;
      container.appendChild(el);
    }
  },

  // ============================================================
  //  Pages Feed Column
  // ============================================================

  async loadPagesFeedForColumn(content, accounts) {
    content.innerHTML = '<div class="column-loading"><div class="spinner"></div></div>';

    const pagesAccounts = accounts.filter(a => this.store.supportsPages(a));
    if (pagesAccounts.length === 0) {
      content.innerHTML = '<div class="column-empty">Pages를 지원하는 계정이 없습니다.</div>';
      return;
    }

    try {
      const allPages = [];
      const results = await Promise.allSettled(
        pagesAccounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client?.getUserPages) return [];
          const userId = account.profile?.id;
          if (!userId) return [];
          const raw = await client.getUserPages(userId, 30);
          return (raw || []).map(p => ({
            ...client.normalizePage(p),
            accountId: account.id,
            themeColor: account.themeColor,
          }));
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') allPages.push(...result.value);
      }

      allPages.sort((a, b) => b.createdAt - a.createdAt);

      content.innerHTML = '';
      if (allPages.length === 0) {
        content.innerHTML = '<div class="column-empty">페이지가 없습니다.</div>';
        return;
      }

      for (const page of allPages) {
        content.appendChild(this._renderPageFeedItem(page));
      }
    } catch (err) {
      content.innerHTML = `<div class="column-empty">페이지 로드 실패</div>`;
    }
  },

  _renderPageFeedItem(page) {
    const item = document.createElement('div');
    item.className = 'page-feed-item';
    const dateStr = page.createdAt.toLocaleDateString('ko-KR');
    const eyeCatch = page.eyeCatchingImage
      ? `<div class="page-feed-thumb"><img src="${escapeHtml(page.eyeCatchingImage.url || page.eyeCatchingImage.thumbnailUrl || '')}" alt="" referrerpolicy="no-referrer"></div>`
      : '';

    const borderStyle = page.themeColor ? `style="border-left:3px solid ${page.themeColor}"` : '';

    item.innerHTML = `
      <div class="page-feed-link" data-page-action="view" data-page-id="${page.id}" data-account-id="${page.accountId}" ${borderStyle}>
        ${eyeCatch}
        <div class="page-feed-body">
          <div class="page-feed-title">${escapeHtml(page.title)}</div>
          ${page.summary ? `<div class="page-feed-summary">${escapeHtml(page.summary)}</div>` : ''}
          <div class="page-feed-meta">
            ${page.user ? `<img class="page-feed-avatar" src="${escapeHtml(page.user.avatarUrl || '')}" alt="" referrerpolicy="no-referrer">` : ''}
            <span class="page-feed-author">${page.user ? escapeHtml(page.user.displayName) : ''}</span>
            <span class="page-feed-date">${dateStr}</span>
            ${page.likedCount > 0 ? `<span class="page-feed-likes">♥ ${page.likedCount}</span>` : ''}
          </div>
        </div>
      </div>
    `;
    return item;
  },

  // ============================================================
  //  Profile Pages Tab
  // ============================================================

  async _loadProfilePages(container, client, account, userId) {
    container.innerHTML = '<div class="profile-posts-empty"><div class="spinner"></div></div>';

    if (!this.store.supportsPages(account)) {
      container.innerHTML = '<div class="profile-posts-empty">이 서버는 Pages를 지원하지 않습니다.</div>';
      return;
    }

    try {
      const raw = await client.getUserPages(userId, 30);
      if (!raw || raw.length === 0) {
        container.innerHTML = '<div class="profile-posts-empty">페이지가 없습니다.</div>';
        return;
      }

      const pages = raw.map(p => client.normalizePage(p));
      pages.sort((a, b) => b.createdAt - a.createdAt);

      container.innerHTML = '<div class="profile-pages-grid"></div>';
      const grid = container.querySelector('.profile-pages-grid');

      for (const page of pages) {
        const card = document.createElement('div');
        card.className = 'profile-page-card';
        card.dataset.pageAction = 'view';
        card.dataset.pageId = page.id;
        card.dataset.accountId = account.id;
        card.style.cursor = 'pointer';

        const eyeCatch = page.eyeCatchingImage
          ? `<div class="profile-page-thumb"><img src="${escapeHtml(page.eyeCatchingImage.url || page.eyeCatchingImage.thumbnailUrl || '')}" alt="" referrerpolicy="no-referrer"></div>`
          : '<div class="profile-page-thumb profile-page-thumb-empty"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></div>';

        card.innerHTML = `
          ${eyeCatch}
          <div class="profile-page-info">
            <div class="profile-page-title">${escapeHtml(page.title)}</div>
            <div class="profile-page-meta">
              ${page.likedCount > 0 ? `<span>♥ ${page.likedCount}</span>` : ''}
              <span>${page.createdAt.toLocaleDateString('ko-KR')}</span>
            </div>
          </div>
        `;
        grid.appendChild(card);
      }
    } catch (err) {
      container.innerHTML = `<div class="profile-posts-empty">페이지 로딩 오류: ${escapeHtml(err.message)}</div>`;
    }
  },

  // ============================================================
  //  Page Share (embed card in compose)
  // ============================================================

  _openPageShareCompose(pageTitle, pageUrl, accountId) {
    const text = `📄 ${pageTitle}\n${pageUrl}`;
    this.openComposeModal(null, accountId);
    // Set text after modal opens
    requestAnimationFrame(() => {
      const composeText = document.getElementById('compose-text');
      if (composeText) {
        composeText.value = text;
        composeText.dispatchEvent(new Event('input'));
      }
    });
  },

  // ============================================================
  //  Pages Dashboard Event Handlers
  // ============================================================

  _bindPagesEvents() {
    // Delegated events for pages modal
    document.addEventListener('click', (e) => {
      // Account selector
      const accountBtn = e.target.closest('.pages-account-btn');
      if (accountBtn) {
        const accountId = accountBtn.dataset.pagesAccount;
        if (accountId) {
          this._pagesSelectedAccountId = accountId;
          this._renderPagesDashboard();
          this._loadPagesForAccount(accountId);
        }
        return;
      }

      // Tab switch
      const tabBtn = e.target.closest('.pages-tab');
      if (tabBtn) {
        const tab = tabBtn.dataset.pagesTab;
        if (tab) {
          this._pagesCurrentTab = tab;
          document.querySelectorAll('.pages-tab').forEach(t => t.classList.remove('active'));
          tabBtn.classList.add('active');
          this._loadPagesForAccount(this._pagesSelectedAccountId);
        }
        return;
      }

      // New page
      if (e.target.closest('#btn-pages-new')) {
        this._createNewDraft();
        return;
      }

      // Page actions
      const pageAction = e.target.closest('[data-page-action]');
      if (pageAction) {
        const action = pageAction.dataset.pageAction;
        if (action === 'view') {
          const pageId = pageAction.dataset.pageId;
          const acctId = pageAction.dataset.accountId;
          if (pageId && acctId) {
            e.preventDefault();
            this.openPageViewer(pageId, acctId);
          }
          return;
        }
        if (action === 'copy-link') {
          const url = pageAction.dataset.pageUrl;
          navigator.clipboard.writeText(url).then(() => this.showToast('링크가 복사되었습니다.'));
        } else if (action === 'delete') {
          const pageId = pageAction.dataset.pageId;
          if (confirm('이 페이지를 삭제하시겠습니까?')) {
            this._deletePageById(pageId);
          }
        } else if (action === 'share') {
          const pageTitle = pageAction.dataset.pageTitle;
          const pageUrl = pageAction.dataset.pageUrl;
          this._openPageShareCompose(pageTitle, pageUrl, this._pagesSelectedAccountId);
        }
        return;
      }

      // Draft actions
      const draftAction = e.target.closest('[data-draft-action]');
      if (draftAction) {
        const action = draftAction.dataset.draftAction;
        const draftId = draftAction.dataset.draftId;
        if (action === 'publish') {
          this._publishDraft(draftId);
        } else if (action === 'delete') {
          if (confirm('이 초안을 삭제하시겠습니까?')) {
            this.deleteDraft(draftId);
            this._loadPagesForAccount(this._pagesSelectedAccountId);
          }
        }
        return;
      }

      // Series create
      if (e.target.closest('#btn-series-create')) {
        const input = document.getElementById('series-name-input');
        const name = input?.value.trim();
        if (name) {
          this.createSeries(this._pagesSelectedAccountId, name);
          this._loadPagesForAccount(this._pagesSelectedAccountId);
        }
        return;
      }

      // Series delete
      const seriesAction = e.target.closest('[data-series-action]');
      if (seriesAction) {
        const action = seriesAction.dataset.seriesAction;
        const seriesId = seriesAction.dataset.seriesId;
        if (action === 'delete') {
          if (confirm('이 시리즈를 삭제하시겠습니까? (페이지는 삭제되지 않습니다)')) {
            this.deleteSeries(seriesId);
            this._loadPagesForAccount(this._pagesSelectedAccountId);
          }
        }
        return;
      }
    });

    // Sort change
    document.addEventListener('change', (e) => {
      if (e.target.id === 'pages-sort') {
        this._pagesSortBy = e.target.value;
        this._loadPagesForAccount(this._pagesSelectedAccountId);
      }
    });
  },

  _createNewDraft() {
    const draftId = `draft_${Date.now()}`;
    this.saveDraft(draftId, {
      accountId: this._pagesSelectedAccountId,
      title: '',
      name: '',
      summary: '',
      content: [{ id: '0', type: 'text', text: '' }],
      variables: [],
      script: '',
      alignCenter: false,
      font: 'sans-serif',
    });
    this._pagesCurrentTab = 'drafts';
    this._renderPagesDashboard();
    this._loadPagesForAccount(this._pagesSelectedAccountId);
    this.showToast('새 초안이 생성되었습니다.');
  },

  async _deletePageById(pageId) {
    const client = this.store.getClient(this._pagesSelectedAccountId);
    if (!client) return;
    try {
      await client.deletePage(pageId);
      this.showToast('페이지가 삭제되었습니다.');
      this._loadPagesForAccount(this._pagesSelectedAccountId);
    } catch (err) {
      this.showToast('삭제 실패: ' + err.message);
    }
  },

  // ============================================================
  //  In-App Page Viewer
  // ============================================================

  async openPageViewer(pageId, accountId) {
    const overlay = document.getElementById('modal-page-viewer');
    if (!overlay) return;

    const titleEl = document.getElementById('page-viewer-title');
    const bodyEl = document.getElementById('page-viewer-body');
    const extLink = document.getElementById('page-viewer-external');

    titleEl.textContent = '';
    extLink.href = '#';
    bodyEl.innerHTML = '<div class="pages-loading"><div class="spinner"></div></div>';
    this.openModal(overlay);

    const client = this.store.getClient(accountId);
    if (!client) {
      bodyEl.innerHTML = '<div class="pages-empty">계정을 찾을 수 없습니다.</div>';
      return;
    }

    try {
      const rawPage = await client.getPage(pageId);
      const page = client.normalizePage(rawPage);

      titleEl.textContent = page.title;
      extLink.href = page.url;

      // Build file map from attachedFiles
      const fileMap = {};
      if (rawPage.attachedFiles) {
        for (const f of rawPage.attachedFiles) {
          fileMap[f.id] = f;
        }
      }

      bodyEl.innerHTML = '';

      // Eye-catching image
      if (page.eyeCatchingImage) {
        const imgEl = document.createElement('div');
        imgEl.className = 'page-viewer-eyecatch';
        imgEl.innerHTML = `<img src="${escapeHtml(page.eyeCatchingImage.url || page.eyeCatchingImage.thumbnailUrl || '')}" alt="" referrerpolicy="no-referrer">`;
        bodyEl.appendChild(imgEl);
      }

      // Author info
      if (page.user) {
        const authorEl = document.createElement('div');
        authorEl.className = 'page-viewer-author';
        const dateStr = page.createdAt.toLocaleDateString('ko-KR');
        authorEl.innerHTML = `
          <img src="${escapeHtml(page.user.avatarUrl || '')}" alt="" referrerpolicy="no-referrer">
          <span class="page-viewer-author-name">${escapeHtml(page.user.displayName)}</span>
          <span class="page-viewer-date">${dateStr}</span>
          ${page.likedCount > 0 ? `<span class="page-viewer-likes">♥ ${page.likedCount}</span>` : ''}
        `;
        bodyEl.appendChild(authorEl);
      }

      // Content blocks
      const contentEl = document.createElement('div');
      contentEl.className = 'page-viewer-content';
      if (page.alignCenter) contentEl.classList.add('text-center');
      if (page.font === 'serif') contentEl.style.fontFamily = 'serif';

      this._renderPageBlocks(page.content, fileMap, contentEl);
      bodyEl.appendChild(contentEl);

    } catch (err) {
      bodyEl.innerHTML = `<div class="pages-empty">페이지를 불러올 수 없습니다: ${escapeHtml(err.message)}</div>`;
    }
  },

  _renderPageBlocks(blocks, fileMap, container) {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      const el = this._renderPageBlock(block, fileMap);
      if (el) container.appendChild(el);
    }
  },

  _renderPageBlock(block, fileMap) {
    if (!block || !block.type) return null;

    switch (block.type) {
      case 'text': {
        const el = document.createElement('div');
        el.className = 'page-block page-block-text';
        el.innerHTML = escapeHtml(block.text || '').replace(/\n/g, '<br>');
        return el;
      }

      case 'section': {
        const el = document.createElement('div');
        el.className = 'page-block page-block-section';
        if (block.title) {
          const h = document.createElement('h3');
          h.className = 'page-block-section-title';
          h.textContent = block.title;
          el.appendChild(h);
        }
        if (block.children) {
          this._renderPageBlocks(block.children, fileMap, el);
        }
        return el;
      }

      case 'image': {
        const el = document.createElement('div');
        el.className = 'page-block page-block-image';
        const file = fileMap[block.fileId];
        if (file) {
          el.innerHTML = `<img src="${escapeHtml(file.url || file.thumbnailUrl || '')}" alt="${escapeHtml(file.comment || file.name || '')}" referrerpolicy="no-referrer" loading="lazy">`;
        }
        return el;
      }

      case 'textarea': {
        const el = document.createElement('div');
        el.className = 'page-block page-block-textarea';
        el.innerHTML = `<pre>${escapeHtml(block.text || '')}</pre>`;
        return el;
      }

      default: {
        // Render text if present, recurse into children if present
        if (block.text) {
          const el = document.createElement('div');
          el.className = 'page-block';
          el.innerHTML = escapeHtml(block.text).replace(/\n/g, '<br>');
          return el;
        }
        if (block.children && Array.isArray(block.children)) {
          const el = document.createElement('div');
          el.className = 'page-block';
          this._renderPageBlocks(block.children, fileMap, el);
          return el.children.length > 0 ? el : null;
        }
        return null;
      }
    }
  },
};
