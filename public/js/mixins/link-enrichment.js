/**
 * Link Enrichment Mixin
 * Fetches OG metadata and resolves fediverse post links in link cards.
 */
import { escapeHtml } from '../ui/utils.js';

export const LinkEnrichmentMixin = {

  enrichLinkCards(container) {
    // Resolve fediverse post links first
    const fediCards = container.querySelectorAll('.link-card[data-fedi-pending]');
    for (const card of fediCards) {
      const url = card.dataset.fediUrl;
      if (!url) continue;
      card.removeAttribute('data-fedi-pending');
      this._enrichSingleCard(card, url);
    }
    // Then handle regular OG cards
    const cards = container.querySelectorAll('.link-card[data-og-pending]');
    for (const card of cards) {
      const url = card.dataset.ogUrl;
      if (!url) continue;
      card.removeAttribute('data-og-pending');
      this._enrichSingleCard(card, url);
    }
  },

  _isFediPostUrl(url) {
    try {
      const u = new URL(url);
      // Misskey/Calckey/Firefish: /notes/xxxx
      if (/^\/notes\/[a-zA-Z0-9]+$/.test(u.pathname)) return true;
      // Mastodon: /@user/123456 or /@user@host/123456
      if (/^\/@[^/]+\/\d+$/.test(u.pathname)) return true;
      // GoToSocial: /@user/statuses/01XXXX
      if (/^\/@[^/]+\/statuses\/[a-zA-Z0-9]+$/.test(u.pathname)) return true;
      // Pleroma/Akkoma: /notice/xxxx or /objects/xxxx
      if (/^\/(notice|objects)\/[a-zA-Z0-9\-]+$/.test(u.pathname)) return true;
      // ActivityPub standard: /users/xxx/statuses/xxx
      if (/^\/users\/[^/]+\/statuses\/[a-zA-Z0-9]+$/.test(u.pathname)) return true;
      return false;
    } catch { return false; }
  },

  async _resolveAsFediPost(url) {
    // Try resolving via any available account
    const accounts = this.store.getAll();
    for (const account of accounts) {
      const client = this.store.getClient(account.id);
      if (!client?.resolveUrl) continue;
      try {
        const post = await client.resolveUrl(url);
        if (post) return { post, accountId: account.id };
      } catch { /* try next */ }
    }
    return null;
  },

  _buildFediEmbedHtml(post) {
    const dp = post.reblog || post;
    const author = dp.author || {};
    const avatarUrl = escapeHtml(author.avatarUrl || '');
    const displayName = author.displayNameHtml || escapeHtml(author.displayName || '');
    const acct = escapeHtml(author.acct || '');
    const content = dp.content || '';
    const media = dp.media || [];
    const images = media.filter(m => m.type !== 'video').slice(0, 4);

    let html = `
      <div class="quote-post fedi-embed" data-fedi-url="${escapeHtml(dp.url || '')}" data-post-id="${escapeHtml(dp.id || '')}" data-platform="${dp.platform || ''}">
        <div class="quote-post-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" opacity="0.6"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg> 연합 글</div>
        <div class="quote-post-body">
          <div class="quote-post-text-area">
            <div class="quote-post-header">
              <img class="quote-post-avatar" src="${avatarUrl}" alt="" referrerpolicy="no-referrer" data-fb="hide">
              <span class="quote-post-author">${displayName}</span>
              <span class="quote-post-handle">@${acct}</span>
            </div>`;

    if (dp.contentWarning) {
      html += `<div class="quote-post-cw"><span class="icon-inline cw-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span> ${escapeHtml(dp.contentWarning)}</div>`;
    } else {
      html += `<div class="quote-post-content">${content}</div>`;
    }

    html += `</div>`;

    if (images.length === 1) {
      html += `<div class="quote-post-thumb"><img src="${images[0].previewUrl || images[0].url}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fb="hide-parent"></div>`;
    }
    html += `</div>`;

    if (images.length > 1) {
      html += `<div class="quote-post-media media-${images.length}">${images.map(m => `<img src="${m.previewUrl || m.url}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fb="hide">`).join('')}</div>`;
    }

    html += `</div>`;
    return html;
  },

  async _enrichSingleCard(card, url) {
    // Try to resolve as fediverse post first
    if (this._isFediPostUrl(url)) {
      try {
        const result = await this._resolveAsFediPost(url);
        if (result) {
          const { post, accountId: resolvedAccountId } = result;
          const embedHtml = this._buildFediEmbedHtml(post);
          const wrapper = document.createElement('div');
          wrapper.innerHTML = embedHtml;
          const embed = wrapper.firstElementChild;
          // Make clickable to open thread
          embed.style.cursor = 'pointer';
          embed.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (post.id && resolvedAccountId) {
              this.openThreadView(post.id, post.platform, resolvedAccountId);
            } else {
              window.open(url, '_blank', 'noopener');
            }
          });
          card.replaceWith(embed);
          return;
        }
      } catch { /* fall through to OG */ }
    }

    let og = this._ogCache.get(url);
    if (!og) {
      try {
        const res = await fetch(`/api/og?url=${encodeURIComponent(url)}`);
        if (!res.ok) return;
        og = await res.json();
        if (og.error) return;
        this._ogCache.set(url, og);
        // Evict oldest entries if over limit
        if (this._ogCache.size > (this._OG_CACHE_MAX || 200)) {
          const toDelete = this._ogCache.size - (this._OG_CACHE_MAX || 200);
          const keys = this._ogCache.keys();
          for (let i = 0; i < toDelete; i++) {
            this._ogCache.delete(keys.next().value);
          }
        }
      } catch { return; }
    }

    // Update the card DOM with OG data
    if (og.image) {
      const img = document.createElement('img');
      img.className = 'link-card-image';
      img.src = og.image;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function() {
        this.parentElement.classList.remove('link-card-has-image');
        this.style.display = 'none';
      };
      card.classList.add('link-card-has-image');
      card.prepend(img);
    }

    const infoEl = card.querySelector('.link-card-info');
    if (!infoEl) return;

    if (og.siteName) {
      const siteEl = infoEl.querySelector('.link-card-site');
      if (siteEl) siteEl.textContent = og.siteName;
    }
    if (og.title) {
      const urlEl = infoEl.querySelector('.link-card-url');
      if (urlEl) urlEl.remove();
      const titleEl = document.createElement('div');
      titleEl.className = 'link-card-title';
      titleEl.textContent = og.title;
      const siteEl = infoEl.querySelector('.link-card-site');
      if (siteEl) siteEl.after(titleEl);
    }
    if (og.description) {
      const descEl = document.createElement('div');
      descEl.className = 'link-card-desc';
      descEl.textContent = og.description;
      infoEl.appendChild(descEl);
    }
  },
};
