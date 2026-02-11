/**
 * Data Loading Mixin
 * Handles timeline loading, notifications, pagination, and caching
 */
import { renderPost, renderNotification, renderLoading, renderLoadingText } from '../ui/dashboard.js';

export const DataLoadingMixin = {

  async refreshAll(fullReload = false) {
    // Visual feedback on the top refresh button
    this.btnRefreshAll.classList.add('refreshing');
    this.btnRefreshAll.disabled = true;

    try {
      // Full reload: re-fetch all account profiles first
      if (fullReload) {
        await this.store.refreshAllProfiles();
        // Re-render toggle bar with updated names/avatars
        this.renderToggleBar();
      }

      // Refresh all visible columns with individual animations
      const columns = this.columnsContainer.querySelectorAll('.column');
      const promises = [];
      for (const col of columns) {
        col.classList.add('refreshing');
        const refreshBtn = col.querySelector('[data-action="refresh-column"]');
        if (refreshBtn) refreshBtn.classList.add('spinning');

        const content = col.querySelector('.column-content');
        const type = col.dataset.columnType;
        const accountId = col.dataset.accountId;

        let loadPromise;
        if (type === 'all') {
          loadPromise = this.loadTimelineForColumn(content, this.store.getAll());
        } else if (type === 'notifications') {
          loadPromise = this.loadNotificationsForColumn(content, this.store.getAll());
        } else if (type === 'account' && accountId) {
          const account = this.store.getById(accountId);
          if (account) {
            loadPromise = this.loadTimelineForColumn(content, [account]);
          }
        }

        if (loadPromise) {
          promises.push(loadPromise.finally(() => {
            if (refreshBtn) refreshBtn.classList.remove('spinning');
            col.classList.remove('refreshing');
            col.classList.add('refresh-done');
            setTimeout(() => col.classList.remove('refresh-done'), 600);
          }));
        }
      }
      await Promise.all(promises);
    } finally {
      this.btnRefreshAll.classList.remove('refreshing');
      this.btnRefreshAll.disabled = false;
    }
  },

  async loadTimelineForColumn(container, accounts) {
    if (accounts.length === 0) {
      container.innerHTML = '<div class="loading-text">표시할 타임라인이 없습니다.</div>';
      return;
    }

    const existingCards = container.querySelectorAll('.post-card');
    const isFirstLoad = existingCards.length === 0;

    if (isFirstLoad) {
      container.innerHTML = '';
      container.appendChild(renderLoading());
    }

    try {
      const allPosts = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];

          try {
            const items = await client.getHomeTimeline(this.settings.postsCount);
            return items.map(item => {
              const post = client.normalizePost(item);
              post.accountId = account.id;
              post.accountPlatform = account.platform;
              post.themeColor = account.themeColor || null;
              const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
              post.isOwn = String(ownerId) === String(account.profile.id);
              return post;
            });
          } catch (err) {
            console.error(`Timeline error for ${account.label}:`, err);
            return [];
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allPosts.push(...result.value);
        }
      }

      // Sort by time descending, with stable tiebreaker by accountId then post id
      allPosts.sort((a, b) => {
        const timeDiff = b.createdAt - a.createdAt;
        if (timeDiff !== 0) return timeDiff;
        // Stable tiebreaker: sort by accountId so dedup always picks the same winner
        if (a.accountId < b.accountId) return -1;
        if (a.accountId > b.accountId) return 1;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });

      // Deduplicate posts by canonical URI (same post seen from different accounts)
      if (accounts.length > 1) {
        const deduped = this._deduplicatePosts(allPosts);
        allPosts.length = 0;
        allPosts.push(...deduped);
      }

      // Fetch missing reply parents
      await this.fetchMissingReplyParents(allPosts, accounts);

      // Cache posts
      this.cachePosts(allPosts);

      // Track oldest post IDs per account for pagination
      const oldestIds = new Map();
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
          const posts = result.value;
          const last = posts[posts.length - 1];
          oldestIds.set(last.accountId, last.id);
        }
      }
      this._columnPagination.set(container, {
        oldestIds,
        accounts,
        loading: false,
        hasMore: allPosts.length > 0,
      });

      if (allPosts.length === 0) {
        if (isFirstLoad) {
          container.innerHTML = '';
          container.appendChild(renderLoadingText('타임라인에 표시할 게시물이 없습니다.'));
        }
        return;
      }

      if (isFirstLoad) {
        // Full render on first load
        container.innerHTML = '';
        for (const post of allPosts) {
          container.appendChild(renderPost(post));
        }
        this.enrichLinkCards(container);
      } else {
        // Smooth incremental update: prepend new posts with animation
        // Build a set of both platform:id keys AND canonical URIs for robust matching
        const existingKeys = new Set();
        for (const card of existingCards) {
          existingKeys.add(`${card.dataset.platform}:${card.dataset.postId}`);
          if (card.dataset.canonicalUri) {
            existingKeys.add(`uri:${card.dataset.canonicalUri}`);
          }
        }

        const newPosts = allPosts.filter(p => {
          // Check platform:id
          if (existingKeys.has(`${p.platform}:${p.id}`)) return false;
          // For non-renote posts, also check canonicalUri to avoid duplicates
          if (!p.rebloggedBy) {
            const displayPost = p.reblog || p;
            if (displayPost.canonicalUri && existingKeys.has(`uri:${displayPost.canonicalUri}`)) return false;
          }
          return true;
        });

        if (newPosts.length > 0) {
          const scrollTop = container.scrollTop;
          const fragment = document.createDocumentFragment();

          for (const post of newPosts) {
            const el = renderPost(post);
            el.classList.add('new-post');
            fragment.appendChild(el);
          }

          container.insertBefore(fragment, container.firstChild);

          // Keep scroll position stable if user was scrolled down
          if (scrollTop > 0) {
            let addedHeight = 0;
            const newCards = container.querySelectorAll('.post-card.new-post');
            for (const card of newCards) {
              addedHeight += card.offsetHeight + 8;
            }
            container.scrollTop = scrollTop + addedHeight;
          }

          // Remove animation class after animation completes
          setTimeout(() => {
            container.querySelectorAll('.new-post').forEach(el => el.classList.remove('new-post'));
          }, 400);

          this.enrichLinkCards(container);
        }
      }
    } catch (err) {
      if (isFirstLoad) {
        container.innerHTML = `<div class="loading-text">타임라인을 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
      }
    }
  },

  async loadOlderPosts(container) {
    const pagination = this._columnPagination.get(container);
    if (!pagination || pagination.loading || !pagination.hasMore) return;

    pagination.loading = true;

    // Show loading indicator at bottom
    let loadingEl = container.querySelector('.load-more-spinner');
    if (!loadingEl) {
      loadingEl = document.createElement('div');
      loadingEl.className = 'load-more-spinner';
      loadingEl.innerHTML = '<div class="spinner"></div>';
      container.appendChild(loadingEl);
    }

    try {
      const { accounts, oldestIds } = pagination;
      const allPosts = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];
          const untilId = oldestIds.get(account.id);
          if (!untilId) return [];

          try {
            const items = await client.getHomeTimeline(this.settings.postsCount, untilId);
            return items.map(item => {
              const post = client.normalizePost(item);
              post.accountId = account.id;
              post.accountPlatform = account.platform;
              post.themeColor = account.themeColor || null;
              const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
              post.isOwn = String(ownerId) === String(account.profile.id);
              return post;
            });
          } catch (err) {
            console.error(`Older posts error for ${account.label}:`, err);
            return [];
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allPosts.push(...result.value);
        }
      }

      // Sort by time descending
      allPosts.sort((a, b) => b.createdAt - a.createdAt);

      // Deduplicate among fetched posts (multi-account)
      if (accounts.length > 1) {
        const deduped = this._deduplicatePosts(allPosts);
        allPosts.length = 0;
        allPosts.push(...deduped);
      }

      // Filter out posts already in the DOM
      const existingKeys = new Set();
      for (const card of container.querySelectorAll('.post-card')) {
        existingKeys.add(`${card.dataset.platform}:${card.dataset.postId}`);
      }
      const newPosts = allPosts.filter(p => !existingKeys.has(`${p.platform}:${p.id}`));

      // Update oldest IDs for next pagination
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
          const posts = result.value;
          const last = posts[posts.length - 1];
          oldestIds.set(last.accountId, last.id);
        }
      }

      // Cache and append
      this.cachePosts(newPosts);

      if (newPosts.length === 0) {
        pagination.hasMore = false;
      } else {
        for (const post of newPosts) {
          container.appendChild(renderPost(post));
        }
        this.enrichLinkCards(container);
      }
    } catch (err) {
      console.error('Failed to load older posts:', err);
    } finally {
      pagination.loading = false;
      const spinner = container.querySelector('.load-more-spinner');
      if (spinner) spinner.remove();
    }
  },

  async loadNotificationsForColumn(container, accounts) {
    if (accounts.length === 0) {
      container.innerHTML = '<div class="loading-text">표시할 알림이 없습니다.</div>';
      return;
    }

    const existingCards = container.querySelectorAll('.notif-card');
    const isFirstLoad = existingCards.length === 0;

    if (isFirstLoad) {
      container.innerHTML = '';
      container.appendChild(renderLoading());
    }

    try {
      const allNotifs = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];

          try {
            const notifs = await client.getNotifications(this.settings.postsCount);
            return notifs.map(n => {
              const notif = client.normalizeNotification(n);
              notif.themeColor = account.themeColor || null;
              notif.accountId = account.id;
              return notif;
            });
          } catch (err) {
            console.error(`Notifications error for ${account.label}:`, err);
            return [];
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allNotifs.push(...result.value);
        }
      }

      // Deduplicate notifications across accounts (same actor + type + target post)
      if (accounts.length > 1) {
        const deduped = this._deduplicateNotifications(allNotifs);
        allNotifs.length = 0;
        allNotifs.push(...deduped);
      }

      allNotifs.sort((a, b) => b.createdAt - a.createdAt);

      // Cache notification posts for reply functionality
      const notifPosts = allNotifs
        .filter(n => n.post?.id)
        .map(n => ({ ...n.post, accountId: n.accountId, accountPlatform: n.platform }));
      if (notifPosts.length > 0) this.cachePosts(notifPosts);

      if (allNotifs.length === 0) {
        if (isFirstLoad) {
          container.innerHTML = '';
          container.appendChild(renderLoadingText('새 알림이 없습니다.'));
        }
        return;
      }

      if (isFirstLoad) {
        container.innerHTML = '';
        for (const notif of allNotifs) {
          container.appendChild(renderNotification(notif));
        }
      } else {
        // Smooth incremental update: prepend new notifications (use dedup key)
        const existingKeys = new Set();
        for (const card of existingCards) {
          if (card.dataset.dedupKey) {
            existingKeys.add(card.dataset.dedupKey);
          } else {
            existingKeys.add(`${card.dataset.platform}:${card.dataset.notifId}`);
          }
        }

        const newNotifs = allNotifs.filter(n => {
          const actorKey = n.actor?.acct || n.actor?.id || '';
          const postKey = n.post?.canonicalUri || n.post?.id || '';
          const reactionKey = n.reactionEmoji || '';
          const dedupKey = `${n.type}:${actorKey}:${postKey}:${reactionKey}`;
          return !existingKeys.has(dedupKey) && !existingKeys.has(`${n.platform}:${n.id}`);
        });

        if (newNotifs.length > 0) {
          const scrollTop = container.scrollTop;
          const fragment = document.createDocumentFragment();

          for (const notif of newNotifs) {
            const el = renderNotification(notif);
            el.classList.add('new-post');
            fragment.appendChild(el);
          }

          container.insertBefore(fragment, container.firstChild);

          if (scrollTop > 0) {
            let addedHeight = 0;
            const newCards = container.querySelectorAll('.notif-card.new-post');
            for (const card of newCards) {
              addedHeight += card.offsetHeight + 8;
            }
            container.scrollTop = scrollTop + addedHeight;
          }

          setTimeout(() => {
            container.querySelectorAll('.new-post').forEach(el => el.classList.remove('new-post'));
          }, 400);
        }
      }
    } catch (err) {
      if (isFirstLoad) {
        container.innerHTML = `<div class="loading-text">알림을 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
      }
    }
  },

  _deduplicatePosts(posts) {
    const seen = new Map();
    const deduped = [];
    for (const post of posts) {
      const displayPost = post.reblog || post;
      const baseKey = displayPost.canonicalUri || `${displayPost.platform}:${displayPost.id}`;
      const key = post.rebloggedBy ? `reblog:${post.rebloggedBy.acct}:${baseKey}` : baseKey;
      if (!seen.has(key)) {
        post.mergedAccounts = [{ id: post.accountId, platform: post.accountPlatform || post.platform, themeColor: post.themeColor }];
        seen.set(key, deduped.length);
        deduped.push(post);
      } else {
        const idx = seen.get(key);
        const existing = deduped[idx];
        if (existing.mergedAccounts && !existing.mergedAccounts.some(a => a.id === post.accountId)) {
          existing.mergedAccounts.push({ id: post.accountId, platform: post.accountPlatform || post.platform, themeColor: post.themeColor });
        }
      }
    }
    return deduped;
  },

  _deduplicateNotifications(notifs) {
    const seen = new Map();
    const deduped = [];
    for (const notif of notifs) {
      const actorKey = notif.actor?.acct || notif.actor?.id || '';
      const postKey = notif.post?.canonicalUri || notif.post?.id || '';
      const reactionKey = notif.reactionEmoji || '';
      const key = `${notif.type}:${actorKey}:${postKey}:${reactionKey}`;
      if (!seen.has(key)) {
        notif.mergedAccounts = [{ id: notif.accountId, platform: notif.platform, themeColor: notif.themeColor }];
        seen.set(key, deduped.length);
        deduped.push(notif);
      } else {
        const idx = seen.get(key);
        const existing = deduped[idx];
        if (existing.mergedAccounts && !existing.mergedAccounts.some(a => a.id === notif.accountId)) {
          existing.mergedAccounts.push({ id: notif.accountId, platform: notif.platform, themeColor: notif.themeColor });
        }
      }
    }
    return deduped;
  },

  cachePosts(posts) {
    for (const post of posts) {
      this.postCache.set(`${post.platform}:${post.id}`, post);
    }
    // Evict oldest entries if over limit
    if (this.postCache.size > this.POST_CACHE_MAX) {
      const toDelete = this.postCache.size - this.POST_CACHE_MAX;
      const keys = this.postCache.keys();
      for (let i = 0; i < toDelete; i++) {
        this.postCache.delete(keys.next().value);
      }
    }
  },

  async fetchMissingReplyParents(posts, accounts) {
    // Find posts that have replyToId but no replyTo content
    const needsFetch = posts.filter(p => {
      const dp = p.reblog || p;
      return dp.replyToId && !dp.replyTo;
    });

    if (needsFetch.length === 0) return;

    // Limit to 10 concurrent fetches
    const toFetch = needsFetch.slice(0, 10);

    await Promise.allSettled(toFetch.map(async (post) => {
      const dp = post.reblog || post;
      try {
        const client = this.store.getClient(post.accountId);
        if (!client) return;

        const account = this.store.getById(post.accountId);
        if (!account) return;

        if (account.platform === 'mastodon') {
          const parent = await client.getStatus(dp.replyToId);
          if (parent) {
            const normalized = client.normalizePost(parent);
            dp.replyTo = {
              id: normalized.id,
              content: normalized.content,
              author: normalized.author,
              contentWarning: normalized.contentWarning || null,
            };
          }
        } else {
          const parent = await client.getNote(dp.replyToId);
          if (parent) {
            const normalized = client.normalizePost(parent);
            dp.replyTo = {
              id: normalized.id,
              content: normalized.content,
              author: normalized.author,
              contentWarning: normalized.contentWarning || null,
            };
          }
        }
      } catch (err) {
        // Silently fail - we'll just show the fallback indicator
      }
    }));
  },

  findPostUrl(postId, platform) {
    const post = this.postCache.get(`${platform}:${postId}`);
    return post?.url || null;
  },

  findCachedPost(postId) {
    for (const [, post] of this.postCache) {
      const dp = post.reblog || post;
      if (post.id === postId || dp.id === postId) return post;
    }
    return null;
  },

};
