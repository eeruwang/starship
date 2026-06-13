/**
 * Dashboard UI
 * Renders timeline posts, notifications, and account cards.
 */
import { escapeHtml, cachedImageUrl } from './utils.js';
import { familyOf } from './platform-families.js';
import {
  iconReply, iconBoost, iconStar, iconHeart, iconLink,
  iconRefresh, iconClose, iconWarning, iconImage,
  iconQuote, iconSmile, iconTrash, iconEdit, iconMore,
  iconHeartSmall, iconStarSmall, iconHeartFill,
  iconReplyNotif, iconBoostNotif, iconMegaphone,
  iconVisPublic, iconVisHome, iconVisFollowers, iconVisDirect,
  iconBookmark, iconBookmarkFill, iconPin,
  iconCheckCircle, iconXCircle,
  getNotifIcon,
} from './icons.js';

const NOTIF_TYPE_LABEL = {
  favourite: '좋아요했습니다',
  reblog: '부스트했습니다',
  renote: '리노트했습니다',
  reaction: '리액션을 보냈습니다',
  mention: '멘션했습니다',
  reply: '답글했습니다',
  follow: '팔로우했습니다',
  follow_request: '팔로우를 요청했습니다',
  receiveFollowRequest: '팔로우를 요청했습니다',
  quote: '인용했습니다',
  poll: '투표가 종료되었습니다',
  status: '새 글을 올렸습니다',
};

const VISIBILITY_ICONS = {
  public: { icon: iconVisPublic, title: '공개' },
  home: { icon: iconVisHome, title: '홈' },
  followers: { icon: iconVisFollowers, title: '팔로워만' },
  direct: { icon: iconVisDirect, title: '다이렉트' },
};

export const PLATFORM_COLORS = {
  misskey: '#96d04a',
  sharkey: '#3ea8ff',
  foundkey: '#71a6d2',
  hajkey: '#6bb87a',
  iceshrimp: '#7bc4e0',
  firefish: '#ee6a00',
  catodon: '#b088f9',
  cherrypick: '#ff6b9d',
  mastodon: '#6364ff',
  hollo: '#3ec9b0',
  akkoma: '#f0a030',
  pleroma: '#f56040',
  gotosocial: '#ff763b',
  hometown: '#8b6bff',
  glitchcafe: '#e04db9',
};

// Software → 짧은 배지 라벨. .platform-badge.{sw} 색은 base.css.
const PLATFORM_LABELS = {
  misskey: 'Misskey',
  sharkey: 'Sharkey',
  foundkey: 'FoundKey',
  hajkey: 'Hajkey',
  iceshrimp: 'Iceshrimp',
  firefish: 'Firefish',
  catodon: 'Catodon',
  cherrypick: 'CherryPick',
  mastodon: 'Mastodon',
  hollo: 'Hollo',
  akkoma: 'Akkoma',
  pleroma: 'Pleroma',
  gotosocial: 'GoToSocial',
  hometown: 'Hometown',
  glitchcafe: 'Glitch',
};

// host(string) → software(string) 캐시. account-setup.js의 NodeInfo 감지로 채워짐.
const HOST_PLATFORM_CACHE = new Map();
export function rememberHostPlatform(host, software) {
  if (!host || !software) return;
  HOST_PLATFORM_CACHE.set(host.toLowerCase(), software);
}

// 작성자의 acct(@user 또는 @user@host)와 canonical URL 패턴으로 작성자 서버의
// 플랫폼 계열을 추정. accountSoftware(보는 계정의 소프트웨어)와 별개.
function authorPlatform(post) {
  const display = post.reblog || post;
  const acct = display.author?.acct || '';
  const url = display.canonicalUri || display.url || '';
  let host = '';
  const at = acct.lastIndexOf('@');
  if (at > 0) host = acct.slice(at + 1).toLowerCase();
  if (!host && url) {
    try { host = new URL(url).host.toLowerCase(); } catch (_) {}
  }
  // 1) 호스트가 보는 계정의 인스턴스와 같으면 → 보는 계정 software 사용
  const accountSw = post.accountSoftware || null;
  const accountHost = (post.accountInstanceHost || '').toLowerCase();
  if (host && accountHost && host === accountHost && accountSw) return accountSw;
  if (!host && accountSw) return accountSw;   // 로컬 계정(acct에 @ 없음)
  // 2) 호스트 캐시 (NodeInfo 결과 등)
  if (host && HOST_PLATFORM_CACHE.has(host)) return HOST_PLATFORM_CACHE.get(host);
  // 3) URL 경로 패턴으로 계열 추정
  try {
    if (url) {
      const path = new URL(url).pathname;
      if (/^\/notes\/[a-zA-Z0-9]+$/.test(path)) return 'misskey';          // Misskey 계열
      if (/^\/(notice|objects)\/[a-zA-Z0-9\-]+$/.test(path)) return 'pleroma'; // Pleroma 계열
      if (/^\/@[^/]+\/statuses\/[a-zA-Z0-9]+$/.test(path)) return 'gotosocial';
      if (/^\/@[^/]+\/\d+$/.test(path)) return 'mastodon';                 // Mastodon
      if (/^\/users\/[^/]+\/statuses\/[a-zA-Z0-9]+$/.test(path)) return 'mastodon'; // 일반 AP
    }
  } catch (_) {}
  return null;
}

function platformBadgeHtml(post) {
  const sw = authorPlatform(post) || post.platform;
  if (!sw) return '';
  const label = PLATFORM_LABELS[sw] || sw;
  return `<span class="platform-badge ${escapeHtml(sw)} badge-xs">${escapeHtml(label)}</span>`;
}

// Mastodon-fork software that supports emoji reactions
const REACTION_SOFTWARE = new Set(['hollo', 'fedibird', 'glitchcafe', 'akkoma', 'pleroma']);

function supportsReactions(post) {
  // Non-mastodon platforms (Misskey forks) always support reactions
  if (post.platform !== 'mastodon') return true;
  // Mastodon forks with known reaction support
  if (post.accountSoftware && REACTION_SOFTWARE.has(post.accountSoftware)) return true;
  // Merged post from multiple accounts including a non-mastodon one
  if (post.mergedAccounts && post.mergedAccounts.some(a => a.platform !== 'mastodon')) return true;
  // Post already has reactions (server clearly supports them)
  if (post.reactions && Object.keys(post.reactions).length > 0) return true;
  return false;
}

// Mastodon의 theme-color 메타태그는 배경색(#181820/#ffffff)을 반환하므로
// 너무 어둡거나 밝은 색은 플랫폼 기본색으로 대체
export function usableColor(color, platform) {
  if (color) {
    const m = color.match(/^#?([0-9a-f]{6})$/i);
    if (m) {
      const h = m[1];
      const brightness = (parseInt(h.substring(0, 2), 16) * 299
        + parseInt(h.substring(2, 4), 16) * 587
        + parseInt(h.substring(4, 6), 16) * 114) / 1000;
      if (brightness >= 30 && brightness <= 225) return color;
    } else {
      return color;
    }
  }
  return PLATFORM_COLORS[platform] || '#7c7dff';
}

function isFediPostUrl(url) {
  try {
    const u = new URL(url);
    // Misskey/Calckey/Firefish: /notes/xxxx
    if (/^\/notes\/[a-zA-Z0-9]+$/.test(u.pathname)) return true;
    // Mastodon: /@user/123456 or /@user@host/123456
    if (/^\/@[^/]+\/\d+$/.test(u.pathname)) return true;
    // GoToSocial: /@user/statuses/01XXXX
    if (/^\/@[^/]+\/statuses\/[a-zA-Z0-9]+$/.test(u.pathname)) return true;
    // Pleroma/Akkoma: /notice/xxxx or /objects/xxxx
    if (/^\/(notice|objects)\/[a-zA-Z0-9\-]+$/.test(u.pathname)) return true;
    // ActivityPub standard: /users/xxx/statuses/xxx
    if (/^\/users\/[^/]+\/statuses\/[a-zA-Z0-9]+$/.test(u.pathname)) return true;
    return false;
  } catch { return false; }
}

/**
 * Extract YouTube video ID from a URL, or return null.
 */
function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0];
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtube-nocookie.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

/**
 * Check whether a URL should be embedded (fedi post or YouTube video).
 */
function isEmbeddableUrl(url) {
  return isFediPostUrl(url) || !!extractYouTubeId(url);
}

/**
 * Strip embeddable URL link from content HTML when it will be shown as a card/embed.
 * Prevents duplicate display of the URL as both inline text and link card / video embed.
 */
function stripFediLinkFromContent(content, linkCard) {
  if (!content || !linkCard?.url || !isEmbeddableUrl(linkCard.url)) return content;
  const escaped = linkCard.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedAmp = linkCard.url.replace(/&/g, '&amp;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const urlPattern = escaped === escapedAmp ? escaped : `(?:${escaped}|${escapedAmp})`;
  let result = content;
  // Remove <a> link in its own <p> paragraph
  result = result.replace(
    new RegExp(`<p>\\s*<a[^>]*href="${urlPattern}"[^>]*>[^<]*</a>\\s*</p>`, 'g'),
    ''
  );
  // Remove <a> link preceded by <br> (e.g. Misskey MFM → HTML conversion)
  result = result.replace(
    new RegExp(`\\s*<br\\s*/?>\\s*<a[^>]*href="${urlPattern}"[^>]*>[^<]*</a>`, 'g'),
    ''
  );
  return result;
}

/**
 * Convert standalone YouTube links and raw iframes in content HTML to embedded players.
 * Handles cases where YouTube URLs appear directly in content without a linkCard.
 */
function embedYouTubeInContent(content) {
  if (!content || !content.includes('youtu')) return content;

  const ytEmbed = (id) =>
    `<div class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(id)}" frameborder="0" allowfullscreen loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe></div>`;

  const tryEmbed = (match, rawUrl) => {
    const id = extractYouTubeId(rawUrl.replace(/&amp;/g, '&'));
    return id ? ytEmbed(id) : match;
  };

  let result = content;

  // 1. YouTube <a> as sole content of a <p> paragraph
  result = result.replace(
    /<p>\s*<a[^>]*href="([^"]*youtu[^"]*)"[^>]*>[\s\S]*?<\/a>\s*<\/p>/g,
    tryEmbed
  );

  // 2. YouTube <a> preceded by <br> (standalone on its own line)
  result = result.replace(
    /\s*<br\s*\/?>\s*<a[^>]*href="([^"]*youtu[^"]*)"[^>]*>[\s\S]*?<\/a>(?=\s*(?:<br[\s/>]|<\/p>|$))/g,
    tryEmbed
  );

  // 3. YouTube <a> at the very start of content (Misskey: no <p> wrapper)
  result = result.replace(
    /^<a[^>]*href="([^"]*youtu[^"]*)"[^>]*>[\s\S]*?<\/a>(?=\s*(?:<br[\s/>]|$))/,
    tryEmbed
  );

  // 4. Raw YouTube <iframe> already in content → normalize and wrap in .video-embed
  //    Use negative lookbehind to skip iframes already wrapped by cases 1-3 above
  result = result.replace(
    /(?<!video-embed">)<iframe[^>]*\bsrc="([^"]*(?:youtube\.com|youtube-nocookie\.com|youtu\.be)[^"]*)"[^>]*>(?:\s*<\/iframe>)?/g,
    tryEmbed
  );

  return result;
}

function renderQuotePost(qp, depth = 0) {
  const maxDepth = 2;
  const depthClass = depth > 0 ? ` quote-depth-${Math.min(depth, maxDepth)}` : '';
  const hasQpMedia = !qp.contentWarning && qp.media && qp.media.length > 0;
  const qpImages = hasQpMedia ? qp.media.filter(m => m.type !== 'video').slice(0, depth > 0 ? 2 : 3) : [];

  let html = `<div class="quote-post${depthClass}" data-quote-id="${escapeHtml(qp.id)}">`;
  html += `<div class="quote-post-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" opacity="0.6"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg> 인용</div>`;
  html += `<div class="quote-post-body">`;
  html += `<div class="quote-post-text-area">`;
  html += `<div class="quote-post-header">`;
  html += `<img class="quote-post-avatar" src="${cachedImageUrl(qp.author?.avatarUrl || '')}" alt="" width="18" height="18" referrerpolicy="no-referrer" data-fb="hide">`;
  html += `<span class="quote-post-author">${qp.author?.displayNameHtml || escapeHtml(qp.author?.displayName || '')}</span>`;
  html += `<span class="quote-post-handle">@${escapeHtml(qp.author?.acct || '')}</span>`;
  html += `</div>`;
  if (qp.contentWarning) {
    html += `<div class="quote-post-cw"><span class="icon-inline cw-icon">${iconWarning}</span> ${escapeHtml(qp.contentWarning)}</div>`;
  } else {
    html += `<div class="quote-post-content">${qp.content}</div>`;
  }
  // Nested quote (recursive)
  if (qp.quotePost && depth < maxDepth) {
    html += renderQuotePost(qp.quotePost, depth + 1);
  }
  html += `</div>`; // quote-post-text-area
  html += `</div>`; // quote-post-body
  if (qpImages.length > 0) {
    html += `<div class="quote-post-media media-${qpImages.length}">${qpImages.map(m => `<img src="${m.previewUrl || m.url}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fb="hide">`).join('')}</div>`;
  }
  html += `</div>`; // quote-post
  return html;
}

function renderReplyMedia(media) {
  if (!media || media.length === 0) return '';
  const items = media.filter(m => m.type !== 'audio').slice(0, 4);
  if (items.length === 0) return '';
  const layoutClass = getMediaLayoutClass(items);
  let html = `<div class="reply-context-media post-media media-${items.length}${layoutClass}">`;
  for (const m of items) {
    if (m.type === 'video') {
      html += `<video controls preload="none" poster="${m.previewUrl || ''}"><source src="${m.url}"></video>`;
    } else {
      html += `<img src="${m.previewUrl || m.url}" alt="${escapeHtml(m.description || '')}" loading="lazy" referrerpolicy="no-referrer" data-full-url="${m.url}" data-lightbox="true" data-fb="dim">`;
    }
  }
  html += '</div>';
  return html;
}

function renderLinkCardHtml(lc, extraClass = '') {
  if (!lc || !lc.url) return '';

  // YouTube → inline embed player
  const ytId = extractYouTubeId(lc.url);
  if (ytId) {
    const cls = extraClass ? `video-embed ${extraClass}` : 'video-embed';
    return `<div class="${cls}"><iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(ytId)}" frameborder="0" allowfullscreen loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe></div>`;
  }

  const hasImage = lc.image;
  const hasTitle = lc.title;
  const needsOg = !hasTitle && !hasImage;
  const isFediUrl = isFediPostUrl(lc.url);
  const baseClass = hasImage ? 'link-card link-card-has-image' : 'link-card';
  const cardClass = extraClass ? `${baseClass} ${extraClass}` : baseClass;
  let extraAttrs = '';
  if (isFediUrl) {
    extraAttrs = ` data-fedi-url="${escapeHtml(lc.url)}" data-fedi-pending="true"`;
  } else if (needsOg) {
    extraAttrs = ` data-og-url="${escapeHtml(lc.url)}" data-og-pending="true"`;
  }
  return `<a class="${cardClass}" href="${escapeHtml(lc.url)}" target="_blank" rel="noopener"${extraAttrs}>
    ${hasImage ? `<img class="link-card-image" src="${escapeHtml(lc.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fb="link-card">` : ''}
    <div class="link-card-info">
      <div class="link-card-site">${escapeHtml(lc.siteName || new URL(lc.url).hostname)}</div>
      ${hasTitle ? `<div class="link-card-title">${escapeHtml(lc.title)}</div>` : ''}
      ${lc.description ? `<div class="link-card-desc">${escapeHtml(lc.description)}</div>` : ''}
      ${!hasTitle ? `<div class="link-card-url">${escapeHtml(lc.url)}</div>` : ''}
    </div>
  </a>`;
}

const SENSITIVE_REVEAL_BTN = `<button class="sensitive-reveal" title="민감한 미디어 보기"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>민감한 콘텐츠</span></button>`;
const SENSITIVE_HIDE_BTN = `<button class="sensitive-hide" title="민감한 미디어 숨기기"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg><span>숨기기</span></button>`;

function getMediaLayoutClass(mediaItems) {
  const count = Math.min(mediaItems.length, 4);
  if (count <= 1) return '';
  const ratios = mediaItems.slice(0, count).map(m => {
    if (m.width && m.height) return m.width / m.height;
    return 1; // default to square if unknown
  });
  // portrait < 0.8, landscape > 1.2, square in between
  const orientations = ratios.map(r => r < 0.8 ? 'p' : r > 1.2 ? 'l' : 's');
  if (count === 2) {
    const allPortrait = orientations.every(o => o === 'p');
    const allLandscape = orientations.every(o => o === 'l' || o === 's');
    if (allPortrait) return ' layout-2p';
    if (allLandscape) return ' layout-2l';
    return ' layout-2m'; // mixed
  }
  if (count === 3) {
    // If first image is portrait, use left-big layout; if landscape, use top-big layout
    if (orientations[0] === 'p') return ' layout-3pl';
    return ' layout-3lt';
  }
  // count === 4: always 2x2
  return '';
}

function renderMediaGridHtml(mediaItems, isSensitive, extraClass = '') {
  if (!mediaItems || mediaItems.length === 0) return '';
  const count = Math.min(mediaItems.length, 4);
  const sensitiveClass = isSensitive ? ' media-sensitive' : '';
  const layoutClass = getMediaLayoutClass(mediaItems);
  const cls = extraClass
    ? `${extraClass} post-media media-${count}${layoutClass}${sensitiveClass}`
    : `post-media media-${count}${layoutClass}${sensitiveClass}`;
  let html = `<div class="${cls}">`;
  if (isSensitive) {
    html += SENSITIVE_REVEAL_BTN + SENSITIVE_HIDE_BTN;
  }
  for (const m of mediaItems.slice(0, count)) {
    if (m.type === 'video') {
      html += `<video controls preload="none" poster="${m.previewUrl || ''}"><source src="${m.url}"></video>`;
    } else {
      html += `<img src="${m.previewUrl || m.url}" alt="${escapeHtml(m.description || '')}" loading="lazy" referrerpolicy="no-referrer" data-full-url="${m.url}" data-lightbox="true" data-fb="dim">`;
    }
  }
  html += '</div>';
  return html;
}

function renderPollHtml(poll, postId, platform) {
  if (!poll || !poll.options) return '';
  const totalVotes = poll.votesCount || poll.options.reduce((s, o) => s + (o.votesCount || 0), 0);
  const hasVoted = poll.voted;
  const isExpired = poll.expired;
  const canVote = !hasVoted && !isExpired;

  let html = `<div class="post-poll" data-poll-id="${escapeHtml(poll.id)}" data-post-id="${escapeHtml(postId)}" data-platform="${escapeHtml(platform)}" data-multiple="${poll.multiple ? 'true' : 'false'}">`;

  for (let i = 0; i < poll.options.length; i++) {
    const opt = poll.options[i];
    const pct = totalVotes > 0 ? Math.round((opt.votesCount / totalVotes) * 100) : 0;
    const isOwn = poll.ownVotes && poll.ownVotes.includes(i);
    const inputType = poll.multiple ? 'checkbox' : 'radio';

    if (canVote) {
      html += `<label class="poll-option poll-option-votable">
        <input type="${inputType}" name="poll-${escapeHtml(postId)}" value="${i}" class="poll-input">
        <span class="poll-option-text">${escapeHtml(opt.title)}</span>
      </label>`;
    } else {
      html += `<div class="poll-option poll-option-result${isOwn ? ' poll-own-vote' : ''}">
        <div class="poll-bar" style="width:${pct}%"></div>
        <span class="poll-option-text">${escapeHtml(opt.title)}</span>
        <span class="poll-pct">${pct}%</span>
      </div>`;
    }
  }

  if (canVote) {
    html += `<button class="poll-vote-btn btn btn-small" data-action="vote-poll">투표</button>`;
  }

  html += `<div class="poll-info">${totalVotes}표`;
  if (poll.expiresAt) {
    if (isExpired) {
      html += ' · 종료됨';
    } else {
      const remaining = poll.expiresAt - new Date();
      if (remaining > 86400000) html += ` · ${Math.floor(remaining / 86400000)}일 남음`;
      else if (remaining > 3600000) html += ` · ${Math.floor(remaining / 3600000)}시간 남음`;
      else if (remaining > 60000) html += ` · ${Math.floor(remaining / 60000)}분 남음`;
      else html += ' · 곧 종료';
    }
  }
  html += '</div></div>';
  return html;
}

function renderReplyContextHtml(displayPost, ctxId) {
  if (displayPost.replyTo) {
    const replyAuthor = displayPost.replyTo.author;
    const parentCw = displayPost.replyTo.contentWarning;
    const parentText = stripHtml(displayPost.replyTo.content);
    const isLong = !parentCw && parentText.length > 200;
    return `
      <div class="reply-context">
        <div class="reply-context-header">
          <img class="reply-context-avatar" src="${cachedImageUrl(replyAuthor?.avatarUrl || '')}" alt="" width="16" height="16" referrerpolicy="no-referrer" data-fb="hide">
          <span class="reply-context-author">${replyAuthor?.displayNameHtml || escapeHtml(replyAuthor?.displayName || '')}</span>
        </div>
        ${parentCw ? `<div class="reply-context-cw"><span class="icon-inline cw-icon">${iconWarning}</span> ${escapeHtml(parentCw)} <button class="cw-toggle" data-cw-target="${ctxId}">내용 보기</button></div>` : ''}
        <div class="reply-context-content${isLong ? ' collapsed' : ''}${parentCw ? ' cw-content' : ''}" id="${ctxId}">${displayPost.replyTo.content}${renderReplyMedia(displayPost.replyTo.media)}</div>
        ${isLong ? `<button class="expand-toggle" data-expand-target="${ctxId}">더보기</button>` : ''}
      </div>
    `;
  } else if (displayPost.replyToAcct) {
    return `<div class="reply-indicator">↩ @${escapeHtml(displayPost.replyToAcct)} 에게 답글</div>`;
  } else if (displayPost.replyToId) {
    return `<div class="reply-indicator">↩ 답글</div>`;
  }
  return '';
}

export function renderPost(post) {
  const card = document.createElement('article');
  card.className = `post-card platform-${post.platform}`;
  card.dataset.postId = post.id;
  card.dataset.platform = post.platform;
  if (post.accountId) card.dataset.accountId = post.accountId;
  // 색맹 모드/계열 그룹핑용 가족 키
  const _sw = post.accountSoftware || post.platform;
  if (_sw) card.dataset.platformFamily = familyOf(_sw);
  const _dispAuthor = (post.reblog || post).author?.displayName || '';
  if (_dispAuthor) card.setAttribute('aria-label', `${_dispAuthor}의 글`);
  const displayPostForUri = post.reblog || post;
  if (displayPostForUri.canonicalUri) card.dataset.canonicalUri = displayPostForUri.canonicalUri;
  if (post._dedupKey) card.dataset.dedupKey = post._dedupKey;
  // Same-author grouping key (excludes boosts so 부스트 카드는 그룹핑 제외)
  if (!post.rebloggedBy && displayPostForUri.author?.acct) {
    card.dataset.authorAcct = displayPostForUri.author.acct;
  }

  // Per-account theme color for single-account posts
  if (!post.mergedAccounts || post.mergedAccounts.length <= 1) {
    card.style.borderLeftColor = usableColor(post.themeColor, post.platform);
  }

  // Merged account border (uses background trick to follow border-radius)
  if (post.mergedAccounts && post.mergedAccounts.length > 1) {
    const colors = post.mergedAccounts.map(a => usableColor(a.themeColor, a.platform));
    const segmentSize = 100 / colors.length;
    const stops = colors.map((c, i) =>
      `${c} ${i * segmentSize}%, ${c} ${(i + 1) * segmentSize}%`
    ).join(', ');
    card.style.setProperty('--merged-gradient', `linear-gradient(to bottom, ${stops})`);
    card.classList.add('merged-border');
  }

  let html = '';

  // Pin indicator
  if (post.pinned) {
    html += `<div class="pin-indicator"><span class="icon-inline">${iconPin}</span> 프로필에 고정됨</div>`;
  }

  // Renote / Boost indicator
  if (post.rebloggedBy) {
    const boostLabel = post.platform === 'mastodon' ? '부스트' : '리노트';
    const rbAvatar = post.rebloggedBy.avatarUrl
      ? `<img class="renote-avatar" src="${escapeHtml(cachedImageUrl(post.rebloggedBy.avatarUrl))}" alt="" width="18" height="18" loading="lazy" referrerpolicy="no-referrer" data-fb="hide">`
      : '';
    html += `<div class="renote-indicator"><span class="icon-inline boost-icon">${iconBoost}</span>${rbAvatar} ${post.rebloggedBy.displayNameHtml || escapeHtml(post.rebloggedBy.displayName)}님이 ${boostLabel}함</div>`;
  }

  const displayPost = post.reblog || post;

  // Reply context
  html += renderReplyContextHtml(displayPost, `reply-ctx-${post.id}`);

  // Header (always visible, even under CW)
  html += `
    <div class="post-header">
      <img class="post-avatar" src="${displayPost.author.avatarUrl ? cachedImageUrl(displayPost.author.avatarUrl) : 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23555%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2240%22>?</text></svg>'}"
           alt="${escapeHtml(displayPost.author.displayName)}"
           width="40" height="40"
           loading="lazy"
           referrerpolicy="no-referrer"
           data-fb="svg-placeholder">
      <div class="post-meta">
        <div class="post-author-row">
          <div class="post-author">${displayPost.author.displayNameHtml || escapeHtml(displayPost.author.displayName)}</div>
          ${platformBadgeHtml(post)}
        </div>
        <div class="post-handle">@${escapeHtml(displayPost.author.acct)}</div>
      </div>
      <span class="post-time" data-time="${displayPost.createdAt.toISOString()}" title="${displayPost.createdAt.toLocaleString()}"><span class="time-text">${timeAgo(displayPost.createdAt)}</span>${displayPost.visibility && VISIBILITY_ICONS[displayPost.visibility] ? `<span class="visibility-icon" title="${VISIBILITY_ICONS[displayPost.visibility].title}">${VISIBILITY_ICONS[displayPost.visibility].icon}</span>` : ''}</span>
    </div>
  `;

  // CW 배너 + 알약형 토글. .cw-open 클래스 토글로 .cw-content 노출.
  if (displayPost.contentWarning) {
    const cwId = `cw-${post.id}`;
    html += `
      <div class="cw-warning">
        <span class="cw-icon">${iconWarning}</span>
        <span class="cw-text">${escapeHtml(displayPost.contentWarning)}</span>
        <button class="cw-toggle" data-cw-target="${cwId}">내용 보기</button>
      </div>
    `;
    html += `<div class="cw-content" id="${cwId}">`;
  }

  // Content — strip fedi link URL from text when it will be shown as a card,
  // then convert standalone YouTube links/iframes to inline embed players.
  // Skip embedYouTubeInContent when a YouTube link card exists to avoid double embeds.
  const strippedContent = stripFediLinkFromContent(displayPost.content, displayPost.linkCard);
  const isYtLinkCard = displayPost.linkCard?.url && extractYouTubeId(displayPost.linkCard.url);
  const postContentHtml = isYtLinkCard ? strippedContent : embedYouTubeInContent(strippedContent);
  html += `<div class="post-content">${postContentHtml}</div>`;

  // Quote post (embedded) — supports nested quotes
  if (displayPost.quotePost) {
    html += renderQuotePost(displayPost.quotePost, 0);
  }

  // Media
  if (displayPost.media && displayPost.media.length > 0) {
    html += renderMediaGridHtml(displayPost.media, displayPost.sensitive || displayPost.media.some(m => m.sensitive));
  }

  // Poll
  if (displayPost.poll) {
    html += renderPollHtml(displayPost.poll, post.id, post.platform);
  }

  // Link card — suppress fedi link card when reply/quote context already shows the referenced post
  const suppressPostLinkCard = displayPost.linkCard?.url
    && isFediPostUrl(displayPost.linkCard.url)
    && (displayPost.replyTo || displayPost.quotePost);
  if (!suppressPostLinkCard) {
    html += renderLinkCardHtml(displayPost.linkCard);
  }

  if (displayPost.contentWarning) {
    html += '</div>'; // close cw-content
  }

  // Reactions (Misskey) / Favourites badge (Mastodon) — outside CW so always visible
  {
    const reactionsHtml = buildReactionsHtml(displayPost, post);
    if (reactionsHtml) html += `<div class="post-reactions">${reactionsHtml}</div>`;
  }

  // Actions
  const replyCount = displayPost.stats?.replies || 0;
  const boostCount = displayPost.stats?.boosts || 0;
  const favCount = displayPost.stats?.favourites || 0;

  const favIcon = iconHeart;
  const isFaved = post.favourited || (post.myReaction && (post.myReaction === '❤' || post.myReaction === '❤️'));
  const hasCustomReaction = post.myReaction && post.myReaction !== '❤' && post.myReaction !== '❤️';

  const hasReactionSupport = supportsReactions(post);

  const overflowItems = [];
  if (post.isOwn && !post.rebloggedBy) {
    overflowItems.push(`<button data-action="edit"><span class="action-icon">${iconEdit}</span>수정</button>`);
  }
  if (post.isOwn) {
    overflowItems.push(`<button class="danger" data-action="delete"><span class="action-icon">${iconTrash}</span>삭제</button>`);
  }
  overflowItems.push(`<button data-action="bookmark"><span class="action-icon">${post.bookmarked ? iconBookmarkFill : iconBookmark}</span>${post.bookmarked ? '북마크 해제' : '북마크'}</button>`);
  overflowItems.push(`<button data-action="open"><span class="action-icon">${iconLink}</span>원본 열기</button>`);

  html += `
    <div class="post-actions">
      <button class="post-action" data-action="reply" title="답글" aria-label="답글">
        <span class="action-icon">${iconReply}</span>
        ${replyCount > 0 ? `<span class="action-count">${replyCount}</span>` : ''}
      </button>
      <button class="post-action${post.reblogged ? ' active' : ''}" data-action="boost" title="${post.platform === 'mastodon' ? '부스트' : '리노트'}" aria-label="${post.platform === 'mastodon' ? '부스트' : '리노트'}">
        <span class="action-icon">${iconBoost}</span>
        ${boostCount > 0 ? `<span class="action-count">${boostCount}</span>` : ''}
      </button>
      <button class="post-action" data-action="quote" title="인용" aria-label="인용">
        <span class="action-icon">${iconQuote}</span>
      </button>
      <button class="post-action${isFaved ? ' active' : ''}" data-action="fav" title="좋아요" aria-label="좋아요">
        <span class="action-icon">${favIcon}</span>
        ${favCount > 0 ? `<span class="action-count">${favCount}</span>` : ''}
      </button>
      ${hasReactionSupport ? `<button class="post-action${hasCustomReaction ? ' active' : ''}" data-action="reaction" title="리액션" aria-label="리액션">
        <span class="action-icon">${iconSmile}</span>
      </button>` : ''}
      <button class="post-action" data-action="more" title="더보기" aria-label="더보기" aria-haspopup="true" aria-expanded="false">
        <span class="action-icon">${iconMore}</span>
      </button>
      <div class="post-action-overflow" hidden role="menu">${overflowItems.join('')}</div>
    </div>
  `;

  card.innerHTML = html;
  return card;
}

export function renderNotification(notif) {
  const card = document.createElement('article');
  const hasPost = !!notif.post?.id;
  card.className = `notif-card notif-type-${notif.type} platform-${notif.platform}${hasPost ? ' notif-clickable' : ''}`;
  card.dataset.notifId = notif.id;
  card.dataset.platform = notif.platform;
  const _nsw = notif.accountSoftware || notif.platform;
  if (_nsw) card.dataset.platformFamily = familyOf(_nsw);
  // 스크린리더용 한 문장 요약 — "OOO님이 좋아요했습니다"
  const _actorName = notif.actor?.displayName || notif.actor?.username || notif.actor?.acct || '';
  const _typeLabel = NOTIF_TYPE_LABEL[notif.type] || '활동했습니다';
  if (_actorName) card.setAttribute('aria-label', `${_actorName}님이 ${_typeLabel}`);
  // Dedup key for incremental updates (prefer normalized key from dedup)
  if (notif._dedupKey) {
    card.dataset.dedupKey = notif._dedupKey;
  } else {
    const actorKey = notif.actor?.acct || notif.actor?.id || '';
    const postKey = notif.post?.canonicalUri || notif.post?.id || '';
    const reactionKey = notif.reactionEmoji || '';
    card.dataset.dedupKey = `${notif.type}:${actorKey}:${postKey}:${reactionKey}`;
  }
  if (notif.accountId) card.dataset.accountId = notif.accountId;
  if (notif.post?.id) card.dataset.postId = notif.post.id;
  if (notif.post?.url) card.dataset.postUrl = notif.post.url;
  if (notif.actor?.id) card.dataset.actorId = notif.actor.id;
  if (notif.actor?.acct) card.dataset.actorAcct = notif.actor.acct;
  if (notif.actor?.displayName) card.dataset.actorName = notif.actor.displayName;
  if (notif.actor?.username) card.dataset.actorUsername = notif.actor.username;
  // Per-account or merged theme color
  if (notif.mergedAccounts && notif.mergedAccounts.length > 1) {
    const colors = notif.mergedAccounts.map(a => usableColor(a.themeColor, a.platform));
    const segmentSize = 100 / colors.length;
    const stops = colors.map((c, i) =>
      `${c} ${i * segmentSize}%, ${c} ${(i + 1) * segmentSize}%`
    ).join(', ');
    card.style.setProperty('--merged-gradient', `linear-gradient(to bottom, ${stops})`);
    card.classList.add('merged-border');
  } else {
    card.style.borderLeftColor = usableColor(notif.themeColor, notif.platform);
  }

  const displayPost = notif.post;
  let html = '';

  // Mention / Quote / Boost notifications: render as full post-card style
  const isMentionStyle = (notif.type === 'mention' || notif.type === 'quote' || notif.type === 'reblog') && displayPost;
  if (isMentionStyle) {
    card.classList.add('notif-mention');

    // Unified indicator: actor avatar with type badge + label
    const indicatorLabels = { quote: '인용', mention: '멘션', reblog: notif.platform === 'mastodon' ? '부스트' : '리노트' };
    const indicatorIcons = { quote: iconReplyNotif, mention: iconMegaphone, reblog: iconBoostNotif };
    const indicatorTypeClass = `notif-type-${notif.type}`;
    const actorName = notif.actor ? (notif.actor.displayNameHtml || escapeHtml(notif.actor.displayName)) : '';
    const actorAvatar = notif.actor?.avatarUrl || '';
    html += `<div class="notif-indicator">
      <div class="notif-actor-wrap notif-indicator-actor">
        <img class="notif-avatar" src="${escapeHtml(actorAvatar)}" alt="" referrerpolicy="no-referrer" data-fb="hide">
        <span class="notif-type-badge ${indicatorTypeClass}"><span class="notif-svg-icon">${indicatorIcons[notif.type] || iconReplyNotif}</span></span>
      </div>
      <span class="notif-indicator-label">${actorName} 님이 ${indicatorLabels[notif.type] || notif.type}</span>
    </div>`;

    // Reply context
    html += renderReplyContextHtml(displayPost, `notif-reply-ctx-${notif.id}`);

    // Post header (full avatar + name + handle + time)
    html += `
      <div class="post-header">
        <img class="post-avatar" src="${cachedImageUrl(displayPost.author.avatarUrl || '')}"
             alt="${escapeHtml(displayPost.author.displayName)}"
             width="40" height="40"
             loading="lazy" referrerpolicy="no-referrer"
             data-fb="dim">
        <div class="post-meta">
          <div class="post-author">${displayPost.author.displayNameHtml || escapeHtml(displayPost.author.displayName)}</div>
          <div class="post-handle">@${escapeHtml(displayPost.author.acct)}</div>
        </div>
        <span class="post-time" data-time="${(displayPost.createdAt || notif.createdAt).toISOString()}" title="${displayPost.createdAt?.toLocaleString?.() || ''}"><span class="time-text">${timeAgo(displayPost.createdAt || notif.createdAt)}</span>${displayPost.visibility && VISIBILITY_ICONS[displayPost.visibility] ? `<span class="visibility-icon" title="${VISIBILITY_ICONS[displayPost.visibility].title}">${VISIBILITY_ICONS[displayPost.visibility].icon}</span>` : ''}</span>
      </div>
    `;

    // CW
    const cwId = `notif-cw-${notif.id}`;
    if (displayPost.contentWarning) {
      html += `<div class="cw-warning"><span class="icon-inline cw-icon">${iconWarning}</span> ${escapeHtml(displayPost.contentWarning)} <button class="cw-toggle" data-cw-target="${cwId}">내용 보기</button></div>`;
      html += `<div class="cw-content" id="${cwId}">`;
    }

    // Content — strip fedi link URL, then convert standalone YouTube links to embeds
    const notifMentionContentHtml = embedYouTubeInContent(stripFediLinkFromContent(displayPost.content, displayPost.linkCard));
    html += `<div class="post-content">${notifMentionContentHtml}</div>`;

    // Quote post
    if (displayPost.quotePost) {
      html += renderQuotePost(displayPost.quotePost, 0);
    }

    // Poll
    if (displayPost.poll) {
      html += renderPollHtml(displayPost.poll, notif.post?.id || notif.id, notif.platform);
    }

    // Media
    if (displayPost.media && displayPost.media.length > 0) {
      html += renderMediaGridHtml(displayPost.media.slice(0, 4), displayPost.sensitive || displayPost.media.some(m => m.sensitive));
    }

    // Link card (notifications column: always show card)
    html += renderLinkCardHtml(displayPost.linkCard);

    // Reactions — always show post-level reaction badges so the full reaction
    // breakdown remains visible even when the notif badge already shows an emoji
    {
      const reactionsHtml = buildReactionsHtml(displayPost, notif);
      if (reactionsHtml) html += `<div class="post-reactions">${reactionsHtml}</div>`;
    }

    // Close CW
    if (displayPost.contentWarning) {
      html += '</div>';
    }

    // Full action buttons (same as post-card)
    const replyCount = displayPost.stats?.replies || 0;
    const boostCount = displayPost.stats?.boosts || 0;
    const favCount = displayPost.stats?.favourites || 0;
    const hasReactionSupport = supportsReactions(notif);
    const isFaved = notif.favourited || displayPost.favourited
      || (displayPost.myReaction && (displayPost.myReaction === '❤' || displayPost.myReaction === '❤️'));
    const hasCustomReaction = displayPost.myReaction && displayPost.myReaction !== '❤' && displayPost.myReaction !== '❤️';

    html += `
      <div class="post-actions">
        <button class="post-action" data-action="reply" title="답글" aria-label="답글"><span class="action-icon">${iconReply}</span>${replyCount > 0 ? `<span class="action-count">${replyCount}</span>` : ''}</button>
        <button class="post-action${notif.reblogged || displayPost.reblogged ? ' active' : ''}" data-action="boost" title="${notif.platform === 'mastodon' ? '부스트' : '리노트'}" aria-label="${notif.platform === 'mastodon' ? '부스트' : '리노트'}"><span class="action-icon">${iconBoost}</span>${boostCount > 0 ? `<span class="action-count">${boostCount}</span>` : ''}</button>
        <button class="post-action" data-action="quote" title="인용" aria-label="인용"><span class="action-icon">${iconQuote}</span></button>
        <button class="post-action${isFaved ? ' active' : ''}" data-action="fav" title="좋아요" aria-label="좋아요"><span class="action-icon">${iconHeart}</span>${favCount > 0 ? `<span class="action-count">${favCount}</span>` : ''}</button>
        ${hasReactionSupport ? `<button class="post-action${hasCustomReaction ? ' active' : ''}" data-action="reaction" title="리액션" aria-label="리액션"><span class="action-icon">${iconSmile}</span></button>` : ''}
        <button class="post-action action-end" data-action="open" title="원본 열기" aria-label="원본 열기"><span class="action-icon">${iconLink}</span></button>
      </div>
    `;

    card.innerHTML = html;
    return card;
  }

  // --- Standard notification layout (non-mention) ---
  let iconHtml;
  const notifTypeClass = `notif-type-${notif.type}`;
  if (notif.reactionEmojiUrl) {
    // Render custom emoji image; if it fails to load, swap in a heart SVG so the
    // badge never collapses to an empty white circle.
    iconHtml = `<img class="notif-custom-emoji" src="${escapeHtml(notif.reactionEmojiUrl)}" alt="${escapeHtml(notif.reactionEmoji || '')}" title="${escapeHtml(notif.reactionEmoji || '')}" referrerpolicy="no-referrer" data-fb="reveal-next"><span class="notif-svg-icon" style="display:none">${iconHeartFill}</span>`;
  } else {
    const icon = getNotifIcon(notif.type, notif.reactionEmoji);
    const isEmoji = typeof icon === 'string' && !icon.startsWith('<svg');
    // If we ended up with a raw shortcode (":foo:") because the URL couldn't be
    // resolved, the badge is too small to render the literal text — fall back
    // to the default reaction icon instead.
    if (isEmoji && typeof icon === 'string' && /^:.+:$/.test(icon)) {
      iconHtml = `<span class="notif-svg-icon">${iconHeartFill}</span>`;
    } else {
      iconHtml = isEmoji
        ? `<span class="notif-emoji">${icon}</span>`
        : `<span class="notif-svg-icon">${icon}</span>`;
    }
  }

  // Actor avatar with notification type badge overlay
  if (notif.actor && notif.actor.avatarUrl) {
    html += `
      <div class="notif-actor-wrap">
        <img class="notif-avatar" src="${escapeHtml(cachedImageUrl(notif.actor.avatarUrl))}" alt="" width="40" height="40" referrerpolicy="no-referrer" data-fb="hide">
        <span class="notif-type-badge ${notifTypeClass}">${iconHtml}</span>
      </div>
    `;
  } else {
    html += `<div class="notif-icon ${notifTypeClass}">${iconHtml}</div>`;
  }

  // Notification header: actor + label + time + visibility icon
  html += `
    <div class="notif-body">
      <div class="notif-text">
        ${notif.actor ? `<strong>${notif.actor.displayNameHtml || escapeHtml(notif.actor.displayName)}</strong>` : ''}
        ${escapeHtml(notif.label)}
      </div>
      <div class="notif-time" data-time="${notif.createdAt.toISOString()}"><span class="time-text">${timeAgo(notif.createdAt)}</span>${displayPost?.visibility && VISIBILITY_ICONS[displayPost.visibility] ? `<span class="visibility-icon" title="${VISIBILITY_ICONS[displayPost.visibility].title}">${VISIBILITY_ICONS[displayPost.visibility].icon}</span>` : ''}</div>
    </div>
  `;

  // Follow request: accept/reject buttons
  if (notif.type === 'receiveFollowRequest' || notif.type === 'follow_request') {
    html += `<div class="follow-request-actions">
      <button class="btn btn-small btn-primary follow-req-btn" data-action="accept-follow" data-actor-id="${escapeHtml(notif.actor?.id || '')}" data-account-id="${escapeHtml(notif.accountId || '')}" data-platform="${escapeHtml(notif.platform)}">${iconCheckCircle} 수락</button>
      <button class="btn btn-small btn-danger follow-req-btn" data-action="reject-follow" data-actor-id="${escapeHtml(notif.actor?.id || '')}" data-account-id="${escapeHtml(notif.accountId || '')}" data-platform="${escapeHtml(notif.platform)}">${iconXCircle} 거절</button>
    </div>`;
  }

  // Reply context (full content + CW toggle) for reply/mention/quote notifications
  if (['reply', 'quote'].includes(notif.type) && displayPost) {
    if (displayPost.replyTo) {
      const notifReplyAuthor = displayPost.replyTo.author;
      const parentCw = displayPost.replyTo.contentWarning;
      const parentText = stripHtml(displayPost.replyTo.content);
      const isLong = !parentCw && parentText.length > 200;
      const replyCtxId = `notif-reply-ctx-${notif.id}`;
      html += `<div class="notif-parent-context notif-parent-context-full">
        <div class="notif-parent-header">
          <img class="notif-parent-avatar" src="${cachedImageUrl(notifReplyAuthor?.avatarUrl || '')}" alt="" width="16" height="16" referrerpolicy="no-referrer" data-fb="hide">
          <span class="notif-parent-author">${notifReplyAuthor?.displayNameHtml || escapeHtml(notifReplyAuthor?.displayName || '')}</span>
          <span class="notif-parent-label-tag">원본</span>
        </div>
        ${parentCw ? `<div class="reply-context-cw"><span class="icon-inline cw-icon">${iconWarning}</span> ${escapeHtml(parentCw)} <button class="cw-toggle" data-cw-target="${replyCtxId}">내용 보기</button></div>` : ''}
        <div class="notif-parent-content${isLong ? ' collapsed' : ''}${parentCw ? ' cw-content' : ''}" id="${replyCtxId}">${displayPost.replyTo.content}${renderReplyMedia(displayPost.replyTo.media)}</div>
        ${isLong ? `<button class="expand-toggle" data-expand-target="${replyCtxId}">더보기</button>` : ''}
      </div>`;
    } else if (displayPost.replyToAcct) {
      html += `<div class="notif-parent-context">
        <span class="notif-parent-label">↩ @${escapeHtml(displayPost.replyToAcct)}의 글에 답글</span>
      </div>`;
    } else if (displayPost.replyToId) {
      html += `<div class="notif-parent-context">
        <span class="notif-parent-label">↩ 답글</span>
      </div>`;
    }
  }

  // Post content area (with CW toggle, media, quote, reactions, link card)
  const hasDisplayContent = displayPost && (displayPost.content || (displayPost.media && displayPost.media.length > 0) || displayPost.quotePost || displayPost.linkCard);
  if (hasDisplayContent) {
    html += `<div class="notif-content-wrap">`;
    const notifCwId = `notif-cw-${notif.id}`;

    // CW (Content Warning) toggle
    if (displayPost.contentWarning) {
      html += `<div class="notif-cw-warning">
        <span class="icon-inline cw-icon">${iconWarning}</span> ${escapeHtml(displayPost.contentWarning)}
        <button class="cw-toggle" data-cw-target="${notifCwId}">내용 보기</button>
      </div>`;
      html += `<div class="cw-content" id="${notifCwId}">`;
    }

    // Post text content — strip fedi link URL, then convert standalone YouTube links to embeds
    const notifStdContentHtml = embedYouTubeInContent(stripFediLinkFromContent(displayPost.content, displayPost.linkCard));
    const notifText = stripHtml(notifStdContentHtml);
    const isLongNotif = notifText.length > 200;
    const notifCtxId = `notif-ctx-${notif.id}`;
    html += `<div class="notif-post-content${isLongNotif ? ' collapsed' : ''}" id="${notifCtxId}">${notifStdContentHtml}</div>`;
    if (isLongNotif) {
      html += `<button class="expand-toggle" data-expand-target="${notifCtxId}">더보기</button>`;
    }

    // Quote post (embedded)
    if (displayPost.quotePost) {
      html += renderQuotePost(displayPost.quotePost, 0);
    }

    // Poll
    if (displayPost.poll) {
      html += renderPollHtml(displayPost.poll, displayPost.id, notif.platform);
    }

    // Media grid with sensitive overlay
    if (displayPost.media && displayPost.media.length > 0) {
      html += renderMediaGridHtml(displayPost.media.slice(0, 4), displayPost.sensitive || displayPost.media.some(m => m.sensitive), 'notif-media-grid');
    }

    // Link card preview (OG metadata)
    html += renderLinkCardHtml(displayPost.linkCard, 'notif-link-card');

    // Close CW content wrapper
    if (displayPost.contentWarning) {
      html += '</div>'; // close cw-content
    }

    // Reaction badges — outside CW so always visible; always show post-level
    // reaction badges so the full reaction breakdown remains visible
    {
      const reactionsHtml = buildReactionsHtml(displayPost, notif);
      if (reactionsHtml) html += `<div class="post-reactions notif-reactions">${reactionsHtml}</div>`;
    }

    // Action buttons with counts and active states (hide for favourite/reaction notifications)
    if (hasPost && !['favourite', 'reaction'].includes(notif.type)) {
      const replyCount = displayPost.stats?.replies || 0;
      const boostCount = displayPost.stats?.boosts || 0;
      let favCount = displayPost.stats?.favourites || 0;
      if (!favCount && displayPost.reactions) {
        favCount = (displayPost.reactions['❤'] || 0) + (displayPost.reactions['❤️'] || 0);
      }
      const hasReactionSupport = supportsReactions(notif);
      const isBoosted = notif.reblogged || displayPost.reblogged;
      const isFaved = notif.favourited || displayPost.favourited
        || (displayPost.myReaction && (displayPost.myReaction === '❤' || displayPost.myReaction === '❤️'));
      const hasCustomReaction = displayPost.myReaction && displayPost.myReaction !== '❤' && displayPost.myReaction !== '❤️';

      html += `<div class="notif-actions">
        <button class="notif-action-btn" data-action="reply" title="답글" aria-label="답글">${iconReply}${replyCount > 0 ? `<span class="notif-action-count">${replyCount}</span>` : ''}</button>
        <button class="notif-action-btn${isBoosted ? ' active' : ''}" data-action="boost" title="부스트/리노트" aria-label="부스트/리노트">${iconBoost}${boostCount > 0 ? `<span class="notif-action-count">${boostCount}</span>` : ''}</button>
        <button class="notif-action-btn${isFaved ? ' active' : ''}" data-action="fav" title="좋아요" aria-label="좋아요">${iconHeart}${favCount > 0 ? `<span class="notif-action-count">${favCount}</span>` : ''}</button>
        ${hasReactionSupport ? `<button class="notif-action-btn${hasCustomReaction ? ' active' : ''}" data-action="reaction" title="리액션 선택" aria-label="리액션 선택">${iconSmile}</button>` : ''}
      </div>`;
    }

    html += '</div>'; // close notif-content-wrap
  }
  card.innerHTML = html;
  return card;
}

export function renderAccountCard(account, onRemove) {
  const sw = account.software || account.platform;
  const card = document.createElement('div');
  card.className = `account-card platform-${sw}`;
  card.style.borderLeftColor = usableColor(account.themeColor, sw);

  const p = account.profile;
  const softwareLabels = {
    misskey: 'Misskey',
    sharkey: 'Sharkey',
    foundkey: 'FoundKey',
    hajkey: 'Hajkey',
    iceshrimp: 'Iceshrimp',
    firefish: 'Firefish',
    catodon: 'Catodon',
    cherrypick: 'CherryPick',
    mastodon: 'Mastodon',
    hollo: 'Hollo',
    akkoma: 'Akkoma',
    pleroma: 'Pleroma',
    gotosocial: 'GoToSocial',
    hometown: 'Hometown',
    glitchcafe: 'Glitch',
  };

  const postLabel = account.platform === 'mastodon' ? '게시물' : '노트';
  const postCount = p.statusesCount ?? p.notesCount ?? 0;

  card.innerHTML = `
    <div class="account-card-header">
      <img class="account-card-avatar" src="${p.avatarUrl || ''}" alt="${escapeHtml(p.displayName)}" width="40" height="40" loading="lazy"
           data-fb="svg-placeholder">
      <div class="account-card-info">
        <div class="account-card-name">${escapeHtml(p.displayName)}</div>
        <div class="account-card-handle">@${escapeHtml(p.acct)} · ${new URL(account.instanceUrl).hostname}</div>
      </div>
      <span class="account-card-platform platform-badge ${sw}">${softwareLabels[sw] || sw}</span>
      ${account.needsReauth ? '<span class="account-card-reauth" title="토큰이 만료되었거나 권한이 부족합니다. 계정을 다시 연결해주세요.">재인증 필요</span>' : ''}
    </div>
    <div class="account-card-stats">
      <div class="account-stat">
        <div class="account-stat-value">${formatNumber(postCount)}</div>
        <div class="account-stat-label">${postLabel}</div>
      </div>
      <div class="account-stat">
        <div class="account-stat-value">${formatNumber(p.followingCount || 0)}</div>
        <div class="account-stat-label">팔로잉</div>
      </div>
      <div class="account-stat">
        <div class="account-stat-value">${formatNumber(p.followersCount || 0)}</div>
        <div class="account-stat-label">팔로워</div>
      </div>
    </div>
    <div class="account-card-actions">
      <button class="btn btn-secondary btn-small" data-action="view-profile" data-account-id="${account.id}">프로필 보기</button>
      <button class="btn btn-danger btn-small" data-action="remove-account" data-account-id="${account.id}">연결 해제</button>
    </div>
  `;

  const removeBtn = card.querySelector('[data-action="remove-account"]');
  removeBtn.addEventListener('click', () => {
    if (confirm(`${p.displayName} 계정 연결을 해제하시겠습니까?`)) {
      onRemove(account.id);
    }
  });

  const profileBtn = card.querySelector('[data-action="view-profile"]');
  profileBtn.addEventListener('click', () => {
    window.open(`${account.instanceUrl}/@${p.username}`, '_blank', 'noopener');
  });

  return card;
}

// 컬럼 초기 로드용 스켈레톤 카드 묶음 (spinner 대체)
export function renderLoading(count = 4) {
  const wrap = document.createElement('div');
  wrap.className = 'skeleton-stack';
  wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'skeleton-card';
    card.innerHTML = `
      <div class="skeleton-header">
        <div class="skeleton-avatar"></div>
        <div class="skeleton-meta">
          <div class="skeleton-line w-50"></div>
          <div class="skeleton-line w-70" style="margin-top:6px"></div>
        </div>
      </div>
      <div class="skeleton-body">
        <div class="skeleton-line w-90" style="margin-top:10px"></div>
        <div class="skeleton-line w-70" style="margin-top:6px"></div>
      </div>
    `;
    wrap.appendChild(card);
  }
  return wrap;
}

export function renderLoadingText(message = '불러오는 중...') {
  const div = document.createElement('div');
  div.className = 'state-block empty';
  div.innerHTML = `
    <div class="state-icon">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    </div>
    <div class="state-title">${escapeHtml(message)}</div>
  `;
  return div;
}

export function renderErrorState(message = '문제가 발생했어요') {
  const div = document.createElement('div');
  div.className = 'state-block error';
  div.innerHTML = `
    <div class="state-icon">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    </div>
    <div class="state-title">${escapeHtml(message)}</div>
  `;
  return div;
}

// Export icons for use in main.js column headers
export { iconRefresh, iconClose, iconImage, renderPollHtml };

/** Build inner HTML for the .post-reactions section */
export function buildReactionsHtml(displayPost, wrapperPost) {
  const hasReactions = displayPost.reactions && Object.keys(displayPost.reactions).length > 0;

  // ❤ 리액션은 favourite 와 동일한 행위(같은 사용자 집합).
  // 둘을 합산(+=)하면 1명이 2로 보이는 중복 카운트가 발생하므로 max 로 통합.
  // - 바닐라 Mastodon: stats.favourites=N, reactions={} → max(N, 0)=N
  // - Misskey: stats.favourites=0, reactions={'❤':H} → max(0, H)=H
  // - Mastodon-fork(Hollo/Akkoma/Pleroma): stats.favourites=H(정규화에서 nonHeart 차감됨),
  //   reactions={'❤':H, ...} → max(H, H)=H
  let favCount = displayPost.stats?.favourites || 0;
  const nonHeartReactions = [];
  if (hasReactions) {
    for (const [reaction, count] of Object.entries(displayPost.reactions)) {
      if (reaction === '❤' || reaction === '❤️') {
        favCount = Math.max(favCount, count);
      } else {
        nonHeartReactions.push([reaction, count]);
      }
    }
  }

  const hasFavs = favCount > 0;
  const hasNonHeartReactions = nonHeartReactions.length > 0;
  if (!hasNonHeartReactions && !hasFavs) return '';
  let html = '';
  if (hasFavs) {
    const isFaved = wrapperPost.favourited || displayPost.favourited
      || (displayPost.myReaction && (displayPost.myReaction === '❤' || displayPost.myReaction === '❤️'));
    html += `<span class="engagement-likes"><span class="reaction-badge like-badge${isFaved ? ' reacted' : ''}" data-reaction="favourite"><span class="reaction-icon reaction-heart">${iconHeartSmall}</span> <span class="reaction-count">${favCount}</span></span></span>`;
  }
  if (hasNonHeartReactions) {
    html += `<span class="engagement-reactions">`;
    for (const [reaction, count] of nonHeartReactions) {
      const emojiHtml = resolveReactionHtml(reaction, displayPost.reactionEmojis, displayPost.emojis, displayPost._reactionInstanceUrl || displayPost.instanceUrl);
      html += `<span class="reaction-badge" data-reaction="${escapeHtml(reaction)}" title="클릭하여 리액션한 사용자 보기">${emojiHtml} <span class="reaction-count">${count}</span></span>`;
    }
    html += `</span>`;
  }
  return html;
}

// Helpers

function stripHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent || '';
}

export function timeAgo(date) {
  const now = new Date();
  const diff = (now - date) / 1000;

  if (diff < 60) return '방금';
  if (diff < 3600) return `${Math.floor(diff / 60)}분`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}일`;

  return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

const REACTION_ICON_MAP = {
  '❤': () => `<span class="reaction-icon reaction-heart">${iconHeartSmall}</span>`,
  '❤️': () => `<span class="reaction-icon reaction-heart">${iconHeartSmall}</span>`,
  '⭐': () => `<span class="reaction-icon reaction-star">${iconStarSmall}</span>`,
  '⭐️': () => `<span class="reaction-icon reaction-star">${iconStarSmall}</span>`,
};

function resolveReactionHtml(reaction, reactionEmojis, emojis, instanceUrl) {
  // Check if it's a custom emoji (:name: or :name@.:)
  const match = reaction.match(/^:(.+):$/);
  if (match) {
    const name = match[1];
    const nameBase = name.replace(/@\.$/, '');
    const url = (reactionEmojis && (reactionEmojis[nameBase] || reactionEmojis[nameBase + '@.']))
             || (emojis && (emojis[nameBase] || emojis[nameBase + '@.']))
             || null;
    if (url) {
      return `<img class="custom-emoji" src="${escapeHtml(url)}" alt="${escapeHtml(reaction)}" title="${escapeHtml(reaction)}" referrerpolicy="no-referrer">`;
    }
    // Fallback: try instance emoji URL for local emojis
    const baseName = name.replace(/@\.$/, ''); // strip @. suffix
    if (instanceUrl && !baseName.includes('@')) {
      return `<img class="custom-emoji" src="${escapeHtml(instanceUrl)}/emoji/${encodeURIComponent(baseName)}.webp" alt="${escapeHtml(reaction)}" title="${escapeHtml(reaction)}" referrerpolicy="no-referrer" data-fb="alt-text">`;
    }
  }
  // Replace common unicode reactions with themed SVG icons
  const iconFn = REACTION_ICON_MAP[reaction];
  if (iconFn) return iconFn();
  return `<span class="reaction-unicode">${reaction}</span>`;
}
