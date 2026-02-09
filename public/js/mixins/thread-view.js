/**
 * Thread View Mixin
 * Handles loading and displaying conversation threads (ancestors + descendants)
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
        // Mastodon: single API call for full context
        const [status, context] = await Promise.all([
          client.getStatus(postId),
          client.getStatusContext(postId),
        ]);
        targetPost = status ? client.normalizePost(status) : null;
        ancestors = (context.ancestors || []).map(s => client.normalizePost(s));
        descendants = (context.descendants || []).map(s => client.normalizePost(s));
      } else {
        // Misskey: separate calls for conversation + children
        const [note, conversation, children] = await Promise.all([
          client.getNote(postId),
          client.getNoteConversation(postId, 30).catch(() => []),
          client.getNoteChildren(postId, 30).catch(() => []),
        ]);
        targetPost = note ? client.normalizePost(note) : null;
        // conversation returns oldest-first (root → parent), reverse for display order
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

      // Ancestors
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

      // Descendants
      for (const post of descendants) {
        const el = renderPost(post);
        el.classList.add('thread-post', 'thread-descendant');
        content.appendChild(el);
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

};
