/**
 * Data Loading Mixin
 * Handles timeline loading, notifications, pagination, and caching
 */
import { escapeHtml } from '../ui/utils.js';
import { usableColor } from '../ui/dashboard.js';
import { renderPost, renderNotification, renderLoading, renderLoadingText } from '../ui/dashboard.js';

export const DataLoadingMixin = {

  async refreshAll(fullReload = false, { skipColumnTypes = [] } = {}) {
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
        const type = col.dataset.columnType;

        // Skip specified column types (e.g. 'all' after compose to avoid pre-federation duplicates)
        if (skipColumnTypes.includes(type)) continue;

        col.classList.add('refreshing');
        const refreshBtn = col.querySelector('[data-action="refresh-column"]');
        if (refreshBtn) refreshBtn.classList.add('spinning');

        const content = col.querySelector('.column-content');
        const accountId = col.dataset.accountId;

        let loadPromise;
        if (type === 'all') {
          loadPromise = this.loadTimelineForColumn(content, this.store.getVisible());
        } else if (type === 'notifications') {
          loadPromise = this.loadNotificationsForColumn(content, this.store.getVisible());
        } else if (type === 'account' && accountId) {
          const account = this.store.getById(accountId);
          if (account) {
            loadPromise = this.loadTimelineForColumn(content, [account]);
          }
        } else if (type === 'bookmarks') {
          loadPromise = this.loadBookmarksForColumn(content, this.store.getVisible());
        } else if (type === 'dm') {
          loadPromise = this.loadConversationsForColumn(content, this.store.getVisible());
        } else if (type === 'pages') {
          loadPromise = this.loadPagesFeedForColumn(content, this.store.getVisible());
        } else if (type === 'thread') {
          loadPromise = this.loadThreadForColumn(col);
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

    const isFirstLoad = container.querySelectorAll('.post-card').length === 0;

    if (isFirstLoad) {
      container.innerHTML = '';
      container.appendChild(renderLoading());
    }

    try {
      const allPosts = [];

      const results = await Promise.allSettled(
        accounts.map(account =>
          this._fetchAccountTimeline(account).catch(err => {
            console.error(`Timeline error for ${account.label}:`, err);
            return [];
          })
        )
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

      // Merge reaction data from cache (e.g. Misskey reactions into Mastodon-only column posts)
      this._mergeReactionsFromCache(allPosts);

      // Fetch missing reply parents
      await this.fetchMissingReplyParents(allPosts, accounts);

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
        // Re-query DOM for fresh snapshot (stream events may have added posts during the fetch)
        const existingCards = container.querySelectorAll('.post-card');
        // Build sets of platform:id keys, canonical URIs, and dedup keys for robust matching
        const existingKeys = new Set();
        // Map canonicalUri → DOM card element for account merging
        const uriToCard = new Map();
        for (const card of existingCards) {
          existingKeys.add(`${card.dataset.platform}:${card.dataset.postId}`);
          if (card.dataset.canonicalUri) {
            existingKeys.add(`uri:${card.dataset.canonicalUri}`);
            uriToCard.set(card.dataset.canonicalUri, card);
          }
          if (card.dataset.dedupKey) {
            existingKeys.add(`dedup:${card.dataset.dedupKey}`);
          }
        }

        // Phase 1: Update existing cards whose mergedAccounts have grown
        // (e.g. Mastodon post now also seen from Misskey account via federation)
        for (const p of allPosts) {
          if (!p.mergedAccounts || p.mergedAccounts.length <= 1) continue;
          const displayPost = p.reblog || p;
          const uri = displayPost.canonicalUri;
          if (!uri || !uriToCard.has(uri)) continue;
          const existingCard = uriToCard.get(uri);
          const cacheKey = `${existingCard.dataset.platform}:${existingCard.dataset.postId}`;
          const cachedPost = this.postCache?.get(cacheKey);
          if (!cachedPost) continue;
          const existingCount = cachedPost.mergedAccounts?.length || 1;
          if (p.mergedAccounts.length > existingCount) {
            cachedPost.mergedAccounts = p.mergedAccounts;
            const newCard = renderPost(cachedPost);
            existingCard.replaceWith(newCard);
            uriToCard.set(uri, newCard);
          }
        }

        // Phase 1.5: Update existing cards whose stats/reactions/state have changed
        // Stats-only changes get a targeted DOM patch so images don't reload.
        {
          const idToCard = new Map();
          for (const card of existingCards) {
            idToCard.set(`${card.dataset.platform}:${card.dataset.postId}`, card);
          }
          for (const p of allPosts) {
            const key = `${p.platform}:${p.id}`;
            const card = idToCard.get(key);
            if (!card) continue;
            const cached = this.postCache?.get(key);
            if (!cached) continue;
            const kind = this._postChangeKind(cached, p);
            if (kind === 'none') continue;
            if (kind === 'stats') {
              this._updateCardStats(card, p);
            } else {
              const newCard = renderPost(p);
              card.replaceWith(newCard);
              idToCard.set(key, newCard);
              const dp = p.reblog || p;
              if (dp.canonicalUri) uriToCard.set(dp.canonicalUri, newCard);
            }
          }
        }

        // Phase 2: Filter for truly new posts
        const newPosts = [];
        for (const p of allPosts) {
          // Check platform:id
          if (existingKeys.has(`${p.platform}:${p.id}`)) continue;
          // Check dedup key (handles cross-instance renotes/boosts)
          if (p._dedupKey && existingKeys.has(`dedup:${p._dedupKey}`)) continue;
          // For non-renote posts, also check canonicalUri to avoid duplicates
          if (!p.rebloggedBy) {
            const displayPost = p.reblog || p;
            if (displayPost.canonicalUri && existingKeys.has(`uri:${displayPost.canonicalUri}`)) continue;
          }
          newPosts.push(p);
        }

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

        // Cap DOM size to prevent memory exhaustion on long-running sessions
        this._pruneExcessPosts(container);
      }

      // Cache posts AFTER incremental merge so Phase 1 can compare against old cache
      this.cachePosts(allPosts);

      // Asynchronously fetch reaction details from Misskey for Mastodon posts
      // that only show favourites (fire-and-forget, cards re-render as results arrive)
      this._fetchMissingReactions(allPosts, container);
    } catch (err) {
      if (isFirstLoad) {
        container.innerHTML = `<div class="loading-text">타임라인을 불러오는 중 오류가 발생했습니다: ${escapeHtml(err.message)}</div>`;
      }
    }
  },

  async loadOlderPosts(container) {
    const pagination = this._columnPagination.get(container);
    if (!pagination || pagination.loading || !pagination.hasMore) return;

    // Stop loading more if DOM is already at the limit
    const max = this.MAX_DOM_POSTS || 500;
    if (container.querySelectorAll('.post-card').length >= max) {
      pagination.hasMore = false;
      return;
    }

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
        accounts.map(account => {
          const untilId = oldestIds.get(account.id);
          if (!untilId) return [];
          return this._fetchAccountTimeline(account, untilId).catch(err => {
            console.error(`Older posts error for ${account.label}:`, err);
            return [];
          });
        })
      );

      let rawApiCount = 0;
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          rawApiCount += result.value.length;
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
        if (card.dataset.dedupKey) existingKeys.add(`dedup:${card.dataset.dedupKey}`);
      }
      const newPosts = allPosts.filter(p => {
        if (existingKeys.has(`${p.platform}:${p.id}`)) return false;
        if (p._dedupKey && existingKeys.has(`dedup:${p._dedupKey}`)) return false;
        return true;
      });

      // Update oldest IDs for next pagination
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
          const posts = result.value;
          const last = posts[posts.length - 1];
          oldestIds.set(last.accountId, last.id);
        }
      }

      // Cache and fetch missing reply parents
      this.cachePosts(newPosts);
      await this.fetchMissingReplyParents(newPosts, accounts);

      if (rawApiCount === 0) {
        pagination.hasMore = false;
      }
      if (newPosts.length > 0) {
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

    // Concurrency guard - prevent overlapping notification fetches
    if (container._notifLoading) return;
    container._notifLoading = true;

    const existingCards = container.querySelectorAll('.notif-card');
    const isFirstLoad = existingCards.length === 0;

    if (isFirstLoad) {
      container.innerHTML = '';
      container.appendChild(renderLoading());
    }

    try {
      const allNotifs = [];
      const prevNewestIds = this._notifNewestIds?.get(container);

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];

          try {
            const sinceId = !isFirstLoad ? prevNewestIds?.get(account.id) || null : null;
            const notifs = await client.getNotifications(this.settings.postsCount, null, sinceId);
            const effectiveColor = this._accountColor(account);
            return notifs.map(n => {
              const notif = client.normalizeNotification(n);
              notif.themeColor = effectiveColor;
              notif.accountId = account.id;
              notif.accountSoftware = account.software || account.platform;
              notif.instanceUrl = account.instanceUrl;
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

      // Track newest notification IDs per account for since_id pagination
      if (!this._notifNewestIds) this._notifNewestIds = new WeakMap();
      const newestIds = this._notifNewestIds.get(container) || new Map();
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
          const notifs = result.value;
          const accountId = notifs[0].accountId;
          // Find max ID from response (don't assume first element is newest)
          let maxId = notifs[0].id;
          for (let i = 1; i < notifs.length; i++) {
            if (this._compareIds(notifs[i].id, maxId) > 0) maxId = notifs[i].id;
          }
          // Only advance sinceId forward, never backward
          const prev = newestIds.get(accountId);
          if (!prev || this._compareIds(maxId, prev) > 0) {
            newestIds.set(accountId, maxId);
          }
        }
      }
      this._notifNewestIds.set(container, newestIds);

      // Deduplicate by platform:id first (catch API-level duplicates / re-fetched notifications)
      {
        const seenIds = new Set();
        let write = 0;
        for (let read = 0; read < allNotifs.length; read++) {
          const key = `${allNotifs[read].platform}:${allNotifs[read].id}`;
          if (!seenIds.has(key)) {
            seenIds.add(key);
            allNotifs[write++] = allNotifs[read];
          }
        }
        allNotifs.length = write;
      }

      // Merge cached reaction data BEFORE semantic dedup so favourite→reaction
      // conversion produces correct dedup keys (prevents duplicates when both
      // a favourite and a native reaction notification exist for the same actor+post)
      {
        const preDedupPosts = allNotifs
          .filter(n => n.post?.id)
          .map(n => {
            n.post.accountId = n.accountId;
            n.post.accountPlatform = n.platform;
            n.post.accountSoftware = n.accountSoftware || n.platform;
            return n.post;
          });
        if (preDedupPosts.length > 0) this._mergeReactionsFromCache(preDedupPosts);
      }
      for (const n of allNotifs) {
        if (n.type !== 'favourite' || !n.post) continue;
        const dp = n.post.reblog || n.post;
        if (!dp.reactions) continue;
        // Skip reactions merged from Misskey cache — these are other users' reactions,
        // not this actor's action. Phase 2 handles per-user matching accurately.
        if (dp._reactionsFromCache) continue;
        const entries = Object.entries(dp.reactions);
        const nonHeart = entries.filter(([k]) => k !== '❤' && k !== '❤️');
        if (nonHeart.length === 0) continue;
        const [emoji] = nonHeart.sort((a, b) => b[1] - a[1])[0];
        n.type = 'reaction';
        n.label = '리액션';
        n.reactionEmoji = emoji;
        n.icon = emoji;
        const match = emoji.match(/^:(.+):$/);
        if (match) {
          const name = match[1];
          n.reactionEmojiUrl = dp.reactionEmojis?.[name] || dp.reactionEmojis?.[name + '@.']
                            || dp.emojis?.[name] || dp.emojis?.[name + '@.'] || null;
        }
      }

      // Compute normalized dedup keys for all notifications
      // (after favourite→reaction conversion so types are final)
      for (const notif of allNotifs) {
        const actorAcct = notif.actor?.acct
          ? this._normalizeAcct(notif.actor.acct, notif.instanceUrl)
          : (notif.actor?.id || '');
        const postKey = notif.post?.canonicalUri || notif.post?.id || '';
        const reactionKey = notif.reactionEmoji || '';
        notif._dedupKey = `${notif.type}:${actorAcct}:${postKey}:${reactionKey}`;
      }

      // Deduplicate notifications by semantic key (same actor + type + target post)
      {
        const deduped = this._deduplicateNotifications(allNotifs);
        allNotifs.length = 0;
        allNotifs.push(...deduped);
      }

      allNotifs.sort((a, b) => b.createdAt - a.createdAt);

      // Cache notification posts for reply functionality (include mergedAccounts for account filtering)
      // Mutate n.post directly so fetchMissingReplyParents updates propagate to notification rendering
      const notifPosts = allNotifs
        .filter(n => n.post?.id)
        .map(n => {
          n.post.accountId = n.accountId;
          n.post.accountPlatform = n.platform;
          n.post.accountSoftware = n.accountSoftware || n.platform;
          if (n.mergedAccounts) n.post.mergedAccounts = n.mergedAccounts;
          return n.post;
        });
      if (notifPosts.length > 0) this.cachePosts(notifPosts);

      // Fetch missing reply parents for notification posts
      await this.fetchMissingReplyParents(notifPosts, accounts);

      // Track oldest notification IDs per account for backward pagination
      if (!this._notifOldestIds) this._notifOldestIds = new WeakMap();
      const oldestIds = this._notifOldestIds.get(container) || new Map();
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
          const notifs = result.value;
          const accountId = notifs[0].accountId;
          let minId = notifs[0].id;
          for (let i = 1; i < notifs.length; i++) {
            if (this._compareIds(notifs[i].id, minId) < 0) minId = notifs[i].id;
          }
          // Only go backward on first load (don't override with newer oldest when polling)
          if (isFirstLoad || !oldestIds.has(accountId)) {
            oldestIds.set(accountId, minId);
          }
        }
      }
      this._notifOldestIds.set(container, oldestIds);

      // Store pagination metadata for infinite scroll
      if (!this._notifPagination) this._notifPagination = new WeakMap();
      this._notifPagination.set(container, {
        accounts,
        loading: false,
        hasMore: allNotifs.length > 0,
      });

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
        this.enrichLinkCards(container);
      } else {
        // Smooth incremental update: prepend new notifications (use dedup key)
        // Re-query DOM cards for freshness (existingCards was captured before async API calls)
        const currentCards = container.querySelectorAll('.notif-card');
        const existingKeys = new Set();
        const dedupToCard = new Map();
        for (const card of currentCards) {
          if (card.dataset.dedupKey) {
            existingKeys.add(card.dataset.dedupKey);
            dedupToCard.set(card.dataset.dedupKey, card);
          }
          existingKeys.add(`${card.dataset.platform}:${card.dataset.notifId}`);
        }

        // Update existing notification cards whose post stats/reactions changed
        for (const n of allNotifs) {
          if (!n._dedupKey || !dedupToCard.has(n._dedupKey)) continue;
          if (!n.post) continue;
          const card = dedupToCard.get(n._dedupKey);
          // Check if the notification's embedded post data changed
          const cachedKey = `${n.post.platform || n.platform}:${n.post.id}`;
          const cached = this.postCache?.get(cachedKey);
          if (!cached) continue;
          const kind = this._postChangeKind(cached, n.post);
          if (kind === 'none') continue;
          if (kind === 'stats') {
            this._updateCardStats(card, n.post);
          } else {
            const newCard = renderNotification(n);
            card.replaceWith(newCard);
            dedupToCard.set(n._dedupKey, newCard);
          }
        }

        const newNotifs = allNotifs.filter(n => {
          return !existingKeys.has(n._dedupKey) && !existingKeys.has(`${n.platform}:${n.id}`);
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

          this.enrichLinkCards(container);
        }
      }
      // Fetch missing reaction details from Misskey for notification posts
      // (also converts Mastodon favourite notifications to reactions when applicable)
      this._fetchMissingReactions(allNotifs, container, { isNotification: true });
    } catch (err) {
      if (isFirstLoad) {
        container.innerHTML = `<div class="loading-text">알림을 불러오는 중 오류가 발생했습니다: ${escapeHtml(err.message)}</div>`;
      }
    } finally {
      container._notifLoading = false;
    }
  },

  _addPostMeta(post, account) {
    post.accountId = account.id;
    post.accountPlatform = account.platform;
    post.accountSoftware = account.software || account.platform;
    post.themeColor = this._accountColor(account);
    const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
    post.isOwn = String(ownerId) === String(account.profile?.id);
    return post;
  },

  async _fetchAccountTimeline(account, untilId = null) {
    const client = this.store.getClient(account.id);
    if (!client) return [];

    // For Mastodon: also fetch own statuses to ensure own posts/boosts appear
    // (home timeline may not include own reblogs on some instances)
    if (account.platform === 'mastodon' && account.profile?.id) {
      const [homeItems, ownItems] = await Promise.all([
        client.getHomeTimeline(this.settings.postsCount, untilId),
        client.getUserStatuses(account.profile.id, 15, untilId).catch(() => []),
      ]);
      const seenIds = new Set();
      const merged = [];
      for (const item of homeItems) {
        seenIds.add(item.id);
        merged.push(item);
      }
      for (const item of ownItems) {
        if (!seenIds.has(item.id)) {
          merged.push(item);
        }
      }
      return merged.map(item => this._addPostMeta(client.normalizePost(item), account));
    }

    const items = await client.getHomeTimeline(this.settings.postsCount, untilId);
    return items.map(item => this._addPostMeta(client.normalizePost(item), account));
  },

  _normalizeAcct(acct, instanceUrl) {
    if (!acct || acct.includes('@')) return acct || '';
    try { return `${acct}@${new URL(instanceUrl).hostname}`; } catch { return acct; }
  },

  // Get the effective accent color for an account (themeColor → platform default)
  _accountColor(account) {
    return usableColor(account.themeColor, account.software || account.platform);
  },

  // Generate a deterministic color from instance hostname when themeColor is unavailable
  _instanceColor(instanceUrl) {
    try {
      const hostname = new URL(instanceUrl).hostname;
      let hash = 0;
      for (let i = 0; i < hostname.length; i++) {
        hash = ((hash << 5) - hash) + hostname.charCodeAt(i);
        hash |= 0;
      }
      const hue = Math.abs(hash) % 360;
      // HSL → hex (s=55%, l=55%)
      const s = 0.55, l = 0.55;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
      const m = l - c / 2;
      let r, g, b;
      if (hue < 60) { r = c; g = x; b = 0; }
      else if (hue < 120) { r = x; g = c; b = 0; }
      else if (hue < 180) { r = 0; g = c; b = x; }
      else if (hue < 240) { r = 0; g = x; b = c; }
      else if (hue < 300) { r = x; g = 0; b = c; }
      else { r = c; g = 0; b = x; }
      const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    } catch { return null; }
  },

  _deduplicatePosts(posts) {
    const seen = new Map();
    const deduped = [];
    for (const post of posts) {
      const displayPost = post.reblog || post;
      const baseKey = displayPost.canonicalUri || `${displayPost.platform}:${displayPost.id}`;
      let key;
      if (post.rebloggedBy) {
        const acct = this._normalizeAcct(post.rebloggedBy.acct, post.instanceUrl);
        key = `reblog:${acct}:${baseKey}`;
      } else {
        key = baseKey;
      }
      post._dedupKey = key;
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
        // Cache post IDs for cross-instance lookup (avoids ap/show and search API calls)
        const srcDisplay = post.reblog || post;
        const dstDisplay = existing.reblog || existing;
        if (srcDisplay.id && (post.accountPlatform || post.platform) !== 'mastodon') {
          dstDisplay._misskeyNoteId = dstDisplay._misskeyNoteId || srcDisplay.id;
          dstDisplay._misskeyAccountId = dstDisplay._misskeyAccountId || post.accountId;
          if (srcDisplay.instanceUrl) dstDisplay._reactionInstanceUrl = dstDisplay._reactionInstanceUrl || srcDisplay.instanceUrl;
        }
        // Per-instance ID cache: all platforms (Mastodon, Misskey, Iceshrimp, Hollo, etc.)
        if (srcDisplay.id && srcDisplay.instanceUrl) {
          if (!dstDisplay._noteIdsByInstance) dstDisplay._noteIdsByInstance = {};
          dstDisplay._noteIdsByInstance[srcDisplay.instanceUrl] = srcDisplay.id;
        }
        // Merge Misskey reaction data into the primary post
        if (srcDisplay.reactions && Object.keys(srcDisplay.reactions).length > 0 &&
            (!dstDisplay.reactions || Object.keys(dstDisplay.reactions).length === 0)) {
          dstDisplay.reactions = srcDisplay.reactions;
          dstDisplay.reactionEmojis = srcDisplay.reactionEmojis || dstDisplay.reactionEmojis;
          dstDisplay.emojis = srcDisplay.emojis || dstDisplay.emojis;
          this._adjustFavouritesForReactions(dstDisplay);
        }
        if (srcDisplay.myReaction && !dstDisplay.myReaction) {
          dstDisplay.myReaction = srcDisplay.myReaction;
        }
      }
    }
    return deduped;
  },

  // Mastodon counts all Misskey reactions (including custom emoji) as favourites.
  // After merging reaction data, subtract the reaction total from favourites
  // so that custom emoji reactions don't also appear as hearts.
  // Cached resolveUrl to avoid redundant ap/show API calls (5-min TTL)
  async _cachedResolveUrl(client, uri) {
    if (!this._resolveCache) this._resolveCache = new Map();
    const cached = this._resolveCache.get(uri);
    if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.result;
    const result = await client.resolveUrl(uri);
    this._resolveCache.set(uri, { result, time: Date.now() });
    // Evict oldest entries when cache exceeds limit
    if (this._resolveCache.size > 150) {
      const now = Date.now();
      for (const [k, v] of this._resolveCache) {
        if (now - v.time > 5 * 60 * 1000) this._resolveCache.delete(k);
      }
      // If still over limit after TTL eviction, remove oldest
      if (this._resolveCache.size > 150) {
        const toDelete = this._resolveCache.size - 150;
        const keys = this._resolveCache.keys();
        for (let i = 0; i < toDelete; i++) this._resolveCache.delete(keys.next().value);
      }
    }
    return result;
  },

  _adjustFavouritesForReactions(dp) {
    if (!dp.reactions || !dp.stats || !dp.stats.favourites) return;
    // Only subtract non-heart reactions: ❤ reactions are equivalent to favourites
    // and should remain in the favourite count. Custom emoji reactions are federated
    // as Likes by Misskey, so Mastodon double-counts them — subtract those only.
    const nonHeartReactions = Object.entries(dp.reactions)
      .filter(([k]) => k !== '❤' && k !== '❤️')
      .reduce((sum, [, c]) => sum + c, 0);
    dp.stats.favourites = Math.max(0, dp.stats.favourites - nonHeartReactions);
  },

  _mergeReactionsFromCache(posts) {
    if (!this.postCache || this.postCache.size === 0) return;
    // Build a canonicalUri → cached post index for fast lookup
    const uriToCache = new Map();
    for (const [, cached] of this.postCache) {
      const cdp = cached.reblog || cached;
      if (cdp.canonicalUri && cdp.reactions && Object.keys(cdp.reactions).length > 0) {
        uriToCache.set(cdp.canonicalUri, cdp);
      }
    }
    if (uriToCache.size === 0) return;

    for (const post of posts) {
      const dp = post.reblog || post;
      if (!dp.canonicalUri) continue;
      // Skip if post already has reaction data
      if (dp.reactions && Object.keys(dp.reactions).length > 0) continue;
      const cached = uriToCache.get(dp.canonicalUri);
      if (cached) {
        dp.reactions = cached.reactions;
        dp._reactionsFromCache = true;
        dp.reactionEmojis = cached.reactionEmojis || dp.reactionEmojis;
        dp.emojis = cached.emojis || dp.emojis;
        if (cached.myReaction && !dp.myReaction) dp.myReaction = cached.myReaction;
        if (cached._misskeyNoteId) dp._misskeyNoteId = cached._misskeyNoteId;
        if (cached._misskeyAccountId) dp._misskeyAccountId = cached._misskeyAccountId;
        if (cached._reactionInstanceUrl) dp._reactionInstanceUrl = cached._reactionInstanceUrl;
        if (cached._noteIdsByInstance) {
          dp._noteIdsByInstance = { ...(dp._noteIdsByInstance || {}), ...cached._noteIdsByInstance };
        }
        if (cached.id && cached.platform && cached.platform !== 'mastodon') {
          dp._misskeyNoteId = dp._misskeyNoteId || cached.id;
        }
        this._adjustFavouritesForReactions(dp);
      }
    }
  },

  // Asynchronously fetch reaction details from Misskey for Mastodon posts that have
  // favourites but no detailed reactions. Uses ap/show to look up the post on Misskey.
  // Fire-and-forget: cards are re-rendered in-place as results arrive.
  _fetchMissingReactions(items, container, { isNotification = false } = {}) {
    const misskeyAccount = this.store.getAll().find(a => a.platform !== 'mastodon');
    const client = misskeyAccount ? this.store.getClient(misskeyAccount.id) : null;

    const misskeyHost = (() => {
      if (!misskeyAccount) return '';
      try { return new URL(misskeyAccount.instanceUrl).hostname; } catch { return ''; }
    })();

    // --- Phase 1: Patch post-level reaction data (requires authenticated Misskey client) ---
    if (client) {
      const seenUris = new Set();
      const toFetch = [];
      for (const item of items) {
        const post = isNotification ? item.post : item;
        if (!post) continue;
        const dp = post.reblog || post;
        if (dp.reactions && Object.keys(dp.reactions).length > 0) continue;
        if (!dp.stats?.favourites || dp.stats.favourites <= 0) continue;
        if (!dp.canonicalUri) continue;
        if (seenUris.has(dp.canonicalUri)) continue;
        seenUris.add(dp.canonicalUri);
        toFetch.push({ item, post, dp });
      }

      // Sequential processing to avoid Misskey rate limits
      // Prioritize posts with cached note IDs (notes/show has high rate limit)
      // Limit ap/show calls (strict rate limit) to avoid blocking user-initiated actions
      (async () => {
        let apShowCount = 0;
        const AP_SHOW_LIMIT = 3;
        for (const { item, post, dp } of toFetch.slice(0, 10)) {
          try {
            // Use notes/show (high rate limit) when note ID is cached, fallback to ap/show
            let resolved;
            const cachedNoteId = dp._misskeyNoteId
              || (dp._noteIdsByInstance && dp._noteIdsByInstance[misskeyAccount.instanceUrl]);
            if (cachedNoteId) {
              const rawNote = await client.getNote(cachedNoteId);
              if (rawNote) resolved = client.normalizePost(rawNote);
            } else if (apShowCount < AP_SHOW_LIMIT) {
              resolved = await this._cachedResolveUrl(client, dp.canonicalUri);
              apShowCount++;
            } else {
              continue; // Skip to preserve rate limit for user actions
            }
            if (!resolved) continue;
            const rdp = resolved.reblog || resolved;
            if (!rdp.reactions || Object.keys(rdp.reactions).length === 0) continue;
            dp.reactions = rdp.reactions;
            dp.reactionEmojis = rdp.reactionEmojis || dp.reactionEmojis;
            dp.emojis = rdp.emojis || dp.emojis;
            if (rdp.instanceUrl) {
              dp.instanceUrl = dp.instanceUrl || rdp.instanceUrl;
              dp._reactionInstanceUrl = rdp.instanceUrl;
            }
            if (rdp.myReaction && !dp.myReaction) dp.myReaction = rdp.myReaction;
            dp._misskeyNoteId = rdp.id;
            dp._misskeyAccountId = misskeyAccount.id;
            if (misskeyAccount.instanceUrl) {
              if (!dp._noteIdsByInstance) dp._noteIdsByInstance = {};
              dp._noteIdsByInstance[misskeyAccount.instanceUrl] = rdp.id;
            }
            this._adjustFavouritesForReactions(dp);
            this.postCache.set(`${post.platform}:${post.id}`, post);

            if (isNotification) {
              for (const notif of items) {
                if (!notif.post || (notif.post.reblog || notif.post).canonicalUri !== dp.canonicalUri) continue;
                const cards = container.querySelectorAll(`.notif-card[data-notif-id="${notif.id}"]`);
                for (const card of cards) {
                  if (card.isConnected) card.replaceWith(renderNotification(notif));
                }
              }
            } else {
              const cards = container.querySelectorAll(`.post-card[data-post-id="${post.id}"][data-platform="${post.platform}"]`);
              for (const card of cards) {
                if (card.isConnected) card.replaceWith(renderPost(item));
              }
            }
          } catch { /* skip failed resolution */ }
        }
      })();
    }

    // --- Phase 2: Convert Mastodon favourite notifications to reactions ---
    if (!isNotification) return;

    const favNotifs = items.filter(n =>
      n.type === 'favourite' && n.platform === 'mastodon' && n.post
    );
    if (favNotifs.length === 0) return;

    // Group by canonical URI (deduplicated)
    const favByUri = new Map();
    for (const notif of favNotifs) {
      const dp = notif.post.reblog || notif.post;
      const uri = dp.canonicalUri;
      if (!uri) continue;
      if (!favByUri.has(uri)) favByUri.set(uri, []);
      favByUri.get(uri).push(notif);
    }

    // Shared helper: apply resolved reaction data to notification group
    const applyReactions = (groupNotifs, reactionByUser, reactionEmojis, emojiBaseUrl) => {
      let changed = false;
      for (const notif of groupNotifs) {
        const actorAcct = notif.actor?.acct
          ? this._normalizeAcct(notif.actor.acct, notif.instanceUrl).toLowerCase()
          : null;
        if (!actorAcct) continue;

        // Exact match only — use per-user reaction data from notes/reactions.
        // No aggregate fallback: if the actor isn't in reactionByUser, they
        // likely just pressed favourite on Mastodon (recorded as ❤ on Misskey).
        const emoji = reactionByUser.get(actorAcct);
        if (!emoji) continue;
        // Default-favourite reactions are federated Mastodon favourites — don't
        // convert. Misskey instances vary on what their default favourite is:
        // newer ones use ❤, but misskey.io and many older deployments record
        // it as ⭐. Treating both as "this was just a Like activity" keeps
        // those notifications looking like proper Mastodon favourites instead
        // of mass-appearing as star reactions.
        if (emoji === '❤' || emoji === '❤️' || emoji === '⭐' || emoji === '⭐️') continue;

        notif.type = 'reaction';
        notif.label = '리액션';
        notif.reactionEmoji = emoji;
        notif.icon = emoji;

        const customMatch = emoji.match(/^:(.+):$/);
        if (customMatch) {
          const name = customMatch[1];
          const url = reactionEmojis[name] || reactionEmojis[name + '@.'] || null;
          if (url) {
            notif.reactionEmojiUrl = url;
          } else {
            const baseName = name.replace(/@\.$/, '');
            notif.reactionEmojiUrl = `${emojiBaseUrl}/emoji/${encodeURIComponent(baseName)}.webp`;
          }
        }

        const actorKey = notif.actor?.acct || notif.actor?.id || '';
        const postKey = notif.post?.canonicalUri || notif.post?.id || '';
        notif._dedupKey = `reaction:${actorKey}:${postKey}:${emoji}`;
        changed = true;
      }
      return changed;
    };

    const rerenderGroup = (groupNotifs) => {
      for (const notif of groupNotifs) {
        if (notif.type !== 'reaction') continue;
        const cards = container.querySelectorAll(`.notif-card[data-notif-id="${notif.id}"]`);
        for (const card of cards) {
          if (!card.isConnected) continue;
          // After async conversion, check if a native reaction card with same dedupKey already exists
          if (notif._dedupKey) {
            const dupCard = container.querySelector(`.notif-card[data-dedup-key="${CSS.escape(notif._dedupKey)}"]`);
            if (dupCard && dupCard !== card && dupCard.isConnected) {
              card.remove();
              continue;
            }
          }
          card.replaceWith(renderNotification(notif));
        }
      }
    };

    if (client) {
      // --- Authenticated approach using Misskey account (sequential to avoid rate limits) ---
      (async () => {
        for (const [uri, groupNotifs] of [...favByUri.entries()].slice(0, 10)) {
          try {
            let resolved;
            try {
              resolved = await this._cachedResolveUrl(client, uri);
            } catch (e) {
              console.warn('[StarShip] fav→reaction: resolveUrl failed for', uri, e.message || e);
              continue;
            }
            if (!resolved) continue;
            const rdp = resolved.reblog || resolved;
            if (!rdp.id) continue;

            const reactionByUser = new Map();
            try {
              const userReactions = await client.getReactions(rdp.id) || [];
              for (const r of userReactions) {
                if (!r.user) continue;
                const host = r.user.host || misskeyHost;
                const acct = `${r.user.username}@${host}`.toLowerCase();
                reactionByUser.set(acct, r.type);
              }
            } catch (e) {
              console.warn('[StarShip] fav→reaction: getReactions failed for note', rdp.id, e.message || e);
            }

            const reactionEmojis = rdp.reactionEmojis || rdp.emojis || {};
            if (reactionByUser.size === 0) continue;

            const changed = applyReactions(groupNotifs, reactionByUser, reactionEmojis, misskeyAccount.instanceUrl);
            if (changed) rerenderGroup(groupNotifs);
          } catch (e) {
            console.warn('[StarShip] fav→reaction error:', e);
          }
        }
      })();
    } else {
      // --- Unauthenticated approach via actor's Misskey instance (sequential to avoid rate limits) ---
      (async () => {
        for (const [uri, groupNotifs] of [...favByUri.entries()].slice(0, 10)) {
          try {
            // Find an actor whose instance is Misskey-compatible
            let actorInstanceUrl = null;
            for (const notif of groupNotifs) {
              const acct = notif.actor?.acct;
              if (!acct || !acct.includes('@')) continue;
              const host = acct.split('@').pop();
              const instanceUrl = `https://${host}`;
              const isMisskey = await this._detectMisskeyInstance(instanceUrl);
              if (isMisskey) {
                actorInstanceUrl = instanceUrl;
                break;
              }
            }
            if (!actorInstanceUrl) continue;

            // Step 1: Resolve the post URI via unauthenticated ap/show
            let noteId;
            try {
              const resolved = await this._unauthMisskeyRequest(actorInstanceUrl, 'ap/show', { uri });
              if (!resolved || resolved.type !== 'Note' || !resolved.object) continue;
              noteId = resolved.object.id;
            } catch (e) {
              console.warn('[StarShip] unauth fav→reaction: ap/show failed for', uri, e.message || e);
              continue;
            }

            // Step 2: Get per-user reactions (unauthenticated)
            const reactionByUser = new Map();
            let reactionEmojis = {};
            try {
              const reactions = await this._unauthMisskeyRequest(actorInstanceUrl, 'notes/reactions', { noteId, limit: 20 });
              if (!Array.isArray(reactions) || reactions.length === 0) continue;
              const actorHost = new URL(actorInstanceUrl).hostname;
              for (const r of reactions) {
                if (!r.user) continue;
                const host = r.user.host || actorHost;
                const acct = `${r.user.username}@${host}`.toLowerCase();
                reactionByUser.set(acct, r.type);
              }
            } catch (e) {
              console.warn('[StarShip] unauth fav→reaction: notes/reactions failed for', noteId, e.message || e);
              continue;
            }

            // Step 3: Get note details for emoji URLs
            try {
              const note = await this._unauthMisskeyRequest(actorInstanceUrl, 'notes/show', { noteId });
              if (note) {
                reactionEmojis = note.reactionEmojis || {};
              }
            } catch { /* proceed with per-user data only */ }

            if (reactionByUser.size === 0) continue;

            const changed = applyReactions(groupNotifs, reactionByUser, reactionEmojis, actorInstanceUrl);
            if (changed) rerenderGroup(groupNotifs);
          } catch (e) {
            console.warn('[StarShip] unauth fav→reaction error:', e);
          }
        }
      })();
    }
  },

  // Detect whether a remote instance is Misskey-compatible (cached, unauthenticated)
  async _detectMisskeyInstance(instanceUrl) {
    if (!this._misskeyInstanceCache) this._misskeyInstanceCache = new Map();
    if (this._misskeyInstanceCache.has(instanceUrl)) return this._misskeyInstanceCache.get(instanceUrl);

    try {
      const result = await this._unauthMisskeyRequest(instanceUrl, 'meta', {});
      const isMisskey = !!(result && (result.version || result.softwareName));
      this._misskeyInstanceCache.set(instanceUrl, isMisskey);
    } catch {
      this._misskeyInstanceCache.set(instanceUrl, false);
    }
    // Evict oldest entries when cache exceeds limit
    if (this._misskeyInstanceCache.size > 100) {
      const toDelete = this._misskeyInstanceCache.size - 100;
      const keys = this._misskeyInstanceCache.keys();
      for (let i = 0; i < toDelete; i++) this._misskeyInstanceCache.delete(keys.next().value);
    }
    return this._misskeyInstanceCache.get(instanceUrl);
  },

  // Make an unauthenticated POST request to a Misskey instance API (via proxy)
  async _unauthMisskeyRequest(instanceUrl, endpoint, body) {
    const targetUrl = `${instanceUrl}/api/${endpoint}`;
    const useProxy = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
    const fetchUrl = useProxy
      ? `/proxy?url=${encodeURIComponent(targetUrl)}`
      : targetUrl;

    const res = await fetch(fetchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Misskey unauthenticated API error ${res.status}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  },

  // Compare two ID strings numerically-safe: length-first, then lexicographic.
  // Works for Mastodon (numeric strings of varying length) and Misskey (fixed-length aidx).
  // Returns negative if a < b, positive if a > b, 0 if equal.
  _compareIds(a, b) {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  },

  _deduplicateNotifications(notifs) {
    const seen = new Map();
    const deduped = [];
    for (const notif of notifs) {
      const actorAcct = notif.actor?.acct ? this._normalizeAcct(notif.actor.acct, notif.instanceUrl) : (notif.actor?.id || '');
      const postKey = notif.post?.canonicalUri || notif.post?.id || '';
      const reactionKey = notif.reactionEmoji || '';
      const key = `${notif.type}:${actorAcct}:${postKey}:${reactionKey}`;
      notif._dedupKey = key;
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

  async loadOlderNotifications(container) {
    const pagination = this._notifPagination?.get(container);
    if (!pagination || pagination.loading || !pagination.hasMore) return;

    const oldestIds = this._notifOldestIds?.get(container);
    if (!oldestIds || oldestIds.size === 0) return;

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
      const { accounts } = pagination;
      const allNotifs = [];

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];
          const maxId = oldestIds.get(account.id);
          if (!maxId) return [];

          try {
            const notifs = await client.getNotifications(this.settings.postsCount, maxId, null);
            const effectiveColor = this._accountColor(account);
            return notifs.map(n => {
              const notif = client.normalizeNotification(n);
              notif.themeColor = effectiveColor;
              notif.accountId = account.id;
              notif.accountSoftware = account.software || account.platform;
              notif.instanceUrl = account.instanceUrl;
              return notif;
            });
          } catch (err) {
            console.error(`Older notifications error for ${account.label}:`, err);
            return [];
          }
        })
      );

      let rawApiCount = 0;
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          rawApiCount += result.value.length;
          allNotifs.push(...result.value);
        }
      }

      // Deduplicate by platform:id
      {
        const seenIds = new Set();
        let write = 0;
        for (let read = 0; read < allNotifs.length; read++) {
          const key = `${allNotifs[read].platform}:${allNotifs[read].id}`;
          if (!seenIds.has(key)) {
            seenIds.add(key);
            allNotifs[write++] = allNotifs[read];
          }
        }
        allNotifs.length = write;
      }

      // Merge cached reaction data BEFORE semantic dedup (same as loadNotificationsForColumn)
      {
        const preDedupPosts = allNotifs
          .filter(n => n.post?.id)
          .map(n => {
            n.post.accountId = n.accountId;
            n.post.accountPlatform = n.platform;
            n.post.accountSoftware = n.accountSoftware || n.platform;
            return n.post;
          });
        if (preDedupPosts.length > 0) this._mergeReactionsFromCache(preDedupPosts);
      }
      for (const n of allNotifs) {
        if (n.type !== 'favourite' || !n.post) continue;
        const dp = n.post.reblog || n.post;
        if (!dp.reactions) continue;
        // Skip reactions merged from Misskey cache — these are other users' reactions,
        // not this actor's action. Phase 2 handles per-user matching accurately.
        if (dp._reactionsFromCache) continue;
        const entries = Object.entries(dp.reactions);
        const nonHeart = entries.filter(([k]) => k !== '❤' && k !== '❤️');
        if (nonHeart.length === 0) continue;
        const [emoji] = nonHeart.sort((a, b) => b[1] - a[1])[0];
        n.type = 'reaction';
        n.label = '리액션';
        n.reactionEmoji = emoji;
        n.icon = emoji;
        const match = emoji.match(/^:(.+):$/);
        if (match) {
          const name = match[1];
          n.reactionEmojiUrl = dp.reactionEmojis?.[name] || dp.reactionEmojis?.[name + '@.']
                            || dp.emojis?.[name] || dp.emojis?.[name + '@.'] || null;
        }
      }

      // Compute dedup keys (after favourite→reaction conversion so types are final)
      for (const notif of allNotifs) {
        const actorAcct = notif.actor?.acct
          ? this._normalizeAcct(notif.actor.acct, notif.instanceUrl)
          : (notif.actor?.id || '');
        const postKey = notif.post?.canonicalUri || notif.post?.id || '';
        const reactionKey = notif.reactionEmoji || '';
        notif._dedupKey = `${notif.type}:${actorAcct}:${postKey}:${reactionKey}`;
      }

      // Semantic deduplication
      {
        const deduped = this._deduplicateNotifications(allNotifs);
        allNotifs.length = 0;
        allNotifs.push(...deduped);
      }

      allNotifs.sort((a, b) => b.createdAt - a.createdAt);

      // Filter out already-displayed notifications
      const existingKeys = new Set();
      for (const card of container.querySelectorAll('.notif-card')) {
        if (card.dataset.dedupKey) existingKeys.add(card.dataset.dedupKey);
        existingKeys.add(`${card.dataset.platform}:${card.dataset.notifId}`);
      }
      const newNotifs = allNotifs.filter(n => {
        return !existingKeys.has(n._dedupKey) && !existingKeys.has(`${n.platform}:${n.id}`);
      });

      // Update oldest IDs for next pagination
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
          const notifs = result.value;
          const accountId = notifs[0].accountId;
          let minId = notifs[0].id;
          for (let i = 1; i < notifs.length; i++) {
            if (this._compareIds(notifs[i].id, minId) < 0) minId = notifs[i].id;
          }
          oldestIds.set(accountId, minId);
        }
      }

      // Cache and fetch missing parents
      // Mutate n.post directly so fetchMissingReplyParents updates propagate to notification rendering
      const notifPosts = newNotifs
        .filter(n => n.post?.id)
        .map(n => {
          n.post.accountId = n.accountId;
          n.post.accountPlatform = n.platform;
          n.post.accountSoftware = n.accountSoftware || n.platform;
          if (n.mergedAccounts) n.post.mergedAccounts = n.mergedAccounts;
          return n.post;
        });
      if (notifPosts.length > 0) {
        this.cachePosts(notifPosts);
        await this.fetchMissingReplyParents(notifPosts, accounts);
      }

      // Only stop pagination when the API itself returned nothing.
      // If API returned results but they were all dedup'd away, the cursor
      // has still advanced and the next page may have unique items.
      if (rawApiCount === 0) {
        pagination.hasMore = false;
      }
      if (newNotifs.length > 0) {
        for (const notif of newNotifs) {
          container.appendChild(renderNotification(notif));
        }
        this.enrichLinkCards(container);
        // Convert Mastodon favourite notifications to Misskey reactions
        this._fetchMissingReactions(newNotifs, container, { isNotification: true });
      }
    } catch (err) {
      console.error('Failed to load older notifications:', err);
    } finally {
      pagination.loading = false;
      const spinner = container.querySelector('.load-more-spinner');
      if (spinner) spinner.remove();
    }
  },

  async loadBookmarksForColumn(container, accounts) {
    if (accounts.length === 0) {
      container.innerHTML = '<div class="loading-text">북마크를 표시할 계정이 없습니다.</div>';
      return;
    }

    const isFirstLoad = container.querySelectorAll('.post-card').length === 0;
    if (isFirstLoad) {
      container.innerHTML = '';
      container.appendChild(renderLoading());
    }

    try {
      const allPosts = [];
      const failedAccounts = [];
      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];
          try {
            let items;
            if (account.platform === 'mastodon') {
              items = await client.getBookmarks(30);
            } else {
              const favs = await client.getBookmarks(30);
              items = favs.map(f => f.note || f);
            }
            return items.map(item => this._addPostMeta(client.normalizePost(item), account));
          } catch (err) {
            console.error(`Bookmarks error for ${account.label}:`, err);
            failedAccounts.push(account.label || account.profile?.displayName || account.id);
            return [];
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allPosts.push(...result.value);
        }
      }

      allPosts.sort((a, b) => b.createdAt - a.createdAt);

      if (accounts.length > 1) {
        const deduped = this._deduplicatePosts(allPosts);
        allPosts.length = 0;
        allPosts.push(...deduped);
      }

      this.cachePosts(allPosts);

      container.innerHTML = '';

      if (failedAccounts.length > 0) {
        const warn = document.createElement('div');
        warn.className = 'column-permission-warn';
        warn.textContent = `권한 부족: ${failedAccounts.join(', ')}`;
        container.appendChild(warn);
      }

      if (allPosts.length === 0 && failedAccounts.length === 0) {
        container.appendChild(renderLoadingText('북마크가 없습니다.'));
        return;
      }

      for (const post of allPosts) {
        post.bookmarked = true;
        container.appendChild(renderPost(post));
      }
      this.enrichLinkCards(container);
    } catch (err) {
      container.innerHTML = `<div class="loading-text">북마크 로딩 오류: ${escapeHtml(err.message)}</div>`;
    }
  },

  async loadConversationsForColumn(container, accounts) {
    if (accounts.length === 0) {
      container.innerHTML = '<div class="loading-text">DM을 표시할 계정이 없습니다.</div>';
      return;
    }

    const isFirstLoad = container.querySelectorAll('.dm-card, .post-card').length === 0;
    if (isFirstLoad) {
      container.innerHTML = '';
      container.appendChild(renderLoading());
    }

    try {
      const allConversations = [];
      const failedAccounts = [];
      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const client = this.store.getClient(account.id);
          if (!client) return [];
          try {
            if (account.platform === 'mastodon') {
              const convos = await client.getConversations(20);
              return convos.map(conv => {
                const lastStatus = conv.last_status;
                if (!lastStatus) return null;
                const post = client.normalizePost(lastStatus);
                post.accountId = account.id;
                post.accountPlatform = account.platform;
                post.themeColor = this._accountColor(account);
                post._conversationId = conv.id;
                post._conversationAccounts = conv.accounts || [];
                return post;
              }).filter(Boolean);
            }
            // Misskey: fetch DMs via notes/mentions with specified visibility
            if (client.getDirectNotes) {
              const notes = await client.getDirectNotes(20);
              return notes.map(n => {
                const post = client.normalizePost(n);
                post.accountId = account.id;
                post.accountPlatform = account.platform;
                post.themeColor = this._accountColor(account);
                return post;
              });
            }
            return [];
          } catch (err) {
            console.error(`Conversations error for ${account.label}:`, err);
            failedAccounts.push(account.label || account.profile?.displayName || account.id);
            return [];
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allConversations.push(...result.value);
        }
      }

      allConversations.sort((a, b) => b.createdAt - a.createdAt);
      this.cachePosts(allConversations);

      container.innerHTML = '';

      if (failedAccounts.length > 0) {
        const warn = document.createElement('div');
        warn.className = 'column-permission-warn';
        warn.textContent = `권한 부족: ${failedAccounts.join(', ')}`;
        container.appendChild(warn);
      }

      if (allConversations.length === 0 && failedAccounts.length === 0) {
        container.appendChild(renderLoadingText('다이렉트 메시지가 없습니다.'));
        return;
      }

      for (const post of allConversations) {
        container.appendChild(renderPost(post));
      }
      this.enrichLinkCards(container);
    } catch (err) {
      container.innerHTML = `<div class="loading-text">DM 로딩 오류: ${escapeHtml(err.message)}</div>`;
    }
  },

  cachePosts(posts) {
    for (const post of posts) {
      const key = `${post.platform}:${post.id}`;
      // Preserve mergedAccounts from a previous multi-account dedup so that
      // a later single-account column load doesn't erase them from the cache
      const existing = this.postCache.get(key);
      if (existing?.mergedAccounts && existing.mergedAccounts.length > 1 &&
          (!post.mergedAccounts || post.mergedAccounts.length <= 1)) {
        post.mergedAccounts = existing.mergedAccounts;
      }
      // Preserve enriched data from existing cache when the new entry doesn't
      // include them (e.g. notification payloads may omit quotes, streaming
      // events lack cross-instance metadata set by _mergePostData)
      if (existing) {
        const edp = existing.reblog || existing;
        const ndp = post.reblog || post;
        if (edp.quotePost && !ndp.quotePost) ndp.quotePost = edp.quotePost;
        if (edp.replyTo && !ndp.replyTo) ndp.replyTo = edp.replyTo;
        // Preserve cross-instance metadata (set by _mergePostData / _refreshMergedPost)
        if (edp._misskeyNoteId && !ndp._misskeyNoteId) {
          ndp._misskeyNoteId = edp._misskeyNoteId;
          ndp._misskeyAccountId = edp._misskeyAccountId;
        }
        if (edp._reactionInstanceUrl && !ndp._reactionInstanceUrl) ndp._reactionInstanceUrl = edp._reactionInstanceUrl;
        if (edp._noteIdsByInstance && !ndp._noteIdsByInstance) ndp._noteIdsByInstance = edp._noteIdsByInstance;
      }
      this.postCache.set(key, post);
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

    // First pass: resolve parents from existing timeline data or cache (no API calls)
    for (const post of needsFetch) {
      const dp = post.reblog || post;
      const parentId = dp.replyToId;
      // Search in the same batch
      const found = posts.find(p => {
        const pdp = p.reblog || p;
        return pdp.id === parentId;
      });
      // Or search in the post cache
      const cached = found || (this.postCache && (() => {
        for (const [, p] of this.postCache) {
          const pdp = p.reblog || p;
          if (pdp.id === parentId) return p;
        }
        return null;
      })());
      if (cached) {
        const pdp = cached.reblog || cached;
        dp.replyTo = {
          id: pdp.id,
          content: pdp.content,
          author: pdp.author,
          contentWarning: pdp.contentWarning || null,
          media: pdp.media || null,
        };
      }
    }

    // Second pass: fetch remaining from API
    const stillNeedsFetch = needsFetch.filter(p => {
      const dp = p.reblog || p;
      return dp.replyToId && !dp.replyTo;
    });

    if (stillNeedsFetch.length === 0) return;

    // Fetch up to 30 parent posts concurrently
    const toFetch = stillNeedsFetch.slice(0, 30);

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
              media: normalized.media || null,
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
              media: normalized.media || null,
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

  /**
   * Compare cached post data with fresh API data to detect changes.
   * Returns true if the post should be re-rendered.
   */
  _postDataChanged(cached, fresh) {
    return this._postChangeKind(cached, fresh) !== 'none';
  },

  /**
   * Classify the change between cached and fresh post data.
   * Returns:
   *   'none'  — nothing visible changed
   *   'stats' — only counts/active flags differ; can be patched in place
   *   'full'  — content/reaction-keys differ; needs a full re-render
   *
   * Targeted updates (stats) avoid replacing the whole card, which would
   * otherwise tear down all <img> elements and cause visible flicker on every
   * auto-refresh tick.
   */
  _postChangeKind(cached, fresh) {
    const cd = cached.reblog || cached;
    const fd = fresh.reblog || fresh;

    // Content edited → full re-render
    if ((cd.content || '') !== (fd.content || '')) return 'full';
    if ((cd.contentWarning || '') !== (fd.contentWarning || '')) return 'full';

    // Reaction key set changed (badges add/remove) → full
    const cKeys = cd.reactions ? Object.keys(cd.reactions).sort().join('|') : '';
    const fKeys = fd.reactions ? Object.keys(fd.reactions).sort().join('|') : '';
    if (cKeys !== fKeys) return 'full';

    let changed = false;

    // Reaction counts only
    if (cd.reactions && fd.reactions) {
      for (const [k, v] of Object.entries(fd.reactions)) {
        if ((cd.reactions[k] || 0) !== v) { changed = true; break; }
      }
    }

    // Stats counts
    if (cd.stats && fd.stats) {
      if ((cd.stats.replies || 0) !== (fd.stats.replies || 0)) changed = true;
      if ((cd.stats.reblogs || 0) !== (fd.stats.reblogs || 0)) changed = true;
      if ((cd.stats.renotes || 0) !== (fd.stats.renotes || 0)) changed = true;
      if ((cd.stats.favourites || 0) !== (fd.stats.favourites || 0)) changed = true;
      if ((cd.stats.reactions || 0) !== (fd.stats.reactions || 0)) changed = true;
    }

    // Boolean states
    if (!!cached.favourited !== !!fresh.favourited) changed = true;
    if (!!cached.reblogged !== !!fresh.reblogged) changed = true;
    if (!!cached.boosted !== !!fresh.boosted) changed = true;
    if ((cd.myReaction || '') !== (fd.myReaction || '')) changed = true;

    return changed ? 'stats' : 'none';
  },

  /**
   * Patch a card's stats/active flags in place — no DOM teardown, no image
   * reload.
   */
  _updateCardStats(card, fresh) {
    const fd = fresh.reblog || fresh;
    const actionsEl = card.querySelector('.post-actions');
    if (actionsEl) {
      const setActionCount = (selector, count, isActive) => {
        const btn = actionsEl.querySelector(selector);
        if (!btn) return;
        if (isActive !== undefined) btn.classList.toggle('active', !!isActive);
        let countEl = btn.querySelector('.action-count');
        const n = count || 0;
        if (n > 0) {
          if (!countEl) {
            countEl = document.createElement('span');
            countEl.className = 'action-count';
            btn.appendChild(countEl);
          }
          const next = String(n);
          if (countEl.textContent !== next) countEl.textContent = next;
        } else if (countEl) {
          countEl.remove();
        }
      };
      setActionCount('[data-action="reply"]', fd.stats?.replies);
      setActionCount('[data-action="boost"]', fd.stats?.reblogs ?? fd.stats?.renotes, fresh.reblogged || fresh.boosted);
      setActionCount('[data-action="fav"]', fd.stats?.favourites ?? fd.stats?.reactions, !!(fresh.favourited || fresh.myReaction));
    }
    // Patch existing reaction-badge counts (key set is identical when this is called)
    if (fd.reactions) {
      const reactionsEl = card.querySelector('.post-reactions');
      if (reactionsEl) {
        for (const badge of reactionsEl.querySelectorAll('.reaction-badge')) {
          const key = badge.dataset.reaction;
          if (!key) continue;
          const next = fd.reactions[key];
          if (next === undefined) continue;
          const countSpan = badge.querySelector('.reaction-count');
          if (countSpan) {
            const s = String(next);
            if (countSpan.textContent !== s) countSpan.textContent = s;
          }
        }
      }
    }
  },

  /**
   * Remove excess post-card elements from the bottom of a column to cap DOM size.
   * Only prunes posts that are well below the current scroll viewport.
   */
  _pruneExcessPosts(container) {
    const cards = container.querySelectorAll('.post-card');
    const max = this.MAX_DOM_POSTS || 500;
    if (cards.length <= max) return;

    const removeCount = cards.length - max;
    for (let i = cards.length - 1; i >= cards.length - removeCount; i--) {
      cards[i].remove();
    }
  },

};
