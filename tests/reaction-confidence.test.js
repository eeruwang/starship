/**
 * Tests: reaction confidence gating.
 *
 * Mirrors _REACTION_CONFIDENCE + _assignReaction (data-loading.js:847-883).
 * The gate protects the notif object from being downgraded when phases race:
 * a slower 'inferred' phase must never overwrite an already-'authoritative'
 * result. Also confirms _markReactionResolvedNegative acts as an absolute
 * lock.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const REACTION_CONFIDENCE = {
  none: 0,
  low: 1,
  inferred: 2,
  authoritative: 3,
};

function assignReaction(notif, { emoji, emojiUrl = null, source = 'inferred' }) {
  if (!notif) return false;
  if (notif._reactionResolvedNegative) return false;
  const cur = REACTION_CONFIDENCE[notif._reactionSource || 'none'];
  const next = REACTION_CONFIDENCE[source] ?? 0;
  if (next < cur) return false;
  notif.type = 'reaction';
  notif.reactionEmoji = emoji;
  notif.reactionEmojiUrl = emojiUrl || notif.reactionEmojiUrl || null;
  notif._reactionSource = source;
  return true;
}

function markReactionResolvedNegative(notif) {
  if (!notif) return;
  notif._reactionResolvedNegative = true;
  if (notif.type === 'reaction' && (notif._reactionSource === 'low' || notif._reactionSource === 'inferred')) {
    notif.type = 'favourite';
  }
}

describe('_assignReaction confidence gating', () => {
  let notif;
  beforeEach(() => { notif = { id: 'n1', type: 'favourite' }; });

  it('assigns from none → inferred', () => {
    assert.equal(assignReaction(notif, { emoji: '👍', source: 'inferred' }), true);
    assert.equal(notif.type, 'reaction');
    assert.equal(notif.reactionEmoji, '👍');
    assert.equal(notif._reactionSource, 'inferred');
  });

  it('promotes inferred → authoritative', () => {
    assignReaction(notif, { emoji: '👍', source: 'inferred' });
    assert.equal(assignReaction(notif, { emoji: '🎉', source: 'authoritative' }), true);
    assert.equal(notif.reactionEmoji, '🎉');
    assert.equal(notif._reactionSource, 'authoritative');
  });

  it('same-level authoritative can overwrite authoritative (Phase 3 overrides Phase 2b)', () => {
    assignReaction(notif, { emoji: '👍', source: 'authoritative' });
    assert.equal(assignReaction(notif, { emoji: '🔥', source: 'authoritative' }), true);
    assert.equal(notif.reactionEmoji, '🔥');
  });

  it('rejects downgrade authoritative → inferred', () => {
    assignReaction(notif, { emoji: '👍', source: 'authoritative' });
    assert.equal(assignReaction(notif, { emoji: '🎉', source: 'inferred' }), false);
    assert.equal(notif.reactionEmoji, '👍', 'stays as authoritative pick');
  });

  it('rejects downgrade authoritative → low', () => {
    assignReaction(notif, { emoji: '👍', source: 'authoritative' });
    assert.equal(assignReaction(notif, { emoji: '💩', source: 'low' }), false);
  });

  it('inferred does not overwrite inferred (idempotent at same level)', () => {
    assignReaction(notif, { emoji: '👍', source: 'inferred' });
    // Same source is allowed (next < cur is false when equal)
    assert.equal(assignReaction(notif, { emoji: '🎉', source: 'inferred' }), true);
    assert.equal(notif.reactionEmoji, '🎉');
  });

  it('negative lock blocks all future assigns', () => {
    markReactionResolvedNegative(notif);
    assert.equal(assignReaction(notif, { emoji: '👍', source: 'authoritative' }), false);
    assert.equal(assignReaction(notif, { emoji: '🎉', source: 'low' }), false);
    // Also blocks even the highest source
    assert.equal(assignReaction(notif, { emoji: '🌟', source: 'authoritative' }), false);
  });

  it('negative lock demotes prior inferred/low back to favourite', () => {
    assignReaction(notif, { emoji: '👍', source: 'inferred' });
    assert.equal(notif.type, 'reaction');
    markReactionResolvedNegative(notif);
    assert.equal(notif.type, 'favourite');
  });

  it('negative lock does NOT demote a prior authoritative pick', () => {
    // If authoritative confirmed the emoji, a later negative call shouldn't
    // erase that (the same authoritative source shouldn't disagree with itself,
    // and if two authoritatives disagree the lock is set by the second one).
    // The current implementation only demotes low/inferred — this pins that.
    assignReaction(notif, { emoji: '👍', source: 'authoritative' });
    markReactionResolvedNegative(notif);
    assert.equal(notif.type, 'reaction', 'authoritative assignment survives negative lock');
  });
});

describe('race scenario — Phase 2b before Phase 3', () => {
  it('Phase 2b inferred cannot overwrite Phase 3 authoritative', () => {
    const notif = { id: 'n1', type: 'favourite' };
    // Phase 3 fires first, authoritative
    assignReaction(notif, { emoji: '🎉', source: 'authoritative' });
    // Phase 2b arrives later with a different emoji as inferred
    assignReaction(notif, { emoji: '👍', source: 'inferred' });
    assert.equal(notif.reactionEmoji, '🎉');
  });

  it('Phase 2b authoritative before Phase 3 authoritative — later wins', () => {
    // Both are authoritative; the later call wins by design (Phase 3 tends to
    // be more accurate on cross-instance reactions since Misskey resolveUrl
    // walks the origin's per-user list).
    const notif = { id: 'n1', type: 'favourite' };
    assignReaction(notif, { emoji: '👍', source: 'authoritative' }); // 2b
    assignReaction(notif, { emoji: '🎉', source: 'authoritative' }); // 3
    assert.equal(notif.reactionEmoji, '🎉');
  });
});
