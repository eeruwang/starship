/**
 * Account Store
 * Manages account persistence in localStorage and provides API client instances.
 */
import { MastodonClient } from './api/mastodon.js';
import { MisskeyClient } from './api/misskey.js';

const STORAGE_KEY = 'starship_accounts';

export class AccountStore {
  constructor() {
    this.accounts = this.load();
    this.clients = new Map();
    this.initClients();
  }

  load() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      const accounts = data ? JSON.parse(data) : [];
      // Mastodon의 theme-color 메타태그는 배경색(#181820/#ffffff)을 반환하므로
      // 기존 저장된 무의미한 색상을 정리
      let dirty = false;
      for (const a of accounts) {
        if (a.themeColor && /^#?([0-9a-f]{6})$/i.test(a.themeColor)) {
          const h = a.themeColor.replace(/^#/, '');
          const brightness = (parseInt(h.substring(0, 2), 16) * 299
            + parseInt(h.substring(2, 4), 16) * 587
            + parseInt(h.substring(4, 6), 16) * 114) / 1000;
          if (brightness < 30 || brightness > 225) {
            a.themeColor = null;
            dirty = true;
          }
        }
      }
      if (dirty) localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
      return accounts;
    } catch {
      return [];
    }
  }

  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.accounts));
  }

  initClients() {
    this.clients.clear();
    for (const account of this.accounts) {
      this.clients.set(account.id, this.createClient(account));
    }
  }

  createClient(account) {
    if (account.platform === 'mastodon') {
      return new MastodonClient(account.instanceUrl, account.accessToken, account.software || 'mastodon');
    }
    return new MisskeyClient(account.instanceUrl, account.accessToken, account.platform);
  }

  normalizeUrl(url) {
    try {
      const u = new URL((url || '').trim().replace(/\/+$/, ''));
      return `${u.protocol}//${u.host.toLowerCase()}`;
    } catch {
      return (url || '').trim().replace(/\/+$/, '').toLowerCase();
    }
  }

  getClient(accountId) {
    return this.clients.get(accountId);
  }

  async addAccount(platform, instanceUrl, accessToken, label = '', software = '') {
    const normalizedUrl = this.normalizeUrl(instanceUrl);
    const client = platform === 'mastodon'
      ? new MastodonClient(normalizedUrl, accessToken, software || 'mastodon')
      : new MisskeyClient(normalizedUrl, accessToken, platform);

    const [profile, themeColor] = await Promise.all([
      client.verifyCredentials(),
      client.fetchThemeColor().catch(() => null),
    ]);

    // 중복 계정 확인: 같은 인스턴스(정규화) + 같은 유저 ID
    const existing = this.accounts.find(a =>
      this.normalizeUrl(a.instanceUrl) === normalizedUrl && a.profile?.id === profile.id
    );
    if (existing) {
      const name = existing.profile?.displayName || existing.label || existing.profile?.username;
      throw new Error(`이미 연결된 계정입니다: ${name}`);
    }

    let account;
    if (platform === 'mastodon') {
      account = {
        id: `mastodon_${profile.id}_${Date.now()}`,
        platform,
        software: software || platform,
        instanceUrl: normalizedUrl,
        accessToken,
        themeColor,
        label: label || profile.display_name || profile.username,
        profile: {
          id: profile.id,
          username: profile.username,
          displayName: profile.display_name || profile.username,
          acct: profile.acct,
          avatarUrl: profile.avatar,
          followersCount: profile.followers_count,
          followingCount: profile.following_count,
          statusesCount: profile.statuses_count,
        },
      };
    } else {
      account = {
        id: `${platform}_${profile.id}_${Date.now()}`,
        platform,
        software: software || platform,
        instanceUrl: normalizedUrl,
        accessToken,
        themeColor,
        label: label || profile.name || profile.username,
        profile: {
          id: profile.id,
          username: profile.username,
          displayName: profile.name || profile.username,
          acct: profile.username,
          avatarUrl: profile.avatarUrl,
          followersCount: profile.followersCount,
          followingCount: profile.followingCount,
          notesCount: profile.notesCount,
        },
      };
    }

    this.accounts.push(account);
    this.clients.set(account.id, client);
    this.save();
    return account;
  }

  async refreshAllProfiles() {
    const updates = [];
    for (const account of this.accounts) {
      const client = this.clients.get(account.id);
      if (!client) continue;
      // Fetch theme color if not yet stored
      if (!account.themeColor) {
        updates.push(
          client.fetchThemeColor().then(color => {
            if (color) account.themeColor = color;
          }).catch(() => {})
        );
      }
      updates.push(
        client.verifyCredentials().then(profile => {
          if (account.needsReauth) account.needsReauth = false;
          const oldDisplayName = account.profile?.displayName;
          if (account.platform === 'mastodon') {
            const newDisplayName = profile.display_name || profile.username;
            // Update label if it was auto-set from the old display name
            if (!account.label || account.label === oldDisplayName) {
              account.label = newDisplayName;
            }
            account.profile = {
              id: profile.id,
              username: profile.username,
              displayName: newDisplayName,
              acct: profile.acct,
              avatarUrl: profile.avatar,
              followersCount: profile.followers_count,
              followingCount: profile.following_count,
              statusesCount: profile.statuses_count,
            };
          } else {
            const newDisplayName = profile.name || profile.username;
            if (!account.label || account.label === oldDisplayName) {
              account.label = newDisplayName;
            }
            account.profile = {
              id: profile.id,
              username: profile.username,
              displayName: newDisplayName,
              acct: profile.username,
              avatarUrl: profile.avatarUrl,
              followersCount: profile.followersCount,
              followingCount: profile.followingCount,
              notesCount: profile.notesCount,
            };
          }
        }).catch(err => {
          if (err?.status === 401 || err?.status === 403) {
            account.needsReauth = true;
          }
          console.error(`Profile refresh failed for ${account.label}:`, err);
        })
      );
    }
    await Promise.allSettled(updates);
    this.save();
  }

  removeAccount(accountId) {
    this.accounts = this.accounts.filter(a => a.id !== accountId);
    this.clients.delete(accountId);
    this.save();
  }

  getAll() {
    return [...this.accounts];
  }

  getVisible() {
    return this.accounts.filter(a => !a.hidden);
  }

  reorder(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || toIndex < 0) return;
    if (fromIndex >= this.accounts.length || toIndex >= this.accounts.length) return;
    const [moved] = this.accounts.splice(fromIndex, 1);
    this.accounts.splice(toIndex, 0, moved);
    this.save();
  }

  toggleHidden(accountId) {
    const account = this.accounts.find(a => a.id === accountId);
    if (account) {
      account.hidden = !account.hidden;
      this.save();
    }
    return account;
  }

  getById(accountId) {
    return this.accounts.find(a => a.id === accountId);
  }

  /** Misskey-family platforms support Pages */
  static PAGES_PLATFORMS = new Set(['misskey', 'iceshrimp', 'cherrypick']);

  supportsPages(accountOrId) {
    const account = typeof accountOrId === 'string' ? this.getById(accountOrId) : accountOrId;
    if (!account) return false;
    return AccountStore.PAGES_PLATFORMS.has(account.platform);
  }

  /** Get all accounts that support Pages */
  getPagesAccounts() {
    return this.accounts.filter(a => !a.hidden && AccountStore.PAGES_PLATFORMS.has(a.platform));
  }

  isEmpty() {
    return this.accounts.length === 0;
  }

  replaceAll(accountsData) {
    this.accounts = accountsData;
    this.save();
    this.initClients();
  }
}
