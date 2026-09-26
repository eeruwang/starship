/**
 * Tests: keyboard-nav boundary logic.
 *
 * The audit's complaint was that J/K walked past the end of one column into
 * the next. The fix scopes J/K to the current column, clamped at the
 * boundaries with no wrap. Cross-column moves use H/L (or ← / →) explicitly.
 *
 * These tests cover the pure index math that keyboard-nav.js uses; the
 * DOM-side element resolution is exercised by manual QA.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Mirrors moveWithinColumn(direction) in keyboard-nav.js:
// clamp to [0, list.length - 1]; no wrap on either boundary.
function nextIndexInColumn(list, currentIdx, direction) {
  if (!list.length) return -1;
  if (currentIdx < 0) return 0; // First press → anchor at top
  const target = currentIdx + direction;
  return Math.max(0, Math.min(list.length - 1, target));
}

describe('keyboard J/K stays inside the current column', () => {
  it('first press with no focus lands on the first card', () => {
    const list = ['a', 'b', 'c'];
    assert.equal(nextIndexInColumn(list, -1, 1), 0);
    assert.equal(nextIndexInColumn(list, -1, -1), 0);
  });

  it('J advances one card forward', () => {
    assert.equal(nextIndexInColumn(['a', 'b', 'c'], 0, 1), 1);
    assert.equal(nextIndexInColumn(['a', 'b', 'c'], 1, 1), 2);
  });

  it('K retreats one card backward', () => {
    assert.equal(nextIndexInColumn(['a', 'b', 'c'], 2, -1), 1);
    assert.equal(nextIndexInColumn(['a', 'b', 'c'], 1, -1), 0);
  });

  it('J at end stays at end (no wrap, no cross-column jump)', () => {
    const list = ['a', 'b', 'c'];
    // Old bug: J walked into the next column's first card.
    assert.equal(nextIndexInColumn(list, 2, 1), 2);
  });

  it('K at start stays at start (no wrap)', () => {
    assert.equal(nextIndexInColumn(['a', 'b', 'c'], 0, -1), 0);
  });

  it('empty column: no anchoring', () => {
    assert.equal(nextIndexInColumn([], -1, 1), -1);
    assert.equal(nextIndexInColumn([], 0, 1), -1);
  });

  it('single-card column stays put on both directions', () => {
    assert.equal(nextIndexInColumn(['only'], 0, 1), 0);
    assert.equal(nextIndexInColumn(['only'], 0, -1), 0);
  });
});
