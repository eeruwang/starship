/**
 * Dashboard UI
 * Renders timeline posts, notifications, and account cards.
 */

export function renderPost(post) {
  const card = document.createElement('div');
  card.className = `post-card platform-${post.platform}`;
  card.dataset.postId = post.id;
  card.dataset.platform = post.platform;

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
        <div class="post-author">${displayPost.author.displayNameHtml || escapeHtml(displayPost.author.displayName)}</div>
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
    const emojiMap = displayPost.reactionEmojis || {};
    const instanceUrl = displayPost.instanceUrl || '';
    html += '<div class="post-reactions">';
    for (const [reaction, count] of Object.entries(displayPost.reactions)) {
      // Check if custom emoji (e.g. :blobcat_basket@serafuku.moe: or :dogroll:)
      const customMatch = reaction.match(/^:(.+):$/);
      let emojiHtml;
      if (customMatch) {
        const emojiName = customMatch[1];
        const emojiUrl = emojiMap[emojiName];
        if (emojiUrl) {
          emojiHtml = `<img class="reaction-emoji" src="${emojiUrl}" alt=":${escapeHtml(emojiName)}:" title=":${escapeHtml(emojiName)}:" loading="lazy">`;
        } else if (instanceUrl && !emojiName.includes('@')) {
          // Local emoji fallback: try instance emoji endpoint
          const fallbackUrl = `${instanceUrl}/emoji/${encodeURIComponent(emojiName)}.webp`;
          emojiHtml = `<img class="reaction-emoji" src="${fallbackUrl}" alt=":${escapeHtml(emojiName)}:" title=":${escapeHtml(emojiName)}:" loading="lazy" onerror="this.replaceWith(document.createTextNode(':${escapeHtml(emojiName)}:'))">`;
        } else if (instanceUrl && emojiName.includes('@')) {
          // Remote emoji: try the remote instance
          const [name, host] = emojiName.split('@');
          const fallbackUrl = `https://${host}/emoji/${encodeURIComponent(name)}.webp`;
          emojiHtml = `<img class="reaction-emoji" src="${fallbackUrl}" alt=":${escapeHtml(emojiName)}:" title=":${escapeHtml(emojiName)}:" loading="lazy" onerror="this.replaceWith(document.createTextNode(':${escapeHtml(emojiName)}:'))">`;
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

  const iconReply = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  const iconBoost = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
  const iconFav = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  const iconOpen = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

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

export function renderNotification(notif) {
  const card = document.createElement('div');
  card.className = `notif-card platform-${notif.platform}`;

  const fallbackAvatar = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23555%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2240%22>?</text></svg>';

  let html = `
    <div class="notif-icon">${notif.icon}</div>
    ${notif.actor ? `<img class="notif-avatar" src="${notif.actor.avatarUrl || fallbackAvatar}" alt="" loading="lazy" onerror="this.src='${fallbackAvatar}'">` : ''}
    <div class="notif-body">
      <div class="notif-text">
        ${notif.actor ? `<strong>${notif.actor.displayNameHtml || escapeHtml(notif.actor.displayName)}</strong>` : ''}
        ${escapeHtml(notif.label)}
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
