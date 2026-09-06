/**
 * Keyword Alerts Mixin
 *
 * 계정별 감시 낱말을 타임라인/스트리밍에 흘러온 글에 맞춰 보고, 걸리면
 * 알림 컬럼에 카드로 넣는다. 서버 알림이 아니므로 적중은 localStorage 에
 * 따로 쌓아 두고 (starship_keyword_hits) 알림 컬럼을 새로 그릴 때마다
 * 서버 알림과 합친다.
 */
import { renderNotification } from '../ui/dashboard.js';
import { debugLog } from '../ui/debug.js';
import {
  getAccountKeywords, matchKeywords, hitKey, shouldRecord,
  makeKeywordNotification, loadHits, saveHits, pruneHits, displayPostOf,
} from '../keyword-alerts.js';

export const KeywordAlertsMixin = {

  /** 적중 목록을 (한 번만) 읽어 메모리에 들고 있는다 */
  _keywordHits() {
    if (!this._kwHits) {
      this._kwHits = loadHits(window.localStorage);
      this._kwHitKeys = new Set(this._kwHits.map(h => h.key));
    }
    return this._kwHits;
  },

  _persistKeywordHits() {
    this._kwHits = saveHits(window.localStorage, this._kwHits || []);
    this._kwHitKeys = new Set(this._kwHits.map(h => h.key));
    return this._kwHits;
  },

  /** 감시 낱말이 하나라도 걸린 계정이 있는가 */
  hasKeywordAlerts() {
    return this.store.getAll().some(a => getAccountKeywords(a).length > 0);
  },

  /**
   * 글 목록을 훑어 새 적중을 기록하고, 알림 컬럼에 바로 꽂는다.
   * @returns {Array} 이번에 새로 생긴 알림들
   */
  scanKeywordAlerts(posts, account, { inject = true } = {}) {
    const keywords = getAccountKeywords(account);
    if (keywords.length === 0 || !posts || posts.length === 0) return [];

    const hits = this._keywordHits();
    const fresh = [];

    for (const post of posts) {
      if (!shouldRecord(post)) continue;
      const key = hitKey(account.id, post);
      if (this._kwHitKeys.has(key)) continue;
      const matched = matchKeywords(post, keywords);
      if (matched.length === 0) continue;

      const dp = displayPostOf(post);
      const notif = this._buildKeywordNotification({ post: dp, accountId: account.id, keywords: matched });
      if (!notif) continue;
      hits.push({
        key,
        at: Date.now(),
        accountId: account.id,
        platform: dp.platform || post.platform,
        keywords: matched,
        post: dp,
      });
      this._kwHitKeys.add(key);
      fresh.push(notif);
    }

    if (fresh.length === 0) return [];

    this._persistKeywordHits();
    debugLog('keyword', `[Keyword] ${account.label}: ${fresh.length}건 적중`,
      fresh.map(n => n.keywords.join(',')));

    if (inject) {
      for (const notif of fresh) this._injectKeywordNotification(notif);
    }
    return fresh;
  },

  _buildKeywordNotification({ post, accountId, keywords }) {
    const account = this.store.getById(accountId);
    if (!account) return null;
    return makeKeywordNotification({
      post,
      account,
      keywords,
      themeColor: this._accountColor(account),
    });
  },

  /**
   * 보관된 적중을 알림 모양으로 돌려준다.
   * 계정이 지워졌거나 감시 낱말이 빠진 적중은 조용히 걸러 낸다.
   */
  keywordHitNotifications() {
    const hits = pruneHits(this._keywordHits());
    const out = [];
    for (const hit of hits) {
      const account = this.store.getById(hit.accountId);
      if (!account || account.hidden) continue;
      if (getAccountKeywords(account).length === 0) continue;
      const notif = this._buildKeywordNotification({
        post: hit.post,
        accountId: hit.accountId,
        keywords: hit.keywords,
      });
      if (notif) out.push(notif);
    }
    return out;
  },

  /**
   * 서버 알림 목록에 키워드 적중을 합친다.
   * 이미 멘션/답글/인용 알림이 온 글은 카드가 겹치므로 적중 쪽을 버린다.
   */
  mergeKeywordNotifications(allNotifs) {
    const hits = this.keywordHitNotifications();
    if (hits.length === 0) return allNotifs;

    const covered = new Set();
    for (const n of allNotifs) {
      const dp = n.post;
      if (!dp) continue;
      if (dp.canonicalUri) covered.add(`uri:${dp.canonicalUri}`);
      covered.add(`id:${n.platform}:${dp.id}`);
    }

    for (const notif of hits) {
      const dp = notif.post;
      if (dp?.canonicalUri && covered.has(`uri:${dp.canonicalUri}`)) continue;
      if (covered.has(`id:${notif.platform}:${dp?.id}`)) continue;
      allNotifs.push(notif);
    }
    return allNotifs;
  },

  /** 실시간 적중을 열려 있는 알림 컬럼 맨 위에 꽂는다 */
  _injectKeywordNotification(notif) {
    if (!notif) return;
    for (const col of this.columnsContainer.querySelectorAll('.column')) {
      if (col.dataset.columnType !== 'notifications') continue;
      const content = col.querySelector('.column-content');
      if (!content) continue;
      if (content.querySelector(`.notif-card[data-notif-id="${CSS.escape(notif.id)}"]`)) continue;
      // 같은 글로 이미 멘션 등 서버 알림 카드가 있으면 겹쳐 놓지 않는다
      if (notif.post?.id && content.querySelector(
        `.notif-card[data-platform="${CSS.escape(notif.platform)}"][data-post-id="${CSS.escape(notif.post.id)}"]`)) continue;

      const placeholder = content.querySelector('.loading-text');
      if (placeholder) placeholder.remove();

      const el = renderNotification(notif);
      el.classList.add('new-post');
      const scrollTop = content.scrollTop;
      content.insertBefore(el, content.firstChild);
      if (scrollTop > 0) content.scrollTop = scrollTop + el.offsetHeight + 8;
      setTimeout(() => el.classList.remove('new-post'), 400);
      this.enrichLinkCards(content);
    }
  },

  /**
   * 낱말을 새로 저장한 직후, 이미 받아 둔 글들에 소급 적용한다.
   * 설정하자마자 아무 일도 안 일어나면 동작하는지 알 수 없기 때문이다.
   */
  rescanKeywordAlerts(accountId) {
    const account = this.store.getById(accountId);
    if (!account || getAccountKeywords(account).length === 0) return 0;
    const posts = [];
    for (const post of this.postCache.values()) {
      if (post.accountId === accountId) posts.push(post);
    }
    return this.scanKeywordAlerts(posts, account).length;
  },

  /** 계정을 지우거나 낱말을 다 비웠을 때 쌓인 적중을 치운다 */
  clearKeywordHits(accountId) {
    const hits = this._keywordHits();
    const kept = hits.filter(h => h.accountId !== accountId);
    if (kept.length === hits.length) return;
    this._kwHits = kept;
    this._persistKeywordHits();
    for (const col of this.columnsContainer.querySelectorAll('.column')) {
      if (col.dataset.columnType !== 'notifications') continue;
      col.querySelectorAll('.notif-card.notif-type-keyword').forEach(card => {
        if (card.dataset.accountId === accountId) card.remove();
      });
    }
  },

};
