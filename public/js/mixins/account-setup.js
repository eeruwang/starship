/**
 * Account Setup Mixin
 * Handles add account modal, platform detection, OAuth login, manual token, and settings
 */
import { startMastodonOAuth, startMiAuth, waitForAuthCallback, clearPendingAuth } from '../auth.js';

export const AccountSetupMixin = {

  openAddAccountModal() {
    this.platformSelect.value = '';
    this.instanceUrl.value = '';
    this.accessToken.value = '';
    this.accountLabel.value = '';
    this.addAccountError.style.display = 'none';
    this.btnConfirmAdd.disabled = false;
    this.btnConfirmAdd.textContent = '수동 토큰으로 추가';
    this.btnOAuthLogin.textContent = '로그인으로 연결';
    this.detectedPlatformEl = document.getElementById('detected-platform');
    this.detectedPlatformEl.style.display = 'none';
    document.getElementById('manual-token-section').removeAttribute('open');
    this.openModal(this.modalAddAccount);
    this.instanceUrl.focus();
  },

  normalizeInstanceUrl(input) {
    let url = input.trim();
    if (!url) return '';
    // Remove trailing slashes
    url = url.replace(/\/+$/, '');
    // Add https:// if no protocol
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    return url;
  },

  updateOAuthButton() {
    const platform = this.platformSelect.value;
    const labels = {
      misskey: 'Misskey 로그인으로 연결',
      iceshrimp: 'Iceshrimp 로그인으로 연결',
      cherrypick: 'CherryPick 로그인으로 연결',
      mastodon: 'Mastodon 로그인으로 연결',
    };
    this.btnOAuthLogin.textContent = labels[platform] || '로그인으로 연결';
  },

  async autoDetectPlatform() {
    const instanceUrl = this.normalizeInstanceUrl(this.instanceUrl.value);
    if (!instanceUrl) return;

    try {
      new URL(instanceUrl);
    } catch {
      return;
    }

    const detectedEl = document.getElementById('detected-platform');
    detectedEl.style.display = 'block';
    detectedEl.textContent = '플랫폼 감지 중...';
    detectedEl.className = 'detected-platform detecting';

    try {
      const useProxy = window.location.hostname !== 'localhost';
      const buildUrl = (target) => useProxy ? `/proxy?url=${encodeURIComponent(target)}` : target;

      // Try Misskey API first (POST /api/meta)
      const misskeyRes = await fetch(buildUrl(`${instanceUrl}/api/meta`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => null);

      if (misskeyRes && misskeyRes.ok) {
        const meta = await misskeyRes.json();
        let platform = 'misskey';
        let platformName = 'Misskey';

        const name = (meta.name || '').toLowerCase();
        const version = (meta.version || '').toLowerCase();
        const softwareName = (meta.softwareName || '').toLowerCase();

        if (softwareName.includes('iceshrimp') || name.includes('iceshrimp') || version.includes('iceshrimp')) {
          platform = 'iceshrimp';
          platformName = 'Iceshrimp';
        } else if (softwareName.includes('cherrypick') || name.includes('cherrypick') || version.includes('cherrypick')) {
          platform = 'cherrypick';
          platformName = 'CherryPick';
        } else if (softwareName.includes('sharkey') || version.includes('sharkey')) {
          platform = 'misskey';
          platformName = 'Sharkey (Misskey 호환)';
        } else if (softwareName.includes('firefish') || version.includes('firefish')) {
          platform = 'iceshrimp';
          platformName = 'Firefish (Misskey 호환)';
        }

        this.platformSelect.value = platform;
        detectedEl.textContent = `${platformName} 감지됨`;
        detectedEl.className = `detected-platform detected platform-${platform}`;
        this.updateOAuthButton();
        return;
      }

      // Try Mastodon API (GET /api/v1/instance)
      const mastodonRes = await fetch(buildUrl(`${instanceUrl}/api/v1/instance`), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      }).catch(() => null);

      if (mastodonRes && mastodonRes.ok) {
        this.platformSelect.value = 'mastodon';
        detectedEl.textContent = 'Mastodon 감지됨';
        detectedEl.className = 'detected-platform detected platform-mastodon';
        this.updateOAuthButton();
        return;
      }

      detectedEl.textContent = '플랫폼을 감지할 수 없습니다. 인스턴스 주소를 확인하세요.';
      detectedEl.className = 'detected-platform detect-failed';
    } catch {
      detectedEl.textContent = '플랫폼을 감지할 수 없습니다.';
      detectedEl.className = 'detected-platform detect-failed';
    }
  },

  // ===== OAuth / MiAuth =====

  async handleOAuthLogin() {
    const instanceUrl = this.normalizeInstanceUrl(this.instanceUrl.value);

    if (!instanceUrl) {
      this.showAddError('인스턴스 주소를 입력하세요. (예: misskey.io)');
      this.instanceUrl.focus();
      return;
    }

    try {
      new URL(instanceUrl);
    } catch {
      this.showAddError('올바른 주소 형식이 아닙니다. (예: misskey.io)');
      this.instanceUrl.focus();
      return;
    }

    this.btnOAuthLogin.disabled = true;
    this.btnOAuthLogin.textContent = '플랫폼 감지 중...';
    this.addAccountError.style.display = 'none';

    // Auto-detect platform if not already detected
    let platform = this.platformSelect.value;
    if (!platform) {
      await this.autoDetectPlatform();
      platform = this.platformSelect.value;
    }

    if (!platform) {
      this.showAddError('플랫폼을 감지할 수 없습니다. 인스턴스 주소를 확인하세요.');
      this.btnOAuthLogin.disabled = false;
      this.btnOAuthLogin.textContent = '로그인으로 연결';
      return;
    }

    this.btnOAuthLogin.textContent = '인증 페이지 여는 중...';

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
      this.closeModal(this.modalAddAccount);
      this.debouncedSaveToCloud();
      this.render();
    } catch (err) {
      clearPendingAuth();
      this.showAddError(`인증 실패: ${err.message}`);
    } finally {
      this.btnOAuthLogin.disabled = false;
      this.updateOAuthButton();
    }
  },

  // ===== Manual Token =====

  async handleAddAccount() {
    const instanceUrl = this.normalizeInstanceUrl(this.instanceUrl.value);
    const accessToken = this.accessToken.value.trim();
    const label = this.accountLabel.value.trim();

    if (!instanceUrl) {
      this.showAddError('인스턴스 주소를 입력하세요.');
      return;
    }
    if (!accessToken) {
      this.showAddError('액세스 토큰을 입력하세요.');
      return;
    }

    try {
      new URL(instanceUrl);
    } catch {
      this.showAddError('올바른 주소 형식이 아닙니다. (예: misskey.io)');
      return;
    }

    this.btnConfirmAdd.disabled = true;
    this.btnConfirmAdd.textContent = '플랫폼 감지 중...';
    this.addAccountError.style.display = 'none';

    // Auto-detect platform if not already detected
    let platform = this.platformSelect.value;
    if (!platform) {
      await this.autoDetectPlatform();
      platform = this.platformSelect.value;
    }

    if (!platform) {
      this.showAddError('플랫폼을 감지할 수 없습니다. 인스턴스 주소를 확인하세요.');
      this.btnConfirmAdd.disabled = false;
      this.btnConfirmAdd.textContent = '수동 토큰으로 추가';
      return;
    }

    this.btnConfirmAdd.textContent = '연결 확인 중...';

    try {
      await this.store.addAccount(platform, instanceUrl, accessToken, label);
      this.closeModal(this.modalAddAccount);
      this.debouncedSaveToCloud();
      this.render();
    } catch (err) {
      this.showAddError(`연결 실패: ${err.message}`);
    } finally {
      this.btnConfirmAdd.disabled = false;
      this.btnConfirmAdd.textContent = '수동 토큰으로 추가';
    }
  },

  showAddError(message) {
    this.addAccountError.textContent = message;
    this.addAccountError.style.display = 'block';
  },

  // ===== Settings =====

  openSettingsModal() {
    const modal = document.getElementById('modal-settings');
    const refreshSelect = document.getElementById('setting-refresh-interval');
    const columnWidthSelect = document.getElementById('setting-column-width');
    const fontSizeSelect = document.getElementById('setting-font-size');
    const postsCountSelect = document.getElementById('setting-posts-count');
    const resetBtn = document.getElementById('btn-settings-reset');

    // Set values and assign handlers directly (direct assignment replaces previous handler)
    refreshSelect.value = String(this.settings.refreshInterval);
    refreshSelect.onchange = () => {
      this.settings.refreshInterval = parseInt(refreshSelect.value);
      this.AUTO_REFRESH_INTERVAL = this.settings.refreshInterval;
      this.saveSettings();
      this.startAutoRefresh();
    };

    const columnWidthValueLabel = document.getElementById('column-width-value');
    columnWidthSelect.value = String(this.settings.columnWidth);
    if (columnWidthValueLabel) columnWidthValueLabel.textContent = `${this.settings.columnWidth}px`;
    const handleColWidthChange = () => {
      if (columnWidthValueLabel) columnWidthValueLabel.textContent = `${columnWidthSelect.value}px`;
      this.settings.columnWidth = parseInt(columnWidthSelect.value);
      this.saveSettings();
      this.applySettings();
    };
    columnWidthSelect.oninput = handleColWidthChange;
    columnWidthSelect.onchange = handleColWidthChange;

    fontSizeSelect.value = String(this.settings.fontSize);
    fontSizeSelect.onchange = () => {
      this.settings.fontSize = parseInt(fontSizeSelect.value);
      this.saveSettings();
      this.applySettings();
    };

    postsCountSelect.value = String(this.settings.postsCount);
    postsCountSelect.onchange = () => {
      this.settings.postsCount = parseInt(postsCountSelect.value);
      this.saveSettings();
    };

    const themeSelect = document.getElementById('setting-theme');
    themeSelect.value = this.settings.theme || 'dark';
    themeSelect.onchange = () => {
      this.settings.theme = themeSelect.value;
      this.saveSettings();
      this.applySettings();
    };

    resetBtn.onclick = () => {
      if (confirm('정말로 모든 데이터를 초기화하시겠습니까?\n계정 정보, 설정이 모두 삭제됩니다.')) {
        localStorage.clear();
        location.reload();
      }
    };

    this.openModal(modal);
  },

};
