/**
 * Streaming Mixin
 * Integrates StreamManager with the app — injects real-time posts and
 * notifications into visible columns.
 */
import { renderPost, renderNotification } from '../ui/dashboard.js';

export const StreamingMixin = {

  startStreaming() {
    if (!this.streamManager) return;

    // Wire up event handlers (only once)
    if (!this._streamBound) {
      this._streamBound = true;
      this.streamManager.on('post', (data) => this._onStreamPost(data));
      this.streamManager.on('notification', (data) => this._onStreamNotification(data));
      this.streamManager.on('postDelete', (data) => this._onStreamPostDelete(data));
    }

    const accounts = this.store.getAll();
    for (const account of accounts) {
      const client = this.store.getClient(account.id);
      if (client) {
        this.streamManager.connect(account, client);
      }
    }
  },

  stopStreaming() {
    if (this.streamManager) {
      this.streamManager.disconnectAll();
    }
  },

  /** Restart streaming after account changes (add/remove/sync). */
  restartStreaming() {
    this.stopStreaming();
    if (!this.store.isEmpty()) {
      this.startStreaming();
    }
  },

  _onStreamPost({ account, post }) {
    // Add metadata (same as _addPostMeta in data-loading)
    post.accountId = account.id;
    post.accountPlatform = account.platform;
    post.themeColor = this._accountColor(account);
    const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
    post.isOwn = String(ownerId) === String(account.profile.id);

    // Cache
    this.cachePosts([post]);

    // Find columns that should receive this post
    const columns = this.columnsContainer.querySelectorAll('.column');
    for (const col of columns) {
      const type = col.dataset.columnType;
      const content = col.querySelector('.column-content');
      if (!content) continue;

      let shouldAdd = false;
      if (type === 'all' && !account.hidden) {
        shouldAdd = true;
      } else if (type === 'account' && col.dataset.accountId === account.id) {
        shouldAdd = true;
      }
      if (!shouldAdd) continue;

      // Duplicate check by platform:id
      if (content.querySelector(`.post-card[data-platform="${post.platform}"][data-post-id="${post.id}"]`)) continue;

      // Duplicate check by canonicalUri (same post from another account)
      const displayPost = post.reblog || post;
      if (displayPost.canonicalUri) {
        const existing = content.querySelector(`.post-card[data-canonical-uri="${CSS.escape(displayPost.canonicalUri)}"]`);
        if (existing) continue;
      }

      // Remove "empty" placeholder if present
      const placeholder = content.querySelector('.loading-text');
      if (placeholder) placeholder.remove();

      const el = renderPost(post);
      el.classList.add('new-post');

      const scrollTop = content.scrollTop;
      content.insertBefore(el, content.firstChild);

      // Keep scroll position stable if user has scrolled down
      if (scrollTop > 0) {
        content.scrollTop = scrollTop + el.offsetHeight + 8;
      }

      setTimeout(() => el.classList.remove('new-post'), 400);
      this.enrichLinkCards(content);
    }
  },

  _onStreamNotification({ account, notif }) {
    notif.accountId = account.id;
    notif.instanceUrl = account.instanceUrl;
    notif.themeColor = this._accountColor(account);

    // Cache the attached post
    if (notif.post) {
      notif.post.accountId = account.id;
      notif.post.accountPlatform = account.platform;
      this.cachePosts([notif.post]);
    }

    const columns = this.columnsContainer.querySelectorAll('.column');
    for (const col of columns) {
      if (col.dataset.columnType !== 'notifications') continue;
      const content = col.querySelector('.column-content');
      if (!content) continue;

      // Skip if account is hidden
      if (account.hidden) continue;

      // Duplicate check
      if (content.querySelector(`.notif-card[data-platform="${notif.platform}"][data-notif-id="${notif.id}"]`)) continue;

      // Remove "empty" placeholder
      const placeholder = content.querySelector('.loading-text');
      if (placeholder) placeholder.remove();

      const el = renderNotification(notif);
      el.classList.add('new-post');

      const scrollTop = content.scrollTop;
      content.insertBefore(el, content.firstChild);

      if (scrollTop > 0) {
        content.scrollTop = scrollTop + el.offsetHeight + 8;
      }

      setTimeout(() => el.classList.remove('new-post'), 400);
      this.enrichLinkCards(content);
    }
  },

  _onStreamPostDelete({ account, postId }) {
    // Remove deleted posts from all columns
    const cards = this.columnsContainer.querySelectorAll(`.post-card[data-platform="${account.platform}"][data-post-id="${postId}"]`);
    for (const card of cards) {
      card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.95)';
      setTimeout(() => card.remove(), 300);
    }
    // Also remove from cache
    this.postCache.delete(`${account.platform}:${postId}`);
  },
};
