/**
 * Stored files: what each kind may contain, and the helpers that store them.
 *
 * Six kinds, each with its own rules. A file's type is decided by its first
 * bytes (its "magic number"), never by the name or the Content-Type a browser
 * claims - both are whatever the sender says they are.
 *
 *   kind           accepted                 limit    who
 *   leaflet        PDF                      3 MB/piece  uploaded (services/leaflets.js)
 *   import         XLSX or CSV              8 MB     uploaded; the original of every import
 *   export         XLSX                     -        written by us; a copy of every export
 *   qr             SVG or PNG               -        written by us; a cache of rendered QRs
 *   avatar         JPEG, PNG or WebP        200 KB   uploaded
 *   product_image  JPEG, PNG or WebP        2 MB     uploaded
 *
 * SVG is accepted only from our own QR renderer and is never accepted from an
 * upload: an SVG is a document that can carry script, served from our origin.
 *
 * With Postgres the bytes live in the `files` table (src/db/postgres.js).
 */
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import * as db from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import logger from '../lib/logger.js';

export const MIME = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export const IMAGE_FORMATS = ['jpeg', 'png', 'webp'];

export const LIMITS = {
  import: 8 * 1024 * 1024,
  avatar: 200 * 1024,
  product_image: 2 * 1024 * 1024,
};

/**
 * What the bytes are, from their first few bytes: pdf | xlsx | png | jpeg |
 * webp | svg | csv, or null when none of these.
 *
 * `xlsx` means "a ZIP" - an .xlsx is one, and the spreadsheet reader rejects a
 * ZIP that is not a workbook. `csv` means "text with no NUL bytes", the most
 * that can be said of a CSV without parsing it.
 */
export function sniff(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  const head = bytes.subarray(0, 16);
  const ascii = head.toString('latin1');
  if (ascii.startsWith('%PDF-')) return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'xlsx';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp';
  const text = bytes.subarray(0, 4096);
  if (text.includes(0)) return null;
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text.toString('utf8'))) return 'svg';
  return 'csv';
}

/** A filename safe to store and to put in a Content-Disposition header. */
export function safeName(name, fallback = 'file') {
  const clean = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w.\- ()]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return clean || fallback;
}

/** A fresh, unguessable id for a file that must not be shared or reused. */
const freshId = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(9).toString('base64url')}`;

/**
 * Check an uploaded image: JPEG, PNG or WebP by its bytes, within `limit`.
 * Returns the format.
 */
export function checkImage(bytes, { limit, label = 'picture' }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw badRequest(`No ${label} was received.`);
  const format = sniff(bytes);
  if (!IMAGE_FORMATS.includes(format)) throw badRequest('Upload a JPEG, PNG or WebP image.');
  if (bytes.length > limit) {
    throw badRequest(`That ${label} is too large. Choose one under ${Math.round(limit / 1024)}KB.`);
  }
  return format;
}

// ---------------------------------------------------------------------------
// Imports and exports: a copy of every spreadsheet that came in or went out
// ---------------------------------------------------------------------------

/**
 * Keep the original of an import. Best effort: the import itself has already
 * happened, so a failure here is logged rather than undoing it.
 */
export async function archiveImport(bytes, { entity, filename, actor, result }) {
  if (!db.filesIndexed()) return null;
  const format = sniff(bytes);
  if (format !== 'xlsx' && format !== 'csv') return null;
  try {
    const name = safeName(filename, `${entity}-import.${format}`);
    const stored = await db.uploadFile(bytes, {
      id: freshId('import'),
      kind: 'import',
      filename: name,
      contentType: MIME[format],
      createdBy: actor?.id ?? null,
      meta: {
        entity,
        created: result?.created ?? null,
        updated: result?.updated ?? null,
        errors: Array.isArray(result?.errors) ? result.errors.length : null,
      },
    });
    return stored.assetId;
  } catch (err) {
    logger.error('could not keep a copy of an import', { error: err.message, entity });
    return null;
  }
}

/** Keep a copy of an export. Best effort, as for imports. */
export async function archiveExport(buffer, { entity, filename, actor, rows }) {
  if (!db.filesIndexed()) return null;
  try {
    const stored = await db.uploadFile(buffer, {
      id: freshId('export'),
      kind: 'export',
      filename: safeName(filename, `${entity}.xlsx`),
      contentType: MIME.xlsx,
      createdBy: actor?.id ?? null,
      meta: { entity, rows },
    });
    return stored.assetId;
  } catch (err) {
    logger.error('could not keep a copy of an export', { error: err.message, entity });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Avatars and product images
// ---------------------------------------------------------------------------

/** Prefix marking a stored-file reference in a field that may also hold a legacy data URL. */
export const FILE_REF = 'file:';

/** Store an avatar image. Returns the reference to keep on the user. */
export async function storeAvatar(userId, bytes) {
  const format = checkImage(bytes, { limit: LIMITS.avatar });
  const stored = await db.uploadFile(bytes, {
    id: freshId(`avatar-${userId}`),
    kind: 'avatar',
    filename: `avatar.${format === 'jpeg' ? 'jpg' : format}`,
    contentType: MIME[format],
    createdBy: userId,
  });
  return `${FILE_REF}${stored.assetId}`;
}

/** Store a product image. Returns its file id. */
export async function storeProductImage(productId, bytes, { actor } = {}) {
  const format = checkImage(bytes, { limit: LIMITS.product_image, label: 'image' });
  const stored = await db.uploadFile(bytes, {
    id: freshId(`product-${productId}`),
    kind: 'product_image',
    filename: `product-${productId}.${format === 'jpeg' ? 'jpg' : format}`,
    contentType: MIME[format],
    createdBy: actor?.id ?? null,
    meta: { productId },
  });
  return stored.assetId;
}

/** Where a product's picture is served from, or null. The URL changes whenever the picture does. */
export const productImageUrl = (p) =>
  p?.image_file_id
    ? `/api/product/${encodeURIComponent(p.sku)}/image?v=${encodeURIComponent(p.image_file_id)}`
    : null;

/** Where an avatar is served from: a stored one by URL, a legacy data URL as it is. */
export const avatarUrl = (value) => {
  const id = refId(value);
  if (id) return `/api/auth/avatar/${encodeURIComponent(id)}`;
  return value ?? null;
};

/** The file id inside a `file:` reference, or null for anything else. */
export const refId = (value) =>
  typeof value === 'string' && value.startsWith(FILE_REF) ? value.slice(FILE_REF.length) : null;

/** Delete a stored file, logging rather than throwing: an orphan is harmless. */
export async function discard(fileId) {
  if (!fileId) return;
  try {
    await db.deleteFile(fileId);
  } catch (err) {
    logger.warn('could not delete a replaced file', { error: err.message, fileId });
  }
}

// ---------------------------------------------------------------------------
// QR images: rendered once, then served from the store
// ---------------------------------------------------------------------------

/**
 * A QR for `text`, as an SVG string (`format: 'svg'`) or PNG bytes
 * (`format: 'png'`), rendered once and kept.
 *
 * The id is a digest of everything that shapes the image - the encoded text
 * (which carries the public base URL and the code's signature), the format and
 * the rendering options - so a change to any of them is simply a new entry,
 * and a stored QR can never be served for a payload it does not encode.
 */
export async function cachedQr(text, { format, options, purpose }) {
  const render = () =>
    format === 'svg'
      ? QRCode.toString(text, { ...options, type: 'svg' })
      : QRCode.toBuffer(text, { ...options, type: 'png' });

  if (!db.filesIndexed()) return render();

  const id = `qr-${crypto
    .createHash('sha256')
    .update(JSON.stringify([format, options, text]))
    .digest('hex')
    .slice(0, 40)}.${format}`;

  try {
    const cached = await db.readFile(id);
    if (cached) return format === 'svg' ? cached.toString('utf8') : cached;
  } catch (err) {
    logger.warn('QR cache read failed; rendering instead', { error: err.message });
  }

  const image = await render();
  try {
    await db.uploadFile(format === 'svg' ? Buffer.from(image, 'utf8') : image, {
      id,
      kind: 'qr',
      filename: id,
      contentType: MIME[format],
      meta: { purpose },
    });
  } catch (err) {
    logger.warn('could not keep a rendered QR', { error: err.message });
  }
  return image;
}

/** A cached PNG QR as a data URL, for the print sheets. */
export async function cachedQrDataUrl(text, { options, purpose }) {
  const png = await cachedQr(text, { format: 'png', options, purpose });
  return `data:image/png;base64,${png.toString('base64')}`;
}

export default {
  MIME, IMAGE_FORMATS, LIMITS, FILE_REF, sniff, safeName, checkImage,
  archiveImport, archiveExport, storeAvatar, storeProductImage, refId, discard, productImageUrl, avatarUrl,
  cachedQr, cachedQrDataUrl,
};
