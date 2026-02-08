/**
 * Misskey API Client
 * Works with Misskey (Original), Iceshrimp, and CherryPick.
 * All use the same base API (Misskey API) with minor variations.
 * Worker 배포 시 /proxy 를 통해 CORS를 우회합니다.
 */
export class MisskeyClient {
  constructor(instanceUrl, accessToken, platformType = 'misskey') {
    this.instanceUrl = instanceUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.platformType = platformType; // 'misskey' | 'iceshrimp' | 'cherrypick'
    // localhost가 아니면 Worker 프록시 사용 (Cloudflare 배포 환경)
    this.useProxy = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
  }

  async request(endpoint, body = {}) {
    const targetUrl = `${this.instanceUrl}/api/${endpoint}`;

    const fetchUrl = this.useProxy
      ? `/proxy?url=${encodeURIComponent(targetUrl)}`
      : targetUrl;

    const res = await fetch(fetchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, i: this.accessToken }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Misskey API error ${res.status}: ${errText}`);
    }

    return res.json();
  }

  async verifyCredentials() {
    return this.request('i');
  }

  async getHomeTimeline(limit = 30, untilId = null) {
    const body = { limit };
    if (untilId) body.untilId = untilId;
    return this.request('notes/timeline', body);
  }

  async getNotifications(limit = 30, untilId = null) {
    const body = { limit };
    if (untilId) body.untilId = untilId;
    return this.request('i/notifications', body);
  }

  async getNote(noteId) {
    return this.request('notes/show', { noteId });
  }

  async getNoteChildren(noteId, limit = 30) {
    return this.request('notes/children', { noteId, limit });
  }

  async createReaction(noteId, reaction = '❤') {
    return this.request('notes/reactions/create', { noteId, reaction });
  }

  async getReactions(noteId, type = null) {
    const body = { noteId, limit: 20 };
    if (type) body.type = type;
    return this.request('notes/reactions', body);
  }

  async renote(noteId) {
    return this.request('notes/create', { renoteId: noteId });
  }

  async createNote(text, options = {}) {
    const body = { text };
    if (options.cw) body.cw = options.cw;
    if (options.fileIds && options.fileIds.length > 0) body.fileIds = options.fileIds;
    if (options.replyId) body.replyId = options.replyId;
    return this.request('notes/create', body);
  }

  async uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('i', this.accessToken);

    const targetUrl = `${this.instanceUrl}/api/drive/files/create`;
    const fetchUrl = this.useProxy
      ? `/proxy?url=${encodeURIComponent(targetUrl)}`
      : targetUrl;

    const res = await fetch(fetchUrl, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`File upload error ${res.status}: ${errText}`);
    }
    return res.json();
  }

  normalizeUser(user) {
    return {
      id: user.id,
      displayName: user.name || user.username,
      username: user.username,
      acct: user.host ? `${user.username}@${user.host}` : user.username,
      avatarUrl: user.avatarUrl,
    };
  }

  normalizePost(note) {
    const author = this.normalizeUser(note.user);
    const isRenote = note.renote && !note.text && !note.cw && (!note.files || note.files.length === 0);

    const actualNote = isRenote ? note.renote : note;
    const actualAuthor = isRenote ? this.normalizeUser(note.renote.user) : author;

    const emojiMap = this.buildEmojiMap(actualNote);

    return {
      id: note.id,
      platform: this.platformType,
      createdAt: new Date(note.createdAt),
      content: this.mfmToHtml(actualNote.text || '', emojiMap),
      contentWarning: actualNote.cw || null,
      author: actualAuthor,
      media: (actualNote.files || []).map(f => ({
        type: f.type?.startsWith('video') ? 'video' : 'image',
        url: f.url,
        previewUrl: f.thumbnailUrl || f.url,
        description: f.comment || f.name,
      })),
      stats: {
        replies: actualNote.repliesCount || 0,
        renotes: actualNote.renoteCount || 0,
        reactions: Object.values(actualNote.reactions || {}).reduce((a, b) => a + b, 0),
      },
      reblog: isRenote ? this.normalizePost(note.renote) : null,
      rebloggedBy: isRenote ? {
        displayName: author.displayName,
        username: author.username,
      } : null,
      reactions: actualNote.reactions || {},
      reactionEmojis: actualNote.reactionEmojis || {},
      emojis: emojiMap,
      canonicalUri: actualNote.uri || `${this.instanceUrl}/notes/${actualNote.id}`,
      replyTo: actualNote.reply ? {
        id: actualNote.reply.id,
        content: this.mfmToHtml(actualNote.reply.text || '', this.buildEmojiMap(actualNote.reply)),
        author: this.normalizeUser(actualNote.reply.user),
      } : null,
      replyToId: actualNote.replyId || null,
      instanceUrl: this.instanceUrl,
      url: `${this.instanceUrl}/notes/${note.id}`,
      raw: note,
    };
  }

  buildEmojiMap(note) {
    const map = {};
    if (note.emojis && typeof note.emojis === 'object' && !Array.isArray(note.emojis)) {
      Object.assign(map, note.emojis);
    }
    if (Array.isArray(note.emojis)) {
      for (const e of note.emojis) {
        if (e.name && e.url) map[e.name] = e.url;
      }
    }
    if (note.reactionEmojis) {
      Object.assign(map, note.reactionEmojis);
    }
    return map;
  }

  normalizeNotification(notif) {
    const typeMap = {
      'reaction': { icon: '💖', label: '리액션' },
      'reply': { icon: '💬', label: '답글' },
      'renote': { icon: '🔁', label: '리노트' },
      'quote': { icon: '💬', label: '인용' },
      'mention': { icon: '📢', label: '멘션' },
      'follow': { icon: '👤', label: '팔로우' },
      'followRequestAccepted': { icon: '✅', label: '팔로우 수락' },
      'receiveFollowRequest': { icon: '🔔', label: '팔로우 요청' },
      'pollEnded': { icon: '📊', label: '투표 종료' },
      'achievementEarned': { icon: '🏆', label: '업적 획득' },
      'app': { icon: '📱', label: '앱 알림' },
      'note': { icon: '📝', label: '새 노트' },
    };

    const info = typeMap[notif.type] || { icon: '🔔', label: notif.type };

    // Resolve custom emoji URL for reaction notifications
    let reactionEmojiUrl = null;
    if (notif.type === 'reaction' && notif.reaction) {
      const stripped = notif.reaction.replace(/^:/, '').replace(/:$/, '');
      if (stripped !== notif.reaction) {
        // Try reactionEmojis first
        if (notif.note?.reactionEmojis) {
          reactionEmojiUrl = notif.note.reactionEmojis[stripped]
            || notif.note.reactionEmojis[stripped + '@.']
            || null;
        }
        // Try note.emojis
        if (!reactionEmojiUrl && notif.note?.emojis) {
          const emojis = notif.note.emojis;
          if (typeof emojis === 'object' && !Array.isArray(emojis)) {
            reactionEmojiUrl = emojis[stripped] || emojis[stripped + '@.'] || null;
          } else if (Array.isArray(emojis)) {
            const found = emojis.find(e => e.name === stripped || e.name === stripped + '@.');
            if (found) reactionEmojiUrl = found.url;
          }
        }
        // Fallback: instance emoji URL for local emojis
        if (!reactionEmojiUrl) {
          const baseName = stripped.replace(/@\.$/, '');
          if (!baseName.includes('@')) {
            reactionEmojiUrl = `${this.instanceUrl}/emoji/${encodeURIComponent(baseName)}.webp`;
          }
        }
      }
    }

    return {
      id: notif.id,
      platform: this.platformType,
      type: notif.type,
      icon: notif.type === 'reaction' ? (notif.reaction || info.icon) : info.icon,
      reactionEmoji: notif.type === 'reaction' ? (notif.reaction || null) : null,
      reactionEmojiUrl,
      label: info.label,
      createdAt: new Date(notif.createdAt),
      actor: notif.user ? this.normalizeUser(notif.user) : null,
      post: notif.note ? this.normalizePost(notif.note) : null,
    };
  }

  mfmToHtml(text, emojis = {}) {
    if (!text) return '';
    let html = this.escapeHtml(text);
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/<i>(.+?)<\/i>/g, '<em>$1</em>');
    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Mentions
    html = html.replace(/@([\w.-]+)(?:@([\w.-]+))?/g, (match, user, host) => {
      return `<span class="mention">@${user}${host ? '@' + host : ''}</span>`;
    });
    // Hashtags
    html = html.replace(/#([\w\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9faf\uac00-\ud7af]+)/g,
      '<span class="hashtag">#$1</span>');
    // URLs
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // Custom emojis :name: or :name@host:
    html = html.replace(/:([a-zA-Z0-9_\-]+(?:@[\w.\-]+)?):/g, (match, name) => {
      const url = emojis[name] || emojis[name + '@.'] || null;
      if (url) {
        return `<img class="inline-emoji" src="${this.escapeHtml(url)}" alt=":${name}:" title=":${name}:" referrerpolicy="no-referrer">`;
      }
      // Fallback: try instance emoji URL for local emojis
      if (!name.includes('@')) {
        return `<img class="inline-emoji" src="${this.instanceUrl}/emoji/${encodeURIComponent(name)}.webp" alt=":${name}:" title=":${name}:" referrerpolicy="no-referrer" onerror="this.replaceWith(this.alt)">`;
      }
      return match;
    });
    // Newlines
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
