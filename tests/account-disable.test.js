/**
 * Tests: Server Account Disable (Column Toggle Off) Behavior
 *
 * Verifies that when a server account's column is toggled off (hidden),
 * all related features are properly affected.
 *
 * Key findings tested here:
 * - Individual account column is correctly hidden
 * - columnState is properly updated and persisted
 * - "전체" (All) and "알림" (Notifications) columns still include hidden accounts (BUG)
 * - Compose modal still shows hidden accounts (BUG)
 * - Post action account picker still shows hidden accounts (BUG)
 * - Auto-refresh still fetches data for hidden accounts via aggregate columns (BUG)
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ============================================================
// Mock helpers – simulate the core logic from main.js
// without requiring a browser DOM
// ============================================================

function createMockAccount(id, platform = 'mastodon', label = '') {
  return {
    id,
    platform,
    instanceUrl: `https://${platform}.example.com`,
    accessToken: 'tok_' + id,
    themeColor: null,
    label: label || `Account ${id}`,
    profile: {
      id: id.split('_')[1] || id,
      username: `user_${id}`,
      displayName: label || `Account ${id}`,
      acct: `user_${id}`,
      avatarUrl: `https://example.com/avatar/${id}.png`,
    },
  };
}

function createMockStore(accounts) {
  const _accounts = [...accounts];
  const _clients = new Map();
  for (const a of _accounts) {
    _clients.set(a.id, {
      getHomeTimeline: async () => [],
      getNotifications: async () => [],
    });
  }
  return {
    getAll: () => [..._accounts],
    getById: (id) => _accounts.find(a => a.id === id),
    getClient: (id) => _clients.get(id),
    isEmpty: () => _accounts.length === 0,
  };
}

/** Minimal columnState manager mirroring logic from main.js lines 83-112, 906-992 */
class ColumnStateManager {
  constructor(store) {
    this.store = store;
    this.columnState = { all: true, notifications: true, accounts: {}, order: ['all', 'notifications'] };
    this._savedStates = []; // track saves for assertion
  }

  /** Mirrors main.js render() lines 906-912: ensure all accounts have entry */
  ensureAccountEntries() {
    for (const account of this.store.getAll()) {
      if (!(account.id in this.columnState.accounts)) {
        this.columnState.accounts[account.id] = false; // Not shown by default
      }
    }
    this.saveColumnState();
  }

  saveColumnState() {
    this._savedStates.push(JSON.parse(JSON.stringify(this.columnState)));
  }

  /** Mirrors handleToggleClick for account type (main.js lines 972-979) */
  toggleAccount(accountId) {
    this.columnState.accounts[accountId] = !this.columnState.accounts[accountId];
    this.updateColumnOrder(`account:${accountId}`, this.columnState.accounts[accountId]);
    this.saveColumnState();
  }

  /** Mirrors handleToggleClick for 'all' (main.js lines 960-965) */
  toggleAll() {
    this.columnState.all = !this.columnState.all;
    this.updateColumnOrder('all', this.columnState.all);
    this.saveColumnState();
  }

  /** Mirrors handleToggleClick for 'notifications' (main.js lines 966-971) */
  toggleNotifications() {
    this.columnState.notifications = !this.columnState.notifications;
    this.updateColumnOrder('notifications', this.columnState.notifications);
    this.saveColumnState();
  }

  /** Mirrors updateColumnOrder (main.js lines 982-992) */
  updateColumnOrder(key, visible) {
    if (!this.columnState.order) this.columnState.order = [];
    const idx = this.columnState.order.indexOf(key);
    if (visible) {
      if (idx === -1) this.columnState.order.push(key);
    } else {
      if (idx !== -1) this.columnState.order.splice(idx, 1);
    }
  }

  /** Mirrors renderColumns logic (main.js lines 1091-1121) – returns which columns would be rendered */
  getVisibleColumns() {
    const allAccounts = this.store.getAll();
    if (allAccounts.length === 0) return [];

    const result = [];
    const order = this.columnState.order || [];

    for (const key of order) {
      if (key === 'all' && this.columnState.all) {
        result.push({ type: 'all', accounts: allAccounts });
      } else if (key === 'notifications' && this.columnState.notifications) {
        result.push({ type: 'notifications', accounts: allAccounts });
      } else if (key.startsWith('account:')) {
        const accountId = key.slice('account:'.length);
        if (this.columnState.accounts[accountId]) {
          const account = this.store.getById(accountId);
          if (account) {
            result.push({ type: 'account', accountId, accounts: [account] });
          }
        }
      }
    }
    return result;
  }

  /** Mirrors refreshAll (data-loading.js lines 9-60): returns which accounts are fetched per column */
  getRefreshTargets() {
    const columns = this.getVisibleColumns();
    return columns.map(col => ({
      type: col.type,
      accountId: col.accountId || null,
      fetchedAccountIds: col.accounts.map(a => a.id),
    }));
  }

  /** Mirrors compose modal logic (compose.js lines 9-11): returns accounts shown in compose */
  getComposeAccounts() {
    return this.store.getAll();
  }

  /** Mirrors post-actions (post-actions.js line 11): returns accounts for account picker */
  getPostActionAccounts() {
    return this.store.getAll();
  }

  isAccountColumnVisible(accountId) {
    return this.columnState.accounts[accountId] === true;
  }
}


// ============================================================
// Tests
// ============================================================

describe('Account Disable – Column State Management', () => {
  let store, manager;
  const account1 = createMockAccount('mastodon_111_1000', 'mastodon', 'Alice');
  const account2 = createMockAccount('misskey_222_2000', 'misskey', 'Bob');

  beforeEach(() => {
    store = createMockStore([account1, account2]);
    manager = new ColumnStateManager(store);
  });

  it('new accounts should be hidden by default', () => {
    manager.ensureAccountEntries();
    assert.equal(manager.columnState.accounts[account1.id], false);
    assert.equal(manager.columnState.accounts[account2.id], false);
  });

  it('new accounts should NOT be in the column order', () => {
    manager.ensureAccountEntries();
    assert.ok(!manager.columnState.order.includes(`account:${account1.id}`));
    assert.ok(!manager.columnState.order.includes(`account:${account2.id}`));
  });

  it('toggling an account on should set visibility to true and add to order', () => {
    manager.ensureAccountEntries();
    manager.toggleAccount(account1.id);

    assert.equal(manager.columnState.accounts[account1.id], true);
    assert.ok(manager.columnState.order.includes(`account:${account1.id}`));
  });

  it('toggling an account off should set visibility to false and remove from order', () => {
    manager.ensureAccountEntries();
    // Turn on then off
    manager.toggleAccount(account1.id);
    manager.toggleAccount(account1.id);

    assert.equal(manager.columnState.accounts[account1.id], false);
    assert.ok(!manager.columnState.order.includes(`account:${account1.id}`));
  });

  it('toggle should persist (saveColumnState called)', () => {
    manager.ensureAccountEntries();
    const savesBeforeToggle = manager._savedStates.length;
    manager.toggleAccount(account1.id);
    assert.ok(manager._savedStates.length > savesBeforeToggle, 'saveColumnState should have been called');
  });

  it('toggling off should not remove account from store', () => {
    manager.ensureAccountEntries();
    manager.toggleAccount(account1.id); // on
    manager.toggleAccount(account1.id); // off

    // Account is still in the store
    assert.ok(store.getById(account1.id), 'account should still exist in store');
    assert.equal(store.getAll().length, 2, 'store should still have 2 accounts');
  });
});


describe('Account Disable – Column Rendering', () => {
  let store, manager;
  const account1 = createMockAccount('mastodon_111_1000', 'mastodon', 'Alice');
  const account2 = createMockAccount('misskey_222_2000', 'misskey', 'Bob');

  beforeEach(() => {
    store = createMockStore([account1, account2]);
    manager = new ColumnStateManager(store);
    manager.ensureAccountEntries();
  });

  it('hidden account should not have its own column rendered', () => {
    const columns = manager.getVisibleColumns();
    const accountColumns = columns.filter(c => c.type === 'account');
    assert.equal(accountColumns.length, 0, 'no account columns should be rendered when all are hidden');
  });

  it('visible account should have its own column rendered', () => {
    manager.toggleAccount(account1.id);
    const columns = manager.getVisibleColumns();
    const accountColumns = columns.filter(c => c.type === 'account');
    assert.equal(accountColumns.length, 1);
    assert.equal(accountColumns[0].accountId, account1.id);
  });

  it('only visible accounts get individual columns', () => {
    manager.toggleAccount(account1.id);  // Show Alice
    // Bob stays hidden

    const columns = manager.getVisibleColumns();
    const accountColumns = columns.filter(c => c.type === 'account');
    assert.equal(accountColumns.length, 1);
    assert.equal(accountColumns[0].accountId, account1.id);
    assert.ok(!accountColumns.find(c => c.accountId === account2.id), 'hidden account should not have column');
  });
});


describe('Account Disable – "전체" (All) column still includes hidden accounts', () => {
  let store, manager;
  const account1 = createMockAccount('mastodon_111_1000', 'mastodon', 'Alice');
  const account2 = createMockAccount('misskey_222_2000', 'misskey', 'Bob');

  beforeEach(() => {
    store = createMockStore([account1, account2]);
    manager = new ColumnStateManager(store);
    manager.ensureAccountEntries();
  });

  it('"전체" column fetches ALL accounts regardless of column visibility', () => {
    // Both accounts are hidden (default)
    const columns = manager.getVisibleColumns();
    const allColumn = columns.find(c => c.type === 'all');

    assert.ok(allColumn, '"전체" column should exist');
    assert.equal(allColumn.accounts.length, 2, '"전체" passes ALL accounts to loadTimelineForColumn');

    const accountIds = allColumn.accounts.map(a => a.id);
    assert.ok(accountIds.includes(account1.id), 'hidden account1 is still in 전체');
    assert.ok(accountIds.includes(account2.id), 'hidden account2 is still in 전체');
  });

  it('"전체" column still includes account after its column is toggled off', () => {
    manager.toggleAccount(account1.id);  // show
    manager.toggleAccount(account1.id);  // hide again

    const columns = manager.getVisibleColumns();
    const allColumn = columns.find(c => c.type === 'all');
    const accountIds = allColumn.accounts.map(a => a.id);
    assert.ok(accountIds.includes(account1.id), 'toggled-off account still in 전체');
  });
});


describe('Account Disable – "알림" (Notifications) column still includes hidden accounts', () => {
  let store, manager;
  const account1 = createMockAccount('mastodon_111_1000', 'mastodon', 'Alice');
  const account2 = createMockAccount('misskey_222_2000', 'misskey', 'Bob');

  beforeEach(() => {
    store = createMockStore([account1, account2]);
    manager = new ColumnStateManager(store);
    manager.ensureAccountEntries();
  });

  it('"알림" column fetches ALL accounts regardless of column visibility', () => {
    const columns = manager.getVisibleColumns();
    const notifColumn = columns.find(c => c.type === 'notifications');

    assert.ok(notifColumn, '"알림" column should exist');
    assert.equal(notifColumn.accounts.length, 2, '"알림" passes ALL accounts to loadNotificationsForColumn');

    const accountIds = notifColumn.accounts.map(a => a.id);
    assert.ok(accountIds.includes(account1.id), 'hidden account1 is still in 알림');
    assert.ok(accountIds.includes(account2.id), 'hidden account2 is still in 알림');
  });
});


describe('Account Disable – Compose modal still shows hidden accounts', () => {
  let store, manager;
  const account1 = createMockAccount('mastodon_111_1000', 'mastodon', 'Alice');
  const account2 = createMockAccount('misskey_222_2000', 'misskey', 'Bob');

  beforeEach(() => {
    store = createMockStore([account1, account2]);
    manager = new ColumnStateManager(store);
    manager.ensureAccountEntries();
  });

  it('compose modal shows all accounts including hidden ones', () => {
    const composeAccounts = manager.getComposeAccounts();
    assert.equal(composeAccounts.length, 2, 'compose shows ALL accounts');

    const ids = composeAccounts.map(a => a.id);
    assert.ok(ids.includes(account1.id), 'hidden account1 shown in compose');
    assert.ok(ids.includes(account2.id), 'hidden account2 shown in compose');
  });

  it('compose modal still shows account even after column is toggled off', () => {
    manager.toggleAccount(account1.id);  // show
    manager.toggleAccount(account1.id);  // hide

    const composeAccounts = manager.getComposeAccounts();
    assert.ok(composeAccounts.find(a => a.id === account1.id), 'toggled-off account still in compose');
  });
});


describe('Account Disable – Post action picker still shows hidden accounts', () => {
  let store, manager;
  const account1 = createMockAccount('mastodon_111_1000', 'mastodon', 'Alice');
  const account2 = createMockAccount('misskey_222_2000', 'misskey', 'Bob');

  beforeEach(() => {
    store = createMockStore([account1, account2]);
    manager = new ColumnStateManager(store);
    manager.ensureAccountEntries();
  });

  it('post action account picker shows all accounts including hidden ones', () => {
    const actionAccounts = manager.getPostActionAccounts();
    assert.equal(actionAccounts.length, 2);

    const ids = actionAccounts.map(a => a.id);
    assert.ok(ids.includes(account1.id), 'hidden account1 in action picker');
    assert.ok(ids.includes(account2.id), 'hidden account2 in action picker');
  });
});


describe('Account Disable – Auto-refresh behavior', () => {
  let store, manager;
  const account1 = createMockAccount('mastodon_111_1000', 'mastodon', 'Alice');
  const account2 = createMockAccount('misskey_222_2000', 'misskey', 'Bob');

  beforeEach(() => {
    store = createMockStore([account1, account2]);
    manager = new ColumnStateManager(store);
    manager.ensureAccountEntries();
  });

  it('refresh targets hidden accounts through aggregate columns', () => {
    // account1 is hidden, but 전체 and 알림 are visible
    const targets = manager.getRefreshTargets();

    // "전체" column should fetch both accounts
    const allTarget = targets.find(t => t.type === 'all');
    assert.ok(allTarget);
    assert.ok(
      allTarget.fetchedAccountIds.includes(account1.id),
      'hidden account1 still refreshed via 전체'
    );
    assert.ok(
      allTarget.fetchedAccountIds.includes(account2.id),
      'hidden account2 still refreshed via 전체'
    );

    // "알림" column should also fetch both accounts
    const notifTarget = targets.find(t => t.type === 'notifications');
    assert.ok(notifTarget);
    assert.ok(
      notifTarget.fetchedAccountIds.includes(account1.id),
      'hidden account1 still refreshed via 알림'
    );
  });

  it('no individual account column is refreshed when account is hidden', () => {
    const targets = manager.getRefreshTargets();
    const accountTargets = targets.filter(t => t.type === 'account');
    assert.equal(accountTargets.length, 0, 'no individual account columns are refreshed');
  });

  it('visible account gets its own refresh target', () => {
    manager.toggleAccount(account1.id); // show account1
    const targets = manager.getRefreshTargets();
    const accountTargets = targets.filter(t => t.type === 'account');
    assert.equal(accountTargets.length, 1);
    assert.equal(accountTargets[0].accountId, account1.id);
  });
});


describe('Account Disable – Toggling all/notifications columns', () => {
  let store, manager;
  const account1 = createMockAccount('mastodon_111_1000', 'mastodon', 'Alice');

  beforeEach(() => {
    store = createMockStore([account1]);
    manager = new ColumnStateManager(store);
    manager.ensureAccountEntries();
  });

  it('toggling "전체" off removes it from visible columns', () => {
    manager.toggleAll(); // off
    const columns = manager.getVisibleColumns();
    assert.ok(!columns.find(c => c.type === 'all'), '전체 should not be visible');
  });

  it('toggling "알림" off removes it from visible columns', () => {
    manager.toggleNotifications(); // off
    const columns = manager.getVisibleColumns();
    assert.ok(!columns.find(c => c.type === 'notifications'), '알림 should not be visible');
  });

  it('when both 전체 and 알림 are off, hidden account data is NOT fetched', () => {
    manager.toggleAll();
    manager.toggleNotifications();
    // account1 is hidden (default)

    const targets = manager.getRefreshTargets();
    assert.equal(targets.length, 0, 'no columns = no fetches');

    // This is the ONLY way to fully stop fetching for a hidden account
    const allFetchedIds = targets.flatMap(t => t.fetchedAccountIds);
    assert.ok(!allFetchedIds.includes(account1.id), 'account data not fetched');
  });

  it('when only 전체 is on, hidden account IS still fetched', () => {
    manager.toggleNotifications(); // off
    // 전체 is still on, account1 is hidden (default)

    const targets = manager.getRefreshTargets();
    const allFetchedIds = targets.flatMap(t => t.fetchedAccountIds);
    assert.ok(allFetchedIds.includes(account1.id), 'hidden account still fetched via 전체');
  });
});


describe('Account Disable – Column order preservation', () => {
  let store, manager;
  const account1 = createMockAccount('mastodon_111_1000', 'mastodon', 'Alice');
  const account2 = createMockAccount('misskey_222_2000', 'misskey', 'Bob');
  const account3 = createMockAccount('mastodon_333_3000', 'mastodon', 'Charlie');

  beforeEach(() => {
    store = createMockStore([account1, account2, account3]);
    manager = new ColumnStateManager(store);
    manager.ensureAccountEntries();
  });

  it('columns render in order of toggle activation', () => {
    manager.toggleAccount(account2.id); // Bob first
    manager.toggleAccount(account1.id); // Alice second
    manager.toggleAccount(account3.id); // Charlie third

    const columns = manager.getVisibleColumns();
    const accountCols = columns.filter(c => c.type === 'account');
    assert.equal(accountCols[0].accountId, account2.id, 'Bob first');
    assert.equal(accountCols[1].accountId, account1.id, 'Alice second');
    assert.equal(accountCols[2].accountId, account3.id, 'Charlie third');
  });

  it('hiding and showing account moves it to end of order', () => {
    manager.toggleAccount(account1.id); // Alice
    manager.toggleAccount(account2.id); // Bob
    manager.toggleAccount(account1.id); // hide Alice
    manager.toggleAccount(account1.id); // show Alice again (goes to end)

    const columns = manager.getVisibleColumns();
    const accountCols = columns.filter(c => c.type === 'account');
    assert.equal(accountCols[0].accountId, account2.id, 'Bob stays first');
    assert.equal(accountCols[1].accountId, account1.id, 'Alice moves to end');
  });
});


describe('Account Disable – loadColumnState migration', () => {

  it('migrates old format without order array', () => {
    // Simulate old column state format (no order array)
    const oldState = {
      all: true,
      notifications: false,
      accounts: { 'acc_1': true, 'acc_2': false },
    };

    // Migration logic from main.js lines 88-98
    if (!Array.isArray(oldState.order)) {
      oldState.order = [];
      if (oldState.all) oldState.order.push('all');
      if (oldState.notifications) oldState.order.push('notifications');
      if (oldState.accounts) {
        for (const id of Object.keys(oldState.accounts)) {
          if (oldState.accounts[id]) oldState.order.push(`account:${id}`);
        }
      }
    }

    assert.deepEqual(oldState.order, ['all', 'account:acc_1']);
    assert.ok(!oldState.order.includes('notifications'), 'disabled notifications not in order');
    assert.ok(!oldState.order.includes('account:acc_2'), 'hidden account not in order');
  });

  it('default state has all and notifications visible', () => {
    const defaultState = { all: true, notifications: true, accounts: {}, order: ['all', 'notifications'] };
    assert.equal(defaultState.all, true);
    assert.equal(defaultState.notifications, true);
    assert.deepEqual(defaultState.order, ['all', 'notifications']);
  });
});
