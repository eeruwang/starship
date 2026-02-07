/**
 * StarShip - Main Application
 */
import { AccountStore } from './accounts.js';
import { renderPost, renderNotification, renderAccountCard, renderLoading, renderLoadingText } from './ui/dashboard.js';
import { startMastodonOAuth, startMiAuth, waitForAuthCallback, clearPendingAuth } from './auth.js';

class StarShipApp {
  constructor() {
    this.store = new AccountStore();
    this.autoRefreshTimer = null;
    this.AUTO_REFRESH_INTERVAL = 60000;
    this.visibleColumns = new Set(['timeline', 'notifications']);
    this.timelineAccountFilter = new Set();
    this.cachedPosts = [];

    this.initElements();
    this.bindEvents();
    this.resetTimelineAccountFilter();
    this.render();
    this.startAutoRefresh();
  }

  initElements() {
    this.btnCompose = document.getElementById('btn-compose');
    this.btnAddAccount = document.getElementById('btn-add-account');
    this.btnRefreshAll = document.getElementById('btn-refresh-all');
    this.accountTabs = document.getElementById('account-tabs');

    this.emptyState = document.getElementById('empty-state');
    this.columnsContainer = document.getElementById('columns-container');
    this.timelineFeed = document.getElementById('timeline-feed');
    this.notificationsFeed = document.getElementById('notifications-feed');
    this.accountsList = document.getElementById('accounts-list');

    this.colTimeline = document.getElementById('col-timeline');
    this.colNotifications = document.getElementById('col-notifications');
    this.colAccounts = document.getElementById('col-accounts');

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

    this.modalCompose = document.getElementById('modal-compose');
    this.composeAccount = document.getElementById('compose-account');
    this.composeText = document.getElementById('compose-text');
    this.composeImage = document.getElementById('compose-image');
    this.composeError = document.getElementById('compose-error');
    this.btnSubmitCompose = document.getElementById('btn-submit-compose');

    this.modalImageViewer = document.getElementById('modal-image-viewer');
    this.imageViewerTarget = document.getElementById('image-viewer-target');
  }

  bindEvents() {
    this.btnCompose.addEventListener('click', () => this.openComposeModal());
    this.btnAddAccount.addEventListener('click', () => this.openAddAccountModal());
    this.btnAddFirst?.addEventListener('click', () => this.openAddAccountModal());
    this.btnRefreshAll.addEventListener('click', () => this.refreshAll());

    document.querySelector('[data-action="refresh-timeline"]')?.addEventListener('click', () => this.loadTimelines());
    document.querySelector('[data-action="refresh-notifications"]')?.addEventListener('click', () => this.loadNotifications());
    document.querySelector('[data-action="close-timeline"]')?.addEventListener('click', () => this.hideColumn('timeline'));
    document.querySelector('[data-action="close-notifications"]')?.addEventListener('click', () => this.hideColumn('notifications'));

    this.accountTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      this.handleTabClick(tab.dataset.tab);
    });

    this.accountTabs.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        this.accountTabs.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });

    this.columnsContainer.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.columnsContainer.scrollWidth > this.columnsContainer.clientWidth) {
        this.columnsContainer.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });

    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById(btn.dataset.closeModal).style.display = 'none';
      });
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.style.display = 'none';
      });
    });

    this.platformSelect.addEventListener('change', () => {
      this.updateTokenHint();
      this.updateOAuthButton();
    });
    this.instanceUrl.addEventListener('input', () => this.updateOAuthButton());
    this.btnOAuthLogin.addEventListener('click', () => this.handleOAuthLogin());
    this.btnConfirmAdd.addEventListener('click', () => this.handleAddAccount());
    this.btnSubmitCompose.addEventListener('click', () => this.handleComposeSubmit());

    document.addEventListener('click', (e) => {
      if (e.target.matches('.cw-toggle')) {
        const target = document.getElementById(e.target.dataset.cwTarget);
        if (target) target.classList.toggle('visible');
        e.target.textContent = target?.classList.contains('visible') ? '숨기기' : '내용 보기';
      }

      const postBtn = e.target.closest('.post-action');
      if (postBtn) this.handlePostAction(postBtn);

      const image = e.target.closest('.post-media-image');
      if (image?.dataset.fullImage) {
        this.imageViewerTarget.src = image.dataset.fullImage;
        this.modalImageViewer.style.display = 'flex';
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    });
  }

  render() {
    const hasAccounts = !this.store.isEmpty();
    this.emptyState.style.display = hasAccounts ? 'none' : 'flex';
    this.columnsContainer.style.display = hasAccounts ? 'grid' : 'none';
    this.btnCompose.disabled = !hasAccounts;

    this.renderTabs();
    this.renderAccountsList();
    this.updateColumnsVisibility();

    if (hasAccounts) this.refreshAll();
  }

  renderTabs() {
    this.accountTabs.innerHTML = '';
    this.accountTabs.appendChild(this.createColumnTab('all', '전체', this.visibleColumns.has('timeline')));
    this.accountTabs.appendChild(this.createColumnTab('notifications', '알림', this.visibleColumns.has('notifications')));
    this.accountTabs.appendChild(this.createColumnTab('accounts', '계정목록', this.visibleColumns.has('accounts')));

    for (const account of this.store.getAll()) {
      const tab = document.createElement('button');
      const selected = this.timelineAccountFilter.has(account.id);
      tab.className = `tab ${selected ? 'active' : ''}`;
      tab.dataset.tab = `account:${account.id}`;
      tab.innerHTML = `<span class="platform-dot ${account.platform}"></span>${this.escapeHtml(account.label || account.profile.displayName)}`;
      this.accountTabs.appendChild(tab);
    }
  }

  createColumnTab(key, label, active) {
    const tab = document.createElement('button');
    tab.className = `tab ${active ? 'active' : ''}`;
    tab.dataset.tab = key;
    tab.textContent = label;
    return tab;
  }

  renderAccountsList() {
    this.accountsList.innerHTML = '';
    const accounts = this.store.getAll();
    if (accounts.length === 0) {
      this.accountsList.innerHTML = '<div class="loading-text">연결된 계정이 없습니다.</div>';
      return;
    }
    for (const account of accounts) {
      const card = renderAccountCard(account, (id) => {
        this.store.removeAccount(id);
        this.timelineAccountFilter.delete(id);
        this.resetTimelineAccountFilter();
        this.render();
      });
      this.accountsList.appendChild(card);
    }
  }

  handleTabClick(tabKey) {
    if (tabKey === 'all') {
      this.visibleColumns.add('timeline');
      this.resetTimelineAccountFilter();
      this.renderTabs();
      this.loadTimelines();
      this.updateColumnsVisibility();
      return;
    }
    if (tabKey === 'notifications') {
      this.toggleColumn('notifications');
      return;
    }
    if (tabKey === 'accounts') {
      this.toggleColumn('accounts');
      return;
    }
    if (tabKey.startsWith('account:')) {
      const accountId = tabKey.slice('account:'.length);
      if (this.timelineAccountFilter.has(accountId)) {
        this.timelineAccountFilter.delete(accountId);
      } else {
        this.timelineAccountFilter.add(accountId);
      }
      if (this.timelineAccountFilter.size === 0) this.resetTimelineAccountFilter();
      this.visibleColumns.add('timeline');
      this.renderTabs();
      this.loadTimelines();
    }
  }

  resetTimelineAccountFilter() {
    const allIds = this.store.getAll().map(a => a.id);
    this.timelineAccountFilter = new Set(allIds);
  }

  toggleColumn(column) {
    if (this.visibleColumns.has(column)) this.visibleColumns.delete(column);
    else this.visibleColumns.add(column);
    this.renderTabs();
    this.updateColumnsVisibility();
    if (column === 'notifications' && this.visibleColumns.has('notifications')) this.loadNotifications();
  }

  hideColumn(column) {
    this.visibleColumns.delete(column);
    this.renderTabs();
    this.updateColumnsVisibility();
  }

  updateColumnsVisibility() {
    this.colTimeline.style.display = this.visibleColumns.has('timeline') ? 'flex' : 'none';
    this.colNotifications.style.display = this.visibleColumns.has('notifications') ? 'flex' : 'none';
    this.colAccounts.style.display = this.visibleColumns.has('accounts') ? 'flex' : 'none';
  }

  async refreshAll() {
    await Promise.all([this.loadTimelines(), this.loadNotifications()]);
  }

  async loadTimelines() {
    const accounts = this.store.getAll().filter(a => this.timelineAccountFilter.has(a.id));
    if (accounts.length === 0) {
      this.timelineFeed.innerHTML = '<div class="loading-text">표시할 타임라인이 없습니다.</div>';
      return;
    }

    this.timelineFeed.innerHTML = '';
    this.timelineFeed.appendChild(renderLoading());

    try {
      const allPosts = [];
      const results = await Promise.allSettled(accounts.map(async account => {
        const client = this.store.getClient(account.id);
        if (!client) return [];
        const posts = await client.getHomeTimeline(30);
        return posts.map(p => ({ ...client.normalizePost(p), accountId: account.id }));
      }));

      for (const result of results) if (result.status === 'fulfilled' && result.value) allPosts.push(...result.value);
      allPosts.sort((a, b) => b.createdAt - a.createdAt);
      this.cachedPosts = allPosts;
      this.timelineFeed.innerHTML = '';

      if (allPosts.length === 0) return this.timelineFeed.appendChild(renderLoadingText('타임라인에 표시할 게시물이 없습니다.'));
      for (const post of allPosts) this.timelineFeed.appendChild(renderPost(post));
    } catch (err) {
      this.timelineFeed.innerHTML = `<div class="loading-text">타임라인 오류: ${this.escapeHtml(err.message)}</div>`;
    }
  }

  async loadNotifications() {
    const accounts = this.store.getAll();
    if (accounts.length === 0) {
      this.notificationsFeed.innerHTML = '<div class="loading-text">표시할 알림이 없습니다.</div>';
      return;
    }

    this.notificationsFeed.innerHTML = '';
    this.notificationsFeed.appendChild(renderLoading());

    try {
      const allNotifs = [];
      const results = await Promise.allSettled(accounts.map(async account => {
        const client = this.store.getClient(account.id);
        if (!client) return [];
        const notifs = await client.getNotifications(30);
        return notifs.map(n => ({ ...client.normalizeNotification(n), accountId: account.id }));
      }));
      for (const result of results) if (result.status === 'fulfilled' && result.value) allNotifs.push(...result.value);
      allNotifs.sort((a, b) => b.createdAt - a.createdAt);
      this.notificationsFeed.innerHTML = '';
      if (allNotifs.length === 0) return this.notificationsFeed.appendChild(renderLoadingText('새 알림이 없습니다.'));
      for (const notif of allNotifs) this.notificationsFeed.appendChild(renderNotification(notif));
    } catch (err) {
      this.notificationsFeed.innerHTML = `<div class="loading-text">알림 오류: ${this.escapeHtml(err.message)}</div>`;
    }
  }

  findPost(postId, platform) {
    return this.cachedPosts.find(p => p.id === postId && p.platform === platform) || null;
  }

  async handlePostAction(btn) {
    const action = btn.dataset.action;
    const card = btn.closest('.post-card');
    if (!card) return;
    const post = this.findPost(card.dataset.postId, card.dataset.platform);
    if (!post) return;

    if (action === 'open') {
      if (post.url) window.open(post.url, '_blank', 'noopener');
      return;
    }

    const account = await this.pickActionAccount(post, action);
    if (!account) return;
    const client = this.store.getClient(account.id);

    try {
      if (action === 'fav') {
        if (post.platform === 'mastodon') await client.favourite(post.targetId);
        else await client.createReaction(post.targetId, '❤');
      } else if (action === 'boost') {
        if (post.platform === 'mastodon') await client.reblog(post.targetId);
        else await client.renote(post.targetId);
      } else if (action === 'reply') {
        const text = prompt('답글 내용을 입력하세요');
        if (!text) return;
        await client.reply(post.targetId, text);
      }
      await this.loadTimelines();
    } catch (err) {
      alert(`작업 실패: ${err.message}`);
    }
  }

  async pickActionAccount(post, action) {
    const candidates = this.store.getAll().filter(a => a.platform === post.platform);
    if (candidates.length === 0) {
      alert('해당 플랫폼의 계정이 없습니다.');
      return null;
    }
    if (candidates.length === 1) return candidates[0];
    const preferred = candidates.find(a => a.id === post.accountId);
    const list = candidates.map((a, i) => `${i + 1}. ${a.label || a.profile.displayName}`).join('\n');
    const input = prompt(`${action}에 사용할 계정을 선택하세요:\n${list}`, preferred ? String(candidates.indexOf(preferred) + 1) : '1');
    const idx = Number(input) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) return null;
    return candidates[idx];
  }

  openComposeModal() {
    const accounts = this.store.getAll();
    this.composeAccount.innerHTML = '';
    for (const a of accounts) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.label || a.profile.displayName} (${a.platform})`;
      this.composeAccount.appendChild(opt);
    }
    this.composeText.value = '';
    this.composeImage.value = '';
    this.composeError.style.display = 'none';
    this.modalCompose.style.display = 'flex';
  }

  async handleComposeSubmit() {
    const accountId = this.composeAccount.value;
    const text = this.composeText.value.trim();
    const files = Array.from(this.composeImage.files || []);
    const account = this.store.getById(accountId);
    if (!account) return;
    if (!text && files.length === 0) {
      this.composeError.textContent = '내용 또는 이미지를 추가하세요.';
      this.composeError.style.display = 'block';
      return;
    }

    const client = this.store.getClient(accountId);
    this.btnSubmitCompose.disabled = true;
    try {
      if (account.platform === 'mastodon') {
        const mediaIds = [];
        for (const file of files) mediaIds.push((await client.uploadMedia(file)).id);
        await client.createPost(text, mediaIds);
      } else {
        const fileIds = [];
        for (const file of files) fileIds.push((await client.uploadFile(file)).id);
        await client.createNote(text, fileIds);
      }
      this.modalCompose.style.display = 'none';
      await this.loadTimelines();
    } catch (err) {
      this.composeError.textContent = `게시 실패: ${err.message}`;
      this.composeError.style.display = 'block';
    } finally {
      this.btnSubmitCompose.disabled = false;
    }
  }

  startAutoRefresh() {
    this.stopAutoRefresh();
    this.autoRefreshTimer = setInterval(() => {
      if (!this.store.isEmpty()) this.refreshAll();
    }, this.AUTO_REFRESH_INTERVAL);
  }

  stopAutoRefresh() {
    if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
  }

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
      misskey: 'Misskey 로그인으로 연결', iceshrimp: 'Iceshrimp 로그인으로 연결',
      cherrypick: 'CherryPick 로그인으로 연결', mastodon: 'Mastodon 로그인으로 연결',
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
  }

  async handleOAuthLogin() {
    const platform = this.platformSelect.value;
    const instanceUrl = this.instanceUrl.value.trim();
    if (!platform || !instanceUrl) return this.showAddError('플랫폼과 인스턴스 URL을 입력하세요.');

    this.btnOAuthLogin.disabled = true;
    this.addAccountError.style.display = 'none';
    try {
      const popup = platform === 'mastodon' ? await startMastodonOAuth(instanceUrl) : await startMiAuth(instanceUrl, platform);
      if (popup) this.btnOAuthLogin.textContent = '인증 대기 중...';
      const result = await waitForAuthCallback();
      await this.store.addAccount(result.platform, result.instanceUrl, result.accessToken);
      this.resetTimelineAccountFilter();
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
    if (!platform || !instanceUrl || !accessToken) return this.showAddError('모든 필드를 입력하세요.');

    this.btnConfirmAdd.disabled = true;
    try {
      await this.store.addAccount(platform, instanceUrl, accessToken, label);
      this.resetTimelineAccountFilter();
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

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const app = new StarShipApp();
  window.app = app;

  const authResult = localStorage.getItem('starship_auth_result');
  if (authResult) {
    localStorage.removeItem('starship_auth_result');
    try {
      const result = JSON.parse(authResult);
      await app.store.addAccount(result.platform, result.instanceUrl, result.accessToken);
      app.resetTimelineAccountFilter();
      app.render();
    } catch (err) {
      console.error('OAuth 콜백 처리 실패:', err);
    }
  }
});
