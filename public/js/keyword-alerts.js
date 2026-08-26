/**
 * Keyword Alerts
 *
 * 계정마다 감시할 낱말을 걸어 두고, 그 낱말이 든 글이 타임라인에 뜨면
 * 알림 컬럼에 넣어 준다. 멘션이 아니어도 (예: 닉네임을 링크 없이 부르는 글)
 * 놓치지 않기 위한 장치다.
 *
 * 서버는 이런 걸 알려 주지 않으므로 전적으로 클라이언트 쪽 판정이다.
 * 타임라인에 흘러온 글만 대상이며, 서버 전체 검색이 아니다.
 *
 * 이 모듈은 DOM 과 localStorage 를 직접 건드리지 않는다 (저장소는 인자로 받는다).
 * 그래야 node --test 에서 그대로 불러 쓸 수 있다.
 */

export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 40;
/** 보관할 최대 적중 수 (localStorage 용량 방어) */
export const MAX_HITS = 60;
/** 적중 보관 기간 */
export const HIT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** 이 시간보다 오래된 글은 새 적중으로 잡지 않는다 (첫 로드 때 과거 글 홍수 방지) */
export const LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const HITS_KEY = 'starship_keyword_hits';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/**
 * HTML 조각에서 사람이 읽는 텍스트만 뽑는다.
 * DOM 을 쓰지 않는 것은 이 모듈을 테스트에서 그대로 쓰기 위해서다.
 */
export function stripToPlainText(html) {
  if (!html) return '';
  return String(html)
    // <br>, </p>, </div> 는 낱말이 붙어 버리지 않게 공백으로
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 입력창의 원문을 낱말 목록으로 만든다.
 * 쉼표와 줄바꿈으로 나누고, 공백을 다듬고, 대소문자 무시로 중복을 없앤다.
 */
export function parseKeywordInput(raw) {
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  for (const piece of String(raw).split(/[,\n]/)) {
    const kw = piece.trim().replace(/\s+/g, ' ').slice(0, MAX_KEYWORD_LENGTH);
    if (!kw) continue;
    const fold = kw.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    out.push(kw);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

export function getAccountKeywords(account) {
  const list = account?.notifyKeywords;
  return Array.isArray(list) ? list.filter(k => typeof k === 'string' && k.trim()) : [];
}

export function setAccountKeywords(account, keywords) {
  if (!account) return [];
  const list = parseKeywordInput((keywords || []).join('\n'));
  if (list.length > 0) account.notifyKeywords = list;
  else delete account.notifyKeywords;
  return list;
}

/** 부스트/리노트 껍데기를 벗긴 실제 글 */
export function displayPostOf(post) {
  return post?.reblog || post;
}

/**
 * 판정 대상 텍스트 — 본문과 CW 문구.
 * 인용된 글과 미디어 파일 이름은 넣지 않는다 (남의 글로 내 알림이 울리는 걸 막기 위해).
 */
export function matchTextOf(post) {
  const dp = displayPostOf(post);
  if (!dp) return '';
  return [stripToPlainText(dp.content), dp.contentWarning || ''].join(' ').trim();
}

/**
 * 적중한 낱말들을 돌려준다. 없으면 빈 배열.
 * 판정은 대소문자를 가리지 않는 부분 일치다. 한국어에는 낱말 경계가 없으므로
 * ("루왕이" 안의 "루왕") 부분 일치가 맞다.
 */
export function matchKeywords(post, keywords) {
  if (!keywords || keywords.length === 0) return [];
  const text = matchTextOf(post).toLowerCase();
  if (!text) return [];
  return keywords.filter(kw => {
    const needle = String(kw).trim().toLowerCase();
    return needle && text.includes(needle);
  });
}

/** 적중 하나를 가리키는 키 — 같은 글로 두 번 알리지 않기 위해 쓴다 */
export function hitKey(accountId, post) {
  const dp = displayPostOf(post);
  return `${accountId}:${dp?.platform || post?.platform || ''}:${dp?.id || post?.id || ''}`;
}

/**
 * 이 글을 지금 새 적중으로 잡을지 판정한다.
 * - 내 글은 제외 (내가 내 닉네임을 쓰는 일이 잦다)
 * - LOOKBACK_MS 보다 오래된 글은 제외 (첫 로드/과거 스크롤에서 쏟아지는 걸 막는다)
 */
export function shouldRecord(post, { now = Date.now() } = {}) {
  if (!post || post.isOwn) return false;
  const dp = displayPostOf(post);
  if (!dp?.id) return false;
  const created = dp.createdAt || post.createdAt;
  const ms = created instanceof Date ? created.getTime() : Date.parse(created || '');
  if (!Number.isFinite(ms)) return true; // 시각을 모르면 통과시킨다
  return now - ms <= LOOKBACK_MS;
}

/**
 * 적중을 알림 컬럼이 아는 모양(normalizeNotification 산출물)으로 바꾼다.
 * type 'keyword' 는 이 앱이 만들어 낸 것으로, 서버에서 오는 종류가 아니다.
 */
export function makeKeywordNotification({ post, account, keywords, themeColor = null, createdAt = null }) {
  const dp = displayPostOf(post);
  const platform = dp.platform || post.platform || account?.platform;
  const notif = {
    id: `kw:${account?.id || ''}:${platform}:${dp.id}`,
    platform,
    type: 'keyword',
    label: '키워드',
    keywords: [...keywords],
    createdAt: createdAt || dp.createdAt || post.createdAt || new Date(),
    actor: dp.author || null,
    post: dp,
    accountId: account?.id || null,
    accountSoftware: account?.software || account?.platform || platform,
    instanceUrl: account?.instanceUrl || null,
    themeColor,
    _keywordAlert: true,
  };
  if (account?.instanceUrl) {
    try { notif.accountInstanceHost = new URL(account.instanceUrl).host; } catch (_) {}
  }
  return notif;
}

/** 오래됐거나 넘치는 적중을 버린다. 최신이 앞에 오도록 정렬해 돌려준다. */
export function pruneHits(hits, now = Date.now()) {
  if (!Array.isArray(hits)) return [];
  return hits
    .filter(h => h && h.key && h.post && Number.isFinite(h.at) && now - h.at <= HIT_TTL_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_HITS);
}

/**
 * JSON 왕복으로 문자열이 되어 버린 createdAt 을 Date 로 되살린다.
 * 렌더러가 createdAt.toISOString() 을 부르므로 이게 없으면 카드가 깨진다.
 */
export function reviveDates(value, depth = 0) {
  if (depth > 6 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = reviveDates(value[i], depth + 1);
    return value;
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && /(createdAt|updatedAt|expiresAt)$/i.test(k)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) value[k] = d;
    } else if (v && typeof v === 'object') {
      value[k] = reviveDates(v, depth + 1);
    }
  }
  return value;
}

export function loadHits(storage, now = Date.now()) {
  try {
    const raw = storage?.getItem(HITS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return pruneHits(parsed, now).map(h => ({ ...h, post: reviveDates(h.post) }));
  } catch {
    return [];
  }
}

export function saveHits(storage, hits, now = Date.now()) {
  const pruned = pruneHits(hits, now);
  try {
    storage?.setItem(HITS_KEY, JSON.stringify(pruned));
  } catch {
    // 용량이 찼으면 절반만 남기고 한 번 더 시도한다
    try { storage?.setItem(HITS_KEY, JSON.stringify(pruned.slice(0, Math.floor(MAX_HITS / 2)))); } catch {}
  }
  return pruned;
}
