/**
 * Thread View Mixin
 * Handles loading and displaying conversation threads (ancestors + descendants)
 * with tree-structured replies and visual hierarchy.
 */
import { renderPost } from '../ui/dashboard.js';

export const ThreadViewMixin = {

  async openThreadView(postId, platform, accountId) {
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
      const addMeta = (post) => {
        post.accountId = accountId;
        post.accountPlatform = account.platform;
        post.themeColor = account.themeColor || null;
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

      // Render
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

      // Scroll to the target post
      requestAnimationFrame(() => {
        const target = content.querySelector('.thread-target');
        if (target) {
          target.scrollIntoView({ block: 'center' });
        }
      });
    } catch (err) {
      console.error('Thread load failed:', err);
      content.innerHTML = `<div class="thread-loading">스레드를 불러오는 중 오류가 발생했습니다: ${this.escapeHtml(err.message)}</div>`;
    }
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
