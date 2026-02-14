/**
 * Shared Emoji Picker Utility
 * Common logic for compose emoji picker and reaction picker.
 */
import { escapeHtml, cachedImageUrl } from './utils.js';

export const COMMON_EMOJIS = [
  '👍', '❤️', '😆', '🎉', '😮', '🤔', '😢', '👀',
  '🔥', '⭐', '💯', '✨', '😂', '🙏', '💕', '😊',
];

/**
 * Build the instance custom emoji section (categories, no search — search is at picker level).
 * @param {Array} emojis - Array of { name, url, category? }
 * @param {string} itemClass - CSS class(es) for emoji buttons
 * @param {string} dataAttr - Data attribute name ('emoji' or 'reaction')
 * @returns {HTMLElement}
 */
export function buildInstanceEmojiSection(emojis, itemClass, dataAttr) {
  const categories = new Map();
  for (const emoji of emojis) {
    const cat = emoji.category || '기타';
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push(emoji);
  }

  const section = document.createElement('div');
  section.className = 'reaction-picker-instance-section';
  section.innerHTML = `
    <div class="reaction-picker-emojis">
      ${Array.from(categories.entries()).map(([cat, catEmojis]) => `
        <div class="reaction-picker-category" data-category="${escapeHtml(cat)}">
          <div class="reaction-picker-category-name">${escapeHtml(cat)}</div>
          <div class="reaction-picker-grid">
            ${catEmojis.map(e => `<button class="${itemClass}" data-${dataAttr}=":${e.name}:" title=":${e.name}:"><img src="${escapeHtml(cachedImageUrl(e.url))}" alt=":${e.name}:" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;

  return section;
}

/**
 * Set up the top-level search input to filter all emojis in the picker.
 * Filters custom emojis by name (substring match, colons stripped).
 * Hides the common unicode section when there's a search query.
 * @param {HTMLElement} picker - Picker container element
 * @param {string} dataAttr - Data attribute name ('emoji' or 'reaction')
 */
export function setupPickerSearch(picker, dataAttr) {
  const searchInput = picker.querySelector('.reaction-picker-search-input');
  if (!searchInput) return;

  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim().toLowerCase().replace(/:/g, '');

    // Hide common unicode section and label when searching
    const unicodeSection = picker.querySelector('.reaction-picker-unicode');
    const sectionLabel = picker.querySelector('.reaction-picker-section-label');
    if (unicodeSection) unicodeSection.style.display = query ? 'none' : '';
    if (sectionLabel) sectionLabel.style.display = query ? 'none' : '';

    // Filter custom emoji items (skip unicode items)
    const allItems = picker.querySelectorAll(`[data-${dataAttr}]`);
    for (const item of allItems) {
      if (item.closest('.reaction-picker-unicode')) continue;
      const name = (item.dataset[dataAttr] || '').toLowerCase().replace(/:/g, '');
      item.style.display = (!query || name.includes(query)) ? '' : 'none';
    }

    // Hide empty categories
    const categories = picker.querySelectorAll('.reaction-picker-category');
    for (const cat of categories) {
      const visible = cat.querySelectorAll(`[data-${dataAttr}]:not([style*="display: none"])`);
      cat.style.display = visible.length > 0 ? '' : 'none';
    }
  });
}

/**
 * Fetch instance emojis and replace the loading placeholder in the picker.
 * @param {Object} options
 * @param {Object} options.client - API client with getInstanceEmojis()
 * @param {HTMLElement} options.picker - Picker container element
 * @param {string} options.pickerId - ID of picker element (to check if still open)
 * @param {string} options.itemClass - CSS class(es) for emoji buttons
 * @param {string} options.dataAttr - Data attribute name ('emoji' or 'reaction')
 * @param {string} [options.emptyMessage] - Message when no emojis (null = remove loading)
 * @param {string} [options.errorMessage] - Message on error (null = remove loading)
 */
export function loadInstanceEmojis({ client, picker, pickerId, itemClass, dataAttr, emptyMessage, errorMessage }) {
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
    const section = buildInstanceEmojiSection(emojis, itemClass, dataAttr);
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
