/**
 * Compose Mixin
 * Handles the compose modal: opening, emoji picker, file attachments, and submission
 */

export const ComposeMixin = {

  openComposeModal(replyToId = null, preferredAccountId = null) {
    const accounts = this.store.getAll();
    if (accounts.length === 0) return;

    // Build account toggle buttons
    this.composeSelectedAccounts.clear();
    this.composeAccountsContainer.innerHTML = '';

    for (const account of accounts) {
      const p = account.profile;
      const btn = document.createElement('button');
      btn.className = 'compose-account-toggle';
      btn.dataset.accountId = account.id;
      const dotStyle = account.themeColor ? `style="background:${account.themeColor}"` : '';
      btn.innerHTML = `
        <img class="compose-account-avatar" src="${p.avatarUrl || ''}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
        <span class="compose-account-name">${this.escapeHtml(p.displayName)}</span>
        <span class="platform-dot ${account.platform}" ${dotStyle}></span>
      `;

      // Pre-select preferred account, or first account by default
      const isFirst = accounts.indexOf(account) === 0;
      if (preferredAccountId === account.id || (!preferredAccountId && isFirst)) {
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
    this.composeVisibility.value = 'public';
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
    this._composeEmojiMap = {};
    this._composeEmojiMapAccountIds = new Set();

    const replyCtx = document.getElementById('compose-reply-context');
    if (replyToId) {
      this.composeText.dataset.replyTo = replyToId;
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
        const authorName = dp.author?.displayNameHtml || this.escapeHtml(dp.author?.displayName || '');
        const avatarHtml = dp.author?.avatarUrl
          ? `<img class="compose-reply-context-avatar" src="${this.escapeHtml(dp.author.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
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
      this.composeText.addEventListener('scroll', () => {
        const ov = document.getElementById('compose-text-overlay');
        if (ov) ov.scrollTop = this.composeText.scrollTop;
      });
    }

    this.openModal(this.modalCompose);
    this.composeText.focus();
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
    let html = this.escapeHtml(text);
    let hasCustomEmoji = false;
    html = html.replace(/:([a-zA-Z0-9_\-]+(?:@[\w.\-]+)?):/g, (match, name) => {
      const url = emojiMap[name];
      if (url) {
        hasCustomEmoji = true;
        return `<img class="inline-emoji" src="${this.escapeHtml(url)}" alt=":${name}:" title=":${name}:" referrerpolicy="no-referrer">`;
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
      for (const id of this.composeSelectedAccounts) {
        if (this._composeEmojiMapAccountIds.has(id)) continue;
        this._composeEmojiMapAccountIds.add(id);
        const client = this.store.getClient(id);
        if (!client?.getInstanceEmojis) continue;
        try {
          const emojis = await client.getInstanceEmojis();
          for (const e of emojis) {
            if (e.name && e.url) {
              this._composeEmojiMap[e.name] = e.url;
            }
          }
        } catch {}
      }
    }

    return this._composeEmojiMap;
  },

  showComposeEmojiPicker() {
    this.closeComposeEmojiPicker();

    const picker = document.createElement('div');
    picker.className = 'compose-emoji-picker';
    picker.id = 'compose-emoji-picker-popup';

    // Common unicode emojis
    const commonReactions = [
      '👍', '❤️', '😆', '🎉', '😮', '🤔', '😢', '👀',
      '🔥', '⭐', '💯', '✨', '😂', '🙏', '💕', '😊',
    ];

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
      <div class="reaction-picker-section-label">이모지</div>
      <div class="reaction-picker-grid reaction-picker-unicode">
        ${commonReactions.map(r => `<button class="reaction-picker-item" data-emoji="${r}">${r}</button>`).join('')}
      </div>
      ${emojiAccountId ? '<div class="reaction-picker-loading">커스텀 이모지 로딩중...</div>' : ''}
    `;

    // Position above the emoji button
    const btnRect = this.btnComposeEmoji.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.bottom = `${window.innerHeight - btnRect.top + 4}px`;
    picker.style.left = `${Math.max(8, Math.min(btnRect.left, window.innerWidth - 330))}px`;

    document.body.appendChild(picker);

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
      client?.getInstanceEmojis?.().then(emojis => {
        if (!document.getElementById('compose-emoji-picker-popup')) return;
        const loadingEl = picker.querySelector('.reaction-picker-loading');
        if (!emojis || emojis.length === 0) {
          if (loadingEl) loadingEl.remove();
          return;
        }

        const categories = new Map();
        for (const emoji of emojis) {
          const cat = emoji.category || '기타';
          if (!categories.has(cat)) categories.set(cat, []);
          categories.get(cat).push(emoji);
        }

        const section = document.createElement('div');
        section.className = 'reaction-picker-instance-section';
        section.innerHTML = `
          <div class="reaction-picker-search">
            <input type="text" class="reaction-picker-search-input" placeholder="커스텀 이모지 검색..." />
          </div>
          <div class="reaction-picker-emojis">
            ${Array.from(categories.entries()).map(([cat, catEmojis]) => `
              <div class="reaction-picker-category" data-category="${cat}">
                <div class="reaction-picker-category-name">${this.escapeHtml(cat)}</div>
                <div class="reaction-picker-grid">
                  ${catEmojis.map(e => `<button class="compose-emoji-item" data-emoji=":${e.name}:" title=":${e.name}:"><img src="${this.escapeHtml(e.url)}" alt=":${e.name}:" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        `;

        if (loadingEl) loadingEl.replaceWith(section);

        const searchInput = section.querySelector('.reaction-picker-search-input');
        if (searchInput) {
          searchInput.addEventListener('input', () => {
            const query = searchInput.value.trim().toLowerCase();
            const items = section.querySelectorAll('.compose-emoji-item');
            const cats = section.querySelectorAll('.reaction-picker-category');
            for (const item of items) {
              const name = (item.dataset.emoji || '').toLowerCase();
              item.style.display = (!query || name.includes(query)) ? '' : 'none';
            }
            for (const cat of cats) {
              const visible = cat.querySelectorAll('.compose-emoji-item:not([style*="display: none"])');
              cat.style.display = visible.length > 0 ? '' : 'none';
            }
          });
        }
      }).catch(() => {
        const loadingEl = picker.querySelector('.reaction-picker-loading');
        if (loadingEl) loadingEl.remove();
      });
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
    const visibility = this.composeVisibility.value;
    const replyToId = this.composeText.dataset.replyTo;
    const quoteId = this.composeText.dataset.quoteId;
    const quoteUrl = this.composeText.dataset.quoteUrl;

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

        // Create post
        if (account.platform === 'mastodon') {
          // For Mastodon: append quote URL to text + try quote_id (supported by some servers)
          let statusText = text;
          if (quoteId && quoteUrl && !text.includes(quoteUrl)) {
            statusText = text + '\n\n' + quoteUrl;
          }
          const mastodonVisibility = ({ public: 'public', home: 'unlisted', followers: 'private', direct: 'direct' })[visibility] || 'public';
          await client.createStatus(statusText, {
            spoilerText: cw || undefined,
            sensitive: this.composeSensitive || undefined,
            visibility: mastodonVisibility,
            mediaIds: fileIds.length > 0 ? fileIds : undefined,
            inReplyToId: replyToId || undefined,
            quoteId: quoteId || undefined,
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
            replyId: replyToId || undefined,
            renoteId: quoteId || undefined,
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
      // At least one succeeded
      this.closeModal(this.modalCompose);
      this.refreshAll();
    }

    this.btnComposeSubmit.disabled = false;
    this.btnComposeSubmit.textContent = '게시';
  },

};
