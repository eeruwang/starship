/**
 * Mastodon API Client
 * Handles communication with Mastodon instances.
 * Worker 배포 시 /proxy 를 통해 CORS를 우회합니다.
 */
import { debugLog } from '../ui/debug.js';
import { escapeHtml, cachedImageUrl, sanitizeHtml } from '../ui/utils.js';
import {
  DIALECT_PLEROMA, DIALECT_FEDIBIRD, dialectForSoftware, dialectFromNodeInfo,
  dialectFromInstance, dialectFromStatus, setAccountReactionDialect,
} from '../reaction-support.js';

export class MastodonClient {
  constructor(instanceUrl, accessToken, software = 'mastodon', reactionDialect = null) {
    this.instanceUrl = instanceUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.software = software;
    // 이름으로 알 수 있으면 그것으로 시작하고, 저장된 값이 있으면 그것을 쓴다.
    // 서버 신고를 읽어 오면 detectReactionSupport 가 덮어쓴다.
    this.reactionDialect = reactionDialect || dialectForSoftware(software);
    // localhost가 아니면 Worker 프록시 사용 (Cloudflare 배포 환경)
    this.useProxy = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
  }

  get supportsReactions() {
    return !!this.reactionDialect;
  }

  /** 서버 응답 하나에서 방언을 알아냈을 때 (이미 알고 있으면 그대로 둔다) */
  learnReactionDialect(dialect) {
    if (dialect && !this.reactionDialect) {
      this.reactionDialect = dialect;
      if (this.accountId) setAccountReactionDialect(this.accountId, dialect);
    }
    return this.reactionDialect;
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
      const err = new Error(`Mastodon API error ${res.status}: ${errText}`);
      err.status = res.status;
      throw err;
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
      const err = new Error(`Mastodon API error ${res.status}: ${errText}`);
      err.status = res.status;
      throw err;
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
   * - Fedibird/Hollo:             PUT  /api/v1/statuses/:id/emoji_reactions/:emoji
   * - Hollo(native)  fallback:    POST /api/v1/statuses/:id/react/:emoji
   * - Pleroma/Akkoma:             PUT  /api/v1/pleroma/statuses/:id/reactions/:emoji
   * 어느 쪽인지는 reactionDialect 가 들고 있다. 소프트웨어 이름으로 가르지 않는
   * 까닭은 Fedibird 가 자기를 mastodon 으로 신고하기 때문이다.
   */
  async createReaction(id, reaction = '❤') {
    const emoji = encodeURIComponent(reaction.replace(/^:|:$/g, ''));
    if (this.reactionDialect === DIALECT_PLEROMA) {
      return this.request('PUT', `/api/v1/pleroma/statuses/${encodeURIComponent(id)}/reactions/${emoji}`);
    }
    try {
      return await this.request('PUT', `/api/v1/statuses/${encodeURIComponent(id)}/emoji_reactions/${emoji}`);
    } catch (err) {
      // Hollo: 구버전 / 미구현 시 네이티브 react 엔드포인트로 폴백
      if (this.software === 'hollo' && /\b(404|405|501)\b/.test(err?.message || '')) {
        return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/react/${emoji}`);
      }
      throw err;
    }
  }

  async deleteReaction(id, reaction) {
    if (!reaction) return this.unfavourite(id);
    const emoji = encodeURIComponent(reaction.replace(/^:|:$/g, ''));
    if (this.reactionDialect === DIALECT_PLEROMA) {
      return this.request('DELETE', `/api/v1/pleroma/statuses/${encodeURIComponent(id)}/reactions/${emoji}`);
    }
    try {
      return await this.request('DELETE', `/api/v1/statuses/${encodeURIComponent(id)}/emoji_reactions/${emoji}`);
    } catch (err) {
      if (this.software === 'hollo' && /\b(404|405|501)\b/.test(err?.message || '')) {
        // Hollo 네이티브: POST /unreact/:emoji
        return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/unreact/${emoji}`);
      }
      throw err;
    }
  }

  async getReactions(id, type = null) {
    try {
      let reactions;
      if (this.reactionDialect === DIALECT_PLEROMA) {
        reactions = await this.request('GET', `/api/v1/pleroma/statuses/${encodeURIComponent(id)}/reactions`);
      } else {
        reactions = await this.request('GET', `/api/v1/statuses/${encodeURIComponent(id)}/emoji_reactions`);
      }
      if (!Array.isArray(reactions)) return [];
      // 신고 없이도 이 경로가 열려 있으면 그 서버는 Fedibird 계열 엔드포인트를 받는다
      if (reactions.length > 0) this.learnReactionDialect(DIALECT_FEDIBIRD);
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
      debugLog('api', '[StarShip] getReactions failed:', err.message || err);
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
    if (options.visibility) body.visibility = options.visibility;
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

  // Admin: 인스턴스의 커스텀 이모지 원본 목록 (카테고리 포함).
  // 폴백 순서: v2 admin → v1 admin → public custom_emojis.
  async adminListCustomEmojis() {
    try {
      const res = await this.request('GET', '/api/v2/admin/custom_emojis?limit=500');
      if (Array.isArray(res)) return res;
    } catch (_) {}
    try {
      const res = await this.request('GET', '/api/v1/admin/custom_emojis?limit=500');
      if (Array.isArray(res)) return res;
    } catch (_) {}
    return this.request('GET', '/api/v1/custom_emojis').catch(() => []);
  }

  // Admin: URL 로 커스텀 이모지 추가.
  //
  // 확인된 사실 (Mastodon/Hollo 소스 대조 후):
  //   - Mastodon 은 /api/v1/admin/custom_emojis 를 제공하지 않는다.
  //     config/routes/api.rb 의 admin 네임스페이스에 custom_emojis 리소스 없음.
  //     이모지 관리는 웹 대시보드 (/admin/custom_emojis) form 만 존재
  //     (config/routes/admin.rb:186 은 API 가 아닌 웹 라우트).
  //   - Hollo 도 동일. /emojis 웹 대시보드만.
  //   - Pleroma/Akkoma 는 /api/v1/pleroma/emoji/packs/... 별도 API 지원 (미구현).
  //   - Fedibird 는 확장 API 있을 수 있으나 정확 스펙 미확인.
  //
  // 결론: Mastodon-순정과 Hollo 는 API 지원 안 함 → 웹 대시보드 안내로 대체.
  //       fedibird/pleroma/akkoma 등에서는 향후 필요 시 별도 구현.
  async adminAddCustomEmoji({ shortcode, url, category = '' }) {
    if (!shortcode || !url) throw new Error('shortcode and url required');
    const sw = this.software || 'mastodon';
    // 웹 대시보드 경로 (사용자에게 안내)
    let dashboardPath = '/admin/custom_emojis';   // Mastodon
    if (sw === 'hollo') dashboardPath = '/emojis';
    else if (sw === 'akkoma' || sw === 'pleroma') dashboardPath = '/pleroma/admin/#/custom-emojis';
    const dashboardUrl = `${this.instanceUrl}${dashboardPath}`;

    // fedibird/glitchcafe 는 실험적으로 admin API 있을 수 있음 — 시도만 해봄
    if (sw === 'fedibird' || sw === 'glitchcafe') {
      // 이미지 다운로드 → multipart POST
      let originUrl = url;
      try {
        const u = new URL(url, (typeof window !== 'undefined' ? window.location.origin : 'https://x/'));
        if (u.pathname === '/cache/image' || u.pathname === '/proxy') {
          const inner = u.searchParams.get('url');
          if (inner) originUrl = inner;
        }
      } catch (_) {}
      const fetchUrl = this.useProxy
        ? `/cache/image?url=${encodeURIComponent(originUrl)}`
        : originUrl;
      const imgRes = await fetch(fetchUrl);
      if (!imgRes.ok) throw new Error(`이모지 이미지 다운로드 실패 (${imgRes.status})`);
      const blob = await imgRes.blob();
      const ext = (blob.type.split('/')[1] || 'png').split(';')[0].replace('jpeg', 'jpg');
      const file = new File([blob], `${shortcode}.${ext}`, { type: blob.type || 'image/png' });
      const fd = new FormData();
      fd.append('shortcode', shortcode);
      fd.append('image', file);
      if (category) fd.append('category', category);
      fd.append('visible_in_picker', 'true');
      try {
        return await this.requestFormData('POST', '/api/v1/admin/custom_emojis', fd);
      } catch (_) {
        // 실패 시 fall through to dashboard 안내
      }
    }

    // Mastodon/Hollo: API 미지원 → 대시보드 안내 throw
    const swLabel = { mastodon: 'Mastodon', hollo: 'Hollo', akkoma: 'Akkoma', pleroma: 'Pleroma' }[sw] || sw;
    throw new Error(
      `${swLabel} 은/는 API 로 커스텀 이모지 추가를 지원하지 않습니다.\n`
      + `웹 관리자 대시보드에서 추가하세요: ${dashboardUrl}\n\n`
      + `추가할 정보:\n`
      + `  · 쇼트코드: ${shortcode}\n`
      + `  · 카테고리: ${category || '(없음)'}\n`
      + `  · 원본 URL: ${url}`
    );
  }

  // 서버 버전 문자열 조회 (예: "4.4.0"). 실패 시 null.
  // Mastodon 4.4+ 네이티브 quote 지원 판별용.
  /**
   * /api/v2/instance 를 한 번만 받아 두고 돌려준다. 없으면 v1 로 내려간다.
   * 서버 버전과 리액션 능력 신고가 같은 응답에 들어 있어서 왕복을 한 번으로 줄인다.
   */
  async getInstanceInfo() {
    if (this._instanceInfo !== undefined) return this._instanceInfo;
    for (const path of ['/api/v2/instance', '/api/v1/instance']) {
      try {
        const inst = await this.request('GET', path);
        if (inst && typeof inst === 'object') {
          this._instanceInfo = inst;
          return inst;
        }
      } catch (_) { /* 다음 경로로 */ }
    }
    this._instanceInfo = null;
    return null;
  }

  async getServerVersion() {
    const inst = await this.getInstanceInfo();
    return inst?.version ? String(inst.version) : null;
  }

  /**
   * 이 서버가 이모지 리액션을 받는지, 받는다면 어느 엔드포인트 계열인지 알아낸다.
   * NodeInfo 의 metadata.features 와 instance 응답의 능력 신고를 차례로 읽는다.
   * 둘 다 조용하면 null 이고, 그때는 글에 리액션이 실려 오는 것을 보고 뒤늦게 배운다.
   */
  async detectReactionSupport() {
    const fromInstance = dialectFromInstance(await this.getInstanceInfo());
    if (fromInstance) {
      this.reactionDialect = fromInstance;
      return fromInstance;
    }
    const fromNodeInfo = dialectFromNodeInfo(await this.getNodeInfo());
    if (fromNodeInfo) {
      this.reactionDialect = fromNodeInfo;
      return fromNodeInfo;
    }
    return this.reactionDialect;
  }

  /** NodeInfo 문서. 프록시를 거쳐 받고 한 번만 받는다. */
  async getNodeInfo() {
    if (this._nodeInfo !== undefined) return this._nodeInfo;
    this._nodeInfo = null;
    const url = (target) => this.useProxy ? `/proxy?url=${encodeURIComponent(target)}` : target;
    try {
      const discRes = await fetch(url(`${this.instanceUrl}/.well-known/nodeinfo`), {
        headers: { 'Accept': 'application/json' },
      });
      if (!discRes.ok) return null;
      const disc = await discRes.json();
      const link = (disc.links || []).find(l => (l.rel || '').includes('nodeinfo'));
      if (!link?.href) return null;
      // 남의 호스트로 끌려가지 않게 막는다
      if (new URL(link.href).host !== new URL(this.instanceUrl).host) return null;
      const niRes = await fetch(url(link.href), { headers: { 'Accept': 'application/json' } });
      if (!niRes.ok) return null;
      this._nodeInfo = await niRes.json();
    } catch (_) { /* 신고가 없으면 없는 대로 */ }
    return this._nodeInfo;
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
    if (options.quoteId) {
      // 파라미터 이름이 서버별로 다름 → 둘 다 보내면 각 서버가 아는 것만 인식.
      //   Mastodon 4.5+                     : quoted_status_id  (공식)
      //   Fedibird / Hollo / Akkoma /
      //     Pleroma / glitch-soc            : quote_id          (fork 관행)
      body.quote_id = options.quoteId;
      body.quoted_status_id = options.quoteId;
    }
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

    // Quote post support — 서버별 응답 shape 이 다름:
    //   Fedibird / Pleroma / Akkoma / Hollo : status.quote = <quoted-status>  (직접)
    //   Mastodon 4.4+                        : status.quote = { state, quoted_status: <quoted-status> }
    //   구 fork                              : status.reblog_quote = <quoted-status>
    // 세 케이스 모두 지원.
    let quotePost = null;
    const rawQuote = status.quote || status.reblog_quote;
    let quoteSource = rawQuote;
    if (rawQuote && rawQuote.quoted_status) {
      // Mastodon 4.4+ 포장 형태 — 안쪽 status 를 꺼내고 state=accepted 만 유효로 취급
      if (rawQuote.state && rawQuote.state !== 'accepted') {
        quoteSource = null;   // pending/revoked/deleted → 렌더 안 함
      } else {
        quoteSource = rawQuote.quoted_status;
      }
    }
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
      // Nested quote (동일 언래핑)
      let nestedQuote = null;
      const rawNested = quoteSource.quote || quoteSource.reblog_quote;
      let nqs = rawNested;
      if (rawNested && rawNested.quoted_status) {
        if (rawNested.state && rawNested.state !== 'accepted') nqs = null;
        else nqs = rawNested.quoted_status;
      }
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
          content: sanitizeHtml(nqContent),
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
        content: sanitizeHtml(qContent),
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
      // 신고를 못 찾았어도 글에 리액션이 실려 왔으면 그 서버는 리액션을 받는다
      this.learnReactionDialect(dialectFromStatus(status));
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
      content: sanitizeHtml(content),
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

    // Extract reaction emoji from notification (Fedibird, glitch-soc, Pleroma, Akkoma, Hollo)
    // Some forks include emoji/emoji_url even on 'favourite' notifications.
    // Field name varies: emoji/emoji_reaction (shortcode), emoji_url/emojiURL/emoji_reaction.url
    let reactionEmoji = notif.emoji || notif.emoji_reaction?.shortcode || notif.emoji_reaction || null;
    if (reactionEmoji && typeof reactionEmoji === 'object') {
      reactionEmoji = reactionEmoji.shortcode || reactionEmoji.name || null;
    }
    let reactionEmojiUrl = notif.emoji_url
      || notif.emojiURL
      || notif.emoji_reaction?.url
      || notif.emoji_reaction?.static_url
      || null;
    // If only shortcode is present, try resolving the URL from the post or actor emoji maps
    if (!reactionEmojiUrl && reactionEmoji) {
      const stripped = String(reactionEmoji).replace(/^:/, '').replace(/:$/, '');
      const lookupIn = (list) => {
        if (!Array.isArray(list)) return null;
        const found = list.find(e => e.shortcode === stripped);
        return found ? (found.url || found.static_url || null) : null;
      };
      reactionEmojiUrl = lookupIn(notif.status?.emojis)
        || lookupIn(acct?.emojis)
        || null;
    }
    reactionEmojiUrl = cachedImageUrl(reactionEmojiUrl) || null;
    // Default-favourite emojis (heart and star) are how Misskey-family servers
    // record a "Like" activity in their reaction store. When such reactions
    // are federated to a Mastodon-compatible server with emoji_reaction
    // support, they arrive here as type 'reaction' with emoji='❤' or '⭐'.
    // We treat those as plain favourites so the user sees a Mastodon-native
    // "좋아요" instead of a flood of identical heart/star reactions.
    if (type === 'reaction' && (reactionEmoji === '❤' || reactionEmoji === '❤️' || reactionEmoji === '⭐' || reactionEmoji === '⭐️')) {
      type = 'favourite';
      reactionEmoji = null;
      reactionEmojiUrl = null;
    }
    // For favourite type with a real custom reaction emoji, normalize to 'reaction'
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
