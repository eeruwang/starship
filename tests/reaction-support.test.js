/**
 * Tests: Reaction Support (마스토돈 계열의 이모지 리액션 지원 판정)
 *
 * public/js/reaction-support.js 를 그대로 불러 검사한다. 그 모듈은 DOM 도
 * fetch 도 쓰지 않고 판정만 하므로 브라우저 없이 돌아간다.
 *
 * 검사하는 것:
 * - 소프트웨어 이름으로 확정되는 것들 (Hollo 포크 포함)
 * - NodeInfo metadata.features 읽기 (Pleroma 계열의 pleroma_emoji_reactions)
 * - /api/v2/instance 읽기 (Fedibird 의 configuration.emoji_reactions 와
 *   fedibird_capabilities, Pleroma 의 pleroma.metadata.features)
 * - 글에 실려 온 리액션 배열로 뒤늦게 알아내기
 * - 계정별 등록부와 카드에 단추를 달지 정하는 판정
 * - 바닐라 마스토돈과 GoToSocial 을 잘못 켜지 않기
 */

const { describe, it, beforeEach, before } = require('node:test');
const assert = require('node:assert/strict');

let RS;
before(async () => {
  RS = await import('../public/js/reaction-support.js');
});

describe('dialectForSoftware — 이름으로 확정되는 것', () => {
  it('Pleroma 계열은 pleroma 방언', () => {
    assert.equal(RS.dialectForSoftware('pleroma'), RS.DIALECT_PLEROMA);
    assert.equal(RS.dialectForSoftware('akkoma'), RS.DIALECT_PLEROMA);
    assert.equal(RS.dialectForSoftware('Akkoma'), RS.DIALECT_PLEROMA);
  });

  it('Hollo 와 그 포크는 fedibird 방언', () => {
    assert.equal(RS.dialectForSoftware('hollo'), RS.DIALECT_FEDIBIRD);
    assert.equal(RS.dialectForSoftware('cloud-hollo'), RS.DIALECT_FEDIBIRD);
    assert.equal(RS.dialectForSoftware('hollo-worker'), RS.DIALECT_FEDIBIRD);
  });

  it('바닐라 마스토돈과 GoToSocial 은 지원하지 않는다', () => {
    assert.equal(RS.dialectForSoftware('mastodon'), null);
    assert.equal(RS.dialectForSoftware('gotosocial'), null);
    assert.equal(RS.dialectForSoftware('hometown'), null);
    assert.equal(RS.dialectForSoftware(''), null);
    assert.equal(RS.dialectForSoftware(null), null);
  });
});

describe('dialectFromNodeInfo', () => {
  it('pleroma_emoji_reactions 가 features 에 있으면 pleroma 방언', () => {
    const ni = {
      software: { name: 'akkoma', version: '3.13.0' },
      metadata: { features: ['pleroma_api', 'pleroma_emoji_reactions', 'quote_posting'] },
    };
    assert.equal(RS.dialectFromNodeInfo(ni), RS.DIALECT_PLEROMA);
  });

  it('features 가 emoji_reaction 을 달리 적어도 fedibird 방언으로 본다', () => {
    const ni = { software: { name: 'mastodon' }, metadata: { features: ['emoji_reaction'] } };
    assert.equal(RS.dialectFromNodeInfo(ni), RS.DIALECT_FEDIBIRD);
  });

  it('신고가 없으면 소프트웨어 이름으로 물러선다', () => {
    assert.equal(RS.dialectFromNodeInfo({ software: { name: 'hollo' } }), RS.DIALECT_FEDIBIRD);
    assert.equal(RS.dialectFromNodeInfo({ software: { name: 'mastodon' } }), null);
    assert.equal(RS.dialectFromNodeInfo(null), null);
  });
});

describe('dialectFromInstance', () => {
  it('Fedibird 의 configuration.emoji_reactions 를 읽는다', () => {
    // fedibird/mastodon 의 InstanceSerializer 가 내놓는 모양
    const inst = {
      domain: 'fedibird.com',
      version: '3.4.1',
      configuration: {
        statuses: { max_characters: 5000 },
        emoji_reactions: { max_reactions: 8, max_reactions_per_account: 1 },
      },
    };
    assert.equal(RS.dialectFromInstance(inst), RS.DIALECT_FEDIBIRD);
  });

  it('fedibird_capabilities 에 emoji_reaction 이 들어 있어도 잡는다', () => {
    const inst = { version: '3.4.1', fedibird_capabilities: ['emoji_reaction', 'status_expire'] };
    assert.equal(RS.dialectFromInstance(inst), RS.DIALECT_FEDIBIRD);
  });

  it('Pleroma 는 같은 응답의 pleroma.metadata.features 로 알린다', () => {
    const inst = { version: '2.7.1', pleroma: { metadata: { features: ['pleroma_emoji_reactions'] } } };
    assert.equal(RS.dialectFromInstance(inst), RS.DIALECT_PLEROMA);
  });

  it('바닐라 마스토돈 응답에서는 아무것도 켜지 않는다', () => {
    const inst = {
      domain: 'mastodon.social',
      version: '4.6.3',
      configuration: { statuses: { max_characters: 500 }, polls: { max_options: 4 } },
    };
    assert.equal(RS.dialectFromInstance(inst), null);
    assert.equal(RS.dialectFromInstance(null), null);
  });
});

describe('dialectFromStatus — 글에 실려 온 것으로 뒤늦게 알아내기', () => {
  it('emoji_reactions 배열이 차 있으면 fedibird 방언', () => {
    const status = { id: '1', emoji_reactions: [{ name: '👍', count: 2, me: false }] };
    assert.equal(RS.dialectFromStatus(status), RS.DIALECT_FEDIBIRD);
  });

  it('pleroma.emoji_reactions 배열이 차 있으면 pleroma 방언', () => {
    const status = { id: '1', pleroma: { emoji_reactions: [{ name: '☕', count: 1, me: true }] } };
    assert.equal(RS.dialectFromStatus(status), RS.DIALECT_PLEROMA);
  });

  it('빈 배열은 근거가 못 된다', () => {
    assert.equal(RS.dialectFromStatus({ id: '1', emoji_reactions: [] }), null);
    assert.equal(RS.dialectFromStatus({ id: '1' }), null);
    assert.equal(RS.dialectFromStatus(null), null);
  });
});

describe('계정별 등록부', () => {
  beforeEach(() => RS.resetAccountReactionDialects());

  it('넣은 것을 그대로 돌려준다', () => {
    RS.setAccountReactionDialect('acc1', RS.DIALECT_FEDIBIRD);
    assert.equal(RS.accountReactionDialect('acc1'), RS.DIALECT_FEDIBIRD);
    assert.equal(RS.accountReactionDialect('acc2'), null);
  });

  it('null 을 넣으면 지운다', () => {
    RS.setAccountReactionDialect('acc1', RS.DIALECT_PLEROMA);
    RS.setAccountReactionDialect('acc1', null);
    assert.equal(RS.accountReactionDialect('acc1'), null);
  });

  it('계정을 지우면 등록도 사라진다', () => {
    RS.setAccountReactionDialect('acc1', RS.DIALECT_FEDIBIRD);
    RS.forgetAccountReactionDialect('acc1');
    assert.equal(RS.accountReactionDialect('acc1'), null);
  });
});

describe('postSupportsReactions — 카드에 단추를 달지', () => {
  beforeEach(() => RS.resetAccountReactionDialects());

  it('미스키 계열은 늘 단다', () => {
    assert.equal(RS.postSupportsReactions({ platform: 'misskey', accountId: 'a' }), true);
    assert.equal(RS.postSupportsReactions({ platform: 'iceshrimp', accountId: 'a' }), true);
  });

  it('바닐라 마스토돈에는 달지 않는다', () => {
    const post = { platform: 'mastodon', accountId: 'a', accountSoftware: 'mastodon' };
    assert.equal(RS.postSupportsReactions(post), false);
  });

  it('등록부에 방언이 있으면 이름이 mastodon 이어도 단다 (Fedibird 의 경우)', () => {
    RS.setAccountReactionDialect('a', RS.DIALECT_FEDIBIRD);
    const post = { platform: 'mastodon', accountId: 'a', accountSoftware: 'mastodon' };
    assert.equal(RS.postSupportsReactions(post), true);
  });

  it('이름만으로 아는 서버는 등록 없이도 단다', () => {
    const post = { platform: 'mastodon', accountId: 'a', accountSoftware: 'hollo' };
    assert.equal(RS.postSupportsReactions(post), true);
  });

  it('이미 리액션이 달린 글이면 단다', () => {
    const post = { platform: 'mastodon', accountId: 'a', accountSoftware: 'mastodon', reactions: { '👍': 3 } };
    assert.equal(RS.postSupportsReactions(post), true);
  });

  it('비마스토돈 계정이 섞인 병합 글이면 단다', () => {
    const post = {
      platform: 'mastodon', accountId: 'a', accountSoftware: 'mastodon',
      mergedAccounts: [{ platform: 'mastodon' }, { platform: 'misskey' }],
    };
    assert.equal(RS.postSupportsReactions(post), true);
  });
});
