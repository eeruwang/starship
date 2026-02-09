/**
 * Dashboard UI
 * Renders timeline posts, notifications, and account cards.
 */
import {
  iconReply, iconBoost, iconStar, iconHeart, iconLink,
  iconRefresh, iconClose, iconWarning, iconImage,
  iconQuote, iconSmile, iconTrash, iconEdit,
  iconHeartSmall, iconStarSmall,
  getNotifIcon,
} from './icons.js';

const PLATFORM_COLORS = {
  misskey: '#96d04a',
  iceshrimp: '#e36a8a',
  cherrypick: '#ff6b9d',
  mastodon: '#6364ff',
};

export function renderPost(post) {
  const card = document.createElement('div');
  card.className = `post-card platform-${post.platform}`;
  card.dataset.postId = post.id;
  card.dataset.platform = post.platform;
  if (post.accountId) card.dataset.accountId = post.accountId;
  const displayPostForUri = post.reblog || post;
  if (displayPostForUri.canonicalUri) card.dataset.canonicalUri = displayPostForUri.canonicalUri;

  // Per-account theme color for single-account posts
  if (post.themeColor && (!post.mergedAccounts || post.mergedAccounts.length <= 1)) {
    card.style.borderLeftColor = post.themeColor;
  }

  // Merged account border (uses background trick to follow border-radius)
  if (post.mergedAccounts && post.mergedAccounts.length > 1) {
    const colors = post.mergedAccounts.map(a => a.themeColor || PLATFORM_COLORS[a.platform] || '#7c7dff');
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
    const parentCw = displayPost.replyTo.contentWarning;
    const parentText = stripHtml(displayPost.replyTo.content);
    const isLong = !parentCw && parentText.length > 200;
    const replyCtxId = `reply-ctx-${post.id}`;
    html += `
      <div class="reply-context">
        <div class="reply-context-header">
          <img class="reply-context-avatar" src="${displayPost.replyTo.author.avatarUrl || ''}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
          <span class="reply-context-author">${displayPost.replyTo.author.displayNameHtml || escapeHtml(displayPost.replyTo.author.displayName)}</span>
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
      <span class="post-time" title="${displayPost.createdAt.toLocaleString()}">${timeAgo(displayPost.createdAt)}</span>
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

  // Media
  if (displayPost.media && displayPost.media.length > 0) {
    const count = Math.min(displayPost.media.length, 4);
    html += `<div class="post-media media-${count}">`;
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
    html += `
      <a class="link-card" href="${escapeHtml(lc.url)}" target="_blank" rel="noopener">
        ${hasImage ? `<img class="link-card-image" src="${escapeHtml(lc.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
        <div class="link-card-info">
          <div class="link-card-site">${escapeHtml(lc.siteName || '')}</div>
          ${hasTitle ? `<div class="link-card-title">${escapeHtml(lc.title)}</div>` : ''}
          ${lc.description ? `<div class="link-card-desc">${escapeHtml(lc.description)}</div>` : ''}
          ${!hasTitle ? `<div class="link-card-url">${escapeHtml(lc.url)}</div>` : ''}
        </div>
      </a>
    `;
  }

  // Reactions (Misskey)
  if (displayPost.reactions && Object.keys(displayPost.reactions).length > 0) {
    html += '<div class="post-reactions">';
    for (const [reaction, count] of Object.entries(displayPost.reactions)) {
      const emojiHtml = resolveReactionHtml(reaction, displayPost.reactionEmojis, displayPost.emojis, displayPost.instanceUrl);
      html += `<span class="reaction-badge" data-reaction="${escapeHtml(reaction)}" title="클릭하여 리액션한 사용자 보기">${emojiHtml} <span class="reaction-count">${count}</span></span>`;
    }
    html += '</div>';
  }

  if (displayPost.contentWarning) {
    html += '</div>'; // close cw-content
  }

  // Actions
  const replyCount = displayPost.stats?.replies || 0;
  const boostCount = displayPost.stats?.reblogs || displayPost.stats?.renotes || 0;
  const favCount = displayPost.stats?.favourites || displayPost.stats?.reactions || 0;

  const favIcon = post.platform === 'mastodon' ? iconStar : iconHeart;

  const isMisskey = post.platform !== 'mastodon';

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
      <button class="post-action${(post.favourited || post.myReaction) ? ' active' : ''}" data-action="fav" title="${isMisskey ? '좋아요' : '즐겨찾기'}">
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
  const replyTypes = ['reply', 'mention', 'quote'];
  const isReplyable = replyTypes.includes(notif.type) && notif.post?.id;
  card.className = `notif-card platform-${notif.platform}${isReplyable ? ' notif-clickable' : ''}`;
  card.dataset.notifId = notif.id;
  card.dataset.platform = notif.platform;
  if (notif.accountId) card.dataset.accountId = notif.accountId;
  if (notif.post?.id) card.dataset.postId = notif.post.id;
  if (notif.themeColor) card.style.borderLeftColor = notif.themeColor;

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
      const parentExcerpt = stripHtml(notif.post.replyTo.content);
      const truncated = parentExcerpt.length > 120 ? parentExcerpt.substring(0, 120) + '…' : parentExcerpt;
      html += `<div class="notif-parent-context">
        <span class="notif-parent-label">↩ ${notif.post.replyTo.author.displayNameHtml || escapeHtml(notif.post.replyTo.author.displayName)}의 글에 답글</span>
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
    if (isReplyable) {
      html += `<div class="notif-reply-hint">${iconReply} 클릭하여 답글</div>`;
    }
  }
  card.innerHTML = html;
  return card;
}

export function renderAccountCard(account, onRemove) {
  const card = document.createElement('div');
  card.className = `account-card platform-${account.platform}`;
  if (account.themeColor) card.style.borderLeftColor = account.themeColor;

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
      <span class="account-card-platform ${account.platform}">${platformLabels[account.platform]}</span>
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
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || '';
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
