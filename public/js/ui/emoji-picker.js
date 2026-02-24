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
 * Unicode emoji name map for inline autocomplete.
 * Maps shortcode names to unicode characters.
 */
export const UNICODE_EMOJI_MAP = {
  thumbsup: '👍', thumbsdown: '👎', heart: '❤️', laughing: '😆', tada: '🎉',
  open_mouth: '😮', thinking: '🤔', cry: '😢', eyes: '👀', fire: '🔥',
  star: '⭐', '100': '💯', sparkles: '✨', joy: '😂', pray: '🙏',
  two_hearts: '💕', blush: '😊', smile: '😄', grin: '😁', wink: '😉',
  kissing_heart: '😘', heart_eyes: '😍', sweat_smile: '😅', rofl: '🤣',
  relaxed: '☺️', yum: '😋', sunglasses: '😎', sob: '😭', angry: '😠',
  rage: '🤬', skull: '💀', clap: '👏', wave: '👋', ok_hand: '👌',
  v: '✌️', muscle: '💪', raised_hands: '🙌', point_up: '☝️',
  point_down: '👇', point_left: '👈', point_right: '👉',
  rocket: '🚀', rainbow: '🌈', sun: '☀️', moon: '🌙', cloud: '☁️',
  umbrella: '☂️', snowflake: '❄️', cherry_blossom: '🌸', rose: '🌹',
  tulip: '🌷', sunflower: '🌻', fallen_leaf: '🍂',
  apple: '🍎', pizza: '🍕', cake: '🎂', coffee: '☕', beer: '🍺',
  wine_glass: '🍷', icecream: '🍦',
  dog: '🐶', cat: '🐱', rabbit: '🐰', bear: '🐻', penguin: '🐧',
  chicken: '🐔', fish: '🐟', butterfly: '🦋',
  check: '✅', x: '❌', warning: '⚠️', question: '❓', exclamation: '❗',
  bulb: '💡', bell: '🔔', pin: '📌', memo: '📝', book: '📖',
  gift: '🎁', trophy: '🏆', medal: '🏅', crown: '👑', gem: '💎',
  money: '💰', bomb: '💣', hammer: '🔨', wrench: '🔧', gear: '⚙️',
  lock: '🔒', key: '🔑', link: '🔗', mag: '🔍',
  music: '🎵', art: '🎨', movie: '🎬', camera: '📷', phone: '📱',
  computer: '💻', earth: '🌍', flag: '🏁', clock: '🕐',
  zzz: '💤', poop: '💩', ghost: '👻', alien: '👽', robot: '🤖',
  smiley: '😃', stuck_out_tongue: '😛', worried: '😟', confused: '😕',
  hushed: '😯', astonished: '😲', flushed: '😳', dizzy_face: '😵',
  mask: '😷', sleeping: '😴', pensive: '😔', disappointed: '😞',
  cold_sweat: '😰', scream: '😱', tired_face: '😫', nerd: '🤓',
  smirk: '😏', unamused: '😒', rolling_eyes: '🙄', grimacing: '😬',
  innocent: '😇', devil: '😈', clown: '🤡', cowboy: '🤠',
  party: '🥳', pleading: '🥺', shush: '🤫', monocle: '🧐',
  hot: '🥵', cold: '🥶', vomit: '🤮', sneezing: '🤧',
  handshake: '🤝', writing_hand: '✍️', nail_polish: '💅',
  red_heart: '❤️', orange_heart: '🧡', yellow_heart: '💛',
  green_heart: '💚', blue_heart: '💙', purple_heart: '💜',
  broken_heart: '💔', sparkling_heart: '💖', heartbeat: '💓',
  plus: '➕', minus: '➖', arrow_up: '⬆️', arrow_down: '⬇️',
  arrow_left: '⬅️', arrow_right: '➡️',
};

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
