/**
 * Account Setup Mixin
 * Handles add account modal, platform detection, OAuth login, manual token, and settings
 */
import { startMastodonOAuth, startMiAuth, waitForAuthCallback, clearPendingAuth, openAuthPopup } from '../auth.js';

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
    this._detectedSoftware = '';
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

  async _fetchNodeInfo(buildUrl, instanceUrl) {
    try {
      const niRes = await fetch(buildUrl(`${instanceUrl}/.well-known/nodeinfo`), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
      if (!niRes.ok) return null;
      const niData = await niRes.json();
      const link = niData.links?.find(l => l.rel?.includes('nodeinfo'));
      if (!link?.href) return null;
      const detailRes = await fetch(buildUrl(link.href), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
      if (!detailRes.ok) return null;
      const detail = await detailRes.json();
      return (detail.software?.name || '').toLowerCase();
    } catch {
      return null;
    }
  },

  _classifyPlatform(softwareName, metaFields) {
    const sw = softwareName || '';
    const name = metaFields?.name || '';
    const version = metaFields?.version || '';
    const metaSw = metaFields?.softwareName || '';

    // Combine all signals for matching
    const signals = [sw, name, version, metaSw].join(' ').toLowerCase();

    // Iceshrimp family
    if (sw === 'iceshrimp' || sw === 'iceshrimp.net' || signals.includes('iceshrimp')) {
      return { platform: 'iceshrimp', software: 'iceshrimp', displayName: 'Iceshrimp' };
    }
    // CherryPick
    if (sw === 'cherrypick' || signals.includes('cherrypick')) {
      return { platform: 'cherrypick', software: 'cherrypick', displayName: 'CherryPick' };
    }
    // Sharkey (Misskey-compatible)
    if (sw === 'sharkey' || signals.includes('sharkey')) {
      return { platform: 'misskey', software: 'sharkey', displayName: 'Sharkey' };
    }
    // Firefish / Catodon (Misskey-compatible, iceshrimp-like)
    if (sw === 'firefish' || signals.includes('firefish')) {
      return { platform: 'iceshrimp', software: 'firefish', displayName: 'Firefish' };
    }
    if (sw === 'catodon' || signals.includes('catodon')) {
      return { platform: 'iceshrimp', software: 'catodon', displayName: 'Catodon' };
    }
    // FoundKey / Hajkey (Misskey-compatible)
    if (sw === 'foundkey' || signals.includes('foundkey')) {
      return { platform: 'misskey', software: 'foundkey', displayName: 'FoundKey' };
    }
    if (sw === 'hajkey' || signals.includes('hajkey')) {
      return { platform: 'misskey', software: 'hajkey', displayName: 'Hajkey' };
    }
    // Vanilla Misskey
    if (sw === 'misskey' || signals.includes('misskey')) {
      return { platform: 'misskey', software: 'misskey', displayName: 'Misskey' };
    }
    // Hollo (Mastodon-compatible, single-user)
    if (sw === 'hollo') return { platform: 'mastodon', software: 'hollo', displayName: 'Hollo' };
    // Mastodon-compatible platforms
    if (sw === 'akkoma') return { platform: 'mastodon', software: 'akkoma', displayName: 'Akkoma' };
    if (sw === 'pleroma') return { platform: 'mastodon', software: 'pleroma', displayName: 'Pleroma' };
    if (sw === 'gotosocial') return { platform: 'mastodon', software: 'gotosocial', displayName: 'GoToSocial' };
    if (sw === 'hometown') return { platform: 'mastodon', software: 'hometown', displayName: 'Hometown' };
    if (sw === 'glitchcafe') return { platform: 'mastodon', software: 'glitchcafe', displayName: 'Glitch' };
    if (sw === 'mastodon') return { platform: 'mastodon', software: 'mastodon', displayName: 'Mastodon' };

    return null;
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

      // Fetch NodeInfo and Misskey /api/meta in parallel for speed
      const [nodeInfoSw, misskeyRes] = await Promise.all([
        this._fetchNodeInfo(buildUrl, instanceUrl),
        fetch(buildUrl(`${instanceUrl}/api/meta`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).catch(() => null),
      ]);

      // If Misskey API responds, it's a Misskey-family server
      if (misskeyRes && misskeyRes.ok) {
        const meta = await misskeyRes.json();
        const metaFields = {
          name: (meta.name || ''),
          version: (meta.version || ''),
          softwareName: (meta.softwareName || ''),
        };

        // Classify using NodeInfo software name + /api/meta fields
        const result = this._classifyPlatform(nodeInfoSw, metaFields)
          || { platform: 'misskey', software: 'misskey', displayName: 'Misskey' };

        this.platformSelect.value = result.platform;
        this._detectedSoftware = result.software;
        detectedEl.textContent = `${result.displayName} 감지됨`;
        detectedEl.className = `detected-platform detected platform-${result.software}`;
        this.updateOAuthButton();
        return;
      }

      // If NodeInfo detected a Mastodon-compatible platform
      if (nodeInfoSw) {
        const result = this._classifyPlatform(nodeInfoSw, null);
        if (result) {
          this.platformSelect.value = result.platform;
          this._detectedSoftware = result.software;
          detectedEl.textContent = `${result.displayName} 감지됨`;
          detectedEl.className = `detected-platform detected platform-${result.software}`;
          this.updateOAuthButton();
          return;
        }
      }

      // Fallback: Try Mastodon API (GET /api/v1/instance). Any server that
      // responds OK here is Mastodon-API compatible — Fedify-based custom
      // forks, future Mastodon-compat servers without a known software name,
      // etc. If NodeInfo gave us a specific identity (e.g. "film-review"),
      // keep it as the software label so account.software stays accurate.
      const mastodonRes = await fetch(buildUrl(`${instanceUrl}/api/v1/instance`), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      }).catch(() => null);

      if (mastodonRes && mastodonRes.ok) {
        // Optionally peek at the body for a version string that names a known
        // fork (e.g. "Hometown 1.x" inside a stock Mastodon-shaped response).
        let detectedSoftware = nodeInfoSw || 'mastodon';
        let displayLabel = nodeInfoSw
          ? `${nodeInfoSw.charAt(0).toUpperCase()}${nodeInfoSw.slice(1)} 감지됨 (Mastodon 호환)`
          : 'Mastodon 감지됨';
        try {
          const meta = await mastodonRes.clone().json();
          const versionStr = (meta.version || '').toLowerCase();
          if (!nodeInfoSw && versionStr) {
            // Substring match against known forks first
            const forkMatch = ['hollo', 'fedibird', 'glitchcafe', 'akkoma', 'pleroma', 'hometown', 'gotosocial']
              .find(s => versionStr.includes(s));
            if (forkMatch) {
              detectedSoftware = forkMatch;
              displayLabel = `${forkMatch.charAt(0).toUpperCase()}${forkMatch.slice(1)} 감지됨 (Mastodon 호환)`;
            }
          }
        } catch { /* body wasn't parseable — proceed with defaults */ }

        this.platformSelect.value = 'mastodon';
        this._detectedSoftware = detectedSoftware;
        detectedEl.textContent = displayLabel;
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

    // Open popup SYNCHRONOUSLY before any async work (iOS blocks window.open after await)
    const popup = openAuthPopup('about:blank');

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
      if (popup) popup.close();
      this.showAddError('플랫폼을 감지할 수 없습니다. 인스턴스 주소를 확인하세요.');
      this.btnOAuthLogin.disabled = false;
      this.btnOAuthLogin.textContent = '로그인으로 연결';
      return;
    }

    this.btnOAuthLogin.textContent = '인증 페이지 여는 중...';

    try {
      if (platform === 'mastodon') {
        await startMastodonOAuth(instanceUrl, popup);
      } else {
        await startMiAuth(instanceUrl, platform, popup);
      }

      if (popup) {
        this.btnOAuthLogin.textContent = '인증 대기 중... (팝업에서 로그인하세요)';
      } else {
        // Popup was blocked → redirect flow (handled by main.js on next page load)
        return;
      }

      const result = await waitForAuthCallback();

      await this.store.addAccount(result.platform, result.instanceUrl, result.accessToken, '', this._detectedSoftware);
      this.closeModal(this.modalAddAccount);
      this.render();
      this.restartStreaming();
      await this.saveToCloud();
    } catch (err) {
      if (popup) popup.close();
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
      await this.store.addAccount(platform, instanceUrl, accessToken, label, this._detectedSoftware);
      this.closeModal(this.modalAddAccount);
      this.render();
      this.restartStreaming();
      await this.saveToCloud();
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
    // Legacy values 'dark'/'light' map onto new palette defaults so existing
    // users don't see an empty select.
    const themeMigrationMap = { dark: 'indigo-night', light: 'daylight' };
    themeSelect.value = themeMigrationMap[this.settings.theme] || this.settings.theme || 'indigo-night';
    themeSelect.onchange = () => {
      this.settings.theme = themeSelect.value;
      this.saveSettings();
      this.applySettings();
    };

    const densitySelect = document.getElementById('setting-density');
    if (densitySelect) {
      densitySelect.value = this.settings.density || 'comfortable';
      densitySelect.onchange = () => {
        this.settings.density = densitySelect.value;
        this.saveSettings();
        this.applySettings();
      };
    }

    const mfmSelect = document.getElementById('setting-mfm');
    if (mfmSelect) {
      mfmSelect.value = this.settings.mfm || 'hover';
      mfmSelect.onchange = () => {
        this.settings.mfm = mfmSelect.value;
        this.saveSettings();
        import('../ui/mfm-motion.js').then(m => m.setMfmMotion(mfmSelect.value));
      };
    }

    resetBtn.onclick = () => {
      if (confirm('정말로 모든 데이터를 초기화하시겠습니까?\n계정 정보, 설정이 모두 삭제됩니다.')) {
        localStorage.clear();
        location.reload();
      }
    };

    this.openModal(modal);
  },

};
