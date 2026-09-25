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
  const row = await db.findOne(
    'leaflet',
    { product_id: Number(productId), language: lang },
    { order: ['effective_from desc', 'id desc'], fields: ['id'] }
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
  // The current leaflet per product: newest effective_from, then newest id -
  // the same ordering currentLeafletId and the public page use.
  const current = '*[_type == "leaflet" && product_id == ^.id && language == $lang] | order(effective_from desc, id desc)[0]';
  const rows = await db.findMany('product', {}, {
    order: 'name asc',
    fields: ['sku', 'name', 'strength', 'dosage_form', 'manufacturer', 'status'],
    extra: {
      leaflet_id: `${current}.id`,
      leaflet_version: `${current}.version`,
      leaflet_language: `${current}.language`,
      effective_from: `${current}.effective_from`,
      leaflet_versions: 'count(*[_type == "leaflet" && product_id == ^.id])',
    },
    params: { lang },
  });

  return rows.map((r) => ({
    ...r,
    hasLeaflet: Boolean(r.leaflet_id),
    url: leafletUrl(r.sku, { lang }),
  }));
}

/** One product's leaflet QR, as an SVG string. */
export async function leafletQrSvg(sku, { lang = 'en', width = 240 } = {}) {
  const product = await db.findOne('product', { sku: String(sku).toUpperCase() }, { fields: ['sku'] });
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
// The file arrives and leaves in pieces, never as one value: a Vercel
// function takes at most 4.5 MB per request, so a 25 MB leaflet has to be
// sent a few megabytes at a time. Each piece is stored as a file asset; a
// leafletFile document is the index of pieces, in order, and says whether
// the upload is finished. The browser uploads the pieces, the publish points
// at the finished file, and the public route streams the pieces back with
// the total length known up front.
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
  const file = await db.insert('leafletFile', { filename: safeFilename(name), size: total });
  return { fileId: file.id, chunkBytes: PDF_CHUNK_BYTES };
}

/** One piece, in order. Stored as its own asset. Returns how much has arrived so far. */
export async function addPdfChunk(fileId, seq, bytes) {
  const file = await db.get('leafletFile', fileId);
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

  const stored = await db.uploadFile(bytes, {
    filename: `${file.filename.replace(/\.pdf$/i, '')}.part${seq}.pdf`,
    contentType: 'application/pdf',
  });
  const piece = {
    asset_id: stored.assetId,
    url: stored.url,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  await db.update('leafletFile', file, {
    received,
    chunks: seq + 1,
    pieces: [...(file.pieces ?? []), piece],
  });
  return { fileId: file.id, received, size: Number(file.size), complete: received === Number(file.size) };
}

/**
 * Seal a finished upload so a publish can point at it.
 *
 * Called inside the publish transaction: if the publish fails, the file stays
 * pending and can be attached again. Checks that every announced byte
 * arrived. The digest recorded is over the pieces' own digests, in order -
 * enough to prove the stored file is the one uploaded without pulling all of
 * it back through the server to hash it.
 */
export async function finishPdf(fileId) {
  const file = await db.get('leafletFile', fileId);
  if (!file) throw badRequest('The PDF upload was not found. Attach the file again.');
  if (file.status !== 'pending') throw badRequest('That PDF is already attached to a leaflet.');
  if (Number(file.received) !== Number(file.size)) {
    throw badRequest(
      `The PDF upload is incomplete: ${mb(file.received)} of ${mb(file.size)} MB arrived. Attach the file again.`
    );
  }
  const sha256 = crypto
    .createHash('sha256')
    .update((file.pieces ?? []).map((p) => p.sha256).join(''))
    .digest('hex');
  await db.update('leafletFile', file, { status: 'ready', sha256 });
  return { ...file, status: 'ready', sha256 };
}

/** The file's index document, or undefined. Never the bytes. */
export async function pdfFile(fileId) {
  return db.get('leafletFile', fileId);
}

/** One stored piece of a file, as a Buffer. */
export async function pdfPiece(file, seq) {
  const piece = file.pieces?.[seq];
  if (!piece) throw new Error(`leaflet file ${file.id} is missing piece ${seq}`);
  const bytes = await db.readFile(piece.asset_id);
  if (!bytes) throw new Error(`leaflet file ${file.id}: asset ${piece.asset_id} is gone`);
  return bytes;
}

/** Is this asset held by any other leaflet file? Assets are content-addressed, so two files can share one. */
async function assetShared(assetId, exceptFileId) {
  const n = await db.count(
    'leafletFile',
    { id: { ne: exceptFileId }, $raw: '$aid in pieces[].asset_id' },
    { params: { aid: assetId } }
  );
  return n > 0;
}

/**
 * Drop uploads that were started but never published - a closed drawer, a
 * lost connection. Run when a new upload begins, so the store cannot fill
 * with abandoned pieces. Returns how many were dropped.
 */
export async function prunePendingPdfs({ olderThanHours = PENDING_PRUNE_HOURS } = {}) {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
  const stale = await db.findMany('leafletFile', { status: 'pending', created_at: { lt: cutoff } });
  for (const file of stale) {
    for (const piece of file.pieces ?? []) {
      if (!(await assetShared(piece.asset_id, file.id))) await db.deleteFile(piece.asset_id);
    }
    await db.removeWhere('leafletFile', { id: file.id });
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
  const product = await db.findOne('product', { sku: String(sku).toUpperCase() });
  if (!product) throw notFound('Product not found');

  const versions = await db.findMany(
    'leaflet',
    { product_id: product.id, language: lang },
    {
      order: ['effective_from desc', 'id desc'],
      fields: ['id', 'version', 'effective_from', 'file_id'],
      extra: {
        pdf_filename: '*[_type == "leafletFile" && id == ^.file_id][0].filename',
        pdf_size: '*[_type == "leafletFile" && id == ^.file_id][0].size',
      },
    }
  );
  if (!versions.length) throw notFound('No leaflet is published for this product');

  const wanted = version === undefined ? versions[0] : versions.find((v) => v.version === version);
  if (!wanted) throw notFound('That version of the leaflet does not exist');

  return { product, versions, wanted, current: wanted.id === versions[0].id };
}

export default {
  currentLeafletId, leafletUrl, listLeafletCodes, leafletQrSvg, leafletQrDataUrl, leafletSheet,
  PDF_MAX_BYTES, PDF_CHUNK_BYTES, safeFilename, beginPdf, addPdfChunk, finishPdf, pdfFile,
  pdfPiece, prunePendingPdfs, leafletPdfUrl, pdfInfo, resolveLeaflet,
};
