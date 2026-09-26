/**
 * Tests: _extractStatusIdFromUrl (data-loading.js:1852).
 *
 * Given a post URL and the software running on that server, extract the
 * local status ID. Used by Phase 2c fav→reaction enrichment when the actor's
 * instance is the same as the post's origin — parsing the URL is cheaper
 * than an auth-gated /api/v2/search call.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function extractStatusIdFromUrl(url, software) {
  let path;
  try { path = new URL(url).pathname; } catch { return null; }
  if (software === 'akkoma' || software === 'pleroma') {
    const m = path.match(/^\/(?:notice|objects)\/([\w-]+)\/?$/);
    if (m) return m[1];
  }
  let m = path.match(/^\/@[^/]+\/([\w-]+)\/?$/);
  if (m) return m[1];
  m = path.match(/^\/users\/[^/]+\/statuses\/([\w-]+)\/?$/);
  if (m) return m[1];
  return null;
}

describe('_extractStatusIdFromUrl', () => {
  it('parses Mastodon-style /@user/12345', () => {
    assert.equal(extractStatusIdFromUrl('https://mstdn.example/@alice/109123456789012345', 'mastodon'), '109123456789012345');
  });

  it('parses Mastodon canonical /users/alice/statuses/12345', () => {
    assert.equal(extractStatusIdFromUrl('https://mstdn.example/users/alice/statuses/109123456789', 'mastodon'), '109123456789');
  });

  it('parses Pleroma /notice/UUID', () => {
    assert.equal(extractStatusIdFromUrl('https://pl.example/notice/AbCdEfG', 'pleroma'), 'AbCdEfG');
  });

  it('parses Akkoma /objects/UUID', () => {
    assert.equal(extractStatusIdFromUrl('https://ak.example/objects/9f1b-abc', 'akkoma'), '9f1b-abc');
  });

  it('parses Mastodon-style URL even when software claims pleroma', () => {
    // Pleroma-mode falls through to the general /@user/id pattern
    assert.equal(extractStatusIdFromUrl('https://ak.example/@alice/109', 'pleroma'), '109');
  });

  it('accepts trailing slash', () => {
    assert.equal(extractStatusIdFromUrl('https://mstdn.example/@alice/12345/', 'mastodon'), '12345');
  });

  it('rejects malformed URL', () => {
    assert.equal(extractStatusIdFromUrl('not a url', 'mastodon'), null);
  });

  it('rejects unrecognized path shape', () => {
    assert.equal(extractStatusIdFromUrl('https://mstdn.example/tags/foo', 'mastodon'), null);
    assert.equal(extractStatusIdFromUrl('https://mstdn.example/', 'mastodon'), null);
  });

  it('does not match Misskey /notes/id', () => {
    // Misskey URLs are handled separately (URL parse in Phase 1b), so this
    // Mastodon-focused helper must NOT accidentally match them.
    assert.equal(extractStatusIdFromUrl('https://misskey.example/notes/abc123', 'mastodon'), null);
  });
});
