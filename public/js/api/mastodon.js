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
    if (options.cw) body.spoiler_text = options.cw;
    if (options.replyId) body.in_reply_to_id = options.replyId;
    if (options.visibility) body.visibility = options.visibility;
    if (options.mediaIds && options.mediaIds.length > 0) body.media_ids = options.mediaIds;
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
      throw new Error(`미디어 업로드 실패 ${res.status}: ${errText}`);
    }
    return res.json();
  }

  normalizePost(status) {
    const acct = status.account;
    const isReblog = !!status.reblog;
    const actualStatus = isReblog ? status.reblog : status;
    const actualAcct = isReblog ? status.reblog.account : acct;

    // Reply info
    let replyTo = null;
    if (actualStatus.in_reply_to_id) {
      replyTo = {
        id: actualStatus.in_reply_to_id,
        accountId: actualStatus.in_reply_to_account_id,
        partial: true,
      };
    }

    return {
      id: status.id,
      platform: 'mastodon',
      createdAt: new Date(status.created_at),
      content: actualStatus.content,
      contentWarning: actualStatus.spoiler_text || null,
      author: {
        id: actualAcct.id,
        displayName: actualAcct.display_name || actualAcct.username,
        displayNameHtml: this.renderDisplayName(actualAcct),
        username: actualAcct.username,
        acct: actualAcct.acct,
        avatarUrl: actualAcct.avatar,
      },
      media: (actualStatus.media_attachments || []).map(m => ({
        type: m.type,
        url: m.url,
        previewUrl: m.preview_url,
        description: m.description,
      })),
      stats: {
        replies: actualStatus.replies_count || 0,
        reblogs: actualStatus.reblogs_count || 0,
        favourites: actualStatus.favourites_count || 0,
      },
      reblog: isReblog ? this.normalizePost(status.reblog) : null,
      rebloggedBy: isReblog ? {
        displayName: acct.display_name || acct.username,
        displayNameHtml: this.renderDisplayName(acct),
        username: acct.username,
      } : null,
      uri: status.uri,
      url: status.url,
      replyTo,
      raw: status,
    };
  }

  normalizeNotification(notif) {
    const typeLabels = {
      'mention': '멘션',
      'reblog': '부스트',
      'favourite': '즐겨찾기',
      'follow': '팔로우',
      'follow_request': '팔로우 요청',
      'poll': '투표 종료',
      'status': '새 게시물',
      'update': '수정됨',
    };

    const label = typeLabels[notif.type] || notif.type;
    const acct = notif.account;

    return {
      id: notif.id,
      platform: 'mastodon',
      type: notif.type,
      label,
      createdAt: new Date(notif.created_at),
      actor: {
        displayName: acct.display_name || acct.username,
        displayNameHtml: this.renderDisplayName(acct),
        username: acct.username,
        avatarUrl: acct.avatar,
      },
      post: notif.status ? this.normalizePost(notif.status) : null,
      reaction: null,
    };
  }

  renderDisplayName(acct) {
    const name = acct.display_name || acct.username;
    let html = this.escapeHtml(name);
    if (Array.isArray(acct.emojis)) {
      for (const e of acct.emojis) {
        if (e.shortcode && (e.url || e.static_url)) {
          const re = new RegExp(`:${e.shortcode}:`, 'g');
          html = html.replace(re, `<img class="inline-emoji" src="${e.url || e.static_url}" alt=":${e.shortcode}:" title=":${e.shortcode}:">`);
        }
      }
    }
    return html;
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
