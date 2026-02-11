/**
 * Post Actions Mixin
 * Handles post interactions: fav, boost, reply, quote, reaction, edit, delete
 */
import { renderPost } from '../ui/dashboard.js';
import { COMMON_EMOJIS, loadInstanceEmojis } from '../ui/emoji-picker.js';

export const PostActionsMixin = {

  async handlePostAction(action, postId, platform, accountId, btnElement) {
    const allAccounts = this.store.getAll();

    if (allAccounts.length === 0) return;

    // For renotes/reblogs, reply/quote targets the original post
    const originalPostId = this.getOriginalPostId(postId, platform);

    // Determine if we're in a multi-account column (all/notifications)
    const column = btnElement.closest('.column');
    const isMultiAccountColumn = column && column.dataset.columnType !== 'account';

    // Reply/Quote: open compose modal
    if (action === 'reply') {
      if (isMultiAccountColumn) {
        const cachedPost = this.postCache.get(`${platform}:${originalPostId}`) || this.postCache.get(`${platform}:${postId}`);
        const relevantAccounts = this._getRelevantAccounts(cachedPost, allAccounts);
        this.openComposeModal(originalPostId, null, relevantAccounts);
      } else {
        this.openComposeModal(originalPostId, accountId);
      }
      return;
    }
    if (action === 'quote') {
      if (isMultiAccountColumn) {
        const cachedPost = this.postCache.get(`${platform}:${originalPostId}`) || this.postCache.get(`${platform}:${postId}`);
        const relevantAccounts = this._getRelevantAccounts(cachedPost, allAccounts);
        this.openQuoteModal(originalPostId, platform, null, relevantAccounts);
      } else {
        this.openQuoteModal(originalPostId, platform, accountId);
      }
      return;
    }

    // If the card is inside an account-specific column, use that account directly
    const columnAccountId = column?.dataset.columnType === 'account' ? column.dataset.accountId : null;
    if (columnAccountId) {
      await this.executePostAction(action, postId, platform, columnAccountId, btnElement);
      return;
    }

    // For multi-account columns (all/notifications): show only accounts that received this post
    const cachedPost = this.postCache.get(`${platform}:${postId}`);
    const relevantAccounts = this._getRelevantAccounts(cachedPost, allAccounts);

    // Single relevant account: use it directly
    if (relevantAccounts.length === 1) {
      await this.executePostAction(action, postId, platform, relevantAccounts[0].id, btnElement);
      return;
    }

    // Multi-account: show picker (no pre-selection)
    this.showAccountPicker(btnElement, relevantAccounts, async (selectedAccountId) => {
      try {
        await this.executePostAction(action, postId, platform, selectedAccountId, btnElement);
      } catch (err) {
        console.error('Post action failed:', err);
      }
    });
  },

  async executePostAction(action, postId, platform, accountId, btnElement) {
    const client = this.store.getClient(accountId);
    if (!client) return;
    const account = this.store.getById(accountId);
    if (!account) return;
    const accountPlatform = account.platform;

    // Look up cached post to check current fav/boost state
    const cachedPost = this.postCache.get(`${platform}:${postId}`);
    // For renotes/reblogs, actions target the deepest original post
    let actionPostId = this.getOriginalPostId(postId, platform);

    // Cross-instance: resolve the post on the target instance first
    // (e.g. Misskey note ID → Mastodon local status ID via canonical URI)
    const postAccount = cachedPost?.accountId ? this.store.getById(cachedPost.accountId) : null;
    const isCrossInstance = postAccount && postAccount.instanceUrl !== account.instanceUrl;
    if (isCrossInstance) {
      const originalCached = this.postCache.get(`${platform}:${actionPostId}`) || cachedPost;
      const displayPost = originalCached?.reblog || originalCached;
      const canonicalUri = displayPost?.canonicalUri || displayPost?.url;
      if (!canonicalUri) {
        this.showToast('이 게시물의 원본 URL을 찾을 수 없습니다.');
        return;
      }
      try {
        btnElement.classList.add('processing');
        const resolved = await client.resolveUrl(canonicalUri);
        if (!resolved) {
          this.showToast('이 게시물을 해당 계정에서 찾을 수 없습니다.');
          btnElement.classList.remove('processing');
          return;
        }
        actionPostId = resolved.id;
      } catch (err) {
        this.showToast('게시물 조회 실패: ' + err.message);
        btnElement.classList.remove('processing');
        return;
      }
    }

    try {
      // Immediate visual feedback: add processing state
      btnElement.classList.add('processing');

      if (action === 'fav') {
        const alreadyFaved = cachedPost?.favourited || cachedPost?.myReaction;
        if (alreadyFaved) {
          // Unlike / unreact
          if (accountPlatform === 'mastodon') {
            await client.unfavourite(actionPostId);
          } else {
            await client.deleteReaction(actionPostId);
          }
          btnElement.classList.remove('processing', 'active');
        } else {
          if (accountPlatform === 'mastodon') {
            await client.favourite(actionPostId);
          } else {
            await client.createReaction(actionPostId, '❤');
          }
          btnElement.classList.remove('processing');
          btnElement.classList.add('active', 'just-activated');
          setTimeout(() => btnElement.classList.remove('just-activated'), 600);
        }
      } else if (action === 'boost') {
        const alreadyBoosted = cachedPost?.reblogged;
        if (alreadyBoosted) {
          if (accountPlatform === 'mastodon') {
            await client.unreblog(actionPostId);
          }
          btnElement.classList.remove('processing', 'active');
          // Update cache
          if (cachedPost) cachedPost.reblogged = false;
        } else {
          if (accountPlatform === 'mastodon') {
            await client.reblog(actionPostId);
          } else {
            await client.renote(actionPostId);
          }
          btnElement.classList.remove('processing');
          btnElement.classList.add('active', 'just-activated');
          setTimeout(() => btnElement.classList.remove('just-activated'), 600);
          // Update cache
          if (cachedPost) cachedPost.reblogged = true;
        }
      } else if (action === 'reply') {
        btnElement.classList.remove('processing');
        this.openComposeModal(postId, accountId);
        return; // Don't refresh for reply
      } else if (action === 'quote') {
        btnElement.classList.remove('processing');
        this.openQuoteModal(postId, platform, accountId);
        return; // Don't refresh for quote
      } else if (action === 'reaction') {
        btnElement.classList.remove('processing');
        // Small delay to ensure any previous picker (account picker) is fully cleaned up
        await new Promise(r => setTimeout(r, 50));
        await this.showReactionPicker(btnElement, actionPostId, platform, accountId);
        return;
      }

      // Re-fetch the note and update the card in-place
      // For cross-instance, use the original platform's client for refresh
      await this.refreshSinglePost(postId, platform, isCrossInstance ? null : accountId);
    } catch (err) {
      console.error(`Action ${action} failed:`, err);
      btnElement.classList.remove('processing');
    }
  },

  async refreshSinglePost(postId, platform, accountId) {
    try {
      let client = this.store.getClient(accountId);
      let account = this.store.getById(accountId);

      // If no accountId or platform mismatch, find a client matching the post's platform
      if (!client || !account || account.platform !== platform) {
        const cachedPost = this.postCache.get(`${platform}:${postId}`);
        if (cachedPost?.accountId) {
          const altClient = this.store.getClient(cachedPost.accountId);
          const altAccount = this.store.getById(cachedPost.accountId);
          if (altClient && altAccount) {
            client = altClient;
            account = altAccount;
          }
        }
        // Fallback: any account on the same platform
        if (!client || account?.platform !== platform) {
          const match = this.store.getAll().find(a =>
            (a.platform === 'mastodon') === (platform === 'mastodon')
          );
          if (match) {
            client = this.store.getClient(match.id);
            account = match;
          }
        }
      }
      if (!client || !account) return;

      let rawPost;
      if (account.platform === 'mastodon') {
        rawPost = await client.getStatus(postId);
      } else {
        rawPost = await client.getNote(postId);
      }
      if (!rawPost) return;

      const updatedPost = client.normalizePost(rawPost);
      updatedPost.accountId = accountId;
      updatedPost.accountPlatform = account.platform;
      updatedPost.themeColor = account.themeColor || null;
      const ownerId = updatedPost.rebloggedBy ? updatedPost.rebloggedBy.id : updatedPost.author.id;
      updatedPost.isOwn = String(ownerId) === String(account.profile.id);

      // Find and update all matching cards in the DOM
      const cards = document.querySelectorAll(`.post-card[data-post-id="${postId}"][data-platform="${platform}"]`);
      for (const card of cards) {
        // Preserve state from cache
        const oldCacheKey = `${platform}:${postId}`;
        const cachedPost = this.postCache.get(oldCacheKey);
        if (cachedPost?.mergedAccounts) {
          updatedPost.mergedAccounts = cachedPost.mergedAccounts;
        }
        // Preserve reblogged state for Misskey (API doesn't report it)
        if (account.platform !== 'mastodon' && cachedPost?.reblogged) {
          updatedPost.reblogged = true;
        }

        const newCard = renderPost(updatedPost);
        card.replaceWith(newCard);
      }

      // Update cache
      this.postCache.set(`${platform}:${postId}`, updatedPost);
    } catch (err) {
      // Silently fail - the action already succeeded
    }
  },

  async handleDeletePost(postId, platform, accountId, btnElement) {
    if (!confirm('이 글을 삭제하시겠습니까?')) return;

    const client = this.store.getClient(accountId);
    const account = this.store.getById(accountId);
    if (!client || !account) return;

    try {
      btnElement.classList.add('processing');
      if (account.platform === 'mastodon') {
        await client.deleteStatus(postId);
      } else {
        await client.deleteNote(postId);
      }

      // Remove the card from the DOM
      const cards = document.querySelectorAll(`.post-card[data-post-id="${postId}"][data-platform="${platform}"]`);
      for (const card of cards) {
        card.style.transition = 'opacity 0.3s, transform 0.3s';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.95)';
        setTimeout(() => card.remove(), 300);
      }

      // Remove from cache
      this.postCache.delete(`${platform}:${postId}`);
    } catch (err) {
      console.error('Delete failed:', err);
      btnElement.classList.remove('processing');
      this.showToast('삭제에 실패했습니다: ' + err.message);
    }
  },

  async openEditModal(postId, platform, accountId) {
    const client = this.store.getClient(accountId);
    const account = this.store.getById(accountId);
    if (!client || !account) return;

    let sourceText = '';
    let sourceCw = '';

    try {
      if (account.platform === 'mastodon') {
        const source = await client.getStatusSource(postId);
        sourceText = source.text || '';
        sourceCw = source.spoiler_text || '';
      } else {
        const cachedPost = this.postCache.get(`${platform}:${postId}`);
        const raw = cachedPost?.raw;
        const actualRaw = (raw?.renote && !raw?.text) ? raw.renote : raw;
        sourceText = actualRaw?.text || '';
        sourceCw = actualRaw?.cw || '';
      }
    } catch (err) {
      this.showToast('원문을 가져오는데 실패했습니다: ' + err.message);
      return;
    }

    // Open compose modal in edit mode
    this.openComposeModal();
    this.composeText.dataset.editPostId = postId;
    this.composeText.dataset.editPlatform = platform;
    this.composeText.dataset.editAccountId = accountId;
    this.composeText.value = sourceText;
    this.composeCw.value = sourceCw;
    this.composeTitle.textContent = '글 수정';
    this.composeText.placeholder = '수정할 내용을 입력하세요...';
    this.btnComposeSubmit.textContent = '수정';

    // Lock to the editing account
    this.composeSelectedAccounts.clear();
    this.composeSelectedAccounts.add(accountId);
    const toggles = this.composeAccountsContainer.querySelectorAll('.compose-account-toggle');
    for (const toggle of toggles) {
      if (toggle.dataset.accountId === accountId) {
        toggle.classList.add('active');
      } else {
        toggle.classList.remove('active');
        toggle.disabled = true;
        toggle.style.opacity = '0.3';
      }
    }
  },

  async handleEditSubmit() {
    const editPostId = this.composeText.dataset.editPostId;
    const editPlatform = this.composeText.dataset.editPlatform;
    const editAccountId = this.composeText.dataset.editAccountId;
    const text = this.composeText.value.trim();
    const cw = this.composeCw.value.trim();

    if (!text) {
      this.composeError.textContent = '내용을 입력하세요.';
      this.composeError.style.display = 'block';
      return;
    }

    this.btnComposeSubmit.disabled = true;
    this.btnComposeSubmit.textContent = '수정 중...';
    this.composeError.style.display = 'none';

    const client = this.store.getClient(editAccountId);
    const account = this.store.getById(editAccountId);
    if (!client || !account) return;

    try {
      if (account.platform === 'mastodon') {
        await client.editStatus(editPostId, text, {
          spoilerText: cw || undefined,
        });
      } else {
        await client.editNote(editPostId, text, {
          cw: cw || undefined,
        });
      }
      this.closeModal(this.modalCompose);
      await this.refreshSinglePost(editPostId, editPlatform, editAccountId);
    } catch (err) {
      this.composeError.textContent = '수정 실패: ' + err.message;
      this.composeError.style.display = 'block';
    }

    this.btnComposeSubmit.disabled = false;
    this.btnComposeSubmit.textContent = '수정';
  },

  // Get the original (deepest) post from a renote/reblog chain
  getOriginalPostId(postId, platform) {
    const cached = this.postCache.get(`${platform}:${postId}`);
    if (!cached) return postId;
    let current = cached;
    while (current.reblog) {
      current = current.reblog;
    }
    return current.id;
  },

  getReplyMention(postId, accountId) {
    const account = this.store.getById(accountId);
    const myUsername = account?.profile?.username;

    // Walk up the reply chain to collect non-self mentions
    const findPost = (id) => {
      for (const [, post] of this.postCache) {
        const dp = post.reblog || post;
        if (post.id === id || dp.id === id) return dp;
      }
      return null;
    };

    const mentions = [];
    const seen = new Set();
    let currentId = postId;
    let depth = 0;

    while (currentId && depth < 10) {
      const dp = findPost(currentId);
      if (!dp) break;

      const author = dp.author;
      if (author) {
        const acct = author.acct || author.username;
        // Add non-self, non-duplicate mentions
        if ((!myUsername || author.username !== myUsername) && !seen.has(acct)) {
          seen.add(acct);
          mentions.push(`@${acct}`);
        }
      }

      // Walk up to parent
      currentId = dp.replyTo?.id || dp.replyToId || null;
      depth++;
      // Stop after finding the first non-self mention
      if (mentions.length > 0) break;
    }

    return mentions.length > 0 ? mentions.join(' ') : null;
  },

  async showReactionPicker(anchorElement, postId, platform, accountId) {
    // Close any existing picker
    this.closeReactionPicker();

    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    picker.id = 'reaction-picker-popup';

    // Check if this is a Misskey-type account (needs instance emojis)
    const client = this.store.getClient(accountId);
    const account = this.store.getById(accountId);
    const isMisskeyType = account && account.platform !== 'mastodon';

    // Build initial HTML with unicode emojis + loading placeholder for instance emojis
    picker.innerHTML = `
      <div class="reaction-picker-section-label">이모지</div>
      <div class="reaction-picker-grid reaction-picker-unicode">
        ${COMMON_EMOJIS.map(r => `<button class="reaction-picker-item" data-reaction="${r}">${r}</button>`).join('')}
      </div>
      ${isMisskeyType ? '<div class="reaction-picker-loading">커스텀 이모지 로딩중...</div>' : ''}
      <div class="reaction-picker-custom">
        <input type="text" class="reaction-picker-input" placeholder=":emoji: 또는 이모지 입력" />
      </div>
    `;

    // Position near button
    const positionReactionPicker = (r) => {
      picker.style.bottom = `${window.innerHeight - r.top + 4}px`;
      picker.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 330))}px`;
    };
    const rect = anchorElement.getBoundingClientRect();
    picker.style.position = 'fixed';
    positionReactionPicker(rect);

    document.body.appendChild(picker);
    this._trackPopupScroll('reactionPicker', picker, anchorElement, positionReactionPicker);

    // Handle emoji click (delegated, works for dynamically added instance emojis too)
    picker.addEventListener('click', async (e) => {
      const item = e.target.closest('.reaction-picker-item');
      if (!item) return;
      const reaction = item.dataset.reaction;
      this.closeReactionPicker();
      await this.sendReaction(postId, platform, accountId, reaction, anchorElement);
    });

    // Handle custom emoji input
    const input = picker.querySelector('.reaction-picker-input');
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const value = input.value.trim();
        if (value) {
          this.closeReactionPicker();
          await this.sendReaction(postId, platform, accountId, value, anchorElement);
        }
      }
    });

    // Close on outside click (persistent listener)
    setTimeout(() => {
      const handler = (e) => {
        if (!picker.contains(e.target) && !anchorElement.contains(e.target)) {
          this.closeReactionPicker();
        }
      };
      document.addEventListener('click', handler);
      this._reactionPickerClose = handler;
    }, 0);

    // Async: fetch and insert instance custom emojis for Misskey accounts
    if (isMisskeyType && client?.getInstanceEmojis) {
      loadInstanceEmojis({
        client,
        picker,
        pickerId: 'reaction-picker-popup',
        escapeHtml: this.escapeHtml.bind(this),
        itemClass: 'reaction-picker-item instance-emoji',
        dataAttr: 'reaction',
        emptyMessage: '커스텀 이모지 없음',
        errorMessage: '이모지 로딩 실패',
      });
    }
  },

  closeReactionPicker() {
    const existing = document.getElementById('reaction-picker-popup');
    if (existing) existing.remove();
    if (this._reactionPickerClose) {
      document.removeEventListener('click', this._reactionPickerClose);
      this._reactionPickerClose = null;
    }
    this._removeScrollTracker('reactionPicker');
  },

  async sendReaction(postId, platform, accountId, reaction, btnElement) {
    const client = this.store.getClient(accountId);
    if (!client) return;
    try {
      btnElement.classList.add('processing');
      // If already reacted on Misskey, delete old reaction first
      const cachedPost = this.postCache.get(`${platform}:${postId}`);
      if (cachedPost?.myReaction) {
        await client.deleteReaction(postId);
      }
      await client.createReaction(postId, reaction);
      btnElement.classList.remove('processing');
      btnElement.classList.add('active', 'just-activated');
      setTimeout(() => btnElement.classList.remove('just-activated'), 600);
      await this.refreshSinglePost(postId, platform, accountId);
    } catch (err) {
      console.error('Reaction failed:', err);
      btnElement.classList.remove('processing');
    }
  },

  openQuoteModal(postId, platform, accountId, restrictedAccounts = null) {
    // Find the original post URL for the quote
    let quoteUrl = '';
    let quoteAccountId = accountId;
    for (const [key, post] of this.postCache) {
      const dp = post.reblog || post;
      if (post.id === postId || dp.id === postId) {
        quoteUrl = dp.url || dp.canonicalUri || '';
        if (!quoteAccountId) quoteAccountId = post.accountId;
        break;
      }
    }

    this.openComposeModal(null, accountId, restrictedAccounts);
    this.composeTitle.textContent = '인용';
    this.composeText.dataset.quoteId = postId;
    this.composeText.dataset.quotePlatform = platform;
    this.composeText.dataset.quoteUrl = quoteUrl;
    if (quoteAccountId) this.composeText.dataset.quoteAccountId = quoteAccountId;
    this.composeText.placeholder = '인용 내용을 작성하세요...';
  },

  // Get accounts that received this post (from mergedAccounts or single accountId)
  _getRelevantAccounts(cachedPost, allAccounts) {
    if (cachedPost?.mergedAccounts && cachedPost.mergedAccounts.length > 0) {
      const accounts = cachedPost.mergedAccounts
        .map(a => this.store.getById(a.id))
        .filter(Boolean);
      if (accounts.length > 0) return accounts;
    }
    if (cachedPost?.accountId) {
      const account = this.store.getById(cachedPost.accountId);
      if (account) return [account];
    }
    return allAccounts;
  },

  // ===== Account Picker =====

  showAccountPicker(anchorElement, accounts, onSelect, preferredAccountId = null) {
    this.closeAccountPicker();

    const picker = document.createElement('div');
    picker.className = 'account-picker';
    picker.id = 'account-picker-popup';

    // Sort preferred account to top
    const sortedAccounts = [...accounts];
    if (preferredAccountId) {
      sortedAccounts.sort((a, b) => {
        if (a.id === preferredAccountId) return -1;
        if (b.id === preferredAccountId) return 1;
        return 0;
      });
    }

    let html = '<div class="account-picker-title">계정 선택</div>';
    for (const account of sortedAccounts) {
      const p = account.profile;
      const isPreferred = account.id === preferredAccountId;
      const dotColor = account.themeColor || '';
      const dotStyle = dotColor ? `style="background:${dotColor}"` : '';
      html += `
        <button class="account-picker-item${isPreferred ? ' preferred' : ''}" data-account-id="${account.id}"${isPreferred && account.themeColor ? ` style="border-left-color:${account.themeColor}"` : ''}>
          <img src="${p.avatarUrl || ''}" alt="" onerror="this.style.display='none'">
          <span class="picker-name">${this.escapeHtml(p.displayName)}</span>
          <span class="platform-dot ${account.platform}" ${dotStyle}></span>
        </button>
      `;
    }
    picker.innerHTML = html;

    // Position near the anchor
    const positionAccountPicker = (r) => {
      picker.style.left = `${r.left}px`;
      picker.style.top = `${r.bottom + 4}px`;
      // Adjust if goes off right
      const pw = picker.offsetWidth || 200;
      if (r.left + pw > window.innerWidth) {
        picker.style.left = `${window.innerWidth - pw - 8}px`;
      }
    };
    const rect = anchorElement.getBoundingClientRect();
    positionAccountPicker(rect);

    document.body.appendChild(picker);
    // Re-adjust after DOM append (now offsetWidth is real)
    positionAccountPicker(anchorElement.getBoundingClientRect());
    this._trackPopupScroll('accountPicker', picker, anchorElement, positionAccountPicker);

    picker.addEventListener('click', (e) => {
      const item = e.target.closest('.account-picker-item');
      if (!item) return;
      const selectedId = item.dataset.accountId;
      this.closeAccountPicker();
      onSelect(selectedId);
    });

    // Close on outside click (persistent listener)
    setTimeout(() => {
      const handler = (e) => {
        if (!picker.contains(e.target) && !anchorElement.contains(e.target)) {
          this.closeAccountPicker();
        }
      };
      document.addEventListener('click', handler);
      this._pickerOutsideClick = handler;
    }, 0);
  },

  closeAccountPicker() {
    const existing = document.getElementById('account-picker-popup');
    if (existing) existing.remove();
    if (this._pickerOutsideClick) {
      document.removeEventListener('click', this._pickerOutsideClick);
      this._pickerOutsideClick = null;
    }
    this._removeScrollTracker('accountPicker');
  },

  // ===== Reaction Users =====

  async showReactionUsers(badge, postId, platform, accountId, reaction) {
    // Toggle: if same badge is already showing the popup, just close it
    if (this._activeReactionBadge === badge && document.getElementById('reaction-users-popup')) {
      this.closeReactionPopup();
      return;
    }

    // Close any existing popup
    this.closeReactionPopup();

    // Track which badge is active
    this._activeReactionBadge = badge;

    // Find a usable account for this platform
    const accounts = this.store.getAll();
    let useAccountId = accountId;
    if (!useAccountId) {
      const match = accounts.find(a => a.platform === platform);
      if (match) useAccountId = match.id;
    }
    if (!useAccountId) return;

    const client = this.store.getClient(useAccountId);
    if (!client) return;

    const popup = document.createElement('div');
    popup.className = 'reaction-users-popup';
    popup.id = 'reaction-users-popup';
    popup.innerHTML = '<div class="reaction-users-loading">불러오는 중...</div>';

    const positionReactionPopup = (r) => {
      popup.style.left = `${r.left}px`;
      popup.style.top = `${r.bottom + 4}px`;
      const pw = popup.offsetWidth || 180;
      if (r.left + pw > window.innerWidth) {
        popup.style.left = `${window.innerWidth - pw - 8}px`;
      }
    };
    const rect = badge.getBoundingClientRect();
    positionReactionPopup(rect);
    document.body.appendChild(popup);
    positionReactionPopup(badge.getBoundingClientRect());
    this._trackPopupScroll('reactionPopup', popup, badge, positionReactionPopup);

    try {
      let users = [];

      if (platform === 'mastodon') {
        // Mastodon doesn't have per-reaction users, skip
        popup.innerHTML = '<div class="reaction-users-loading">Mastodon은 리액션 사용자 조회를 지원하지 않습니다.</div>';
      } else {
        // Misskey: notes/reactions
        let reactions = await client.getReactions(postId, reaction || undefined);

        // Fallback: if type-filtered query returned empty, retry without filter
        // and match client-side (handles custom emoji format mismatches like :emoji@.: vs :emoji:)
        if (reactions.length === 0 && reaction) {
          const allReactions = await client.getReactions(postId);
          // Normalize reaction string for comparison (strip @. suffix for local emoji)
          const normalize = (r) => r ? r.replace(/@\.:$/, ':').replace(/@\.$/, '') : '';
          const target = normalize(reaction);
          reactions = allReactions.filter(r => {
            const rType = normalize(r.type || '');
            return rType === target || r.type === reaction;
          });
        }

        users = reactions.map(r => {
          const normalized = r.user ? client.normalizeUser(r.user) : null;
          return {
            displayNameHtml: normalized?.displayNameHtml || this.escapeHtml(r.user?.name || r.user?.username || '?'),
            username: normalized?.username || r.user?.username || '?',
            avatarUrl: normalized?.avatarUrl || r.user?.avatarUrl || '',
            reaction: r.type || '',
          };
        });

        if (users.length === 0) {
          popup.innerHTML = '<div class="reaction-users-loading">리액션한 사용자가 없습니다.</div>';
        } else {
          let html = '<div class="reaction-users-list">';
          for (const user of users) {
            html += `
              <div class="reaction-user-item">
                <img class="reaction-user-avatar" src="${this.escapeHtml(user.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
                <span class="reaction-user-name">${user.displayNameHtml}</span>
                <span class="reaction-user-handle">@${this.escapeHtml(user.username)}</span>
              </div>
            `;
          }
          html += '</div>';
          popup.innerHTML = html;
        }
      }
    } catch {
      popup.innerHTML = '<div class="reaction-users-loading">불러오기 실패</div>';
    }

    // Close on outside click (persistent listener)
    setTimeout(() => {
      const handler = (e) => {
        if (!popup.contains(e.target) && !badge.contains(e.target)) {
          this.closeReactionPopup();
        }
      };
      document.addEventListener('click', handler);
      this._reactionPopupClose = handler;
    }, 0);
  },

  closeReactionPopup() {
    const existing = document.getElementById('reaction-users-popup');
    if (existing) existing.remove();
    if (this._reactionPopupClose) {
      document.removeEventListener('click', this._reactionPopupClose);
      this._reactionPopupClose = null;
    }
    this._activeReactionBadge = null;
    this._removeScrollTracker('reactionPopup');
  },

  // Track scroll on the column-content and reposition a fixed popup to follow the anchor
  _trackPopupScroll(key, popup, anchorElement, positionFn) {
    const scrollContainer = anchorElement.closest('.column-content');
    if (!scrollContainer) return;
    const handler = () => {
      const rect = anchorElement.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      // Hide popup if anchor scrolled out of view
      if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) {
        popup.style.visibility = 'hidden';
      } else {
        popup.style.visibility = '';
        positionFn(rect);
      }
    };
    scrollContainer.addEventListener('scroll', handler, { passive: true });
    if (!this._scrollTrackers) this._scrollTrackers = {};
    this._scrollTrackers[key] = { container: scrollContainer, handler };
  },

  _removeScrollTracker(key) {
    if (!this._scrollTrackers || !this._scrollTrackers[key]) return;
    const { container, handler } = this._scrollTrackers[key];
    container.removeEventListener('scroll', handler);
    delete this._scrollTrackers[key];
  },

};
