/**
 * Data Loading Mixin
 * Handles timeline loading, notifications, pagination, and caching
 */
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
            const effectiveColor = account.themeColor || this._instanceColor(account.instanceUrl);
            const addMeta = (post) => {
              post.accountId = account.id;
              post.accountPlatform = account.platform;
              post.themeColor = effectiveColor;
              const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
              post.isOwn = String(ownerId) === String(account.profile.id);
              return post;
            };

            // For Mastodon: also fetch own statuses to ensure own posts/boosts appear
            // (home timeline may not include own reblogs on some instances)
            if (account.platform === 'mastodon' && account.profile?.id) {
              const [homeItems, ownItems] = await Promise.all([
                client.getHomeTimeline(this.settings.postsCount),
                client.getUserStatuses(account.profile.id, 15).catch(() => []),
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
              return merged.map(item => addMeta(client.normalizePost(item)));
            }

            const items = await client.getHomeTimeline(this.settings.postsCount);
            return items.map(item => addMeta(client.normalizePost(item)));
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
      }

      // Cache posts AFTER incremental merge so Phase 1 can compare against old cache
      this.cachePosts(allPosts);
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
            const effectiveColor = account.themeColor || this._instanceColor(account.instanceUrl);
            const addMeta = (post) => {
              post.accountId = account.id;
              post.accountPlatform = account.platform;
              post.themeColor = effectiveColor;
              const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
              post.isOwn = String(ownerId) === String(account.profile.id);
              return post;
            };

            // For Mastodon: also fetch own statuses to ensure own posts/boosts appear
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
              return merged.map(item => addMeta(client.normalizePost(item)));
            }

            const items = await client.getHomeTimeline(this.settings.postsCount, untilId);
            return items.map(item => addMeta(client.normalizePost(item)));
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
            const effectiveColor = account.themeColor || this._instanceColor(account.instanceUrl);
            return notifs.map(n => {
              const notif = client.normalizeNotification(n);
              notif.themeColor = effectiveColor;
              notif.accountId = account.id;
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
      if (!this._notifNewestIds) this._notifNewestIds = new Map();
      const newestIds = this._notifNewestIds.get(container) || new Map();
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
          const notifs = result.value;
          const accountId = notifs[0].accountId;
          // Find max ID from response (don't assume first element is newest)
          let maxId = notifs[0].id;
          for (let i = 1; i < notifs.length; i++) {
            if (notifs[i].id > maxId) maxId = notifs[i].id;
          }
          // Only advance sinceId forward, never backward
          const prev = newestIds.get(accountId);
          if (!prev || maxId > prev) {
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

      // Compute normalized dedup keys for all notifications
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
          if (n.mergedAccounts) n.post.mergedAccounts = n.mergedAccounts;
          return n.post;
        });
      if (notifPosts.length > 0) this.cachePosts(notifPosts);

      // Fetch missing reply parents for notification posts
      await this.fetchMissingReplyParents(notifPosts, accounts);

      // Track oldest notification IDs per account for backward pagination
      if (!this._notifOldestIds) this._notifOldestIds = new Map();
      const oldestIds = this._notifOldestIds.get(container) || new Map();
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
          const notifs = result.value;
          const accountId = notifs[0].accountId;
          let minId = notifs[0].id;
          for (let i = 1; i < notifs.length; i++) {
            if (notifs[i].id < minId) minId = notifs[i].id;
          }
          // Only go backward on first load (don't override with newer oldest when polling)
          if (isFirstLoad || !oldestIds.has(accountId)) {
            oldestIds.set(accountId, minId);
          }
        }
      }
      this._notifOldestIds.set(container, oldestIds);

      // Store pagination metadata for infinite scroll
      if (!this._notifPagination) this._notifPagination = new Map();
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
        for (const card of currentCards) {
          if (card.dataset.dedupKey) {
            existingKeys.add(card.dataset.dedupKey);
          }
          existingKeys.add(`${card.dataset.platform}:${card.dataset.notifId}`);
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
    } catch (err) {
      if (isFirstLoad) {
        container.innerHTML = `<div class="loading-text">알림을 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
      }
    } finally {
      container._notifLoading = false;
    }
  },

  _normalizeAcct(acct, instanceUrl) {
    if (!acct || acct.includes('@')) return acct || '';
    try { return `${acct}@${new URL(instanceUrl).hostname}`; } catch { return acct; }
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
        // Merge Misskey reaction data into the primary post
        const srcDisplay = post.reblog || post;
        const dstDisplay = existing.reblog || existing;
        if (srcDisplay.reactions && Object.keys(srcDisplay.reactions).length > 0 &&
            (!dstDisplay.reactions || Object.keys(dstDisplay.reactions).length === 0)) {
          dstDisplay.reactions = srcDisplay.reactions;
          dstDisplay.reactionEmojis = srcDisplay.reactionEmojis || dstDisplay.reactionEmojis;
          dstDisplay.emojis = srcDisplay.emojis || dstDisplay.emojis;
        }
        if (srcDisplay.myReaction && !dstDisplay.myReaction) {
          dstDisplay.myReaction = srcDisplay.myReaction;
        }
      }
    }
    return deduped;
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
            const effectiveColor = account.themeColor || this._instanceColor(account.instanceUrl);
            return notifs.map(n => {
              const notif = client.normalizeNotification(n);
              notif.themeColor = effectiveColor;
              notif.accountId = account.id;
              notif.instanceUrl = account.instanceUrl;
              return notif;
            });
          } catch (err) {
            console.error(`Older notifications error for ${account.label}:`, err);
            return [];
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
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

      // Compute dedup keys
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
            if (notifs[i].id < minId) minId = notifs[i].id;
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
          if (n.mergedAccounts) n.post.mergedAccounts = n.mergedAccounts;
          return n.post;
        });
      if (notifPosts.length > 0) {
        this.cachePosts(notifPosts);
        await this.fetchMissingReplyParents(notifPosts, accounts);
      }

      if (newNotifs.length === 0) {
        pagination.hasMore = false;
      } else {
        for (const notif of newNotifs) {
          container.appendChild(renderNotification(notif));
        }
        this.enrichLinkCards(container);
      }
    } catch (err) {
      console.error('Failed to load older notifications:', err);
    } finally {
      pagination.loading = false;
      const spinner = container.querySelector('.load-more-spinner');
      if (spinner) spinner.remove();
    }
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
