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

/**
 * Sanitize an HTML fragment for safe innerHTML assignment.
 *
 * Allowlist approach: keeps a small set of formatting tags (matching what
 * Mastodon/Misskey actually emit for post bodies and bios), removes anything
 * else by replacing the element with its text content. Strips ALL inline
 * event handlers (on*) and refuses javascript:/vbscript:/data:text/html
 * URLs on href/src.
 *
 * Defense in depth: Mastodon already sanitises its own output, but if a user
 * follows accounts on glitch-soc/Hollo forks or self-hosted fediverse code
 * that doesn't, this sanitizer guards the innerHTML sinks downstream.
 */
const SAFE_TAGS = new Set([
  'a', 'p', 'br', 'span', 'div',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
  'code', 'pre', 'kbd', 'samp',
  'blockquote', 'q', 'cite',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'img',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'small', 'sup', 'sub', 'mark', 'hr',
]);
const SAFE_GLOBAL_ATTRS = new Set(['class', 'lang', 'dir', 'title']);
const TAG_ATTRS = {
  a: new Set(['href', 'rel', 'target']),
  img: new Set(['src', 'alt', 'width', 'height', 'referrerpolicy', 'loading']),
};

function _isUrlAttrSafe(value) {
  if (!value) return true;
  const v = String(value).trim().toLowerCase();
  if (v.startsWith('javascript:') || v.startsWith('vbscript:')) return false;
  if (v.startsWith('data:') && !v.startsWith('data:image/')) return false;
  return true;
}

function _sanitizeNode(node) {
  // Iterate over a snapshot of children — we mutate during walk
  const children = [...node.children];
  for (const el of children) {
    const tag = el.tagName.toLowerCase();
    if (!SAFE_TAGS.has(tag)) {
      // Drop the element but keep its text content as a text node
      const text = document.createTextNode(el.textContent || '');
      el.replaceWith(text);
      continue;
    }
    const tagAttrs = TAG_ATTRS[tag];
    for (const attr of [...el.attributes]) {
      const aname = attr.name.toLowerCase();
      if (aname.startsWith('on')) { el.removeAttribute(attr.name); continue; }
      if ((aname === 'href' || aname === 'src') && !_isUrlAttrSafe(attr.value)) {
        el.removeAttribute(attr.name);
        continue;
      }
      const allowedByTag = tagAttrs && tagAttrs.has(aname);
      if (!allowedByTag && !SAFE_GLOBAL_ATTRS.has(aname)) {
        el.removeAttribute(attr.name);
      }
    }
    // Force rel for external links
    if (tag === 'a' && el.getAttribute('target') === '_blank') {
      el.setAttribute('rel', 'noopener noreferrer');
    }
    _sanitizeNode(el);
  }
}

export function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  _sanitizeNode(tpl.content);
  return tpl.innerHTML;
}

/**
 * Compress an image File using Canvas before upload.
 * - Resizes to fit within maxDimension (default 2048px)
 * - Converts to JPEG at the given quality (default 0.85)
 * - Skips GIFs (animated) and files already under 200KB
 * - Returns a new File with the same name
 */
export function compressImage(file, { maxDimension = 2048, quality = 0.85 } = {}) {
  return new Promise((resolve) => {
    // Skip non-image or animated GIF
    if (!file.type.startsWith('image/') || file.type === 'image/gif') {
      return resolve(file);
    }
    // Skip small files (under 200KB)
    if (file.size < 200 * 1024) {
      return resolve(file);
    }

    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;
      // No resize needed if already within bounds and file is small enough
      if (width <= maxDimension && height <= maxDimension && file.size < 1024 * 1024) {
        return resolve(file);
      }

      // Scale down to fit within maxDimension
      if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // Use PNG output for images with transparency, JPEG otherwise
      const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const outputQuality = outputType === 'image/png' ? undefined : quality;

      canvas.toBlob((blob) => {
        if (!blob || blob.size >= file.size) {
          // Compressed version is larger — keep original
          return resolve(file);
        }
        const ext = outputType === 'image/png' ? '.png' : '.jpg';
        const name = file.name.replace(/\.[^.]+$/, '') + ext;
        resolve(new File([blob], name, { type: outputType, lastModified: Date.now() }));
      }, outputType, outputQuality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file); // fallback to original on error
    };
    img.src = url;
  });
}
