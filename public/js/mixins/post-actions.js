/**
 * Post Actions Mixin
 * Handles post interactions: fav, boost, reply, quote, reaction, edit, delete
 */
import { escapeHtml } from '../ui/utils.js';
import { COMMON_EMOJIS, loadInstanceEmojis, setupPickerSearch } from '../ui/emoji-picker.js';
import { buildReactionsHtml, renderPost } from '../ui/dashboard.js';

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
        this.openComposeModal(originalPostId, accountId, relevantAccounts);
      } else {
        this.openComposeModal(originalPostId, accountId);
      }
      return;
    }
    if (action === 'quote') {
      if (isMultiAccountColumn) {
        const cachedPost = this.postCache.get(`${platform}:${originalPostId}`) || this.postCache.get(`${platform}:${postId}`);
        const relevantAccounts = this._getRelevantAccounts(cachedPost, allAccounts);
        this.openQuoteModal(originalPostId, platform, accountId, relevantAccounts);
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
    let relevantAccounts = this._getRelevantAccounts(cachedPost, allAccounts);

    // Reaction: only Misskey accounts can react
    if (action === 'reaction') {
      relevantAccounts = relevantAccounts.filter(a => a.platform !== 'mastodon');
      if (relevantAccounts.length === 0) {
        this.showToast('리액션은 미스키 계정에서만 가능합니다.', 'info');
        return;
      }
    }

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

      // Try cached note ID first (avoids ap/show API call, prevents 429)
      let resolved = false;
      // Multi-instance lookup: check per-instance map first (handles multiple Misskey-type accounts)
      if (displayPost?._noteIdsByInstance && displayPost._noteIdsByInstance[account.instanceUrl]) {
        actionPostId = displayPost._noteIdsByInstance[account.instanceUrl];
        resolved = true;
      }
      // Fallback: legacy single-account cache
      if (!resolved) {
        const cachedNoteId = displayPost?._misskeyNoteId;
        const cachedAccountId = displayPost?._misskeyAccountId;
        if (cachedNoteId && cachedAccountId) {
          const cachedAccount = this.store.getById(cachedAccountId);
          if (cachedAccount && cachedAccount.instanceUrl === account.instanceUrl) {
            actionPostId = cachedNoteId;
            resolved = true;
          }
        }
      }

      if (!resolved) {
        const canonicalUri = displayPost?.canonicalUri || displayPost?.url;
        if (!canonicalUri) {
          this.showToast('이 게시물의 원본 URL을 찾을 수 없습니다.');
          return;
        }
        try {
          btnElement.classList.add('processing');
          const resolvedPost = await client.resolveUrl(canonicalUri);
          if (!resolvedPost) {
            this.showToast('이 게시물을 해당 계정에서 찾을 수 없습니다.');
            btnElement.classList.remove('processing');
            return;
          }
          actionPostId = resolvedPost.id;
          // Cache the resolved ID for future use
          if (displayPost) {
            // Only set _misskeyNoteId for Misskey-type accounts (used by _fetchMissingReactions)
            if (accountPlatform !== 'mastodon') {
              displayPost._misskeyNoteId = resolvedPost.id;
              displayPost._misskeyAccountId = accountId;
            }
            if (!displayPost._noteIdsByInstance) displayPost._noteIdsByInstance = {};
            displayPost._noteIdsByInstance[account.instanceUrl] = resolvedPost.id;
          }
        } catch (err) {
          this.showToast('게시물 조회 실패: ' + err.message);
          btnElement.classList.remove('processing');
          return;
        }
      }
    }

    try {
      // Immediate visual feedback: add processing state
      btnElement.classList.add('processing');

      if (action === 'fav') {
        const displayPost = cachedPost?.reblog || cachedPost;
        const alreadyFaved = cachedPost?.favourited || displayPost?.myReaction;

        // Optimistic update: apply immediately, then send API call
        if (alreadyFaved) {
          if (cachedPost) {
            cachedPost.favourited = false;
            if (displayPost) {
              displayPost.favourited = false;
              // Decrement reaction count
              if (displayPost.myReaction && displayPost.reactions?.[displayPost.myReaction] > 0) {
                displayPost.reactions[displayPost.myReaction] = Math.max(0, displayPost.reactions[displayPost.myReaction] - 1);
                if (displayPost.reactions[displayPost.myReaction] === 0) delete displayPost.reactions[displayPost.myReaction];
              }
              displayPost.myReaction = null;
              if (displayPost.stats) displayPost.stats.favourites = Math.max(0, (displayPost.stats.favourites || 1) - 1);
            }
            this._rerenderCachedPost(postId, platform);
          }
          btnElement.classList.remove('processing', 'active');
          // Background API call
          if (accountPlatform === 'mastodon') {
            client.unfavourite(actionPostId).catch(e => console.error('Unfav failed:', e));
          } else {
            client.deleteReaction(actionPostId).catch(e => console.error('Unreact failed:', e));
          }
        } else {
          if (cachedPost) {
            cachedPost.favourited = true;
            if (displayPost) {
              displayPost.favourited = true;
              // Increment reaction/fav count
              if (accountPlatform !== 'mastodon') {
                if (!displayPost.reactions) displayPost.reactions = {};
                displayPost.reactions['❤'] = (displayPost.reactions['❤'] || 0) + 1;
                displayPost.myReaction = '❤';
              } else {
                if (displayPost.stats) displayPost.stats.favourites = (displayPost.stats.favourites || 0) + 1;
              }
            }
            this._rerenderCachedPost(postId, platform);
          }
          btnElement.classList.remove('processing');
          btnElement.classList.add('active', 'just-activated');
          setTimeout(() => btnElement.classList.remove('just-activated'), 600);
          // Background API call
          if (accountPlatform === 'mastodon') {
            client.favourite(actionPostId).catch(e => console.error('Fav failed:', e));
          } else {
            client.createReaction(actionPostId, '❤').catch(e => console.error('React failed:', e));
          }
        }
        // Fav already handled optimistically — background server confirm via streaming
        return;
      } else if (action === 'boost') {
        const alreadyBoosted = cachedPost?.reblogged;
        if (alreadyBoosted) {
          if (accountPlatform === 'mastodon') {
            await client.unreblog(actionPostId);
          } else {
            await client.unrenote(actionPostId);
          }
          if (cachedPost) cachedPost.reblogged = false;
          btnElement.classList.remove('processing', 'active');
        } else {
          if (accountPlatform === 'mastodon') {
            await client.reblog(actionPostId);
          } else {
            await client.renote(actionPostId);
          }
          if (cachedPost) cachedPost.reblogged = true;
          btnElement.classList.remove('processing');
          btnElement.classList.add('active', 'just-activated');
          setTimeout(() => btnElement.classList.remove('just-activated'), 600);
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
        // Pass both: actionPostId for API calls, postId for card refresh
        const originalPostId = isCrossInstance ? postId : null;
        await this.showReactionPicker(btnElement, actionPostId, platform, accountId, originalPostId);
        return;
      }

      // Re-fetch the note and update the card in-place
      if (isCrossInstance && actionPostId) {
        // For cross-instance: refresh from both platforms and merge
        await this._refreshMergedPost(postId, platform, accountId, actionPostId);
      } else {
        await this.refreshSinglePost(postId, platform, accountId);
      }
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
      const udp = updatedPost.reblog || updatedPost;

      // Merge into cache instead of replacing — preserves replyTo, enrichments, etc.
      const cacheKey = `${platform}:${postId}`;
      const cachedPost = this.postCache.get(cacheKey);
      if (cachedPost) {
        const cdp = cachedPost.reblog || cachedPost;
        // Update interactive state
        cdp.favourited = udp.favourited;
        cdp.myReaction = udp.myReaction;
        // Misskey API always returns reblogged:false — trust cache set by executePostAction
        if (account.platform === 'mastodon') {
          cdp.reblogged = udp.reblogged;
        }
        // Update stats
        if (udp.stats) {
          cdp.stats = { ...cdp.stats, ...udp.stats };
          if (cdp.reactions && Object.keys(cdp.reactions).length > 0 && cdp.stats.favourites > 0) {
            const nonHeartReactions = Object.entries(cdp.reactions)
              .filter(([k]) => k !== '❤' && k !== '❤️')
              .reduce((sum, [, c]) => sum + c, 0);
            cdp.stats.favourites = Math.max(0, cdp.stats.favourites - nonHeartReactions);
          }
        }
        // Update reactions (always sync — clears correctly on unreact)
        if (udp.reactions) {
          cdp.reactions = udp.reactions;
          // Merge rather than replace — preserves pre-populated emoji URLs
          // (Misskey may not return reactionEmojis immediately after creating a reaction)
          cdp.reactionEmojis = { ...(cdp.reactionEmojis || {}), ...(udp.reactionEmojis || {}) };
        }
        // Sync wrapper state for reblogs (wrapper and inner post differ)
        if (cachedPost !== cdp) {
          cachedPost.favourited = updatedPost.favourited;
          if (account.platform === 'mastodon') {
            cachedPost.reblogged = updatedPost.reblogged;
          }
        }
      } else {
        // No cache — store normalized post directly
        updatedPost.accountId = accountId;
        updatedPost.accountPlatform = account.platform;
        updatedPost.themeColor = this._accountColor(account);
        this.postCache.set(cacheKey, updatedPost);
      }

      // In-place DOM update: only refresh action buttons and counts
      const postData = cachedPost || updatedPost;
      const dp = postData.reblog || postData;
      const selector = `.post-card[data-post-id="${postId}"][data-platform="${platform}"], .notif-card[data-post-id="${postId}"][data-platform="${platform}"]`;
      const cards = document.querySelectorAll(selector);
      for (const card of cards) {
        this._updateCardActions(card, dp, postData);
      }
    } catch (err) {
      // Silently fail - the action already succeeded
    }
  },

  /** Update action buttons and counts in-place without re-rendering the card */
  _updateCardActions(card, displayPost, wrapperPost) {
    // Action button selectors work for both post-card and notif-card
    const favBtn = card.querySelector('[data-action="fav"]');
    const boostBtn = card.querySelector('[data-action="boost"]');

    const isFaved = wrapperPost.favourited || displayPost.favourited
      || (displayPost.myReaction && (displayPost.myReaction === '❤' || displayPost.myReaction === '❤️'));
    const isBoosted = wrapperPost.reblogged || displayPost.reblogged;

    if (favBtn) {
      favBtn.classList.toggle('active', !!isFaved);
      const favCount = displayPost.stats?.favourites || 0;
      const countEl = favBtn.querySelector('.action-count, .notif-action-count');
      if (countEl) {
        countEl.textContent = favCount > 0 ? String(favCount) : '';
        if (favCount <= 0) countEl.remove();
      } else if (favCount > 0) {
        const span = document.createElement('span');
        span.className = card.classList.contains('notif-card') ? 'notif-action-count' : 'action-count';
        span.textContent = String(favCount);
        favBtn.appendChild(span);
      }
    }

    if (boostBtn) {
      boostBtn.classList.toggle('active', !!isBoosted);
      const boostCount = displayPost.stats?.boosts || 0;
      const countEl = boostBtn.querySelector('.action-count, .notif-action-count');
      if (countEl) {
        countEl.textContent = boostCount > 0 ? String(boostCount) : '';
        if (boostCount <= 0) countEl.remove();
      } else if (boostCount > 0) {
        const span = document.createElement('span');
        span.className = card.classList.contains('notif-card') ? 'notif-action-count' : 'action-count';
        span.textContent = String(boostCount);
        boostBtn.appendChild(span);
      }
    }

    // Update reply count too
    const replyBtn = card.querySelector('[data-action="reply"]');
    if (replyBtn) {
      const replyCount = displayPost.stats?.replies || 0;
      const countEl = replyBtn.querySelector('.action-count, .notif-action-count');
      if (countEl) {
        countEl.textContent = replyCount > 0 ? String(replyCount) : '';
        if (replyCount <= 0) countEl.remove();
      } else if (replyCount > 0) {
        const span = document.createElement('span');
        span.className = card.classList.contains('notif-card') ? 'notif-action-count' : 'action-count';
        span.textContent = String(replyCount);
        replyBtn.appendChild(span);
      }
    }

    // Rebuild reaction badges section (favourites + custom reactions)
    const reactionsHtml = buildReactionsHtml(displayPost, wrapperPost);
    let reactionsDiv = card.querySelector('.post-reactions');
    if (reactionsHtml) {
      if (!reactionsDiv) {
        reactionsDiv = document.createElement('div');
        reactionsDiv.className = card.classList.contains('notif-card')
          ? 'post-reactions notif-reactions' : 'post-reactions';
        const actionsDiv = card.querySelector('.post-actions, .notif-actions');
        if (actionsDiv) actionsDiv.insertAdjacentElement('beforebegin', reactionsDiv);
      }
      reactionsDiv.innerHTML = reactionsHtml;
    } else if (reactionsDiv) {
      reactionsDiv.remove();
    }
  },

  async _refreshMergedPost(postId, platform, actingAccountId, actingPostId) {
    const cachedPost = this.postCache.get(`${platform}:${postId}`);

    // Find original platform client
    let origClient, origAccount;
    if (cachedPost?.accountId) {
      origClient = this.store.getClient(cachedPost.accountId);
      origAccount = this.store.getById(cachedPost.accountId);
    }
    if (!origClient || origAccount?.platform !== platform) {
      const match = this.store.getAll().find(a =>
        (a.platform === 'mastodon') === (platform === 'mastodon')
      );
      if (match) { origClient = this.store.getClient(match.id); origAccount = match; }
    }

    const actingClient = this.store.getClient(actingAccountId);
    const actingAccount = this.store.getById(actingAccountId);

    // Fetch from both platforms in parallel
    const [origResult, actingResult] = await Promise.allSettled([
      origClient && origAccount
        ? (origAccount.platform === 'mastodon' ? origClient.getStatus(postId) : origClient.getNote(postId))
        : Promise.resolve(null),
      actingClient && actingAccount
        ? (actingAccount.platform === 'mastodon' ? actingClient.getStatus(actingPostId) : actingClient.getNote(actingPostId))
        : Promise.resolve(null),
    ]);

    // Normalize original platform result
    let basePost = cachedPost;
    if (origResult.status === 'fulfilled' && origResult.value && origClient) {
      basePost = origClient.normalizePost(origResult.value);
      basePost.accountId = origAccount.id;
      basePost.accountPlatform = origAccount.platform;
      basePost.themeColor = origAccount.themeColor || null;
      const ownerId = basePost.rebloggedBy ? basePost.rebloggedBy.id : basePost.author.id;
      basePost.isOwn = String(ownerId) === String(origAccount.profile?.id);
    }
    if (!basePost) return;

    // Preserve mergedAccounts
    if (cachedPost?.mergedAccounts) basePost.mergedAccounts = cachedPost.mergedAccounts;

    // Merge data from acting account (e.g. Misskey reactions into Mastodon post)
    if (actingResult.status === 'fulfilled' && actingResult.value && actingClient) {
      const actingPost = actingClient.normalizePost(actingResult.value);
      const dp = basePost.reblog || basePost;
      const adp = actingPost.reblog || actingPost;

      // Merge reactions (always sync — empty means unreacted)
      dp.reactions = { ...(dp.reactions || {}), ...(adp.reactions || {}) };
      dp._misskeyNoteId = adp.id;
      dp._misskeyAccountId = actingAccountId;
      if (adp.reactionEmojis) dp.reactionEmojis = { ...(dp.reactionEmojis || {}), ...adp.reactionEmojis };
      if (adp.emojis) dp.emojis = { ...(dp.emojis || {}), ...adp.emojis };
      if (adp.instanceUrl) {
        dp.instanceUrl = dp.instanceUrl || adp.instanceUrl;
        dp._reactionInstanceUrl = adp.instanceUrl;
        if (!dp._noteIdsByInstance) dp._noteIdsByInstance = {};
        dp._noteIdsByInstance[adp.instanceUrl] = adp.id;
      }

      // Adjust favourites: Mastodon counts custom reactions as favourites
      // Only subtract non-heart reactions — ❤ reactions are equivalent to favourites
      if (dp.reactions && Object.keys(dp.reactions).length > 0 && dp.stats?.favourites > 0) {
        const nonHeartReactions = Object.entries(dp.reactions)
          .filter(([k]) => k !== '❤' && k !== '❤️')
          .reduce((sum, [, c]) => sum + c, 0);
        dp.stats.favourites = Math.max(0, dp.stats.favourites - nonHeartReactions);
      }

      // Merge fav/reaction state — acting account is the truth for myReaction
      if (actingPost.favourited) basePost.favourited = true;
      basePost.myReaction = actingPost.myReaction;
    }

    // Preserve reblogged state (set by executePostAction, not reliable from API)
    if (cachedPost?.reblogged) basePost.reblogged = true;

    // Merge updated stats/state back into cache (preserve replyTo, enrichments)
    if (cachedPost && basePost !== cachedPost) {
      const cdp = cachedPost.reblog || cachedPost;
      const bdp = basePost.reblog || basePost;
      cdp.favourited = bdp.favourited;
      cdp.reblogged = bdp.reblogged;
      cdp.myReaction = bdp.myReaction;
      if (bdp.stats) cdp.stats = { ...cdp.stats, ...bdp.stats };
      // Always sync reactions (clears correctly on unreact)
      if (bdp.reactions) cdp.reactions = bdp.reactions;
      if (bdp.reactionEmojis) cdp.reactionEmojis = { ...(cdp.reactionEmojis || {}), ...bdp.reactionEmojis };
      if (bdp.emojis) cdp.emojis = { ...(cdp.emojis || {}), ...bdp.emojis };
      if (bdp._misskeyNoteId) cdp._misskeyNoteId = bdp._misskeyNoteId;
      if (bdp._misskeyAccountId) cdp._misskeyAccountId = bdp._misskeyAccountId;
      if (bdp._reactionInstanceUrl) cdp._reactionInstanceUrl = bdp._reactionInstanceUrl;
      if (bdp._noteIdsByInstance) {
        cdp._noteIdsByInstance = { ...(cdp._noteIdsByInstance || {}), ...bdp._noteIdsByInstance };
      }
      if (bdp.instanceUrl) cdp.instanceUrl = cdp.instanceUrl || bdp.instanceUrl;
      cachedPost.favourited = basePost.favourited;
      cachedPost.reblogged = basePost.reblogged;
    } else {
      this.postCache.set(`${platform}:${postId}`, basePost);
    }

    // In-place DOM update: only refresh action buttons and counts
    const postData = cachedPost || basePost;
    const dp = postData.reblog || postData;
    const cards = document.querySelectorAll(`.post-card[data-post-id="${postId}"][data-platform="${platform}"]`);
    for (const card of cards) {
      this._updateCardActions(card, dp, postData);
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
        const cachedPost = this.postCache.get(`${editPlatform}:${editPostId}`);
        const mediaIds = cachedPost?.raw?.media_attachments?.map(m => m.id);
        await client.editStatus(editPostId, text, {
          spoilerText: cw,
          mediaIds: mediaIds?.length ? mediaIds : undefined,
        });
      } else {
        await client.editNote(editPostId, text, {
          cw: cw,
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
    const seen = new Set([postId]);
    while (current.reblog && !seen.has(current.reblog.id)) {
      seen.add(current.reblog.id);
      current = current.reblog;
    }
    return current.id;
  },

  getReplyMention(postId, accountId) {
    // Build a set of all "my" account identifiers to exclude from mentions
    const myIdentifiers = new Set();
    for (const acc of this.store.getAll()) {
      if (acc.profile?.username) {
        myIdentifiers.add(acc.profile.username.toLowerCase());
        if (acc.instanceUrl) {
          try {
            const domain = new URL(acc.instanceUrl).hostname;
            myIdentifiers.add(`${acc.profile.username.toLowerCase()}@${domain}`);
          } catch {}
        }
      }
    }
    const isSelf = (acct) => {
      if (!acct) return true;
      return myIdentifiers.has(acct.toLowerCase());
    };

    // Walk up the reply chain to collect all non-self mentions
    const findPost = (id) => {
      for (const [, post] of this.postCache) {
        const dp = post.reblog || post;
        if (post.id === id || dp.id === id) return dp;
      }
      return null;
    };

    const mentions = [];
    const seen = new Set();
    const addMention = (acct) => {
      if (!acct || isSelf(acct)) return;
      const lower = acct.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      mentions.push(`@${acct}`);
    };

    let currentId = postId;
    let depth = 0;
    let isFirst = true;

    while (currentId && depth < 20) {
      const dp = findPost(currentId);
      if (!dp) break;

      // Collect author of this post
      if (dp.author) {
        addMention(dp.author.acct || dp.author.username);
      }

      // On the first post (the one we're replying to), also collect its @mentions
      if (isFirst) {
        // Mastodon: raw.mentions array
        const rawMentions = dp.raw?.mentions || dp.raw?.renote?.mentions;
        if (Array.isArray(rawMentions)) {
          for (const m of rawMentions) {
            if (m.acct) addMention(m.acct);
          }
        }
        isFirst = false;
      }

      // Walk up to parent
      currentId = dp.replyTo?.id || dp.replyToId || null;
      depth++;
    }

    return mentions.length > 0 ? mentions.join(' ') : null;
  },

  async showReactionPicker(anchorElement, actionPostId, platform, accountId, originalPostId) {
    // Close any existing picker
    this.closeReactionPicker();

    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    picker.id = 'reaction-picker-popup';

    // Check if this account supports custom emoji reactions (Misskey forks + Mastodon forks with reaction support)
    const client = this.store.getClient(accountId);
    const account = this.store.getById(accountId);
    const hasCustomEmojis = account && (
      account.platform !== 'mastodon' || client?.supportsReactions
    );

    // Build initial HTML with search + unicode emojis + loading placeholder for instance emojis
    picker.innerHTML = `
      ${hasCustomEmojis ? '<div class="reaction-picker-search"><input type="text" class="reaction-picker-search-input" placeholder="이모지 검색..." /></div>' : ''}
      <div class="reaction-picker-section-label">이모지</div>
      <div class="reaction-picker-grid reaction-picker-unicode">
        ${COMMON_EMOJIS.map(r => `<button class="reaction-picker-item" data-reaction="${r}">${r}</button>`).join('')}
      </div>
      ${hasCustomEmojis ? '<div class="reaction-picker-loading">커스텀 이모지 로딩중...</div>' : ''}
    `;

    if (hasCustomEmojis) setupPickerSearch(picker, 'reaction');

    // Position near button: prefer above, fall back to below if not enough space
    // Clamp to viewport to prevent clipping
    const positionReactionPicker = (r) => {
      const pickerHeight = picker.offsetHeight || 420;
      const spaceAbove = r.top;
      const spaceBelow = window.innerHeight - r.bottom;
      if (spaceAbove >= pickerHeight + 4 || spaceAbove >= spaceBelow) {
        // Place above, clamp so top doesn't go off-screen
        const bottom = window.innerHeight - r.top + 4;
        const top = window.innerHeight - bottom - pickerHeight;
        if (top < 4) {
          picker.style.top = '4px';
          picker.style.bottom = '';
        } else {
          picker.style.bottom = `${bottom}px`;
          picker.style.top = '';
        }
      } else {
        // Place below, clamp so bottom doesn't go off-screen
        const top = r.bottom + 4;
        if (top + pickerHeight > window.innerHeight - 4) {
          picker.style.top = `${Math.max(4, window.innerHeight - pickerHeight - 4)}px`;
        } else {
          picker.style.top = `${top}px`;
        }
        picker.style.bottom = '';
      }
      picker.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 330))}px`;
    };

    // Start hidden to avoid position jump, then fade in after final position
    picker.style.position = 'fixed';
    picker.style.opacity = '0';
    document.body.appendChild(picker);
    positionReactionPicker(anchorElement.getBoundingClientRect());
    // Force layout, then fade in
    picker.offsetHeight; // eslint-disable-line no-unused-expressions
    picker.style.opacity = '';
    this._trackPopupScroll('reactionPicker', picker, anchorElement, positionReactionPicker);

    // Handle emoji click (delegated, works for dynamically added instance emojis too)
    picker.addEventListener('click', async (e) => {
      const item = e.target.closest('.reaction-picker-item');
      if (!item) return;
      const reaction = item.dataset.reaction;
      // Capture emoji URL from <img> tag — needed because Misskey's notes/show
      // may not include reactionEmojis immediately after creating a reaction
      const img = item.querySelector('img');
      const emojiUrl = img ? img.src : null;
      this.closeReactionPicker();
      await this.sendReaction(actionPostId, platform, accountId, reaction, anchorElement, originalPostId, emojiUrl);
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

    // Async: fetch and insert instance custom emojis
    if (hasCustomEmojis && client?.getInstanceEmojis) {
      loadInstanceEmojis({
        client,
        picker,
        pickerId: 'reaction-picker-popup',
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

  async sendReaction(actionPostId, platform, accountId, reaction, btnElement, originalPostId, emojiUrl) {
    const client = this.store.getClient(accountId);
    if (!client) return;
    const refreshPostId = originalPostId || actionPostId;
    const isCrossInstance = originalPostId && originalPostId !== actionPostId;

    const cachedPost = this.postCache.get(`${platform}:${refreshPostId}`);

    // --- Optimistic update: immediately reflect the reaction in UI ---
    let prevReactions, prevMyReaction, prevReactionEmojis;
    if (cachedPost) {
      const dp = cachedPost.reblog || cachedPost;
      // Save previous state for rollback on error
      prevReactions = dp.reactions ? { ...dp.reactions } : {};
      prevMyReaction = dp.myReaction;
      prevReactionEmojis = dp.reactionEmojis ? { ...dp.reactionEmojis } : {};

      // Remove old reaction count if replacing (Misskey single-reaction mode)
      if (dp.myReaction && platform !== 'mastodon') {
        const oldKey = dp.myReaction;
        if (dp.reactions && dp.reactions[oldKey] > 0) {
          dp.reactions[oldKey] = Math.max(0, dp.reactions[oldKey] - 1);
          if (dp.reactions[oldKey] === 0) delete dp.reactions[oldKey];
        }
      }

      // Apply new reaction
      if (!dp.reactions) dp.reactions = {};
      dp.reactions[reaction] = (dp.reactions[reaction] || 0) + 1;
      dp.myReaction = reaction;

      // Pre-populate emoji URL for custom emoji
      if (emojiUrl) {
        const match = reaction.match(/^:(.+):$/);
        if (match) {
          const name = match[1];
          const nameBase = name.replace(/@\.$/, '');
          if (!dp.reactionEmojis) dp.reactionEmojis = {};
          dp.reactionEmojis[nameBase] = emojiUrl;
          dp.reactionEmojis[nameBase + '@.'] = emojiUrl;
        }
      }

      // Immediately re-render all cards showing this post
      this._rerenderCachedPost(refreshPostId, platform);
    }

    btnElement.classList.add('active', 'just-activated');
    setTimeout(() => btnElement.classList.remove('just-activated'), 600);

    // --- API call (background) ---
    try {
      // Misskey only allows one reaction — delete old before adding new
      if (prevMyReaction && platform !== 'mastodon') {
        await client.deleteReaction(actionPostId);
      }
      await client.createReaction(actionPostId, reaction);

      // Confirm with server data (silent, non-blocking)
      if (isCrossInstance) {
        this._refreshMergedPost(refreshPostId, platform, accountId, actionPostId);
      } else {
        this.refreshSinglePost(refreshPostId, platform, accountId);
      }
    } catch (err) {
      console.error('Reaction failed:', err);
      // Rollback optimistic update on failure
      if (cachedPost) {
        const dp = cachedPost.reblog || cachedPost;
        dp.reactions = prevReactions;
        dp.myReaction = prevMyReaction;
        dp.reactionEmojis = prevReactionEmojis;
        this._rerenderCachedPost(refreshPostId, platform);
      }
      btnElement.classList.remove('active');
      this.showToast('리액션 실패', 'error');
    }
  },

  /**
   * Re-render all visible cards for a cached post across all columns.
   */
  _rerenderCachedPost(postId, platform) {
    const cacheKey = `${platform}:${postId}`;
    const cachedPost = this.postCache.get(cacheKey);
    if (!cachedPost) return;

    const dp = cachedPost.reblog || cachedPost;
    const uri = dp.canonicalUri;
    const selectors = [
      `.post-card[data-platform="${CSS.escape(platform)}"][data-post-id="${CSS.escape(postId)}"]`,
    ];
    if (uri) selectors.push(`.post-card[data-canonical-uri="${CSS.escape(uri)}"]`);

    for (const col of this.columnsContainer.querySelectorAll('.column')) {
      if (col.dataset.columnType === 'notifications') continue;
      const content = col.querySelector('.column-content');
      if (!content) continue;
      const isThread = col.dataset.columnType === 'thread';

      for (const sel of selectors) {
        for (const card of content.querySelectorAll(sel)) {
          if (!card.isConnected) continue;
          const cardPost = this.postCache.get(`${card.dataset.platform}:${card.dataset.postId}`) || cachedPost;
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
    // Toggle: if picker is already open for this anchor, just close it
    if (this._activePickerAnchor === anchorElement && document.getElementById('account-picker-popup')) {
      this.closeAccountPicker();
      return;
    }
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
      const dotColor = this._accountColor(account) || '';
      const dotStyle = dotColor ? `style="background:${dotColor}"` : '';
      html += `
        <button class="account-picker-item${isPreferred ? ' preferred' : ''}" data-account-id="${account.id}"${isPreferred && dotColor ? ` style="border-left-color:${dotColor}"` : ''}>
          <img src="${p.avatarUrl || ''}" alt="" onerror="this.style.display='none'">
          <span class="picker-name">${escapeHtml(p.displayName)}</span>
          <span class="platform-dot ${account.software || account.platform}" ${dotStyle}></span>
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
    // Start hidden to avoid position jump, then fade in after final position
    picker.style.opacity = '0';
    document.body.appendChild(picker);
    positionAccountPicker(anchorElement.getBoundingClientRect());
    picker.offsetHeight; // eslint-disable-line no-unused-expressions
    picker.style.opacity = '';
    this._trackPopupScroll('accountPicker', picker, anchorElement, positionAccountPicker);
    this._activePickerAnchor = anchorElement;

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
    this._activePickerAnchor = null;
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

      // Check if this Mastodon post has a Misskey note ID (reactions fetched from Misskey)
      const cachedPost = this.postCache.get(`${platform}:${postId}`);
      const displayPost = cachedPost ? (cachedPost.reblog || cachedPost) : null;
      const misskeyNoteId = displayPost?._misskeyNoteId;
      const misskeyAccountId = displayPost?._misskeyAccountId;

      // Determine if this is a heart/favourite badge click vs emoji reaction badge click
      const isFavourite = !reaction || reaction === 'favourite';

      if (platform === 'mastodon' && isFavourite) {
        // Heart/favourite badge on Mastodon: always use Mastodon getFavouritedBy
        const favUsers = await client.getFavouritedBy(postId);
        if (!favUsers || favUsers.length === 0) {
          popup.innerHTML = '<div class="reaction-users-loading">좋아요한 사용자가 없습니다.</div>';
        } else {
          users = favUsers.map(u => {
            const normalized = client.normalizeUser(u);
            return {
              displayNameHtml: normalized.displayNameHtml,
              username: normalized.acct || normalized.username,
              avatarUrl: normalized.avatarUrl || '',
            };
          });
          popup.innerHTML = this._renderReactionUsersHtml(users);
        }
      } else if (platform === 'mastodon' && misskeyNoteId) {
        // Emoji reaction badge on merged Mastodon+Misskey post: use Misskey API
        const mkClient = this.store.getClient(misskeyAccountId) ||
          this.store.getClient(this.store.getAll().find(a => a.platform !== 'mastodon')?.id);
        if (mkClient) {
          let reactions = await mkClient.getReactions(misskeyNoteId, reaction || undefined);
          if (reactions.length === 0 && reaction) {
            const allReactions = await mkClient.getReactions(misskeyNoteId);
            const normalize = (r) => r ? r.replace(/@\.:$/, ':').replace(/@\.$/, '') : '';
            const target = normalize(reaction);
            reactions = allReactions.filter(r => {
              const rType = normalize(r.type || '');
              return rType === target || r.type === reaction;
            });
          }
          users = reactions.map(r => {
            const normalized = r.user ? mkClient.normalizeUser(r.user) : null;
            return {
              displayNameHtml: normalized?.displayNameHtml || escapeHtml(r.user?.name || r.user?.username || '?'),
              username: normalized?.username || r.user?.username || '?',
              avatarUrl: normalized?.avatarUrl || r.user?.avatarUrl || '',
              reaction: r.type || '',
            };
          });
        }
        if (users.length === 0) {
          popup.innerHTML = '<div class="reaction-users-loading">리액션한 사용자가 없습니다.</div>';
        } else {
          popup.innerHTML = this._renderReactionUsersHtml(users);
        }
      } else if (platform === 'mastodon' && client.supportsReactions && !isFavourite) {
        // Mastodon fork with reaction support (Hollo, Fedibird, Pleroma, Akkoma): use reaction API
        const reactions = await client.getReactions(postId, reaction || undefined);
        users = reactions.map(r => {
          const normalized = r.user ? client.normalizeUser(r.user) : null;
          return {
            displayNameHtml: normalized?.displayNameHtml || escapeHtml(r.user?.display_name || r.user?.username || '?'),
            username: normalized?.acct || normalized?.username || r.user?.username || '?',
            avatarUrl: normalized?.avatarUrl || r.user?.avatar || '',
            reaction: r.type || '',
          };
        });
        if (users.length === 0) {
          popup.innerHTML = '<div class="reaction-users-loading">리액션한 사용자가 없습니다.</div>';
        } else {
          popup.innerHTML = this._renderReactionUsersHtml(users);
        }
      } else if (platform === 'mastodon') {
        // Standard Mastodon or favourite badge: use getFavouritedBy
        const favUsers = await client.getFavouritedBy(postId);
        if (!favUsers || favUsers.length === 0) {
          popup.innerHTML = '<div class="reaction-users-loading">좋아요한 사용자가 없습니다.</div>';
        } else {
          users = favUsers.map(u => {
            const normalized = client.normalizeUser(u);
            return {
              displayNameHtml: normalized.displayNameHtml,
              username: normalized.acct || normalized.username,
              avatarUrl: normalized.avatarUrl || '',
            };
          });
          popup.innerHTML = this._renderReactionUsersHtml(users);
        }
      } else {
        // Misskey platform: use notes/reactions
        const reactionType = isFavourite ? '❤' : reaction;
        let reactions = await client.getReactions(postId, reactionType || undefined);

        // Fallback: if type-filtered query returned empty, retry without filter
        // and match client-side (handles custom emoji format mismatches like :emoji@.: vs :emoji:)
        if (reactions.length === 0 && reactionType) {
          const allReactions = await client.getReactions(postId);
          const normalize = (r) => r ? r.replace(/@\.:$/, ':').replace(/@\.$/, '') : '';
          const target = normalize(reactionType);
          reactions = allReactions.filter(r => {
            const rType = normalize(r.type || '');
            return rType === target || r.type === reactionType;
          });
        }

        users = reactions.map(r => {
          const normalized = r.user ? client.normalizeUser(r.user) : null;
          return {
            displayNameHtml: normalized?.displayNameHtml || escapeHtml(r.user?.name || r.user?.username || '?'),
            username: normalized?.username || r.user?.username || '?',
            avatarUrl: normalized?.avatarUrl || r.user?.avatarUrl || '',
            reaction: r.type || '',
          };
        });

        if (users.length === 0) {
          popup.innerHTML = '<div class="reaction-users-loading">리액션한 사용자가 없습니다.</div>';
        } else {
          popup.innerHTML = this._renderReactionUsersHtml(users);
        }
      }
    } catch (e) {
      const msg = e?.message || '';
      const is429 = msg.includes('429') || msg.includes('RATE_LIMIT');
      popup.innerHTML = `<div class="reaction-users-loading">${is429 ? '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' : '게시물 조회 실패'}</div>`;
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

  _renderReactionUsersHtml(users) {
    let html = '<div class="reaction-users-list">';
    for (const user of users) {
      html += `
        <div class="reaction-user-item">
          <img class="reaction-user-avatar" src="${escapeHtml(user.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
          <span class="reaction-user-name">${user.displayNameHtml}</span>
          <span class="reaction-user-handle">@${escapeHtml(user.username)}</span>
        </div>
      `;
    }
    html += '</div>';
    return html;
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
