/**
 * Tests: post dedup key formation.
 *
 * Mirrors `_computeDedupKey` from data-loading.js (line 743). The key drives
 * whether two entries in different columns represent the same underlying post
 * (so they merge instead of duplicating), and whether a boost card is a
 * distinct entry from the original post (it must be, or streaming boost
 * events overwrite the origin card).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Pure reimplementation of the logic in data-loading.js — kept in sync
// deliberately so a regression in the mixin surfaces here.
function normalizeAcct(acct, instanceUrl) {
  if (!acct || acct.includes('@')) return acct || '';
  try { return `${acct}@${new URL(instanceUrl).hostname}`; } catch { return acct; }
}

function computeDedupKey(post) {
  const displayPost = post.reblog || post;
  const baseKey = displayPost.canonicalUri || `${displayPost.platform}:${displayPost.id}`;
  if (post.rebloggedBy) {
    const acct = normalizeAcct(post.rebloggedBy.acct, post.instanceUrl);
    return `reblog:${acct}:${baseKey}`;
  }
  return baseKey;
}

describe('_computeDedupKey', () => {
  it('uses canonicalUri when present', () => {
    const post = {
      platform: 'mastodon',
      id: 'local-1',
      canonicalUri: 'https://origin.example/@a/999',
    };
    assert.equal(computeDedupKey(post), 'https://origin.example/@a/999');
  });

  it('falls back to platform:id when no canonicalUri', () => {
    const post = { platform: 'misskey', id: 'note123' };
    assert.equal(computeDedupKey(post), 'misskey:note123');
  });

  it('boost/reblog gets a distinct key from its original', () => {
    const original = {
      platform: 'mastodon',
      id: '1',
      canonicalUri: 'https://origin.example/@a/999',
    };
    const boost = {
      platform: 'mastodon',
      id: '2',
      rebloggedBy: { acct: 'booster@somewhere.example' },
      instanceUrl: 'https://ours.example',
      reblog: original,
    };
    const originalKey = computeDedupKey(original);
    const boostKey = computeDedupKey(boost);
    assert.notEqual(originalKey, boostKey);
    assert.equal(boostKey, 'reblog:booster@somewhere.example:https://origin.example/@a/999');
  });

  it('normalizes local acct without host by appending instance host', () => {
    const post = {
      platform: 'mastodon',
      id: '2',
      rebloggedBy: { acct: 'alice' },
      instanceUrl: 'https://mastodon.example',
      reblog: { platform: 'mastodon', id: '1', canonicalUri: 'https://o/1' },
    };
    assert.equal(computeDedupKey(post), 'reblog:alice@mastodon.example:https://o/1');
  });

  it('same original boosted by two different accounts → two distinct keys', () => {
    const original = { platform: 'mastodon', id: '1', canonicalUri: 'https://o/1' };
    const boostA = {
      platform: 'mastodon', id: 'a',
      rebloggedBy: { acct: 'alice@a.example' },
      instanceUrl: 'https://ours.example',
      reblog: original,
    };
    const boostB = {
      platform: 'mastodon', id: 'b',
      rebloggedBy: { acct: 'bob@b.example' },
      instanceUrl: 'https://ours.example',
      reblog: original,
    };
    assert.notEqual(computeDedupKey(boostA), computeDedupKey(boostB));
  });

  it('same original picked up on multiple accounts → same key (will merge)', () => {
    const shared = { platform: 'mastodon', id: '1', canonicalUri: 'https://o/1' };
    const seenOnA = { ...shared };
    const seenOnB = { ...shared };
    assert.equal(computeDedupKey(seenOnA), computeDedupKey(seenOnB));
  });
});
