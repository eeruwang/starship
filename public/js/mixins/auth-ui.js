/**
 * Auth UI Mixin
 * Handles authentication, user menu, admin UI, and cloud sync
 */

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
    } catch {}
  },

  async fetchSiteInfo() {
    try {
      const res = await fetch('/api/site-info', { cache: 'no-store' });
      this._siteInfo = await res.json();
    } catch {}
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
      case 'add-account':
        this.openAddAccountModal();
        break;
      case 'sync-now':
        await this.saveToCloud();
        break;
      case 'export-data': {
        const data = {
          accounts: this.store.getAll().map(a => ({
            id: a.id, platform: a.platform, instanceUrl: a.instanceUrl,
            accessToken: a.accessToken, themeColor: a.themeColor,
            label: a.label, profile: a.profile,
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
      case 'toggle-registration':
        await this.toggleRegistration();
        break;
      case 'logout':
        if (confirm('로그아웃 하시겠습니까?')) {
          await this.logout();
        }
        break;
    }
  },

  async toggleRegistration() {
    const newVal = !this._siteInfo.registrationOpen;
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ registration_open: String(newVal) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || '설정 저장에 실패했습니다');
        return;
      }
      // Re-fetch to confirm server state
      await this.fetchSiteInfo();
      this.updateAdminUI();
    } catch (err) {
      alert('서버 연결 오류');
    }
  },

  updateAdminUI() {
    const text = document.getElementById('toggle-reg-text');
    const icon = document.querySelector('#btn-toggle-reg svg line');
    if (this._siteInfo.registrationOpen) {
      text.textContent = '회원가입 닫기';
      if (icon) icon.setAttribute('x1', '23');
    } else {
      text.textContent = '회원가입 열기';
      if (icon) icon.setAttribute('x1', '20');
    }
  },

  toggleAuthMode() {
    this._authMode = this._authMode === 'login' ? 'register' : 'login';
    this.updateAuthModal();
  },

  updateAuthModal() {
    const isLogin = this._authMode === 'login';
    const regClosed = !isLogin && !this._siteInfo.registrationOpen;
    this.authModalTitle.textContent = isLogin ? '로그인' : '회원가입';
    this.authSubtitle.textContent = isLogin ? 'StarShip에 오신 것을 환영합니다'
      : regClosed ? '현재 회원가입이 비활성화되어 있습니다' : '새 계정을 만들어보세요';
    this.authError.style.display = 'none';
    this.authPassword.autocomplete = isLogin ? 'current-password' : 'new-password';
    this.authSwitchText.textContent = isLogin ? '계정이 없으신가요?' : '이미 계정이 있으신가요?';
    this.btnAuthSwitch.textContent = isLogin ? '회원가입' : '로그인';
    // Turnstile
    const container = document.getElementById('turnstile-container');
    if (!isLogin && this._siteInfo.turnstileSiteKey && !regClosed) {
      container.style.display = 'flex';
      this.renderTurnstile();
    } else {
      container.style.display = 'none';
      this.removeTurnstile();
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
    if (needsTurnstile && !this._turnstileToken) {
      this.btnAuthSubmit.disabled = true;
      this.btnAuthSubmit.textContent = '인간 확인을 완료해주세요';
    } else {
      this.btnAuthSubmit.disabled = false;
      this.btnAuthSubmit.textContent = '가입하기';
    }
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
      } else {
        // Login: load cloud data
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
    // Clear local data
    this.store.replaceAll([]);
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
            id: a.id, platform: a.platform, instanceUrl: a.instanceUrl,
            accessToken: a.accessToken, themeColor: a.themeColor,
            label: a.label, profile: a.profile,
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
    } catch (err) {
      console.error('Cloud load failed:', err);
    }
  },

};
