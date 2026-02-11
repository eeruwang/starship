/**
 * Dashboard UI
 * Renders timeline posts, notifications, and account cards.
 */
import {
  iconReply, iconBoost, iconStar, iconHeart, iconLink,
  iconRefresh, iconClose, iconWarning, iconImage,
  iconQuote, iconSmile, iconTrash, iconEdit,
  iconHeartSmall, iconStarSmall,
  iconVisPublic, iconVisHome, iconVisFollowers, iconVisDirect,
  getNotifIcon,
} from './icons.js';

const VISIBILITY_ICONS = {
  public: { icon: iconVisPublic, title: '공개' },
  home: { icon: iconVisHome, title: '홈' },
  followers: { icon: iconVisFollowers, title: '팔로워만' },
  direct: { icon: iconVisDirect, title: '다이렉트' },
};

const PLATFORM_COLORS = {
  misskey: '#96d04a',
  iceshrimp: '#e36a8a',
  cherrypick: '#ff6b9d',
  mastodon: '#6364ff',
};

// Mastodon의 theme-color 메타태그는 배경색(#181820/#ffffff)을 반환하므로
// 너무 어둡거나 밝은 색은 플랫폼 기본색으로 대체
function usableColor(color, platform) {
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
    if (/^\/notes\/[a-zA-Z0-9]+$/.test(u.pathname)) return true;
    if (/^\/@[^/]+\/\d+$/.test(u.pathname)) return true;
    if (/^\/(notice|objects)\/[a-zA-Z0-9\-]+$/.test(u.pathname)) return true;
    return false;
  } catch { return false; }
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
  html += `<img class="quote-post-avatar" src="${qp.author?.avatarUrl || ''}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">`;
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
  if (qpImages.length === 1) {
    html += `<div class="quote-post-thumb"><img src="${qpImages[0].previewUrl || qpImages[0].url}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.style.display='none'"></div>`;
  }
  html += `</div>`; // quote-post-body
  if (qpImages.length > 1) {
    html += `<div class="quote-post-media media-${qpImages.length}">${qpImages.map(m => `<img src="${m.previewUrl || m.url}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`).join('')}</div>`;
  }
  html += `</div>`; // quote-post
  return html;
}

export function renderPost(post) {
  const card = document.createElement('div');
  card.className = `post-card platform-${post.platform}`;
  card.dataset.postId = post.id;
  card.dataset.platform = post.platform;
  if (post.accountId) card.dataset.accountId = post.accountId;
  const displayPostForUri = post.reblog || post;
  if (displayPostForUri.canonicalUri) card.dataset.canonicalUri = displayPostForUri.canonicalUri;
  if (post._dedupKey) card.dataset.dedupKey = post._dedupKey;

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

  // Renote / Boost indicator
  if (post.rebloggedBy) {
    const boostLabel = post.platform === 'mastodon' ? '부스트' : '리노트';
    html += `<div class="renote-indicator"><span class="icon-inline boost-icon">${iconBoost}</span> ${post.rebloggedBy.displayNameHtml || escapeHtml(post.rebloggedBy.displayName)}님이 ${boostLabel}함</div>`;
  }

  const displayPost = post.reblog || post;

  // Reply context
  if (displayPost.replyTo) {
    const replyAuthor = displayPost.replyTo.author;
    const parentCw = displayPost.replyTo.contentWarning;
    const parentText = stripHtml(displayPost.replyTo.content);
    const isLong = !parentCw && parentText.length > 200;
    const replyCtxId = `reply-ctx-${post.id}`;
    html += `
      <div class="reply-context">
        <div class="reply-context-header">
          <img class="reply-context-avatar" src="${replyAuthor?.avatarUrl || ''}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
          <span class="reply-context-author">${replyAuthor?.displayNameHtml || escapeHtml(replyAuthor?.displayName || '')}</span>
        </div>
        ${parentCw ? `<div class="reply-context-cw"><span class="icon-inline cw-icon">${iconWarning}</span> ${escapeHtml(parentCw)} <button class="cw-toggle" data-cw-target="${replyCtxId}">내용 보기</button></div>` : ''}
        <div class="reply-context-content${isLong ? ' collapsed' : ''}${parentCw ? ' cw-content' : ''}" id="${replyCtxId}">${displayPost.replyTo.content}</div>
        ${isLong ? `<button class="expand-toggle" data-expand-target="${replyCtxId}">더보기</button>` : ''}
      </div>
    `;
  } else if (displayPost.replyToAcct) {
    html += `<div class="reply-indicator">↩ @${escapeHtml(displayPost.replyToAcct)} 에게 답글</div>`;
  } else if (displayPost.replyToId) {
    html += `<div class="reply-indicator">↩ 답글</div>`;
  }

  // Header (always visible, even under CW)
  html += `
    <div class="post-header">
      <img class="post-avatar" src="${displayPost.author.avatarUrl || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23555%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2240%22>?</text></svg>'}"
           alt="${escapeHtml(displayPost.author.displayName)}"
           loading="lazy"
           referrerpolicy="no-referrer"
           onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23555%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2240%22>?</text></svg>'">
      <div class="post-meta">
        <div class="post-author">${displayPost.author.displayNameHtml || escapeHtml(displayPost.author.displayName)}</div>
        <div class="post-handle">@${escapeHtml(displayPost.author.acct)}</div>
      </div>
      <span class="post-time" title="${displayPost.createdAt.toLocaleString()}">${timeAgo(displayPost.createdAt)}${displayPost.visibility && VISIBILITY_ICONS[displayPost.visibility] ? `<span class="visibility-icon" title="${VISIBILITY_ICONS[displayPost.visibility].title}">${VISIBILITY_ICONS[displayPost.visibility].icon}</span>` : ''}</span>
    </div>
  `;

  // CW (after header, only hides content/media/reactions)
  if (displayPost.contentWarning) {
    const cwId = `cw-${post.id}`;
    html += `
      <div class="cw-warning">
        <span class="icon-inline cw-icon">${iconWarning}</span> ${escapeHtml(displayPost.contentWarning)}
        <button class="cw-toggle" data-cw-target="${cwId}">내용 보기</button>
      </div>
    `;
    html += `<div class="cw-content" id="${cwId}">`;
  }

  // Content
  html += `<div class="post-content">${displayPost.content}</div>`;

  // Quote post (embedded) — supports nested quotes
  if (displayPost.quotePost) {
    html += renderQuotePost(displayPost.quotePost, 0);
  }

  // Media
  if (displayPost.media && displayPost.media.length > 0) {
    const count = Math.min(displayPost.media.length, 4);
    // Sensitive: post-level (Mastodon) or any file-level (Misskey)
    const hasSensitive = displayPost.sensitive || displayPost.media.some(m => m.sensitive);
    const sensitiveClass = hasSensitive ? ' media-sensitive' : '';
    html += `<div class="post-media media-${count}${sensitiveClass}">`;
    if (hasSensitive) {
      html += `<button class="sensitive-reveal" title="민감한 미디어 보기"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>민감한 콘텐츠</span></button>`;
      html += `<button class="sensitive-hide" title="민감한 미디어 숨기기"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg><span>숨기기</span></button>`;
    }
    for (const m of displayPost.media) {
      if (m.type === 'video') {
        html += `<video controls preload="none" poster="${m.previewUrl || ''}"><source src="${m.url}"></video>`;
      } else {
        html += `<img src="${m.previewUrl || m.url}" alt="${escapeHtml(m.description || '')}" loading="lazy" referrerpolicy="no-referrer" data-full-url="${m.url}" data-lightbox="true" onerror="this.style.opacity='0.3'">`;
      }
    }
    html += '</div>';
  }

  // Link card
  if (displayPost.linkCard && displayPost.linkCard.url) {
    const lc = displayPost.linkCard;
    const hasImage = lc.image;
    const hasTitle = lc.title;
    const needsOg = !hasTitle && !hasImage;
    // Detect fediverse post URLs
    const isFediUrl = isFediPostUrl(lc.url);
    const cardClass = hasImage ? 'link-card link-card-has-image' : 'link-card';
    let extraAttrs = '';
    if (isFediUrl) {
      extraAttrs = ` data-fedi-url="${escapeHtml(lc.url)}" data-fedi-pending="true"`;
    } else if (needsOg) {
      extraAttrs = ` data-og-url="${escapeHtml(lc.url)}" data-og-pending="true"`;
    }
    html += `
      <a class="${cardClass}" href="${escapeHtml(lc.url)}" target="_blank" rel="noopener"${extraAttrs}>
        ${hasImage ? `<img class="link-card-image" src="${escapeHtml(lc.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.remove('link-card-has-image');this.style.display='none'">` : ''}
        <div class="link-card-info">
          <div class="link-card-site">${escapeHtml(lc.siteName || new URL(lc.url).hostname)}</div>
          ${hasTitle ? `<div class="link-card-title">${escapeHtml(lc.title)}</div>` : ''}
          ${lc.description ? `<div class="link-card-desc">${escapeHtml(lc.description)}</div>` : ''}
          ${!hasTitle ? `<div class="link-card-url">${escapeHtml(lc.url)}</div>` : ''}
        </div>
      </a>
    `;
  }

  // Reactions (Misskey) / Favourites badge (Mastodon)
  if (displayPost.reactions && Object.keys(displayPost.reactions).length > 0) {
    html += '<div class="post-reactions">';
    for (const [reaction, count] of Object.entries(displayPost.reactions)) {
      const emojiHtml = resolveReactionHtml(reaction, displayPost.reactionEmojis, displayPost.emojis, displayPost.instanceUrl);
      html += `<span class="reaction-badge" data-reaction="${escapeHtml(reaction)}" title="클릭하여 리액션한 사용자 보기">${emojiHtml} <span class="reaction-count">${count}</span></span>`;
    }
    html += '</div>';
  } else if (post.platform === 'mastodon' && displayPost.stats?.favourites > 0) {
    html += `<div class="post-reactions"><span class="reaction-badge${post.favourited ? ' reacted' : ''}"><span class="reaction-icon reaction-heart">${iconHeartSmall}</span> <span class="reaction-count">${displayPost.stats.favourites}</span></span></div>`;
  }

  if (displayPost.contentWarning) {
    html += '</div>'; // close cw-content
  }

  // Actions
  const replyCount = displayPost.stats?.replies || 0;
  const boostCount = displayPost.stats?.reblogs || displayPost.stats?.renotes || 0;
  const favCount = displayPost.stats?.favourites || displayPost.stats?.reactions || 0;

  const favIcon = iconHeart;

  const isMisskey = post.platform !== 'mastodon'
    || (post.mergedAccounts && post.mergedAccounts.some(a => a.platform !== 'mastodon'));

  html += `
    <div class="post-actions">
      <button class="post-action" data-action="reply" title="답글">
        <span class="action-icon">${iconReply}</span>
        ${replyCount > 0 ? `<span class="action-count">${replyCount}</span>` : ''}
      </button>
      <button class="post-action${post.reblogged ? ' active' : ''}" data-action="boost" title="${post.platform === 'mastodon' ? '부스트' : '리노트'}">
        <span class="action-icon">${iconBoost}</span>
        ${boostCount > 0 ? `<span class="action-count">${boostCount}</span>` : ''}
      </button>
      <button class="post-action" data-action="quote" title="인용">
        <span class="action-icon">${iconQuote}</span>
      </button>
      <button class="post-action${(post.favourited || post.myReaction) ? ' active' : ''}" data-action="fav" title="좋아요">
        <span class="action-icon">${favIcon}</span>
        ${favCount > 0 ? `<span class="action-count">${favCount}</span>` : ''}
      </button>
      ${isMisskey ? `<button class="post-action" data-action="reaction" title="리액션">
        <span class="action-icon">${iconSmile}</span>
      </button>` : ''}
      ${post.isOwn ? `<button class="post-action action-edit" data-action="edit" title="수정">
        <span class="action-icon">${iconEdit}</span>
      </button><button class="post-action action-delete" data-action="delete" title="삭제">
        <span class="action-icon">${iconTrash}</span>
      </button>` : ''}
      <button class="post-action action-end" data-action="open" title="원본 열기">
        <span class="action-icon">${iconLink}</span>
      </button>
    </div>
  `;

  card.innerHTML = html;
  return card;
}

export function renderNotification(notif) {
  const card = document.createElement('div');
  const hasPost = !!notif.post?.id;
  card.className = `notif-card platform-${notif.platform}${hasPost ? ' notif-clickable' : ''}`;
  card.dataset.notifId = notif.id;
  card.dataset.platform = notif.platform;
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

  let iconHtml;
  const notifTypeClass = `notif-type-${notif.type}`;
  if (notif.reactionEmojiUrl) {
    iconHtml = `<img class="notif-custom-emoji" src="${escapeHtml(notif.reactionEmojiUrl)}" alt="${escapeHtml(notif.reactionEmoji || '')}" title="${escapeHtml(notif.reactionEmoji || '')}" referrerpolicy="no-referrer" onerror="this.style.display='none'">`;
  } else {
    const icon = getNotifIcon(notif.type, notif.reactionEmoji);
    const isEmoji = typeof icon === 'string' && !icon.startsWith('<svg');
    iconHtml = isEmoji
      ? `<span class="notif-emoji">${icon}</span>`
      : `<span class="notif-svg-icon">${icon}</span>`;
  }

  let html = '';

  // Actor avatar with notification type badge overlay
  if (notif.actor && notif.actor.avatarUrl) {
    html += `
      <div class="notif-actor-wrap">
        <img class="notif-avatar" src="${escapeHtml(notif.actor.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
        <span class="notif-type-badge ${notifTypeClass}">${iconHtml}</span>
      </div>
    `;
  } else {
    html += `<div class="notif-icon ${notifTypeClass}">${iconHtml}</div>`;
  }

  html += `
    <div class="notif-body">
      <div class="notif-text">
        ${notif.actor ? `<strong>${notif.actor.displayNameHtml || escapeHtml(notif.actor.displayName)}</strong>` : ''}
        ${escapeHtml(notif.label)}
      </div>
      <div class="notif-time">${timeAgo(notif.createdAt)}</div>
    </div>
  `;

  // Parent post context for reply notifications
  if (['reply', 'mention', 'quote'].includes(notif.type) && notif.post) {
    if (notif.post.replyTo) {
      const notifReplyAuthor = notif.post.replyTo.author;
      const parentExcerpt = stripHtml(notif.post.replyTo.content);
      const truncated = parentExcerpt.length > 120 ? parentExcerpt.substring(0, 120) + '…' : parentExcerpt;
      html += `<div class="notif-parent-context">
        <span class="notif-parent-label">↩ ${notifReplyAuthor?.displayNameHtml || escapeHtml(notifReplyAuthor?.displayName || '')}의 글에 답글</span>
        <div class="notif-parent-excerpt">${escapeHtml(truncated)}</div>
      </div>`;
    } else if (notif.post.replyToAcct) {
      html += `<div class="notif-parent-context">
        <span class="notif-parent-label">↩ @${escapeHtml(notif.post.replyToAcct)}의 글에 답글</span>
      </div>`;
    }
  }

  if (notif.post && notif.post.content) {
    const notifText = stripHtml(notif.post.content);
    const isLongNotif = notifText.length > 200;
    const notifCtxId = `notif-ctx-${notif.id}`;
    html += `<div class="notif-post-content${isLongNotif ? ' collapsed' : ''}" id="${notifCtxId}">${notif.post.content}</div>`;
    if (isLongNotif) {
      html += `<button class="expand-toggle" data-expand-target="${notifCtxId}">더보기</button>`;
    }
    if (notif.post.media && notif.post.media.length > 0) {
      html += `<div class="notif-media">`;
      for (const m of notif.post.media.slice(0, 4)) {
        if (m.type !== 'video') {
          html += `<img src="${m.previewUrl || m.url}" alt="" loading="lazy" referrerpolicy="no-referrer" data-full-url="${m.url}" data-lightbox="true" onerror="this.style.display='none'">`;
        }
      }
      html += `</div>`;
    }
    if (hasPost) {
      const isMisskey = notif.platform !== 'mastodon';
      html += `<div class="notif-actions">
        <button class="notif-action-btn" data-action="reply" title="답글">${iconReply}</button>
        <button class="notif-action-btn" data-action="boost" title="부스트/리노트">${iconBoost}</button>
        <button class="notif-action-btn" data-action="fav" title="좋아요">${iconHeart}</button>
        ${isMisskey ? `<button class="notif-action-btn" data-action="reaction" title="리액션 선택">${iconSmile}</button>` : ''}
      </div>`;
    }
  }
  card.innerHTML = html;
  return card;
}

export function renderAccountCard(account, onRemove) {
  const card = document.createElement('div');
  card.className = `account-card platform-${account.platform}`;
  card.style.borderLeftColor = usableColor(account.themeColor, account.platform);

  const p = account.profile;
  const platformLabels = {
    misskey: 'Misskey',
    iceshrimp: 'Iceshrimp',
    cherrypick: 'CherryPick',
    mastodon: 'Mastodon',
  };

  const postLabel = account.platform === 'mastodon' ? '게시물' : '노트';
  const postCount = p.statusesCount ?? p.notesCount ?? 0;

  card.innerHTML = `
    <div class="account-card-header">
      <img class="account-card-avatar" src="${p.avatarUrl || ''}" alt="${escapeHtml(p.displayName)}" loading="lazy"
           onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23555%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2240%22>?</text></svg>'">
      <div class="account-card-info">
        <div class="account-card-name">${escapeHtml(p.displayName)}</div>
        <div class="account-card-handle">@${escapeHtml(p.acct)} · ${new URL(account.instanceUrl).hostname}</div>
      </div>
      <span class="account-card-platform platform-badge ${account.platform}">${platformLabels[account.platform]}</span>
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

export function renderLoading() {
  const div = document.createElement('div');
  div.className = 'loading-spinner';
  div.innerHTML = '<div class="spinner"></div>';
  return div;
}

export function renderLoadingText(message = '불러오는 중...') {
  const div = document.createElement('div');
  div.className = 'loading-text';
  div.textContent = message;
  return div;
}

// Export icons for use in main.js column headers
export { iconRefresh, iconClose, iconImage };

// Helpers

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function stripHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent || '';
}

function timeAgo(date) {
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
    const url = (reactionEmojis && (reactionEmojis[name] || reactionEmojis[name + '@.']))
             || (emojis && (emojis[name] || emojis[name + '@.']))
             || null;
    if (url) {
      return `<img class="custom-emoji" src="${escapeHtml(url)}" alt="${escapeHtml(reaction)}" title="${escapeHtml(reaction)}" referrerpolicy="no-referrer">`;
    }
    // Fallback: try instance emoji URL for local emojis
    const baseName = name.replace(/@\.$/, ''); // strip @. suffix
    if (instanceUrl && !baseName.includes('@')) {
      return `<img class="custom-emoji" src="${escapeHtml(instanceUrl)}/emoji/${encodeURIComponent(baseName)}.webp" alt="${escapeHtml(reaction)}" title="${escapeHtml(reaction)}" referrerpolicy="no-referrer" onerror="this.replaceWith(this.alt)">`;
    }
  }
  // Replace common unicode reactions with themed SVG icons
  const iconFn = REACTION_ICON_MAP[reaction];
  if (iconFn) return iconFn();
  return reaction;
}
