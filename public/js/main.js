/**
 * StarShip - Main Application
 * Fediverse multi-account dashboard for Misskey, Iceshrimp, CherryPick, and Mastodon.
 */
import { AccountStore } from './accounts.js';
import { renderPost, renderNotification, renderAccountCard, renderLoading, renderLoadingText } from './ui/dashboard.js';
import { startMastodonOAuth, startMiAuth, waitForAuthCallback, clearPendingAuth } from './auth.js';
import { normalizeInstanceUrl, detectPlatform } from './utils/instance.js';

class StarShipApp {
  constructor() {
    this.store = new AccountStore();
    this.activeFilter = 'all'; // 'all' or account id
    this.autoRefreshTimer = null;
    this.AUTO_REFRESH_INTERVAL = 60000; // 1 minute
    this.cachedTimelineFilter = null;

    this.initElements();
    this.bindEvents();
    this.render();
    this.startAutoRefresh();
  }

  initElements() {
    // Header buttons
    this.btnAddAccount = document.getElementById('btn-add-account');
    this.btnRefreshAll = document.getElementById('btn-refresh-all');
    this.btnSettings = document.getElementById('btn-settings');
    this.btnAccountsMenu = document.getElementById('btn-accounts-menu');

    // Tab bar
    this.accountTabs = document.getElementById('account-tabs');

    // Dashboard
    this.emptyState = document.getElementById('empty-state');
    this.columnsContainer = document.getElementById('columns-container');
    this.timelineFeed = document.getElementById('timeline-feed');
    this.notificationsFeed = document.getElementById('notifications-feed');
    this.accountsList = document.getElementById('accounts-list');

    // Modal
    this.modalAddAccount = document.getElementById('modal-add-account');
    this.instanceUrl = document.getElementById('instance-url');
    this.accessToken = document.getElementById('access-token');
    this.accountLabel = document.getElementById('account-label');
    this.btnConfirmAdd = document.getElementById('btn-confirm-add');
    this.addAccountError = document.getElementById('add-account-error');

    this.btnAddFirst = document.getElementById('btn-add-first');

    // OAuth
    this.btnOAuthLogin = document.getElementById('btn-oauth-login');
  }

  bindEvents() {
    // Open add account modal
    this.btnAddAccount.addEventListener('click', () => this.openAddAccountModal());
    this.btnAddFirst?.addEventListener('click', () => this.openAddAccountModal());
    this.btnAccountsMenu?.addEventListener('click', () => {
      document.getElementById('modal-accounts').style.display = 'flex';
      this.renderAccountsList();
    });

    // Refresh
    this.btnRefreshAll.addEventListener('click', () => this.refreshAll());

    // Column refresh buttons
    document.querySelector('[data-action="refresh-timeline"]')?.addEventListener('click', () => this.loadTimelines());
    document.querySelector('[data-action="refresh-notifications"]')?.addEventListener('click', () => this.loadNotifications());

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


    // OAuth login button
    this.btnOAuthLogin.addEventListener('click', () => this.handleOAuthLogin());

    // Confirm add account (manual token)
    this.btnConfirmAdd.addEventListener('click', () => this.handleAddAccount());

    // Tab clicks (delegated)
    this.accountTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      this.setActiveFilter(tab.dataset.tab);
    });

    // CW toggle (delegated)
    document.addEventListener('click', (e) => {
      if (e.target.matches('.cw-toggle')) {
        const target = document.getElementById(e.target.dataset.cwTarget);
        if (target) target.classList.toggle('visible');
        e.target.textContent = target?.classList.contains('visible') ? '숨기기' : '내용 보기';
      }
    });

    // Post actions (delegated)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.post-action');
      if (!btn) return;
      const card = btn.closest('.post-card');
      if (!card) return;

      const action = btn.dataset.action;
      if (!action) return;
      await this.handlePostAction(action, card, btn);
    });

    // Keyboard shortcut: Escape to close modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      }
    });
  }

  // ===== Rendering =====

  render() {
    const hasAccounts = !this.store.isEmpty();
    this.emptyState.style.display = hasAccounts ? 'none' : 'flex';
    this.columnsContainer.style.display = hasAccounts ? 'grid' : 'none';

    this.renderTabs();
    this.renderAccountsList();

    if (hasAccounts) {
      this.refreshAll();
    }
  }

  renderTabs() {
    this.accountTabs.innerHTML = '';

    const allTab = document.createElement('button');
    allTab.className = `tab ${this.activeFilter === 'all' ? 'active' : ''}`;
    allTab.dataset.tab = 'all';
    allTab.textContent = '전체';
    this.accountTabs.appendChild(allTab);

    for (const account of this.store.getAll()) {
      const tab = document.createElement('button');
      tab.className = `tab ${this.activeFilter === account.id ? 'active' : ''}`;
      tab.dataset.tab = account.id;
      tab.innerHTML = `<span class="platform-dot ${account.platform}"></span>${this.escapeHtml(account.label || account.profile.displayName)}`;
      this.accountTabs.appendChild(tab);
    }
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
        this.render();
      });
      this.accountsList.appendChild(card);
    }
  }

  setActiveFilter(filter) {
    this.activeFilter = filter;
    this.renderTabs();
    this.refreshAll();
  }

  // ===== Data Loading =====

  async refreshAll() {
    await Promise.all([
      this.loadTimelines(),
      this.loadNotifications(),
    ]);
  }

  async loadTimelines() {
    const accounts = this.getFilteredAccounts();
    if (accounts.length === 0) {
      this.timelineFeed.innerHTML = '<div class="loading-text">표시할 타임라인이 없습니다.</div>';
      this.cachedPosts = [];
      this.cachedTimelineFilter = this.activeFilter;
      return;
    }

    const shouldShowLoader = !Array.isArray(this.cachedPosts)
      || this.cachedPosts.length === 0
      || this.cachedTimelineFilter !== this.activeFilter;

    if (shouldShowLoader) {
      this.timelineFeed.innerHTML = '';
      this.timelineFeed.appendChild(renderLoading());
    }

    try {
      const allPosts = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];

          if (account.platform === 'mastodon') {
            const statuses = await client.getHomeTimeline(30);
            return statuses.map(s => ({ ...client.normalizePost(s), accountId: account.id }));
          } else {
            const notes = await client.getHomeTimeline(30);
            return notes.map(n => ({ ...client.normalizePost(n), accountId: account.id }));
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allPosts.push(...result.value);
        }
      }

      // Sort by date descending
      allPosts.sort((a, b) => b.createdAt - a.createdAt);

      const timelinePosts = this.activeFilter === 'all'
        ? this.mergeCommonTimelinePosts(allPosts)
        : allPosts;

      if (timelinePosts.length === 0) {
        this.timelineFeed.innerHTML = '';
        this.timelineFeed.appendChild(renderLoadingText('타임라인에 표시할 게시물이 없습니다.'));
        this.cachedPosts = [];
        this.cachedTimelineFilter = this.activeFilter;
        return;
      }

      const makeKey = (post) => post.dedupeKey || `${post.platform}:${post.accountId || ''}:${post.id}`;

      const hasRenderedPosts = this.timelineFeed.querySelector('.post-card') !== null;
      const canIncremental = !shouldShowLoader
        && this.cachedTimelineFilter === this.activeFilter
        && hasRenderedPosts;

      if (!canIncremental) {
        this.timelineFeed.innerHTML = '';
        for (const post of timelinePosts) {
          this.timelineFeed.appendChild(renderPost(post));
        }
        this.cachedPosts = timelinePosts;
        this.cachedTimelineFilter = this.activeFilter;
        return;
      }

      const prevByKey = new Map((this.cachedPosts || []).map((post) => [makeKey(post), post]));
      const nextByKey = new Map(timelinePosts.map((post) => [makeKey(post), post]));
      const newPosts = timelinePosts.filter((post) => !prevByKey.has(makeKey(post)));

      const isPostChanged = (prev, next) => {
        if (!prev || !next) return true;
        const prevTime = prev.createdAt instanceof Date ? prev.createdAt.getTime() : new Date(prev.createdAt).getTime();
        const nextTime = next.createdAt instanceof Date ? next.createdAt.getTime() : new Date(next.createdAt).getTime();
        return prevTime !== nextTime
          || prev.content !== next.content
          || prev.contentWarning !== next.contentWarning
          || JSON.stringify(prev.stats || {}) !== JSON.stringify(next.stats || {})
          || JSON.stringify(prev.reactions || {}) !== JSON.stringify(next.reactions || {});
      };

      // Update existing cards in-place when content/stats changed.
      for (const card of this.timelineFeed.querySelectorAll('.post-card')) {
        const key = card.dataset.dedupeKey || `${card.dataset.platform}:${card.dataset.accountId || ''}:${card.dataset.postId}`;
        const prev = prevByKey.get(key);
        const next = nextByKey.get(key);
        if (!next || !isPostChanged(prev, next)) continue;

        const replacement = renderPost(next);
        card.replaceWith(replacement);
      }

      if (newPosts.length > 0) {
        const prevScrollTop = this.timelineFeed.scrollTop;
        const prevScrollHeight = this.timelineFeed.scrollHeight;
        const isNearTop = prevScrollTop < 24;

        for (let i = newPosts.length - 1; i >= 0; i -= 1) {
          const card = renderPost(newPosts[i]);
          card.classList.add('is-new');
          setTimeout(() => card.classList.remove('is-new'), 700);
          this.timelineFeed.prepend(card);
        }

        const delta = this.timelineFeed.scrollHeight - prevScrollHeight;
        this.timelineFeed.scrollTop = isNearTop ? 0 : (prevScrollTop + delta);
      }

      this.cachedPosts = timelinePosts;
      this.cachedTimelineFilter = this.activeFilter;
    } catch (err) {
      this.timelineFeed.innerHTML = `<div class="loading-text">타임라인을 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
    }
  }

  mergeCommonTimelinePosts(posts) {
    const mergedByKey = new Map();

    for (const post of posts) {
      const key = this.getPostDedupeKey(post);
      const account = this.store.getById(post.accountId);
      const marker = {
        accountId: post.accountId,
        label: account?.label || account?.profile?.displayName || post.accountId,
        color: this.getAccountMarkerColor(post.accountId),
      };

      if (!mergedByKey.has(key)) {
        mergedByKey.set(key, {
          ...post,
          dedupeKey: key,
          sourceAccounts: [marker],
        });
        continue;
      }

      const existing = mergedByKey.get(key);
      if (!existing.sourceAccounts.some((item) => item.accountId === marker.accountId)) {
        existing.sourceAccounts.push(marker);
      }
    }

    return [...mergedByKey.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getPostDedupeKey(post) {
    const canonical = post.reblog || post;
    const canonicalRaw = canonical.raw || {};
    const canonicalId = canonicalRaw.id || canonical.id || post.targetPostId || post.id;
    const canonicalUri = canonicalRaw.uri || canonicalRaw.url || canonical.url || post.url || '';
    const canonicalAuthor = canonical.author?.acct || canonical.author?.username || '';

    if (canonicalUri) {
      return `${post.platform}:uri:${canonicalUri}`;
    }

    return `${post.platform}:id:${canonicalId}:author:${canonicalAuthor}`;
  }

  getAccountMarkerColor(accountId = '') {
    let hash = 0;
    for (let i = 0; i < accountId.length; i += 1) {
      hash = ((hash << 5) - hash) + accountId.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 80% 62%)`;
  }


  async loadNotifications() {
    const accounts = this.getFilteredAccounts();
    if (accounts.length === 0) {
      this.notificationsFeed.innerHTML = '<div class="loading-text">표시할 알림이 없습니다.</div>';
      return;
    }

    this.notificationsFeed.innerHTML = '';
    this.notificationsFeed.appendChild(renderLoading());

    try {
      const allNotifs = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];

          if (account.platform === 'mastodon') {
            const notifs = await client.getNotifications(30);
            return notifs.map(n => client.normalizeNotification(n));
          } else {
            const notifs = await client.getNotifications(30);
            return notifs.map(n => client.normalizeNotification(n));
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allNotifs.push(...result.value);
        }
      }

      allNotifs.sort((a, b) => b.createdAt - a.createdAt);

      this.notificationsFeed.innerHTML = '';

      if (allNotifs.length === 0) {
        this.notificationsFeed.appendChild(renderLoadingText('새 알림이 없습니다.'));
        return;
      }

      for (const notif of allNotifs) {
        this.notificationsFeed.appendChild(renderNotification(notif));
      }
    } catch (err) {
      this.notificationsFeed.innerHTML = `<div class="loading-text">알림을 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
    }
  }

  getFilteredAccounts() {
    if (this.activeFilter === 'all') {
      return this.store.getAll();
    }
    const account = this.store.getById(this.activeFilter);
    return account ? [account] : [];
  }

  findPostUrl(postId, platform) {
    if (!this.cachedPosts) return null;
    const post = this.cachedPosts.find(p => p.id === postId && p.platform === platform);
    return post?.url || null;
  }

  findPost(postId, platform, accountId = '') {
    if (!this.cachedPosts) return null;
    return this.cachedPosts.find(p => p.id === postId
      && p.platform === platform
      && (!accountId || p.accountId === accountId)) || null;
  }

  async handlePostAction(action, card, btn) {
    const postId = card.dataset.postId;
    const platform = card.dataset.platform;
    const accountId = card.dataset.accountId || '';
    const targetPostId = card.dataset.targetPostId || postId;
    const postUrl = card.dataset.postUrl || this.findPostUrl(postId, platform);

    if (action === 'open') {
      if (postUrl) window.open(postUrl, '_blank', 'noopener');
      return;
    }

    const account = this.store.getById(accountId);
    const client = this.store.getClient(accountId);
    if (!account || !client) {
      alert('해당 계정 클라이언트를 찾을 수 없습니다.');
      return;
    }

    btn.disabled = true;
    const originalTitle = btn.title;
    btn.title = '처리 중...';

    try {
      if (action === 'reply') {
        const text = prompt('댓글 내용을 입력하세요');
        if (!text || !text.trim()) return;
        if (account.platform === 'mastodon') {
          await client.createStatus(text.trim(), targetPostId);
        } else {
          await client.createNote(text.trim(), targetPostId);
        }
        this.bumpPostCounter(postId, platform, accountId, 'replies', 1);
        this.animateAction(btn, 'reply');
      }

      if (action === 'fav') {
        if (account.platform === 'mastodon') {
          await client.favourite(targetPostId);
        } else {
          await client.createReaction(targetPostId, '❤');
        }
        this.bumpPostCounter(postId, platform, accountId, account.platform === 'mastodon' ? 'favourites' : 'reactions', 1);
        this.animateAction(btn, 'fav');
      }

      if (action === 'boost') {
        if (account.platform === 'mastodon') {
          await client.reblog(targetPostId);
        } else {
          await client.renote(targetPostId);
        }
        this.bumpPostCounter(postId, platform, accountId, account.platform === 'mastodon' ? 'reblogs' : 'renotes', 1);
        this.animateAction(btn, 'boost');
      }

      await this.refreshSinglePostCard(postId, platform, accountId, targetPostId);
    } catch (err) {
      alert(`작업 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.title = originalTitle;
    }
  }

  bumpPostCounter(postId, platform, accountId, key, amount = 1) {
    const post = this.findPost(postId, platform, accountId);
    if (!post) return;
    post.stats = post.stats || {};
    post.stats[key] = (post.stats[key] || 0) + amount;

    const card = this.timelineFeed?.querySelector(`.post-card[data-post-id="${postId}"][data-platform="${platform}"][data-account-id="${accountId}"]`)
      || this.timelineFeed?.querySelector(`.post-card[data-post-id="${postId}"][data-platform="${platform}"]`);
    if (!card) return;

    const action = key === 'replies' ? 'reply' : (key === 'reblogs' || key === 'renotes') ? 'boost' : 'fav';
    const actionBtn = card.querySelector(`.post-action[data-action="${action}"]`);
    if (!actionBtn) return;

    let count = actionBtn.querySelector('.post-action-count');
    if (!count) {
      count = document.createElement('span');
      count.className = 'post-action-count';
      actionBtn.appendChild(count);
    }
    const value = post.stats[key] || 0;
    count.textContent = String(value);
  }

  animateAction(btn, action) {
    btn.classList.remove('is-pop', 'is-active');
    btn.classList.add('is-pop', 'is-active', `is-${action}`);
    setTimeout(() => {
      btn.classList.remove('is-pop');
    }, 260);
  }

  async refreshSinglePostCard(postId, platform, accountId, targetPostId) {
    const account = this.store.getById(accountId);
    const client = this.store.getClient(accountId);
    if (!account || !client) return;

    let refreshed = null;
    if (account.platform === 'mastodon') {
      const status = await client.getStatus(targetPostId);
      refreshed = { ...client.normalizePost(status), accountId };
    } else {
      const note = await client.getNote(targetPostId);
      refreshed = { ...client.normalizePost(note), accountId };
    }

    if (!refreshed) return;

    const index = this.cachedPosts?.findIndex(p => p.id === postId && p.platform === platform && p.accountId === accountId);
    if (typeof index === 'number' && index >= 0) {
      this.cachedPosts[index] = refreshed;
    }

    const current = this.timelineFeed?.querySelector(`.post-card[data-post-id="${postId}"][data-platform="${platform}"][data-account-id="${accountId}"]`)
      || this.timelineFeed?.querySelector(`.post-card[data-post-id="${postId}"][data-platform="${platform}"]`);
    if (!current) return;

    const nextCard = renderPost(refreshed);
    current.replaceWith(nextCard);
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

  // ===== Add Account Modal =====

  openAddAccountModal() {
    this.instanceUrl.value = '';
    this.accessToken.value = '';
    this.accountLabel.value = '';
    this.addAccountError.style.display = 'none';
    this.btnConfirmAdd.disabled = false;
    this.btnConfirmAdd.textContent = '수동 토큰으로 추가';
    document.getElementById('manual-token-section').removeAttribute('open');
    this.modalAddAccount.style.display = 'flex';
    this.instanceUrl.focus();
    this.updateOAuthButton();
  }

  updateOAuthButton() {
    this.btnOAuthLogin.textContent = '로그인으로 연결';
  }


  // ===== OAuth / MiAuth 로그인 =====

  async handleOAuthLogin() {
    let platform;
    const rawInstanceUrl = this.instanceUrl.value.trim();

    // 단계별 유효성 검사 → 어떤 필드가 빠졌는지 명확히 안내
    if (!rawInstanceUrl) {
      this.showAddError('인스턴스 URL을 입력하세요. (예: misskey.io)');
      this.instanceUrl.focus();
      return;
    }

    let instanceUrl;
    try {
      instanceUrl = normalizeInstanceUrl(rawInstanceUrl);
    } catch (err) {
      this.showAddError(err.message);
      this.instanceUrl.focus();
      return;
    }

    if (!platform) {
      try {
        platform = await detectPlatform(instanceUrl);
      } catch (err) {
        this.showAddError(err.message);
        this.instanceUrl.focus();
        return;
      }
    }

    this.btnOAuthLogin.disabled = true;
    this.btnOAuthLogin.textContent = '인증 페이지 여는 중...';
    this.addAccountError.style.display = 'none';

    try {
      // 플랫폼에 따라 OAuth 또는 MiAuth 시작
      let popup;
      if (platform === 'mastodon') {
        popup = await startMastodonOAuth(instanceUrl);
      } else {
        popup = await startMiAuth(instanceUrl, platform);
      }

      if (popup) {
        this.btnOAuthLogin.textContent = '인증 대기 중... (팝업에서 로그인하세요)';
      } else {
        // 팝업이 차단되어 리다이렉트된 경우 → 여기 도달 안 함
        return;
      }

      // 팝업에서 인증 완료 메시지 대기
      const result = await waitForAuthCallback();

      // 토큰으로 계정 추가
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

  // ===== 수동 토큰 추가 =====

  async handleAddAccount() {
    let platform;
    const rawInstanceUrl = this.instanceUrl.value.trim();
    const accessToken = this.accessToken.value.trim();
    const label = this.accountLabel.value.trim();

    if (!rawInstanceUrl) {
      this.showAddError('인스턴스 URL을 입력하세요.');
      return;
    }
    if (!accessToken) {
      this.showAddError('액세스 토큰을 입력하세요.');
      return;
    }

    let instanceUrl;
    try {
      instanceUrl = normalizeInstanceUrl(rawInstanceUrl);
    } catch (err) {
      this.showAddError(err.message);
      return;
    }

    if (!platform) {
      try {
        platform = await detectPlatform(instanceUrl);
      } catch (err) {
        this.showAddError(err.message);
        return;
      }
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

  // 리다이렉트 방식 OAuth 콜백 처리 (팝업 차단된 경우)
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
