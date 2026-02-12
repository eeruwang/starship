/**
 * Thread View Mixin
 * Handles loading and displaying conversation threads (ancestors + descendants)
 * with tree-structured replies and visual hierarchy.
 *
 * Architecture:
 *   openThreadView (entry point)
 *     → _fetchThreadForAccount (per-account fetching)
 *     → _mergePostData / _deduplicateThreadPosts (cross-account merge)
 *     → _renderThread / _renderDescendantTree (rendering)
 *
 * All thread views fetch from ALL visible accounts for complete engagement
 * data (reactions, favourites, renotes). The merged-account border UI is
 * controlled via DOM manipulation after rendering — never by mutating post
 * data — so the post cache stays consistent across views.
 */
import { renderPost } from '../ui/dashboard.js';

export const ThreadViewMixin = {

  /**
   * Entry point for all thread views.
   * Always fetches from all visible accounts for complete data.
   * Merged-account borders are shown only in 'all' / 'notifications' columns.
   */
  async openThreadView(postId, platform, accountId, { columnType } = {}) {
    const showMergedUI = !columnType || columnType === 'all' || columnType === 'notifications';

    const modal = document.getElementById('modal-thread');
    const content = document.getElementById('thread-content');
    content.innerHTML = '<div class="thread-loading"><div class="spinner"></div></div>';
    this.openModal(modal);

    try {
      const cachedPost = this.postCache.get(`${platform}:${postId}`);
      const canonicalUri = cachedPost ? (cachedPost.reblog || cachedPost).canonicalUri : null;

      // Determine accounts to fetch from
      const visibleAccounts = this.store.getVisible();
      const accounts = visibleAccounts.map(a => ({
        id: a.id,
        platform: a.platform,
        themeColor: a.themeColor || this._instanceColor(a.instanceUrl),
      }));

      // Fetch thread data from all accounts in parallel
      let ancestors = [];
      let targetPost = null;
      let descendants = [];

      if (accounts.length <= 1) {
        // Single account: straightforward fetch
        const result = await this._fetchThreadForAccount(
          postId, platform, accountId, null
        );
        if (result) {
          ancestors = result.ancestors;
          targetPost = result.target;
          descendants = result.descendants;
        }
      } else {
        // Multi-account: fetch from all, merge and deduplicate
        const results = await Promise.allSettled(
          accounts.map(async (ma) => {
            // Only the clicked account can use the original postId directly;
            // other accounts (even same platform) may be on different instances
            const localPostId = (ma.id === accountId) ? postId : null;
            return this._fetchThreadForAccount(
              localPostId, platform, ma.id, canonicalUri
            );
          })
        );

        for (const result of results) {
          if (result.status !== 'fulfilled' || !result.value) continue;
          const r = result.value;
          ancestors.push(...r.ancestors);
          if (r.target) {
            if (!targetPost) {
              targetPost = r.target;
            } else {
              this._mergePostData(targetPost, r.target);
            }
          }
          descendants.push(...r.descendants);
        }

        ancestors = this._deduplicateThreadPosts(ancestors);
        descendants = this._deduplicateThreadPosts(descendants);

        // Preserve mergedAccounts from cache on target
        if (targetPost && cachedPost?.mergedAccounts) {
          targetPost.mergedAccounts = cachedPost.mergedAccounts;
        }
      }

      // Cache all posts (always with mergedAccounts intact for cache consistency)
      const allPosts = [...ancestors, ...(targetPost ? [targetPost] : []), ...descendants];
      this.cachePosts(allPosts);

      // Render
      this._renderThread(content, ancestors, targetPost, descendants);

      // Control merged-account border via DOM, not data mutation
      // This keeps the post cache clean and consistent across views
      if (!showMergedUI) {
        for (const el of content.querySelectorAll('.merged-border')) {
          el.classList.remove('merged-border');
          el.style.removeProperty('--merged-gradient');
        }
      }

      // Enrich posts with reaction data from Misskey (fire-and-forget)
      this._fetchMissingReactions(allPosts, content);
    } catch (err) {
      console.error('Thread load failed:', err);
      content.innerHTML = `<div class="thread-loading">스레드를 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
    }
  },

  /**
   * Fetch thread data for a single account.
   * @param {string|null} postId - Post ID on this account's platform (null if needs resolution)
   * @param {string} originalPlatform - Platform of the originally clicked post
   * @param {string} accountId - Account to fetch from
   * @param {string|null} canonicalUri - AP URI for cross-platform resolution
   * @returns {{ ancestors, target, descendants } | null}
   */
  async _fetchThreadForAccount(postId, originalPlatform, accountId, canonicalUri) {
    const account = this.store.getById(accountId);
    const client = this.store.getClient(accountId);
    if (!client || !account) return null;

    let localPostId = postId;

    // Cross-platform: resolve the post URI to get the local ID
    if (!localPostId) {
      if (!canonicalUri) return null;
      try {
        const resolved = await client.resolveUrl(canonicalUri);
        if (!resolved) return null;
        localPostId = resolved.id;
      } catch { return null; }
    }

    let ancestors = [], target = null, descendants = [];

    if (account.platform === 'mastodon') {
      const [status, ctx] = await Promise.all([
        client.getStatus(localPostId),
        client.getStatusContext(localPostId),
      ]);
      target = status ? client.normalizePost(status) : null;
      ancestors = (ctx.ancestors || []).map(s => client.normalizePost(s));
      descendants = (ctx.descendants || []).map(s => client.normalizePost(s));
    } else {
      const [note, conversation, children] = await Promise.all([
        client.getNote(localPostId),
        client.getNoteConversation(localPostId, 30).catch(() => []),
        client.getNoteChildren(localPostId, 30).catch(() => []),
      ]);
      target = note ? client.normalizePost(note) : null;
      ancestors = (conversation || []).map(n => client.normalizePost(n)).reverse();
      descendants = (children || []).map(n => client.normalizePost(n));
    }

    // Add account metadata to all posts
    const effectiveColor = account.themeColor || this._instanceColor(account.instanceUrl);
    const addMeta = (post) => {
      post.accountId = accountId;
      post.accountPlatform = account.platform;
      post.themeColor = effectiveColor;
      const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
      post.isOwn = String(ownerId) === String(account.profile.id);
      return post;
    };
    ancestors.forEach(addMeta);
    if (target) addMeta(target);
    descendants.forEach(addMeta);

    return { ancestors, target, descendants };
  },

  /**
   * Merge engagement data from source post into target post.
   * Takes the best data from each platform (reactions, stats, emoji URLs).
   */
  _mergePostData(target, source) {
    const tDp = target.reblog || target;
    const sDp = source.reblog || source;

    // Merge reactions (Misskey reactions into Mastodon post)
    if (sDp.reactions && Object.keys(sDp.reactions).length > 0) {
      if (!tDp.reactions || Object.keys(tDp.reactions).length === 0) {
        tDp.reactions = { ...sDp.reactions };
        if (sDp._misskeyNoteId) tDp._misskeyNoteId = sDp._misskeyNoteId;
        if (sDp._misskeyAccountId) tDp._misskeyAccountId = sDp._misskeyAccountId;
        if (sDp.id && source.platform !== 'mastodon' && !tDp._misskeyNoteId) {
          tDp._misskeyNoteId = sDp.id;
          tDp._misskeyAccountId = source.accountId;
        }
      }
    }
    if (sDp.reactionEmojis) tDp.reactionEmojis = { ...(tDp.reactionEmojis || {}), ...sDp.reactionEmojis };
    if (sDp.emojis) tDp.emojis = { ...(tDp.emojis || {}), ...sDp.emojis };
    if (sDp.instanceUrl && !tDp.instanceUrl) tDp.instanceUrl = sDp.instanceUrl;

    // Merge stats (take max)
    if (sDp.stats) {
      tDp.stats = tDp.stats || {};
      tDp.stats.replies = Math.max(tDp.stats.replies || 0, sDp.stats.replies || 0);
      tDp.stats.reblogs = Math.max(tDp.stats.reblogs || 0, sDp.stats.reblogs || 0);
      tDp.stats.renotes = Math.max(tDp.stats.renotes || 0, sDp.stats.renotes || 0);
      if (sDp.stats.favourites > 0) {
        tDp.stats.favourites = Math.max(tDp.stats.favourites || 0, sDp.stats.favourites);
      }
    }
    // Mastodon counts custom reactions as favourites — adjust to avoid double-counting
    if (tDp.reactions && Object.keys(tDp.reactions).length > 0 && tDp.stats && tDp.stats.favourites > 0) {
      const totalReactions = Object.values(tDp.reactions).reduce((sum, c) => sum + c, 0);
      tDp.stats.favourites = Math.max(0, tDp.stats.favourites - totalReactions);
    }

    // Merge fav/reaction state
    if (source.favourited) target.favourited = true;
    if (source.myReaction) target.myReaction = source.myReaction;

    // Merge mergedAccounts
    if (!target.mergedAccounts) {
      target.mergedAccounts = [{ id: target.accountId, platform: target.accountPlatform || target.platform, themeColor: target.themeColor }];
    }
    if (source.accountId && !target.mergedAccounts.some(a => a.id === source.accountId)) {
      target.mergedAccounts.push({ id: source.accountId, platform: source.accountPlatform || source.platform, themeColor: source.themeColor });
    }
  },

  /**
   * Deduplicate posts by canonical URI, merging data from duplicates.
   */
  _deduplicateThreadPosts(posts) {
    const seen = new Map();
    const result = [];
    for (const post of posts) {
      const dp = post.reblog || post;
      const key = dp.canonicalUri || `${dp.platform}:${dp.id}`;
      if (!seen.has(key)) {
        seen.set(key, result.length);
        result.push(post);
      } else {
        const idx = seen.get(key);
        this._mergePostData(result[idx], post);
      }
    }
    return result;
  },

  /**
   * Render the thread: ancestors → target → descendant tree.
   */
  _renderThread(content, ancestors, targetPost, descendants) {
    content.innerHTML = '';

    if (ancestors.length === 0 && !targetPost && descendants.length === 0) {
      content.innerHTML = '<div class="thread-loading">대화를 불러올 수 없습니다.</div>';
      return;
    }

    // Ancestors (linear chain)
    for (const post of ancestors) {
      const el = renderPost(post);
      el.classList.add('thread-post', 'thread-ancestor');
      content.appendChild(el);
    }

    // Target post (highlighted)
    if (targetPost) {
      const el = renderPost(targetPost);
      el.classList.add('thread-post', 'thread-target');
      content.appendChild(el);
    }

    // Descendants: build a reply tree and render with indentation
    if (descendants.length > 0) {
      this._renderDescendantTree(content, descendants, targetPost?.id);
    }

    // Enrich link cards with OG data
    this.enrichLinkCards(content);

    // Scroll to the target post
    requestAnimationFrame(() => {
      const target = content.querySelector('.thread-target');
      if (target) {
        target.scrollIntoView({ block: 'center' });
      }
    });
  },

  /**
   * Build a tree from descendants based on replyToId and render with indentation.
   */
  _renderDescendantTree(container, descendants, targetPostId) {
    const childrenMap = new Map();
    const postMap = new Map();

    for (const post of descendants) {
      postMap.set(String(post.id), post);
      const parentId = String(post.replyToId || targetPostId || '');
      if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
      childrenMap.get(parentId).push(post);
    }

    const maxDepth = 4;
    const renderNode = (postId, depth) => {
      const children = childrenMap.get(String(postId)) || [];
      for (const child of children) {
        const el = renderPost(child);
        el.classList.add('thread-post', 'thread-descendant');
        const level = Math.min(depth, maxDepth);
        el.classList.add(`thread-depth-${level}`);
        container.appendChild(el);
        renderNode(child.id, depth + 1);
      }
    };

    renderNode(targetPostId, 1);

    // Orphaned descendants (replyToId doesn't match any known post)
    const rendered = new Set();
    const collectRendered = (pid) => {
      const children = childrenMap.get(String(pid)) || [];
      for (const c of children) {
        rendered.add(String(c.id));
        collectRendered(c.id);
      }
    };
    collectRendered(targetPostId);

    for (const post of descendants) {
      if (!rendered.has(String(post.id))) {
        const el = renderPost(post);
        el.classList.add('thread-post', 'thread-descendant');
        container.appendChild(el);
      }
    }
  },

};
