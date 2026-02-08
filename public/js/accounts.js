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
      return data ? JSON.parse(data) : [];
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

  async addAccount(platform, instanceUrl, accessToken, label = '') {
    const client = platform === 'mastodon'
      ? new MastodonClient(instanceUrl, accessToken)
      : new MisskeyClient(instanceUrl, accessToken, platform);

    const profile = await client.verifyCredentials();

    let account;
    if (platform === 'mastodon') {
      account = {
        id: `mastodon_${profile.id}_${Date.now()}`,
        platform,
        instanceUrl: instanceUrl.replace(/\/+$/, ''),
        accessToken,
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
        instanceUrl: instanceUrl.replace(/\/+$/, ''),
        accessToken,
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

  getById(accountId) {
    return this.accounts.find(a => a.id === accountId);
  }

  isEmpty() {
    return this.accounts.length === 0;
  }
}
