/**
 * Leaflet QR codes.
 *
 * A DIFFERENT ARTEFACT FROM THE PACK CODES, and the distinction matters:
 *
 *   pack code     one per unit, serialized and signed, proves this particular
 *                 pack is genuine. Scanning it twice is the counterfeit
 *                 signal, so every scan is recorded.
 *
 *   leaflet code  one per medicine, not serialized, not signed, carries no
 *                 claim about any pack. It opens the patient information for
 *                 that product - for a shelf talker, a poster, a carton, a
 *                 pharmacy counter card.
 *
 * Because a leaflet QR makes no authenticity claim, it needs no secret and no
 * scan record: it is a link, and the URL is the whole of it. That is also why
 * these are generated on demand rather than stored. A QR is a picture of a
 * URL; keeping the images would be a cache that can drift from the leaflet it
 * points at, while regenerating one costs a millisecond.
 */
import QRCode from 'qrcode';

import * as db from '../db/index.js';
import { config, LOCAL_BASE_URL_WARNING } from '../config.js';
import crypto from 'node:crypto';

import { notFound, badRequest } from '../lib/errors.js';
import logger from '../lib/logger.js';

/**
 * The id of a product's current leaflet, or null if none is published.
 *
 * Recorded on a batch when it is created, as the version it shipped with -
 * whether the batch is created in the dashboard or imported from a sheet, so
 * both paths agree. Same ordering as the public page, so "current" means the
 * same thing everywhere.
 */
export async function currentLeafletId(productId, { lang = 'en' } = {}) {
  const row = await db.get(
    `SELECT id FROM leaflets WHERE product_id = ? AND language = ?
      ORDER BY effective_from DESC, id DESC LIMIT 1`,
    [productId, lang]
  );
  return row?.id ?? null;
}

/** The public address a leaflet QR points at. */
export function leafletUrl(sku, { lang } = {}) {
  const base = `${config.publicBaseUrl}/leaflet/${encodeURIComponent(String(sku).toUpperCase())}`;
  return lang && lang !== 'en' ? `${base}?lang=${encodeURIComponent(lang)}` : base;
}

/**
 * Every product, with its current leaflet and the URL its QR would carry.
 *
 * Products WITHOUT a leaflet are included rather than filtered out: a QR
 * printed for a medicine whose leaflet was never published would lead a
 * patient to a dead end, so the gap has to be visible on this screen.
 */
export async function listLeafletCodes({ lang = 'en' } = {}) {
  const rows = await db.all(
    `SELECT p.id, p.sku, p.name, p.strength, p.dosage_form, p.manufacturer, p.status,
            l.id            AS leaflet_id,
            l.version       AS leaflet_version,
            l.language      AS leaflet_language,
            l.effective_from,
            (SELECT COUNT(*) FROM leaflets x WHERE x.product_id = p.id) AS leaflet_versions
       FROM products p
       LEFT JOIN leaflets l
              ON l.id = (
                 SELECT id FROM leaflets
                  WHERE product_id = p.id AND language = ?
                  ORDER BY effective_from DESC
                  LIMIT 1
               )
      ORDER BY p.name`,
    [lang]
  );

  return rows.map((r) => ({
    ...r,
    hasLeaflet: Boolean(r.leaflet_id),
    url: leafletUrl(r.sku, { lang }),
  }));
}

/** One product's leaflet QR, as an SVG string. */
export async function leafletQrSvg(sku, { lang = 'en', width = 240 } = {}) {
  const product = await db.get('SELECT sku FROM products WHERE sku = ?', [
    String(sku).toUpperCase(),
  ]);
  if (!product) throw notFound('Product not found');

  /*
   * Error-correction level Q, as on the pack labels: these get printed small
   * and on surfaces that scuff, and a leaflet QR that fails to scan at a
   * pharmacy counter is worse than no QR at all.
   */
  return QRCode.toString(leafletUrl(product.sku, { lang }), {
    type: 'svg',
    errorCorrectionLevel: 'Q',
    margin: 1,
    width,
  });
}

/** One product's leaflet QR, as a PNG data URL (for the print sheet). */
export async function leafletQrDataUrl(sku, { lang = 'en', width = 320 } = {}) {
  return QRCode.toDataURL(leafletUrl(sku, { lang }), {
    errorCorrectionLevel: 'Q',
    margin: 1,
    width,
  });
}

/**
 * A printable sheet: every product that HAS a leaflet, with its QR.
 *
 * Products without one are left out here - this is the artefact that goes to
 * a printer, and a QR leading to "no leaflet published" should never reach a
 * shelf. The list screen is where that gap is shown instead.
 */
export async function leafletSheet({ lang = 'en' } = {}) {
  const products = (await listLeafletCodes({ lang })).filter((p) => p.hasLeaflet);

  // A leaflet QR carries nothing but its URL, so a local base URL leaves it
  // with no recoverable meaning at all once it is on a shelf talker.
  if (config.publicBaseUrlIsLocal) {
    logger.warn(LOCAL_BASE_URL_WARNING, { artefact: 'leaflet sheet', lang, products: products.length });
  }

  return Promise.all(
    products.map(async (p) => ({
      sku: p.sku,
      name: p.name,
      strength: p.strength,
      dosageForm: p.dosage_form,
      version: p.leaflet_version,
      url: p.url,
      qr: await leafletQrDataUrl(p.sku, { lang }),
    }))
  );
}

// ---------------------------------------------------------------------------
// The PDF behind a leaflet
//
// A leaflet may be published as the PDF the artwork department already has,
// instead of - or as well as - structured text. When one is attached, the
// leaflet QR opens it directly. The text sections stay the accessible form,
// which is why the form keeps asking for them even when a PDF is attached.
//
// The file lives in the database - a serverless deployment has no disk - and
// in pieces, never as one value: a Vercel function takes at most 4.5 MB per
// request, and a hosted libSQL server caps what one query may return, so a
// 25 MB leaflet has to arrive and leave a few megabytes at a time. The
// browser uploads the pieces in order, the publish points at the finished
// file, and the public route streams the pieces back with the total length
// known up front.
// ---------------------------------------------------------------------------

/** The most a leaflet PDF may be. */
export const PDF_MAX_BYTES = 25 * 1024 * 1024;
/** One upload request. Under Vercel's 4.5 MB per-request ceiling with room to spare. */
export const PDF_CHUNK_BYTES = 3 * 1024 * 1024;
/** How long an upload may sit unpublished before it is dropped. */
const PENDING_PRUNE_HOURS = 24;

const mb = (n) => (n / 1048576).toFixed(1);

/** A name safe to send back in a Content-Disposition header: it came from a browser. */
export function safeFilename(name) {
  const base = String(name ?? 'leaflet.pdf')
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w .()-]+/g, '_')
    .trim()
    .slice(0, 120);
  return /\.pdf$/i.test(base) ? base : `${base || 'leaflet'}.pdf`;
}

/**
 * Start an upload: the file's name and announced size, before any bytes.
 * The size is checked here so a file that is too large is refused before a
 * single piece is sent.
 */
export async function beginPdf({ name, size }) {
  const total = Number(size);
  if (!Number.isInteger(total) || total <= 0) {
    throw badRequest('The PDF size must be a whole number of bytes.');
  }
  if (total > PDF_MAX_BYTES) {
    throw badRequest(`The PDF is ${mb(total)} MB; the limit is ${PDF_MAX_BYTES / 1048576} MB.`);
  }
  await prunePendingPdfs();
  const { lastInsertRowid } = await db.run(
    `INSERT INTO leaflet_files (filename, size, sha256, status, received, chunks)
     VALUES (?, ?, '', 'pending', 0, 0)`,
    [safeFilename(name), total]
  );
  return { fileId: lastInsertRowid, chunkBytes: PDF_CHUNK_BYTES };
}

/** One piece, in order. Returns how much has arrived so far. */
export async function addPdfChunk(fileId, seq, bytes) {
  const file = await db.get('SELECT * FROM leaflet_files WHERE id = ?', [fileId]);
  if (!file) throw notFound('No such upload');
  if (file.status !== 'pending') {
    throw badRequest('That file is already attached to a leaflet and cannot be changed.');
  }
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw badRequest('No data was received for this chunk.');
  if (bytes.length > PDF_CHUNK_BYTES) {
    throw badRequest(`A chunk may be at most ${PDF_CHUNK_BYTES / 1048576} MB.`);
  }
  if (seq !== Number(file.chunks)) {
    throw badRequest(`Expected chunk ${file.chunks}, got ${seq}: chunks must arrive in order.`);
  }
  if (seq === 0 && bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw badRequest('That file is not a PDF.');
  }
  const received = Number(file.received) + bytes.length;
  if (received > Number(file.size)) throw badRequest('More data arrived than the announced size.');

  await db.tx(async () => {
    await db.run('INSERT INTO leaflet_file_chunks (file_id, seq, data) VALUES (?,?,?)', [file.id, seq, bytes]);
    await db.run('UPDATE leaflet_files SET received = ?, chunks = ? WHERE id = ?', [received, seq + 1, file.id]);
  });
  return { fileId: file.id, received, size: Number(file.size), complete: received === Number(file.size) };
}

/**
 * Seal a finished upload so a publish can point at it.
 *
 * Called inside the publish transaction: if the publish fails, the file stays
 * pending and can be attached again. Checks that every announced byte
 * arrived, and records the digest so the stored file can be verified later.
 */
export async function finishPdf(fileId) {
  const file = await db.get('SELECT * FROM leaflet_files WHERE id = ?', [fileId]);
  if (!file) throw badRequest('The PDF upload was not found. Attach the file again.');
  if (file.status !== 'pending') throw badRequest('That PDF is already attached to a leaflet.');
  if (Number(file.received) !== Number(file.size)) {
    throw badRequest(
      `The PDF upload is incomplete: ${mb(file.received)} of ${mb(file.size)} MB arrived. Attach the file again.`
    );
  }
  const hash = crypto.createHash('sha256');
  for (let seq = 0; seq < Number(file.chunks); seq++) hash.update(await pdfChunk(file.id, seq));
  const sha256 = hash.digest('hex');
  await db.run(`UPDATE leaflet_files SET status = 'ready', sha256 = ? WHERE id = ?`, [sha256, file.id]);
  return { ...file, status: 'ready', sha256 };
}

/** The file's record - never its bytes - or undefined. */
export async function pdfFile(fileId) {
  return db.get(
    'SELECT id, filename, size, sha256, status, chunks, created_at FROM leaflet_files WHERE id = ?',
    [fileId]
  );
}

/** One stored piece, as a Buffer. Both drivers hand back bytes. */
export async function pdfChunk(fileId, seq) {
  const row = await db.get('SELECT data FROM leaflet_file_chunks WHERE file_id = ? AND seq = ?', [fileId, seq]);
  if (!row) throw new Error(`leaflet file ${fileId} is missing chunk ${seq}`);
  return Buffer.from(row.data);
}

/**
 * Drop uploads that were started but never published - a closed drawer, a
 * lost connection. Run when a new upload begins, so the table cannot fill
 * with abandoned pieces. Returns how many were dropped.
 */
export async function prunePendingPdfs({ olderThanHours = PENDING_PRUNE_HOURS } = {}) {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
  const stale = await db.all(
    `SELECT id FROM leaflet_files WHERE status = 'pending' AND created_at < ?`,
    [cutoff]
  );
  for (const { id } of stale) {
    await db.run('DELETE FROM leaflet_file_chunks WHERE file_id = ?', [id]);
    await db.run('DELETE FROM leaflet_files WHERE id = ?', [id]);
  }
  return stale.length;
}

/** The public address that serves a leaflet's PDF: the current version unless one is named. */
export function leafletPdfUrl(sku, { lang = 'en', version } = {}) {
  const q = new URLSearchParams();
  if (lang && lang !== 'en') q.set('lang', lang);
  if (version) q.set('version', version);
  const s = q.toString();
  return `/api/product/${encodeURIComponent(String(sku).toUpperCase())}/leaflet.pdf${s ? `?${s}` : ''}`;
}

/** What the public payloads say about a leaflet's PDF, or null when it has none. */
export function pdfInfo(sku, row, { lang, version } = {}) {
  if (!row?.file_id) return null;
  return {
    url: leafletPdfUrl(sku, { lang, version }),
    filename: row.pdf_filename ?? null,
    size: row.pdf_size == null ? null : Number(row.pdf_size),
  };
}

/**
 * Which leaflet a public request means.
 *
 * The product, every version for the language newest first (the newest IS
 * the current one), and the one wanted: the current by default, or the one
 * ?version= names. Shared by the page, the PDF and anything else that has to
 * agree on what "current" means.
 */
export async function resolveLeaflet(sku, { lang = 'en', version } = {}) {
  const product = await db.get('SELECT * FROM products WHERE sku = ?', [
    String(sku).toUpperCase(),
  ]);
  if (!product) throw notFound('Product not found');

  const versions = await db.all(
    `SELECT l.id, l.version, l.effective_from, l.file_id,
            f.filename AS pdf_filename, f.size AS pdf_size
       FROM leaflets l
       LEFT JOIN leaflet_files f ON f.id = l.file_id
      WHERE l.product_id = ? AND l.language = ?
      ORDER BY l.effective_from DESC, l.id DESC`,
    [product.id, lang]
  );
  if (!versions.length) throw notFound('No leaflet is published for this product');

  const wanted = version === undefined ? versions[0] : versions.find((v) => v.version === version);
  if (!wanted) throw notFound('That version of the leaflet does not exist');

  return { product, versions, wanted, current: wanted.id === versions[0].id };
}

export default {
  currentLeafletId, leafletUrl, listLeafletCodes, leafletQrSvg, leafletQrDataUrl, leafletSheet,
  PDF_MAX_BYTES, PDF_CHUNK_BYTES, safeFilename, beginPdf, addPdfChunk, finishPdf, pdfFile,
  pdfChunk, prunePendingPdfs, leafletPdfUrl, pdfInfo, resolveLeaflet,
};
