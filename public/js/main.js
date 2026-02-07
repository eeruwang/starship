/**
 * StarShip - Main Application
 * Fediverse multi-account dashboard for Misskey, Iceshrimp, CherryPick, and Mastodon.
 */
import { AccountStore } from './accounts.js';
import { renderPost, renderNotification, renderAccountCard, renderLoading, renderLoadingText } from './ui/dashboard.js';
import { startMastodonOAuth, startMiAuth, waitForAuthCallback, clearPendingAuth } from './auth.js';

class StarShipApp {
  constructor() {
    this.store = new AccountStore();
    this.activeFilter = 'all'; // 'all' or account id
    this.autoRefreshTimer = null;
    this.AUTO_REFRESH_INTERVAL = 60000; // 1 minute

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
    this.platformSelect = document.getElementById('platform-select');
    this.instanceUrl = document.getElementById('instance-url');
    this.accessToken = document.getElementById('access-token');
    this.accountLabel = document.getElementById('account-label');
    this.btnConfirmAdd = document.getElementById('btn-confirm-add');
    this.addAccountError = document.getElementById('add-account-error');
    this.tokenHint = document.getElementById('token-hint');

    this.btnAddFirst = document.getElementById('btn-add-first');

    // OAuth
    this.btnOAuthLogin = document.getElementById('btn-oauth-login');
  }

  bindEvents() {
    // Open add account modal
    this.btnAddAccount.addEventListener('click', () => this.openAddAccountModal());
    this.btnAddFirst?.addEventListener('click', () => this.openAddAccountModal());

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

    // Platform select → update hints and enable OAuth button
    this.platformSelect.addEventListener('change', () => {
      this.updateTokenHint();
      this.updateOAuthButton();
    });

    // Instance URL change → enable OAuth button
    this.instanceUrl.addEventListener('input', () => {
      this.updateOAuthButton();
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

    // Post action: open link (delegated)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.post-action[data-action="open"]');
      if (!btn) return;
      const card = btn.closest('.post-card');
      if (!card) return;
      const postUrl = this.findPostUrl(card.dataset.postId, card.dataset.platform);
      if (postUrl) window.open(postUrl, '_blank', 'noopener');
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
      return;
    }

    this.timelineFeed.innerHTML = '';
    this.timelineFeed.appendChild(renderLoading());

    try {
      const allPosts = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];

          const timeline = await client.getHomeTimeline(30);
          const posts = timeline.map(item => client.normalizePost(item));

          // Attach source account info
          for (const post of posts) {
            post._seenBy = [{
              platform: account.platform,
              avatarUrl: account.profile.avatarUrl,
              label: account.label || account.profile.displayName,
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

      // Deduplicate: merge duplicate notes seen from multiple accounts
      const seen = new Map();
      const uniquePosts = [];
      for (const post of allPosts) {
        const key = post.uri || post.url;
        if (!key) {
          uniquePosts.push(post);
          continue;
        }
        const existing = seen.get(key);
        if (existing) {
          // Merge seenBy from duplicate into first occurrence
          if (post._seenBy) {
            existing._seenBy.push(...post._seenBy);
          }
        } else {
          seen.set(key, post);
          uniquePosts.push(post);
        }
      }

      this.timelineFeed.innerHTML = '';

      if (uniquePosts.length === 0) {
        this.timelineFeed.appendChild(renderLoadingText('타임라인에 표시할 게시물이 없습니다.'));
        return;
      }

      // Store posts for URL lookup
      this.cachedPosts = uniquePosts;

      for (const post of uniquePosts) {
        this.timelineFeed.appendChild(renderPost(post));
      }
    } catch (err) {
      this.timelineFeed.innerHTML = `<div class="loading-text">타임라인을 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
    }
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

  // ===== OAuth / MiAuth 로그인 =====

  async handleOAuthLogin() {
    const platform = this.platformSelect.value;
    const instanceUrl = this.instanceUrl.value.trim();

    // 단계별 유효성 검사 → 어떤 필드가 빠졌는지 명확히 안내
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
    const platform = this.platformSelect.value;
    const instanceUrl = this.instanceUrl.value.trim();
    const accessToken = this.accessToken.value.trim();
    const label = this.accountLabel.value.trim();

    if (!platform) {
      this.showAddError('플랫폼을 선택하세요.');
      return;
    }
    if (!instanceUrl) {
      this.showAddError('인스턴스 URL을 입력하세요.');
      return;
    }
    if (!accessToken) {
      this.showAddError('액세스 토큰을 입력하세요.');
      return;
    }

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
