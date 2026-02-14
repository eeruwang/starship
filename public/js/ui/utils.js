/**
 * Shared UI Utilities
 */

export function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Wrap a remote image URL through the /cache/image proxy.
 * Returns the original URL on localhost (no worker proxy).
 */
const _useImageCache = window.location.hostname !== 'localhost';
export function cachedImageUrl(url) {
  if (!url || !_useImageCache) return url || '';
  // Don't re-wrap already-proxied URLs or data/blob URLs
  if (url.startsWith('/cache/') || url.startsWith('data:') || url.startsWith('blob:')) return url;
  return `/cache/image?url=${encodeURIComponent(url)}`;
}
