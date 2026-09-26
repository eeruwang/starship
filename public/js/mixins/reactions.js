/**
 * Reactions Mixin
 *
 * Extracted from data-loading.js — everything to do with:
 *   • Cross-fork reaction promotion (favourite → reaction)
 *   • Multi-phase enrichment fetch (own server, actor host, Misskey resolveUrl)
 *   • Confidence-ranked assignment + negative locking
 *   • Custom emoji URL lookup + per-instance emoji map caching
 *   • NodeInfo software detection + unauth API helpers
 *   • Retry queue for un-resolved notifications
 *
 * All methods are mixed into the app object alongside DataLoadingMixin, so
 * `this.postCache`, `this.store`, `this._setCachedPost`, and friends resolve
 * exactly as before the split.
 */
import { renderPost, renderNotification } from '../ui/dashboard.js';

export const ReactionsMixin = {

  _adjustFavouritesForReactions(dp) {
    if (!dp.reactions || !dp.stats || !dp.stats.favourites) return;
    // Only subtract non-heart reactions: ❤ reactions are equivalent to favourites
    // and should remain in the favourite count. Custom emoji reactions are federated
    // as Likes by Misskey, so Mastodon double-counts them — subtract those only.
    const nonHeartReactions = Object.entries(dp.reactions)
      .filter(([k]) => k !== '❤' && k !== '❤️')
      .reduce((sum, [, c]) => sum + c, 0);
    dp.stats.favourites = Math.max(0, dp.stats.favourites - nonHeartReactions);
  },

  // === Reaction enrichment confidence model ===
  // Higher number = higher confidence. Lower-confidence sources can't overwrite
  // a higher-confidence assignment, and a "resolved-negative" (we know the
  // actor did NOT make an emoji reaction) is absolute — no later path may
  // upgrade it to a reaction.
  _REACTION_CONFIDENCE: {
    none: 0,
    low: 1,         // _promoteFavouriteToReaction — aggregate guess
    inferred: 2,    // Phase 2a single-emoji inference, Phase 4 unauth per-user
    authoritative: 3, // Phase 3 authenticated Misskey per-user, Phase 2b own server
  },

  // Assign a reaction emoji/url to a notification, respecting confidence rank.
  // Returns true when a (possibly identical) update was applied, false when
  // skipped due to a higher-confidence existing assignment or a negative lock.
  _assignReaction(notif, { emoji, emojiUrl = null, source = 'inferred', emojiBaseUrl = '' }) {
    if (!notif) return false;
    if (notif._reactionResolvedNegative) return false; // absolute lock
    const cur = this._REACTION_CONFIDENCE[notif._reactionSource || 'none'];
    const next = this._REACTION_CONFIDENCE[source] ?? 0;
    if (next < cur) return false;
    // Compute URL with fallbacks (only when not provided)
    let url = emojiUrl;
    const customMatch = emoji.match(/^:(.+):$/);
    if (customMatch && !url) {
      const name = customMatch[1];
      const baseName = name.replace(/@\.$/, '');
      if (emojiBaseUrl && !baseName.includes('@')) {
        url = `${emojiBaseUrl.replace(/\/+$/, '')}/emoji/${encodeURIComponent(baseName)}.webp`;
      }
    }
    notif.type = 'reaction';
    notif.label = '리액션';
    notif.reactionEmoji = emoji;
    notif.icon = emoji;
    notif.reactionEmojiUrl = url || notif.reactionEmojiUrl || null;
    notif._reactionSource = source;
    const actorKey = notif.actor?.acct || notif.actor?.id || '';
    const postKey = notif.post?.canonicalUri || notif.post?.id || '';
    notif._dedupKey = `reaction:${actorKey}:${postKey}:${emoji}`;
    return true;
  },

  // Mark that an authoritative source confirmed the actor did NOT emoji-react
  // (per-user fetch succeeded but actor not in result). Locks the notification
  // as plain favourite forever — no subsequent phase may promote it.
  _markReactionResolvedNegative(notif) {
    if (!notif) return;
    notif._reactionResolvedNegative = true;
    // Demote any prior low/inferred assignment back to favourite
    if (notif.type === 'reaction' && (notif._reactionSource === 'low' || notif._reactionSource === 'inferred')) {
      notif.type = 'favourite';
      notif.label = '좋아요';
      notif.reactionEmoji = null;
      notif.reactionEmojiUrl = null;
      notif.icon = null;
      notif._reactionSource = null;
      const actorKey = notif.actor?.acct || notif.actor?.id || '';
      const postKey = notif.post?.canonicalUri || notif.post?.id || '';
      notif._dedupKey = `favourite:${actorKey}:${postKey}`;
    }
  },

  // === Retry queue for un-resolved notifications ===
  // After all enrichment phases finish, notifications that should plausibly
  // have a reaction (post had favourites_count > 0) but ended up with no
  // resolution get scheduled for retry on subsequent refresh cycles. Backoff:
  // attempt 1 → next refresh, then 2 → +60s, 3 → +5m, 4+ → drop.
  _scheduleRetry(notif, container) {
    if (!this._enrichmentRetry) this._enrichmentRetry = new Map();
    const key = notif.id + '@' + (notif.platform || 'mastodon');
    const prev = this._enrichmentRetry.get(key);
    const attempts = (prev?.attempts || 0) + 1;
    if (attempts > 3) {
      this._enrichmentRetry.delete(key);
      return;
    }
    const delays = [0, 60_000, 300_000];
    this._enrichmentRetry.set(key, {
      notif, container,
      attempts,
      nextAt: Date.now() + delays[Math.min(attempts - 1, delays.length - 1)],
    });
  },

  // Called by auto-refresh tick. Picks notifs whose nextAt has elapsed and
  // routes them through _fetchMissingReactions again.
  _processEnrichmentRetries() {
    if (!this._enrichmentRetry || this._enrichmentRetry.size === 0) return;
    const now = Date.now();
    const byContainer = new Map();
    for (const [key, entry] of this._enrichmentRetry) {
      if (entry.nextAt > now) continue;
      if (!entry.container.isConnected) { this._enrichmentRetry.delete(key); continue; }
      if (entry.notif._reactionSource === 'authoritative' || entry.notif._reactionResolvedNegative) {
        this._enrichmentRetry.delete(key);
        continue;
      }
      if (!byContainer.has(entry.container)) byContainer.set(entry.container, []);
      byContainer.get(entry.container).push(entry.notif);
      // Don't delete entry yet — _scheduleRetry will bump attempts if still unresolved
    }
    for (const [container, notifs] of byContainer) {
      this._fetchMissingReactions(notifs, container, { isNotification: true });
    }
  },

  // Routine-path warnings (unauth API rejections, instance-not-misskey, etc.)
  // run every refresh cycle and flood production console. Gate them behind a
  // localStorage flag so power users / debugging sessions can opt in.
  _debugWarn(...args) {
    if (this._debugEnabledCache === undefined) {
      try {
        this._debugEnabledCache = (typeof localStorage !== 'undefined'
          && localStorage.getItem('starship_debug') === '1');
      } catch { this._debugEnabledCache = false; }
    }
    if (this._debugEnabledCache) console.warn(...args);
  },

  // Heuristic promotion of a Mastodon favourite notification to a reaction
  // when the post carries reaction data that wasn't merged from cache (which
  // would be other users' reactions). Picks the most-counted non-heart emoji
  // and resolves a usable image URL with multiple fallbacks. Called in two
  // load paths (fresh notifications + older paginated batch).
  _promoteFavouriteToReaction(n) {
    if (!n || n.type !== 'favourite' || !n.post) return;
    // First, prefer per-user data persisted on the post (set by an authoritative
    // Phase 3 lookup in an earlier session/refresh and round-tripped through
    // postCache). This is the only path with confidence='authoritative' at
    // promote time.
    const dp = n.post.reblog || n.post;
    if (dp._reactionByUser) {
      const acctKey = this._normalizeAcct(n.actor?.acct || '', n.instanceUrl).toLowerCase();
      const emoji = acctKey ? dp._reactionByUser[acctKey] : null;
      if (emoji && emoji !== '❤' && emoji !== '❤️' && emoji !== '⭐' && emoji !== '⭐️') {
        const url = this._lookupEmojiUrl(emoji, dp, n.actor?.acct);
        this._assignReaction(n, {
          emoji, emojiUrl: url, source: 'authoritative',
          emojiBaseUrl: dp._reactionInstanceUrl || dp.instanceUrl || '',
        });
        return;
      }
      if (emoji === '❤' || emoji === '❤️' || emoji === '⭐' || emoji === '⭐️') {
        this._markReactionResolvedNegative(n);
        return;
      }
      // We have per-user data but the actor isn't in it → they really did
      // press plain favourite (or our previous fetch was paginated and missed
      // them — Phase 3 will refresh).
    }
    if (!dp.reactions || dp._reactionsFromCache) return;
    const nonHeart = Object.entries(dp.reactions)
      .filter(([k]) => k !== '❤' && k !== '❤️');
    if (nonHeart.length === 0) return;
    const [emoji] = nonHeart.sort((a, b) => b[1] - a[1])[0];
    const url = this._lookupEmojiUrl(emoji, dp, n.actor?.acct);
    this._assignReaction(n, {
      emoji, emojiUrl: url, source: 'low',
      emojiBaseUrl: dp._reactionInstanceUrl || dp.instanceUrl || '',
    });
  },

  // Persist per-user reaction mapping on the post object so subsequent
  // refreshes can answer "what did this actor react with" without re-querying
  // the Misskey API. Survives via postCache → _mergeReactionsFromCache.
  _persistReactionByUser(post, reactionByUser) {
    if (!post || !reactionByUser || reactionByUser.size === 0) return;
    const dp = post.reblog || post;
    if (!dp._reactionByUser) dp._reactionByUser = {};
    for (const [acct, emoji] of reactionByUser) {
      dp._reactionByUser[acct] = emoji;
    }
    this._setCachedPost(`${post.platform}:${post.id}`, post);
  },

  // Resolve a custom emoji shortcode to a URL using post emoji maps, actor's
  // own host, or the post's origin instance as fallbacks. Used by both promote
  // and applyReactions paths.
  _lookupEmojiUrl(emoji, dp, actorAcct) {
    const match = (emoji || '').match(/^:(.+):$/);
    if (!match) return null;
    const name = match[1];
    const baseName = name.replace(/@\.$/, '');
    let url = dp.reactionEmojis?.[name] || dp.reactionEmojis?.[name + '@.']
           || dp.emojis?.[name] || dp.emojis?.[name + '@.']
           || null;
    if (url || baseName.includes('@')) return url;
    if (actorAcct && actorAcct.includes('@')) {
      const host = actorAcct.split('@').pop();
      return `https://${host}/emoji/${encodeURIComponent(baseName)}.webp`;
    }
    const baseUrl = dp._reactionInstanceUrl || dp.instanceUrl;
    if (baseUrl) return `${baseUrl}/emoji/${encodeURIComponent(baseName)}.webp`;
    return null;
  },

  _mergeReactionsFromCache(posts) {
    if (!this.postCache || this.postCache.size === 0) return;
    // Build a canonicalUri → cached post index for fast lookup
    const uriToCache = new Map();
    for (const [, cached] of this.postCache) {
      const cdp = cached.reblog || cached;
      if (cdp.canonicalUri && cdp.reactions && Object.keys(cdp.reactions).length > 0) {
        uriToCache.set(cdp.canonicalUri, cdp);
      }
    }
    if (uriToCache.size === 0) return;

    for (const post of posts) {
      const dp = post.reblog || post;
      if (!dp.canonicalUri) continue;
      // Skip if post already has reaction data
      if (dp.reactions && Object.keys(dp.reactions).length > 0) continue;
      const cached = uriToCache.get(dp.canonicalUri);
      if (cached) {
        dp.reactions = cached.reactions;
        dp._reactionsFromCache = true;
        dp.reactionEmojis = cached.reactionEmojis || dp.reactionEmojis;
        dp.emojis = cached.emojis || dp.emojis;
        if (cached.myReaction && !dp.myReaction) dp.myReaction = cached.myReaction;
        if (cached._reactionByUser) {
          // Per-user reaction mapping: merge in, prefer existing entries on dp
          dp._reactionByUser = { ...cached._reactionByUser, ...(dp._reactionByUser || {}) };
        }
        if (cached._misskeyNoteId) dp._misskeyNoteId = cached._misskeyNoteId;
        if (cached._misskeyAccountId) dp._misskeyAccountId = cached._misskeyAccountId;
        if (cached._reactionInstanceUrl) dp._reactionInstanceUrl = cached._reactionInstanceUrl;
        if (cached._noteIdsByInstance) {
          dp._noteIdsByInstance = { ...(dp._noteIdsByInstance || {}), ...cached._noteIdsByInstance };
        }
        if (cached.id && cached.platform && cached.platform !== 'mastodon') {
          dp._misskeyNoteId = dp._misskeyNoteId || cached.id;
        }
        this._adjustFavouritesForReactions(dp);
      }
    }
  },

  // Asynchronously fetch reaction details from Misskey for Mastodon posts that have
  // favourites but no detailed reactions. Uses ap/show to look up the post on Misskey.
  // Fire-and-forget: cards are re-rendered in-place as results arrive.
  _fetchMissingReactions(items, container, { isNotification = false } = {}) {
    // Use ALL Misskey-family accounts (not just the first). Different
    // instances have different federation graphs — a post one instance can't
    // resolve may be present on another. Phase 1 / Phase 3 walks the list in
    // order until one succeeds.
    const allMisskeyAccounts = this.store.getAll().filter(a => a.platform !== 'mastodon');
    const misskeyAccount = allMisskeyAccounts[0] || null;
    const client = misskeyAccount ? this.store.getClient(misskeyAccount.id) : null;

    const misskeyHost = (() => {
      if (!misskeyAccount) return '';
      try { return new URL(misskeyAccount.instanceUrl).hostname; } catch { return ''; }
    })();

    // --- Phase 1: Patch post-level reaction data (requires authenticated Misskey client) ---
    if (client) {
      const seenUris = new Set();
      const toFetch = [];
      for (const item of items) {
        const post = isNotification ? item.post : item;
        if (!post) continue;
        const dp = post.reblog || post;
        if (dp.reactions && Object.keys(dp.reactions).length > 0) continue;
        if (!dp.stats?.favourites || dp.stats.favourites <= 0) continue;
        if (!dp.canonicalUri) continue;
        if (seenUris.has(dp.canonicalUri)) continue;
        seenUris.add(dp.canonicalUri);
        toFetch.push({ item, post, dp });
      }

      // Sequential processing to avoid Misskey rate limits
      // Prioritize posts with cached note IDs (notes/show has high rate limit)
      // Limit ap/show calls (strict rate limit) to avoid blocking user-initiated actions
      (async () => {
        let apShowCount = 0;
        const AP_SHOW_LIMIT = 3;
        for (const { item, post, dp } of toFetch.slice(0, 10)) {
          try {
            // Walk every Misskey account in the store: a post one instance
            // can't federate may live on another. Stop at the first success.
            // Cached note IDs (per instance) bypass the strict ap/show limit.
            let resolved = null;
            let usedAccount = null;
            let usedClient = null;
            for (const ma of allMisskeyAccounts) {
              const mc = this.store.getClient(ma.id);
              if (!mc) continue;
              const cachedNoteId = (dp._noteIdsByInstance && dp._noteIdsByInstance[ma.instanceUrl])
                || (ma.instanceUrl === misskeyAccount.instanceUrl ? dp._misskeyNoteId : null);
              if (cachedNoteId) {
                try {
                  const rawNote = await mc.getNote(cachedNoteId);
                  if (rawNote) { resolved = mc.normalizePost(rawNote); usedAccount = ma; usedClient = mc; break; }
                } catch { /* try next account */ }
              } else if (apShowCount < AP_SHOW_LIMIT) {
                try {
                  const r = await this._cachedResolveUrl(mc, dp.canonicalUri);
                  if (r) { resolved = r; usedAccount = ma; usedClient = mc; apShowCount++; break; }
                } catch { /* try next account */ }
              }
            }
            if (!resolved || !usedAccount) continue;
            const rdp = resolved.reblog || resolved;
            if (!rdp.reactions || Object.keys(rdp.reactions).length === 0) continue;
            dp.reactions = rdp.reactions;
            dp.reactionEmojis = rdp.reactionEmojis || dp.reactionEmojis;
            dp.emojis = rdp.emojis || dp.emojis;
            if (rdp.instanceUrl) {
              dp.instanceUrl = dp.instanceUrl || rdp.instanceUrl;
              dp._reactionInstanceUrl = rdp.instanceUrl;
            }
            if (rdp.myReaction && !dp.myReaction) dp.myReaction = rdp.myReaction;
            dp._misskeyNoteId = rdp.id;
            dp._misskeyAccountId = usedAccount.id;
            if (usedAccount.instanceUrl) {
              if (!dp._noteIdsByInstance) dp._noteIdsByInstance = {};
              dp._noteIdsByInstance[usedAccount.instanceUrl] = rdp.id;
            }
            this._adjustFavouritesForReactions(dp);
            this._setCachedPost(`${post.platform}:${post.id}`, post);

            if (isNotification) {
              for (const notif of items) {
                if (!notif.post || (notif.post.reblog || notif.post).canonicalUri !== dp.canonicalUri) continue;
                const cards = container.querySelectorAll(`.notif-card[data-notif-id="${notif.id}"]`);
                for (const card of cards) {
                  if (card.isConnected) card.replaceWith(renderNotification(notif));
                }
              }
            } else {
              const cards = container.querySelectorAll(`.post-card[data-post-id="${post.id}"][data-platform="${post.platform}"]`);
              for (const card of cards) {
                if (card.isConnected) card.replaceWith(renderPost(item));
              }
            }
          } catch { /* skip failed resolution */ }
        }
      })();
    }

    // --- Phase 1b: Best-effort unauth enrichment via post's origin instance ---
    // Phase 1 only runs when the user has a Misskey-family account. For pure
    // Mastodon users, posts that came in without reaction data would otherwise
    // never get them. Try the post's origin instance (extracted from post.url
    // or canonicalUri host) — Hollo/Akkoma/Pleroma/glitch-soc/Fedibird hold
    // the authoritative reaction state for their own posts and the public
    // emoji_reactions endpoint usually doesn't require auth.
    {
      const seenUris = new Set();
      const byOrigin = new Map();
      for (const item of items) {
        const post = isNotification ? item.post : item;
        if (!post) continue;
        const dp = post.reblog || post;
        if (dp.reactions && Object.keys(dp.reactions).length > 0) continue;
        if (!dp.stats?.favourites || dp.stats.favourites <= 0) continue;
        const ref = dp.url || dp.canonicalUri;
        if (!ref) continue;
        if (seenUris.has(ref)) continue;
        let parsed;
        try { parsed = new URL(ref); } catch { continue; }
        if (parsed.protocol !== 'https:') continue;
        seenUris.add(ref);
        const originUrl = `https://${parsed.host}`;
        if (!byOrigin.has(originUrl)) byOrigin.set(originUrl, []);
        byOrigin.get(originUrl).push({ item, post, dp, postUrl: ref });
      }

      const REACTIONS_MASTODON_COMPAT = new Set(['hollo', 'fedibird', 'glitchcafe', 'akkoma', 'pleroma']);
      const MISSKEY_FAMILY = new Set([
        'misskey', 'sharkey', 'firefish', 'iceshrimp', 'iceshrimp.net',
        'cherrypick', 'foundkey', 'hajkey', 'catodon',
      ]);
      const originLimit = 6;
      const perOriginLimit = 5;
      let originSeen = 0;
      for (const [originUrl, posts] of byOrigin) {
        if (++originSeen > originLimit) break;
        const subset = posts.slice(0, perOriginLimit);
        (async () => {
          const software = await this._detectInstanceSoftware(originUrl);
          if (!software) return;

          const applyAndRender = (item, post, dp, reactions, reactionEmojis) => {
            if (!reactions || Object.keys(reactions).length === 0) return;
            dp.reactions = reactions;
            dp.reactionEmojis = { ...(dp.reactionEmojis || {}), ...reactionEmojis };
            dp._reactionInstanceUrl = dp._reactionInstanceUrl || originUrl;
            this._adjustFavouritesForReactions(dp);
            this._setCachedPost(`${post.platform}:${post.id}`, post);
            if (isNotification) {
              const cards = container.querySelectorAll(`.notif-card[data-notif-id="${item.id}"]`);
              for (const card of cards) {
                if (card.isConnected) card.replaceWith(renderNotification(item));
              }
            } else {
              const cards = container.querySelectorAll(`.post-card[data-post-id="${post.id}"][data-platform="${post.platform}"]`);
              for (const card of cards) {
                if (card.isConnected) card.replaceWith(renderPost(item));
              }
            }
          };

          if (REACTIONS_MASTODON_COMPAT.has(software)) {
            for (const { item, post, dp, postUrl } of subset) {
              try {
                if (dp.reactions && Object.keys(dp.reactions).length > 0) continue;
                let localId = this._extractStatusIdFromUrl(postUrl, software);
                if (!localId) {
                  try {
                    const search = await this._unauthMastodonGet(
                      originUrl,
                      `/api/v2/search?q=${encodeURIComponent(postUrl)}&type=statuses&resolve=false&limit=1`
                    );
                    if (search?.statuses?.length) localId = search.statuses[0].id;
                  } catch { /* search may require auth */ }
                }
                if (!localId) continue;

                const reactionsPath = (software === 'akkoma' || software === 'pleroma')
                  ? `/api/v1/pleroma/statuses/${encodeURIComponent(localId)}/reactions`
                  : `/api/v1/statuses/${encodeURIComponent(localId)}/emoji_reactions`;
                let reactionsArr;
                try {
                  reactionsArr = await this._unauthMastodonGet(originUrl, reactionsPath);
                } catch { continue; }
                if (!Array.isArray(reactionsArr) || reactionsArr.length === 0) continue;

                const reactions = {};
                const reactionEmojis = {};
                for (const r of reactionsArr) {
                  if (!r.name || !r.count) continue;
                  reactions[r.name] = r.count;
                  if (/^:.+:$/.test(r.name) && r.url) {
                    reactionEmojis[r.name.replace(/^:|:$/g, '')] = r.url;
                  }
                }
                applyAndRender(item, post, dp, reactions, reactionEmojis);
              } catch (e) {
                this._debugWarn('[StarShip] mastodon-compat origin enrichment error:', e?.message || e);
              }
            }
          } else if (MISSKEY_FAMILY.has(software)) {
            for (const { item, post, dp, postUrl } of subset) {
              try {
                if (dp.reactions && Object.keys(dp.reactions).length > 0) continue;
                // Try URL-pattern parse first: /notes/{id}
                let noteId = null;
                try {
                  const u = new URL(postUrl);
                  const m = u.pathname.match(/^\/notes\/([\w-]+)\/?$/);
                  if (m) noteId = m[1];
                } catch { /* parse failed */ }
                if (!noteId) {
                  // Fallback: ap/show with the URI
                  try {
                    const apResult = await this._unauthMisskeyRequest(originUrl, 'ap/show', { uri: postUrl });
                    if (apResult?.type === 'Note' && apResult.object?.id) noteId = apResult.object.id;
                  } catch { continue; }
                }
                if (!noteId) continue;

                let note;
                try {
                  note = await this._unauthMisskeyRequest(originUrl, 'notes/show', { noteId });
                } catch { continue; }
                const reactions = note?.reactions || null;
                if (!reactions || Object.keys(reactions).length === 0) continue;
                const reactionEmojis = note.reactionEmojis || {};
                applyAndRender(item, post, dp, reactions, reactionEmojis);
              } catch (e) {
                this._debugWarn('[StarShip] misskey origin enrichment error:', e?.message || e);
              }
            }
          }
        })();
      }
    }

    // --- Phase 2: Convert Mastodon favourite notifications to reactions ---
    // Also include 'reaction' notifications that arrived without an emoji
    // payload (some Mastodon-compat servers preserve the type but strip the
    // emoji during federation, so the badge would otherwise fall back to a
    // heart). These get the same enrichment treatment.
    if (!isNotification) return;

    const favNotifs = items.filter(n =>
      n.platform === 'mastodon' && n.post
      && ((n.type === 'favourite') || (n.type === 'reaction' && !n.reactionEmoji))
    );
    if (favNotifs.length === 0) return;

    // Group by canonical URI (deduplicated)
    const favByUri = new Map();
    for (const notif of favNotifs) {
      const dp = notif.post.reblog || notif.post;
      const uri = dp.canonicalUri;
      if (!uri) continue;
      if (!favByUri.has(uri)) favByUri.set(uri, []);
      favByUri.get(uri).push(notif);
    }

    // Shared helper: apply resolved reaction data to notification group.
    // `source` indicates the confidence: 'authoritative' (Phase 3 / Phase 2b
    // per-user from real API), 'inferred' (Phase 2a single-emoji guess,
    // Phase 4 unauth per-user), or 'low' (used by promote only). When the
    // lookup ran successfully AND the actor wasn't in the result, we mark the
    // notif as resolved-negative so it stays as a plain favourite for good.
    const applyReactions = (groupNotifs, reactionByUser, reactionEmojis, emojiBaseUrl, source = 'authoritative', { ground = false } = {}) => {
      let changed = false;
      for (const notif of groupNotifs) {
        if (notif._reactionResolvedNegative) continue;
        const actorAcct = notif.actor?.acct
          ? this._normalizeAcct(notif.actor.acct, notif.instanceUrl).toLowerCase()
          : null;
        if (!actorAcct) continue;

        const emoji = reactionByUser.get(actorAcct);
        if (!emoji) {
          // Ground-truth fetches (Phase 3 per-user) know the full reactor set.
          // Actor not in it = they didn't react with an emoji. Lock so no later
          // inference may flip them to the wrong emoji.
          if (ground && source === 'authoritative') this._markReactionResolvedNegative(notif);
          continue;
        }
        // Default-favourite reactions are federated Mastodon favourites — don't
        // convert. misskey.io and older Misskey deployments record default
        // favourites as ⭐, newer ones as ❤. Both signal "just a Like".
        if (emoji === '❤' || emoji === '❤️' || emoji === '⭐' || emoji === '⭐️') {
          if (ground && source === 'authoritative') this._markReactionResolvedNegative(notif);
          continue;
        }

        // Resolve custom emoji URL through the shared lookup (post emoji maps,
        // actor host, post origin) — keeps fallbacks consistent across phases.
        let url = null;
        const customMatch = emoji.match(/^:(.+):$/);
        if (customMatch) {
          const name = customMatch[1];
          url = reactionEmojis?.[name] || reactionEmojis?.[name + '@.'] || null;
        }
        if (!url) {
          const dp = notif.post?.reblog || notif.post;
          if (dp) url = this._lookupEmojiUrl(emoji, dp, notif.actor?.acct);
          if (!url && customMatch) {
            const baseName = customMatch[1].replace(/@\.$/, '');
            if (emojiBaseUrl) url = `${emojiBaseUrl.replace(/\/+$/, '')}/emoji/${encodeURIComponent(baseName)}.webp`;
          }
        }
        const applied = this._assignReaction(notif, { emoji, emojiUrl: url, source, emojiBaseUrl });
        if (applied) changed = true;
      }
      return changed;
    };

    const rerenderGroup = (groupNotifs) => {
      for (const notif of groupNotifs) {
        // Re-render reactions AND notifs demoted back to favourite by a
        // ground-truth negative resolution, so the badge stays in sync.
        if (notif.type !== 'reaction' && !notif._reactionResolvedNegative) continue;
        const cards = container.querySelectorAll(`.notif-card[data-notif-id="${notif.id}"]`);
        for (const card of cards) {
          if (!card.isConnected) continue;
          if (notif._dedupKey) {
            const dupCard = container.querySelector(`.notif-card[data-dedup-key="${CSS.escape(notif._dedupKey)}"]`);
            if (dupCard && dupCard !== card && dupCard.isConnected) {
              card.remove();
              continue;
            }
          }
          card.replaceWith(renderNotification(notif));
        }
      }
    };

    // --- Phase 2a: Cheap inference from cached post.reactions ---
    // Hollo/Mastodon-compat actors aren't reachable via the Misskey paths
    // below (their instances aren't Misskey API-compatible). Before giving
    // up and leaving such notifications as plain favourites, see if the post
    // already carries reaction data merged from a Misskey/Iceshrimp account
    // earlier. If the post has a single non-default reaction emoji and its
    // count is at least the number of pending favourite notifications for
    // this post, every such notif must correspond to that emoji.
    for (const [uri, groupNotifs] of [...favByUri.entries()]) {
      if (groupNotifs.length === 0) continue;
      const dp = groupNotifs[0].post.reblog || groupNotifs[0].post;
      const reactions = dp.reactions;
      if (!reactions || typeof reactions !== 'object') continue;
      const customEntries = Object.entries(reactions).filter(([emoji, count]) =>
        count > 0
        && emoji !== '❤' && emoji !== '❤️'
        && emoji !== '⭐' && emoji !== '⭐️'
      );
      if (customEntries.length !== 1) continue;
      const [inferredEmoji, inferredCount] = customEntries[0];
      if (inferredCount < groupNotifs.length) continue;

      const inferredByUser = new Map();
      for (const notif of groupNotifs) {
        const actorAcct = notif.actor?.acct
          ? this._normalizeAcct(notif.actor.acct, notif.instanceUrl).toLowerCase()
          : null;
        if (actorAcct) inferredByUser.set(actorAcct, inferredEmoji);
      }
      const reactionEmojis = dp.reactionEmojis || {};
      const emojiBaseUrl = dp._reactionInstanceUrl || dp.instanceUrl || '';
      const changed = applyReactions(groupNotifs, inferredByUser, reactionEmojis, emojiBaseUrl, 'inferred');
      if (changed) rerenderGroup(groupNotifs);
      // Don't delete favByUri — Phase 3/2b may have authoritative data that
      // overrides this guess (and may demote to favourite via ground-truth).
    }

    // --- Phase 2b: Use the receiving Mastodon account's own reactions API ---
    // When the user's own Mastodon-compat server supports emoji_reactions
    // (Hollo / glitch-soc / Akkoma / Pleroma / Fedibird), it already has the
    // post and per-user reaction data — we don't need to bounce off Misskey or
    // the actor's instance. Call it directly for each receiving account.
    {
      const byAccount = new Map();
      for (const [uri, groupNotifs] of favByUri.entries()) {
        for (const n of groupNotifs) {
          if (!n.accountId) continue;
          if (!byAccount.has(n.accountId)) byAccount.set(n.accountId, new Map());
          const uriMap = byAccount.get(n.accountId);
          if (!uriMap.has(uri)) uriMap.set(uri, []);
          uriMap.get(uri).push(n);
        }
      }
      for (const [accountId, uriMap] of byAccount) {
        const acct = this.store.getById(accountId);
        const acctClient = this.store.getClient(accountId);
        if (!acct || !acctClient) continue;
        if (acct.platform !== 'mastodon') continue;
        // Don't gate on supportsReactions — try the endpoint anyway. The
        // software flag may be stale (account added before NodeInfo detection,
        // running an upstream patch, etc.). client.getReactions already
        // catches errors and returns [] on 404, so attempting is cheap.
        (async () => {
          for (const [uri, groupNotifs] of [...uriMap.entries()].slice(0, 10)) {
            try {
              const dp = groupNotifs[0].post.reblog || groupNotifs[0].post;
              const localId = dp.id;
              if (!localId) continue;
              const reactions = await acctClient.getReactions(localId).catch(() => []);
              if (!Array.isArray(reactions) || reactions.length === 0) continue;
              const reactionByUser = new Map();
              const reactionEmojis = {};
              const localHost = (() => {
                try { return new URL(acct.instanceUrl).hostname; } catch { return ''; }
              })();
              for (const r of reactions) {
                if (!r.user) continue;
                const u = r.user;
                let userAcct = (u.acct || u.username || '').toLowerCase();
                if (!userAcct) continue;
                if (!userAcct.includes('@')) userAcct = `${userAcct}@${localHost}`;
                reactionByUser.set(userAcct, r.type);
                // Custom emoji URL lookup map: shortcode → url
                if (r.type && /^:.+:$/.test(r.type)) {
                  const name = r.type.replace(/^:|:$/g, '');
                  if (u.emojis && Array.isArray(u.emojis)) {
                    const found = u.emojis.find(e => e.shortcode === name);
                    if (found) reactionEmojis[name] = found.url || found.static_url;
                  }
                }
              }
              // Persist on the post for subsequent refreshes — survives via postCache
              this._persistReactionByUser(groupNotifs[0].post, reactionByUser);
              // Not ground-truth: getReactions() here is a single unpaginated
              // page from the receiving Mastodon-compat server, which for a
              // remote post may not carry every reactor yet. Pass ground=false
              // so we don't negative-lock a notif Phase 3 could still promote.
              // Also don't delete from favByUri — let Phase 3's authoritative
              // Misskey walk overwrite via _assignReaction confidence gating.
              const changed = applyReactions(groupNotifs, reactionByUser, reactionEmojis, acct.instanceUrl, 'authoritative', { ground: false });
              if (changed) rerenderGroup(groupNotifs);
            } catch (e) {
              this._debugWarn('[StarShip] mastodon-self fav→reaction error:', e?.message || e);
            }
          }
        })();
      }
    }

    // --- Phase 2c: Best-effort unauthenticated reactions on actor's instance ---
    // Only fires when the post's URI host matches the actor's host, i.e. the
    // post was originally written on the same server the actor is on. In that
    // case we can derive the local status ID by parsing the URL — no auth-
    // gated /api/v2/search needed. For cross-instance posts (actor reacted to
    // a remote post) this phase skips; those rely on Phase 2a/2d.
    (async () => {
      for (const [uri, groupNotifs] of [...favByUri.entries()].slice(0, 5)) {
        try {
          // The URI we have is the post's canonical URI. If the actor's host
          // matches that URI's host, the actor's instance is the post's origin.
          let postHost;
          try { postHost = new URL(uri).host; } catch { continue; }
          const matchingActor = groupNotifs.find(n => {
            const acct = n.actor?.acct;
            return acct && acct.includes('@') && acct.split('@').pop() === postHost;
          });
          if (!matchingActor) continue;

          const actorInstance = `https://${postHost}`;
          const actorSoftware = await this._detectMastodonReactionsSoftware(actorInstance);
          if (!actorSoftware) continue;

          const localId = this._extractStatusIdFromUrl(uri, actorSoftware);
          if (!localId) continue;

          const reactionsPath = (actorSoftware === 'akkoma' || actorSoftware === 'pleroma')
            ? `/api/v1/pleroma/statuses/${encodeURIComponent(localId)}/reactions`
            : `/api/v1/statuses/${encodeURIComponent(localId)}/emoji_reactions`;
          let reactionsArr;
          try {
            reactionsArr = await this._unauthMastodonGet(actorInstance, reactionsPath);
          } catch { continue; }
          if (!Array.isArray(reactionsArr) || reactionsArr.length === 0) continue;

          const reactionByUser = new Map();
          const reactionEmojis = {};
          for (const r of reactionsArr) {
            const emoji = r.name;
            if (emoji && /^:.+:$/.test(emoji) && r.url) {
              reactionEmojis[emoji.replace(/^:|:$/g, '')] = r.url;
            }
            for (const u of (r.accounts || [])) {
              let userAcct = (u.acct || u.username || '').toLowerCase();
              if (!userAcct) continue;
              if (!userAcct.includes('@')) userAcct = `${userAcct}@${postHost}`;
              reactionByUser.set(userAcct, emoji);
            }
          }
          if (reactionByUser.size === 0) continue;

          this._persistReactionByUser(groupNotifs[0].post, reactionByUser);
          const changed = applyReactions(groupNotifs, reactionByUser, reactionEmojis, actorInstance, 'inferred');
          if (changed) rerenderGroup(groupNotifs);
        } catch (e) {
          this._debugWarn('[StarShip] mastodon-compat unauth fav→reaction error:', e?.message || e);
        }
      }
    })();

    if (allMisskeyAccounts.length > 0) {
      // --- Phase 3: Authenticated Misskey lookup (per-user, authoritative) ---
      // Walk ALL Misskey-family accounts the user has (not just the first):
      // different instances see different federation graphs, and a post that
      // misskey.io can't resolve may be present on sharkey.somewhere etc.
      //   • Resolve URI sequentially per account, stop at first success.
      //   • Fetch up to 100 reactions per note in one call (Misskey allows it).
      //   • If response is paginated (size === limit), pull next page via
      //     offset until we cover ≤ 300 reactions or hit the actor.
      //   • Pass ground=true so applyReactions can demote actors not in the
      //     fully-fetched reactor set to a locked-favourite.
      (async () => {
        for (const [uri, groupNotifs] of [...favByUri.entries()].slice(0, 12)) {
          try {
            let resolved = null;
            let mskClient = null;
            let mskAccount = null;
            for (const ma of allMisskeyAccounts) {
              const mc = this.store.getClient(ma.id);
              if (!mc) continue;
              try {
                const r = await this._cachedResolveUrl(mc, uri);
                if (r) { resolved = r; mskClient = mc; mskAccount = ma; break; }
              } catch (e) {
                this._debugWarn('[StarShip] fav→reaction resolveUrl failed on', ma.label, e?.message || e);
              }
            }
            if (!resolved || !mskClient) continue;
            const rdp = resolved.reblog || resolved;
            if (!rdp.id) continue;
            const mskHost = (() => {
              try { return new URL(mskAccount.instanceUrl).hostname; } catch { return ''; }
            })();

            const reactionByUser = new Map();
            let fetchedFully = false;
            try {
              const LIMIT = 100;
              let collected = 0;
              const MAX_TOTAL = 300;
              let lastBatchSize = LIMIT;
              while (lastBatchSize === LIMIT && collected < MAX_TOTAL) {
                const batch = await mskClient.getReactions(rdp.id, null, { limit: LIMIT, offset: collected });
                if (!Array.isArray(batch) || batch.length === 0) { fetchedFully = true; break; }
                for (const r of batch) {
                  if (!r.user) continue;
                  const host = r.user.host || mskHost;
                  const acct = `${r.user.username}@${host}`.toLowerCase();
                  reactionByUser.set(acct, r.type);
                }
                collected += batch.length;
                lastBatchSize = batch.length;
              }
              if (lastBatchSize < LIMIT) fetchedFully = true;
            } catch (e) {
              this._debugWarn('[StarShip] fav→reaction: getReactions failed for note', rdp.id, e?.message || e);
            }

            const reactionEmojis = rdp.reactionEmojis || rdp.emojis || {};
            // Persist the Misskey note ID + account so showReactionUsers
            // (badge click) can route through the per-emoji Misskey API
            // instead of falling back to vanilla getFavouritedBy (which would
            // show all reactors regardless of which emoji was clicked).
            {
              const dp = groupNotifs[0].post.reblog || groupNotifs[0].post;
              if (dp) {
                dp._misskeyNoteId = rdp.id;
                dp._misskeyAccountId = mskAccount.id;
                if (mskAccount.instanceUrl) {
                  if (!dp._noteIdsByInstance) dp._noteIdsByInstance = {};
                  dp._noteIdsByInstance[mskAccount.instanceUrl] = rdp.id;
                }
                if (rdp.reactionEmojis) dp.reactionEmojis = { ...(dp.reactionEmojis || {}), ...rdp.reactionEmojis };
                this._setCachedPost(`${groupNotifs[0].post.platform}:${groupNotifs[0].post.id}`, groupNotifs[0].post);
              }
            }
            this._persistReactionByUser(groupNotifs[0].post, reactionByUser);

            // Only mark ground=true when we believe the reactor set is complete.
            // Otherwise unmatched actors might just be on a later page we didn't
            // fetch, and we shouldn't demote them.
            const changed = applyReactions(groupNotifs, reactionByUser, reactionEmojis, mskAccount.instanceUrl, 'authoritative', { ground: fetchedFully });
            if (changed) rerenderGroup(groupNotifs);
            if (fetchedFully) favByUri.delete(uri);
          } catch (e) {
            this._debugWarn('[StarShip] fav→reaction error:', e);
          }
        }
      })();
    } else {
      // --- Unauthenticated approach via actor's Misskey instance (sequential to avoid rate limits) ---
      (async () => {
        for (const [uri, groupNotifs] of [...favByUri.entries()].slice(0, 10)) {
          try {
            // Find an actor whose instance is Misskey-compatible
            let actorInstanceUrl = null;
            for (const notif of groupNotifs) {
              const acct = notif.actor?.acct;
              if (!acct || !acct.includes('@')) continue;
              const host = acct.split('@').pop();
              const instanceUrl = `https://${host}`;
              const isMisskey = await this._detectMisskeyInstance(instanceUrl);
              if (isMisskey) {
                actorInstanceUrl = instanceUrl;
                break;
              }
            }
            if (!actorInstanceUrl) continue;

            // Step 1: Resolve the post URI via unauthenticated ap/show
            let noteId;
            try {
              const resolved = await this._unauthMisskeyRequest(actorInstanceUrl, 'ap/show', { uri });
              if (!resolved || resolved.type !== 'Note' || !resolved.object) continue;
              noteId = resolved.object.id;
            } catch (e) {
              this._debugWarn('[StarShip] unauth fav→reaction: ap/show failed for', uri, e.message || e);
              continue;
            }

            // Step 2: Get per-user reactions (unauthenticated)
            const reactionByUser = new Map();
            let reactionEmojis = {};
            try {
              const reactions = await this._unauthMisskeyRequest(actorInstanceUrl, 'notes/reactions', { noteId, limit: 20 });
              if (!Array.isArray(reactions) || reactions.length === 0) continue;
              const actorHost = new URL(actorInstanceUrl).hostname;
              for (const r of reactions) {
                if (!r.user) continue;
                const host = r.user.host || actorHost;
                const acct = `${r.user.username}@${host}`.toLowerCase();
                reactionByUser.set(acct, r.type);
              }
            } catch (e) {
              this._debugWarn('[StarShip] unauth fav→reaction: notes/reactions failed for', noteId, e.message || e);
              continue;
            }

            // Step 3: Get note details for emoji URLs
            try {
              const note = await this._unauthMisskeyRequest(actorInstanceUrl, 'notes/show', { noteId });
              if (note) {
                reactionEmojis = note.reactionEmojis || {};
              }
            } catch { /* proceed with per-user data only */ }

            if (reactionByUser.size === 0) continue;

            this._persistReactionByUser(groupNotifs[0].post, reactionByUser);
            const changed = applyReactions(groupNotifs, reactionByUser, reactionEmojis, actorInstanceUrl, 'inferred');
            if (changed) rerenderGroup(groupNotifs);
          } catch (e) {
            this._debugWarn('[StarShip] unauth fav→reaction error:', e);
          }
        }
      })();
    }

    // --- Phase 2d: Resolve missing custom emoji URLs for reaction notifications ---
    // Vanilla Mastodon may deliver an emoji_reaction with a `:shortcode:` in
    // the emoji field but no emoji_url. Without a URL, the badge can't render
    // an image and our renderer falls back to a heart SVG. Look the URL up
    // from the actor's instance public /api/v1/custom_emojis endpoint (cached
    // per instance, one fetch per actor host).
    {
      const shortcodeNotifs = items.filter(n =>
        n.platform === 'mastodon' && n.type === 'reaction'
        && n.reactionEmoji && /^:.+:$/.test(n.reactionEmoji)
        && !n.reactionEmojiUrl
      );
      if (shortcodeNotifs.length > 0) {
        const byActorInstance = new Map();
        for (const notif of shortcodeNotifs) {
          const acct = notif.actor?.acct;
          if (!acct || !acct.includes('@')) continue;
          const host = acct.split('@').pop();
          const instanceUrl = `https://${host}`;
          if (!byActorInstance.has(instanceUrl)) byActorInstance.set(instanceUrl, []);
          byActorInstance.get(instanceUrl).push(notif);
        }
        // Cap fan-out: on first load a notification page can carry dozens of
        // distinct actor hosts. Fetch /api/v1/custom_emojis for at most this
        // many on a single run; subsequent refreshes pick up the rest as
        // notifications cycle. _getInstanceEmojiMap caches per host so repeat
        // visits are cheap.
        const PHASE_2D_INSTANCE_CAP = 8;
        let instancesProbed = 0;
        for (const [instanceUrl, notifGroup] of byActorInstance) {
          if (instancesProbed++ >= PHASE_2D_INSTANCE_CAP) break;
          (async () => {
            const emojiMap = await this._getInstanceEmojiMap(instanceUrl);
            if (!emojiMap || emojiMap.size === 0) return;
            for (const notif of notifGroup) {
              const stripped = notif.reactionEmoji.replace(/^:|:$/g, '');
              const url = emojiMap.get(stripped);
              if (!url) continue;
              notif.reactionEmojiUrl = url;
              if (isNotification) {
                const cards = container.querySelectorAll(`.notif-card[data-notif-id="${notif.id}"]`);
                for (const card of cards) {
                  if (card.isConnected) card.replaceWith(renderNotification(notif));
                }
              }
            }
          })();
        }
      }
    }

    // Schedule retries for notifications still un-resolved after all phases
    // dispatched. Async paths may resolve them in the next few hundred ms; the
    // retry tick will skip those (checks _reactionSource === 'authoritative').
    // What remains is the rate-limited / federation-lag cases that benefit
    // from later attempts.
    if (isNotification) {
      for (const notif of items) {
        if (notif._reactionResolvedNegative) continue;
        if (notif._reactionSource === 'authoritative') continue;
        if (notif.type !== 'favourite' && !(notif.type === 'reaction' && notif._reactionSource !== 'authoritative')) continue;
        const dp = notif.post?.reblog || notif.post;
        if (!dp) continue;
        if (!dp.stats?.favourites || dp.stats.favourites <= 0) continue;
        this._scheduleRetry(notif, container);
      }
    }
  },

  // Fetch and cache the public custom emoji map (shortcode → URL) for an
  // instance. Returns an empty Map on failure so callers can still iterate
  // safely. One fetch per host per session.
  async _getInstanceEmojiMap(instanceUrl) {
    if (!this._instanceEmojiCache) this._instanceEmojiCache = new Map();
    if (this._instanceEmojiCache.has(instanceUrl)) return this._instanceEmojiCache.get(instanceUrl);
    const result = new Map();
    try {
      const targetUrl = `${instanceUrl}/api/v1/custom_emojis`;
      const useProxy = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
      const fetchUrl = useProxy ? `/proxy?url=${encodeURIComponent(targetUrl)}` : targetUrl;
      const res = await fetch(fetchUrl, { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list)) {
          for (const e of list) {
            if (e.shortcode) result.set(e.shortcode, e.url || e.static_url || '');
          }
        }
      }
    } catch { /* result stays empty */ }
    this._instanceEmojiCache.set(instanceUrl, result);
    if (this._instanceEmojiCache.size > 50) {
      const toDelete = this._instanceEmojiCache.size - 50;
      const keys = this._instanceEmojiCache.keys();
      for (let i = 0; i < toDelete; i++) this._instanceEmojiCache.delete(keys.next().value);
    }
    return result;
  },

  // Detect whether a remote instance is Misskey-compatible (cached, unauthenticated)
  // Extract the local status ID from a Mastodon-compat post URL.
  // URL patterns vary by software:
  //   Mastodon / glitch-soc / Hometown:  /@user/{id}  or  /users/X/statuses/{id}
  //   Hollo / Fedibird:                  /@user/{uuid}
  //   Pleroma / Akkoma:                  /notice/{id}  or  /objects/{id}
  // Returns the ID or null if the URL doesn't match a known pattern.
  _extractStatusIdFromUrl(url, software) {
    let path;
    try { path = new URL(url).pathname; } catch { return null; }
    if (software === 'akkoma' || software === 'pleroma') {
      const m = path.match(/^\/(?:notice|objects)\/([\w-]+)\/?$/);
      if (m) return m[1];
    }
    // Mastodon-style account-prefixed URL
    let m = path.match(/^\/@[^/]+\/([\w-]+)\/?$/);
    if (m) return m[1];
    // Mastodon canonical URL
    m = path.match(/^\/users\/[^/]+\/statuses\/([\w-]+)\/?$/);
    if (m) return m[1];
    return null;
  },

  // Detect a fediverse instance's software via NodeInfo. Returns the
  // lowercased software name or null. Result is cached.
  async _detectInstanceSoftware(instanceUrl) {
    if (!this._instanceSoftwareCache) this._instanceSoftwareCache = new Map();
    if (this._instanceSoftwareCache.has(instanceUrl)) return this._instanceSoftwareCache.get(instanceUrl);
    let result = null;
    try {
      const useProxy = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
      const buildUrl = (target) => useProxy ? `/proxy?url=${encodeURIComponent(target)}` : target;
      const discRes = await fetch(buildUrl(`${instanceUrl}/.well-known/nodeinfo`), {
        headers: { 'Accept': 'application/json' },
      });
      if (discRes.ok) {
        const disc = await discRes.json();
        const link = (disc.links || []).find(l => (l.rel || '').includes('nodeinfo'));
        if (link?.href) {
          let niUrl;
          try { niUrl = new URL(link.href); } catch { niUrl = null; }
          if (niUrl && niUrl.host === new URL(instanceUrl).host) {
            const niRes = await fetch(buildUrl(link.href), { headers: { 'Accept': 'application/json' } });
            if (niRes.ok) {
              const ni = await niRes.json();
              const sw = (ni.software?.name || '').toLowerCase();
              if (sw) result = sw;
            }
          }
        }
      }
    } catch { /* result stays null */ }
    this._instanceSoftwareCache.set(instanceUrl, result);
    if (this._instanceSoftwareCache.size > 100) {
      const toDelete = this._instanceSoftwareCache.size - 100;
      const keys = this._instanceSoftwareCache.keys();
      for (let i = 0; i < toDelete; i++) this._instanceSoftwareCache.delete(keys.next().value);
    }
    return result;
  },

  // Backwards-compat wrapper used by Phase 2c — only returns software when it
  // belongs to the Mastodon-compat-with-reactions set.
  async _detectMastodonReactionsSoftware(instanceUrl) {
    const SUPPORTED = new Set(['hollo', 'fedibird', 'glitchcafe', 'akkoma', 'pleroma']);
    const sw = await this._detectInstanceSoftware(instanceUrl);
    return sw && SUPPORTED.has(sw) ? sw : null;
  },

  // Unauthenticated GET to a Mastodon-compatible instance API (via proxy).
  // Throws on non-2xx so callers can fall through to the next path.
  async _unauthMastodonGet(instanceUrl, path) {
    const targetUrl = `${instanceUrl}${path}`;
    const useProxy = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
    const fetchUrl = useProxy ? `/proxy?url=${encodeURIComponent(targetUrl)}` : targetUrl;
    const res = await fetch(fetchUrl, { method: 'GET', headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      const err = new Error(`Mastodon unauthenticated API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  },

  async _detectMisskeyInstance(instanceUrl) {
    if (!this._misskeyInstanceCache) this._misskeyInstanceCache = new Map();
    if (this._misskeyInstanceCache.has(instanceUrl)) return this._misskeyInstanceCache.get(instanceUrl);

    try {
      const result = await this._unauthMisskeyRequest(instanceUrl, 'meta', {});
      const isMisskey = !!(result && (result.version || result.softwareName));
      this._misskeyInstanceCache.set(instanceUrl, isMisskey);
    } catch {
      this._misskeyInstanceCache.set(instanceUrl, false);
    }
    // Evict oldest entries when cache exceeds limit
    if (this._misskeyInstanceCache.size > 100) {
      const toDelete = this._misskeyInstanceCache.size - 100;
      const keys = this._misskeyInstanceCache.keys();
      for (let i = 0; i < toDelete; i++) this._misskeyInstanceCache.delete(keys.next().value);
    }
    return this._misskeyInstanceCache.get(instanceUrl);
  },

  // Make an unauthenticated POST request to a Misskey instance API (via proxy)
  async _unauthMisskeyRequest(instanceUrl, endpoint, body) {
    const targetUrl = `${instanceUrl}/api/${endpoint}`;
    const useProxy = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
    const fetchUrl = useProxy
      ? `/proxy?url=${encodeURIComponent(targetUrl)}`
      : targetUrl;

    const res = await fetch(fetchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Misskey unauthenticated API error ${res.status}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  },
};
