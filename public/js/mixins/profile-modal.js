/**
 * Profile Modal Mixin
 * Handles the profile modal: opening, profile editing, notes tabs, follow relations
 */
import { escapeHtml, compressImage } from '../ui/utils.js';
import { renderPost } from '../ui/dashboard.js';

export const ProfileModalMixin = {

  async openProfileModal(author, platform, accountId) {
    const modal = document.getElementById('modal-profile');
    const banner = document.getElementById('profile-banner');
    const avatar = document.getElementById('profile-avatar');
    const nameEl = document.getElementById('profile-name');
    const handleEl = document.getElementById('profile-handle');
    const bioEl = document.getElementById('profile-bio');
    const statsEl = document.getElementById('profile-stats');
    const fieldsEl = document.getElementById('profile-fields');
    const actionsEl = document.getElementById('profile-actions');
    const editInline = document.getElementById('profile-edit-inline');
    const tabsEl = document.getElementById('profile-tabs');
    const postsEl = document.getElementById('profile-posts');
    const editBannerBtn = document.getElementById('profile-edit-banner-btn');
    const editBannerInput = document.getElementById('profile-edit-banner-input');
    const editAvatarBtn = document.getElementById('profile-edit-avatar-btn');
    const editAvatarInput = document.getElementById('profile-edit-avatar-input');
    const stickyHeader = document.getElementById('profile-sticky-header');
    const stickyAvatar = document.getElementById('profile-sticky-avatar');
    const stickyName = document.getElementById('profile-sticky-name');
    const stickyHandle = document.getElementById('profile-sticky-handle');

    // Cleanup previous scroll listeners
    const scrollEl = modal.querySelector('.profile-scroll');
    if (this._profileScrollHandler && scrollEl) {
      scrollEl.removeEventListener('scroll', this._profileScrollHandler);
      this._profileScrollHandler = null;
    }
    if (this._profileStickyScrollHandler && scrollEl) {
      scrollEl.removeEventListener('scroll', this._profileStickyScrollHandler);
      this._profileStickyScrollHandler = null;
    }
    // Cleanup previous stats click listener
    if (this._profileStatsClickHandler && statsEl) {
      statsEl.removeEventListener('click', this._profileStatsClickHandler);
      this._profileStatsClickHandler = null;
    }
    // Cleanup previous tabs click listener
    if (this._profileTabsClickHandler && tabsEl) {
      tabsEl.removeEventListener('click', this._profileTabsClickHandler);
      this._profileTabsClickHandler = null;
    }
    this._profileState = null;

    // Clean up previous follow badges
    const oldBadges = document.getElementById('profile-follow-badges');
    if (oldBadges) oldBadges.remove();
    const oldFollowBtn = document.getElementById('btn-profile-follow');
    if (oldFollowBtn) oldFollowBtn.remove();

    // Reset
    banner.style.backgroundImage = '';
    banner.style.backgroundPosition = '';
    banner.style.backgroundSize = '';
    banner.style.background = 'linear-gradient(135deg, var(--accent-primary), #a78bfa)';
    avatar.src = author.avatarUrl || '';
    nameEl.innerHTML = author.displayNameHtml || escapeHtml(author.displayName);
    handleEl.textContent = `@${author.acct}`;
    bioEl.innerHTML = '';
    statsEl.innerHTML = '';
    fieldsEl.innerHTML = '';
    actionsEl.innerHTML = '';
    editInline.style.display = 'none';
    editBannerBtn.style.display = 'none';
    editAvatarBtn.style.display = 'none';
    editBannerInput.value = '';
    editAvatarInput.value = '';
    this._profileEditAvatarFile = null;
    this._profileEditBannerFile = null;
    tabsEl.style.display = 'none';
    const showPagesTab = this.store.supportsPages(this.store.getById(effectiveAccountId));
    tabsEl.innerHTML = `
      <button class="profile-tab active" data-profile-tab="notes">노트</button>
      <button class="profile-tab" data-profile-tab="renotes">리노트</button>
      <button class="profile-tab" data-profile-tab="replies">댓글</button>
      ${showPagesTab ? '<button class="profile-tab" data-profile-tab="pages">페이지</button>' : ''}
    `;
    postsEl.style.display = 'none';
    postsEl.innerHTML = '';

    // Reset sticky header
    stickyHeader.classList.remove('visible');
    stickyAvatar.src = author.avatarUrl || '';
    stickyName.innerHTML = author.displayNameHtml || escapeHtml(author.displayName);
    stickyHandle.textContent = `@${author.acct}`;

    // Scroll listener for sticky header
    const bannerHeight = 160; // matches CSS .profile-banner height
    const threshold = bannerHeight - 44; // show sticky when banner mostly scrolled away
    const onScroll = () => {
      const scrollTop = scrollEl.scrollTop;
      if (scrollTop >= threshold) {
        stickyHeader.classList.add('visible');
      } else {
        stickyHeader.classList.remove('visible');
      }
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    this._profileStickyScrollHandler = onScroll;

    // Reset scroll position
    scrollEl.scrollTop = 0;

    this.openModal(modal);

    // Fetch full profile
    // Check if this is my account early, so we can use own client for full data access
    // (avoids ffVisibility restrictions when viewing own profile from another account's context)
    const myAccount = this.store.getAll().find(a =>
      String(a.profile?.id) === String(author.id) && a.platform === platform
    );
    let effectiveAccountId = myAccount ? myAccount.id : accountId;
    if (!myAccount) {
      const viewingAccount = this.store.getById(accountId);
      if (viewingAccount?.hidden) {
        const fallback = this.store.getVisible().find(a => a.platform === platform);
        if (fallback) effectiveAccountId = fallback.id;
      }
    }
    const client = this.store.getClient(effectiveAccountId);
    if (!client) return;

    try {
      const user = await client.getUser(author.id);
      if (!user) return;

      this._renderProfileHeader(user, platform, {
        banner, avatar, nameEl, handleEl, bioEl, statsEl, fieldsEl,
        stickyAvatar, stickyName, stickyHandle, client,
      });

      const account = this.store.getById(effectiveAccountId);
      const instanceUrl = account?.instanceUrl || '';
      const isMisskey = platform !== 'mastodon';

      // Actions
      let actionsHtml = `<a class="btn btn-secondary btn-small" href="${instanceUrl}/@${user.username}" target="_blank" rel="noopener">인스턴스에서 보기</a>`;
      if (myAccount) {
        actionsHtml += `<button class="btn btn-primary btn-small" id="btn-profile-edit">프로필 수정</button>`;
      }
      actionsEl.innerHTML = actionsHtml;

      // Show notes tabs for own account
      // Make follower/following stats clickable
      statsEl.querySelectorAll('[data-stat-tab]').forEach(el => el.classList.add('profile-stat-clickable'));
      const statsClickHandler = async (e) => {
        const stat = e.target.closest('[data-stat-tab]');
        if (!stat) return;
        const tabName = stat.dataset.statTab;

        // Deactivate all tabs visually
        const currentTabsEl = document.getElementById('profile-tabs');
        if (currentTabsEl) currentTabsEl.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));

        // Stop infinite scroll from interfering
        if (this._profileState) this._profileState.activeTab = tabName;

        // Show list in posts area
        postsEl.innerHTML = '<div class="profile-posts-empty"><div class="spinner"></div></div>';
        if (tabName === 'followers') {
          if (myAccount) {
            await this._loadProfileFollowersWithActions(postsEl, client, account, user.id);
          } else {
            await this._loadProfileFollowers(postsEl, client, account, user.id);
          }
        } else {
          if (myAccount) {
            await this._loadProfileFollowingWithActions(postsEl, client, account, user.id);
          } else {
            await this._loadProfileFollowing(postsEl, client, account, user.id);
          }
        }
      };
      statsEl.addEventListener('click', statsClickHandler);
      this._profileStatsClickHandler = statsClickHandler;

      if (myAccount) {
        tabsEl.style.display = 'flex';
        postsEl.style.display = 'block';
        this._loadProfileNotes(user.id, platform, effectiveAccountId, client, isMisskey, account);
      }

      // Follow relationship for other users
      if (!myAccount) {
        this._loadFollowRelation(user, platform, effectiveAccountId, client, isMisskey, instanceUrl, actionsEl);

        // Show tabs and posts for other users' profiles
        tabsEl.style.display = 'flex';
        postsEl.style.display = 'block';
        this._loadOtherProfileTabs(user.id, platform, effectiveAccountId, client, isMisskey, account, tabsEl, postsEl);
      }

      // Edit handlers
      if (myAccount) {
        this._setupProfileEditHandlers(user, isMisskey, myAccount, instanceUrl, {
          nameEl, bioEl, actionsEl, avatar, banner, editInline,
          editBannerBtn, editAvatarBtn, editBannerInput, editAvatarInput,
          stickyName, client,
        });
      }
    } catch (err) {
      bioEl.innerHTML = `<span style="color:var(--text-muted)">프로필을 불러올 수 없습니다</span>`;
    }
  },

  _renderProfileHeader(user, platform, els) {
    const { banner, avatar, nameEl, handleEl, bioEl, statsEl, fieldsEl,
            stickyAvatar, stickyName, stickyHandle, client } = els;
    const isMisskey = platform !== 'mastodon';

    // Banner
    const bannerUrl = user.bannerUrl || user.header;
    if (bannerUrl) {
      banner.style.background = 'none';
      banner.style.backgroundImage = `url(${bannerUrl})`;
      banner.style.backgroundPosition = 'center';
      banner.style.backgroundSize = 'cover';
      banner.style.backgroundColor = 'var(--bg-tertiary)';
    }

    // Avatar
    avatar.src = user.avatarUrl || user.avatar || avatar.src;

    // Name with emoji
    if (isMisskey) {
      const userEmojis = this._extractUserEmojis(user);
      nameEl.innerHTML = client.resolveNameEmojis(user.name || user.username, userEmojis);
    } else {
      let nameHtml = escapeHtml(user.display_name || user.username);
      if (user.emojis && user.emojis.length > 0) {
        for (const emoji of user.emojis) {
          nameHtml = nameHtml.replaceAll(`:${emoji.shortcode}:`,
            `<img class="inline-emoji" src="${emoji.url}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" referrerpolicy="no-referrer">`);
        }
      }
      nameEl.innerHTML = nameHtml;
    }

    // Handle
    const host = user.host || '';
    const acct = user.acct || (host ? `${user.username}@${host}` : user.username);
    handleEl.textContent = `@${acct}`;

    // Sync sticky header with full data
    stickyAvatar.src = avatar.src;
    stickyName.innerHTML = nameEl.innerHTML;
    stickyHandle.textContent = handleEl.textContent;

    // Bio
    if (isMisskey) {
      const bio = user.description || '';
      if (bio) {
        const userEmojis = this._extractUserEmojis(user);
        bioEl.innerHTML = client.mfmToHtml(bio, userEmojis);
      }
    } else {
      let bio = user.note || '';
      if (bio) {
        if (user.emojis && user.emojis.length > 0) {
          for (const emoji of user.emojis) {
            bio = bio.replaceAll(`:${emoji.shortcode}:`,
              `<img class="inline-emoji" src="${escapeHtml(emoji.url)}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" referrerpolicy="no-referrer">`);
          }
        }
        bioEl.innerHTML = bio;
      }
    }

    // Stats
    const followers = user.followersCount ?? user.followers_count ?? 0;
    const following = user.followingCount ?? user.following_count ?? 0;
    const posts = user.notesCount ?? user.statuses_count ?? 0;
    statsEl.innerHTML = `
      <span class="profile-stat profile-stat-followers" data-stat-tab="followers"><strong>${followers}</strong> 팔로워</span>
      <span class="profile-stat profile-stat-following" data-stat-tab="following"><strong>${following}</strong> 팔로잉</span>
      <span class="profile-stat"><strong>${posts}</strong> ${isMisskey ? '노트' : '게시물'}</span>
    `;

    // Fields
    const fields = user.fields || [];
    if (fields.length > 0) {
      const resolveFieldEmojis = (html) => {
        if (!isMisskey && user.emojis && user.emojis.length > 0) {
          for (const emoji of user.emojis) {
            html = html.replaceAll(`:${emoji.shortcode}:`,
              `<img class="inline-emoji" src="${escapeHtml(emoji.url)}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" referrerpolicy="no-referrer">`);
          }
        }
        return html;
      };
      fieldsEl.innerHTML = fields.map(f => `
        <div class="profile-field">
          <span class="profile-field-name">${resolveFieldEmojis(escapeHtml(f.name))}</span>
          <span class="profile-field-value">${isMisskey ? resolveFieldEmojis(escapeHtml(f.value || '')) : resolveFieldEmojis(f.value || '')}</span>
        </div>
      `).join('');
    }
  },

  _extractUserEmojis(user) {
    const emojis = {};
    if (user.emojis && typeof user.emojis === 'object' && !Array.isArray(user.emojis)) {
      Object.assign(emojis, user.emojis);
    }
    if (Array.isArray(user.emojis)) {
      for (const e of user.emojis) {
        if (e.name && e.url) emojis[e.name] = e.url;
      }
    }
    return emojis;
  },

  _setupProfileEditHandlers(user, isMisskey, myAccount, instanceUrl, els) {
    const { nameEl, bioEl, actionsEl, avatar, banner, editInline,
            editBannerBtn, editAvatarBtn, editBannerInput, editAvatarInput,
            stickyName, client } = els;

    const editBtn = document.getElementById('btn-profile-edit');
    const editName = document.getElementById('profile-edit-name');
    const editBio = document.getElementById('profile-edit-bio');

    // Store originals for cancel
    this._profileOriginalAvatar = avatar.src;
    this._profileOriginalBannerStyle = banner.style.cssText;

    const enterEditMode = () => {
      editName.value = isMisskey ? (user.name || '') : (user.display_name || '');
      editBio.value = isMisskey ? (user.description || '') : (user.source?.note || user.note?.replace(/<[^>]*>/g, '') || '');
      this._profileEditAvatarFile = null;
      this._profileEditBannerFile = null;
      editAvatarInput.value = '';
      editBannerInput.value = '';
      editInline.style.display = 'block';
      nameEl.style.display = 'none';
      bioEl.style.display = 'none';
      editBannerBtn.style.display = 'flex';
      editAvatarBtn.style.display = 'flex';
      actionsEl.innerHTML = `
        <button class="btn btn-secondary btn-small" id="btn-profile-edit-cancel">취소</button>
        <button class="btn btn-primary btn-small" id="btn-profile-edit-save">저장</button>
      `;
      document.getElementById('btn-profile-edit-cancel').addEventListener('click', exitEditMode);
      document.getElementById('btn-profile-edit-save').addEventListener('click', saveProfile);
    };

    const exitEditMode = () => {
      editInline.style.display = 'none';
      nameEl.style.display = '';
      bioEl.style.display = '';
      editBannerBtn.style.display = 'none';
      editAvatarBtn.style.display = 'none';
      if (this._profileEditAvatarFile) {
        if (avatar.src.startsWith('blob:')) URL.revokeObjectURL(avatar.src);
        avatar.src = this._profileOriginalAvatar || '';
      }
      if (this._profileEditBannerFile) {
        const bgUrl = banner.style.backgroundImage.match(/url\(([^)]+)\)/)?.[1];
        if (bgUrl && bgUrl.startsWith('blob:')) URL.revokeObjectURL(bgUrl);
        banner.style.cssText = this._profileOriginalBannerStyle || '';
      }
      let html = `<a class="btn btn-secondary btn-small" href="${instanceUrl}/@${user.username}" target="_blank" rel="noopener">인스턴스에서 보기</a>`;
      html += `<button class="btn btn-primary btn-small" id="btn-profile-edit">프로필 수정</button>`;
      actionsEl.innerHTML = html;
      document.getElementById('btn-profile-edit').addEventListener('click', enterEditMode);
    };

    const saveProfile = async () => {
      const saveBtn = document.getElementById('btn-profile-edit-save');
      saveBtn.disabled = true;
      saveBtn.textContent = '저장 중...';
      try {
        const myClient = this.store.getClient(myAccount.id);
        if (isMisskey) {
          const params = { name: editName.value, description: editBio.value };
          if (this._profileEditAvatarFile) {
            const file = await myClient.uploadFile(this._profileEditAvatarFile);
            params.avatarId = file.id;
          }
          if (this._profileEditBannerFile) {
            const file = await myClient.uploadFile(this._profileEditBannerFile);
            params.bannerId = file.id;
          }
          await myClient.updateProfile(params);
        } else {
          await myClient.updateProfile({
            displayName: editName.value,
            note: editBio.value,
            avatar: this._profileEditAvatarFile || undefined,
            header: this._profileEditBannerFile || undefined,
          });
        }
        const oldDisplayName = myAccount.profile.displayName;
        try {
          const freshProfile = await myClient.verifyCredentials();
          if (isMisskey) {
            myAccount.profile.displayName = freshProfile.name || freshProfile.username;
            myAccount.profile.avatarUrl = freshProfile.avatarUrl;
          } else {
            myAccount.profile.displayName = freshProfile.display_name || freshProfile.username;
            myAccount.profile.avatarUrl = freshProfile.avatar;
          }
        } catch {
          myAccount.profile.displayName = editName.value || myAccount.profile.username;
        }
        if (!myAccount.label || myAccount.label === oldDisplayName) {
          myAccount.label = myAccount.profile.displayName;
        }
        this.store.save();
        this.debouncedSaveToCloud();
        nameEl.textContent = myAccount.profile.displayName;
        bioEl.innerHTML = escapeHtml(editBio.value).replace(/\n/g, '<br>');
        stickyName.textContent = myAccount.profile.displayName;
        if (myAccount.profile.avatarUrl) avatar.src = myAccount.profile.avatarUrl;
        this._refreshColumnHeaders();
        this._profileOriginalAvatar = avatar.src;
        this._profileOriginalBannerStyle = banner.style.cssText;
        editInline.style.display = 'none';
        nameEl.style.display = '';
        bioEl.style.display = '';
        editBannerBtn.style.display = 'none';
        editAvatarBtn.style.display = 'none';
        let html = `<a class="btn btn-secondary btn-small" href="${instanceUrl}/@${user.username}" target="_blank" rel="noopener">인스턴스에서 보기</a>`;
        html += `<button class="btn btn-primary btn-small" id="btn-profile-edit">프로필 수정</button>`;
        actionsEl.innerHTML = html;
        document.getElementById('btn-profile-edit').addEventListener('click', enterEditMode);
      } catch (err) {
        if (err.message.includes('PERMISSION_DENIED')) {
          this.showToast('프로필 수정 권한이 없습니다. 계정 재인증으로 권한을 갱신하세요.');
        } else {
          this.showToast('프로필 수정 실패: ' + err.message);
        }
      } finally {
        const btn = document.getElementById('btn-profile-edit-save');
        if (btn) { btn.disabled = false; btn.textContent = '저장'; }
      }
    };

    // Image upload handlers
    editBannerBtn.onclick = () => editBannerInput.click();
    editBannerInput.onchange = async () => {
      const file = editBannerInput.files[0];
      if (!file) return;
      this._profileEditBannerFile = await compressImage(file);
      const url = URL.createObjectURL(this._profileEditBannerFile);
      banner.style.background = 'none';
      banner.style.backgroundImage = `url(${url})`;
      banner.style.backgroundSize = 'cover';
      banner.style.backgroundPosition = 'center';
    };
    editAvatarBtn.onclick = () => editAvatarInput.click();
    editAvatarInput.onchange = async () => {
      const file = editAvatarInput.files[0];
      if (!file) return;
      this._profileEditAvatarFile = await compressImage(file);
      avatar.src = URL.createObjectURL(this._profileEditAvatarFile);
    };

    editBtn.addEventListener('click', enterEditMode);
  },

  async _loadProfileNotes(userId, platform, accountId, client, isMisskey, account) {
    const postsEl = document.getElementById('profile-posts');
    const tabsEl = document.getElementById('profile-tabs');
    const scrollEl = document.querySelector('#modal-profile .profile-scroll');
    postsEl.innerHTML = '<div class="profile-posts-empty"><div class="spinner"></div></div>';

    // State for infinite scroll
    this._profileState = {
      userId, platform, accountId, client, isMisskey, account,
      tabData: { notes: [], renotes: [], replies: [] },
      activeTab: 'notes',
      loading: false,
      hasMore: true,
      lastRawId: null,
    };

    try {
      await this._fetchMoreProfileNotes();

      // Setup tabs
      this._profileState.tabsEl = tabsEl;
      this._updateProfileTabCounts();
      this._renderProfileTab('notes', postsEl);

      // Tab click
      const tabClickHandler = async (e) => {
        const tab = e.target.closest('.profile-tab');
        if (!tab) return;
        const tabName = tab.dataset.profileTab;
        if (!tabName) return;
        tabsEl.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this._profileState.activeTab = tabName;
        if (tabName === 'pages') {
          await this._loadProfilePages(postsEl, client, account, user.id);
        } else {
          this._renderProfileTab(tabName, postsEl);
        }
      };
      tabsEl.addEventListener('click', tabClickHandler);
      this._profileTabsClickHandler = tabClickHandler;

      // Infinite scroll on the profile-scroll container
      if (this._profileScrollHandler) {
        scrollEl.removeEventListener('scroll', this._profileScrollHandler);
      }
      this._profileScrollHandler = () => {
        if (!this._profileState || this._profileState.loading || !this._profileState.hasMore) return;
        const { scrollTop, scrollHeight, clientHeight } = scrollEl;
        if (scrollTop + clientHeight >= scrollHeight - 100) {
          this._loadMoreProfileNotes();
        }
      };
      scrollEl.addEventListener('scroll', this._profileScrollHandler, { passive: true });
    } catch (err) {
      console.error('Failed to load profile notes:', err);
      postsEl.innerHTML = '<div class="profile-posts-empty">노트를 불러올 수 없습니다</div>';
    }
  },

  async _fetchMoreProfileNotes() {
    const s = this._profileState;
    if (!s || s.loading || !s.hasMore) return [];
    s.loading = true;

    try {
      let raw;
      if (s.isMisskey) {
        raw = await s.client.getUserNotes(s.userId, 20, s.lastRawId);
      } else {
        raw = await s.client.getUserStatuses(s.userId, 20, s.lastRawId);
      }
      if (!raw || raw.length === 0) {
        s.hasMore = false;
        return [];
      }
      s.lastRawId = raw[raw.length - 1].id;
      if (raw.length < 20) s.hasMore = false;

      const normalized = raw.map(n => s.client.normalizePost(n));
      normalized.forEach(post => {
        post.accountId = s.accountId;
        post.accountPlatform = s.platform;
        post.themeColor = s.account?.themeColor || null;
        const ownerId = post.rebloggedBy ? post.rebloggedBy.id : post.author.id;
        post.isOwn = String(ownerId) === String(s.account?.profile?.id);
      });
      this.cachePosts(normalized);

      // Categorize and append
      for (const n of normalized) {
        if (n.rebloggedBy) s.tabData.renotes.push(n);
        else if (n.replyToId) s.tabData.replies.push(n);
        else s.tabData.notes.push(n);
      }
      return normalized;
    } finally {
      s.loading = false;
    }
  },

  async _loadMoreProfileNotes() {
    const s = this._profileState;
    if (!s) return;
    if (s.activeTab === 'followers' || s.activeTab === 'following') return;
    const postsEl = document.getElementById('profile-posts');
    const prevCounts = {
      notes: s.tabData.notes.length,
      renotes: s.tabData.renotes.length,
      replies: s.tabData.replies.length,
    };

    // Show loading indicator
    let loader = postsEl.querySelector('.profile-load-more');
    if (!loader) {
      loader = document.createElement('div');
      loader.className = 'profile-posts-empty profile-load-more';
      loader.innerHTML = '<div class="spinner"></div>';
      postsEl.appendChild(loader);
    }

    await this._fetchMoreProfileNotes();
    this._updateProfileTabCounts();

    // Remove loader
    loader = postsEl.querySelector('.profile-load-more');
    if (loader) loader.remove();

    // Append only new posts for active tab
    const tab = s.activeTab;
    const allPosts = s.tabData[tab] || [];
    const prevCount = prevCounts[tab] || 0;
    const newPosts = allPosts.slice(prevCount);
    for (const post of newPosts) {
      postsEl.appendChild(renderPost(post));
    }
    this.enrichLinkCards(postsEl);

    // Remove empty message if posts appeared
    if (allPosts.length > 0) {
      const empty = postsEl.querySelector('.profile-posts-empty:not(.profile-load-more)');
      if (empty) empty.remove();
    }
  },

  _updateProfileTabCounts() {
    const s = this._profileState;
    if (!s || !s.tabsEl) return;
    const tabLabels = { notes: '노트', renotes: '리노트', replies: '댓글' };
    s.tabsEl.querySelectorAll('.profile-tab').forEach(btn => {
      const key = btn.dataset.profileTab;
      const count = (s.tabData[key] || []).length;
      btn.innerHTML = `${tabLabels[key]} <span class="tab-count">${count}</span>`;
    });
  },

  _renderProfileTab(tabName, container) {
    const s = this._profileState;
    const posts = s ? (s.tabData[tabName] || []) : [];
    container.innerHTML = '';
    if (posts.length === 0) {
      const labels = { notes: '노트', renotes: '리노트', replies: '댓글' };
      container.innerHTML = `<div class="profile-posts-empty">${labels[tabName] || '게시물'}이 없습니다</div>`;
      return;
    }
    for (const post of posts) {
      container.appendChild(renderPost(post));
    }
    this.enrichLinkCards(container);
  },

  async _loadFollowRelation(user, platform, accountId, client, isMisskey, instanceUrl, actionsEl, knownState) {
    try {
      let isFollowing = false;
      let isFollowedBy = false;
      let relation = null;

      if (knownState) {
        isFollowing = knownState.isFollowing;
        isFollowedBy = knownState.isFollowedBy;
        relation = knownState.relation || null;
      } else if (isMisskey) {
        relation = await client.getRelation(user.id);
        isFollowing = !!relation?.isFollowing;
        isFollowedBy = !!relation?.isFollowed;
      } else {
        const rels = await client.getRelationships([user.id]);
        if (rels && rels.length > 0) {
          relation = rels[0];
          isFollowing = !!relation.following;
          isFollowedBy = !!relation.followed_by;
        }
      }

      // Build relation badges (inside banner-wrap for overlay)
      const badgesEl = document.getElementById('profile-follow-badges');
      if (badgesEl) badgesEl.remove();
      const badges = document.createElement('div');
      badges.id = 'profile-follow-badges';
      badges.className = 'profile-follow-badges';

      if (isFollowedBy) {
        badges.innerHTML += `<span class="follow-badge follow-badge-follower">나를 팔로우 중</span>`;
      }
      if (isFollowing) {
        badges.innerHTML += `<span class="follow-badge follow-badge-following">팔로우 중</span>`;
      }

      // Insert badges into banner area
      const bannerWrap = document.querySelector('#modal-profile .profile-banner-wrap');
      if (bannerWrap) {
        bannerWrap.appendChild(badges);
      }

      // Add follow/unfollow button
      const existingFollowBtn = document.getElementById('btn-profile-follow');
      if (existingFollowBtn) existingFollowBtn.remove();

      const followBtn = document.createElement('button');
      followBtn.id = 'btn-profile-follow';
      followBtn.className = isFollowing
        ? 'btn btn-secondary btn-small profile-follow-btn following'
        : 'btn btn-primary btn-small profile-follow-btn';
      followBtn.textContent = isFollowing ? '팔로우 해제' : '팔로우';

      // Hover state for unfollow (mouse), touch shows unfollow text directly
      if (isFollowing) {
        const hasTouch = 'ontouchstart' in window;
        if (hasTouch) {
          // Touch devices: show "팔로우 해제" directly so intent is clear
          followBtn.textContent = '팔로우 해제';
        } else {
          followBtn.addEventListener('mouseenter', () => { followBtn.textContent = '팔로우 해제'; followBtn.classList.add('unfollow-hover'); });
          followBtn.addEventListener('mouseleave', () => { followBtn.textContent = '팔로우 중'; followBtn.classList.remove('unfollow-hover'); });
          followBtn.textContent = '팔로우 중';
        }
      }

      followBtn.addEventListener('click', async () => {
        followBtn.disabled = true;
        try {
          if (isFollowing) {
            await client.unfollowUser(user.id);
            isFollowing = false;
          } else {
            await client.followUser(user.id);
            isFollowing = true;
          }
          // Optimistic UI update — pass known state to skip API re-fetch
          this._loadFollowRelation(user, platform, accountId, client, isMisskey, instanceUrl, actionsEl,
            { isFollowing, isFollowedBy, relation });
        } catch (err) {
          this.showToast('팔로우 처리 실패: ' + err.message);
        } finally {
          followBtn.disabled = false;
        }
      });

      actionsEl.appendChild(followBtn);

      // Mute/Block buttons
      // Remove existing mute/block buttons before re-adding
      const existingMuteWrap = actionsEl.querySelector('.mute-btn-wrap');
      if (existingMuteWrap) existingMuteWrap.remove();
      const existingBlockBtn = actionsEl.querySelector('.btn-profile-block');
      if (existingBlockBtn) existingBlockBtn.remove();

      const isMuting = isMisskey ? !!relation?.isMuting : !!relation?.muting;
      const isBlocking = isMisskey ? !!relation?.isBlocking : !!relation?.blocking;

      // Mute button with duration picker
      const muteWrap = document.createElement('div');
      muteWrap.className = 'mute-btn-wrap';

      const muteBtn = document.createElement('button');
      muteBtn.className = 'btn btn-small btn-secondary btn-profile-mute';
      muteBtn.textContent = isMuting ? '뮤트 해제' : '뮤트';

      const muteDurations = [
        { label: '무기한', seconds: 0 },
        { label: '30분', seconds: 1800 },
        { label: '1시간', seconds: 3600 },
        { label: '6시간', seconds: 21600 },
        { label: '1일', seconds: 86400 },
        { label: '3일', seconds: 259200 },
        { label: '7일', seconds: 604800 },
      ];

      const durationMenu = document.createElement('div');
      durationMenu.className = 'mute-duration-menu';
      durationMenu.style.display = 'none';
      for (const dur of muteDurations) {
        const opt = document.createElement('button');
        opt.className = 'mute-duration-opt';
        opt.textContent = dur.label;
        opt.addEventListener('click', async () => {
          durationMenu.style.display = 'none';
          muteBtn.disabled = true;
          try {
            if (isMisskey) {
              const expiresAt = dur.seconds > 0 ? new Date(Date.now() + dur.seconds * 1000).toISOString() : null;
              await client.muteUser(user.id, expiresAt);
              if (relation) relation.isMuting = true;
            } else {
              await client.muteAccount(user.id, dur.seconds);
              if (relation) relation.muting = true;
            }
            muteBtn.textContent = '뮤트 해제';
            this.showToast(dur.seconds > 0 ? `${dur.label}간 뮤트됨` : '뮤트됨');
          } catch (err) {
            this.showToast('뮤트 실패: ' + err.message);
          } finally {
            muteBtn.disabled = false;
          }
        });
        durationMenu.appendChild(opt);
      }

      muteBtn.addEventListener('click', async () => {
        const currentlyMuting = isMisskey ? !!relation?.isMuting : !!relation?.muting;
        if (currentlyMuting) {
          // Unmute directly
          muteBtn.disabled = true;
          try {
            if (isMisskey) {
              await client.unmuteUser(user.id);
              if (relation) relation.isMuting = false;
            } else {
              await client.unmuteAccount(user.id);
              if (relation) relation.muting = false;
            }
            muteBtn.textContent = '뮤트';
          } catch (err) {
            this.showToast('뮤트 해제 실패: ' + err.message);
          } finally {
            muteBtn.disabled = false;
          }
        } else {
          // Show duration picker
          const isVisible = durationMenu.style.display !== 'none';
          durationMenu.style.display = isVisible ? 'none' : '';
        }
      });

      // Close menu on outside click
      const closeMuteMenu = (e) => {
        if (!muteWrap.contains(e.target)) durationMenu.style.display = 'none';
      };
      document.addEventListener('click', closeMuteMenu);
      // Cleanup when modal closes
      const observer = new MutationObserver(() => {
        if (!muteWrap.isConnected) {
          document.removeEventListener('click', closeMuteMenu);
          observer.disconnect();
        }
      });
      observer.observe(actionsEl.closest('.modal') || document.body, { childList: true, subtree: true });

      muteWrap.appendChild(muteBtn);
      muteWrap.appendChild(durationMenu);

      const blockBtn = document.createElement('button');
      blockBtn.className = 'btn btn-small btn-danger btn-profile-block';
      blockBtn.textContent = isBlocking ? '차단 해제' : '차단';
      blockBtn.addEventListener('click', async () => {
        const currentlyBlocking = isMisskey ? !!relation?.isBlocking : !!relation?.blocking;
        if (!currentlyBlocking && !confirm('이 사용자를 차단하시겠습니까?')) return;
        blockBtn.disabled = true;
        try {
          if (isMisskey) {
            currentlyBlocking ? await client.unblockUser(user.id) : await client.blockUser(user.id);
            if (relation) relation.isBlocking = !currentlyBlocking;
          } else {
            currentlyBlocking ? await client.unblockAccount(user.id) : await client.blockAccount(user.id);
            if (relation) relation.blocking = !currentlyBlocking;
          }
          blockBtn.textContent = (isMisskey ? relation?.isBlocking : relation?.blocking) ? '차단 해제' : '차단';
        } catch (err) {
          this.showToast('차단 실패: ' + err.message);
        } finally {
          blockBtn.disabled = false;
        }
      });

      actionsEl.appendChild(muteWrap);
      actionsEl.appendChild(blockBtn);
    } catch (err) {
      console.error('Failed to load follow relation:', err);
    }
  },

  async _loadOtherProfileTabs(userId, platform, accountId, client, isMisskey, account, tabsEl, postsEl) {
    // Replace default tab buttons with Posts/Pinned (+ Pages if supported)
    const showPages = this.store.supportsPages(account);
    tabsEl.innerHTML = `
      <button class="profile-tab active" data-profile-tab="posts">게시물</button>
      <button class="profile-tab" data-profile-tab="pinned">고정됨</button>
      ${showPages ? '<button class="profile-tab" data-profile-tab="pages">페이지</button>' : ''}
    `;

    // Tab switching
    const tabClickHandler = async (e) => {
      const tab = e.target.closest('.profile-tab');
      if (!tab) return;
      const tabName = tab.dataset.profileTab;
      if (!tabName) return;
      tabsEl.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      postsEl.innerHTML = '<div class="profile-posts-empty"><div class="spinner"></div></div>';

      try {
        if (tabName === 'posts') {
          await this._loadProfilePosts(postsEl, client, account, userId);
        } else if (tabName === 'pinned') {
          await this._loadProfilePinned(postsEl, client, account, userId);
        } else if (tabName === 'pages') {
          await this._loadProfilePages(postsEl, client, account, userId);
        }
      } catch (err) {
        postsEl.innerHTML = `<div class="profile-posts-empty">로딩 오류: ${err.message}</div>`;
      }
    };
    tabsEl.addEventListener('click', tabClickHandler);
    this._profileTabsClickHandler = tabClickHandler;

    // Load default tab (posts)
    await this._loadProfilePosts(postsEl, client, account, userId);
  },

  async _loadProfilePosts(container, client, account, userId) {
    container.innerHTML = '<div class="profile-posts-empty"><div class="spinner"></div></div>';
    try {
      let posts;
      if (account.platform === 'mastodon') {
        const items = await client.getUserStatuses(userId, 20);
        posts = items.map(s => {
          const p = client.normalizePost(s);
          p.accountId = account.id;
          p.accountPlatform = account.platform;
          p.themeColor = account.themeColor;
          const ownerId = p.rebloggedBy ? p.rebloggedBy.id : p.author.id;
          p.isOwn = String(ownerId) === String(account.profile?.id);
          return p;
        });
      } else {
        const items = await client.getUserNotes(userId, 20);
        posts = items.map(n => {
          const p = client.normalizePost(n);
          p.accountId = account.id;
          p.accountPlatform = account.platform;
          p.themeColor = account.themeColor;
          const ownerId = p.rebloggedBy ? p.rebloggedBy.id : p.author.id;
          p.isOwn = String(ownerId) === String(account.profile?.id);
          return p;
        });
      }
      container.innerHTML = '';
      if (posts.length === 0) {
        container.innerHTML = '<div class="profile-posts-empty">게시물이 없습니다.</div>';
        return;
      }
      for (const post of posts) {
        if (this.postCache) this.postCache.set(`${post.platform}:${post.id}`, post);
        container.appendChild(renderPost(post));
      }
      this.enrichLinkCards(container);
    } catch (err) {
      container.innerHTML = `<div class="profile-posts-empty">게시물 로딩 오류: ${err.message}</div>`;
    }
  },

  async _loadProfilePinned(container, client, account, userId) {
    container.innerHTML = '<div class="profile-posts-empty"><div class="spinner"></div></div>';
    try {
      let posts;
      if (account.platform === 'mastodon') {
        const items = await client.getPinnedStatuses(userId);
        posts = items.map(s => {
          const p = client.normalizePost(s);
          p.accountId = account.id;
          p.accountPlatform = account.platform;
          p.themeColor = account.themeColor;
          p.pinned = true;
          p.isOwn = String(p.author.id) === String(account.profile?.id);
          return p;
        });
      } else {
        const items = await client.getPinnedNotes(userId);
        posts = items.map(n => {
          const p = client.normalizePost(n);
          p.accountId = account.id;
          p.accountPlatform = account.platform;
          p.themeColor = account.themeColor;
          p.pinned = true;
          p.isOwn = String(p.author.id) === String(account.profile?.id);
          return p;
        });
      }
      container.innerHTML = '';
      if (posts.length === 0) {
        container.innerHTML = '<div class="profile-posts-empty">고정된 게시물이 없습니다.</div>';
        return;
      }
      for (const post of posts) {
        if (this.postCache) this.postCache.set(`${post.platform}:${post.id}`, post);
        container.appendChild(renderPost(post));
      }
      this.enrichLinkCards(container);
    } catch (err) {
      container.innerHTML = `<div class="profile-posts-empty">고정 게시물 로딩 오류: ${err.message}</div>`;
    }
  },

  async _loadProfileFollowers(container, client, account, userId) {
    container.innerHTML = '<div class="profile-posts-empty"><div class="spinner"></div></div>';
    try {
      let users;
      if (account.platform === 'mastodon') {
        const items = await client.getFollowers(userId, 40);
        users = items.map(u => client.normalizeUser(u));
      } else {
        const items = await client.getFollowers(userId, 40);
        users = items.map(f => client.normalizeUser(f.follower || f));
      }
      container.innerHTML = '';
      if (users.length === 0) {
        container.innerHTML = '<div class="profile-posts-empty">팔로워가 없습니다.</div>';
        return;
      }
      for (const user of users) {
        const card = document.createElement('div');
        card.className = 'user-list-item';
        card.innerHTML = `
          <img class="user-list-avatar" src="${user.avatarUrl || ''}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
          <div class="user-list-info">
            <div class="user-list-name">${user.displayNameHtml || ''}</div>
            <div class="user-list-acct">@${user.acct || user.username || ''}</div>
          </div>
        `;
        card.addEventListener('click', () => {
          this.openProfileModal(user, account.platform, account.id);
        });
        container.appendChild(card);
      }
    } catch (err) {
      container.innerHTML = `<div class="profile-posts-empty">팔로워 로딩 오류: ${err.message}</div>`;
    }
  },

  async _loadProfileFollowing(container, client, account, userId) {
    container.innerHTML = '<div class="profile-posts-empty"><div class="spinner"></div></div>';
    try {
      let users;
      if (account.platform === 'mastodon') {
        const items = await client.getFollowing(userId, 40);
        users = items.map(u => client.normalizeUser(u));
      } else {
        const items = await client.getFollowing(userId, 40);
        users = items.map(f => client.normalizeUser(f.followee || f));
      }
      container.innerHTML = '';
      if (users.length === 0) {
        container.innerHTML = '<div class="profile-posts-empty">팔로잉이 없습니다.</div>';
        return;
      }
      for (const user of users) {
        const card = document.createElement('div');
        card.className = 'user-list-item';
        card.innerHTML = `
          <img class="user-list-avatar" src="${user.avatarUrl || ''}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
          <div class="user-list-info">
            <div class="user-list-name">${user.displayNameHtml || ''}</div>
            <div class="user-list-acct">@${user.acct || user.username || ''}</div>
          </div>
        `;
        card.addEventListener('click', () => {
          this.openProfileModal(user, account.platform, account.id);
        });
        container.appendChild(card);
      }
    } catch (err) {
      container.innerHTML = `<div class="profile-posts-empty">팔로잉 로딩 오류: ${err.message}</div>`;
    }
  },

  _createUserListItemWithAction(user, account, client, isFollowing) {
    const card = document.createElement('div');
    card.className = 'user-list-item';

    const infoArea = document.createElement('div');
    infoArea.className = 'user-list-item-left';
    infoArea.innerHTML = `
      <img class="user-list-avatar" src="${user.avatarUrl || ''}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
      <div class="user-list-info">
        <div class="user-list-name">${user.displayNameHtml || ''}</div>
        <div class="user-list-acct">@${user.acct || user.username || ''}</div>
      </div>
    `;
    infoArea.addEventListener('click', () => {
      this.openProfileModal(user, account.platform, account.id);
    });

    const btn = document.createElement('button');
    btn.className = isFollowing ? 'btn btn-small user-list-follow-btn following' : 'btn btn-small user-list-follow-btn';
    btn.textContent = isFollowing ? '팔로잉' : '팔로우';

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      try {
        const currentlyFollowing = btn.classList.contains('following');
        if (currentlyFollowing) {
          await client.unfollowUser(user.id);
          btn.classList.remove('following');
          btn.textContent = '팔로우';
        } else {
          await client.followUser(user.id);
          btn.classList.add('following');
          btn.textContent = '팔로잉';
        }
      } catch (err) {
        this.showToast('팔로우 변경 실패: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    });

    card.appendChild(infoArea);
    card.appendChild(btn);
    return card;
  },

  async _loadProfileFollowersWithActions(container, client, account, userId) {
    container.innerHTML = '<div class="profile-posts-empty"><div class="spinner"></div></div>';
    try {
      let users;
      const isMisskey = account.platform !== 'mastodon';
      if (isMisskey) {
        const items = await client.getFollowers(userId, 40);
        users = items.map(f => client.normalizeUser(f.follower || f));
      } else {
        const items = await client.getFollowers(userId, 40);
        users = items.map(u => client.normalizeUser(u));
      }
      container.innerHTML = '';
      if (users.length === 0) {
        container.innerHTML = '<div class="profile-posts-empty">팔로워가 없습니다.</div>';
        return;
      }

      // Show cards immediately (without follow status)
      const cardMap = new Map();
      for (const user of users) {
        const card = this._createUserListItemWithAction(user, account, client, false);
        cardMap.set(user.id, card);
        container.appendChild(card);
      }

      // Then update follow status in background
      try {
        if (isMisskey) {
          for (const user of users) {
            client.getRelation(user.id).then(rel => {
              if (rel?.isFollowing) {
                const card = cardMap.get(user.id);
                if (!card) return;
                const btn = card.querySelector('.user-list-follow-btn');
                if (btn) { btn.classList.add('following'); btn.textContent = '팔로잉'; }
              }
            }).catch(() => {});
          }
        } else {
          const ids = users.map(u => u.id);
          const rels = await client.getRelationships(ids);
          for (const r of rels) {
            if (r.following) {
              const card = cardMap.get(r.id);
              if (!card) continue;
              const btn = card.querySelector('.user-list-follow-btn');
              if (btn) { btn.classList.add('following'); btn.textContent = '팔로잉'; }
            }
          }
        }
      } catch (_) { /* proceed without relation info */ }
    } catch (err) {
      container.innerHTML = `<div class="profile-posts-empty">팔로워 로딩 오류: ${err.message}</div>`;
    }
  },

  async _loadProfileFollowingWithActions(container, client, account, userId) {
    container.innerHTML = '<div class="profile-posts-empty"><div class="spinner"></div></div>';
    try {
      let users;
      const isMisskey = account.platform !== 'mastodon';
      if (isMisskey) {
        const items = await client.getFollowing(userId, 40);
        users = items.map(f => client.normalizeUser(f.followee || f));
      } else {
        const items = await client.getFollowing(userId, 40);
        users = items.map(u => client.normalizeUser(u));
      }
      container.innerHTML = '';
      if (users.length === 0) {
        container.innerHTML = '<div class="profile-posts-empty">팔로잉이 없습니다.</div>';
        return;
      }

      // All users in following list are followed by me
      for (const user of users) {
        const card = this._createUserListItemWithAction(user, account, client, true);
        container.appendChild(card);
      }
    } catch (err) {
      container.innerHTML = `<div class="profile-posts-empty">팔로잉 로딩 오류: ${err.message}</div>`;
    }
  },
};
