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
      // Update admin UI if already logged in as admin (race condition fix)
      if (this._currentUser?.role === 'admin') {
        this.updateAdminUI();
      }
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
        alert(data.error || '설정 저장에 실패했습니다');
        return;
      }
      await this.fetchSiteInfo();
      this.updateAdminUI();
    } catch (err) {
      alert('서버 연결 오류');
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
          alert(data.error || '생성 실패');
          return;
        }
        await this.loadInviteCodes();
      } catch {
        alert('서버 연결 오류');
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
          } catch { alert('삭제 실패'); }
        });
      });
    } catch {
      list.innerHTML = '<div class="invite-empty">불러오기 실패</div>';
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
    } catch (err) {
      console.error('Cloud load failed:', err);
    }
  },

};
