/**
 * Thread View Mixin
 * Handles loading and displaying conversation threads (ancestors + descendants)
 * with tree-structured replies and visual hierarchy.
 */
import { renderPost } from '../ui/dashboard.js';

export const ThreadViewMixin = {

  async openThreadView(postId, platform, accountId) {
    // Check if this is a merged post (visible from multiple accounts)
    const cachedPost = this.postCache.get(`${platform}:${postId}`);
    if (cachedPost?.mergedAccounts && cachedPost.mergedAccounts.length > 1) {
      return this._openMergedThreadView(postId, platform, cachedPost.mergedAccounts);
    }

    // If user has accounts on other platforms, use merged view to properly
    // separate favourites and reactions (e.g. Mastodon favs vs Misskey reactions)
    const allAccounts = this.store.getAll();
    if (allAccounts.length > 1) {
      const mergedAccounts = allAccounts.map(a => ({
        id: a.id,
        platform: a.platform,
        themeColor: a.themeColor || this._instanceColor(a.instanceUrl),
      }));
      return this._openMergedThreadView(postId, platform, mergedAccounts);
    }

    const client = this.store.getClient(accountId);
    const account = this.store.getById(accountId);
    if (!client || !account) return;

    const modal = document.getElementById('modal-thread');
    const content = document.getElementById('thread-content');
    content.innerHTML = '<div class="thread-loading"><div class="spinner"></div></div>';
    this.openModal(modal);

    try {
      let ancestors = [];
      let targetPost = null;
      let descendants = [];

      if (account.platform === 'mastodon') {
        const [status, context] = await Promise.all([
          client.getStatus(postId),
          client.getStatusContext(postId),
        ]);
        targetPost = status ? client.normalizePost(status) : null;
        ancestors = (context.ancestors || []).map(s => client.normalizePost(s));
        descendants = (context.descendants || []).map(s => client.normalizePost(s));
      } else {
        const [note, conversation, children] = await Promise.all([
          client.getNote(postId),
          client.getNoteConversation(postId, 30).catch(() => []),
          client.getNoteChildren(postId, 30).catch(() => []),
        ]);
        targetPost = note ? client.normalizePost(note) : null;
        ancestors = (conversation || []).map(n => client.normalizePost(n)).reverse();
        descendants = (children || []).map(n => client.normalizePost(n));
      }

      // Add account info to all posts
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
      if (targetPost) addMeta(targetPost);
      descendants.forEach(addMeta);

      // Cache all posts
      const allPosts = [...ancestors, ...(targetPost ? [targetPost] : []), ...descendants];
      this.cachePosts(allPosts);

      this._renderThread(content, ancestors, targetPost, descendants);
    } catch (err) {
      console.error('Thread load failed:', err);
      content.innerHTML = `<div class="thread-loading">스레드를 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
    }
  },

  async _openMergedThreadView(postId, platform, mergedAccounts) {
    const modal = document.getElementById('modal-thread');
    const content = document.getElementById('thread-content');
    content.innerHTML = '<div class="thread-loading"><div class="spinner"></div></div>';
    this.openModal(modal);

    const cachedPost = this.postCache.get(`${platform}:${postId}`);
    const canonicalUri = cachedPost ? (cachedPost.reblog || cachedPost).canonicalUri : null;

    try {
      let allAncestors = [];
      let targetPost = null;
      let allDescendants = [];

      // Fetch threads from all merged accounts in parallel
      const results = await Promise.allSettled(
        mergedAccounts.map(async (ma) => {
          const account = this.store.getById(ma.id);
          const client = this.store.getClient(ma.id);
          if (!client || !account) return null;

          let localPostId = postId;

          // For different platforms: resolve the post first
          if (account.platform !== platform) {
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

          const effectiveColor = ma.themeColor || account.themeColor || this._instanceColor(account.instanceUrl);
          const addMeta = (post) => {
            post.accountId = ma.id;
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
        })
      );

      // Merge results from all accounts
      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const { ancestors, target, descendants } = result.value;
        allAncestors.push(...ancestors);
        if (target) {
          if (!targetPost) {
            targetPost = target;
          } else {
            this._mergePostData(targetPost, target);
          }
        }
        allDescendants.push(...descendants);
      }

      // Deduplicate ancestors and descendants by canonical URI, merging data
      allAncestors = this._deduplicateThreadPosts(allAncestors);
      allDescendants = this._deduplicateThreadPosts(allDescendants);

      // Preserve mergedAccounts on target
      if (targetPost && cachedPost?.mergedAccounts) {
        targetPost.mergedAccounts = cachedPost.mergedAccounts;
      }

      // Cache all posts
      const allPosts = [...allAncestors, ...(targetPost ? [targetPost] : []), ...allDescendants];
      this.cachePosts(allPosts);

      this._renderThread(content, allAncestors, targetPost, allDescendants);
    } catch (err) {
      console.error('Merged thread load failed:', err);
      content.innerHTML = `<div class="thread-loading">스레드를 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
    }
  },

  _mergePostData(target, source) {
    const tDp = target.reblog || target;
    const sDp = source.reblog || source;

    // Merge reactions (Misskey reactions into Mastodon post)
    if (sDp.reactions && Object.keys(sDp.reactions).length > 0) {
      if (!tDp.reactions || Object.keys(tDp.reactions).length === 0) {
        // Target has no reactions: take source reactions directly
        tDp.reactions = { ...sDp.reactions };
        if (sDp._misskeyNoteId) tDp._misskeyNoteId = sDp._misskeyNoteId;
        if (sDp._misskeyAccountId) tDp._misskeyAccountId = sDp._misskeyAccountId;
        if (sDp.id && source.platform !== 'mastodon' && !tDp._misskeyNoteId) {
          tDp._misskeyNoteId = sDp.id;
          tDp._misskeyAccountId = source.accountId;
        }
      }
      // Don't spread-merge if target already has reactions (avoids key format duplication)
    }
    if (sDp.reactionEmojis) tDp.reactionEmojis = { ...(tDp.reactionEmojis || {}), ...sDp.reactionEmojis };
    if (sDp.emojis) tDp.emojis = { ...(tDp.emojis || {}), ...sDp.emojis };
    if (sDp.instanceUrl && !tDp.instanceUrl) tDp.instanceUrl = sDp.instanceUrl;

    // Merge stats (take max)
    if (sDp.stats) {
      tDp.stats = tDp.stats || {};
      tDp.stats.replies = Math.max(tDp.stats.replies || 0, sDp.stats.replies || 0);
      tDp.stats.reblogs = Math.max(tDp.stats.reblogs || 0, sDp.stats.reblogs || 0);
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
        // Merge into existing
        const idx = seen.get(key);
        this._mergePostData(result[idx], post);
      }
    }
    return result;
  },

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
    // Build lookup: postId → children
    const childrenMap = new Map();
    const postMap = new Map();

    for (const post of descendants) {
      postMap.set(String(post.id), post);
      const parentId = String(post.replyToId || targetPostId || '');
      if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
      childrenMap.get(parentId).push(post);
    }

    // Render tree recursively with depth tracking (no margin, use border color only)
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

    // Any orphaned descendants (replyToId doesn't match any known post or target)
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
