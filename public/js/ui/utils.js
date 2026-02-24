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
