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
import { escapeHtml } from '../ui/utils.js';
import { renderPost } from '../ui/dashboard.js';

export const ThreadViewMixin = {

  /**
   * Entry point for all thread views.
   * Two-phase loading: renders from the clicked account immediately,
   * then merges data from other accounts in the background.
   */
  async openThreadView(postId, platform, accountId, { columnType } = {}) {
    const showMergedUI = !columnType || columnType === 'all' || columnType === 'notifications';

    const modal = document.getElementById('modal-thread');
    const content = document.getElementById('thread-content');
    content.innerHTML = '<div class="thread-loading"><div class="spinner"></div></div>';
    this.openModal(modal);

    // Store current thread info so the pin button can use it
    this._currentThread = { postId, platform, accountId };

    try {
      const cachedPost = this.postCache.get(`${platform}:${postId}`);
      const canonicalUri = cachedPost ? (cachedPost.reblog || cachedPost).canonicalUri : null;

      // Determine accounts to fetch from
      const visibleAccounts = this.store.getVisible();
      const accounts = visibleAccounts.map(a => ({
        id: a.id,
        platform: a.platform,
        themeColor: this._accountColor(a),
      }));

      // Phase 1: Fetch from clicked account (no URL resolution needed — fastest)
      const primaryResult = await this._fetchThreadForAccount(
        postId, platform, accountId, null
      );

      let ancestors = primaryResult?.ancestors || [];
      let targetPost = primaryResult?.target || null;
      let descendants = primaryResult?.descendants || [];

      // Render immediately with primary account data
      let allPosts = [...ancestors, ...(targetPost ? [targetPost] : []), ...descendants];
      this.cachePosts(allPosts);
      this._mergeReactionsFromCache(allPosts);
      this._renderThread(content, ancestors, targetPost, descendants);
      this._applyMergedBorderUI(content, showMergedUI, accounts, accountId);
      this._fetchMissingReactions(allPosts, content);

      // Phase 2: Fetch from other accounts in background and merge
      const otherAccounts = accounts.filter(a => a.id !== accountId);
      if (otherAccounts.length > 0 && canonicalUri) {
        this._mergeOtherAccountThreads(
          content, otherAccounts, canonicalUri, platform,
          ancestors, targetPost, descendants, cachedPost,
          showMergedUI, accounts, accountId
        );
      }
    } catch (err) {
      console.error('Thread load failed:', err);
      content.innerHTML = `<div class="thread-loading">스레드를 불러오는 중 오류가 발생했습니다: ${escapeHtml(err.message)}</div>`;
    }
  },

  /**
   * Background merge: fetch thread from other accounts and re-render with merged data.
   */
  async _mergeOtherAccountThreads(
    content, otherAccounts, canonicalUri, platform,
    ancestors, targetPost, descendants, cachedPost,
    showMergedUI, allAccounts, clickedAccountId
  ) {
    try {
      const results = await Promise.allSettled(
        otherAccounts.map(ma =>
          this._fetchThreadForAccount(null, platform, ma.id, canonicalUri)
        )
      );

      let hasNewData = false;
      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const r = result.value;
        hasNewData = true;
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

      if (!hasNewData) return;

      ancestors = this._deduplicateThreadPosts(ancestors);
      descendants = this._deduplicateThreadPosts(descendants);

      if (targetPost && cachedPost?.mergedAccounts) {
        targetPost.mergedAccounts = cachedPost.mergedAccounts;
      }

      const allPosts = [...ancestors, ...(targetPost ? [targetPost] : []), ...descendants];
      this.cachePosts(allPosts);
      this._mergeReactionsFromCache(allPosts);

      // Re-render with merged data (preserve scroll position)
      const scrollTop = content.scrollTop;
      this._renderThread(content, ancestors, targetPost, descendants);
      this._applyMergedBorderUI(content, showMergedUI, allAccounts, clickedAccountId);
      content.scrollTop = scrollTop;

      this._fetchMissingReactions(allPosts, content);
    } catch (err) {
      console.error('Background thread merge failed:', err);
    }
  },

  /**
   * Apply or remove merged-account border UI based on column context.
   */
  _applyMergedBorderUI(content, showMergedUI, accounts, clickedAccountId) {
    if (!showMergedUI) {
      const clickedAcct = accounts.find(a => a.id === clickedAccountId);
      const solidColor = clickedAcct?.themeColor || null;
      for (const el of content.querySelectorAll('.merged-border')) {
        el.classList.remove('merged-border');
        el.style.removeProperty('--merged-gradient');
        if (solidColor) el.style.borderLeftColor = solidColor;
      }
    }
  },

  /**
   * Pin the current thread as a column.
   * Called from the pin button in the thread modal header.
   */
  pinThreadAsColumn() {
    const info = this._currentThread;
    if (!info) return;

    const threadKey = `thread:${info.platform}:${info.postId}`;

    // Already pinned?
    if (this.columnState.threads?.[threadKey]) {
      this.showToast('이미 컬럼으로 추가된 스레드입니다', 'info');
      return;
    }

    // Save thread info to columnState
    if (!this.columnState.threads) this.columnState.threads = {};
    this.columnState.threads[threadKey] = {
      postId: info.postId,
      platform: info.platform,
      accountId: info.accountId,
    };
    this.updateColumnOrder(threadKey, true);
    this.saveColumnState();

    // Build column and insert
    const col = this.buildSingleColumn('thread', null, threadKey);
    if (col) {
      const refNode = this.getColumnInsertionPoint('thread', null, threadKey);
      this.columnsContainer.insertBefore(col, refNode);

      col.style.opacity = '0';
      col.style.transform = 'scale(0.95)';
      col.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      requestAnimationFrame(() => {
        col.style.opacity = '1';
        col.style.transform = 'scale(1)';
        setTimeout(() => { col.style.transition = ''; col.style.transform = ''; }, 350);
      });

      this.loadThreadForColumn(col);
    }

    // Update toggle bar and close the modal
    this.renderToggleBar();
    this.closeModal(document.getElementById('modal-thread'));
  },

  /**
   * Remove a pinned thread column.
   */
  unpinThreadColumn(threadKey) {
    if (this.columnState.threads) {
      delete this.columnState.threads[threadKey];
      // Clean up empty threads object
      if (Object.keys(this.columnState.threads).length === 0) {
        delete this.columnState.threads;
      }
    }
    this.updateColumnOrder(threadKey, false);
    this.saveColumnState();
    this.renderToggleBar();
    this.toggleColumnSmooth('thread', false, null, threadKey);
  },

  /**
   * Load thread data into a thread column.
   * Guarded against concurrent calls for the same column.
   */
  async loadThreadForColumn(col) {
    // Prevent overlapping loads for the same column
    if (col._threadLoading) return;
    col._threadLoading = true;

    const postId = col.dataset.threadPostId;
    const platform = col.dataset.threadPlatform;
    const accountId = col.dataset.threadAccountId;
    const content = col.querySelector('.column-content');
    if (!content) { col._threadLoading = false; return; }

    content.classList.add('thread-content');
    content.innerHTML = '<div class="thread-loading"><div class="spinner"></div></div>';

    try {
      // Fetch from the primary account
      const primaryResult = await this._fetchThreadForAccount(postId, platform, accountId, null);

      let ancestors = primaryResult?.ancestors || [];
      let targetPost = primaryResult?.target || null;
      let descendants = primaryResult?.descendants || [];

      // Update column title with author info
      const h2 = col.querySelector('.column-header h2');
      if (h2 && targetPost) {
        const author = targetPost.author;
        const name = escapeHtml(author.displayName || author.username);
        const avatarHtml = author.avatarUrl
          ? `<img class="column-header-avatar" src="${escapeHtml(author.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
          : '';
        h2.innerHTML = `${avatarHtml}${name}의 스레드`;
      }

      let allPosts = [...ancestors, ...(targetPost ? [targetPost] : []), ...descendants];
      this.cachePosts(allPosts);
      this._mergeReactionsFromCache(allPosts);
      this._renderThread(content, ancestors, targetPost, descendants);
      this._fetchMissingReactions(allPosts, content);

      // Phase 2: merge other accounts
      const cachedPost = this.postCache.get(`${platform}:${postId}`);
      const canonicalUri = cachedPost ? (cachedPost.reblog || cachedPost).canonicalUri : null;
      const visibleAccounts = this.store.getVisible();
      const otherAccounts = visibleAccounts
        .filter(a => a.id !== accountId)
        .map(a => ({ id: a.id, platform: a.platform, themeColor: this._accountColor(a) }));

      if (otherAccounts.length > 0 && canonicalUri) {
        await this._mergeOtherAccountThreads(
          content, otherAccounts, canonicalUri, platform,
          ancestors, targetPost, descendants, cachedPost,
          true, visibleAccounts.map(a => ({ id: a.id, platform: a.platform, themeColor: this._accountColor(a) })),
          accountId
        );
      }
    } catch (err) {
      console.error('Thread column load failed:', err);
      content.innerHTML = `<div class="thread-loading">스레드를 불러올 수 없습니다.</div>`;
    } finally {
      col._threadLoading = false;
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
        const resolved = await this._cachedResolveUrl(client, canonicalUri);
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
    const effectiveColor = this._accountColor(account);
    const addMeta = (post) => {
      post.accountId = accountId;
      post.accountPlatform = account.platform;
      post.accountSoftware = account.software || account.platform;
      post.themeColor = effectiveColor;
      const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
      post.isOwn = String(ownerId) === String(account.profile?.id);
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

    // Always cache Misskey note ID for cross-instance lookup (avoids ap/show for reactions)
    if (sDp._misskeyNoteId) {
      tDp._misskeyNoteId = tDp._misskeyNoteId || sDp._misskeyNoteId;
      tDp._misskeyAccountId = tDp._misskeyAccountId || sDp._misskeyAccountId;
    }
    if (sDp._reactionInstanceUrl) tDp._reactionInstanceUrl = tDp._reactionInstanceUrl || sDp._reactionInstanceUrl;
    if (sDp._noteIdsByInstance) {
      tDp._noteIdsByInstance = { ...(tDp._noteIdsByInstance || {}), ...sDp._noteIdsByInstance };
    }
    if (sDp.id && source.platform !== 'mastodon' && !tDp._misskeyNoteId) {
      tDp._misskeyNoteId = sDp.id;
      tDp._misskeyAccountId = source.accountId;
      if (sDp.instanceUrl) tDp._reactionInstanceUrl = tDp._reactionInstanceUrl || sDp.instanceUrl;
    }
    // Per-instance ID cache: all platforms
    if (sDp.id && sDp.instanceUrl) {
      if (!tDp._noteIdsByInstance) tDp._noteIdsByInstance = {};
      tDp._noteIdsByInstance[sDp.instanceUrl] = sDp.id;
    }
    // Merge reactions (Misskey reactions into Mastodon post)
    if (sDp.reactions && Object.keys(sDp.reactions).length > 0) {
      if (!tDp.reactions || Object.keys(tDp.reactions).length === 0) {
        tDp.reactions = { ...sDp.reactions };
      }
    }
    if (sDp.reactionEmojis) tDp.reactionEmojis = { ...(tDp.reactionEmojis || {}), ...sDp.reactionEmojis };
    if (sDp.emojis) tDp.emojis = { ...(tDp.emojis || {}), ...sDp.emojis };
    if (sDp.instanceUrl && !tDp.instanceUrl) tDp.instanceUrl = sDp.instanceUrl;

    // Merge stats (take max of each unified field)
    if (sDp.stats) {
      tDp.stats = tDp.stats || {};
      tDp.stats.replies = Math.max(tDp.stats.replies || 0, sDp.stats.replies || 0);
      tDp.stats.boosts = Math.max(tDp.stats.boosts || 0, sDp.stats.boosts || 0);
      tDp.stats.favourites = Math.max(tDp.stats.favourites || 0, sDp.stats.favourites || 0);
    }
    // Mastodon counts custom reactions as favourites — adjust to avoid double-counting
    // Only subtract non-heart reactions — ❤ reactions are equivalent to favourites
    if (tDp.reactions && Object.keys(tDp.reactions).length > 0 && tDp.stats && tDp.stats.favourites > 0) {
      const nonHeartReactions = Object.entries(tDp.reactions)
        .filter(([k]) => k !== '❤' && k !== '❤️')
        .reduce((sum, [, c]) => sum + c, 0);
      tDp.stats.favourites = Math.max(0, tDp.stats.favourites - nonHeartReactions);
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

    const fragment = document.createDocumentFragment();

    // Ancestors (linear chain)
    for (const post of ancestors) {
      const el = renderPost(post);
      el.classList.add('thread-post', 'thread-ancestor');
      fragment.appendChild(el);
    }

    // Target post (highlighted)
    if (targetPost) {
      const el = renderPost(targetPost);
      el.classList.add('thread-post', 'thread-target');
      fragment.appendChild(el);
    }

    // Descendants: build a reply tree and render with indentation
    if (descendants.length > 0) {
      this._renderDescendantTree(fragment, descendants, targetPost?.id);
    }

    content.appendChild(fragment);

    // Enrich link cards with OG data
    this.enrichLinkCards(content);

    // Scroll to the target post (only in modal, not in pinned columns)
    if (content.closest('.modal')) {
      requestAnimationFrame(() => {
        const target = content.querySelector('.thread-target');
        if (target) {
          target.scrollIntoView({ block: 'center' });
        }
      });
    }
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
