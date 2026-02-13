/**
 * Compose Mixin
 * Handles the compose modal: opening, emoji picker, file attachments, and submission
 */
import { escapeHtml } from '../ui/utils.js';
import { COMMON_EMOJIS, loadInstanceEmojis, setupPickerSearch } from '../ui/emoji-picker.js';

export const ComposeMixin = {

  openComposeModal(replyToId = null, preferredAccountId = null, restrictedAccounts = null) {
    const accounts = restrictedAccounts || this.store.getAll();
    if (accounts.length === 0) return;

    // Build account toggle buttons
    this.composeSelectedAccounts.clear();
    this.composeAccountsContainer.innerHTML = '';

    for (const account of accounts) {
      const p = account.profile;
      const btn = document.createElement('button');
      btn.className = 'compose-account-toggle';
      btn.dataset.accountId = account.id;
      const dotColor = account.themeColor || this._instanceColor(account.instanceUrl);
      const dotStyle = dotColor ? `style="background:${dotColor}"` : '';
      btn.innerHTML = `
        <img class="compose-account-avatar" src="${p.avatarUrl || ''}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
        <span class="compose-account-name">${escapeHtml(p.displayName)}</span>
        <span class="platform-dot ${account.software || account.platform}" ${dotStyle}></span>
      `;

      // In restricted mode (multi-account column), no pre-selection unless explicitly preferred
      // In normal mode, pre-select preferred account or first by default
      const isFirst = accounts.indexOf(account) === 0;
      const shouldPreSelect = restrictedAccounts
        ? (preferredAccountId && preferredAccountId === account.id)
        : (preferredAccountId === account.id || (!preferredAccountId && isFirst));
      if (shouldPreSelect) {
        btn.classList.add('active');
        this.composeSelectedAccounts.add(account.id);
      }

      btn.addEventListener('click', () => {
        if (this.composeSelectedAccounts.has(account.id)) {
          this.composeSelectedAccounts.delete(account.id);
          btn.classList.remove('active');
        } else {
          this.composeSelectedAccounts.add(account.id);
          btn.classList.add('active');
        }
        this._syncComposeVisibility();
      });

      this.composeAccountsContainer.appendChild(btn);
    }

    // Reset
    this.composeCw.value = '';
    this.composeText.value = '';
    this.composeFiles = [];
    this.composeImagePreview.innerHTML = '';
    this.composeSensitive = false;
    this.btnComposeSensitive.classList.remove('active');
    this._syncComposeVisibility();
    this.composeCharHint.textContent = '';
    this.composeError.style.display = 'none';
    this.btnComposeSubmit.disabled = false;
    this.btnComposeSubmit.textContent = '게시';
    delete this.composeText.dataset.editPostId;
    delete this.composeText.dataset.editPlatform;
    delete this.composeText.dataset.editAccountId;
    delete this.composeText.dataset.quoteId;
    delete this.composeText.dataset.quotePlatform;
    delete this.composeText.dataset.quoteUrl;
    delete this.composeText.dataset.quoteAccountId;
    delete this.composeText.dataset.replyCanonicalUri;
    delete this.composeText.dataset.replyAccountId;
    this._composeEmojiMap = {};
    this._composeEmojiMapAccountIds = new Set();

    const replyCtx = document.getElementById('compose-reply-context');
    if (replyToId) {
      this.composeText.dataset.replyTo = replyToId;
      // Store canonical URI for cross-instance reply resolution
      const replySourcePost = this.findCachedPost(replyToId);
      if (replySourcePost) {
        const dpReply = replySourcePost.reblog || replySourcePost;
        const canonicalUri = dpReply.canonicalUri || dpReply.url;
        if (canonicalUri) this.composeText.dataset.replyCanonicalUri = canonicalUri;
        if (replySourcePost.accountId) this.composeText.dataset.replyAccountId = replySourcePost.accountId;
      }
      this.composeText.placeholder = '답글을 작성하세요...';
      this.composeTitle.textContent = '답글 작성';

      // Auto-fill mention of the original post author
      const replyMention = this.getReplyMention(replyToId, preferredAccountId);
      if (replyMention) {
        this.composeText.value = replyMention + ' ';
      }

      // Show original post in reply context
      const origPost = this.findCachedPost(replyToId);
      if (origPost) {
        const dp = origPost.reblog || origPost;
        const authorName = dp.author?.displayNameHtml || escapeHtml(dp.author?.displayName || '');
        const avatarHtml = dp.author?.avatarUrl
          ? `<img class="compose-reply-context-avatar" src="${escapeHtml(dp.author.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
          : '';
        replyCtx.innerHTML = `
          <div class="compose-reply-context-header">
            ${avatarHtml}
            <span class="compose-reply-context-name">${authorName}</span>
            <span class="compose-reply-context-label">의 글에 답글</span>
          </div>
          <div class="compose-reply-context-body">${dp.content || ''}</div>
        `;
        replyCtx.style.display = '';

        // Default reply visibility to the original post's visibility
        if (dp.visibility) {
          this.composeVisibilityValue = dp.visibility;
          const opt = this._composeVisibilityOptions.find(o => o.value === dp.visibility);
          if (opt) {
            this.btnComposeVisibility.innerHTML = this._getVisibilitySvg(opt.icon);
            this.btnComposeVisibility.title = `공개 범위: ${opt.label}`;
          }
        }
      } else {
        replyCtx.style.display = 'none';
      }
    } else {
      delete this.composeText.dataset.replyTo;
      this.composeText.placeholder = '무슨 일이 일어나고 있나요?';
      this.composeTitle.textContent = '새 글 작성';
      replyCtx.style.display = 'none';
      replyCtx.innerHTML = '';
    }

    // Reset emoji overlay
    const textWrap = document.querySelector('.compose-text-wrap');
    const overlay = document.getElementById('compose-text-overlay');
    if (textWrap) textWrap.classList.remove('emoji-active');
    if (overlay) overlay.innerHTML = '';

    // Setup live emoji preview on input + scroll sync
    if (!this._composeEmojiInputHandler) {
      this._composeEmojiInputHandler = () => this._updateComposeEmojiPreview();
      this.composeText.addEventListener('input', this._composeEmojiInputHandler);
      this._composeScrollSyncHandler = () => {
        const ov = document.getElementById('compose-text-overlay');
        if (ov) ov.scrollTop = this.composeText.scrollTop;
      };
      this.composeText.addEventListener('scroll', this._composeScrollSyncHandler, { passive: true });
    }

    this.openModal(this.modalCompose);
    this.composeText.focus();
  },

  _getAccountVisibility(accountId) {
    try {
      const data = JSON.parse(localStorage.getItem('starship_visibility') || '{}');
      return data[accountId] || 'public';
    } catch { return 'public'; }
  },

  _saveAccountVisibility(accountId, visibility) {
    try {
      const data = JSON.parse(localStorage.getItem('starship_visibility') || '{}');
      data[accountId] = visibility;
      localStorage.setItem('starship_visibility', JSON.stringify(data));
    } catch {}
  },

  _composeVisibilityOptions: [
    { value: 'public', label: '공개', desc: '모든 유저에게 공개', icon: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' },
    { value: 'home', label: '홈', desc: '홈 타임라인에만 공개', icon: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' },
    { value: 'followers', label: '팔로워', desc: '팔로워에게만 공개', icon: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' },
    { value: 'direct', label: '다이렉트', desc: '지정한 유저에게만 공개', icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>' },
  ],

  _getVisibilitySvg(iconPath, size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>`;
  },

  _syncComposeVisibility() {
    const firstId = [...this.composeSelectedAccounts][0];
    const vis = firstId ? this._getAccountVisibility(firstId) : 'public';
    this.composeVisibilityValue = vis;
    const opt = this._composeVisibilityOptions.find(o => o.value === vis);
    if (opt) {
      this.btnComposeVisibility.innerHTML = this._getVisibilitySvg(opt.icon);
      this.btnComposeVisibility.title = `공개 범위: ${opt.label}`;
    }
  },

  showComposeVisibilityPicker() {
    this.closeComposeVisibilityPicker();

    const picker = document.createElement('div');
    picker.className = 'compose-visibility-picker';
    picker.id = 'compose-visibility-picker-popup';

    picker.innerHTML = this._composeVisibilityOptions.map(opt => `
      <button class="compose-visibility-option${opt.value === this.composeVisibilityValue ? ' active' : ''}" data-value="${opt.value}">
        <span class="compose-visibility-icon">${this._getVisibilitySvg(opt.icon)}</span>
        <span class="compose-visibility-info">
          <span class="compose-visibility-label">${opt.label}</span>
          <span class="compose-visibility-desc">${opt.desc}</span>
        </span>
      </button>
    `).join('');

    // Position above the button
    const btnRect = this.btnComposeVisibility.getBoundingClientRect();
    picker.style.bottom = `${window.innerHeight - btnRect.top + 4}px`;
    picker.style.left = `${Math.max(8, Math.min(btnRect.left, window.innerWidth - 240))}px`;

    document.body.appendChild(picker);

    picker.addEventListener('click', (e) => {
      const item = e.target.closest('.compose-visibility-option');
      if (!item) return;
      const val = item.dataset.value;
      this.composeVisibilityValue = val;
      const opt = this._composeVisibilityOptions.find(o => o.value === val);
      if (opt) {
        this.btnComposeVisibility.innerHTML = this._getVisibilitySvg(opt.icon);
        this.btnComposeVisibility.title = `공개 범위: ${opt.label}`;
      }
      this.closeComposeVisibilityPicker();
    });

    // Outside click to close
    setTimeout(() => {
      const handler = (e) => {
        if (!picker.contains(e.target) && !this.btnComposeVisibility.contains(e.target)) {
          this.closeComposeVisibilityPicker();
        }
      };
      document.addEventListener('click', handler);
      this._composeVisibilityClose = handler;
    }, 0);
  },

  closeComposeVisibilityPicker() {
    const existing = document.getElementById('compose-visibility-picker-popup');
    if (existing) existing.remove();
    if (this._composeVisibilityClose) {
      document.removeEventListener('click', this._composeVisibilityClose);
      this._composeVisibilityClose = null;
    }
  },

  _updateComposeWordCount() {
    const text = this.composeText.value;
    if (!text.trim()) {
      this.composeCharHint.textContent = '';
      return;
    }
    const chars = text.length;
    const words = text.trim().split(/\s+/).length;
    this.composeCharHint.textContent = `${chars}자 · ${words}단어`;
  },

  async _updateComposeEmojiPreview() {
    const text = this.composeText.value;
    const textWrap = document.querySelector('.compose-text-wrap');
    const overlay = document.getElementById('compose-text-overlay');
    if (!overlay || !textWrap) return;

    // Check if text contains custom emoji patterns :name:
    const emojiPattern = /:([a-zA-Z0-9_\-]+(?:@[\w.\-]+)?):/g;
    if (!emojiPattern.test(text)) {
      textWrap.classList.remove('emoji-active');
      overlay.innerHTML = '';
      return;
    }

    // Get emoji maps from selected accounts
    const emojiMap = await this._getComposeEmojiMap();
    if (Object.keys(emojiMap).length === 0) {
      textWrap.classList.remove('emoji-active');
      return;
    }

    // Resolve emojis in text
    let html = escapeHtml(text);
    let hasCustomEmoji = false;
    html = html.replace(/:([a-zA-Z0-9_\-]+(?:@[\w.\-]+)?):/g, (match, name) => {
      const url = emojiMap[name];
      if (url) {
        hasCustomEmoji = true;
        return `<img class="inline-emoji" src="${escapeHtml(url)}" alt=":${name}:" title=":${name}:" referrerpolicy="no-referrer">`;
      }
      return match;
    });

    if (hasCustomEmoji) {
      overlay.innerHTML = html;
      textWrap.classList.add('emoji-active');
      overlay.scrollTop = this.composeText.scrollTop;
    } else {
      textWrap.classList.remove('emoji-active');
      overlay.innerHTML = '';
    }
  },

  async _getComposeEmojiMap() {
    if (!this._composeEmojiMap) this._composeEmojiMap = {};
    if (!this._composeEmojiMapAccountIds) this._composeEmojiMapAccountIds = new Set();

    // Check if we need to refresh the emoji map (new accounts selected)
    let needsFetch = false;
    for (const id of this.composeSelectedAccounts) {
      if (!this._composeEmojiMapAccountIds.has(id)) {
        needsFetch = true;
        break;
      }
    }

    if (needsFetch) {
      const fetchPromises = [];
      for (const id of this.composeSelectedAccounts) {
        if (this._composeEmojiMapAccountIds.has(id)) continue;
        this._composeEmojiMapAccountIds.add(id);
        const client = this.store.getClient(id);
        if (!client?.getInstanceEmojis) continue;
        fetchPromises.push(
          client.getInstanceEmojis().then(emojis => {
            for (const e of emojis) {
              if (e.name && e.url) {
                this._composeEmojiMap[e.name] = e.url;
              }
            }
          }).catch(err => console.warn('Instance emoji fetch failed:', err))
        );
      }
      if (fetchPromises.length > 0) await Promise.all(fetchPromises);
    }

    return this._composeEmojiMap;
  },

  showComposeEmojiPicker() {
    this.closeComposeEmojiPicker();

    const picker = document.createElement('div');
    picker.className = 'compose-emoji-picker';
    picker.id = 'compose-emoji-picker-popup';

    // Determine first selected account with instance emojis
    let emojiAccountId = null;
    for (const id of this.composeSelectedAccounts) {
      const acct = this.store.getById(id);
      if (acct) {
        const client = this.store.getClient(id);
        if (client?.getInstanceEmojis) {
          emojiAccountId = id;
          break;
        }
      }
    }

    picker.innerHTML = `
      ${emojiAccountId ? '<div class="reaction-picker-search"><input type="text" class="reaction-picker-search-input" placeholder="이모지 검색..." /></div>' : ''}
      <div class="reaction-picker-section-label">이모지</div>
      <div class="reaction-picker-grid reaction-picker-unicode">
        ${COMMON_EMOJIS.map(r => `<button class="reaction-picker-item" data-emoji="${r}">${r}</button>`).join('')}
      </div>
      ${emojiAccountId ? '<div class="reaction-picker-loading">커스텀 이모지 로딩중...</div>' : ''}
    `;

    if (emojiAccountId) setupPickerSearch(picker, 'emoji');

    // Position near the emoji button: prefer above, fall back to below
    const btnRect = this.btnComposeEmoji.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.left = `${Math.max(8, Math.min(btnRect.left, window.innerWidth - 330))}px`;

    document.body.appendChild(picker);

    const pickerHeight = picker.offsetHeight || 420;
    const spaceAbove = btnRect.top;
    const spaceBelow = window.innerHeight - btnRect.bottom;
    if (spaceAbove >= pickerHeight + 4 || spaceAbove >= spaceBelow) {
      picker.style.bottom = `${window.innerHeight - btnRect.top + 4}px`;
    } else {
      picker.style.top = `${btnRect.bottom + 4}px`;
    }

    // Insert emoji into textarea
    const insertEmoji = (text) => {
      const ta = this.composeText;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.substring(0, start) + text + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + text.length;
      ta.focus();
    };

    picker.addEventListener('click', (e) => {
      const item = e.target.closest('.reaction-picker-item, .compose-emoji-item');
      if (!item) return;
      const emoji = item.dataset.emoji;
      if (emoji) {
        insertEmoji(emoji);
        this.closeComposeEmojiPicker();
      }
    });

    // Outside click to close
    setTimeout(() => {
      const handler = (e) => {
        if (!picker.contains(e.target) && !this.btnComposeEmoji.contains(e.target)) {
          this.closeComposeEmojiPicker();
        }
      };
      document.addEventListener('click', handler);
      this._composeEmojiClose = handler;
    }, 0);

    // Fetch instance emojis async
    if (emojiAccountId) {
      const client = this.store.getClient(emojiAccountId);
      if (client?.getInstanceEmojis) {
        loadInstanceEmojis({
          client,
          picker,
          pickerId: 'compose-emoji-picker-popup',
          itemClass: 'compose-emoji-item',
          dataAttr: 'emoji',
        });
      }
    }
  },

  closeComposeEmojiPicker() {
    const existing = document.getElementById('compose-emoji-picker-popup');
    if (existing) existing.remove();
    if (this._composeEmojiClose) {
      document.removeEventListener('click', this._composeEmojiClose);
      this._composeEmojiClose = null;
    }
  },

  handleComposeFileSelect() {
    const files = Array.from(this.composeFilesInput.files);
    for (const file of files) {
      if (this.composeFiles.length >= 4) break;
      this.composeFiles.push(file);
    }
    this.composeFilesInput.value = '';
    this.renderComposeImagePreview();
  },

  renderComposeImagePreview() {
    // Revoke old ObjectURLs before clearing
    this.composeImagePreview.querySelectorAll('img').forEach(img => {
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    });
    this.composeImagePreview.innerHTML = '';
    this.composeFiles.forEach((file, idx) => {
      const item = document.createElement('div');
      item.className = 'preview-item';

      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'preview-remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        this.composeFiles.splice(idx, 1);
        this.renderComposeImagePreview();
      });

      item.appendChild(img);
      item.appendChild(removeBtn);
      this.composeImagePreview.appendChild(item);
    });
  },

  async handleComposeSubmit() {
    // Edit mode
    if (this.composeText.dataset.editPostId) {
      return this.handleEditSubmit();
    }

    const selectedIds = [...this.composeSelectedAccounts];
    const text = this.composeText.value.trim();
    const cw = this.composeCw.value.trim();
    const visibility = this.composeVisibilityValue;
    const replyToId = this.composeText.dataset.replyTo;
    const replyCanonicalUri = this.composeText.dataset.replyCanonicalUri;
    const replyAccountId = this.composeText.dataset.replyAccountId;
    const quoteId = this.composeText.dataset.quoteId;
    const quoteUrl = this.composeText.dataset.quoteUrl;
    const quoteAccountId = this.composeText.dataset.quoteAccountId;

    if (selectedIds.length === 0) {
      this.composeError.textContent = '게시할 계정을 하나 이상 선택하세요.';
      this.composeError.style.display = 'block';
      return;
    }

    if (!text && this.composeFiles.length === 0) {
      this.composeError.textContent = '내용을 입력하거나 이미지를 추가하세요.';
      this.composeError.style.display = 'block';
      return;
    }

    this.btnComposeSubmit.disabled = true;
    this.btnComposeSubmit.textContent = '게시 중...';
    this.composeError.style.display = 'none';

    const errors = [];

    for (const accountId of selectedIds) {
      const account = this.store.getById(accountId);
      const client = this.store.getClient(accountId);
      if (!account || !client) continue;

      try {
        // Upload files per account
        let fileIds = [];
        if (this.composeFiles.length > 0) {
          for (const file of this.composeFiles) {
            if (account.platform === 'mastodon') {
              const result = await client.uploadMedia(file);
              fileIds.push(result.id);
            } else {
              const result = await client.uploadFile(file);
              fileIds.push(result.id);
            }
          }
        }

        // Cross-instance reply resolution: resolve the post on this account's instance
        let resolvedReplyId = replyToId;
        if (replyToId && replyCanonicalUri) {
          const replyAccount = replyAccountId ? this.store.getById(replyAccountId) : null;
          if (replyAccount && replyAccount.instanceUrl !== account.instanceUrl) {
            try {
              const resolved = await client.resolveUrl(replyCanonicalUri);
              if (resolved) {
                resolvedReplyId = resolved.id;
              } else {
                errors.push(`${account.profile.displayName}: 답글 대상을 찾을 수 없습니다.`);
                continue;
              }
            } catch (err) {
              errors.push(`${account.profile.displayName}: 답글 대상 조회 실패: ${err.message}`);
              continue;
            }
          }
        }

        // Cross-instance quote resolution
        let resolvedQuoteId = quoteId;
        if (quoteId && quoteUrl) {
          const qAccount = quoteAccountId ? this.store.getById(quoteAccountId) : null;
          if (qAccount && qAccount.instanceUrl !== account.instanceUrl) {
            try {
              const resolved = await client.resolveUrl(quoteUrl);
              if (resolved) resolvedQuoteId = resolved.id;
            } catch { /* fall through, URL will be appended as text */ }
          }
        }

        // Create post
        if (account.platform === 'mastodon') {
          // For Mastodon 4.3+: use native quote_id parameter
          // Only append quote URL as text fallback if quote_id couldn't be resolved
          let statusText = text;
          if (quoteUrl && !resolvedQuoteId && !text.includes(quoteUrl)) {
            statusText = text + '\n\n' + quoteUrl;
          }
          const mastodonVisibility = ({ public: 'public', home: 'unlisted', followers: 'private', direct: 'direct' })[visibility] || 'public';
          await client.createStatus(statusText, {
            spoilerText: cw || undefined,
            sensitive: this.composeSensitive || undefined,
            visibility: mastodonVisibility,
            mediaIds: fileIds.length > 0 ? fileIds : undefined,
            inReplyToId: resolvedReplyId || undefined,
            quoteId: resolvedQuoteId || undefined,
          });
        } else {
          // Misskey: mark uploaded files as sensitive
          if (this.composeSensitive && fileIds.length > 0) {
            for (const fid of fileIds) {
              await client.updateFile(fid, { isSensitive: true }).catch(() => {});
            }
          }
          const misskeyVisibility = ({ public: 'public', home: 'home', followers: 'followers', direct: 'specified' })[visibility] || 'public';
          await client.createNote(text, {
            cw: cw || undefined,
            visibility: misskeyVisibility,
            fileIds: fileIds.length > 0 ? fileIds : undefined,
            replyId: resolvedReplyId || undefined,
            renoteId: resolvedQuoteId || undefined,
          });
        }
      } catch (err) {
        errors.push(`${account.profile.displayName}: ${err.message}`);
      }
    }

    if (errors.length > 0) {
      this.composeError.textContent = `일부 계정 게시 실패: ${errors.join('; ')}`;
      this.composeError.style.display = 'block';
    }

    if (errors.length < selectedIds.length) {
      // Save visibility per account
      for (const accountId of selectedIds) {
        this._saveAccountVisibility(accountId, visibility);
      }
      this.closeModal(this.modalCompose);
      // Skip "all" column on post-compose refresh: the new post hasn't federated
      // to other instances yet, so showing it immediately would display it without
      // proper account merging. The next auto-refresh will pick it up with dedup.
      this.refreshAll(false, { skipColumnTypes: ['all'] });
    }

    this.btnComposeSubmit.disabled = false;
    this.btnComposeSubmit.textContent = '게시';
  },

};
