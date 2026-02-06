/**
 * Dashboard UI
 * Renders timeline posts, notifications, and account cards.
 */

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
    html += `<div class="renote-indicator">🔁 ${escapeHtml(post.rebloggedBy.displayName)}님이 ${boostLabel}함</div>`;
  }

  const displayPost = post.reblog || post;

  // CW
  if (displayPost.contentWarning) {
    const cwId = `cw-${post.id}`;
    html += `
      <div class="cw-warning">
        ⚠️ ${escapeHtml(displayPost.contentWarning)}
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
    html += '<div class="post-media">';
    for (const m of displayPost.media) {
      if (m.type === 'video') {
        html += `<video controls preload="none" poster="${m.previewUrl || ''}"><source src="${m.url}"></video>`;
      } else {
        html += `<img src="${m.previewUrl || m.url}" alt="${escapeHtml(m.description || '')}" loading="lazy">`;
      }
    }
    html += '</div>';
  }

  // Reactions (Misskey)
  if (displayPost.reactions && Object.keys(displayPost.reactions).length > 0) {
    html += '<div class="post-reactions">';
    for (const [reaction, count] of Object.entries(displayPost.reactions)) {
      html += `<span class="reaction-badge">${reaction} ${count}</span>`;
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
      <button class="post-action reply" data-action="reply" title="댓글" aria-label="댓글">${actionIcon('reply')}${replyCount > 0 ? `<span class="post-action-count">${replyCount}</span>` : ''}</button>
      <button class="post-action boost" data-action="boost" title="${post.platform === 'mastodon' ? '리포스트' : '리노트'}" aria-label="${post.platform === 'mastodon' ? '리포스트' : '리노트'}">${actionIcon('boost')}${boostCount > 0 ? `<span class="post-action-count">${boostCount}</span>` : ''}</button>
      <button class="post-action fav" data-action="fav" title="좋아요" aria-label="좋아요">${actionIcon('star')}${favCount > 0 ? `<span class="post-action-count">${favCount}</span>` : ''}</button>
      <button class="post-action open" data-action="open" title="원문 열기" aria-label="원문 열기">${actionIcon('more')}</button>
    </div>
  `;

  card.innerHTML = html;
  card.dataset.targetPostId = displayPost.id || post.id;
  card.dataset.postUrl = displayPost.url || post.url || '';
  return card;
}

export function renderNotification(notif) {
  const card = document.createElement('div');
  card.className = `notif-card platform-${notif.platform}`;

  let html = `
    <div class="notif-icon">${renderNotifIcon(notif)}</div>
    <div class="notif-body">
      <div class="notif-text">
        ${notif.actor ? `<strong>${renderTextWithEmojis(notif.actor.displayName, notif.emojiMap)}</strong>` : ''}
        ${renderTextWithEmojis(notif.label, notif.emojiMap)}
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

// Helpers


function actionIcon(type) {
  const icons = {
    reply: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 9L4 12.5L9 16"/><path d="M5.2 12.5H13.6C16.7 12.5 19.2 14.9 19.2 18"/></svg>',
    boost: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7H18"/><path d="M15 4L18 7L15 10"/><path d="M17 17H6"/><path d="M9 14L6 17L9 20"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.8L14.6 9.1L20.5 9.9L16.2 14L17.2 20L12 17.2L6.8 20L7.8 14L3.5 9.9L9.4 9.1Z"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6" cy="12" r="1.35" fill="currentColor"/><circle cx="12" cy="12" r="1.35" fill="currentColor"/><circle cx="18" cy="12" r="1.35" fill="currentColor"/></svg>',
  };
  return icons[type] || '';
}



function renderTextWithEmojis(text, emojiMap = {}) {
  const safe = escapeHtml(text || '');
  if (!safe) return '';
  return safe.replace(/:([a-zA-Z0-9_.+-]+(?:@[a-zA-Z0-9.-]+)?):/g, (match, name) => {
    const baseName = name.split('@')[0];
    const url = emojiMap?.[name] || emojiMap?.[`:${name}:`] || emojiMap?.[baseName] || emojiMap?.[`:${baseName}:`];
    if (!url) return match;
    return `<img class="inline-emoji" src="${escapeHtml(url)}" alt=":${escapeHtml(name)}:" loading="lazy">`;
  });
}

function renderNotifIcon(notif) {
  if (notif.reactionEmojiUrl) {
    return `<img class="inline-emoji notif-inline-emoji" src="${escapeHtml(notif.reactionEmojiUrl)}" alt="${escapeHtml(notif.icon || 'reaction')}" loading="lazy">`;
  }
  return escapeHtml(notif.icon || '🔔');
}


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
