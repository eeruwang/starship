/**
 * Shared Emoji Picker Utility
 * Common logic for compose emoji picker and reaction picker.
 */

export const COMMON_EMOJIS = [
  '👍', '❤️', '😆', '🎉', '😮', '🤔', '😢', '👀',
  '🔥', '⭐', '💯', '✨', '😂', '🙏', '💕', '😊',
];

/**
 * Build the instance custom emoji section (categories + search).
 * @param {Array} emojis - Array of { name, url, category? }
 * @param {Function} escapeHtml
 * @param {string} itemClass - CSS class(es) for emoji buttons
 * @param {string} dataAttr - Data attribute name ('emoji' or 'reaction')
 * @returns {HTMLElement}
 */
export function buildInstanceEmojiSection(emojis, escapeHtml, itemClass, dataAttr) {
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
        <div class="reaction-picker-category" data-category="${escapeHtml(cat)}">
          <div class="reaction-picker-category-name">${escapeHtml(cat)}</div>
          <div class="reaction-picker-grid">
            ${catEmojis.map(e => `<button class="${itemClass}" data-${dataAttr}=":${e.name}:" title=":${e.name}:"><img src="${escapeHtml(e.url)}" alt=":${e.name}:" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;

  const searchInput = section.querySelector('.reaction-picker-search-input');
  if (searchInput) {
    const selectorClass = itemClass.split(' ')[0];
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.trim().toLowerCase();
      const items = section.querySelectorAll(`.${selectorClass}`);
      const cats = section.querySelectorAll('.reaction-picker-category');
      for (const item of items) {
        const name = (item.dataset[dataAttr] || '').toLowerCase();
        item.style.display = (!query || name.includes(query)) ? '' : 'none';
      }
      for (const cat of cats) {
        const visible = cat.querySelectorAll(`.${selectorClass}:not([style*="display: none"])`);
        cat.style.display = visible.length > 0 ? '' : 'none';
      }
    });
  }

  return section;
}

/**
 * Fetch instance emojis and replace the loading placeholder in the picker.
 * @param {Object} options
 * @param {Object} options.client - API client with getInstanceEmojis()
 * @param {HTMLElement} options.picker - Picker container element
 * @param {string} options.pickerId - ID of picker element (to check if still open)
 * @param {Function} options.escapeHtml
 * @param {string} options.itemClass - CSS class(es) for emoji buttons
 * @param {string} options.dataAttr - Data attribute name ('emoji' or 'reaction')
 * @param {string} [options.emptyMessage] - Message when no emojis (null = remove loading)
 * @param {string} [options.errorMessage] - Message on error (null = remove loading)
 */
export function loadInstanceEmojis({ client, picker, pickerId, escapeHtml, itemClass, dataAttr, emptyMessage, errorMessage }) {
  client.getInstanceEmojis().then(emojis => {
    if (!document.getElementById(pickerId)) return;
    const loadingEl = picker.querySelector('.reaction-picker-loading');
    if (!emojis || emojis.length === 0) {
      if (loadingEl) {
        if (emptyMessage) {
          loadingEl.textContent = emptyMessage;
        } else {
          loadingEl.remove();
        }
      }
      return;
    }
    const section = buildInstanceEmojiSection(emojis, escapeHtml, itemClass, dataAttr);
    if (loadingEl) loadingEl.replaceWith(section);
  }).catch(() => {
    const loadingEl = picker.querySelector('.reaction-picker-loading');
    if (loadingEl) {
      if (errorMessage) {
        loadingEl.textContent = errorMessage;
      } else {
        loadingEl.remove();
      }
    }
  });
}
