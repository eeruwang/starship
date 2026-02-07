/**
 * Dashboard UI
 * Renders timeline posts, notifications, and account cards.
 */

// ===== SVG Notification Icons =====
const NOTIF_ICONS = {
  reaction: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff6b9d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  reply: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6cb4ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  renote: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#96d04a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  reblog: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#96d04a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  follow: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7c7dff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
  follow_request: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffb340" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
  receiveFollowRequest: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffb340" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
  followRequestAccepted: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#96d04a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/></svg>',
  mention: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e36a8a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>',
  quote: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e36a8a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h2v4H8z"/><path d="M13 9h2v4h-2z"/></svg>',
  favourite: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffb340" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  poll: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6cb4ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 12h2v5H7z"/><path d="M11 8h2v9h-2z"/><path d="M15 10h2v7h-2z"/></svg>',
  pollEnded: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6cb4ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 12h2v5H7z"/><path d="M11 8h2v9h-2z"/><path d="M15 10h2v7h-2z"/></svg>',
  status: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#96d04a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  note: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#96d04a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  update: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9a9ab8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  achievementEarned: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffb340" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>',
  app: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9a9ab8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>',
  default: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9a9ab8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
};

// ===== Post Action SVG Icons =====
const iconReply = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const iconBoost = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
const iconFav = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const iconOpen = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

const FALLBACK_AVATAR = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23555%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2240%22>?</text></svg>';

export function renderPost(post, animate = false) {
  const card = document.createElement('div');
  card.className = `post-card platform-${post.platform}`;
  if (animate) card.classList.add('post-new');
  card.dataset.postId = post.id;
  card.dataset.platform = post.platform;
  card.dataset.postUri = post.uri || post.url || '';

  // Multi-account left border: gradient of platform colors
  if (post._seenBy && post._seenBy.length > 1) {
    card.classList.add('multi-account');
    const platformColors = {
      misskey: '#96d04a',
      iceshrimp: '#e36a8a',
      cherrypick: '#ff6b9d',
      mastodon: '#6364ff',
    };
    const colors = post._seenBy.map(a => platformColors[a.platform] || '#7c7dff');
    const segments = colors.map((c, i) => {
      const start = (i / colors.length) * 100;
      const end = ((i + 1) / colors.length) * 100;
      return `${c} ${start}%, ${c} ${end}%`;
    }).join(', ');
    card.style.borderImage = `linear-gradient(to bottom, ${segments}) 1`;
    card.style.borderLeftWidth = '4px';
  }

  let html = '';

  // Multi-account seen-by indicator with overlapping avatars
  if (post._seenBy && post._seenBy.length > 1) {
    html += `<div class="seen-by-indicator">`;
    html += `<div class="seen-by-avatars">`;
    for (const acct of post._seenBy) {
      html += `<img class="seen-by-avatar ${acct.platform}" src="${acct.avatarUrl || ''}" alt="${escapeHtml(acct.label)}" title="${escapeHtml(acct.label)}" loading="lazy" onerror="this.style.display='none'">`;
    }
    html += `</div>`;
    html += `<span class="seen-by-text">${post._seenBy.length}개 계정에서 수신</span>`;
    html += `</div>`;
  }

  // Renote / Boost indicator
  if (post.rebloggedBy) {
    const boostLabel = post.platform === 'mastodon' ? '부스트' : '리노트';
    const boostIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
    html += `<div class="renote-indicator">${boostIcon} ${post.rebloggedBy.displayNameHtml || escapeHtml(post.rebloggedBy.displayName)}님이 ${boostLabel}함</div>`;
  }

  const displayPost = post.reblog || post;

  // Parent post (reply context)
  if (post.replyTo && !post.replyTo.partial) {
    html += `<div class="reply-context">`;
    html += `<div class="reply-context-header">`;
    html += `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`;
    html += `<img class="reply-context-avatar" src="${post.replyTo.author?.avatarUrl || FALLBACK_AVATAR}" loading="lazy" onerror="this.src='${FALLBACK_AVATAR}'">`;
    html += `<span class="reply-context-name">${post.replyTo.author?.displayNameHtml || escapeHtml(post.replyTo.author?.displayName || '?')}</span>`;
    html += `</div>`;
    html += `<div class="reply-context-content">${post.replyTo.content}</div>`;
    html += `</div>`;
  } else if (post.replyTo && post.replyTo.partial) {
    html += `<div class="reply-context reply-context-partial">`;
    html += `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`;
    html += `<span class="reply-context-label">답글</span>`;
    html += `</div>`;
  }

  // CW
  if (displayPost.contentWarning) {
    const cwId = `cw-${post.id}`;
    html += `
      <div class="cw-warning">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        ${escapeHtml(displayPost.contentWarning)}
        <button class="cw-toggle" data-cw-target="${cwId}">내용 보기</button>
      </div>
    `;
    html += `<div class="cw-content" id="${cwId}">`;
  }

  // Header
  html += `
    <div class="post-header">
      <img class="post-avatar" src="${displayPost.author.avatarUrl || FALLBACK_AVATAR}"
           alt="${escapeHtml(displayPost.author.displayName)}"
           loading="lazy"
           onerror="this.src='${FALLBACK_AVATAR}'">
      <div class="post-meta">
        <div class="post-author">${displayPost.author.displayNameHtml || escapeHtml(displayPost.author.displayName)}</div>
        <div class="post-handle">@${escapeHtml(displayPost.author.acct)}</div>
      </div>
      <span class="post-time" title="${displayPost.createdAt.toLocaleString()}">${timeAgo(displayPost.createdAt)}</span>
    </div>
  `;

  // Content
  html += `<div class="post-content">${displayPost.content}</div>`;

  // Media - with lightbox trigger
  if (displayPost.media && displayPost.media.length > 0) {
    const mediaCount = Math.min(displayPost.media.length, 4);
    html += `<div class="post-media media-${mediaCount}">`;
    for (const m of displayPost.media) {
      if (m.type === 'video') {
        html += `<video controls preload="none" poster="${m.previewUrl || ''}"><source src="${m.url}"></video>`;
      } else {
        html += `<img src="${m.previewUrl || m.url}" alt="${escapeHtml(m.description || '')}" loading="lazy" data-lightbox-src="${m.url}" class="lightbox-trigger">`;
      }
    }
    html += '</div>';
  }

  // Reactions (Misskey)
  if (displayPost.reactions && Object.keys(displayPost.reactions).length > 0) {
    const emojiMap = displayPost.reactionEmojis || {};
    const instanceUrl = displayPost.instanceUrl || '';
    html += '<div class="post-reactions">';
    for (const [reaction, count] of Object.entries(displayPost.reactions)) {
      const customMatch = reaction.match(/^:(.+):$/);
      let emojiHtml;
      if (customMatch) {
        const emojiName = customMatch[1];
        const emojiUrl = emojiMap[emojiName];
        if (emojiUrl) {
          emojiHtml = `<img class="reaction-emoji" src="${emojiUrl}" alt=":${escapeHtml(emojiName)}:" title=":${escapeHtml(emojiName)}:" loading="lazy">`;
        } else if (instanceUrl && !emojiName.includes('@')) {
          const fallbackUrl = `${instanceUrl}/emoji/${encodeURIComponent(emojiName)}.webp`;
          emojiHtml = `<img class="reaction-emoji" src="${fallbackUrl}" alt=":${escapeHtml(emojiName)}:" title=":${escapeHtml(emojiName)}:" loading="lazy" onerror="this.parentNode.replaceChild(document.createTextNode(':${escapeHtml(emojiName)}:'),this)">`;
        } else if (instanceUrl && emojiName.includes('@')) {
          const [name, host] = emojiName.split('@');
          const fallbackUrl = `https://${host}/emoji/${encodeURIComponent(name)}.webp`;
          emojiHtml = `<img class="reaction-emoji" src="${fallbackUrl}" alt=":${escapeHtml(emojiName)}:" title=":${escapeHtml(emojiName)}:" loading="lazy" onerror="this.parentNode.replaceChild(document.createTextNode(':${escapeHtml(emojiName)}:'),this)">`;
        } else {
          emojiHtml = escapeHtml(reaction);
        }
      } else {
        emojiHtml = reaction;
      }
      html += `<span class="reaction-badge">${emojiHtml} ${count}</span>`;
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

  html += `
    <div class="post-actions">
      <button class="post-action" data-action="reply" title="답글">${iconReply}${replyCount > 0 ? `<span>${replyCount}</span>` : ''}</button>
      <button class="post-action" data-action="boost" title="${post.platform === 'mastodon' ? '부스트' : '리노트'}">${iconBoost}${boostCount > 0 ? `<span>${boostCount}</span>` : ''}</button>
      <button class="post-action" data-action="fav" title="${post.platform === 'mastodon' ? '즐겨찾기' : '리액션'}">${iconFav}${favCount > 0 ? `<span>${favCount}</span>` : ''}</button>
      <button class="post-action" data-action="open" title="원본 열기">${iconOpen}</button>
    </div>
  `;

  card.innerHTML = html;
  return card;
}

export function renderNotification(notif, animate = false) {
  const card = document.createElement('div');
  card.className = `notif-card platform-${notif.platform}`;
  if (animate) card.classList.add('notif-new');

  // Get SVG icon for this notification type
  const iconSvg = NOTIF_ICONS[notif.type] || NOTIF_ICONS.default;

  // Reaction display
  let reactionHtml = '';
  if (notif.reaction) {
    if (notif.reaction.type === 'image') {
      reactionHtml = `<img class="notif-reaction-emoji" src="${notif.reaction.url}" alt="${escapeHtml(notif.reaction.alt)}" loading="lazy" onerror="this.style.display='none'">`;
    } else if (notif.reaction.type === 'text') {
      reactionHtml = `<span class="notif-reaction-text">${notif.reaction.value}</span>`;
    }
  }

  let html = `
    <div class="notif-icon">${iconSvg}</div>
    ${notif.actor ? `<img class="notif-avatar" src="${notif.actor.avatarUrl || FALLBACK_AVATAR}" alt="" loading="lazy" onerror="this.src='${FALLBACK_AVATAR}'">` : ''}
    <div class="notif-body">
      <div class="notif-text">
        ${notif.actor ? `<strong>${notif.actor.displayNameHtml || escapeHtml(notif.actor.displayName)}</strong>` : ''}
        ${escapeHtml(notif.label)}
        ${reactionHtml}
      </div>
      <div class="notif-time">${timeAgo(notif.createdAt)}</div>
  `;

  if (notif.post) {
    html += `<div class="notif-excerpt">${notif.post.content}</div>`;
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
           onerror="this.src='${FALLBACK_AVATAR}'">
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

// ===== Column Creation =====

export function createColumn(id, title, options = {}) {
  const section = document.createElement('section');
  section.className = 'column';
  section.id = id;
  section.dataset.columnId = id;

  const closable = options.closable !== false; // default true
  const refreshable = options.refreshable !== false; // default true

  let headerHtml = `<div class="column-header">
    <h2>${escapeHtml(title)}</h2>
    <div class="column-header-actions">`;

  if (refreshable) {
    headerHtml += `<button class="btn btn-icon btn-small" data-action="refresh-column" title="새로고침">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
    </button>`;
  }

  if (closable) {
    headerHtml += `<button class="btn btn-icon btn-small column-close" data-action="close-column" title="닫기">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  }

  headerHtml += `</div></div>`;

  section.innerHTML = headerHtml + `<div class="column-content"></div>`;

  return section;
}

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
