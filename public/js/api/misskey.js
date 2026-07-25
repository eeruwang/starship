/**
 * Misskey API Client
 * Works with Misskey (Original), Iceshrimp, and CherryPick.
 * All use the same base API (Misskey API) with minor variations.
 * Worker 배포 시 /proxy 를 통해 CORS를 우회합니다.
 */
import { escapeHtml, cachedImageUrl, sanitizeHtml } from '../ui/utils.js';

export class MisskeyClient {
  constructor(instanceUrl, accessToken, platformType = 'misskey') {
    this.instanceUrl = instanceUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.platformType = platformType; // 'misskey' | 'iceshrimp' | 'cherrypick'
    // localhost가 아니면 Worker 프록시 사용 (Cloudflare 배포 환경)
    this.useProxy = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
    this._emojiCache = null; // cached instance emojis
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
      const err = new Error(`Misskey API error ${res.status}: ${errText}`);
      err.status = res.status;
      throw err;
    }

    // Some endpoints (e.g. reactions/create, reactions/delete) return 204 No Content
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async verifyCredentials() {
    return this.request('i');
  }

  async getUser(userId) {
    return this.request('users/show', { userId });
  }

  async getUserNotes(userId, limit = 20, untilId = null) {
    const body = { userId, limit, withRenotes: true, includeReplies: true };
    if (untilId) body.untilId = untilId;
    return this.request('users/notes', body);
  }

  async getRelation(userId) {
    const result = await this.request('users/relation', { userId });
    // Can return array or single object depending on version
    return Array.isArray(result) ? result[0] : result;
  }

  async followUser(userId) {
    return this.request('following/create', { userId });
  }

  async unfollowUser(userId) {
    return this.request('following/delete', { userId });
  }

  async updateProfile({ name, description, avatarId, bannerId }) {
    const body = {};
    if (name !== undefined) body.name = name;
    if (description !== undefined) body.description = description || null;
    if (avatarId !== undefined) body.avatarId = avatarId;
    if (bannerId !== undefined) body.bannerId = bannerId;
    return this.request('i/update', body);
  }

  async getHomeTimeline(limit = 30, untilId = null) {
    const body = { limit };
    if (untilId) body.untilId = untilId;
    return this.request('notes/timeline', body);
  }

  async getNotifications(limit = 30, untilId = null, sinceId = null) {
    const body = { limit };
    if (untilId) body.untilId = untilId;
    if (sinceId) body.sinceId = sinceId;
    return this.request('i/notifications', body);
  }

  async resolveUrl(url) {
    const result = await this.request('ap/show', { uri: url });
    if (result.type === 'Note' && result.object) {
      return this.normalizePost(result.object);
    }
    return null;
  }

  async getNote(noteId) {
    return this.request('notes/show', { noteId });
  }

  async getNoteChildren(noteId, limit = 30) {
    return this.request('notes/children', { noteId, limit });
  }

  async getNoteConversation(noteId, limit = 30) {
    return this.request('notes/conversation', { noteId, limit });
  }

  async createReaction(noteId, reaction = '❤') {
    return this.request('notes/reactions/create', { noteId, reaction });
  }

  async deleteReaction(noteId) {
    return this.request('notes/reactions/delete', { noteId });
  }

  async getReactions(noteId, type = null, { limit = 20, offset = 0 } = {}) {
    const body = { noteId, limit: Math.min(Math.max(1, limit), 100) };
    if (offset) body.offset = offset;
    if (type) body.type = type;
    return this.request('notes/reactions', body);
  }

  async deleteNote(noteId) {
    return this.request('notes/delete', { noteId });
  }

  async editNote(noteId, text, options = {}) {
    const body = { noteId, text };
    body.cw = options.cw || null;
    if (options.visibility) body.visibility = options.visibility;
    return this.request('notes/update', body);
  }

  async renote(noteId) {
    return this.request('notes/create', { renoteId: noteId });
  }

  async unrenote(noteId) {
    return this.request('notes/unrenote', { noteId });
  }

  async updateFile(fileId, params = {}) {
    return this.request('drive/files/update', { fileId, ...params });
  }

  async createNote(text, options = {}) {
    const body = { text };
    if (options.cw) body.cw = options.cw;
    if (options.visibility) body.visibility = options.visibility;
    if (options.fileIds && options.fileIds.length > 0) body.fileIds = options.fileIds;
    if (options.replyId) body.replyId = options.replyId;
    if (options.renoteId) body.renoteId = options.renoteId;
    return this.request('notes/create', body);
  }

  async getEmojis() {
    const proxyFetch = async (url, options = {}) => {
      const fetchUrl = this.useProxy
        ? `/proxy?url=${encodeURIComponent(url)}`
        : url;
      return fetch(fetchUrl, options);
    };

    // 1) Try Misskey standard: POST /api/emojis
    try {
      const res = await proxyFetch(`${this.instanceUrl}/api/emojis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        // Misskey returns { emojis: [...] }
        if (data && Array.isArray(data.emojis)) return data.emojis;
        if (Array.isArray(data)) return data;
      }
    } catch { /* try next */ }

    // 2) Fallback: Mastodon-compatible GET /api/v1/custom_emojis (Iceshrimp, etc.)
    try {
      const res = await proxyFetch(`${this.instanceUrl}/api/v1/custom_emojis`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        // Mastodon format: [{ shortcode, url, category, ... }] → normalize to { name, url, category }
        if (Array.isArray(data)) {
          return data
            .filter(e => e.visible_in_picker !== false)
            .map(e => ({
              name: e.shortcode,
              url: e.url || e.static_url,
              category: e.category || null,
              aliases: [],
            }));
        }
      }
    } catch { /* try next */ }

    // 3) Last fallback: emojis from /api/meta (older Misskey/Calckey)
    try {
      const meta = await this.request('meta', {});
      if (meta && Array.isArray(meta.emojis)) {
        return meta.emojis;
      }
    } catch { /* give up */ }

    return [];
  }

  async getInstanceEmojis() {
    if (this._emojiCache) return this._emojiCache;
    try {
      const emojis = await this.getEmojis();
      if (emojis.length > 0) {
        this._emojiCache = emojis;
        return this._emojiCache;
      }
      // Don't cache empty — allow retry
      return [];
    } catch (err) {
      console.error('Failed to fetch instance emojis:', err);
      return [];
    }
  }

  async fetchThemeColor() {
    try {
      const meta = await this.request('meta', {});
      return meta.themeColor || null;
    } catch { return null; }
  }

  // Admin: 인스턴스 커스텀 이모지 목록 (카테고리 포함).
  async adminListCustomEmojis() {
    // Misskey/Sharkey: admin/emoji/list 는 페이지네이션. 최대 500개까지 긁음.
    const all = [];
    let untilId = null;
    for (let i = 0; i < 5; i++) {
      const params = { limit: 100 };
      if (untilId) params.untilId = untilId;
      let batch;
      try {
        batch = await this.request('admin/emoji/list', params);
      } catch (_) {
        // fallback: 공개 emojis 목록만.
        try {
          const emojis = await this.request('emojis', {});
          return (emojis?.emojis || []).map(e => ({
            shortcode: e.name, url: e.url, category: e.category || null,
          }));
        } catch { return []; }
      }
      if (!Array.isArray(batch) || !batch.length) break;
      all.push(...batch);
      if (batch.length < 100) break;
      untilId = batch[batch.length - 1].id;
    }
    return all.map(e => ({
      id: e.id, shortcode: e.name, url: e.url, category: e.category || null,
      aliases: e.aliases || [], license: e.license || '',
    }));
  }

  // Admin: URL 로 커스텀 이모지 추가.
  //   Misskey 표준: 드라이브에 업로드 → admin/emoji/add {fileId}
  //   Sharkey/Firefish 등 일부 fork 는 admin/emoji/add {url} 직접 수용.
  async adminAddCustomEmoji({ shortcode, url, category = '', aliases = [], license = '', isSensitive = false }) {
    if (!shortcode || !url) throw new Error('name and url required');
    // 1) URL 직접 수용 시도 (Sharkey 등)
    try {
      return await this.request('admin/emoji/add', {
        name: shortcode, url, category: category || undefined,
        aliases, license, isSensitive,
      });
    } catch (err) {
      // 400/422 = url 필드 미지원 가능성 → 파일 업로드 폴백
      if (!/\b(400|404|422|501)\b/.test(err?.message || '')) {
        // 계속 폴백
      }
    }
    // 2) 파일 업로드 → fileId 로 add
    let fetchUrl = url;
    try {
      const u = new URL(url, (typeof window !== 'undefined' ? window.location.origin : 'https://x/'));
      if (u.pathname === '/cache/image' || u.pathname === '/proxy') {
        const inner = u.searchParams.get('url');
        if (inner) fetchUrl = inner;
      }
    } catch (_) {}
    if (this.useProxy && !/^\/(cache|proxy)/.test(fetchUrl)) {
      fetchUrl = `/proxy?url=${encodeURIComponent(fetchUrl)}`;
    }
    const imgRes = await fetch(fetchUrl);
    if (!imgRes.ok) throw new Error(`이모지 이미지 다운로드 실패 (${imgRes.status})`);
    const blob = await imgRes.blob();
    const ext = (blob.type.split('/')[1] || 'png').split(';')[0].replace('jpeg', 'jpg');
    const file = new File([blob], `${shortcode}.${ext}`, { type: blob.type || 'image/png' });
    const uploaded = await this.uploadFile(file);
    if (!uploaded?.id) throw new Error('드라이브 업로드 실패');
    return this.request('admin/emoji/add', {
      fileId: uploaded.id,
      name: shortcode, category: category || undefined,
      aliases, license, isSensitive,
    });
  }

  async uploadFile(file, { onProgress } = {}) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('i', this.accessToken);

    const targetUrl = `${this.instanceUrl}/api/drive/files/create`;
    const fetchUrl = this.useProxy
      ? `/proxy?url=${encodeURIComponent(targetUrl)}`
      : targetUrl;

    if (onProgress) {
      return this._xhrUpload(fetchUrl, formData, { onProgress });
    }

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

  _xhrUpload(url, formData, { onProgress }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new Error('Invalid JSON response')); }
        } else {
          reject(new Error(`File upload error ${xhr.status}: ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => reject(new Error('Upload network error'));
      xhr.send(formData);
    });
  }

  // === New API methods ===

  async votePoll(noteId, choice) {
    return this.request('notes/polls/vote', { noteId, choice });
  }

  async getBookmarks(limit = 20, untilId = null) {
    const body = { limit };
    if (untilId) body.untilId = untilId;
    return this.request('i/favorites', body);
  }

  async addBookmark(noteId) {
    return this.request('notes/favorites/create', { noteId });
  }

  async removeBookmark(noteId) {
    return this.request('notes/favorites/delete', { noteId });
  }

  async getDirectNotes(limit = 20, untilId = null) {
    const body = { limit, visibility: 'specified' };
    if (untilId) body.untilId = untilId;
    try {
      return await this.request('notes/mentions', body);
    } catch {
      // Fallback: fetch mentions and filter client-side
      const fbBody = { limit: limit * 3 };
      if (untilId) fbBody.untilId = untilId;
      const mentions = await this.request('notes/mentions', fbBody);
      return mentions.filter(n => n.visibility === 'specified').slice(0, limit);
    }
  }

  async pinNote(noteId) {
    return this.request('i/pin', { noteId });
  }

  async unpinNote(noteId) {
    return this.request('i/unpin', { noteId });
  }

  async muteUser(userId, expiresAt = null) {
    const body = { userId };
    if (expiresAt) body.expiresAt = expiresAt;
    return this.request('mute/create', body);
  }

  async unmuteUser(userId) {
    return this.request('mute/delete', { userId });
  }

  async blockUser(userId) {
    return this.request('blocking/create', { userId });
  }

  async unblockUser(userId) {
    return this.request('blocking/delete', { userId });
  }

  async searchUsers(query, limit = 10) {
    return this.request('users/search', { query, limit });
  }

  async getFollowRequests(limit = 30) {
    return this.request('following/requests/list', { limit });
  }

  async acceptFollowRequest(userId) {
    return this.request('following/requests/accept', { userId });
  }

  async rejectFollowRequest(userId) {
    return this.request('following/requests/reject', { userId });
  }

  async getFollowers(userId, limit = 30, untilId = null) {
    const body = { userId, limit };
    if (untilId) body.untilId = untilId;
    return this.request('users/followers', body);
  }

  async getFollowing(userId, limit = 30, untilId = null) {
    const body = { userId, limit };
    if (untilId) body.untilId = untilId;
    return this.request('users/following', body);
  }

  async getGlobalTimeline(limit = 30, untilId = null) {
    const body = { limit };
    if (untilId) body.untilId = untilId;
    return this.request('notes/global-timeline', body);
  }

  // ===== Pages API =====

  async getMyPages(limit = 20, sinceId = null, untilId = null) {
    const body = { limit };
    if (sinceId) body.sinceId = sinceId;
    if (untilId) body.untilId = untilId;
    return this.request('i/pages', body);
  }

  async getPages(limit = 20, sinceId = null, untilId = null) {
    const body = { limit };
    if (sinceId) body.sinceId = sinceId;
    if (untilId) body.untilId = untilId;
    return this.request('pages/featured', body);
  }

  async getUserPages(userId, limit = 20, untilId = null) {
    const body = { userId, limit };
    if (untilId) body.untilId = untilId;
    return this.request('users/pages', body);
  }

  async getPage(pageId) {
    return this.request('pages/show', { pageId });
  }

  async getPageByName(username, name) {
    return this.request('pages/show', { name, username });
  }

  async createPage(params) {
    return this.request('pages/create', params);
  }

  async updatePage(pageId, params) {
    return this.request('pages/update', { pageId, ...params });
  }

  async deletePage(pageId) {
    return this.request('pages/delete', { pageId });
  }

  async likePage(pageId) {
    return this.request('pages/like', { pageId });
  }

  async unlikePage(pageId) {
    return this.request('pages/unlike', { pageId });
  }

  normalizePage(page) {
    return {
      id: page.id,
      createdAt: new Date(page.createdAt),
      updatedAt: page.updatedAt ? new Date(page.updatedAt) : null,
      title: page.title || '',
      name: page.name || '',
      summary: page.summary || null,
      content: page.content || [],
      variables: page.variables || [],
      script: page.script || '',
      eyeCatchingImage: page.eyeCatchingImage || null,
      eyeCatchingImageId: page.eyeCatchingImageId || null,
      user: page.user ? this.normalizeUser(page.user) : null,
      likedCount: page.likedCount || 0,
      isLiked: !!page.isLiked,
      visibility: page.visibility || 'public',
      hideTitleWhenPinned: !!page.hideTitleWhenPinned,
      alignCenter: !!page.alignCenter,
      font: page.font || 'sans-serif',
      url: `${this.instanceUrl}/@${page.user?.username}/pages/${page.name}`,
      instanceUrl: this.instanceUrl,
    };
  }

  async getLocalTimeline(limit = 30, untilId = null) {
    const body = { limit };
    if (untilId) body.untilId = untilId;
    return this.request('notes/local-timeline', body);
  }

  async searchByTag(tag, limit = 30, untilId = null) {
    const body = { tag, limit };
    if (untilId) body.untilId = untilId;
    return this.request('notes/search-by-tag', body);
  }

  async getPinnedNotes(userId) {
    return this.request('users/show', { userId }).then(u => u?.pinnedNotes || []);
  }

  normalizeUser(user) {
    const displayName = user.name || user.username;
    // Build emoji map from user's emojis
    const userEmojis = {};
    if (user.emojis && typeof user.emojis === 'object' && !Array.isArray(user.emojis)) {
      Object.assign(userEmojis, user.emojis);
    }
    if (Array.isArray(user.emojis)) {
      for (const e of user.emojis) {
        if (e.name && e.url) userEmojis[e.name] = e.url;
      }
    }
    // Resolve custom emoji shortcodes in display name
    const displayNameHtml = this.resolveNameEmojis(displayName, userEmojis);
    return {
      id: user.id,
      displayName,
      displayNameHtml,
      username: user.username,
      acct: user.host ? `${user.username}@${user.host}` : user.username,
      avatarUrl: cachedImageUrl(user.avatarUrl),
    };
  }

  resolveNameEmojis(name, emojis = {}) {
    if (!name) return '';
    let html = escapeHtml(name);
    html = html.replace(/:([a-zA-Z0-9_\-]+(?:@[\w.\-]+)?):/g, (match, emojiName) => {
      const url = emojis[emojiName] || emojis[emojiName + '@.'] || null;
      if (url) {
        return `<img class="inline-emoji" src="${escapeHtml(cachedImageUrl(url))}" alt=":${emojiName}:" title=":${emojiName}:" referrerpolicy="no-referrer">`;
      }
      // Fallback: try instance emoji URL for local emojis
      if (!emojiName.includes('@')) {
        return `<img class="inline-emoji" src="${escapeHtml(cachedImageUrl(`${this.instanceUrl}/emoji/${encodeURIComponent(emojiName)}.webp`))}" alt=":${emojiName}:" title=":${emojiName}:" referrerpolicy="no-referrer" data-fb="alt-text">`;
      }
      return match;
    });
    return html;
  }

  normalizePost(note) {
    const author = this.normalizeUser(note.user);
    const isRenote = note.renote && !note.text && !note.cw && (!note.files || note.files.length === 0);
    const isQuote = note.renote && !isRenote;

    const actualNote = isRenote ? note.renote : note;
    const actualAuthor = isRenote ? this.normalizeUser(note.renote.user) : author;

    const emojiMap = this.buildEmojiMap(actualNote);

    // Build quote post (note with own text + renote = quote)
    let quotePost = null;
    if (isQuote) {
      const qn = note.renote;
      const qAuthor = this.normalizeUser(qn.user);
      const qEmojiMap = this.buildEmojiMap(qn);
      // Nested quote: if the quoted note itself is a quote
      let nestedQuote = null;
      if (qn.renote && qn.text) {
        const nqn = qn.renote;
        const nqAuthor = this.normalizeUser(nqn.user);
        const nqEmojiMap = this.buildEmojiMap(nqn);
        nestedQuote = {
          id: nqn.id,
          platform: this.platformType,
          content: sanitizeHtml(this.mfmToHtml(nqn.text || '', nqEmojiMap)),
          contentWarning: nqn.cw || null,
          author: nqAuthor,
          media: (nqn.files || []).map(f => ({
            type: f.type?.startsWith('video') ? 'video' : 'image',
            url: f.url,
            previewUrl: f.thumbnailUrl || f.url,
            description: f.comment || f.name,
            width: f.properties?.width || 0,
            height: f.properties?.height || 0,
          })),
          url: nqn.uri || `${this.instanceUrl}/notes/${nqn.id}`,
          quotePost: null, // cap at 2 levels
        };
      }
      quotePost = {
        id: qn.id,
        platform: this.platformType,
        content: sanitizeHtml(this.mfmToHtml(qn.text || '', qEmojiMap)),
        contentWarning: qn.cw || null,
        author: qAuthor,
        media: (qn.files || []).map(f => ({
          type: f.type?.startsWith('video') ? 'video' : 'image',
          url: f.url,
          previewUrl: f.thumbnailUrl || f.url,
          description: f.comment || f.name,
          width: f.properties?.width || 0,
          height: f.properties?.height || 0,
        })),
        url: qn.uri || `${this.instanceUrl}/notes/${qn.id}`,
        quotePost: nestedQuote,
      };
    }

    // Extract first external URL for link card (markdown links or bare URLs)
    let linkCard = null;
    const noteText = actualNote.text || '';
    const urlMatch = noteText.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)|(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      const rawUrl = urlMatch[1] || urlMatch[2];
      const cleanUrl = rawUrl.replace(/[).,;:!?]+$/, '');
      try {
        const parsed = new URL(cleanUrl);
        linkCard = { url: cleanUrl, title: null, description: null, image: null, siteName: parsed.hostname };
      } catch { /* skip */ }
    }

    // Suppress link card if it points to the quoted post's URL
    if (linkCard && quotePost) {
      const quoteUrls = [
        quotePost.url,
        `${this.instanceUrl}/notes/${note.renote.id}`,
        note.renote.uri,
      ].filter(Boolean);
      if (quoteUrls.some(u => linkCard.url.includes(u) || u.includes(linkCard.url))) {
        linkCard = null;
      }
    }

    // Suppress link card if it points to the reply parent's URL
    if (linkCard && actualNote.reply) {
      const replyUrls = [
        actualNote.reply.uri,
        `${this.instanceUrl}/notes/${actualNote.reply.id}`,
      ].filter(Boolean);
      if (replyUrls.some(u => linkCard.url.includes(u) || u.includes(linkCard.url))) {
        linkCard = null;
      }
    }

    return {
      id: note.id,
      platform: this.platformType,
      createdAt: new Date(note.createdAt),
      content: sanitizeHtml(this.mfmToHtml(actualNote.text || '', emojiMap)),
      contentWarning: actualNote.cw || null,
      author: actualAuthor,
      sensitive: (actualNote.files || []).some(f => f.isSensitive),
      media: (actualNote.files || []).map(f => ({
        type: f.type?.startsWith('video') ? 'video' : 'image',
        url: f.url,
        previewUrl: f.thumbnailUrl || f.url,
        description: f.comment || f.name,
        sensitive: !!f.isSensitive,
        width: f.properties?.width || 0,
        height: f.properties?.height || 0,
      })),
      stats: {
        replies: actualNote.repliesCount || 0,
        boosts: actualNote.renoteCount || 0,
        favourites: 0,
      },
      reblog: isRenote ? this.normalizePost(note.renote) : null,
      rebloggedBy: isRenote ? author : null,
      quotePost,
      favourited: !!actualNote.myReaction,
      reblogged: false,
      myReaction: actualNote.myReaction || null,
      reactions: actualNote.reactions || {},
      reactionEmojis: actualNote.reactionEmojis || {},
      emojis: emojiMap,
      linkCard,
      canonicalUri: actualNote.uri || `${this.instanceUrl}/notes/${actualNote.id}`,
      replyTo: actualNote.reply ? {
        id: actualNote.reply.id,
        content: sanitizeHtml(this.mfmToHtml(actualNote.reply.text || '', this.buildEmojiMap(actualNote.reply))),
        author: this.normalizeUser(actualNote.reply.user),
        contentWarning: actualNote.reply.cw || null,
      } : null,
      replyToId: actualNote.replyId || null,
      instanceUrl: this.instanceUrl,
      visibility: actualNote.visibility || 'public',
      bookmarked: !!note.isFavorited,
      pinned: false,
      poll: actualNote.poll ? {
        id: actualNote.id,
        expiresAt: actualNote.poll.expiresAt ? new Date(actualNote.poll.expiresAt) : null,
        expired: !!(actualNote.poll.expiresAt && new Date(actualNote.poll.expiresAt) < new Date()),
        multiple: !!actualNote.poll.multiple,
        votesCount: (actualNote.poll.choices || []).reduce((s, c) => s + (c.votes || 0), 0),
        votersCount: 0,
        voted: (actualNote.poll.choices || []).some(c => c.isVoted),
        ownVotes: (actualNote.poll.choices || []).map((c, i) => c.isVoted ? i : -1).filter(i => i >= 0),
        options: (actualNote.poll.choices || []).map(c => ({
          title: c.text,
          votesCount: c.votes || 0,
        })),
      } : null,
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
      reactionEmojiUrl: cachedImageUrl(reactionEmojiUrl),
      label: info.label,
      createdAt: new Date(notif.createdAt),
      actor: notif.user ? this.normalizeUser(notif.user) : null,
      post: notif.note ? this.normalizePost(notif.note) : null,
    };
  }

  mfmToHtml(text, emojis = {}) {
    if (!text) return '';
    let html = escapeHtml(text);

    // 1. Extract code blocks ```lang\ncode``` as placeholders
    const codeBlocks = [];
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang, code: code.replace(/\n$/, '') });
      return `\x00CB${idx}\x00`;
    });

    // 2. Extract inline code `...` as placeholders
    const inlineCodes = [];
    html = html.replace(/`([^`\n]+)`/g, (match, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(code);
      return `\x00IC${idx}\x00`;
    });

    // 3. MFM $[function.params content] (innermost first, repeat for nesting)
    let prevHtml, mfmIter = 0;
    do {
      if (++mfmIter > 10) break; // prevent infinite loop on deeply nested MFM
      prevHtml = html;
      html = html.replace(/\$\[(\w+)(?:\.([\w=,.\-]+))?\s+([^\[\]]*)\]/g, (match, func, paramStr, content) => {
        const params = {};
        if (paramStr) {
          for (const p of paramStr.split(',')) {
            const [k, v] = p.split('=');
            params[k] = v !== undefined ? v : true;
          }
        }
        const speed = params.speed || null;
        const speedStyle = speed ? `animation-duration:${escapeHtml(speed)};` : '';

        switch (func) {
          case 'flip': {
            const h = params.h !== undefined;
            const v = params.v !== undefined;
            const tx = h && v ? 'scale(-1,-1)' : v ? 'scaleY(-1)' : 'scaleX(-1)';
            return `<span style="display:inline-block;transform:${tx}">${content}</span>`;
          }
          case 'x2': return `<span class="mfm-x2">${content}</span>`;
          case 'x3': return `<span class="mfm-x3">${content}</span>`;
          case 'x4': return `<span class="mfm-x4">${content}</span>`;
          case 'blur': return `<span class="mfm-blur">${content}</span>`;
          case 'sparkle': return `<span class="mfm-sparkle" style="${speedStyle}">${content}</span>`;
          case 'spin': {
            const dir = params.left ? 'reverse' : params.alternate ? 'alternate' : 'normal';
            const axis = params.y ? 'Y' : params.x ? 'X' : '';
            const cls = axis ? `mfm-spin-${axis.toLowerCase()}` : 'mfm-spin';
            return `<span class="${cls}" style="animation-direction:${dir};${speedStyle}">${content}</span>`;
          }
          case 'shake': return `<span class="mfm-shake" style="${speedStyle}">${content}</span>`;
          case 'bounce': return `<span class="mfm-bounce" style="${speedStyle}">${content}</span>`;
          case 'jump': return `<span class="mfm-jump" style="${speedStyle}">${content}</span>`;
          case 'tada': return `<span class="mfm-tada" style="${speedStyle}">${content}</span>`;
          case 'twitch': return `<span class="mfm-twitch" style="${speedStyle}">${content}</span>`;
          case 'jelly': return `<span class="mfm-jelly" style="${speedStyle}">${content}</span>`;
          case 'rainbow': return `<span class="mfm-rainbow" style="${speedStyle}">${content}</span>`;
          case 'font': {
            const face = params.serif ? 'serif' : params.monospace ? 'monospace' : params.cursive ? 'cursive' : params.fantasy ? 'fantasy' : null;
            return face ? `<span style="font-family:${face}">${content}</span>` : content;
          }
          case 'fg': {
            const c = params.color ? `#${escapeHtml(params.color)}` : 'inherit';
            return `<span style="color:${c}">${content}</span>`;
          }
          case 'bg': {
            const c = params.color ? `#${escapeHtml(params.color)}` : 'inherit';
            return `<span style="background-color:${c};border-radius:2px;padding:0 2px">${content}</span>`;
          }
          case 'position': {
            const x = parseFloat(params.x) || 0;
            const y = parseFloat(params.y) || 0;
            return `<span style="display:inline-block;transform:translate(${x}em,${y}em)">${content}</span>`;
          }
          case 'scale': {
            const sx = Math.min(parseFloat(params.x) || 1, 5);
            const sy = Math.min(parseFloat(params.y) || 1, 5);
            return `<span style="display:inline-block;transform:scale(${sx},${sy})">${content}</span>`;
          }
          case 'rotate': {
            const deg = parseFloat(params.deg) || 0;
            return `<span style="display:inline-block;transform:rotate(${deg}deg)">${content}</span>`;
          }
          case 'ruby': {
            // $[ruby base text] — content format: "base text"
            const parts = content.split(/\s+/);
            if (parts.length >= 2) {
              const base = parts.slice(0, -1).join(' ');
              const rt = parts[parts.length - 1];
              return `<ruby>${base}<rp>(</rp><rt>${rt}</rt><rp>)</rp></ruby>`;
            }
            return content;
          }
          case 'unixtime': {
            const ts = parseInt(content, 10);
            if (!isNaN(ts)) {
              const d = new Date(ts * 1000);
              return `<time datetime="${d.toISOString()}" title="${d.toISOString()}">${d.toLocaleString('ko-KR')}</time>`;
            }
            return content;
          }
          default: return content;
        }
      });
    } while (html !== prevHtml);

    // 4. Extract markdown links [text](url) as placeholders
    const mdLinks = [];
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match, linkText, url) => {
      const idx = mdLinks.length;
      mdLinks.push({ text: linkText, url });
      return `\x00ML${idx}\x00`;
    });

    // 5. Extract bare URLs as placeholders
    const extractedUrls = [];
    html = html.replace(/(https?:\/\/[^\s<]+)/g, (match) => {
      const cleaned = match.replace(/[).,;:!?&]+$/, '').replace(/&amp;$/, '');
      const idx = extractedUrls.length;
      extractedUrls.push(cleaned);
      const trailing = match.slice(cleaned.length);
      return `\x00URL${idx}\x00${trailing}`;
    });

    // Headings (before hashtags to avoid # conflict)
    html = html.replace(/^(#{1,6})\s+(.+)/gm, (match, hashes, content) => {
      const level = Math.min(hashes.length, 4);
      return `<h${level} class="mfm-heading">${content}</h${level}>`;
    });

    // Bold (MFM **text** and <b> tags)
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/&lt;b&gt;([\s\S]*?)&lt;\/b&gt;/g, '<strong>$1</strong>');
    // Italic (MFM <i> tags are escaped by escapeHtml)
    html = html.replace(/&lt;i&gt;(.+?)&lt;\/i&gt;/g, '<em>$1</em>');
    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // MFM <center> and <small>
    html = html.replace(/&lt;center&gt;([\s\S]*?)&lt;\/center&gt;/g, '<div class="mfm-center">$1</div>');
    html = html.replace(/&lt;small&gt;([\s\S]*?)&lt;\/small&gt;/g, '<small>$1</small>');
    // Mentions \u2014 anchor \ub85c \ub80c\ub354\ud574 events.js \uc758 \uc704\uc784 \ud578\ub4e4\ub7ec\uac00 \ud504\ub85c\ud544 \ubaa8\ub2ec\uc744 \uc5f0\ub2e4.
    // sanitizeHtml \uc774 data-* \ub97c \uc81c\uac70\ud558\ubbc0\ub85c href \uc5d0 acct \uc778\ucf54\ub529. \uc2e4\uc81c \uc774\ub3d9\uc740 preventDefault \ub428.
    html = html.replace(/@([\w.-]+)(?:@([\w.-]+))?/g, (match, user, host) => {
      const acct = host ? `${user}@${host}` : user;
      const label = `@${user}${host ? '@' + host : ''}`;
      const href = `${this.instanceUrl}/@${acct}`;
      return `<a class="mention" href="${escapeHtml(href)}" rel="nofollow noopener noreferrer">${escapeHtml(label)}</a>`;
    });
    // Hashtags \u2014 \ub3d9\uc77c \uc774\uc720\ub85c anchor \ub85c.
    html = html.replace(/#([\w\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9faf\uac00-\ud7af]+)/g,
      (match, tag) => {
        const href = `${this.instanceUrl}/tags/${encodeURIComponent(tag)}`;
        return `<a class="hashtag" href="${escapeHtml(href)}" rel="tag nofollow noopener noreferrer">#${escapeHtml(tag)}</a>`;
      });
    // Custom emojis :name: or :name@host:
    html = html.replace(/:([a-zA-Z0-9_\-]+(?:@[\w.\-]+)?):/g, (match, name) => {
      const url = emojis[name] || emojis[name + '@.'] || null;
      if (url) {
        return `<img class="inline-emoji" src="${escapeHtml(cachedImageUrl(url))}" alt=":${name}:" title=":${name}:" referrerpolicy="no-referrer">`;
      }
      if (!name.includes('@')) {
        return `<img class="inline-emoji" src="${escapeHtml(cachedImageUrl(`${this.instanceUrl}/emoji/${encodeURIComponent(name)}.webp`))}" alt=":${name}:" title=":${name}:" referrerpolicy="no-referrer" data-fb="alt-text">`;
      }
      return match;
    });

    // Blockquotes: lines starting with &gt; (before newline conversion)
    html = html.replace(/^&gt;\s?(.*)/gm, '<blockquote class="mfm-quote">$1</blockquote>');
    html = html.replace(/<\/blockquote>\n<blockquote class="mfm-quote">/g, '<br>');
    // Remove newline immediately after blockquote (block element already provides spacing)
    html = html.replace(/<\/blockquote>\n/g, '</blockquote>');

    // Restore markdown links
    html = html.replace(/\x00ML(\d+)\x00/g, (match, idx) => {
      const link = mdLinks[parseInt(idx)];
      return `<a href="${link.url}" target="_blank" rel="noopener">${link.text}</a>`;
    });

    // Restore bare URLs as clickable links
    html = html.replace(/\x00URL(\d+)\x00/g, (match, idx) => {
      const url = extractedUrls[parseInt(idx)];
      let displayUrl = url;
      if (displayUrl.length > 60) {
        try {
          const parsed = new URL(displayUrl.replaceAll('&amp;', '&'));
          displayUrl = parsed.hostname + (parsed.pathname.length > 20 ? parsed.pathname.substring(0, 20) + '…' : parsed.pathname);
          displayUrl = escapeHtml(displayUrl);
        } catch {
          displayUrl = displayUrl.substring(0, 57) + '…';
        }
      }
      return `<a href="${url}" target="_blank" rel="noopener">${displayUrl}</a>`;
    });

    // Newlines
    html = html.replace(/\n/g, '<br>');

    // Restore inline code (after newline conversion to preserve formatting)
    html = html.replace(/\x00IC(\d+)\x00/g, (match, idx) => {
      return `<code class="mfm-inline-code">${inlineCodes[parseInt(idx)]}</code>`;
    });

    // Restore code blocks (after newline conversion to preserve whitespace)
    html = html.replace(/\x00CB(\d+)\x00/g, (match, idx) => {
      const block = codeBlocks[parseInt(idx)];
      return `<pre class="mfm-code-block"><code>${block.code}</code></pre>`;
    });

    return html;
  }

}
