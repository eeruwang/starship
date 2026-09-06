/**
 * Reaction Support
 *
 * 마스토돈 API 를 말하는 서버 가운데 이모지 리액션을 받는 것들을 가려내고,
 * 어느 엔드포인트 계열로 보낼지 정한다.
 *
 * 소프트웨어 이름만으로는 가려낼 수 없다. Fedibird 는 NodeInfo 에 자기를
 * mastodon 으로 신고하고 버전 문자열에도 표시를 남기지 않는다
 * (lib/mastodon/version.rb 의 to_s 는 "3.4.1" 만 만든다).
 * 그래서 이름표 대신 서버가 스스로 내놓는 능력 신고를 읽는다.
 *
 * 읽는 자리는 셋이다.
 *   1. NodeInfo metadata.features — Pleroma 계열이 pleroma_emoji_reactions 를 싣는다.
 *   2. /api/v2/instance — Fedibird 가 configuration.emoji_reactions 와
 *      fedibird_capabilities 를 싣는다.
 *   3. 글 자체 — emoji_reactions 배열이 실려 오면 그 서버는 이미 답을 준 것이다.
 *
 * DOM 도 fetch 도 쓰지 않는다. 판정만 하므로 node --test 에서 그대로 부른다.
 */

/** PUT/DELETE /api/v1/statuses/:id/emoji_reactions/:emoji (Fedibird, Hollo) */
export const DIALECT_FEDIBIRD = 'fedibird';
/** PUT/DELETE /api/v1/pleroma/statuses/:id/reactions/:emoji (Pleroma, Akkoma) */
export const DIALECT_PLEROMA = 'pleroma';

/**
 * 이름만으로 확정할 수 있는 것들.
 * Hollo 는 포크가 cloud-hollo 처럼 다른 이름을 신고하므로 부분 일치로 본다.
 */
const SOFTWARE_DIALECT = [
  [/hollo/, DIALECT_FEDIBIRD],
  [/^fedibird$/, DIALECT_FEDIBIRD],
  [/^glitchcafe$/, DIALECT_FEDIBIRD],
  [/^akkoma$/, DIALECT_PLEROMA],
  [/^pleroma$/, DIALECT_PLEROMA],
];

export function dialectForSoftware(software) {
  const sw = String(software || '').toLowerCase();
  if (!sw) return null;
  for (const [re, dialect] of SOFTWARE_DIALECT) {
    if (re.test(sw)) return dialect;
  }
  return null;
}

function featureList(source) {
  return Array.isArray(source) ? source.map(f => String(f).toLowerCase()) : [];
}

function dialectFromFeatures(features) {
  const list = featureList(features);
  if (list.length === 0) return null;
  if (list.includes('pleroma_emoji_reactions')) return DIALECT_PLEROMA;
  if (list.some(f => f.includes('emoji_reaction'))) return DIALECT_FEDIBIRD;
  return null;
}

/**
 * NodeInfo 문서에서 읽는다.
 * Pleroma 2.1 부터 metadata.features 에 pleroma_emoji_reactions 를 싣는다.
 */
export function dialectFromNodeInfo(nodeinfo) {
  if (!nodeinfo || typeof nodeinfo !== 'object') return null;
  return dialectFromFeatures(nodeinfo.metadata?.features)
    || dialectForSoftware(nodeinfo.software?.name);
}

/**
 * /api/v2/instance (없으면 /api/v1/instance) 응답에서 읽는다.
 * Fedibird 의 InstanceSerializer 는 configuration.emoji_reactions 로
 * max_reactions 를 내놓고, fedibird_capabilities 로 확장 목록을 내놓는다.
 * Pleroma 계열은 같은 응답의 pleroma.metadata.features 에 실어 준다.
 */
export function dialectFromInstance(instance) {
  if (!instance || typeof instance !== 'object') return null;
  const pleroma = dialectFromFeatures(instance.pleroma?.metadata?.features);
  if (pleroma) return pleroma;
  const caps = dialectFromFeatures(instance.fedibird_capabilities);
  if (caps) return caps;
  const cfg = instance.configuration?.emoji_reactions;
  if (cfg && typeof cfg === 'object') return DIALECT_FEDIBIRD;
  return null;
}

/**
 * 글 하나에서 읽는다. 서버가 리액션을 실어 보냈다면 신고를 못 찾았어도 지원한다.
 * 빈 배열은 근거가 못 된다. 바닐라 마스토돈도 빈 배열을 실어 보낼 수 있다.
 */
export function dialectFromStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const pleroma = status.pleroma?.emoji_reactions;
  if (Array.isArray(pleroma) && pleroma.length > 0) return DIALECT_PLEROMA;
  const fedibird = status.emoji_reactions;
  if (Array.isArray(fedibird) && fedibird.length > 0) return DIALECT_FEDIBIRD;
  return null;
}

/**
 * 계정별로 알아낸 방언을 담아 둔다.
 * 카드를 그리는 쪽(dashboard)은 클라이언트 객체를 들고 있지 않고 글만 들고 있어서,
 * 글에 붙은 accountId 로 여기에 물어본다.
 */
const ACCOUNT_DIALECT = new Map();

export function setAccountReactionDialect(accountId, dialect) {
  if (!accountId) return null;
  if (dialect) ACCOUNT_DIALECT.set(accountId, dialect);
  else ACCOUNT_DIALECT.delete(accountId);
  return dialect || null;
}

export function accountReactionDialect(accountId) {
  return (accountId && ACCOUNT_DIALECT.get(accountId)) || null;
}

export function forgetAccountReactionDialect(accountId) {
  ACCOUNT_DIALECT.delete(accountId);
}

/** 테스트용 — 등록된 것을 모두 지운다 */
export function resetAccountReactionDialects() {
  ACCOUNT_DIALECT.clear();
}

/**
 * 카드에 리액션 단추를 달지 정한다.
 * 마스토돈 계열이 아니면(미스키 계열) 늘 단다.
 */
export function postSupportsReactions(post) {
  if (!post) return false;
  if (post.platform !== 'mastodon') return true;
  if (accountReactionDialect(post.accountId)) return true;
  if (dialectForSoftware(post.accountSoftware)) return true;
  if (post.mergedAccounts && post.mergedAccounts.some(a => a.platform !== 'mastodon')) return true;
  if (post.reactions && Object.keys(post.reactions).length > 0) return true;
  return false;
}
