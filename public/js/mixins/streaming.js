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
      this.streamManager.on('postUpdate', (data) => this._onStreamPostUpdate(data));
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
    post.accountSoftware = account.software || account.platform;
    post.themeColor = this._accountColor(account);
    const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
    post.isOwn = String(ownerId) === String(account.profile?.id);

    // Cache
    this.cachePosts([post]);

    // Find columns that should receive this post
    const columns = this.columnsContainer.querySelectorAll('.column');
    for (const col of columns) {
      const type = col.dataset.columnType;
      const content = col.querySelector('.column-content');
      if (!content) continue;

      // --- Timeline columns (all / account) ---
      if (type === 'all' || type === 'account') {
        let shouldAdd = false;
        if (type === 'all' && !account.hidden) {
          shouldAdd = true;
        } else if (type === 'account' && col.dataset.accountId === account.id) {
          shouldAdd = true;
        }
        if (!shouldAdd) continue;

        // Duplicate check by platform:id
        if (content.querySelector(`.post-card[data-platform="${CSS.escape(post.platform)}"][data-post-id="${CSS.escape(post.id)}"]`)) continue;

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
        continue;
      }

      // --- Thread columns: append replies in real-time ---
      if (type === 'thread') {
        this._addStreamPostToThread(col, content, post);
      }
    }
  },

  /**
   * Try to append a streaming post as a new reply in a thread column.
   * Only adds the post if its replyToId matches a post already in the thread.
   */
  _addStreamPostToThread(col, content, post) {
    const replyToId = post.replyToId;
    if (!replyToId) return;

    // Duplicate check
    if (content.querySelector(`.post-card[data-platform="${CSS.escape(post.platform)}"][data-post-id="${CSS.escape(post.id)}"]`)) return;
    const displayPost = post.reblog || post;
    if (displayPost.canonicalUri) {
      if (content.querySelector(`.post-card[data-canonical-uri="${CSS.escape(displayPost.canonicalUri)}"]`)) return;
    }

    // Find the parent card in the thread column
    let parentCard = content.querySelector(
      `.post-card[data-platform="${CSS.escape(post.platform)}"][data-post-id="${CSS.escape(replyToId)}"]`
    );

    // Cross-account: try canonicalUri lookup if direct ID didn't match
    if (!parentCard) {
      const cachedParent = this.postCache.get(`${post.platform}:${replyToId}`);
      if (cachedParent) {
        const parentUri = (cachedParent.reblog || cachedParent).canonicalUri;
        if (parentUri) {
          parentCard = content.querySelector(`.post-card[data-canonical-uri="${CSS.escape(parentUri)}"]`);
        }
      }
    }

    if (!parentCard) return;

    // Determine parent's depth from its CSS class
    const getCardDepth = (card) => {
      if (card.classList.contains('thread-target') || card.classList.contains('thread-ancestor')) return 0;
      for (let i = 4; i >= 1; i--) {
        if (card.classList.contains(`thread-depth-${i}`)) return i;
      }
      return 0;
    };

    const parentDepth = getCardDepth(parentCard);
    const newDepth = Math.min(parentDepth + 1, 4);

    // Find insertion point: after parent and all its deeper descendants
    let insertAfter = parentCard;
    let sibling = parentCard.nextElementSibling;
    while (sibling && sibling.classList.contains('post-card')) {
      if (!sibling.classList.contains('thread-descendant')) break;
      const sibDepth = getCardDepth(sibling);
      if (sibDepth <= parentDepth) break; // Left the parent's subtree
      insertAfter = sibling;
      sibling = sibling.nextElementSibling;
    }

    const el = renderPost(post);
    el.classList.add('thread-post', 'thread-descendant', `thread-depth-${newDepth}`, 'new-post');

    const scrollTop = content.scrollTop;
    insertAfter.insertAdjacentElement('afterend', el);

    // Keep scroll stable if user has scrolled up from the bottom
    if (scrollTop > 0) {
      content.scrollTop = scrollTop + el.offsetHeight + 8;
    }

    setTimeout(() => el.classList.remove('new-post'), 400);
    this.enrichLinkCards(content);
  },

  _onStreamNotification({ account, notif }) {
    notif.accountId = account.id;
    notif.accountSoftware = account.software || account.platform;
    notif.instanceUrl = account.instanceUrl;
    notif.themeColor = this._accountColor(account);

    // Cache the attached post
    if (notif.post) {
      notif.post.accountId = account.id;
      notif.post.accountPlatform = account.platform;
      notif.post.accountSoftware = account.software || account.platform;
      this.cachePosts([notif.post]);
    }

    // Update the post card in timeline columns (reaction/fav/boost counts)
    if (notif.post && ['reaction', 'favourite', 'reblog', 'renote', 'reply'].includes(notif.type)) {
      this._updatePostFromNotification(notif);
    }

    const columns = this.columnsContainer.querySelectorAll('.column');
    for (const col of columns) {
      if (col.dataset.columnType !== 'notifications') continue;
      const content = col.querySelector('.column-content');
      if (!content) continue;

      // Skip if account is hidden
      if (account.hidden) continue;

      // Duplicate check
      if (content.querySelector(`.notif-card[data-platform="${CSS.escape(notif.platform)}"][data-notif-id="${CSS.escape(notif.id)}"]`)) continue;

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

  /**
   * Update post cards in timeline columns when a reaction/fav/boost notification arrives.
   * Uses canonicalUri to find the post across platforms (e.g. Misskey reaction → Mastodon card).
   */
  _updatePostFromNotification(notif) {
    const notifDisplay = notif.post.reblog || notif.post;
    const uri = notifDisplay.canonicalUri;
    if (!uri) return;

    let updated = false;

    // Find and update all cached posts matching this canonicalUri
    for (const [, cached] of this.postCache) {
      const dp = cached.reblog || cached;
      if (dp.canonicalUri !== uri) continue;

      if (notif.type === 'reaction' && notifDisplay.reactions) {
        // Misskey: notification includes full updated reactions map
        dp.reactions = notifDisplay.reactions;
        dp.reactionEmojis = { ...(dp.reactionEmojis || {}), ...(notifDisplay.reactionEmojis || {}) };
        dp.emojis = { ...(dp.emojis || {}), ...(notifDisplay.emojis || {}) };
        if (notifDisplay.myReaction) dp.myReaction = notifDisplay.myReaction;
        this._adjustFavouritesForReactions(dp);
      } else if (notif.type === 'favourite') {
        dp.stats.favourites = Math.max(dp.stats.favourites, notifDisplay.stats?.favourites || 0);
      } else if (notif.type === 'reblog' || notif.type === 'renote') {
        dp.stats.boosts = Math.max(dp.stats.boosts, notifDisplay.stats?.boosts || 0);
      } else if (notif.type === 'reply') {
        dp.stats.replies = Math.max(dp.stats.replies, notifDisplay.stats?.replies || 0);
      }

      updated = true;
    }

    if (!updated) return;

    // Re-render matching cards in timeline and thread columns (not notifications)
    for (const col of this.columnsContainer.querySelectorAll('.column')) {
      if (col.dataset.columnType === 'notifications') continue;
      const content = col.querySelector('.column-content');
      if (!content) continue;

      const cards = content.querySelectorAll(`.post-card[data-canonical-uri="${CSS.escape(uri)}"]`);
      for (const card of cards) {
        if (!card.isConnected) continue;
        const cardPost = this.postCache.get(`${card.dataset.platform}:${card.dataset.postId}`);
        if (cardPost) {
          const newEl = renderPost(cardPost);
          // Preserve thread styling classes for thread columns
          if (col.dataset.columnType === 'thread') {
            for (const cls of card.classList) {
              if (cls.startsWith('thread-')) newEl.classList.add(cls);
            }
          }
          card.replaceWith(newEl);
        }
      }
    }
  },

  _onStreamPostUpdate({ account, post }) {
    // Post was edited — update cache and re-render in all columns
    post.accountId = account.id;
    post.accountPlatform = account.platform;
    post.accountSoftware = account.software || account.platform;
    post.themeColor = this._accountColor(account);
    const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
    post.isOwn = String(ownerId) === String(account.profile?.id);

    this.cachePosts([post]);

    const dp = post.reblog || post;
    const uri = dp.canonicalUri;

    for (const col of this.columnsContainer.querySelectorAll('.column')) {
      const content = col.querySelector('.column-content');
      if (!content) continue;

      const isThread = col.dataset.columnType === 'thread';

      // Match by platform:id
      const cards = content.querySelectorAll(`.post-card[data-platform="${CSS.escape(post.platform)}"][data-post-id="${CSS.escape(post.id)}"]`);
      for (const card of cards) {
        if (!card.isConnected) continue;
        const newEl = renderPost(post);
        if (isThread) {
          for (const cls of card.classList) {
            if (cls.startsWith('thread-')) newEl.classList.add(cls);
          }
        }
        card.replaceWith(newEl);
      }

      // Also match by canonicalUri (cross-account)
      if (uri) {
        const uriCards = content.querySelectorAll(`.post-card[data-canonical-uri="${CSS.escape(uri)}"]`);
        for (const card of uriCards) {
          if (!card.isConnected) continue;
          const cardPost = this.postCache.get(`${card.dataset.platform}:${card.dataset.postId}`);
          if (cardPost) {
            const cdp = cardPost.reblog || cardPost;
            cdp.content = dp.content;
            cdp.contentWarning = dp.contentWarning;
            cdp.media = dp.media;
            const newEl = renderPost(cardPost);
            if (isThread) {
              for (const cls of card.classList) {
                if (cls.startsWith('thread-')) newEl.classList.add(cls);
              }
            }
            card.replaceWith(newEl);
          }
        }
      }
    }
  },

  _onStreamPostDelete({ account, postId }) {
    // Remove deleted posts from all columns
    const cards = this.columnsContainer.querySelectorAll(`.post-card[data-platform="${CSS.escape(account.platform)}"][data-post-id="${CSS.escape(postId)}"]`);
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
