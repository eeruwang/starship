/**
 * Compose Mixin
 * Handles the compose modal: opening, emoji picker, file attachments, and submission
 */
import { escapeHtml, compressImage, cachedImageUrl } from '../ui/utils.js';
import { COMMON_EMOJIS, UNICODE_EMOJI_MAP, loadInstanceEmojis, setupPickerSearch } from '../ui/emoji-picker.js';

export const ComposeMixin = {

  openComposeModal(replyToId = null, preferredAccountId = null, restrictedAccounts = null) {
    const accounts = restrictedAccounts || this.store.getVisible();
    if (accounts.length === 0) return;

    // Build account toggle buttons
    this.composeSelectedAccounts.clear();
    this.composeAccountsContainer.innerHTML = '';

    for (const account of accounts) {
      const p = account.profile;
      const btn = document.createElement('button');
      btn.className = 'compose-account-toggle';
      btn.dataset.accountId = account.id;
      const dotColor = this._accountColor(account);
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

    // Restore saved draft for new posts (not reply/edit/quote)
    if (!replyToId && this._composeDraft) {
      this.composeText.value = this._composeDraft.text || '';
      this.composeCw.value = this._composeDraft.cw || '';
      this._composeDraft = null;
    }

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
          ? `<img class="compose-reply-context-avatar" src="${escapeHtml(cachedImageUrl(dp.author.avatarUrl))}" alt="" width="20" height="20" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
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

  _saveComposeDraft() {
    const ct = this.composeText;
    // Only save for new posts (not reply/edit/quote)
    if (ct.dataset.editPostId || ct.dataset.replyTo || ct.dataset.quoteId) return;
    const text = ct.value;
    const cw = this.composeCw.value;
    if (!text.trim() && !cw.trim()) {
      this._composeDraft = null;
      return;
    }
    this._composeDraft = { text, cw };
  },

  _clearComposeDraft() {
    this._composeDraft = null;
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
    const pickerWidth = Math.min(320, window.innerWidth - 16);
    picker.style.left = `${Math.max(8, Math.min(btnRect.left, window.innerWidth - pickerWidth - 8))}px`;

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

  async handleComposeFileSelect() {
    const files = Array.from(this.composeFilesInput.files);
    for (const file of files) {
      if (this.composeFiles.length >= 4) break;
      const compressed = await compressImage(file);
      this.composeFiles.push(compressed);
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

  _showUploadProgress() {
    const items = this.composeImagePreview.querySelectorAll('.preview-item');
    items.forEach((item) => {
      if (item.querySelector('.upload-progress')) return;
      const overlay = document.createElement('div');
      overlay.className = 'upload-progress';
      overlay.innerHTML = '<div class="upload-progress-bar"></div>';
      item.appendChild(overlay);
    });
  },

  _updateUploadProgress(fileIndex, ratio) {
    const items = this.composeImagePreview.querySelectorAll('.preview-item');
    const item = items[fileIndex];
    if (!item) return;
    const bar = item.querySelector('.upload-progress-bar');
    if (bar) bar.style.width = `${Math.round(ratio * 100)}%`;
    if (ratio >= 1) {
      const overlay = item.querySelector('.upload-progress');
      if (overlay) overlay.classList.add('done');
    }
  },

  // ===== Inline Emoji Autocomplete =====

  /**
   * Extract the emoji autocomplete query from the textarea at cursor position.
   * Returns { query, colonPos, endPos } or null if no autocomplete context.
   */
  _getEmojiAutocompleteQuery() {
    const ta = this.composeText;
    const text = ta.value;
    const pos = ta.selectionStart;

    // Search backwards from cursor for ':'
    let colonPos = -1;
    for (let i = pos - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === ':') {
        colonPos = i;
        break;
      }
      // Stop at whitespace or newline (except when part of the query)
      if (/\s/.test(ch)) break;
    }

    if (colonPos === -1) return null;

    // Colon must be at start of text or after whitespace
    if (colonPos > 0 && !/\s/.test(text[colonPos - 1])) return null;

    const query = text.substring(colonPos + 1, pos);

    // Don't trigger if query contains whitespace or another colon (already closed)
    if (/[\s:]/.test(query)) return null;

    // Require at least 1 character after colon for filtering
    if (query.length < 1) return null;

    return { query, colonPos, endPos: pos };
  },

  /**
   * Handle emoji autocomplete on each input event.
   */
  async _handleEmojiAutocomplete() {
    const result = this._getEmojiAutocompleteQuery();
    if (!result) {
      this._closeEmojiAutocomplete();
      return;
    }

    const { query } = result;
    const lowerQuery = query.toLowerCase();

    // Gather matches from both unicode and custom emojis
    const matches = [];

    // Search unicode emojis by name
    for (const [name, char] of Object.entries(UNICODE_EMOJI_MAP)) {
      if (name.includes(lowerQuery)) {
        matches.push({ name, display: char, text: char, isCustom: false });
      }
      if (matches.length >= 30) break;
    }

    // Search custom instance emojis
    const emojiMap = await this._getComposeEmojiMap();
    for (const [name, url] of Object.entries(emojiMap)) {
      if (name.toLowerCase().includes(lowerQuery)) {
        matches.push({ name, url, text: `:${name}:`, isCustom: true });
      }
      if (matches.length >= 30) break;
    }

    if (matches.length === 0) {
      this._closeEmojiAutocomplete();
      return;
    }

    this._renderEmojiAutocomplete(matches);
  },

  /**
   * Render the autocomplete dropdown with matched emojis.
   */
  _renderEmojiAutocomplete(matches) {
    let dropdown = document.getElementById('emoji-autocomplete-dropdown');
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.id = 'emoji-autocomplete-dropdown';
      dropdown.className = 'emoji-autocomplete-dropdown';
      const textWrap = document.querySelector('.compose-text-wrap');
      textWrap.style.position = 'relative';
      textWrap.appendChild(dropdown);

      dropdown.addEventListener('mousedown', (e) => {
        // Prevent blur on textarea when clicking dropdown items
        e.preventDefault();
      });
      dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.emoji-ac-item');
        if (!item) return;
        const idx = parseInt(item.dataset.index);
        this._selectEmojiAutocomplete(idx);
      });
    }

    this._emojiAutocompleteIndex = 0;
    this._emojiAutocompleteItems = matches;

    dropdown.innerHTML = matches.map((m, i) => `
      <button class="emoji-ac-item${i === 0 ? ' active' : ''}" data-index="${i}">
        ${m.isCustom
          ? `<img src="${escapeHtml(m.url)}" alt=":${escapeHtml(m.name)}:" class="emoji-ac-img" referrerpolicy="no-referrer">`
          : `<span class="emoji-ac-unicode">${m.display}</span>`
        }
        <span class="emoji-ac-name">:${escapeHtml(m.name)}:</span>
      </button>
    `).join('');
  },

  /**
   * Select an emoji from the autocomplete dropdown by index.
   */
  _selectEmojiAutocomplete(index) {
    const items = this._emojiAutocompleteItems;
    if (!items || index < 0 || index >= items.length) return;

    const selected = items[index];
    const result = this._getEmojiAutocompleteQuery();
    if (!result) return;

    const ta = this.composeText;
    const before = ta.value.substring(0, result.colonPos);
    const after = ta.value.substring(result.endPos);
    ta.value = before + selected.text + ' ' + after;
    const newPos = result.colonPos + selected.text.length + 1;
    ta.selectionStart = ta.selectionEnd = newPos;
    ta.focus();

    this._closeEmojiAutocomplete();
    this._updateComposeEmojiPreview();
    this._updateComposeWordCount();
  },

  /**
   * Close the emoji autocomplete dropdown.
   */
  _closeEmojiAutocomplete() {
    const dropdown = document.getElementById('emoji-autocomplete-dropdown');
    if (dropdown) dropdown.remove();
    this._emojiAutocompleteItems = null;
    this._emojiAutocompleteIndex = -1;
  },

  /**
   * Navigate the autocomplete dropdown with arrow keys.
   * Returns true if navigation was handled (autocomplete is open).
   */
  _navigateEmojiAutocomplete(direction) {
    const dropdown = document.getElementById('emoji-autocomplete-dropdown');
    if (!dropdown || !this._emojiAutocompleteItems) return false;

    const items = this._emojiAutocompleteItems;
    let newIndex = (this._emojiAutocompleteIndex || 0) + direction;
    if (newIndex < 0) newIndex = items.length - 1;
    if (newIndex >= items.length) newIndex = 0;

    this._emojiAutocompleteIndex = newIndex;

    const buttons = dropdown.querySelectorAll('.emoji-ac-item');
    buttons.forEach((btn, i) => btn.classList.toggle('active', i === newIndex));
    buttons[newIndex]?.scrollIntoView({ block: 'nearest' });

    return true;
  },

  /**
   * Check if the emoji autocomplete dropdown is currently open.
   */
  _isEmojiAutocompleteOpen() {
    return !!document.getElementById('emoji-autocomplete-dropdown');
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

    // Show upload progress overlays on preview images
    const totalFiles = this.composeFiles.length;
    if (totalFiles > 0) {
      this._showUploadProgress();
    }

    const errors = [];

    for (const accountId of selectedIds) {
      const account = this.store.getById(accountId);
      const client = this.store.getClient(accountId);
      if (!account || !client) continue;

      try {
        // Upload files per account with progress
        let fileIds = [];
        if (totalFiles > 0) {
          for (let i = 0; i < this.composeFiles.length; i++) {
            const file = this.composeFiles[i];
            this.btnComposeSubmit.textContent = `업로드 ${i + 1}/${totalFiles}`;
            const onProgress = (ratio) => this._updateUploadProgress(i, ratio);
            if (account.platform === 'mastodon') {
              const result = await client.uploadMedia(file, { onProgress });
              fileIds.push(result.id);
            } else {
              const result = await client.uploadFile(file, { onProgress });
              fileIds.push(result.id);
            }
            this._updateUploadProgress(i, 1);
          }
          this.btnComposeSubmit.textContent = '게시 중...';
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
        let quoteResolveFailed = false;
        if (quoteId && quoteUrl) {
          const qAccount = quoteAccountId ? this.store.getById(quoteAccountId) : null;
          if (qAccount && qAccount.instanceUrl !== account.instanceUrl) {
            try {
              const resolved = await client.resolveUrl(quoteUrl);
              if (resolved) {
                resolvedQuoteId = resolved.id;
              } else {
                quoteResolveFailed = true;
                resolvedQuoteId = null;
              }
            } catch {
              quoteResolveFailed = true;
              resolvedQuoteId = null;
            }
          }
        }

        // Create post and optimistically inject into timeline
        let rawPost;
        if (account.platform === 'mastodon') {
          // Always include the URL in body text when quoting. Vanilla Mastodon
          // and GoToSocial render it as a link card (the de-facto quote
          // pattern), and forks that natively support quote_id (Hollo,
          // Fedibird, glitch-soc, Akkoma, Pleroma) additionally get the
          // relationship — our renderer suppresses the duplicate link card and
          // the trailing URL <a> on display, so visually there's no clutter.
          let statusText = text;
          if (quoteUrl && !text.includes(quoteUrl)) {
            statusText = text + '\n\n' + quoteUrl;
          }
          const mastodonVisibility = ({ public: 'public', home: 'unlisted', followers: 'private', direct: 'direct' })[visibility] || 'public';
          rawPost = await client.createStatus(statusText, {
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
          // Misskey-family: if cross-instance resolve failed, the original
          // foreign ID would 404 on the local server; fall back to URL append
          // so the post still includes a link to the quoted source.
          let noteText = text;
          if (quoteUrl && quoteResolveFailed && !text.includes(quoteUrl)) {
            noteText = text + '\n\n' + quoteUrl;
          }
          const misskeyVisibility = ({ public: 'public', home: 'home', followers: 'followers', direct: 'specified' })[visibility] || 'public';
          const result = await client.createNote(noteText, {
            cw: cw || undefined,
            visibility: misskeyVisibility,
            fileIds: fileIds.length > 0 ? fileIds : undefined,
            replyId: resolvedReplyId || undefined,
            renoteId: resolvedQuoteId || undefined,
          });
          // Misskey returns { createdNote: { ... } }
          rawPost = result?.createdNote || result;
        }

        // Optimistic insert: inject the post into timeline immediately
        // so it appears without waiting for WebSocket stream delivery.
        // When the stream later delivers the same post, existing dedup
        // checks (platform:id / canonicalUri) will skip it.
        if (rawPost) {
          try {
            const post = client.normalizePost(rawPost);
            this._onStreamPost({ account, post });
          } catch { /* non-critical — stream will deliver it */ }
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
      this._clearComposeDraft();
      this.closeModal(this.modalCompose);
    }

    this.btnComposeSubmit.disabled = false;
    this.btnComposeSubmit.textContent = '게시';
  },

};
