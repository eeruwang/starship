/**
 * Profile Modal Mixin
 * Handles the profile modal: opening, profile editing, notes tabs, follow relations
 */
import { escapeHtml } from '../ui/utils.js';
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
    const client = this.store.getClient(accountId);
    if (!client) return;

    try {
      const user = await client.getUser(author.id);
      if (!user) return;

      this._renderProfileHeader(user, platform, {
        banner, avatar, nameEl, handleEl, bioEl, statsEl, fieldsEl,
        stickyAvatar, stickyName, stickyHandle, client,
      });

      // Check if this is my account
      const myAccount = this.store.getAll().find(a =>
        String(a.profile?.id) === String(user.id) && a.platform === platform
      );
      const account = this.store.getById(accountId);
      const instanceUrl = account?.instanceUrl || '';
      const isMisskey = platform !== 'mastodon';

      // Actions
      let actionsHtml = `<a class="btn btn-secondary btn-small" href="${instanceUrl}/@${user.username}" target="_blank" rel="noopener">인스턴스에서 보기</a>`;
      if (myAccount) {
        actionsHtml += `<button class="btn btn-primary btn-small" id="btn-profile-edit">프로필 수정</button>`;
      }
      actionsEl.innerHTML = actionsHtml;

      // Show notes tabs for own account
      if (myAccount) {
        tabsEl.style.display = 'flex';
        postsEl.style.display = 'block';
        this._loadProfileNotes(user.id, platform, accountId, client, isMisskey, account);
      }

      // Follow relationship for other users
      if (!myAccount) {
        this._loadFollowRelation(user, platform, accountId, client, isMisskey, instanceUrl, actionsEl);
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
      <span class="profile-stat"><strong>${followers}</strong> 팔로워</span>
      <span class="profile-stat"><strong>${following}</strong> 팔로잉</span>
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
    editBannerInput.onchange = () => {
      const file = editBannerInput.files[0];
      if (!file) return;
      this._profileEditBannerFile = file;
      const url = URL.createObjectURL(file);
      banner.style.background = 'none';
      banner.style.backgroundImage = `url(${url})`;
      banner.style.backgroundSize = 'cover';
      banner.style.backgroundPosition = 'center';
    };
    editAvatarBtn.onclick = () => editAvatarInput.click();
    editAvatarInput.onchange = () => {
      const file = editAvatarInput.files[0];
      if (!file) return;
      this._profileEditAvatarFile = file;
      avatar.src = URL.createObjectURL(file);
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
      const newTabs = tabsEl.cloneNode(true);
      tabsEl.replaceWith(newTabs);
      this._profileState.tabsEl = newTabs;
      this._updateProfileTabCounts();
      this._renderProfileTab('notes', postsEl);

      // Tab click
      newTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.profile-tab');
        if (!tab) return;
        const tabName = tab.dataset.profileTab;
        if (!tabName) return;
        newTabs.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this._profileState.activeTab = tabName;
        this._renderProfileTab(tabName, postsEl);
      });

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

  async _loadFollowRelation(user, platform, accountId, client, isMisskey, instanceUrl, actionsEl) {
    try {
      let isFollowing = false;
      let isFollowedBy = false;

      if (isMisskey) {
        const rel = await client.getRelation(user.id);
        isFollowing = !!rel?.isFollowing;
        isFollowedBy = !!rel?.isFollowed;
      } else {
        const rels = await client.getRelationships([user.id]);
        if (rels && rels.length > 0) {
          isFollowing = !!rels[0].following;
          isFollowedBy = !!rels[0].followed_by;
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

      // Hover state for unfollow
      if (isFollowing) {
        followBtn.addEventListener('mouseenter', () => { followBtn.textContent = '팔로우 해제'; followBtn.classList.add('unfollow-hover'); });
        followBtn.addEventListener('mouseleave', () => { followBtn.textContent = '팔로우 중'; followBtn.classList.remove('unfollow-hover'); });
        followBtn.textContent = '팔로우 중';
      }

      followBtn.addEventListener('click', async () => {
        followBtn.disabled = true;
        try {
          if (isFollowing) {
            if (isMisskey) await client.unfollowUser(user.id);
            else await client.unfollowUser(user.id);
            isFollowing = false;
          } else {
            if (isMisskey) await client.followUser(user.id);
            else await client.followUser(user.id);
            isFollowing = true;
          }
          // Refresh the UI
          this._loadFollowRelation(user, platform, accountId, client, isMisskey, instanceUrl, actionsEl);
        } catch (err) {
          this.showToast('팔로우 처리 실패: ' + err.message);
        } finally {
          followBtn.disabled = false;
        }
      });

      actionsEl.appendChild(followBtn);
    } catch (err) {
      console.error('Failed to load follow relation:', err);
    }
  },
};
