/**
 * Auth UI Mixin
 * Handles authentication, user menu, admin UI, and cloud sync
 */
import { escapeHtml } from '../ui/utils.js';
import { usableColor } from '../ui/dashboard.js';
import { startMastodonOAuth, startMiAuth, waitForAuthCallback, clearPendingAuth, openAuthPopup } from '../auth.js';

const SOFTWARE_LABELS = {
  misskey: 'Misskey', sharkey: 'Sharkey', foundkey: 'FoundKey', hajkey: 'Hajkey',
  iceshrimp: 'Iceshrimp', firefish: 'Firefish', catodon: 'Catodon',
  cherrypick: 'CherryPick', mastodon: 'Mastodon', hollo: 'Hollo',
  akkoma: 'Akkoma', pleroma: 'Pleroma', gotosocial: 'GoToSocial',
  hometown: 'Hometown', glitchcafe: 'Glitch',
};

export const AuthUIMixin = {

  async checkAuth() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const data = await res.json();
      if (data.loggedIn) {
        this._currentUser = { username: data.username, role: data.role };
        this.updateAuthButton();
        await this.loadCloudData();
      }
    } catch (err) { console.warn('Auth check failed:', err); }
  },

  async fetchSiteInfo() {
    try {
      const res = await fetch('/api/site-info', { cache: 'no-store' });
      this._siteInfo = await res.json();
      // Update admin UI if already logged in as admin (race condition fix)
      if (this._currentUser?.role === 'admin') {
        this.updateAdminUI();
      }
    } catch (err) { console.warn('Site info fetch failed:', err); }
  },

  updateAuthButton() {
    const isAdmin = this._currentUser?.role === 'admin';
    if (this._currentUser) {
      this.btnAuth.textContent = this._currentUser.username;
      this.btnAuth.classList.add('logged-in');
      this.btnAuth.title = '사용자 메뉴';
      document.getElementById('user-menu-header').textContent = `${this._currentUser.username} 님`;
    } else {
      this.btnAuth.textContent = '로그인';
      this.btnAuth.classList.remove('logged-in');
      this.btnAuth.title = '로그인';
    }
    // Show/hide admin items
    document.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = isAdmin ? '' : 'none';
    });
    if (isAdmin) this.updateAdminUI();
  },

  handleAuthButtonClick() {
    if (this._currentUser) {
      this.toggleUserMenu();
    } else {
      this._authMode = 'login';
      this.updateAuthModal();
      this.openModal(this.modalAuth);
      this.authUsername.focus();
    }
  },

  toggleUserMenu() {
    const menu = document.getElementById('user-menu');
    const wrap = document.getElementById('user-menu-wrap');
    const isOpen = menu.classList.contains('open');
    if (isOpen) {
      this.closeUserMenu();
    } else {
      menu.style.display = 'block';
      requestAnimationFrame(() => menu.classList.add('open'));
      if (this._userMenuOutsideClick) {
        document.removeEventListener('click', this._userMenuOutsideClick, true);
      }
      this._userMenuOutsideClick = (e) => {
        if (!wrap.contains(e.target)) {
          this.closeUserMenu();
        }
      };
      setTimeout(() => document.addEventListener('click', this._userMenuOutsideClick, true), 0);
    }
  },

  closeUserMenu() {
    const menu = document.getElementById('user-menu');
    menu.classList.remove('open');
    menu.addEventListener('transitionend', () => {
      if (!menu.classList.contains('open')) menu.style.display = 'none';
    }, { once: true });
    if (this._userMenuOutsideClick) {
      document.removeEventListener('click', this._userMenuOutsideClick, true);
      this._userMenuOutsideClick = null;
    }
  },

  async handleUserMenuAction(action) {
    this.closeUserMenu();
    switch (action) {
      case 'sync-now':
        await this.saveToCloud();
        break;
      case 'export-data': {
        const data = {
          accounts: this.store.getAll().map(a => ({
            id: a.id, platform: a.platform, software: a.software || a.platform,
            instanceUrl: a.instanceUrl,
            accessToken: a.accessToken, themeColor: a.themeColor,
            label: a.label, profile: a.profile, hidden: a.hidden || false,
          })),
          settings: this.settings,
          columnState: this.columnState,
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `starship-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        break;
      }
      case 'import-data':
        document.getElementById('import-file-input').click();
        break;
      case 'reauth-account':
        this.openReauthAccountPicker();
        break;
      case 'manage-invite-codes':
        this.openInviteCodeModal();
        break;
      case 'logout':
        if (confirm('로그아웃 하시겠습니까?')) {
          await this.logout();
        }
        break;
    }
  },

  async setRegistrationMode(newMode) {
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ registration_mode: newMode }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        this.showToast(data.error || '설정 저장에 실패했습니다');
        return;
      }
      await this.fetchSiteInfo();
      this.updateAdminUI();
    } catch (err) {
      this.showToast('서버 연결 오류');
    }
  },

  updateAdminUI() {
    const mode = this._siteInfo.registrationMode || 'open';
    document.querySelectorAll('.reg-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.regMode === mode);
    });
  },

  toggleAuthMode() {
    this._authMode = this._authMode === 'login' ? 'register' : 'login';
    this.updateAuthModal();
  },

  updateAuthModal() {
    const isLogin = this._authMode === 'login';
    const regMode = this._siteInfo.registrationMode || 'open';
    const regClosed = !isLogin && regMode === 'closed';
    const regInvite = !isLogin && regMode === 'invite';
    this.authModalTitle.textContent = isLogin ? '로그인' : '회원가입';
    this.authSubtitle.textContent = isLogin ? 'StarShip에 오신 것을 환영합니다'
      : regClosed ? '현재 회원가입이 비활성화되어 있습니다'
      : regInvite ? '초대코드가 필요합니다' : '새 계정을 만들어보세요';
    this.authError.style.display = 'none';
    this.authPassword.autocomplete = isLogin ? 'current-password' : 'new-password';
    this.authSwitchText.textContent = isLogin ? '계정이 없으신가요?' : '이미 계정이 있으신가요?';
    this.btnAuthSwitch.textContent = isLogin ? '회원가입' : '로그인';
    // Invite code field
    const inviteField = document.getElementById('auth-invite-field');
    if (inviteField) {
      inviteField.style.display = regInvite ? '' : 'none';
      if (!regInvite) {
        const inviteInput = document.getElementById('auth-invite-code');
        if (inviteInput) inviteInput.value = '';
      }
    }
    // Turnstile: invite 모드에서는 코드 입력 후에만 표시
    const container = document.getElementById('turnstile-container');
    const showTurnstile = !isLogin && this._siteInfo.turnstileSiteKey && !regClosed
      && (!regInvite || (document.getElementById('auth-invite-code')?.value || '').trim().length > 0);
    if (showTurnstile) {
      container.style.display = 'flex';
      this.renderTurnstile();
    } else {
      container.style.display = 'none';
      this.removeTurnstile();
    }
    // invite 코드 입력 시 Turnstile 표시/숨김 갱신
    if (regInvite) {
      const inviteInput = document.getElementById('auth-invite-code');
      if (inviteInput && !inviteInput._turnstileListener) {
        inviteInput._turnstileListener = true;
        inviteInput.addEventListener('input', () => {
          this._updateTurnstileForInvite();
        });
      }
    }
    // Button state
    if (isLogin) {
      this.btnAuthSubmit.disabled = false;
      this.btnAuthSubmit.textContent = '로그인';
    } else if (regClosed) {
      this.btnAuthSubmit.disabled = true;
      this.btnAuthSubmit.textContent = '회원가입 비활성화됨';
    } else {
      this._updateRegisterButtonState();
    }
  },

  renderTurnstile() {
    if (this._turnstileWidgetId != null || !window.turnstile) return;
    const container = document.getElementById('turnstile-container');
    container.innerHTML = '';
    this._turnstileToken = null;
    this._updateRegisterButtonState();
    this._turnstileWidgetId = window.turnstile.render(container, {
      sitekey: this._siteInfo.turnstileSiteKey,
      theme: 'dark',
      callback: (token) => {
        this._turnstileToken = token;
        this._updateRegisterButtonState();
      },
      'expired-callback': () => {
        this._turnstileToken = null;
        this._updateRegisterButtonState();
      },
      'error-callback': () => {
        this._turnstileToken = null;
        this._updateRegisterButtonState();
      },
    });
  },

  removeTurnstile() {
    if (this._turnstileWidgetId != null && window.turnstile) {
      window.turnstile.remove(this._turnstileWidgetId);
      this._turnstileWidgetId = null;
      this._turnstileToken = null;
    }
  },

  _updateRegisterButtonState() {
    if (this._authMode !== 'register') return;
    const needsTurnstile = !!this._siteInfo.turnstileSiteKey;
    const regMode = this._siteInfo.registrationMode || 'open';
    const regInvite = regMode === 'invite';
    const inviteCode = (document.getElementById('auth-invite-code')?.value || '').trim();
    if (regInvite && !inviteCode) {
      this.btnAuthSubmit.disabled = true;
      this.btnAuthSubmit.textContent = '초대코드를 입력해주세요';
    } else if (needsTurnstile && !this._turnstileToken) {
      this.btnAuthSubmit.disabled = true;
      this.btnAuthSubmit.textContent = '인간 확인을 완료해주세요';
    } else {
      this.btnAuthSubmit.disabled = false;
      this.btnAuthSubmit.textContent = '가입하기';
    }
  },

  _updateTurnstileForInvite() {
    const regMode = this._siteInfo.registrationMode || 'open';
    if (regMode !== 'invite') return;
    const inviteCode = (document.getElementById('auth-invite-code')?.value || '').trim();
    const container = document.getElementById('turnstile-container');
    if (inviteCode.length > 0 && this._siteInfo.turnstileSiteKey) {
      container.style.display = 'flex';
      this.renderTurnstile();
    } else {
      container.style.display = 'none';
      this.removeTurnstile();
    }
    this._updateRegisterButtonState();
  },

  async handleAuthSubmit() {
    const username = this.authUsername.value.trim();
    const password = this.authPassword.value;
    if (!username || !password) {
      this.authError.textContent = '아이디와 비밀번호를 입력해주세요';
      this.authError.style.display = 'block';
      return;
    }

    this.btnAuthSubmit.disabled = true;
    this.btnAuthSubmit.textContent = '처리 중...';

    try {
      const endpoint = this._authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username, password,
          ...(this._authMode === 'register' && this._turnstileToken ? { turnstileToken: this._turnstileToken } : {}),
          ...(this._authMode === 'register' ? { inviteCode: (document.getElementById('auth-invite-code')?.value || '').trim() || undefined } : {}),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        this.authError.textContent = data.error || '오류가 발생했습니다';
        this.authError.style.display = 'block';
        if (window.turnstile && this._turnstileWidgetId != null) {
          window.turnstile.reset(this._turnstileWidgetId);
          this._turnstileToken = null;
          this._updateRegisterButtonState();
        }
        return;
      }

      this.removeTurnstile();
      this._currentUser = { username: data.username, role: data.role || 'user' };
      this.updateAuthButton();
      this.closeModal(this.modalAuth);
      this.authUsername.value = '';
      this.authPassword.value = '';

      if (this._authMode === 'register') {
        // New registration: save current local data to cloud
        await this.saveToCloud();
        this.render();
      } else {
        // Login: load cloud data (calls render internally)
        await this.loadCloudData();
      }
    } catch (err) {
      this.authError.textContent = '서버 연결 오류';
      this.authError.style.display = 'block';
    } finally {
      this.updateAuthModal();
    }
  },

  async logout() {
    await this.saveToCloud();
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {}
    this._currentUser = null;
    // Stop background timers
    this.stopAutoRefresh();
    clearTimeout(this._syncDebounce);
    this._syncDebounce = null;
    // Clear caches
    this.postCache.clear();
    this._ogCache.clear();
    // Clear local data
    this.store.replaceAll([]);
    this.stopStreaming();
    this.columnState = { all: true, notifications: true, accounts: {}, columnOrder: [] };
    this.saveColumnState();
    this.columnsContainer.innerHTML = '';
    this.updateAuthButton();
    this.render();
  },

  async saveToCloud() {
    if (!this._currentUser) return;
    try {
      await fetch('/api/sync/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          accounts: this.store.getAll().map(a => ({
            id: a.id, platform: a.platform, software: a.software || a.platform,
            instanceUrl: a.instanceUrl,
            accessToken: a.accessToken, themeColor: a.themeColor,
            label: a.label, profile: a.profile, hidden: a.hidden || false,
          })),
          settings: this.settings,
          columnState: this.columnState,
        }),
      });
    } catch (err) {
      console.error('Cloud save failed:', err);
    }
  },

  debouncedSaveToCloud() {
    if (!this._currentUser) return;
    clearTimeout(this._syncDebounce);
    this._syncDebounce = setTimeout(() => this.saveToCloud(), 2000);
  },

  async openInviteCodeModal() {
    const modal = document.getElementById('modal-invite-codes');
    this.openModal(modal);
    await this.loadInviteCodes();

    const genBtn = document.getElementById('btn-generate-invites');
    const newBtn = genBtn.cloneNode(true);
    genBtn.replaceWith(newBtn);
    newBtn.addEventListener('click', async () => {
      const count = parseInt(document.getElementById('invite-count').value) || 1;
      const maxUses = parseInt(document.getElementById('invite-max-uses').value) || 1;
      newBtn.disabled = true;
      newBtn.textContent = '생성 중...';
      try {
        const res = await fetch('/api/admin/invite-codes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ count, maxUses }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          this.showToast(data.error || '생성 실패');
          return;
        }
        await this.loadInviteCodes();
      } catch {
        this.showToast('서버 연결 오류');
      } finally {
        newBtn.disabled = false;
        newBtn.textContent = '생성';
      }
    });
  },

  async loadInviteCodes() {
    const list = document.getElementById('invite-list');
    try {
      const res = await fetch('/api/admin/invite-codes', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) { list.innerHTML = '<div class="invite-empty">불러오기 실패</div>'; return; }
      const codes = await res.json();
      if (!codes.length) {
        list.innerHTML = '<div class="invite-empty">초대코드가 없습니다</div>';
        return;
      }
      list.innerHTML = codes.map(c => {
        const full = c.used_count >= c.max_uses;
        return `<div class="invite-item">
          <span class="invite-code" title="클릭하여 복사">${c.code}</span>
          <span class="invite-uses ${full ? 'invite-uses-full' : ''}">${c.used_count}/${c.max_uses}</span>
          <button class="invite-delete" data-code="${c.code}" title="삭제">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>`;
      }).join('');

      // Copy on click
      list.querySelectorAll('.invite-code').forEach(el => {
        el.addEventListener('click', () => {
          navigator.clipboard.writeText(el.textContent.trim()).then(() => {
            const orig = el.textContent;
            el.textContent = '복사됨!';
            setTimeout(() => { el.textContent = orig; }, 1000);
          });
        });
      });
      // Delete
      list.querySelectorAll('.invite-delete').forEach(el => {
        el.addEventListener('click', async () => {
          const code = el.dataset.code;
          try {
            await fetch(`/api/admin/invite-codes/${encodeURIComponent(code)}`, {
              method: 'DELETE', credentials: 'same-origin',
            });
            await this.loadInviteCodes();
          } catch { this.showToast('삭제 실패'); }
        });
      });
    } catch {
      list.innerHTML = '<div class="invite-empty">불러오기 실패</div>';
    }
  },

  openReauthAccountPicker() {
    const accounts = this.store.getAll();

    // Create a simple picker popup
    const existing = document.getElementById('reauth-picker');
    if (existing) existing.remove();

    const picker = document.createElement('div');
    picker.id = 'reauth-picker';
    picker.className = 'reauth-picker-overlay';
    picker.innerHTML = `
      <div class="reauth-picker-modal">
        <div class="reauth-picker-header">
          <h3>계정 관리</h3>
          <p class="reauth-picker-desc">${accounts.length > 0 ? '드래그하여 순서 변경. 클릭하면 재인증. 👁 표시 토글, ✕ 삭제' : '연결된 계정이 없습니다. 아래에서 추가하세요.'}</p>
        </div>
        <div class="reauth-picker-list">
          ${accounts.map((a, i) => {
            const isHidden = !!a.hidden;
            const sw = a.software || a.platform;
            const borderColor = usableColor(a.themeColor, sw);
            const swLabel = SOFTWARE_LABELS[sw] || sw;
            const eyeSvg = isHidden
              ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
              : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
            const orderLabel = i === 0 ? ' <span class="reauth-default-badge">기본</span>' : '';
            const wsConnected = this.streamManager?.isConnected(a.id);
            const wsStatusClass = wsConnected ? 'ws-connected' : 'ws-disconnected';
            const wsStatusTitle = wsConnected ? '스트리밍 연결됨' : '스트리밍 끊김';
            return `
            <div class="reauth-picker-row${isHidden ? ' account-hidden' : ''}" data-account-id="${a.id}" data-index="${i}" draggable="true" style="border-left: 3px solid ${borderColor}; border-radius: var(--radius);">
              <span class="reauth-drag-handle" title="드래그하여 순서 변경">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>
              </span>
              <button class="reauth-picker-item" data-account-id="${a.id}">
                <img class="reauth-picker-avatar" src="${a.profile?.avatarUrl || ''}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
                <div class="reauth-picker-info">
                  <span class="reauth-picker-name">${escapeHtml(a.profile?.displayName || a.label || '')}${orderLabel}</span>
                  <span class="reauth-picker-instance">${escapeHtml(a.instanceUrl.replace('https://', ''))}</span>
                </div>
                <span class="ws-status-dot ${wsStatusClass}" data-ws-account-id="${a.id}" title="${wsStatusTitle}"></span>
                <span class="platform-badge ${sw}" style="font-size: 0.65rem; padding: 0.1rem 0.4rem; border-radius: 8px; white-space: nowrap;">${escapeHtml(swLabel)}</span>
              </button>
              <button class="reauth-picker-eye" data-account-id="${a.id}" title="${isHidden ? '전체/알림에 표시' : '전체/알림에서 숨기기'}">
                ${eyeSvg}
              </button>
              <button class="reauth-picker-delete" data-account-id="${a.id}" title="계정 삭제">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          `}).join('')}
        </div>
        <div class="reauth-picker-footer">
          <button class="btn btn-primary btn-small reauth-picker-add">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            계정 추가
          </button>
          <button class="btn btn-secondary btn-small reauth-picker-cancel">닫기</button>
        </div>
      </div>
    `;

    document.body.appendChild(picker);
    requestAnimationFrame(() => picker.classList.add('visible'));

    // Real-time WebSocket status updates
    const updateWsDot = ({ accountId }) => {
      const dot = picker.querySelector(`.ws-status-dot[data-ws-account-id="${accountId}"]`);
      if (!dot) return;
      const connected = this.streamManager?.isConnected(accountId);
      dot.className = `ws-status-dot ${connected ? 'ws-connected' : 'ws-disconnected'}`;
      dot.title = connected ? '스트리밍 연결됨' : '스트리밍 끊김';
    };
    this.streamManager?.on('connected', updateWsDot);
    this.streamManager?.on('disconnected', updateWsDot);

    // Close
    const close = () => {
      this.streamManager?.off('connected', updateWsDot);
      this.streamManager?.off('disconnected', updateWsDot);
      picker.classList.remove('visible');
      setTimeout(() => picker.remove(), 200);
      this.saveToCloud();
    };

    picker.querySelector('.reauth-picker-cancel').addEventListener('click', close);
    picker.querySelector('.reauth-picker-add').addEventListener('click', () => {
      close();
      this.openAddAccountModal();
    });
    picker.addEventListener('click', (e) => {
      if (e.target === picker) close();
    });

    // Account click → re-auth
    picker.querySelectorAll('.reauth-picker-item').forEach(item => {
      item.addEventListener('click', async () => {
        const accountId = item.dataset.accountId;
        const account = this.store.getById(accountId);
        if (!account) return;
        close();
        await this.reauthAccount(account);
      });
    });

    // Eye toggle click → toggle visibility in all/notifications
    picker.querySelectorAll('.reauth-picker-eye').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const accountId = btn.dataset.accountId;
        const account = this.store.toggleHidden(accountId);
        if (!account) return;
        const row = btn.closest('.reauth-picker-row');
        const isHidden = !!account.hidden;
        // Update row visual state
        if (row) row.classList.toggle('account-hidden', isHidden);
        btn.title = isHidden ? '전체/알림에 표시' : '전체/알림에서 숨기기';
        btn.innerHTML = isHidden
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        // If hiding, close the account column if open
        if (isHidden && this.columnState.accounts[accountId]) {
          this.columnState.accounts[accountId] = false;
          this.updateColumnOrder(`account:${accountId}`, false);
          this.saveColumnState();
          this.toggleColumnSmooth('account', false, accountId);
        }
        this.debouncedSaveToCloud();
        // Full refresh (like adding a new account)
        this.render();
      });
    });

    // Delete click → remove account
    picker.querySelectorAll('.reauth-picker-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const accountId = btn.dataset.accountId;
        const account = this.store.getById(accountId);
        if (!account) return;
        const name = account.profile?.displayName || account.label || accountId;
        if (!confirm(`"${name}" 계정을 삭제하시겠습니까?\n이 계정의 연결이 해제됩니다.`)) return;
        this.store.removeAccount(accountId);
        this.streamManager?.disconnect(accountId);
        this.debouncedSaveToCloud();
        // Remove the row from the picker
        const row = btn.closest('.reauth-picker-row');
        if (row) row.remove();
        // If no accounts left, close picker and re-render
        if (this.store.isEmpty()) {
          close();
        }
        this.render();
      });
    });

    // Drag-and-drop reordering
    const list = picker.querySelector('.reauth-picker-list');
    let dragRow = null;
    list.addEventListener('dragstart', (e) => {
      dragRow = e.target.closest('.reauth-picker-row');
      if (!dragRow) return;
      dragRow.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
    });
    list.addEventListener('dragend', () => {
      if (dragRow) dragRow.classList.remove('dragging');
      list.querySelectorAll('.reauth-picker-row').forEach(r => r.classList.remove('drag-over'));
      dragRow = null;
    });
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = e.target.closest('.reauth-picker-row');
      if (!target || target === dragRow) return;
      list.querySelectorAll('.reauth-picker-row').forEach(r => r.classList.remove('drag-over'));
      target.classList.add('drag-over');
    });
    list.addEventListener('dragleave', (e) => {
      const target = e.target.closest('.reauth-picker-row');
      if (target) target.classList.remove('drag-over');
    });
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      const target = e.target.closest('.reauth-picker-row');
      if (!target || !dragRow || target === dragRow) return;
      const fromIndex = parseInt(dragRow.dataset.index);
      const toIndex = parseInt(target.dataset.index);
      this.store.reorder(fromIndex, toIndex);
      this.debouncedSaveToCloud();
      this.render();
      // Re-open picker with updated order
      close();
      setTimeout(() => this.openReauthAccountPicker(), 220);
    });
  },

  async reauthAccount(account) {
    // Open popup SYNCHRONOUSLY (iOS blocks window.open after await)
    const popup = openAuthPopup('about:blank');

    try {
      if (account.platform === 'mastodon') {
        await startMastodonOAuth(account.instanceUrl, popup);
      } else {
        await startMiAuth(account.instanceUrl, account.platform, popup);
      }

      if (!popup) return;

      const result = await waitForAuthCallback();

      // Update the existing account's token
      account.accessToken = result.accessToken;
      // Recreate the client with new token
      const newClient = this.store.createClient(account);
      this.store.clients.set(account.id, newClient);

      // Re-verify credentials, fetch theme color, and detect software
      const client = this.store.getClient(account.id);
      if (client) {
        try {
          const [profile, themeColor] = await Promise.all([
            client.verifyCredentials(),
            client.fetchThemeColor().catch(() => null),
          ]);

          if (themeColor) account.themeColor = themeColor;

          // Re-detect software via NodeInfo if not already set
          if (!account.software || account.software === account.platform) {
            const sw = await this._fetchNodeInfo(
              (url) => (window.location.hostname !== 'localhost' ? `/proxy?url=${encodeURIComponent(url)}` : url),
              account.instanceUrl
            );
            if (sw) {
              const classified = this._classifyPlatform(sw, null);
              if (classified) account.software = classified.software;
            }
          }

          if (account.platform === 'mastodon') {
            account.profile = {
              id: profile.id,
              username: profile.username,
              displayName: profile.display_name || profile.username,
              acct: profile.acct,
              avatarUrl: profile.avatar,
              followersCount: profile.followers_count,
              followingCount: profile.following_count,
              statusesCount: profile.statuses_count,
            };
          } else {
            const me = profile;
            account.profile = {
              id: me.id,
              username: me.username,
              displayName: me.name || me.username,
              acct: me.host ? `${me.username}@${me.host}` : me.username,
              avatarUrl: me.avatarUrl,
              followersCount: me.followersCount,
              followingCount: me.followingCount,
              notesCount: me.notesCount,
            };
          }
        } catch {}
      }

      this.store.save();
      this.showToast(`${account.profile?.displayName || account.label} 계정이 재인증되었습니다.`, 'success');
      this.render();
      await this.saveToCloud();
    } catch (err) {
      if (popup) popup.close();
      clearPendingAuth();
      this.showToast(`재인증 실패: ${err.message}`);
    }
  },

  async loadCloudData() {
    if (!this._currentUser) return;
    try {
      const res = await fetch('/api/sync/load', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();

      if (data.accounts && data.accounts.length > 0) {
        // Replace local accounts with cloud data
        this.store.replaceAll(data.accounts);
      }
      if (data.settings) {
        this.settings = { ...this.settings, ...data.settings };
        this.saveSettings();
        this.applySettings();
      }
      if (data.columnState) {
        this.columnState = data.columnState;
        this.saveColumnState();
      }
      // Re-render with cloud data
      this.render();
      this.restartStreaming();
    } catch (err) {
      console.error('Cloud load failed:', err);
    }
  },

};
