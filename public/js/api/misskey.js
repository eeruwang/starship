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

  async renote(noteId) {
    return this.request('notes/create', { renoteId: noteId });
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

    return {
      id: note.id,
      platform: this.platformType,
      createdAt: new Date(note.createdAt),
      content: this.mfmToHtml(actualNote.text || '', this.buildEmojiMap(actualNote, note)),
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
      url: `${this.instanceUrl}/notes/${note.id}`,
      raw: note,
    };
  }


  buildEmojiMap(actualNote, originalNote) {
    const map = {};

    const addEmojiMapping = (rawKey, rawUrl) => {
      if (typeof rawKey !== 'string' || !rawKey) return;
      if (typeof rawUrl !== 'string' || !rawUrl) return;

      const key = rawKey.trim();
      const url = rawUrl.trim();
      if (!key || !url) return;

      const noColon = key.replace(/^:+|:+$/g, '');
      const base = noColon.split('@')[0];

      const variants = new Set([key, noColon]);
      variants.add(`:${noColon}:`);
      if (base) {
        variants.add(base);
        variants.add(`:${base}:`);
      }

      for (const v of variants) {
        if (!v) continue;
        if (!map[v]) map[v] = url;
      }
    };

    const addFromRecord = (source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return;
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'string') {
          addEmojiMapping(key, value);
          continue;
        }
        if (value && typeof value === 'object') {
          const objectName = value.name || value.shortcode || value.shortName || key;
          const objectUrl = value.url || value.staticUrl || value.publicUrl;
          addEmojiMapping(objectName, objectUrl);
          addEmojiMapping(key, objectUrl);
        }
      }
    };

    const addFromArray = (source) => {
      if (!Array.isArray(source)) return;
      for (const emoji of source) {
        if (!emoji || typeof emoji !== 'object') continue;
        const name = emoji.name || emoji.shortcode || emoji.shortName;
        const url = emoji.url || emoji.staticUrl || emoji.publicUrl;
        addEmojiMapping(name, url);
      }
    };

    addFromRecord(actualNote?.emojis);
    addFromRecord(originalNote?.emojis);
    addFromArray(actualNote?.emojis);
    addFromArray(originalNote?.emojis);
    addFromArray(actualNote?.emojiDefinitions);
    addFromArray(originalNote?.emojiDefinitions);

    const users = [actualNote?.user, originalNote?.user].filter(Boolean);
    for (const user of users) {
      addFromArray(user?.emojis);
      addFromRecord(user?.emojis);
    }

    return map;
  }

  resolveEmojiUrl(token, emojiMap = {}) {
    if (!token || typeof token !== 'string') return null;
    const matched = token.match(/^:([a-zA-Z0-9_.+-]+(?:@[a-zA-Z0-9.-]+)?):$/);
    if (!matched) return null;
    const name = matched[1];
    const base = name.split('@')[0];
    return emojiMap[token] || emojiMap[name] || emojiMap[`:${name}:`] || emojiMap[base] || emojiMap[`:${base}:`] || null;
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
    const reactionEmojiMap = this.buildEmojiMap(notif.note || {}, notif.note || {});
    const mergeEmojiMap = (source) => {
      if (!source || typeof source !== 'object') return;

      const list = Array.isArray(source) ? source : Object.entries(source).map(([key, value]) => {
        if (typeof value === 'string') return { name: key, url: value };
        if (value && typeof value === 'object') {
          return {
            name: value.name || value.shortcode || value.shortName || key,
            url: value.url || value.staticUrl || value.publicUrl,
          };
        }
        return null;
      }).filter(Boolean);

      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const name = item.name || item.shortcode || item.shortName;
        const url = item.url || item.staticUrl || item.publicUrl;
        if (!name || !url) continue;
        const clean = name.replace(/^:+|:+$/g, '');
        const base = clean.split('@')[0];

        reactionEmojiMap[clean] = reactionEmojiMap[clean] || url;
        reactionEmojiMap[`:${clean}:`] = reactionEmojiMap[`:${clean}:`] || url;
        if (base) {
          reactionEmojiMap[base] = reactionEmojiMap[base] || url;
          reactionEmojiMap[`:${base}:`] = reactionEmojiMap[`:${base}:`] || url;
        }
      }
    };

    mergeEmojiMap(notif.user?.emojis);
    mergeEmojiMap(notif.note?.user?.emojis);
    mergeEmojiMap(notif.note?.emojis);
    mergeEmojiMap(notif.note?.emojiDefinitions);
    mergeEmojiMap(notif.reactionEmojis);
    mergeEmojiMap(notif.emojis);

    const reactionEmojiUrl = notif.type === 'reaction'
      ? this.resolveEmojiUrl(notif.reaction, reactionEmojiMap)
      : null;

    return {
      id: notif.id,
      platform: this.platformType,
      type: notif.type,
      icon: notif.type === 'reaction' ? (notif.reaction || info.icon) : info.icon,
      reactionEmojiUrl,
      emojiMap: reactionEmojiMap,
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
    html = html.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

    // Custom emoji (:blobcat:)
    html = html.replace(/:([a-zA-Z0-9_.+-]+(?:@[a-zA-Z0-9.-]+)?):/g, (match, name) => {
      const base = name.split('@')[0];
      const url = emojis?.[name] || emojis?.[`:${name}:`] || emojis?.[base] || emojis?.[`:${base}:`];
      if (!url) return match;
      return `<img class="inline-emoji" src="${url}" alt=":${name}:" loading="lazy">`;
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
