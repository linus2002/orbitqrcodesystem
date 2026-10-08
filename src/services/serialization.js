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
import {
  batchCandidates, serialWidthFor, qrPayload, codeFormatOf, CODE_FORMAT, COMPACT_WIDTH,
} from '../lib/codes.js';
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

/** Candidates looked up, and codes written, per round: one transaction each. */
const ISSUE_CHUNK = 250;
/** Integer ids reserved at a time, so a large batch is not a round trip per chunk. */
const ID_BLOCK = 5000;
/** Tries at one round when another issuance takes one of its codes first. */
const MAX_ROUND_ATTEMPTS = 5;
/**
 * How many codes held by other batches may be passed over, beyond the batch's
 * own size. Past that, more than half of what was tried was taken - a serial
 * space that crowded should stop an issuance with a clear message, not keep
 * it scanning a space of up to a billion serials.
 */
const SKIP_ALLOWANCE = 1000;

/**
 * Generate and store every unit code for a batch.
 *
 * A batch can run to hundreds of thousands of units - far more than one
 * Sanity transaction can carry - so the codes are written in chunks, and the
 * batch only moves to `codes_issued` once every one of them is stored and
 * counted.
 *
 * Codes are taken from the batch's own shuffled sequence of candidates (see
 * batchCandidates). Batches of one SKU share a serial space, so a candidate
 * may already be another batch's code; it is passed over and the next is
 * taken. Every code is written with `create`
 * under an id that IS the code, in one transaction per chunk, so a code
 * taken between the look-up and the write fails the whole chunk, which is
 * then looked at again. A duplicate code cannot be stored, even by two
 * issuances at once.
 *
 * An issuance cut short (a timeout, a lost connection) leaves the batch in
 * `planned` with some codes stored. Running it again walks the same sequence
 * from the start, keeps what is already this batch's, and fills in the rest -
 * so it finishes with the codes an uninterrupted run would have stored.
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
  // Without the product there is no SKU, and the codes would read "NULL-...".
  if (!batch.sku) {
    throw conflict(`Batch ${batch.batch_number} has no product record, so its codes cannot be made.`);
  }

  const format = await formatFor(batch);
  const width = format === CODE_FORMAT.COMPACT ? COMPACT_WIDTH : serialWidthFor(batch.quantity);
  const started = Date.now();

  const { created, kept, skipped } = await storeCodes(batch, width, format);

  // Check, don't assume: exactly one stored code per planned unit.
  const stored = await db.count('code', { batch_id: batch.id });
  if (stored !== batch.quantity) {
    logger.error('code issuance does not add up', {
      batch: batch.batch_number,
      stored,
      planned: batch.quantity,
      created,
      kept,
    });
    throw conflict(
      `Issuing stopped: ${stored.toLocaleString()} codes are stored for batch ${batch.batch_number}, ` +
        `not the ${batch.quantity.toLocaleString()} planned. The batch has been left as planned and this ` +
        'has been logged - please contact the system administrator before trying again.'
    );
  }

  // Only now does the batch say so.
  const marked = await markIssued(batch, width);

  const ms = Date.now() - started;
  if (marked) {
    logger.info('codes issued', { batch: batch.batch_number, count: stored, created, kept, skipped, ms });
    await audit.record({
      actor,
      req,
      action: 'batch.issue_codes',
      entityType: 'batch',
      entityId: batch.id,
      detail: { batchNumber: batch.batch_number, quantity: stored, serialWidth: width, format, ms, skipped },
    });
  }

  return {
    batchId: batch.id,
    batchNumber: batch.batch_number,
    issued: stored,
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
 * The code format a batch is issued in.
 *
 * Compact for a batch with no codes yet. A batch whose issuance was cut short
 * in the legacy format finishes in it: resuming walks the same candidates and
 * keeps the codes already stored, so switching format part-way would leave the
 * batch with two kinds of code and the stored ones out of order.
 */
async function formatFor(batch) {
  const [first] = await db.findMany('code', { batch_id: batch.id }, { limit: 1, fields: ['code'] });
  return first && codeFormatOf(first.code) === CODE_FORMAT.LEGACY ? CODE_FORMAT.LEGACY : CODE_FORMAT.COMPACT;
}

/**
 * Store a batch's codes, a round at a time, and say how it went.
 *
 * Each candidate in a round is one of three things:
 *   - free: written now, with the next unit index;
 *   - already this batch's, from a run that was cut short: kept, and it must
 *     carry the unit index it would be given now - anything else means the
 *     stored codes are not what this procedure wrote, and nothing more is
 *     written;
 *   - another batch's: passed over.
 * Unit indexes therefore run 0..quantity-1 with no gap and no repeat.
 */
async function storeCodes(batch, width, format) {
  const candidates = batchCandidates({
    sku: batch.sku,
    mfgDate: batch.mfg_date,
    width,
    format,
    // Binding the permutation key to the batch means two batches of the same
    // SKU on the same day get completely different serial orderings.
    batchKey: `${batch.batch_number}:${batch.id}`,
    secret: config.secrets.code,
  });

  let next = 0; // the unit index the next free candidate gets
  let created = 0;
  let kept = 0;
  let skipped = 0;
  let ids = []; // reserved, not yet used

  while (next < batch.quantity) {
    const round = take(candidates, Math.min(ISSUE_CHUNK, batch.quantity - next));
    if (!round.length) throw crowded(batch);

    for (let attempt = 1; ; attempt++) {
      const held = await holders(round);
      const rows = [];
      let n = next;
      let roundKept = 0;
      let roundSkipped = 0;

      for (const c of round) {
        const holder = held.get(db.docIdOf('code', c));
        if (!holder) {
          rows.push({
            code: c.code,
            batch_id: batch.id,
            product_id: batch.product_id,
            unit_index: n,
            serial: c.serial,
            status: 'issued',
          });
          n += 1;
        } else if (holder._type === 'code' && holder.batch_id === batch.id) {
          if (holder.unit_index !== n) throw outOfOrder(batch, c.code, holder.unit_index, n);
          roundKept += 1;
          n += 1;
        } else {
          roundSkipped += 1;
        }
      }
      if (skipped + roundSkipped > batch.quantity + SKIP_ALLOWANCE) throw crowded(batch);

      if (rows.length) {
        if (ids.length < rows.length) {
          // Never more than the units still to fill, so a finished batch
          // leaves at most a small gap in the ids - which ids allow.
          const want = Math.max(rows.length, Math.min(ID_BLOCK, batch.quantity - next)) - ids.length;
          ids = ids.concat(await db.nextIds('code', want));
        }
        rows.forEach((row, i) => {
          row.id = ids[i];
        });
        try {
          // One transaction of plain creates: if any of these codes was taken
          // since the look-up, none of them is written.
          await db.insertMany('code', rows, { chunk: rows.length });
        } catch (err) {
          if (!isTaken(err)) throw err;
          if (attempt >= MAX_ROUND_ATTEMPTS) throw busy(batch);
          continue;
        }
        ids = ids.slice(rows.length);
      }

      next = n;
      created += rows.length;
      kept += roundKept;
      skipped += roundSkipped;
      break;
    }
  }
  return { created, kept, skipped };
}

/**
 * Move the batch to `codes_issued` if it is still planned, as a
 * compare-and-set on its revision: when two runs of one batch finish
 * together, exactly one marks it (and records it in the audit log). Returns
 * false when another run already had.
 */
async function markIssued(batch, width) {
  for (let attempt = 1; attempt <= MAX_ROUND_ATTEMPTS; attempt++) {
    const current = await db.query('*[_id == $id][0]{ _rev, status }', { id: db.docIdOf('batch', batch) });
    if (!current) {
      logger.error('batch removed during code issuance', { batch: batch.batch_number, id: batch.id });
      throw conflict(
        `Batch ${batch.batch_number} was removed while its codes were being issued. ` +
          'This has been logged - please contact the system administrator.'
      );
    }
    if (current.status !== 'planned') return false;
    try {
      await db.update(
        'batch',
        batch,
        { status: 'codes_issued', serial_width: width, codes_issued_at: db.now() },
        { ifRevision: current._rev }
      );
      return true;
    } catch (err) {
      // Changed since it was read: look again.
      if (!isTaken(err)) throw err;
    }
  }
  throw conflict(`Batch ${batch.batch_number} was being changed at the same moment - please try again.`);
}

/** The next `k` values of an iterator (fewer at its end). */
function take(iterator, k) {
  const out = [];
  while (out.length < k) {
    const { value, done } = iterator.next();
    if (done) break;
    out.push(value);
  }
  return out;
}

/** Who already holds each candidate's code, by document id. */
async function holders(round) {
  const docs = await db.query('*[_id in $ids]{ _id, _type, batch_id, unit_index }', {
    ids: round.map((c) => db.docIdOf('code', c)),
  });
  return new Map(docs.map((d) => [d._id, d]));
}

/** A create that failed because the document exists - taken since the look-up. */
const isTaken = (err) => err?.status === 409 || err?.statusCode === 409;

function busy(batch) {
  return conflict(
    `Another batch of ${batch.sku} was issuing codes at the same moment. ` +
      'The codes stored so far are kept - please try again.'
  );
}

function crowded(batch) {
  logger.error('serial space crowded', { batch: batch.batch_number, sku: batch.sku, mfgDate: batch.mfg_date });
  return conflict(
    `Batch ${batch.batch_number} cannot be issued: most of the serial numbers for ${batch.sku} are ` +
      'already used by other batches. This has been logged - please contact the system administrator.'
  );
}

function outOfOrder(batch, code, stored, expected) {
  logger.error('stored codes out of order', { batch: batch.batch_number, code, stored, expected });
  return conflict(
    `Batch ${batch.batch_number} already has codes stored that do not match how they are issued, so ` +
      'nothing more was written. The batch has been left as planned and this has been logged - please ' +
      'contact the system administrator.'
  );
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
