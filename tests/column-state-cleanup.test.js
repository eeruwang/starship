/**
 * Tests: _cleanupAccountColumnState — mirrors main.js.
 *
 * Removing an account must also drop any columnState entries it owned
 * (accounts[id] toggle + `account:${id}` slot in order). Without cleanup,
 * every removed account leaves a dead entry that persists to localStorage
 * and rides along in every cloud-sync payload.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function makeApp(initialState) {
  return {
    columnState: JSON.parse(JSON.stringify(initialState)),
    _saveCount: 0,
    saveColumnState() { this._saveCount++; },
    _cleanupAccountColumnState(accountId) {
      if (!accountId || !this.columnState) return;
      let dirty = false;
      if (this.columnState.accounts && accountId in this.columnState.accounts) {
        delete this.columnState.accounts[accountId];
        dirty = true;
      }
      if (Array.isArray(this.columnState.order)) {
        const key = `account:${accountId}`;
        const filtered = this.columnState.order.filter(k => k !== key);
        if (filtered.length !== this.columnState.order.length) {
          this.columnState.order = filtered;
          dirty = true;
        }
      }
      if (dirty) this.saveColumnState();
    },
  };
}

describe('_cleanupAccountColumnState', () => {
  let app;
  beforeEach(() => {
    app = makeApp({
      all: true,
      notifications: true,
      accounts: { 'a1': true, 'a2': false, 'a3': true },
      order: ['all', 'account:a1', 'notifications', 'account:a3'],
    });
  });

  it('removes accounts[id] entry', () => {
    app._cleanupAccountColumnState('a1');
    assert.equal('a1' in app.columnState.accounts, false);
    assert.equal(app.columnState.accounts.a2, false, 'other entries survive');
    assert.equal(app.columnState.accounts.a3, true);
  });

  it('removes account:id from order', () => {
    app._cleanupAccountColumnState('a1');
    assert.deepEqual(app.columnState.order, ['all', 'notifications', 'account:a3']);
  });

  it('cleans a hidden (toggled-off) account too', () => {
    // a2 is toggled off, so it isn't in order — but IS in accounts. The
    // toggle entry must still be dropped so the account can't resurrect on
    // re-add with the same id.
    app._cleanupAccountColumnState('a2');
    assert.equal('a2' in app.columnState.accounts, false);
    assert.deepEqual(app.columnState.order, ['all', 'account:a1', 'notifications', 'account:a3']);
  });

  it('does not persist when nothing changes (unknown id)', () => {
    const before = app._saveCount;
    app._cleanupAccountColumnState('nonexistent');
    assert.equal(app._saveCount, before, 'no-op when id was never in state');
  });

  it('persists exactly once when work is done', () => {
    const before = app._saveCount;
    app._cleanupAccountColumnState('a1');
    assert.equal(app._saveCount, before + 1);
  });

  it('leaves aggregate columns and other accounts intact', () => {
    app._cleanupAccountColumnState('a1');
    assert.equal(app.columnState.all, true);
    assert.equal(app.columnState.notifications, true);
    assert.ok(app.columnState.order.includes('all'));
    assert.ok(app.columnState.order.includes('notifications'));
    assert.ok(app.columnState.order.includes('account:a3'));
  });

  it('no-op on defensive edge cases', () => {
    assert.doesNotThrow(() => app._cleanupAccountColumnState(null));
    assert.doesNotThrow(() => app._cleanupAccountColumnState(''));
    assert.doesNotThrow(() => app._cleanupAccountColumnState(undefined));
    // State missing pieces
    const bareApp = makeApp({});
    assert.doesNotThrow(() => bareApp._cleanupAccountColumnState('a1'));
  });
});
