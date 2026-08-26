/**
 * Tests: Keyword Alerts (계정별 감시 낱말)
 *
 * public/js/keyword-alerts.js 를 그대로 불러 검사한다. 그 모듈은 DOM 과
 * localStorage 를 직접 건드리지 않으므로 브라우저 없이 돌아간다.
 *
 * 검사하는 것:
 * - HTML 본문에서 판정용 평문 뽑기
 * - 입력 문자열 → 낱말 목록 (쉼표/줄바꿈 분리, 중복 제거, 개수·길이 제한)
 * - 한국어 부분 일치와 대소문자 무시 판정, CW 문구 포함, 부스트 껍데기 벗기기
 * - 새 적중으로 잡을지 판정 (내 글 제외, 오래된 글 제외)
 * - 알림 객체 모양과 id 의 결정성
 * - 적중 보관 — 기간 만료, 개수 상한, 최신 우선 정렬
 * - JSON 왕복 뒤 createdAt 되살리기
 * - 저장소 용량이 찼을 때의 물러서기
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let KA;
before(async () => {
  KA = await import('../public/js/keyword-alerts.js');
});

// ============================================================
// 도우미
// ============================================================

function makePost(overrides = {}) {
  return {
    id: 'post1',
    platform: 'mastodon',
    content: '<p>안녕하세요</p>',
    contentWarning: null,
    createdAt: new Date(),
    author: { id: 'u1', acct: 'someone', displayName: 'Someone' },
    isOwn: false,
    ...overrides,
  };
}

function makeAccount(overrides = {}) {
  return {
    id: 'mastodon_1_123',
    platform: 'mastodon',
    software: 'mastodon',
    instanceUrl: 'https://example.social',
    ...overrides,
  };
}

/** localStorage 흉내 — 용량 한도를 흉내 낼 수 있게 만든 것 */
function makeStorage({ limit = Infinity } = {}) {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (v.length > limit) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(k, v);
    },
  };
}

// ============================================================

describe('stripToPlainText — 판정용 평문 뽑기', () => {
  it('태그를 걷어 낸다', () => {
    assert.equal(KA.stripToPlainText('<p>안녕 <b>이루왕</b>님</p>'), '안녕 이루왕님');
  });

  it('블록 끝과 <br> 자리에 공백을 넣어 낱말이 붙지 않게 한다', () => {
    assert.equal(KA.stripToPlainText('<p>앞</p><p>뒤</p>'), '앞 뒤');
    assert.equal(KA.stripToPlainText('앞<br>뒤'), '앞 뒤');
  });

  it('HTML 엔티티를 되돌린다', () => {
    assert.equal(KA.stripToPlainText('a &amp; b &lt;c&gt; &#39;d&#39;'), "a & b <c> 'd'");
  });

  it('멘션 링크의 표시 텍스트는 남는다', () => {
    const html = '<p><a href="https://x/@eeru" class="mention">@eeru</a> 안녕</p>';
    assert.equal(KA.stripToPlainText(html), '@eeru 안녕');
  });

  it('빈 값은 빈 문자열', () => {
    assert.equal(KA.stripToPlainText(null), '');
    assert.equal(KA.stripToPlainText(''), '');
  });
});

describe('parseKeywordInput — 입력에서 낱말 목록 만들기', () => {
  it('쉼표와 줄바꿈으로 나누고 공백을 다듬는다', () => {
    assert.deepEqual(KA.parseKeywordInput(' 이루왕, 루왕 \n 왕루이 '), ['이루왕', '루왕', '왕루이']);
  });

  it('대소문자를 무시하고 중복을 없앤다', () => {
    assert.deepEqual(KA.parseKeywordInput('Eeru, eeru, EERU'), ['Eeru']);
  });

  it('빈 조각을 버린다', () => {
    assert.deepEqual(KA.parseKeywordInput('a,,  ,b'), ['a', 'b']);
  });

  it('개수 상한을 지킨다', () => {
    const many = Array.from({ length: KA.MAX_KEYWORDS + 10 }, (_, i) => `kw${i}`).join(',');
    assert.equal(KA.parseKeywordInput(many).length, KA.MAX_KEYWORDS);
  });

  it('낱말 길이를 자른다', () => {
    const long = 'ㄱ'.repeat(KA.MAX_KEYWORD_LENGTH + 20);
    assert.equal(KA.parseKeywordInput(long)[0].length, KA.MAX_KEYWORD_LENGTH);
  });

  it('빈 입력은 빈 배열', () => {
    assert.deepEqual(KA.parseKeywordInput(''), []);
    assert.deepEqual(KA.parseKeywordInput(null), []);
  });
});

describe('getAccountKeywords / setAccountKeywords', () => {
  it('걸어 둔 낱말이 없으면 빈 배열', () => {
    assert.deepEqual(KA.getAccountKeywords(makeAccount()), []);
    assert.deepEqual(KA.getAccountKeywords(null), []);
  });

  it('저장하면 정규화된 목록이 남는다', () => {
    const account = makeAccount();
    const saved = KA.setAccountKeywords(account, [' 이루왕 ', '루왕', '이루왕']);
    assert.deepEqual(saved, ['이루왕', '루왕']);
    assert.deepEqual(account.notifyKeywords, ['이루왕', '루왕']);
  });

  it('빈 목록을 넣으면 속성 자체를 지운다', () => {
    const account = makeAccount({ notifyKeywords: ['이루왕'] });
    assert.deepEqual(KA.setAccountKeywords(account, []), []);
    assert.equal('notifyKeywords' in account, false);
  });
});

describe('matchKeywords — 적중 판정', () => {
  it('한국어는 낱말 일부만 겹쳐도 걸린다', () => {
    const post = makePost({ content: '<p>어제 루왕이랑 밥 먹었다</p>' });
    assert.deepEqual(KA.matchKeywords(post, ['루왕']), ['루왕']);
  });

  it('대소문자를 가리지 않는다', () => {
    const post = makePost({ content: '<p>Hello EeruWang</p>' });
    assert.deepEqual(KA.matchKeywords(post, ['eeruwang']), ['eeruwang']);
  });

  it('걸린 낱말을 모두 돌려준다', () => {
    const post = makePost({ content: '<p>이루왕 = 루왕</p>' });
    assert.deepEqual(KA.matchKeywords(post, ['이루왕', '루왕', '없는말']), ['이루왕', '루왕']);
  });

  it('CW 문구에 든 낱말도 잡는다', () => {
    const post = makePost({ content: '<p>본문</p>', contentWarning: '이루왕 얘기' });
    assert.deepEqual(KA.matchKeywords(post, ['이루왕']), ['이루왕']);
  });

  it('부스트는 껍데기를 벗기고 원글을 본다', () => {
    const inner = makePost({ id: 'inner', content: '<p>루왕 안녕</p>' });
    const boost = makePost({ id: 'outer', content: '', reblog: inner });
    assert.deepEqual(KA.matchKeywords(boost, ['루왕']), ['루왕']);
  });

  it('없으면 빈 배열', () => {
    assert.deepEqual(KA.matchKeywords(makePost(), ['루왕']), []);
  });

  it('감시 낱말이 없으면 아무것도 걸리지 않는다', () => {
    const post = makePost({ content: '<p>루왕</p>' });
    assert.deepEqual(KA.matchKeywords(post, []), []);
    assert.deepEqual(KA.matchKeywords(post, null), []);
  });

  it('링크 URL 안의 글자로는 걸리지 않는다 (표시 텍스트만 본다)', () => {
    const post = makePost({ content: '<p><a href="https://example.com/루왕/x">링크</a></p>' });
    assert.deepEqual(KA.matchKeywords(post, ['루왕']), []);
  });
});

describe('shouldRecord — 새 적중으로 잡을 글인가', () => {
  it('내 글은 잡지 않는다', () => {
    assert.equal(KA.shouldRecord(makePost({ isOwn: true })), false);
  });

  it('방금 올라온 글은 잡는다', () => {
    assert.equal(KA.shouldRecord(makePost()), true);
  });

  it('되돌아보기 한계보다 오래된 글은 잡지 않는다', () => {
    const old = makePost({ createdAt: new Date(Date.now() - KA.LOOKBACK_MS - 60_000) });
    assert.equal(KA.shouldRecord(old), false);
  });

  it('시각을 모르는 글은 통과시킨다', () => {
    assert.equal(KA.shouldRecord(makePost({ createdAt: null })), true);
  });

  it('id 가 없으면 잡지 않는다', () => {
    assert.equal(KA.shouldRecord(makePost({ id: null })), false);
    assert.equal(KA.shouldRecord(null), false);
  });
});

describe('makeKeywordNotification — 알림 객체', () => {
  const account = makeAccount({ software: 'hollo' });
  const post = makePost({ content: '<p>루왕 안녕</p>' });

  it('알림 컬럼이 아는 모양으로 만든다', () => {
    const n = KA.makeKeywordNotification({ post, account, keywords: ['루왕'], themeColor: '#abc' });
    assert.equal(n.type, 'keyword');
    assert.equal(n.platform, 'mastodon');
    assert.equal(n.accountId, account.id);
    assert.equal(n.accountSoftware, 'hollo');
    assert.equal(n.accountInstanceHost, 'example.social');
    assert.equal(n.themeColor, '#abc');
    assert.deepEqual(n.keywords, ['루왕']);
    assert.equal(n.post, post);
    assert.equal(n.actor, post.author);
    assert.ok(n.createdAt instanceof Date);
  });

  it('id 는 계정+글에 대해 늘 같다 (같은 카드가 두 번 들어가지 않도록)', () => {
    const a = KA.makeKeywordNotification({ post, account, keywords: ['루왕'] });
    const b = KA.makeKeywordNotification({ post, account, keywords: ['루왕', '이루왕'] });
    assert.equal(a.id, b.id);
    assert.equal(a.id, `kw:${account.id}:mastodon:post1`);
  });

  it('부스트는 원글을 가리킨다', () => {
    const inner = makePost({ id: 'inner' });
    const boost = makePost({ id: 'outer', reblog: inner });
    const n = KA.makeKeywordNotification({ post: boost, account, keywords: ['루왕'] });
    assert.equal(n.post, inner);
    assert.ok(n.id.endsWith(':inner'));
  });
});

describe('pruneHits — 적중 보관', () => {
  const now = Date.now();
  const hit = (id, at) => ({ key: `k${id}`, at, post: makePost({ id }) });

  it('기간이 지난 것을 버린다', () => {
    const kept = KA.pruneHits([hit('a', now), hit('b', now - KA.HIT_TTL_MS - 1000)], now);
    assert.deepEqual(kept.map(h => h.key), ['ka']);
  });

  it('최신이 앞에 오게 정렬한다', () => {
    const kept = KA.pruneHits([hit('a', now - 5000), hit('b', now)], now);
    assert.deepEqual(kept.map(h => h.key), ['kb', 'ka']);
  });

  it('개수 상한을 지킨다', () => {
    const many = Array.from({ length: KA.MAX_HITS + 20 }, (_, i) => hit(String(i), now - i));
    assert.equal(KA.pruneHits(many, now).length, KA.MAX_HITS);
  });

  it('망가진 항목을 걸러 낸다', () => {
    const kept = KA.pruneHits([null, { key: 'x' }, { at: now }, hit('a', now)], now);
    assert.deepEqual(kept.map(h => h.key), ['ka']);
  });

  it('배열이 아니면 빈 배열', () => {
    assert.deepEqual(KA.pruneHits(null), []);
  });
});

describe('reviveDates — JSON 왕복 뒤 날짜 되살리기', () => {
  it('createdAt 문자열을 Date 로 되돌린다', () => {
    const round = JSON.parse(JSON.stringify({ createdAt: new Date('2026-08-01T00:00:00.000Z') }));
    assert.equal(typeof round.createdAt, 'string');
    const revived = KA.reviveDates(round);
    assert.ok(revived.createdAt instanceof Date);
    assert.equal(revived.createdAt.toISOString(), '2026-08-01T00:00:00.000Z');
  });

  it('중첩된 글(인용/부스트)의 날짜도 되살린다', () => {
    const round = JSON.parse(JSON.stringify({
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      quotePost: { createdAt: new Date('2026-07-31T00:00:00.000Z') },
    }));
    const revived = KA.reviveDates(round);
    assert.ok(revived.quotePost.createdAt instanceof Date);
  });

  it('날짜가 아닌 문자열은 건드리지 않는다', () => {
    const revived = KA.reviveDates({ content: '2026-08-01T00:00:00.000Z 라고 썼다' });
    assert.equal(typeof revived.content, 'string');
  });
});

describe('loadHits / saveHits — 저장소 왕복', () => {
  it('저장한 것을 되읽고 날짜를 되살린다', () => {
    const storage = makeStorage();
    const now = Date.now();
    KA.saveHits(storage, [{ key: 'k1', at: now, accountId: 'a1', keywords: ['루왕'], post: makePost() }], now);
    const loaded = KA.loadHits(storage, now);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].key, 'k1');
    assert.ok(loaded[0].post.createdAt instanceof Date);
  });

  it('저장된 게 없으면 빈 배열', () => {
    assert.deepEqual(KA.loadHits(makeStorage()), []);
  });

  it('깨진 JSON 에도 던지지 않는다', () => {
    const storage = makeStorage();
    storage.map.set(KA.HITS_KEY, '{ 망가진');
    assert.deepEqual(KA.loadHits(storage), []);
  });

  it('용량이 차면 절반만 남기고 다시 시도한다', () => {
    const now = Date.now();
    const full = Array.from({ length: KA.MAX_HITS }, (_, i) => ({
      key: `k${i}`, at: now - i, accountId: 'a1', keywords: ['루왕'], post: makePost({ id: `p${i}` }),
    }));
    // 전체는 못 들어가고 절반은 들어가는 한도
    const whole = JSON.stringify(KA.pruneHits(full, now)).length;
    const half = JSON.stringify(KA.pruneHits(full, now).slice(0, Math.floor(KA.MAX_HITS / 2))).length;
    const storage = makeStorage({ limit: Math.floor((whole + half) / 2) });
    KA.saveHits(storage, full, now);
    const loaded = KA.loadHits(storage, now);
    assert.ok(loaded.length > 0 && loaded.length < KA.MAX_HITS);
  });

  it('저장소가 아예 없어도 던지지 않는다', () => {
    assert.deepEqual(KA.loadHits(null), []);
    assert.deepEqual(KA.saveHits(null, []), []);
  });
});
