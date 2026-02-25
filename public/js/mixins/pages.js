/**
 * Pages Mixin
 * Blog-like page management: dashboard, drafts, series, feed column, profile tab, sharing.
 * Handles non-Pages platforms gracefully.
 */
import { escapeHtml, compressImage } from '../ui/utils.js';

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
    // Edit button in page viewer
    const editBtn = document.getElementById('page-viewer-edit');
    if (editBtn) {
      editBtn.addEventListener('click', () => this._openPageEditor());
    }

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
    const editBtn = document.getElementById('page-viewer-edit');

    titleEl.textContent = '';
    extLink.href = '#';
    if (editBtn) editBtn.style.display = 'none';
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

      // Check if this is the user's own page
      const account = this.store.getById(accountId);
      const isOwnPage = account && page.user &&
        String(account.profile?.id) === String(page.user.id);

      // Store current page data for editing
      this._viewerPageData = { rawPage, page, accountId, pageId, isOwnPage };

      // Show edit button for own pages
      if (editBtn && isOwnPage) {
        editBtn.style.display = '';
      }

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

      this._renderPageBlocks(page.content, fileMap, contentEl, client);
      bodyEl.appendChild(contentEl);

      // Ensure all content links open in new tab without closing the viewer
      contentEl.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (link) {
          e.stopPropagation();
          link.target = '_blank';
          link.rel = 'noopener';
        }
      });

    } catch (err) {
      bodyEl.innerHTML = `<div class="pages-empty">페이지를 불러올 수 없습니다: ${escapeHtml(err.message)}</div>`;
    }
  },

  // Switch viewer to edit mode (unified single-textarea editing)
  _openPageEditor() {
    const data = this._viewerPageData;
    if (!data || !data.isOwnPage) return;

    const bodyEl = document.getElementById('page-viewer-body');
    const titleEl = document.getElementById('page-viewer-title');
    if (!bodyEl) return;

    const { rawPage, page, accountId, pageId } = data;

    // Build file map
    const fileMap = {};
    if (rawPage.attachedFiles) {
      for (const f of rawPage.attachedFiles) fileMap[f.id] = f;
    }

    bodyEl.innerHTML = '';

    // Title editor
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'input page-editor-title';
    titleInput.value = page.title;
    titleInput.placeholder = '페이지 제목';
    bodyEl.appendChild(titleInput);

    // Summary editor
    const summaryInput = document.createElement('input');
    summaryInput.type = 'text';
    summaryInput.className = 'input page-editor-summary';
    summaryInput.value = page.summary || '';
    summaryInput.placeholder = '요약 (선택)';
    bodyEl.appendChild(summaryInput);

    // Convert blocks to unified text
    const imageList = []; // [{fileId, file}]
    const unifiedText = this._blocksToUnifiedText(rawPage.content || [], fileMap, imageList);

    // Segmented editor: text areas split by inline images
    const editorContainer = document.createElement('div');
    editorContainer.className = 'page-editor-content';

    // Helper: create an auto-resizing textarea segment
    const makeSegment = (value = '') => {
      const ta = document.createElement('textarea');
      ta.className = 'input page-editor-segment';
      ta.value = value;
      const resize = () => { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight, 28) + 'px'; };
      ta.addEventListener('input', resize);
      requestAnimationFrame(resize);
      return ta;
    };

    // Helper: create an inline image element
    const makeInlineImage = (ref, url) => {
      const wrap = document.createElement('div');
      wrap.className = 'page-editor-inline-image';
      wrap.dataset.imageRef = ref;
      wrap.innerHTML = `<img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer">`;
      return wrap;
    };

    // Build initial segments from unified text
    const segments = unifiedText.split(/(\[image:\d+\])/);
    for (const seg of segments) {
      const imgMatch = seg.match(/^\[image:(\d+)\]$/);
      if (imgMatch) {
        const idx = parseInt(imgMatch[1]) - 1;
        const img = imageList[idx];
        if (img && img.file) {
          editorContainer.appendChild(makeInlineImage(seg, img.file.url || img.file.thumbnailUrl || ''));
        }
      } else {
        editorContainer.appendChild(makeSegment(seg));
      }
    }
    // Ensure there's always a textarea at the end
    if (!editorContainer.lastElementChild || editorContainer.lastElementChild.dataset.imageRef) {
      editorContainer.appendChild(makeSegment());
    }

    // --- Image upload logic ---
    const client = this.store.getClient(accountId);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    bodyEl.appendChild(fileInput);

    // Find the currently focused textarea (for insertion point)
    const getActiveSegment = () => {
      const active = document.activeElement;
      if (active?.tagName === 'TEXTAREA' && editorContainer.contains(active)) return active;
      // Fallback: last textarea
      const all = editorContainer.querySelectorAll('textarea');
      return all[all.length - 1] || null;
    };

    // Insert uploaded image after a given textarea, splitting it at cursor
    const insertImageAfterSegment = (ta, fileId, url) => {
      const ref = `[image:${imageList.length}]`;
      imageList.push({ fileId, file: { url } });
      const imgEl = makeInlineImage(ref, url);

      // Split textarea at cursor position
      const pos = ta.selectionStart ?? ta.value.length;
      const before = ta.value.slice(0, pos);
      const after = ta.value.slice(pos);

      ta.value = before.endsWith('\n') || before === '' ? before : before + '\n';
      const resize = () => { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight, 28) + 'px'; };
      resize();

      const afterTa = makeSegment(after.startsWith('\n') || after === '' ? after : '\n' + after);
      ta.after(imgEl);
      imgEl.after(afterTa);
      afterTa.focus();
    };

    // Upload a single image file and insert it
    const uploadAndInsert = async (file, targetTa) => {
      if (!client?.uploadFile) {
        this.showToast('이 계정은 파일 업로드를 지원하지 않습니다.');
        return;
      }
      // Show progress placeholder
      const placeholder = document.createElement('div');
      placeholder.className = 'page-editor-upload-progress';
      placeholder.innerHTML = '<div class="spinner-small"></div><span>업로드 중...</span><div class="page-editor-progress-bar"><div class="page-editor-progress-fill"></div></div>';
      targetTa.after(placeholder);

      try {
        const compressed = await compressImage(file);
        const result = await client.uploadFile(compressed, {
          onProgress: (ratio) => {
            const fill = placeholder.querySelector('.page-editor-progress-fill');
            if (fill) fill.style.width = `${Math.round(ratio * 100)}%`;
          },
        });
        placeholder.remove();
        insertImageAfterSegment(targetTa, result.id, result.url || result.thumbnailUrl || '');
      } catch (err) {
        placeholder.remove();
        this.showToast('이미지 업로드 실패: ' + err.message);
      }
    };

    // Process multiple image files
    const handleImageFiles = async (files) => {
      const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
      if (imageFiles.length === 0) return;
      const ta = getActiveSegment();
      if (!ta) return;
      for (const file of imageFiles) {
        await uploadAndInsert(file, ta);
      }
    };

    // 1) Button click → file picker
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) handleImageFiles(fileInput.files);
      fileInput.value = '';
    });

    // 2) Drag & drop on editor
    editorContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      editorContainer.classList.add('drag-over');
    });
    editorContainer.addEventListener('dragleave', () => {
      editorContainer.classList.remove('drag-over');
    });
    editorContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      editorContainer.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) handleImageFiles(e.dataTransfer.files);
    });

    // 3) Clipboard paste in any segment
    editorContainer.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleImageFiles(imageFiles);
      }
    });

    bodyEl.appendChild(editorContainer);

    // Toolbar with image add button
    const toolbar = document.createElement('div');
    toolbar.className = 'page-editor-toolbar';
    toolbar.innerHTML = `<button class="btn btn-secondary btn-small page-editor-add-image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> 이미지 추가</button>`;
    toolbar.querySelector('.page-editor-add-image').addEventListener('click', () => fileInput.click());
    // Insert toolbar before editorContainer
    bodyEl.insertBefore(toolbar, editorContainer);

    // Collect all segments back into unified text
    const collectText = () => {
      const parts = [];
      for (const child of editorContainer.children) {
        if (child.dataset.imageRef) {
          parts.push(child.dataset.imageRef);
        } else if (child.tagName === 'TEXTAREA') {
          parts.push(child.value);
        }
      }
      return parts.join('');
    };

    // Sticky save/cancel bar
    const actions = document.createElement('div');
    actions.className = 'page-editor-actions';
    actions.innerHTML = `
      <button class="btn btn-secondary" id="page-editor-cancel">취소</button>
      <button class="btn btn-primary" id="page-editor-save">저장</button>
    `;
    bodyEl.appendChild(actions);

    titleEl.textContent = '페이지 수정';

    document.getElementById('page-editor-cancel').addEventListener('click', () => {
      this.openPageViewer(pageId, accountId);
    });

    document.getElementById('page-editor-save').addEventListener('click', async () => {
      const saveBtn = document.getElementById('page-editor-save');
      saveBtn.disabled = true;
      saveBtn.textContent = '저장 중...';

      try {
        const client = this.store.getClient(accountId);
        if (!client) throw new Error('클라이언트를 찾을 수 없습니다.');

        const newContent = this._unifiedTextToBlocks(collectText(), imageList);

        await client.updatePage(pageId, {
          title: titleInput.value || page.title,
          name: rawPage.name,
          summary: summaryInput.value || null,
          content: newContent.length > 0 ? newContent : rawPage.content,
          variables: rawPage.variables || [],
          script: rawPage.script || '',
          alignCenter: rawPage.alignCenter || false,
          font: rawPage.font || 'sans-serif',
        });

        this.showToast('페이지가 수정되었습니다!');
        // Refresh dashboard if it's open
        if (this._pagesSelectedAccountId) {
          this._loadPagesForAccount(this._pagesSelectedAccountId);
        }
        this.openPageViewer(pageId, accountId);
      } catch (err) {
        this.showToast('수정 실패: ' + err.message);
        saveBtn.disabled = false;
        saveBtn.textContent = '저장';
      }
    });
  },

  // Convert block tree → single text string for unified editor
  _blocksToUnifiedText(blocks, fileMap, imageList) {
    const lines = [];
    const process = (blockList) => {
      for (const block of blockList) {
        if (block.type === 'section') {
          lines.push(`## ${block.title || ''}`);
          if (block.children && block.children.length > 0) {
            process(block.children);
          }
          lines.push('');
        } else if (block.type === 'text') {
          lines.push(block.text || '');
          lines.push('');
        } else if (block.type === 'textarea') {
          lines.push('```');
          lines.push(block.text || '');
          lines.push('```');
          lines.push('');
        } else if (block.type === 'image') {
          const file = fileMap[block.fileId] || null;
          imageList.push({ fileId: block.fileId, file });
          lines.push(`[image:${imageList.length}]`);
          lines.push('');
        }
      }
    };
    process(blocks);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  },

  // Parse unified text → block tree for API submission
  _unifiedTextToBlocks(text, imageList) {
    const lines = text.split('\n');
    const result = [];
    let currentSection = null;
    let textBuf = [];
    let inCode = false;
    let codeBuf = [];
    let blockId = 1;

    const makeId = () => String(blockId++);
    const getTarget = () => currentSection ? currentSection.children : result;

    const flushText = (target) => {
      const joined = textBuf.join('\n').trim();
      if (joined) {
        target.push({ id: makeId(), type: 'text', text: joined });
      }
      textBuf = [];
    };

    const flushCode = (target) => {
      target.push({ id: makeId(), type: 'textarea', text: codeBuf.join('\n') });
      codeBuf = [];
    };

    for (const line of lines) {
      if (inCode) {
        if (line.trim() === '```') {
          inCode = false;
          flushCode(getTarget());
        } else {
          codeBuf.push(line);
        }
        continue;
      }

      if (line.trim() === '```') {
        flushText(getTarget());
        inCode = true;
        continue;
      }

      const sectionMatch = line.match(/^## (.*)$/);
      if (sectionMatch) {
        flushText(getTarget());
        if (currentSection) result.push(currentSection);
        currentSection = {
          id: makeId(),
          type: 'section',
          title: sectionMatch[1],
          children: []
        };
        continue;
      }

      const imageMatch = line.match(/^\[image:(\d+)\]$/);
      if (imageMatch) {
        flushText(getTarget());
        const idx = parseInt(imageMatch[1]) - 1;
        const img = imageList[idx];
        if (img) {
          getTarget().push({ id: makeId(), type: 'image', fileId: img.fileId });
        }
        continue;
      }

      textBuf.push(line);
    }

    if (inCode) flushCode(getTarget());
    flushText(getTarget());
    if (currentSection) result.push(currentSection);

    return result;
  },

  _renderPageBlocks(blocks, fileMap, container, client) {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      const el = this._renderPageBlock(block, fileMap, client);
      if (el) container.appendChild(el);
    }
  },

  _showNewPageAccountPicker() {
    const pagesAccounts = this.store.getPagesAccounts();
    if (pagesAccounts.length === 0) {
      this.showToast('Pages를 지원하는 계정이 없습니다.');
      return;
    }
    // Only one account → skip picker, open editor directly
    if (pagesAccounts.length === 1) {
      this._openNewPageEditor(pagesAccounts[0].id);
      return;
    }
    // Build account picker popup
    const existing = document.querySelector('.page-account-picker');
    if (existing) existing.remove();

    const picker = document.createElement('div');
    picker.className = 'page-account-picker';
    picker.innerHTML = pagesAccounts.map(a => {
      const avatar = a.profile?.avatarUrl ? `<img src="${escapeHtml(a.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" class="page-account-picker-avatar">` : '';
      const name = escapeHtml(a.profile?.displayName || a.profile?.username || a.id);
      const host = escapeHtml(new URL(a.instanceUrl).host);
      return `<button class="page-account-picker-item" data-account-id="${a.id}">${avatar}<span class="page-account-picker-name">${name}<small>${host}</small></span></button>`;
    }).join('');

    // Position near the add button
    const addBtn = document.querySelector('[data-action="add-page"]');
    if (addBtn) {
      const rect = addBtn.getBoundingClientRect();
      picker.style.position = 'fixed';
      picker.style.top = (rect.bottom + 4) + 'px';
      picker.style.right = (window.innerWidth - rect.right) + 'px';
    }

    document.body.appendChild(picker);

    const handlePick = (e) => {
      const item = e.target.closest('.page-account-picker-item');
      if (item) {
        const accountId = item.dataset.accountId;
        picker.remove();
        document.removeEventListener('click', handleOutside, true);
        this._openNewPageEditor(accountId);
      }
    };
    picker.addEventListener('click', handlePick);

    const handleOutside = (e) => {
      if (!picker.contains(e.target) && !e.target.closest('[data-action="add-page"]')) {
        picker.remove();
        document.removeEventListener('click', handleOutside, true);
      }
    };
    setTimeout(() => document.addEventListener('click', handleOutside, true), 0);
  },

  _openNewPageEditor(accountId) {
    const overlay = document.getElementById('modal-page-viewer');
    if (!overlay) return;

    const titleEl = document.getElementById('page-viewer-title');
    const bodyEl = document.getElementById('page-viewer-body');
    const editBtn = document.getElementById('page-viewer-edit');
    const extLink = document.getElementById('page-viewer-external');
    if (!bodyEl) return;

    if (titleEl) titleEl.textContent = '새 페이지';
    if (editBtn) editBtn.style.display = 'none';
    if (extLink) extLink.style.display = 'none';
    bodyEl.innerHTML = '';

    // Title input
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'input page-editor-title';
    titleInput.placeholder = '페이지 제목';
    bodyEl.appendChild(titleInput);

    // Summary input
    const summaryInput = document.createElement('input');
    summaryInput.type = 'text';
    summaryInput.className = 'input page-editor-summary';
    summaryInput.placeholder = '요약 (선택)';
    bodyEl.appendChild(summaryInput);

    // Editor area
    const imageList = [];
    const editorContainer = document.createElement('div');
    editorContainer.className = 'page-editor-content';

    const makeSegment = (value = '') => {
      const ta = document.createElement('textarea');
      ta.className = 'input page-editor-segment';
      ta.value = value;
      const resize = () => { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight, 28) + 'px'; };
      ta.addEventListener('input', resize);
      requestAnimationFrame(resize);
      return ta;
    };

    editorContainer.appendChild(makeSegment(''));
    bodyEl.appendChild(editorContainer);

    // Image upload toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'page-editor-toolbar';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    const imgBtn = document.createElement('button');
    imgBtn.type = 'button';
    imgBtn.className = 'btn btn-small btn-secondary';
    imgBtn.textContent = '이미지 추가';
    imgBtn.addEventListener('click', () => fileInput.click());
    toolbar.appendChild(imgBtn);
    toolbar.appendChild(fileInput);
    bodyEl.appendChild(toolbar);

    const insertImageAfter = async (file, afterEl) => {
      const client = this.store.getClient(accountId);
      if (!client) return;
      try {
        const compressed = await compressImage(file);
        const uploaded = await client.uploadFile(compressed, file.name);
        const idx = imageList.length;
        imageList.push({ fileId: uploaded.id, file: uploaded });
        const imgEl = document.createElement('div');
        imgEl.className = 'page-editor-inline-image';
        imgEl.innerHTML = `<img src="${escapeHtml(uploaded.url || uploaded.thumbnailUrl || '')}" alt="" referrerpolicy="no-referrer"><span class="page-editor-image-label">[image:${idx + 1}]</span>`;
        const newSeg = makeSegment('');
        if (afterEl && afterEl.nextSibling) {
          editorContainer.insertBefore(imgEl, afterEl.nextSibling);
          editorContainer.insertBefore(newSeg, imgEl.nextSibling);
        } else {
          editorContainer.appendChild(imgEl);
          editorContainer.appendChild(newSeg);
        }
        newSeg.focus();
      } catch (err) {
        this.showToast('이미지 업로드 실패: ' + err.message);
      }
    };

    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) {
        const focusedSeg = editorContainer.querySelector('.page-editor-segment:focus') || editorContainer.querySelector('.page-editor-segment:last-of-type');
        insertImageAfter(fileInput.files[0], focusedSeg);
        fileInput.value = '';
      }
    });

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'page-editor-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = '발행';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = '취소';
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    bodyEl.appendChild(btnRow);

    cancelBtn.addEventListener('click', () => {
      this.closeModal(overlay);
    });

    const collectText = () => {
      const parts = [];
      for (const child of editorContainer.children) {
        if (child.classList.contains('page-editor-segment')) {
          parts.push(child.value);
        } else if (child.classList.contains('page-editor-inline-image')) {
          const label = child.querySelector('.page-editor-image-label');
          if (label) parts.push(label.textContent);
        }
      }
      return parts.join('\n');
    };

    saveBtn.addEventListener('click', async () => {
      const title = titleInput.value.trim();
      if (!title) {
        this.showToast('제목을 입력해주세요.');
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = '발행 중...';

      try {
        const client = this.store.getClient(accountId);
        if (!client) throw new Error('클라이언트를 찾을 수 없습니다.');

        const content = this._unifiedTextToBlocks(collectText(), imageList);
        const name = Date.now().toString(36);

        await client.createPage({
          title,
          name,
          summary: summaryInput.value.trim() || null,
          content: content.length > 0 ? content : [{ id: '0', type: 'text', text: '' }],
          variables: [],
          script: '',
          alignCenter: false,
          font: 'sans-serif',
        });

        this.showToast('페이지가 발행되었습니다!');
        this.closeModal(overlay);
        // Refresh pages column
        const pagesCol = this.columnsContainer.querySelector('.column[data-column-type="pages"]');
        if (pagesCol) {
          this.loadPagesFeedForColumn(pagesCol.querySelector('.column-content'), this.store.getVisible());
        }
      } catch (err) {
        this.showToast('발행 실패: ' + err.message);
        saveBtn.disabled = false;
        saveBtn.textContent = '발행';
      }
    });

    this.openModal(overlay);
    titleInput.focus();
  },

  _renderPageBlock(block, fileMap, client) {
    if (!block || !block.type) return null;

    // Use MFM renderer if client supports it, otherwise fallback to escapeHtml
    const renderText = (text) => {
      if (client && client.mfmToHtml) {
        return client.mfmToHtml(text || '');
      }
      return escapeHtml(text || '').replace(/\n/g, '<br>');
    };

    switch (block.type) {
      case 'text': {
        const el = document.createElement('div');
        el.className = 'page-block page-block-text';
        el.innerHTML = renderText(block.text);
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
          this._renderPageBlocks(block.children, fileMap, el, client);
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
        if (block.text) {
          const el = document.createElement('div');
          el.className = 'page-block';
          el.innerHTML = renderText(block.text);
          return el;
        }
        if (block.children && Array.isArray(block.children)) {
          const el = document.createElement('div');
          el.className = 'page-block';
          this._renderPageBlocks(block.children, fileMap, el, client);
          return el.children.length > 0 ? el : null;
        }
        return null;
      }
    }
  },
};
