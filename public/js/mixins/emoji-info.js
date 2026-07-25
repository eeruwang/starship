/**
 * Emoji Info Mixin
 * 노트 안의 커스텀 이모지 (.custom-emoji / .inline-emoji / .notif-custom-emoji) 클릭 시
 * 이모지 정보 모달을 띄운다. 관리자 계정이 하나라도 있으면 "서버에 추가" 옵션을 노출.
 * - Mastodon 계열(mastodon/hollo/fedibird/glitchcafe/akkoma/pleroma): 관리자 API
 * - Misskey 계열(misskey/sharkey/iceshrimp/…): admin/emoji/add
 */
import { escapeHtml } from '../ui/utils.js';

// 앱 프록시 wrap 해제. cachedImageUrl 이 만든 `/cache/image?url=X` → X.
// 이미 절대 URL 이면 그대로. 상대경로면 window.location.origin 기준 절대화.
function _unwrapCacheUrl(src) {
  if (!src) return '';
  try {
    const u = new URL(src, window.location.origin);
    if (u.pathname === '/cache/image') {
      const inner = u.searchParams.get('url');
      if (inner) return inner;
    }
    if (u.pathname === '/proxy') {
      const inner = u.searchParams.get('url');
      if (inner) return inner;
    }
    return u.toString();
  } catch (_) {
    return src;
  }
}

// 이모지 이미지에 붙는 클래스들. picker/compose/toolbar 안의 것은 제외.
const EMOJI_SELECTOR = [
  '.post-content img.custom-emoji',
  '.post-content img.inline-emoji',
  '.quote-post-content img.custom-emoji',
  '.quote-post-content img.inline-emoji',
  '.notif-post-content img.custom-emoji',
  '.notif-post-content img.inline-emoji',
  '.notif-content img.custom-emoji',
  '.notif-content img.inline-emoji',
  '.reaction-badge img.custom-emoji',
  'img.notif-custom-emoji',
  '.thread-content img.custom-emoji',
  '.thread-content img.inline-emoji',
].join(', ');

export const EmojiInfoMixin = {

  _bindEmojiInfo() {
    document.addEventListener('click', (e) => {
      const img = e.target.closest(EMOJI_SELECTOR);
      if (!img) return;
      // picker/compose/toolbar 안이면 무시 (거긴 이모지 선택 UI)
      if (e.target.closest('.reaction-picker, .compose-editor, .emoji-picker')) return;
      e.preventDefault();
      e.stopPropagation();
      this.openEmojiInfoModal(img);
    }, true);

    // "새로 만들기" 토글
    document.getElementById('emoji-import-new-category')?.addEventListener('click', () => {
      const sel = document.getElementById('emoji-import-category');
      const inp = document.getElementById('emoji-import-category-new');
      if (!inp) return;
      inp.hidden = !inp.hidden;
      if (!inp.hidden) inp.focus();
      if (sel) sel.disabled = !inp.hidden;
    });

    // 서버 선택 변경 시 카테고리 목록 다시 로드 + Misskey 전용 필드 표시
    document.getElementById('emoji-import-account')?.addEventListener('change', () => {
      this._reloadEmojiCategories();
    });

    // "서버에 추가" 클릭
    document.getElementById('btn-emoji-import')?.addEventListener('click', () => {
      this._submitEmojiImport();
    });
  },

  openEmojiInfoModal(img) {
    // 이모지 정보 추출.
    // img.src 는 대개 /cache/image?url=ENCODED_ORIGIN 형태(앱 프록시)라, 서버에
    // 다시 가져올 때는 원본 URL 로 되돌려야 한다.
    const rawSrc = img.src || '';
    const originUrl = _unwrapCacheUrl(rawSrc);
    const alt = (img.alt || '').replace(/^:|:$/g, '');
    const title = (img.title || '').replace(/^:|:$/g, '');
    const shortcode = (alt || title || 'emoji').split('@')[0];  // remote form :name@host: → name

    // 원본 인스턴스 호스트 (원본 URL 기준)
    let sourceHost = '';
    try { sourceHost = new URL(originUrl).host; } catch (_) {}

    // 모달 채우기
    document.getElementById('emoji-info-img').src = rawSrc;
    document.getElementById('emoji-info-img').alt = shortcode;
    document.getElementById('emoji-info-shortcode').textContent = `:${shortcode}:`;
    document.getElementById('emoji-info-source').textContent = sourceHost ? `출처: ${sourceHost}` : '';

    // 어드민 계정 리스트
    const adminAccounts = this.store.getAll().filter(a => a.isAdmin);
    const importSection = document.getElementById('emoji-info-import');
    const importBtn = document.getElementById('btn-emoji-import');
    if (importSection && importBtn) {
      if (adminAccounts.length === 0) {
        importSection.hidden = true;
        importBtn.hidden = true;
      } else {
        importSection.hidden = false;
        importBtn.hidden = false;
        const sel = document.getElementById('emoji-import-account');
        sel.innerHTML = adminAccounts.map(a =>
          `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label || a.profile?.displayName || a.instanceUrl)}</option>`
        ).join('');
        const scInput = document.getElementById('emoji-import-shortcode');
        if (scInput) scInput.value = shortcode;
        // 원본 URL 을 hidden state 로 기억 (프록시 wrap 이 아닌 원본)
        importBtn.dataset.emojiUrl = originUrl;
        importBtn.dataset.emojiShortcode = shortcode;
        importBtn.dataset.emojiSourceHost = sourceHost;
        // 카테고리 목록 로드
        this._reloadEmojiCategories();
      }
    }

    this.openModal(document.getElementById('modal-emoji-info'));
  },

  async _reloadEmojiCategories() {
    const sel = document.getElementById('emoji-import-account');
    const catSel = document.getElementById('emoji-import-category');
    const catNew = document.getElementById('emoji-import-category-new');
    if (!sel || !catSel) return;
    const accountId = sel.value;
    const account = this.store.getById(accountId);
    if (!account) return;
    // Misskey 전용 필드 표시 토글
    document.querySelectorAll('[data-misskey-only]').forEach(el => {
      el.hidden = account.platform === 'mastodon';
    });
    catSel.innerHTML = '<option value="">불러오는 중...</option>';
    catSel.disabled = true;
    if (catNew) { catNew.hidden = true; catNew.value = ''; }
    const client = this.store.getClient(accountId);
    if (!client?.adminListCustomEmojis) {
      catSel.innerHTML = '<option value="">(카테고리 조회 미지원)</option>';
      catSel.disabled = false;
      return;
    }
    try {
      const emojis = await client.adminListCustomEmojis();
      const cats = new Set();
      for (const e of emojis || []) {
        if (e.category) cats.add(e.category);
      }
      const arr = [...cats].sort((a, b) => a.localeCompare(b));
      catSel.innerHTML = '<option value="">(카테고리 없음)</option>'
        + arr.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      catSel.disabled = false;
    } catch (err) {
      console.warn('emoji category load failed', err);
      catSel.innerHTML = '<option value="">(불러오기 실패)</option>';
      catSel.disabled = false;
    }
  },

  async _submitEmojiImport() {
    const btn = document.getElementById('btn-emoji-import');
    const err = document.getElementById('emoji-import-error');
    if (err) { err.style.display = 'none'; err.textContent = ''; }
    if (!btn) return;
    const accountId = document.getElementById('emoji-import-account')?.value;
    const shortcode = (document.getElementById('emoji-import-shortcode')?.value || '').trim();
    const url = btn.dataset.emojiUrl;
    let category = document.getElementById('emoji-import-category')?.value || '';
    const catNew = document.getElementById('emoji-import-category-new');
    if (catNew && !catNew.hidden && catNew.value.trim()) category = catNew.value.trim();
    const aliasesRaw = document.getElementById('emoji-import-aliases')?.value || '';
    const aliases = aliasesRaw.split(',').map(s => s.trim()).filter(Boolean);
    const license = (document.getElementById('emoji-import-license')?.value || '').trim();

    if (!accountId || !shortcode || !url) {
      if (err) { err.textContent = '필수값이 비어있습니다.'; err.style.display = ''; }
      return;
    }
    if (!/^[\w-]+$/.test(shortcode)) {
      if (err) { err.textContent = '쇼트코드는 영숫자 · _ · - 만 가능합니다.'; err.style.display = ''; }
      return;
    }
    const client = this.store.getClient(accountId);
    if (!client?.adminAddCustomEmoji) {
      if (err) { err.textContent = '이 계정은 admin 이모지 추가를 지원하지 않습니다.'; err.style.display = ''; }
      return;
    }

    btn.disabled = true;
    btn.textContent = '추가 중...';
    try {
      await client.adminAddCustomEmoji({
        shortcode, url, category, aliases, license,
      });
      this.showToast?.(`이모지 :${shortcode}: 추가됨`, 'success');
      this.closeModal(document.getElementById('modal-emoji-info'));
    } catch (e) {
      console.error('emoji import failed', e);
      if (err) {
        err.textContent = `추가 실패: ${e?.message || e}`;
        err.style.display = '';
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '서버에 추가';
    }
  },
};
