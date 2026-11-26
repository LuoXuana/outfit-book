/**
 * Client-side photo decoder, resizer, and JPEG compressor.
 * Always outputs standard JPEG blobs (never WebP via Canvas) for 100% iOS & Huawei compatibility.
 */

const MAIN_MAX_EDGE = 1440;
const MAIN_QUALITY = 0.82;
const THUMB_MAX_EDGE = 420;
const THUMB_QUALITY = 0.75;

/**
 * Decode an image Blob/File into an ImageBitmap or HTMLImageElement with dimensions.
 */
async function decodeImageSource(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close?.(),
      };
    } catch {
      // Fallback to HTMLImageElement below
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('无法读取该图片格式，请尝试换一张照片'));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function computeTargetSize(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (!longest || longest <= maxEdge) {
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function renderToJpegBlob(source, targetWidth, targetHeight, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    throw new Error('浏览器不支持图片处理画布');
  }

  // Paint white backdrop in case a PNG with transparent pixels is converted to JPEG
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(source, 0, 0, targetWidth, targetHeight);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        // Release iOS Canvas GPU backing store promptly
        canvas.width = 0;
        canvas.height = 0;
        if (!blob) {
          reject(new Error('图片压缩失败'));
          return;
        }
        resolve(blob);
      },
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Compress a user-selected File/Blob into a display JPEG + small grid thumbnail JPEG.
 * @param {Blob} file
 */
export async function processPhotoFile(file) {
  const decoded = await decodeImageSource(file);
  try {
    const mainSize = computeTargetSize(decoded.width, decoded.height, MAIN_MAX_EDGE);
    const thumbSize = computeTargetSize(decoded.width, decoded.height, THUMB_MAX_EDGE);

    const blob = await renderToJpegBlob(decoded.source, mainSize.width, mainSize.height, MAIN_QUALITY);
    const thumbBlob = await renderToJpegBlob(decoded.source, thumbSize.width, thumbSize.height, THUMB_QUALITY);

    return {
      blob,
      thumbBlob,
      width: mainSize.width,
      height: mainSize.height,
      size: blob.size,
      mimeType: 'image/jpeg',
    };
  } finally {
    decoded.cleanup();
  }
}

/**
 * Generate a thumbnail JPEG from an already-stored/imported JPEG blob.
 * @param {Blob} blob
 */
export async function generateThumbnailFromBlob(blob) {
  const decoded = await decodeImageSource(blob);
  try {
    const thumbSize = computeTargetSize(decoded.width, decoded.height, THUMB_MAX_EDGE);
    const thumbBlob = await renderToJpegBlob(decoded.source, thumbSize.width, thumbSize.height, THUMB_QUALITY);
    return {
      thumbBlob,
      width: decoded.width,
      height: decoded.height,
    };
  } finally {
    decoded.cleanup();
  }
}
