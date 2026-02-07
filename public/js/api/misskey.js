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
    this._emojiCache = null;
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

  async renote(noteId) {
    return this.request('notes/create', { renoteId: noteId });
  }

  async createNote(text, options = {}) {
    const body = { text };
    if (options.cw) body.cw = options.cw;
    if (options.replyId) body.replyId = options.replyId;
    if (options.visibility) body.visibility = options.visibility;
    if (options.fileIds && options.fileIds.length > 0) body.fileIds = options.fileIds;
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
      throw new Error(`파일 업로드 실패 ${res.status}: ${errText}`);
    }
    return res.json();
  }

  normalizeUser(user) {
    // Build emoji map from user's custom emojis (for display name)
    const userEmojis = {};
    if (Array.isArray(user.emojis)) {
      for (const e of user.emojis) {
        if (e.name && e.url) userEmojis[e.name] = e.url;
      }
    } else if (user.emojis && typeof user.emojis === 'object') {
      Object.assign(userEmojis, user.emojis);
    }
    const mergedEmojis = { ...(this._emojiCache || {}), ...userEmojis };

    const displayName = user.name || user.username;

    return {
      id: user.id,
      displayName,
      displayNameHtml: this.renderEmojis(displayName, mergedEmojis),
      username: user.username,
      acct: user.host ? `${user.username}@${user.host}` : user.username,
      avatarUrl: user.avatarUrl,
    };
  }

  renderEmojis(text, emojiMap) {
    if (!text) return '';
    let html = this.escapeHtml(text);
    html = html.replace(/:([a-zA-Z0-9_]+(?:@[\w.-]+)?):/g, (match, name) => {
      const baseName = name.includes('@') ? name.split('@')[0] : name;
      const url = emojiMap[name] || emojiMap[baseName];
      if (url) {
        return `<img class="inline-emoji" src="${url}" alt=":${name}:" title=":${name}:">`;
      }
      return match;
    });
    return html;
  }

  normalizePost(note) {
    const author = this.normalizeUser(note.user);
    const isRenote = note.renote && !note.text && !note.cw && (!note.files || note.files.length === 0);

    const actualNote = isRenote ? note.renote : note;
    const actualAuthor = isRenote ? this.normalizeUser(note.renote.user) : author;
    const emojiMap = this.buildEmojiMap(actualNote);

    // Parent post for replies
    let replyTo = null;
    if (note.reply) {
      const replyAuthor = this.normalizeUser(note.reply.user);
      const replyEmojiMap = this.buildEmojiMap(note.reply);
      replyTo = {
        id: note.reply.id,
        author: replyAuthor,
        content: this.mfmToHtml(note.reply.text || '', replyEmojiMap),
        createdAt: new Date(note.reply.createdAt),
        url: `${this.instanceUrl}/notes/${note.reply.id}`,
      };
    } else if (actualNote.replyId) {
      // We know it's a reply but don't have parent data
      replyTo = { id: actualNote.replyId, partial: true };
    }

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
        displayNameHtml: author.displayNameHtml,
        username: author.username,
      } : null,
      reactions: actualNote.reactions || {},
      reactionEmojis: emojiMap,
      instanceUrl: this.instanceUrl,
      uri: note.uri || null,
      url: `${this.instanceUrl}/notes/${note.id}`,
      replyTo,
      raw: note,
    };
  }

  normalizeNotification(notif) {
    const typeLabels = {
      'reaction': '리액션',
      'reply': '답글',
      'renote': '리노트',
      'quote': '인용',
      'mention': '멘션',
      'follow': '팔로우',
      'followRequestAccepted': '팔로우 수락',
      'receiveFollowRequest': '팔로우 요청',
      'pollEnded': '투표 종료',
      'achievementEarned': '업적 획득',
      'app': '앱 알림',
      'note': '새 노트',
    };

    const label = typeLabels[notif.type] || notif.type;

    // Resolve reaction emoji
    let reaction = null;
    if (notif.type === 'reaction' && notif.reaction) {
      const customMatch = notif.reaction.match(/^:(.+):$/);
      if (customMatch) {
        const emojiName = customMatch[1];
        let emojiUrl = null;

        // Try reactionEmojis from the note
        if (notif.note?.reactionEmojis) {
          emojiUrl = notif.note.reactionEmojis[emojiName];
          if (!emojiUrl) {
            const baseName = emojiName.includes('@') ? emojiName.split('@')[0] : emojiName;
            emojiUrl = notif.note.reactionEmojis[baseName];
          }
        }

        // Try instance emoji cache
        if (!emojiUrl && this._emojiCache) {
          const baseName = emojiName.includes('@') ? emojiName.split('@')[0] : emojiName;
          emojiUrl = this._emojiCache[emojiName] || this._emojiCache[baseName];
        }

        // Fallback: try remote instance emoji endpoint
        if (!emojiUrl && emojiName.includes('@')) {
          const [name, host] = emojiName.split('@');
          emojiUrl = `https://${host}/emoji/${encodeURIComponent(name)}.webp`;
        }

        // Fallback: try local instance emoji endpoint
        if (!emojiUrl) {
          const baseName = emojiName.includes('@') ? emojiName.split('@')[0] : emojiName;
          emojiUrl = `${this.instanceUrl}/emoji/${encodeURIComponent(baseName)}.webp`;
        }

        reaction = { type: 'image', url: emojiUrl, alt: notif.reaction };
      } else {
        // Unicode emoji
        reaction = { type: 'text', value: notif.reaction };
      }
    }

    return {
      id: notif.id,
      platform: this.platformType,
      type: notif.type,
      label,
      createdAt: new Date(notif.createdAt),
      actor: notif.user ? this.normalizeUser(notif.user) : null,
      post: notif.note ? this.normalizePost(notif.note) : null,
      reaction,
    };
  }

  async fetchEmojis() {
    if (this._emojiCache) return this._emojiCache;
    this._emojiCache = {};

    // Strategy 1: Misskey native api/emojis
    try {
      const result = await this.request('emojis');
      const emojis = result.emojis || result;
      if (Array.isArray(emojis)) {
        for (const e of emojis) {
          if (e.name && e.url) this._emojiCache[e.name] = e.url;
        }
      }
    } catch { /* endpoint might not exist */ }

    // Strategy 2: Mastodon-compatible endpoint (widely supported across forks)
    if (Object.keys(this._emojiCache).length === 0) {
      try {
        const targetUrl = `${this.instanceUrl}/api/v1/custom_emojis`;
        const fetchUrl = this.useProxy
          ? `/proxy?url=${encodeURIComponent(targetUrl)}`
          : targetUrl;
        const res = await fetch(fetchUrl);
        if (res.ok) {
          const emojis = await res.json();
          if (Array.isArray(emojis)) {
            for (const e of emojis) {
              if (e.shortcode && (e.url || e.static_url)) {
                this._emojiCache[e.shortcode] = e.url || e.static_url;
              }
            }
          }
        }
      } catch { /* endpoint might not exist */ }
    }

    return this._emojiCache;
  }

  buildEmojiMap(note) {
    const map = {};
    // From instance emoji cache: resolve reaction keys
    if (this._emojiCache && note.reactions) {
      for (const reactionKey of Object.keys(note.reactions)) {
        const match = reactionKey.match(/^:(.+):$/);
        if (match) {
          const fullName = match[1];
          // Strip @host to match local cache key (e.g. "dogroll@instance" → "dogroll")
          const baseName = fullName.includes('@') ? fullName.split('@')[0] : fullName;
          const url = this._emojiCache[fullName] || this._emojiCache[baseName];
          if (url) map[fullName] = url;
        }
      }
    }
    // From emojis array (some forks use this)
    if (Array.isArray(note.emojis)) {
      for (const e of note.emojis) {
        if (e.name && e.url) map[e.name] = e.url;
      }
    } else if (note.emojis && typeof note.emojis === 'object') {
      Object.assign(map, note.emojis);
    }
    // reactionEmojis takes priority
    if (note.reactionEmojis) {
      Object.assign(map, note.reactionEmojis);
    }
    return map;
  }

  mfmToHtml(text, emojiMap = {}) {
    if (!text) return '';
    let html = this.escapeHtml(text);
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/<i>(.+?)<\/i>/g, '<em>$1</em>');
    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Custom emoji :name: or :name@host: — do BEFORE URL processing
    // Use placeholder tokens to prevent URL regex from matching inside img tags
    const emojiTokens = [];
    html = html.replace(/:([a-zA-Z0-9_]+(?:@[\w.-]+)?):/g, (match, name) => {
      const baseName = name.includes('@') ? name.split('@')[0] : name;
      const url = emojiMap[name] || emojiMap[baseName];
      if (url) {
        const token = `\x00EMOJI_${emojiTokens.length}\x00`;
        emojiTokens.push(`<img class="inline-emoji" src="${url}" alt=":${name}:" title=":${name}:">`);
        return token;
      }
      if (this.instanceUrl && !name.includes('@')) {
        const token = `\x00EMOJI_${emojiTokens.length}\x00`;
        emojiTokens.push(`<img class="inline-emoji" src="${this.instanceUrl}/emoji/${encodeURIComponent(name)}.webp" alt=":${name}:" title=":${name}:" onerror="this.parentNode.replaceChild(document.createTextNode(':${name}:'),this)">`);
        return token;
      }
      if (name.includes('@')) {
        const [eName, host] = name.split('@');
        const token = `\x00EMOJI_${emojiTokens.length}\x00`;
        emojiTokens.push(`<img class="inline-emoji" src="https://${host}/emoji/${encodeURIComponent(eName)}.webp" alt=":${name}:" title=":${name}:" onerror="this.parentNode.replaceChild(document.createTextNode(':${name}:'),this)">`);
        return token;
      }
      return match;
    });

    // Mentions
    html = html.replace(/@([\w.-]+)(?:@([\w.-]+))?/g, (match, user, host) => {
      return `<span class="mention">@${user}${host ? '@' + host : ''}</span>`;
    });
    // Hashtags
    html = html.replace(/#([\w\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9faf\uac00-\ud7af]+)/g,
      '<span class="hashtag">#$1</span>');
    // URLs — won't match inside emoji tokens (they use \x00)
    html = html.replace(/(https?:\/\/[^\s<\x00]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // Newlines
    html = html.replace(/\n/g, '<br>');

    // Restore emoji tokens
    for (let i = 0; i < emojiTokens.length; i++) {
      html = html.replace(`\x00EMOJI_${i}\x00`, emojiTokens[i]);
    }

    return html;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
