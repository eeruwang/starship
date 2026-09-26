/**
 * Tests: postCache LRU eviction via _setCachedPost.
 *
 * Mirrors data-loading.js:_setCachedPost (line ~2325). Previously every code
 * path that added a single post to postCache called .set() directly, so the
 * eviction loop in cachePosts() was silently bypassed for individual updates.
 * Long-lived sessions leaked memory. The helper wraps every set with an LRU
 * cap enforcement.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Pure reimplementation matching data-loading.js
function makeApp(max) {
  return {
    postCache: new Map(),
    POST_CACHE_MAX: max,
    _setCachedPost(key, post) {
      if (!this.postCache) return;
      this.postCache.set(key, post);
      if (this.postCache.size > this.POST_CACHE_MAX) {
        const toDelete = this.postCache.size - this.POST_CACHE_MAX;
        const keys = this.postCache.keys();
        for (let i = 0; i < toDelete; i++) {
          this.postCache.delete(keys.next().value);
        }
      }
    },
  };
}

describe('_setCachedPost', () => {
  let app;
  beforeEach(() => { app = makeApp(3); });

  it('adds a post under the cap', () => {
    app._setCachedPost('a', { id: 'a' });
    app._setCachedPost('b', { id: 'b' });
    assert.equal(app.postCache.size, 2);
    assert.deepEqual(app.postCache.get('a'), { id: 'a' });
  });

  it('evicts oldest when exceeding cap', () => {
    app._setCachedPost('a', { id: 'a' });
    app._setCachedPost('b', { id: 'b' });
    app._setCachedPost('c', { id: 'c' });
    app._setCachedPost('d', { id: 'd' });
    assert.equal(app.postCache.size, 3);
    assert.equal(app.postCache.has('a'), false, 'oldest evicted');
    assert.equal(app.postCache.has('b'), true);
    assert.equal(app.postCache.has('c'), true);
    assert.equal(app.postCache.has('d'), true);
  });

  it('overwriting an existing key does not grow the cache', () => {
    app._setCachedPost('a', { id: 'a', v: 1 });
    app._setCachedPost('a', { id: 'a', v: 2 });
    assert.equal(app.postCache.size, 1);
    assert.equal(app.postCache.get('a').v, 2);
  });

  it('stays exactly at cap after many inserts', () => {
    for (let i = 0; i < 100; i++) {
      app._setCachedPost(`k${i}`, { id: i });
    }
    assert.equal(app.postCache.size, 3);
    // Only the last 3 keys should survive
    assert.equal(app.postCache.has('k97'), true);
    assert.equal(app.postCache.has('k98'), true);
    assert.equal(app.postCache.has('k99'), true);
  });

  it('no-op when postCache is missing (defensive)', () => {
    const brokenApp = { POST_CACHE_MAX: 3, _setCachedPost: app._setCachedPost };
    assert.doesNotThrow(() => brokenApp._setCachedPost('a', {}));
  });
});
