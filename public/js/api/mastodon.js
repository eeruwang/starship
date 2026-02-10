/**
 * Mastodon API Client
 * Handles communication with Mastodon instances.
 * Worker 배포 시 /proxy 를 통해 CORS를 우회합니다.
 */
export class MastodonClient {
  constructor(instanceUrl, accessToken) {
    this.instanceUrl = instanceUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    // localhost가 아니면 Worker 프록시 사용 (Cloudflare 배포 환경)
    this.useProxy = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
  }

  async request(method, path, body = null) {
    const targetUrl = `${this.instanceUrl}${path}`;
    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const fetchUrl = this.useProxy
      ? `/proxy?url=${encodeURIComponent(targetUrl)}`
      : targetUrl;

    const res = await fetch(fetchUrl, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Mastodon API error ${res.status}: ${errText}`);
    }

    return res.json();
  }

  async verifyCredentials() {
    return this.request('GET', '/api/v1/accounts/verify_credentials');
  }

  async getUser(userId) {
    return this.request('GET', `/api/v1/accounts/${encodeURIComponent(userId)}`);
  }

  async getUserStatuses(userId, limit = 20, maxId = null) {
    let path = `/api/v1/accounts/${encodeURIComponent(userId)}/statuses?limit=${limit}`;
    if (maxId) path += `&max_id=${maxId}`;
    return this.request('GET', path);
  }

  async resolveUrl(url) {
    const results = await this.request('GET', `/api/v2/search?q=${encodeURIComponent(url)}&resolve=true&type=statuses&limit=1`);
    if (results.statuses && results.statuses.length > 0) {
      return this.normalizePost(results.statuses[0]);
    }
    return null;
  }

  async getRelationships(userIds) {
    const params = userIds.map(id => `id[]=${encodeURIComponent(id)}`).join('&');
    return this.request('GET', `/api/v1/accounts/relationships?${params}`);
  }

  async followUser(userId) {
    return this.request('POST', `/api/v1/accounts/${encodeURIComponent(userId)}/follow`);
  }

  async unfollowUser(userId) {
    return this.request('POST', `/api/v1/accounts/${encodeURIComponent(userId)}/unfollow`);
  }

  async updateProfile({ displayName, note, avatar, header }) {
    if (avatar || header) {
      const formData = new FormData();
      if (displayName !== undefined) formData.append('display_name', displayName);
      if (note !== undefined) formData.append('note', note);
      if (avatar) formData.append('avatar', avatar);
      if (header) formData.append('header', header);
      return this.requestFormData('PATCH', '/api/v1/accounts/update_credentials', formData);
    }
    const body = {};
    if (displayName !== undefined) body.display_name = displayName;
    if (note !== undefined) body.note = note;
    return this.request('PATCH', '/api/v1/accounts/update_credentials', body);
  }

  async requestFormData(method, path, formData) {
    const targetUrl = `${this.instanceUrl}${path}`;
    const fetchUrl = this.useProxy
      ? `/proxy?url=${encodeURIComponent(targetUrl)}`
      : targetUrl;

    const res = await fetch(fetchUrl, {
      method,
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Mastodon API error ${res.status}: ${errText}`);
    }
    return res.json();
  }

  async getHomeTimeline(limit = 30, maxId = null) {
    let path = `/api/v1/timelines/home?limit=${limit}`;
    if (maxId) path += `&max_id=${maxId}`;
    return this.request('GET', path);
  }

  async getNotifications(limit = 30, maxId = null) {
    let path = `/api/v1/notifications?limit=${limit}`;
    if (maxId) path += `&max_id=${maxId}`;
    return this.request('GET', path);
  }

  async getStatus(id) {
    return this.request('GET', `/api/v1/statuses/${encodeURIComponent(id)}`);
  }

  async getStatusContext(id) {
    return this.request('GET', `/api/v1/statuses/${encodeURIComponent(id)}/context`);
  }

  async favourite(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/favourite`);
  }

  async unfavourite(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/unfavourite`);
  }

  async reblog(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/reblog`);
  }

  async unreblog(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/unreblog`);
  }

  async deleteStatus(id) {
    return this.request('DELETE', `/api/v1/statuses/${encodeURIComponent(id)}`);
  }

  async getStatusSource(id) {
    return this.request('GET', `/api/v1/statuses/${encodeURIComponent(id)}/source`);
  }

  async editStatus(id, text, options = {}) {
    const body = { status: text };
    if (options.spoilerText) body.spoiler_text = options.spoilerText;
    if (options.mediaIds) body.media_ids = options.mediaIds;
    return this.request('PUT', `/api/v1/statuses/${encodeURIComponent(id)}`, body);
  }

  async bookmark(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/bookmark`);
  }

  async getInstanceEmojis() {
    try {
      const emojis = await this.request('GET', '/api/v1/custom_emojis');
      if (!Array.isArray(emojis)) return [];
      return emojis.map(e => ({ name: e.shortcode, url: e.static_url || e.url, category: e.category || null }));
    } catch { return []; }
  }

  async fetchThemeColor() {
    try {
      const targetUrl = this.instanceUrl;
      const fetchUrl = this.useProxy
        ? `/proxy?url=${encodeURIComponent(targetUrl)}`
        : targetUrl;
      const res = await fetch(fetchUrl, { headers: { 'Accept': 'text/html' } });
      if (!res.ok) return null;
      const html = await res.text();
      const match = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']theme-color["']/i);
      return match ? match[1] : null;
    } catch { return null; }
  }

  async createStatus(text, options = {}) {
    const body = { status: text };
    if (options.spoilerText) body.spoiler_text = options.spoilerText;
    if (options.mediaIds && options.mediaIds.length > 0) body.media_ids = options.mediaIds;
    if (options.inReplyToId) body.in_reply_to_id = options.inReplyToId;
    if (options.quoteId) body.quote_id = options.quoteId;
    return this.request('POST', '/api/v1/statuses', body);
  }

  async uploadMedia(file) {
    const formData = new FormData();
    formData.append('file', file);

    const targetUrl = `${this.instanceUrl}/api/v2/media`;
    const fetchUrl = this.useProxy
      ? `/proxy?url=${encodeURIComponent(targetUrl)}`
      : targetUrl;

    const res = await fetch(fetchUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Media upload error ${res.status}: ${errText}`);
    }
    return res.json();
  }

  normalizeUser(acct) {
    const displayName = acct.display_name || acct.username;
    let displayNameHtml = this.escapeHtml(displayName);
    // Resolve custom emojis in display name
    if (acct.emojis && acct.emojis.length > 0) {
      for (const emoji of acct.emojis) {
        displayNameHtml = displayNameHtml.replaceAll(`:${emoji.shortcode}:`,
          `<img class="inline-emoji" src="${emoji.url}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" referrerpolicy="no-referrer">`);
      }
    }
    return {
      id: acct.id,
      displayName,
      displayNameHtml,
      username: acct.username,
      acct: acct.acct,
      avatarUrl: acct.avatar,
    };
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  normalizePost(status) {
    const acct = status.account;
    // Process custom emojis in content
    let content = status.content;
    const emojiMap = {};
    if (status.emojis && status.emojis.length > 0) {
      for (const emoji of status.emojis) {
        emojiMap[emoji.shortcode] = emoji.url;
        content = content.replaceAll(`:${emoji.shortcode}:`,
          `<img class="inline-emoji" src="${emoji.url}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" referrerpolicy="no-referrer">`);
      }
    }
    // Link card from Mastodon API
    const card = status.card;
    let linkCard = null;
    if (card && card.url) {
      let siteName = card.provider_name || '';
      if (!siteName) { try { siteName = new URL(card.url).hostname; } catch {} }
      linkCard = { url: card.url, title: card.title || null, description: card.description || null, image: card.image || null, siteName };
    }

    // Quote post support (Fedibird, Pleroma/Akkoma, etc.)
    let quotePost = null;
    const quoteSource = status.quote || status.reblog_quote;
    if (quoteSource && quoteSource.account) {
      const qContent = quoteSource.content || '';
      const qAuthor = this.normalizeUser(quoteSource.account);
      // Nested quote
      let nestedQuote = null;
      const nqs = quoteSource.quote || quoteSource.reblog_quote;
      if (nqs && nqs.account) {
        nestedQuote = {
          id: nqs.id,
          platform: 'mastodon',
          content: nqs.content || '',
          contentWarning: nqs.spoiler_text || null,
          author: this.normalizeUser(nqs.account),
          media: (nqs.media_attachments || []).map(m => ({
            type: m.type, url: m.url, previewUrl: m.preview_url, description: m.description,
          })),
          url: nqs.url,
          quotePost: null,
        };
      }
      quotePost = {
        id: quoteSource.id,
        platform: 'mastodon',
        content: qContent,
        contentWarning: quoteSource.spoiler_text || null,
        author: qAuthor,
        media: (quoteSource.media_attachments || []).map(m => ({
          type: m.type,
          url: m.url,
          previewUrl: m.preview_url,
          description: m.description,
        })),
        url: quoteSource.url,
        quotePost: nestedQuote,
      };
      // Suppress link card if it points to the quoted post
      if (linkCard && quotePost.url && linkCard.url.includes(quotePost.url)) {
        linkCard = null;
      }
    }

    return {
      id: status.id,
      platform: 'mastodon',
      createdAt: new Date(status.created_at),
      content: content,
      contentWarning: status.spoiler_text || null,
      author: this.normalizeUser(acct),
      media: (status.media_attachments || []).map(m => ({
        type: m.type,
        url: m.url,
        previewUrl: m.preview_url,
        description: m.description,
      })),
      stats: {
        replies: status.replies_count || 0,
        reblogs: status.reblogs_count || 0,
        favourites: status.favourites_count || 0,
      },
      reblog: status.reblog ? this.normalizePost(status.reblog) : null,
      rebloggedBy: status.reblog ? this.normalizeUser(acct) : null,
      quotePost,
      favourited: !!status.favourited,
      reblogged: !!status.reblogged,
      myReaction: null,
      emojis: emojiMap,
      linkCard,
      canonicalUri: status.uri || status.url,
      instanceUrl: this.instanceUrl,
      replyTo: null,
      replyToId: status.in_reply_to_id || null,
      replyToAcct: status.in_reply_to_id
        ? ((status.mentions || []).find(m => m.id === status.in_reply_to_account_id)?.acct || null)
        : null,
      url: status.url,
      raw: status,
    };
  }

  normalizeNotification(notif) {
    const typeMap = {
      'mention': { icon: '💬', label: '멘션' },
      'reblog': { icon: '🔁', label: '부스트' },
      'favourite': { icon: '⭐', label: '즐겨찾기' },
      'follow': { icon: '👤', label: '팔로우' },
      'follow_request': { icon: '🔔', label: '팔로우 요청' },
      'poll': { icon: '📊', label: '투표 종료' },
      'status': { icon: '📝', label: '새 게시물' },
      'update': { icon: '✏️', label: '수정됨' },
    };

    const info = typeMap[notif.type] || { icon: '🔔', label: notif.type };
    const acct = notif.account;

    return {
      id: notif.id,
      platform: 'mastodon',
      type: notif.type,
      icon: info.icon,
      reactionEmoji: null,
      reactionEmojiUrl: null,
      label: info.label,
      createdAt: new Date(notif.created_at),
      actor: this.normalizeUser(acct),
      post: notif.status ? this.normalizePost(notif.status) : null,
    };
  }
}
