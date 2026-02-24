/**
 * Mastodon API Client
 * Handles communication with Mastodon instances.
 * Worker 배포 시 /proxy 를 통해 CORS를 우회합니다.
 */
import { escapeHtml, cachedImageUrl } from '../ui/utils.js';

// Mastodon-compatible software that supports emoji reactions
const REACTION_SOFTWARE = new Set(['hollo', 'fedibird', 'glitchcafe', 'akkoma', 'pleroma']);

export class MastodonClient {
  constructor(instanceUrl, accessToken, software = 'mastodon') {
    this.instanceUrl = instanceUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.software = software;
    // localhost가 아니면 Worker 프록시 사용 (Cloudflare 배포 환경)
    this.useProxy = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
  }

  get supportsReactions() {
    return REACTION_SOFTWARE.has(this.software);
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

  async getNotifications(limit = 30, maxId = null, sinceId = null) {
    let path = `/api/v1/notifications?limit=${limit}`;
    if (maxId) path += `&max_id=${maxId}`;
    if (sinceId) path += `&since_id=${sinceId}`;
    return this.request('GET', path);
  }

  async getStatus(id) {
    return this.request('GET', `/api/v1/statuses/${encodeURIComponent(id)}`);
  }

  async getStatusContext(id) {
    return this.request('GET', `/api/v1/statuses/${encodeURIComponent(id)}/context`);
  }

  async getFavouritedBy(id) {
    return this.request('GET', `/api/v1/statuses/${encodeURIComponent(id)}/favourited_by`);
  }

  async favourite(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/favourite`);
  }

  async unfavourite(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/unfavourite`);
  }

  /**
   * Emoji reaction support for Mastodon-compatible forks.
   * - Fedibird/glitch-soc/Hollo: /api/v1/statuses/:id/emoji_reactions/:emoji
   * - Pleroma/Akkoma: /api/v1/pleroma/statuses/:id/reactions/:emoji
   */
  async createReaction(id, reaction = '❤') {
    const emoji = encodeURIComponent(reaction.replace(/^:|:$/g, ''));
    if (this.software === 'akkoma' || this.software === 'pleroma') {
      return this.request('PUT', `/api/v1/pleroma/statuses/${encodeURIComponent(id)}/reactions/${emoji}`);
    }
    return this.request('PUT', `/api/v1/statuses/${encodeURIComponent(id)}/emoji_reactions/${emoji}`);
  }

  async deleteReaction(id, reaction) {
    if (!reaction) return this.unfavourite(id);
    const emoji = encodeURIComponent(reaction.replace(/^:|:$/g, ''));
    if (this.software === 'akkoma' || this.software === 'pleroma') {
      return this.request('DELETE', `/api/v1/pleroma/statuses/${encodeURIComponent(id)}/reactions/${emoji}`);
    }
    return this.request('DELETE', `/api/v1/statuses/${encodeURIComponent(id)}/emoji_reactions/${emoji}`);
  }

  async getReactions(id, type = null) {
    try {
      let reactions;
      if (this.software === 'akkoma' || this.software === 'pleroma') {
        reactions = await this.request('GET', `/api/v1/pleroma/statuses/${encodeURIComponent(id)}/reactions`);
      } else {
        reactions = await this.request('GET', `/api/v1/statuses/${encodeURIComponent(id)}/emoji_reactions`);
      }
      if (!Array.isArray(reactions)) return [];
      // Normalize to flat user list like Misskey: [{ type, user }]
      const result = [];
      for (const r of reactions) {
        if (type && r.name !== type && r.name !== type.replace(/^:|:$/g, '')) continue;
        for (const u of (r.accounts || [])) {
          result.push({ type: r.name, user: u });
        }
      }
      return result;
    } catch (err) {
      console.debug('[StarShip] getReactions failed:', err.message || err);
      return [];
    }
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
    if (options.spoilerText !== undefined) body.spoiler_text = options.spoilerText;
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
      return emojis.map(e => ({ name: e.shortcode, url: e.url, staticUrl: e.static_url || e.url, category: e.category || null }));
    } catch { return []; }
  }

  async fetchThemeColor() {
    // Strategy 1: Try Mastodon v2 instance API for accent_color (Mastodon 4.3+)
    try {
      const instance = await this.request('GET', '/api/v2/instance');
      if (instance.accent_color && this._isUsableColor(instance.accent_color)) {
        return instance.accent_color;
      }
    } catch { /* v2 not available, try fallbacks */ }

    // Strategy 2: Try v1 instance API (some forks include theme_color)
    try {
      const instance = await this.request('GET', '/api/v1/instance');
      if (instance.accent_color && this._isUsableColor(instance.accent_color)) {
        return instance.accent_color;
      }
    } catch { /* continue to HTML fallback */ }

    // Strategy 3: Fetch instance HTML for CSS --color-accent or theme-color meta
    try {
      let color = null;
      if (this.useProxy) {
        const res = await fetch(`/api/instance-theme?url=${encodeURIComponent(this.instanceUrl)}`);
        if (!res.ok) return null;
        const data = await res.json();
        color = data.color || null;
      } else {
        const res = await fetch(this.instanceUrl, { headers: { 'Accept': 'text/html' } });
        if (!res.ok) return null;
        const html = await res.text();
        // Try CSS variable --color-accent first (Mastodon 4.x injects this)
        const cssMatch = html.match(/--color-accent:\s*([^;}]+)/);
        if (cssMatch) color = cssMatch[1].trim();
        // Fall back to theme-color meta tag
        if (!color) {
          const metaMatch = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']theme-color["']/i);
          color = metaMatch ? metaMatch[1] : null;
        }
      }
      // Normalize rgb() to hex for consistent brightness checks
      if (color) color = this._normalizeToHex(color);
      if (color && this._isUsableColor(color)) return color;
      return null;
    } catch { return null; }
  }

  _normalizeToHex(color) {
    if (!color) return color;
    const m = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
    if (m) {
      const toHex = v => parseInt(v).toString(16).padStart(2, '0');
      return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
    }
    return color;
  }

  _isUsableColor(color) {
    if (!color) return false;
    const hex = color.replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return true; // non-standard format — let it through
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness >= 30 && brightness <= 225;
  }

  _extractFirstContentUrl(html) {
    if (!html) return null;
    const regex = /<a\s[^>]*href="([^"]+)"[^>]*>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const tag = match[0];
      // Skip mention and hashtag links
      if (/class="[^"]*\b(mention|hashtag)\b/i.test(tag)) continue;
      const url = match[1].replace(/&amp;/g, '&');
      if (/^https?:\/\//i.test(url)) return url;
    }
    return null;
  }

  async createStatus(text, options = {}) {
    const body = { status: text };
    if (options.spoilerText) body.spoiler_text = options.spoilerText;
    if (options.sensitive) body.sensitive = true;
    if (options.visibility) body.visibility = options.visibility;
    if (options.mediaIds && options.mediaIds.length > 0) body.media_ids = options.mediaIds;
    if (options.inReplyToId) body.in_reply_to_id = options.inReplyToId;
    if (options.quoteId) body.quote_id = options.quoteId;
    return this.request('POST', '/api/v1/statuses', body);
  }

  async uploadMedia(file, { onProgress } = {}) {
    const formData = new FormData();
    formData.append('file', file);

    const targetUrl = `${this.instanceUrl}/api/v2/media`;
    const fetchUrl = this.useProxy
      ? `/proxy?url=${encodeURIComponent(targetUrl)}`
      : targetUrl;

    if (onProgress) {
      return this._xhrUpload(fetchUrl, formData, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` },
        onProgress,
      });
    }

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

  _xhrUpload(url, formData, { headers = {}, onProgress }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new Error('Invalid JSON response')); }
        } else {
          reject(new Error(`Media upload error ${xhr.status}: ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => reject(new Error('Upload network error'));
      xhr.send(formData);
    });
  }

  // === New API methods ===

  async unbookmark(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/unbookmark`);
  }

  async getBookmarks(limit = 20, maxId = null) {
    let path = `/api/v1/bookmarks?limit=${limit}`;
    if (maxId) path += `&max_id=${maxId}`;
    return this.request('GET', path);
  }

  async pinStatus(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/pin`);
  }

  async unpinStatus(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/unpin`);
  }

  async votePoll(pollId, choices) {
    return this.request('POST', `/api/v1/polls/${encodeURIComponent(pollId)}/votes`, { choices });
  }

  async muteAccount(userId, duration = 0) {
    return this.request('POST', `/api/v1/accounts/${encodeURIComponent(userId)}/mute`, { duration });
  }

  async unmuteAccount(userId) {
    return this.request('POST', `/api/v1/accounts/${encodeURIComponent(userId)}/unmute`);
  }

  async blockAccount(userId) {
    return this.request('POST', `/api/v1/accounts/${encodeURIComponent(userId)}/block`);
  }

  async unblockAccount(userId) {
    return this.request('POST', `/api/v1/accounts/${encodeURIComponent(userId)}/unblock`);
  }

  async searchAccounts(query, limit = 10) {
    return this.request('GET', `/api/v2/search?q=${encodeURIComponent(query)}&type=accounts&limit=${limit}&resolve=true`);
  }

  async getFollowRequests(limit = 40) {
    return this.request('GET', `/api/v1/follow_requests?limit=${limit}`);
  }

  async acceptFollowRequest(userId) {
    return this.request('POST', `/api/v1/follow_requests/${encodeURIComponent(userId)}/authorize`);
  }

  async rejectFollowRequest(userId) {
    return this.request('POST', `/api/v1/follow_requests/${encodeURIComponent(userId)}/reject`);
  }

  async getFollowers(userId, limit = 40, maxId = null) {
    let path = `/api/v1/accounts/${encodeURIComponent(userId)}/followers?limit=${limit}`;
    if (maxId) path += `&max_id=${maxId}`;
    return this.request('GET', path);
  }

  async getFollowing(userId, limit = 40, maxId = null) {
    let path = `/api/v1/accounts/${encodeURIComponent(userId)}/following?limit=${limit}`;
    if (maxId) path += `&max_id=${maxId}`;
    return this.request('GET', path);
  }

  async getRebloggedBy(id, limit = 40) {
    return this.request('GET', `/api/v1/statuses/${encodeURIComponent(id)}/reblogged_by?limit=${limit}`);
  }

  async getConversations(limit = 20, maxId = null) {
    let path = `/api/v1/conversations?limit=${limit}`;
    if (maxId) path += `&max_id=${maxId}`;
    return this.request('GET', path);
  }

  async getPublicTimeline(limit = 30, maxId = null, local = false) {
    let path = `/api/v1/timelines/public?limit=${limit}`;
    if (maxId) path += `&max_id=${maxId}`;
    if (local) path += `&local=true`;
    return this.request('GET', path);
  }

  async getHashtagTimeline(hashtag, limit = 30, maxId = null) {
    let path = `/api/v1/timelines/tag/${encodeURIComponent(hashtag)}?limit=${limit}`;
    if (maxId) path += `&max_id=${maxId}`;
    return this.request('GET', path);
  }

  async getPinnedStatuses(userId) {
    return this.request('GET', `/api/v1/accounts/${encodeURIComponent(userId)}/statuses?pinned=true`);
  }

  normalizeUser(acct) {
    const displayName = acct.display_name || acct.username;
    let displayNameHtml = escapeHtml(displayName);
    // Resolve custom emojis in display name
    if (acct.emojis && acct.emojis.length > 0) {
      for (const emoji of acct.emojis) {
        displayNameHtml = displayNameHtml.replaceAll(`:${emoji.shortcode}:`,
          `<img class="inline-emoji" src="${cachedImageUrl(emoji.url)}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" referrerpolicy="no-referrer">`);
      }
    }
    return {
      id: acct.id,
      displayName,
      displayNameHtml,
      username: acct.username,
      acct: acct.acct,
      avatarUrl: cachedImageUrl(acct.avatar),
    };
  }

  /**
   * Enhance Mastodon HTML content with markdown-like formatting.
   * Mastodon API returns pre-formatted HTML, but some instances/forks
   * don't render markdown syntax (bold, code, blockquotes, etc.).
   * This processes text nodes within the HTML to add formatting that
   * matches Misskey's MFM rendering.
   */
  enhanceHtml(html) {
    if (!html) return '';

    // Split HTML into tags and text segments
    const parts = html.split(/(<[^>]+>)/);
    let inPre = false;
    let inCode = false;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.startsWith('<')) {
        if (/<pre[\s>]/i.test(part)) inPre = true;
        else if (/<\/pre>/i.test(part)) inPre = false;
        if (/<code[\s>]/i.test(part)) inCode = true;
        else if (/<\/code>/i.test(part)) inCode = false;
        continue;
      }
      if (inPre || inCode) continue;

      let t = part;

      // Code blocks: ```lang\ncode``` → <pre><code>
      t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) =>
        `<pre class="mfm-code-block"><code>${code.replace(/\n$/, '')}</code></pre>`);

      // Inline code: `code`
      t = t.replace(/`([^`\n]+)`/g, '<code class="mfm-inline-code">$1</code>');

      // Bold: **text**
      t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

      // Strikethrough: ~~text~~
      t = t.replace(/~~(.+?)~~/g, '<del>$1</del>');

      // Blockquote: &gt; at line start (Mastodon HTML-encodes >)
      t = t.replace(/^&gt;\s?(.*)/gm, '<blockquote class="mfm-quote">$1</blockquote>');
      t = t.replace(/<\/blockquote>\n<blockquote class="mfm-quote">/g, '<br>');

      parts[i] = t;
    }

    return parts.join('');
  }

  normalizePost(status) {
    const acct = status.account;
    // Process custom emojis in content
    let content = status.content;
    const emojiMap = {};
    if (status.emojis && status.emojis.length > 0) {
      for (const emoji of status.emojis) {
        emojiMap[emoji.shortcode] = cachedImageUrl(emoji.url);
        content = content.replaceAll(`:${emoji.shortcode}:`,
          `<img class="inline-emoji" src="${cachedImageUrl(emoji.url)}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" referrerpolicy="no-referrer">`);
      }
    }
    // Enhance HTML with markdown-like formatting
    content = this.enhanceHtml(content);
    // Link card from Mastodon API
    const card = status.card;
    let linkCard = null;
    if (card && card.url) {
      let siteName = card.provider_name || '';
      if (!siteName) { try { siteName = new URL(card.url).hostname; } catch {} }
      linkCard = { url: card.url, title: card.title || null, description: card.description || null, image: card.image || null, siteName };
    }

    // Fallback: extract first content URL from HTML if no API card available
    // (Mastodon doesn't always generate cards, e.g. for fedi post URLs)
    if (!linkCard && status.content) {
      const extractedUrl = this._extractFirstContentUrl(status.content);
      if (extractedUrl) {
        try {
          linkCard = { url: extractedUrl, title: null, description: null, image: null, siteName: new URL(extractedUrl).hostname };
        } catch { /* skip invalid URL */ }
      }
    }

    // Quote post support (Fedibird, Pleroma/Akkoma, Mastodon 4.3+, etc.)
    let quotePost = null;
    const quoteSource = status.quote || status.reblog_quote;
    if (quoteSource && quoteSource.account) {
      // Process custom emojis in quote content
      let qContent = quoteSource.content || '';
      if (quoteSource.emojis && quoteSource.emojis.length > 0) {
        for (const emoji of quoteSource.emojis) {
          qContent = qContent.replaceAll(`:${emoji.shortcode}:`,
            `<img class="inline-emoji" src="${cachedImageUrl(emoji.url)}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" referrerpolicy="no-referrer">`);
        }
      }
      qContent = this.enhanceHtml(qContent);
      const qAuthor = this.normalizeUser(quoteSource.account);
      // Nested quote
      let nestedQuote = null;
      const nqs = quoteSource.quote || quoteSource.reblog_quote;
      if (nqs && nqs.account) {
        let nqContent = nqs.content || '';
        if (nqs.emojis && nqs.emojis.length > 0) {
          for (const emoji of nqs.emojis) {
            nqContent = nqContent.replaceAll(`:${emoji.shortcode}:`,
              `<img class="inline-emoji" src="${cachedImageUrl(emoji.url)}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" referrerpolicy="no-referrer">`);
          }
        }
        nqContent = this.enhanceHtml(nqContent);
        nestedQuote = {
          id: nqs.id,
          platform: 'mastodon',
          content: nqContent,
          contentWarning: nqs.spoiler_text || null,
          author: this.normalizeUser(nqs.account),
          media: (nqs.media_attachments || []).map(m => ({
            type: m.type, url: m.url, previewUrl: m.preview_url, description: m.description,
            width: m.meta?.original?.width || m.meta?.small?.width || 0,
            height: m.meta?.original?.height || m.meta?.small?.height || 0,
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
          width: m.meta?.original?.width || m.meta?.small?.width || 0,
          height: m.meta?.original?.height || m.meta?.small?.height || 0,
        })),
        url: quoteSource.url,
        quotePost: nestedQuote,
      };
      // Suppress link card if it points to the quoted post
      if (linkCard && quotePost.url) {
        try {
          const lcUrl = new URL(linkCard.url);
          const qpUrl = new URL(quotePost.url);
          if (lcUrl.origin === qpUrl.origin && lcUrl.pathname === qpUrl.pathname) {
            linkCard = null;
          }
        } catch {
          if (linkCard.url === quotePost.url) linkCard = null;
        }
      }
      // Strip the quote URL from post content to avoid duplicate display
      // Mastodon embeds the quote URL as <a> tag in the HTML content
      if (quotePost.url && content) {
        content = content.replace(
          new RegExp(`<p>\\s*<a[^>]*href="${quotePost.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[^<]*</a>\\s*</p>`, 'g'),
          ''
        );
        // Also strip if it's the last link in a paragraph (not the only content)
        content = content.replace(
          new RegExp(`\\s*<a[^>]*href="${quotePost.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*class="[^"]*quote-inline[^"]*"[^>]*>[^<]*</a>`, 'g'),
          ''
        );
      }
    }

    // Parse emoji_reactions from Mastodon-compatible servers (Fedibird, glitch-soc, Pleroma, Akkoma, etc.)
    let reactions = null;
    let reactionEmojis = null;
    let myReaction = null;
    const emojiReactions = status.emoji_reactions || status.reactions || status.pleroma?.emoji_reactions;
    if (Array.isArray(emojiReactions) && emojiReactions.length > 0) {
      reactions = {};
      reactionEmojis = {};
      for (const er of emojiReactions) {
        const name = er.name || er.emoji;
        if (!name) continue;
        // Custom emoji: wrap in colons
        const isCustom = !!(er.url || er.static_url);
        const key = isCustom ? `:${name}:` : name;
        reactions[key] = (reactions[key] || 0) + (er.count || 1);
        if (isCustom) {
          reactionEmojis[name] = er.url || er.static_url;
        }
        if (er.me) myReaction = key;
      }
      if (Object.keys(reactions).length === 0) {
        reactions = null;
        reactionEmojis = null;
      }
    }

    // Adjust favourites: servers that support emoji_reactions may double-count them in favourites_count
    // Only subtract non-heart reactions — ❤ reactions are equivalent to favourites
    let favouritesCount = status.favourites_count || 0;
    if (reactions) {
      const nonHeartReactions = Object.entries(reactions)
        .filter(([k]) => k !== '❤' && k !== '❤️')
        .reduce((sum, [, c]) => sum + c, 0);
      favouritesCount = Math.max(0, favouritesCount - nonHeartReactions);
    }

    return {
      id: status.id,
      platform: 'mastodon',
      createdAt: new Date(status.created_at),
      content: content,
      contentWarning: status.spoiler_text || null,
      author: this.normalizeUser(acct),
      sensitive: !!status.sensitive,
      media: (status.media_attachments || []).map(m => ({
        type: m.type,
        url: m.url,
        previewUrl: m.preview_url,
        description: m.description,
        width: m.meta?.original?.width || m.meta?.small?.width || 0,
        height: m.meta?.original?.height || m.meta?.small?.height || 0,
      })),
      stats: {
        replies: status.replies_count || 0,
        boosts: status.reblogs_count || 0,
        favourites: favouritesCount,
      },
      reblog: status.reblog ? this.normalizePost(status.reblog) : null,
      rebloggedBy: status.reblog ? this.normalizeUser(acct) : null,
      quotePost,
      favourited: !!status.favourited,
      reblogged: !!status.reblogged,
      reactions,
      reactionEmojis,
      myReaction,
      emojis: emojiMap,
      linkCard,
      canonicalUri: status.uri || status.url,
      instanceUrl: this.instanceUrl,
      replyTo: null,
      replyToId: status.in_reply_to_id || null,
      replyToAcct: status.in_reply_to_id
        ? ((status.mentions || []).find(m => m.id === status.in_reply_to_account_id)?.acct || null)
        : null,
      bookmarked: !!status.bookmarked,
      pinned: !!status.pinned,
      poll: status.poll ? {
        id: status.poll.id,
        expiresAt: status.poll.expires_at ? new Date(status.poll.expires_at) : null,
        expired: !!status.poll.expired,
        multiple: !!status.poll.multiple,
        votesCount: status.poll.votes_count || 0,
        votersCount: status.poll.voters_count || 0,
        voted: !!status.poll.voted,
        ownVotes: status.poll.own_votes || [],
        options: (status.poll.options || []).map(o => ({
          title: o.title,
          votesCount: o.votes_count || 0,
        })),
      } : null,
      visibility: ({ public: 'public', unlisted: 'home', private: 'followers', direct: 'direct' })[status.visibility] || 'public',
      url: status.url,
      raw: status,
    };
  }

  normalizeNotification(notif) {
    const typeMap = {
      'mention': { icon: '💬', label: '멘션' },
      'reblog': { icon: '🔁', label: '부스트' },
      'favourite': { icon: '❤️', label: '좋아요' },
      'emoji_reaction': { icon: '⭐', label: '리액션' },
      'reaction': { icon: '⭐', label: '리액션' },
      'pleroma:emoji_reaction': { icon: '⭐', label: '리액션' },
      'follow': { icon: '👤', label: '팔로우' },
      'follow_request': { icon: '🔔', label: '팔로우 요청' },
      'poll': { icon: '📊', label: '투표 종료' },
      'status': { icon: '📝', label: '새 게시물' },
      'update': { icon: '✏️', label: '수정됨' },
      'quote': { icon: '📌', label: '인용' },
    };

    // Normalize reaction notification types to 'reaction' for consistent handling
    let type = notif.type;
    if (type === 'emoji_reaction' || type === 'pleroma:emoji_reaction') {
      type = 'reaction';
    }

    const acct = notif.account;

    // Extract reaction emoji from notification (Fedibird, glitch-soc, Pleroma, Akkoma)
    // Some forks include emoji/emoji_url even on 'favourite' notifications
    const reactionEmoji = notif.emoji || notif.emoji_reaction || null;
    const reactionEmojiUrl = cachedImageUrl(notif.emoji_url) || null;
    // For favourite type with reaction emoji, normalize to 'reaction' type
    if (type === 'favourite' && reactionEmoji) {
      type = 'reaction';
    }

    // Reaction enrichment for standard Mastodon (which lacks emoji fields in notifications)
    // is handled by _mergeReactionsFromCache + _fetchMissingReactions in data-loading.js
    const info = typeMap[type] || { icon: '🔔', label: type };

    return {
      id: notif.id,
      platform: 'mastodon',
      type,
      icon: reactionEmoji || info.icon,
      reactionEmoji,
      reactionEmojiUrl,
      label: info.label,
      createdAt: new Date(notif.created_at),
      actor: this.normalizeUser(acct),
      post: notif.status ? this.normalizePost(notif.status) : null,
    };
  }
}
