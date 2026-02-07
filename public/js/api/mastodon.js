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

  async reblog(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/reblog`);
  }

  async bookmark(id) {
    return this.request('POST', `/api/v1/statuses/${encodeURIComponent(id)}/bookmark`);
  }

  async createStatus(text, options = {}) {
    const body = { status: text };
    if (options.spoilerText) body.spoiler_text = options.spoilerText;
    if (options.mediaIds && options.mediaIds.length > 0) body.media_ids = options.mediaIds;
    if (options.inReplyToId) body.in_reply_to_id = options.inReplyToId;
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

  normalizePost(status) {
    const acct = status.account;
    return {
      id: status.id,
      platform: 'mastodon',
      createdAt: new Date(status.created_at),
      content: status.content,
      contentWarning: status.spoiler_text || null,
      author: {
        id: acct.id,
        displayName: acct.display_name || acct.username,
        username: acct.username,
        acct: acct.acct,
        avatarUrl: acct.avatar,
      },
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
      rebloggedBy: status.reblog ? {
        displayName: acct.display_name || acct.username,
        username: acct.username,
      } : null,
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
      label: info.label,
      createdAt: new Date(notif.created_at),
      actor: {
        displayName: acct.display_name || acct.username,
        username: acct.username,
        avatarUrl: acct.avatar,
      },
      post: notif.status ? this.normalizePost(notif.status) : null,
    };
  }
}
