/**
 * Serialization engine.
 *
 * Owns the batch lifecycle and the one-code-per-unit issuance step that the
 * field guide places between "batch produced" and "code sealed on the pack".
 *
 *   planned -> codes_issued -> printed -> released -> distributed
 *                                             \-> recalled
 *
 * Issuance is deliberately irreversible: once codes exist for a batch they are
 * never regenerated, because the previous set may already be on physical packs.
 * Re-running issuance on an already-issued batch is rejected, not silently
 * repeated.
 */
import QRCode from 'qrcode';
import * as db from '../db/index.js';
import { TYPES } from '../db/schema.js';
import { config, LOCAL_BASE_URL_WARNING } from '../config.js';
import { generateBatchCodes, serialWidthFor, qrPayload } from '../lib/codes.js';
import { conflict, notFound, badRequest } from '../lib/errors.js';
import * as audit from './audit.js';
import logger from '../lib/logger.js';

/** Upper bound per batch. Larger runs should be split, as they are physically. */
export const MAX_BATCH_QUANTITY = 500_000;

/** Which lifecycle transitions are legal. */
const TRANSITIONS = {
  planned: ['codes_issued'],
  codes_issued: ['printed'],
  printed: ['released', 'recalled'],
  released: ['distributed', 'recalled'],
  distributed: ['recalled', 'closed'],
  recalled: ['closed'],
  closed: [],
};

export function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw conflict(`A batch in status "${from}" cannot move to "${to}".`, {
      allowed: TRANSITIONS[from] ?? [],
    });
  }
}

/**
 * Generate and store every unit code for a batch.
 *
 * A batch can run to hundreds of thousands of units - far more than one
 * Sanity transaction can carry - so the codes are written in chunks, and the
 * batch only moves to `codes_issued` once every chunk has landed. What makes
 * that safe is that issuance is DETERMINISTIC: the same batch always yields
 * the same codes, and each is written with createIfNotExists under an id that
 * is the code itself. An issuance interrupted part-way leaves the batch in
 * `planned`; running it again rewrites nothing that exists and fills in the
 * rest. A duplicate code cannot arise even from two runs at once.
 *
 * Returns a summary plus a small preview of the codes.
 */
export async function issueCodes(batchId, { actor, req } = {}) {
  const batch = await withProduct(await db.get('batch', batchId));
  if (!batch) throw notFound('Batch not found');

  if (batch.status !== 'planned') {
    throw conflict(
      `Codes have already been issued for batch ${batch.batch_number}. ` +
        'Codes are never regenerated, because the existing set may already be printed on packs.'
    );
  }
  if (batch.quantity > MAX_BATCH_QUANTITY) {
    throw badRequest(`Batch quantity exceeds the ${MAX_BATCH_QUANTITY.toLocaleString()} unit limit.`);
  }

  const width = serialWidthFor(batch.quantity);
  const started = Date.now();

  /*
   * Generated lazily and written a slice at a time, so a 500,000-unit batch
   * never sits in memory whole. Each slice is several Sanity transactions
   * (db.insertMany chunks them); the slice only bounds memory.
   */
  const SLICE = 5000;
  let inserted = 0;
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    await db.insertMany('code', pending, {
      ifNotExists: true,
      // Two batches of one SKU made on the same day can, rarely, mint the same
      // code. The first keeps it and this issuance stops, loudly.
      accept: (existing) => existing.batch_id === batch.id,
    });
    inserted += pending.length;
    pending = [];
  };

  for (const { unitIndex, serial, code } of generateBatchCodes({
    sku: batch.sku,
    mfgDate: batch.mfg_date,
    quantity: batch.quantity,
    // Binding the permutation key to the batch means two batches of the same
    // SKU on the same day still get completely different serial orderings.
    batchKey: `${batch.batch_number}:${batch.id}`,
    secret: config.secrets.code,
  })) {
    pending.push({ code, batch_id: batch.id, product_id: batch.product_id, unit_index: unitIndex, serial, status: 'issued' });
    if (pending.length >= SLICE) await flush();
  }
  await flush();

  // Only now, with every code stored, does the batch say so.
  await db.update('batch', batch, { status: 'codes_issued', serial_width: width, codes_issued_at: db.now() });

  const ms = Date.now() - started;
  logger.info('codes issued', { batch: batch.batch_number, count: inserted, ms });

  await audit.record({
    actor,
    req,
    action: 'batch.issue_codes',
    entityType: 'batch',
    entityId: batch.id,
    detail: { batchNumber: batch.batch_number, quantity: inserted, serialWidth: width, ms },
  });

  return {
    batchId: batch.id,
    batchNumber: batch.batch_number,
    issued: inserted,
    serialWidth: width,
    durationMs: ms,
    preview: await db.findMany('code', { batch_id: batch.id }, {
      order: 'unit_index asc',
      limit: 5,
      fields: ['code', 'serial', 'unit_index'],
    }),
  };
}

/**
 * Move a batch to a new lifecycle status, applying the side effects that
 * status implies (e.g. releasing a batch releases its codes for scanning).
 */
export async function transition(batchId, to, { actor, req, reason = null } = {}) {
  const batch = await db.get('batch', batchId);
  if (!batch) throw notFound('Batch not found');
  assertTransition(batch.status, to);

  if (to === 'recalled' && !reason) {
    throw badRequest('A recall requires a reason - it is shown to every patient who scans the batch.');
  }

  /*
   * The codes first, then the batch. A batch's codes can outnumber what one
   * transaction carries, so this is not atomic - and the order is what keeps
   * that safe. Verification decides from the BATCH status (and a code's own
   * void), never from the per-code label being propagated here, so a
   * half-propagated set changes no scan result. If the propagation fails, the
   * batch is still in its old status and the transition can simply be run
   * again; every step below is idempotent.
   */
  if (to === 'printed') {
    await db.updateWhere('code', { batch_id: batch.id, status: 'issued' }, { status: 'printed' });
  } else if (to === 'released') {
    await db.updateWhere('code', { batch_id: batch.id, status: { in: ['issued', 'printed'] } }, { status: 'released' });
  } else if (to === 'recalled') {
    // Every not-yet-flagged code in the batch becomes recalled, so any
    // future scan warns the patient immediately.
    await db.updateWhere('code', { batch_id: batch.id, status: { ne: 'flagged' } }, { status: 'recalled' });
  }

  const stamps = { printed: 'printed_at', released: 'released_at', recalled: 'recalled_at' };
  const changes = { status: to };
  if (stamps[to]) changes[stamps[to]] = db.now();
  if (to === 'recalled') changes.recall_reason = reason;
  await db.update('batch', batch, changes);

  await audit.record({
    actor,
    req,
    action: `batch.${to}`,
    entityType: 'batch',
    entityId: batchId,
    detail: { from: batch.status, to, batchNumber: batch.batch_number, reason },
  });

  logger.info('batch transition', { batch: batch.batch_number, from: batch.status, to });
  return await db.get('batch', batchId);
}

/** Per-batch code statistics for the dashboard. */
export async function batchStats(batchId) {
  // Every count in one request, computed by the Lake rather than by fetching
  // the codes - a batch can hold hundreds of thousands.
  const statuses = TYPES.code.fields.status.enum;
  const codeCounts = statuses
    .map((st) => `"${st}": count(*[_type == "code" && batch_id == $id && status == "${st}"])`)
    .join(', ');
  const r = await db.query(
    `{
       "codes": {${codeCounts}},
       "scans": {
         "total": count(*[_type == "scan" && batch_id == $id]),
         "genuine": count(*[_type == "scan" && batch_id == $id && result == "genuine"]),
         "flagged": count(*[_type == "scan" && batch_id == $id && result == "flagged"])
       }
     }`,
    { id: Number(batchId) }
  );
  // Statuses with no codes are left out, as GROUP BY left them out.
  const byStatus = Object.fromEntries(Object.entries(r.codes).filter(([, n]) => n > 0));
  return {
    codes: byStatus,
    totalCodes: Object.values(byStatus).reduce((a, n) => a + n, 0),
    scans: r.scans,
  };
}

/** Paged code listing for a batch. */
export async function listCodes(batchId, { page, pageSize, status, search } = {}) {
  const { limit, offset, ...meta } = db.paginate({ page, pageSize });
  const where = {
    batch_id: Number(batchId),
    status: status || undefined,
    // GROQ's match is word-based: the code's segments are its words, so a
    // serial or a segment prefix finds it, as LIKE '%...%' mostly did.
    code: search ? { match: `*${String(search).toUpperCase().replace(/[*"\\]/g, '')}*` } : undefined,
  };

  const total = await db.count('code', where);
  const items = await db.findMany('code', where, {
    order: 'unit_index asc',
    limit,
    offset,
    fields: ['code', 'serial', 'unit_index', 'status', 'scan_count', 'first_scan_at', 'last_scan_at'],
  });
  return { items, total, ...meta };
}

/**
 * Render a code's QR as an SVG string.
 *
 * Error-correction level Q (25% recoverable) is the right choice for pharma
 * packaging: the label will be small, may curve around a carton edge, and has
 * to survive scuffing in transit.
 */
export async function qrSvg(code) {
  const payload = qrPayload(code, config.secrets.code, config.publicBaseUrl);
  return QRCode.toString(payload, {
    type: 'svg',
    errorCorrectionLevel: 'Q',
    margin: 1,
    width: 240,
  });
}

/** Render a code's QR as a PNG data URL (used by the print sheet). */
export async function qrDataUrl(code) {
  const payload = qrPayload(code, config.secrets.code, config.publicBaseUrl);
  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'Q', margin: 1, width: 320 });
}

/**
 * Export a batch's codes as CSV - the hand-off file the packaging line's
 * printer consumes. This is the one artefact QR Shield writes back toward the
 * physical supply chain.
 */
export async function exportCsv(batchId) {
  const batch = await withProduct(await db.get('batch', batchId));
  if (!batch) throw notFound('Batch not found');

  // Paged by unit index, so a very large batch is never one enormous response.
  const rows = [];
  for (let from = 0; from < batch.quantity; from += 5000) {
    rows.push(
      ...(await db.findMany('code', { batch_id: batch.id, unit_index: { gte: from, lt: from + 5000 } }, {
        order: 'unit_index asc',
        fields: ['code', 'serial', 'unit_index'],
      }))
    );
  }
  const header = 'unit_index,code,serial,qr_payload,batch_number,product_sku,mfg_date,expiry_date';
  const lines = rows.map((r) =>
    [
      r.unit_index,
      r.code,
      r.serial,
      qrPayload(r.code, config.secrets.code, config.publicBaseUrl),
      batch.batch_number,
      batch.sku,
      batch.mfg_date,
      batch.expiry_date,
    ].join(',')
  );
  /*
   * This file is what a packaging line prints from, so a local base URL here
   * is the costliest place for it to go unnoticed. Logged rather than refused:
   * exporting against a local address is exactly what a demonstration does.
   */
  if (config.publicBaseUrlIsLocal) {
    logger.warn(LOCAL_BASE_URL_WARNING, {
      batch: batch.batch_number,
      artefact: 'codes.csv',
      units: rows.length,
    });
  }

  return {
    filename: `codes-${batch.batch_number}.csv`,
    csv: [header, ...lines].join('\n'),
    warning: config.publicBaseUrlIsLocal ? LOCAL_BASE_URL_WARNING : undefined,
  };
}

/** A batch row with its product's sku and name alongside, as the old join gave. */
async function withProduct(batch) {
  if (!batch) return batch;
  const product = await db.get('product', batch.product_id);
  return { ...batch, sku: product?.sku ?? null, name: product?.name ?? null };
}

export default {
  issueCodes,
  transition,
  batchStats,
  listCodes,
  qrSvg,
  qrDataUrl,
  exportCsv,
  assertTransition,
  MAX_BATCH_QUANTITY,
};
