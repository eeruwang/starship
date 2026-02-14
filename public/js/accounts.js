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
      return new MastodonClient(account.instanceUrl, account.accessToken);
    }
    return new MisskeyClient(account.instanceUrl, account.accessToken, account.platform);
  }

  getClient(accountId) {
    return this.clients.get(accountId);
  }

  async addAccount(platform, instanceUrl, accessToken, label = '', software = '') {
    const client = platform === 'mastodon'
      ? new MastodonClient(instanceUrl, accessToken)
      : new MisskeyClient(instanceUrl, accessToken, platform);

    const [profile, themeColor] = await Promise.all([
      client.verifyCredentials(),
      client.fetchThemeColor().catch(() => null),
    ]);

    // 중복 계정 확인: 같은 인스턴스 + 같은 유저 ID
    const normalizedUrl = instanceUrl.replace(/\/+$/, '');
    const existing = this.accounts.find(a =>
      a.instanceUrl === normalizedUrl && a.profile?.id === profile.id
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
        instanceUrl: instanceUrl.replace(/\/+$/, ''),
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
        instanceUrl: instanceUrl.replace(/\/+$/, ''),
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

  isEmpty() {
    return this.accounts.length === 0;
  }

  replaceAll(accountsData) {
    this.accounts = accountsData;
    this.save();
    this.initClients();
  }
}
