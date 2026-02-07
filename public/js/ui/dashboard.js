/**
 * Dashboard UI
 * Renders timeline posts, notifications, and account cards.
 */
import {
  iconReply, iconBoost, iconStar, iconHeart, iconLink,
  iconRefresh, iconClose, iconWarning, iconImage,
  getNotifIcon,
} from './icons.js';

export function renderPost(post) {
  const card = document.createElement('div');
  card.className = `post-card platform-${post.platform}`;
  card.dataset.postId = post.id;
  card.dataset.platform = post.platform;
  if (post.accountId) card.dataset.accountId = post.accountId;

  let html = '';

  // Renote / Boost indicator
  if (post.rebloggedBy) {
    const boostLabel = post.platform === 'mastodon' ? '부스트' : '리노트';
    html += `<div class="renote-indicator"><span class="icon-inline boost-icon">${iconBoost}</span> ${escapeHtml(post.rebloggedBy.displayName)}님이 ${boostLabel}함</div>`;
  }

  const displayPost = post.reblog || post;

  // Reply context
  if (displayPost.replyTo) {
    const parentContent = stripHtml(displayPost.replyTo.content);
    const excerpt = parentContent.slice(0, 80) + (parentContent.length > 80 ? '...' : '');
    html += `
      <div class="reply-context">
        <div class="reply-context-header">
          <img class="reply-context-avatar" src="${displayPost.replyTo.author.avatarUrl || ''}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
          <span class="reply-context-author">${escapeHtml(displayPost.replyTo.author.displayName)}</span>
        </div>
        <div class="reply-context-content">${escapeHtml(excerpt)}</div>
      </div>
    `;
  } else if (displayPost.replyToAcct) {
    html += `<div class="reply-indicator">↩ @${escapeHtml(displayPost.replyToAcct)} 에게 답글</div>`;
  } else if (displayPost.replyToId) {
    html += `<div class="reply-indicator">↩ 답글</div>`;
  }

  // CW
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

  // Header
  html += `
    <div class="post-header">
      <img class="post-avatar" src="${displayPost.author.avatarUrl || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23555%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2240%22>?</text></svg>'}"
           alt="${escapeHtml(displayPost.author.displayName)}"
           loading="lazy"
           referrerpolicy="no-referrer"
           onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23555%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2240%22>?</text></svg>'">
      <div class="post-meta">
        <div class="post-author">${escapeHtml(displayPost.author.displayName)}</div>
        <div class="post-handle">@${escapeHtml(displayPost.author.acct)}</div>
      </div>
      <span class="post-time" title="${displayPost.createdAt.toLocaleString()}">${timeAgo(displayPost.createdAt)}</span>
    </div>
  `;

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

  // Reactions (Misskey)
  if (displayPost.reactions && Object.keys(displayPost.reactions).length > 0) {
    html += '<div class="post-reactions">';
    for (const [reaction, count] of Object.entries(displayPost.reactions)) {
      const emojiHtml = resolveReactionHtml(reaction, displayPost.reactionEmojis);
      html += `<span class="reaction-badge">${emojiHtml} <span class="reaction-count">${count}</span></span>`;
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

  html += `
    <div class="post-actions">
      <button class="post-action" data-action="reply" title="답글">
        <span class="action-icon">${iconReply}</span>
        ${replyCount > 0 ? `<span class="action-count">${replyCount}</span>` : ''}
      </button>
      <button class="post-action" data-action="boost" title="${post.platform === 'mastodon' ? '부스트' : '리노트'}">
        <span class="action-icon">${iconBoost}</span>
        ${boostCount > 0 ? `<span class="action-count">${boostCount}</span>` : ''}
      </button>
      <button class="post-action" data-action="fav" title="${post.platform === 'mastodon' ? '즐겨찾기' : '리액션'}">
        <span class="action-icon">${favIcon}</span>
        ${favCount > 0 ? `<span class="action-count">${favCount}</span>` : ''}
      </button>
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
  card.className = `notif-card platform-${notif.platform}`;
  card.dataset.notifId = notif.id;
  card.dataset.platform = notif.platform;

  let iconHtml;
  if (notif.reactionEmojiUrl) {
    iconHtml = `<img class="notif-custom-emoji" src="${escapeHtml(notif.reactionEmojiUrl)}" alt="${escapeHtml(notif.reactionEmoji || '')}" title="${escapeHtml(notif.reactionEmoji || '')}">`;
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
        <span class="notif-type-badge">${iconHtml}</span>
      </div>
    `;
  } else {
    html += `<div class="notif-icon">${iconHtml}</div>`;
  }

  html += `
    <div class="notif-body">
      <div class="notif-text">
        ${notif.actor ? `<strong>${escapeHtml(notif.actor.displayName)}</strong>` : ''}
        ${escapeHtml(notif.label)}
      </div>
      <div class="notif-time">${timeAgo(notif.createdAt)}</div>
  `;

  if (notif.post) {
    const excerpt = stripHtml(notif.post.content).slice(0, 100);
    if (excerpt) {
      html += `<div class="notif-excerpt">${escapeHtml(excerpt)}</div>`;
    }
  }

  html += '</div>';
  card.innerHTML = html;
  return card;
}

export function renderAccountCard(account, onRemove) {
  const card = document.createElement('div');
  card.className = `account-card platform-${account.platform}`;

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

function resolveReactionHtml(reaction, reactionEmojis) {
  // Check if it's a custom emoji (:name: or :name@.:)
  const match = reaction.match(/^:(.+):$/);
  if (match && reactionEmojis) {
    const name = match[1];
    const url = reactionEmojis[name] || reactionEmojis[name + '@.'] || null;
    if (url) {
      return `<img class="custom-emoji" src="${escapeHtml(url)}" alt="${escapeHtml(reaction)}" title="${escapeHtml(reaction)}">`;
    }
  }
  return reaction;
}
