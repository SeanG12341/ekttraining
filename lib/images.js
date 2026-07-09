'use strict';

/**
 * Image upload validation + web optimization.
 * Accepts a raw buffer (from multer memory storage), validates it, then
 * resizes and re-encodes it to WebP for fast loading, writing the result
 * into the ./uploads directory.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const sharp = require('sharp');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB hard limit on the incoming file
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// The About image is displayed in a 3:4 portrait frame ~640px wide on desktop;
// cap the stored asset at a retina-friendly size to keep it lean.
const MAX_WIDTH = 1200;
const MAX_HEIGHT = 1600;

class ImageError extends Error {}

/**
 * @param {Buffer} buffer  raw uploaded bytes
 * @param {string} mimetype declared mimetype from the upload
 * @returns {Promise<{ path: string, filename: string, bytes: number }>}
 */
async function processAboutImage(buffer, mimetype) {
  if (!buffer || !buffer.length) {
    throw new ImageError('No image data was received.');
  }
  if (buffer.length > MAX_BYTES) {
    throw new ImageError('Image is too large. Maximum size is 8 MB.');
  }
  if (!ALLOWED_MIME.has(mimetype)) {
    throw new ImageError('Unsupported file type. Please upload a JPG, PNG, WEBP, or GIF.');
  }

  // Decode with sharp — this also verifies the bytes really are an image
  // (a mismatched extension / mimetype will throw here).
  let pipeline;
  let meta;
  try {
    pipeline = sharp(buffer, { failOn: 'error' });
    meta = await pipeline.metadata();
  } catch {
    throw new ImageError('The uploaded file is not a valid image.');
  }
  if (!meta || !meta.width || !meta.height) {
    throw new ImageError('The uploaded file is not a valid image.');
  }

  const filename = `about-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webp`;
  const outPath = path.join(UPLOAD_DIR, filename);

  await pipeline
    .rotate() // respect EXIF orientation
    .resize({
      width: MAX_WIDTH,
      height: MAX_HEIGHT,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 82 })
    .toFile(outPath);

  const bytes = fs.statSync(outPath).size;
  return { path: `/uploads/${filename}`, filename, bytes };
}

/** Delete a previously stored upload (best-effort; ignores missing files). */
function deleteUpload(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return;
  const filename = path.basename(publicPath);
  const full = path.join(UPLOAD_DIR, filename);
  fs.rm(full, { force: true }, () => {});
}

module.exports = {
  processAboutImage,
  deleteUpload,
  ImageError,
  UPLOAD_DIR,
  MAX_BYTES,
  ALLOWED_MIME,
};
