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
import { config } from '../config.js';
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
 * Runs in a single transaction so a failure part-way cannot leave a batch with
 * half its codes. Returns a summary plus a small preview of the codes.
 */
export async function issueCodes(batchId, { actor, req } = {}) {
  const batch = await db.get(
    `SELECT b.*, p.sku FROM batches b JOIN products p ON p.id = b.product_id WHERE b.id = ?`,
    [batchId]
  );
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

  const inserted = await db.tx(async () => {
    /*
     * Inserted in chunks rather than one statement at a time. Every statement
     * is a network round trip to the database now, and a batch can run to
     * hundreds of thousands of units - issuing them singly would take minutes
     * of pure latency. CHUNK is a compromise between round trips and the size
     * of a single request.
     */
    /*
     * One statement per chunk, not one per code. Every statement is a network
     * round trip to the database now, and a 1,200-unit batch issued one row at
     * a time measured at 159 SECONDS against a hosted Postgres - well past the
     * 30s a serverless function is given, so a real batch could never be
     * issued at all.
     *
     * The chunk size is bounded by the parameter limit of the engine, not by
     * the wire: Postgres allows 65535 per statement, SQLite far fewer, so the
     * smaller number is used where it applies. Five columns per row.
     */
    const CHUNK = config.db.postgresUrl ? 500 : 150;

    let n = 0;
    let pending = [];
    const flush = async () => {
      if (!pending.length) return;
      const tuples = pending.map(() => "(?, ?, ?, ?, ?, 'issued')").join(', ');
      await db.run(
        `INSERT INTO codes (code, batch_id, product_id, unit_index, serial, status)
         VALUES ${tuples}`,
        pending.flat()
      );
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
      pending.push([code, batch.id, batch.product_id, unitIndex, serial]);
      if (pending.length >= CHUNK) await flush();
      n += 1;
    }
    await flush();

    await db.run(
      `UPDATE batches
          SET status = 'codes_issued', serial_width = ?,
              codes_issued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [width, batch.id]
    );
    return n;
  });

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
    preview: await db.all(
      'SELECT code, serial, unit_index FROM codes WHERE batch_id = ? ORDER BY unit_index LIMIT 5',
      [batch.id]
    ),
  };
}

/**
 * Move a batch to a new lifecycle status, applying the side effects that
 * status implies (e.g. releasing a batch releases its codes for scanning).
 */
export async function transition(batchId, to, { actor, req, reason = null } = {}) {
  const batch = await db.get('SELECT * FROM batches WHERE id = ?', [batchId]);
  if (!batch) throw notFound('Batch not found');
  assertTransition(batch.status, to);

  if (to === 'recalled' && !reason) {
    throw badRequest('A recall requires a reason - it is shown to every patient who scans the batch.');
  }

  await db.tx(async () => {
    const stamps = {
      printed: 'printed_at',
      released: 'released_at',
      recalled: 'recalled_at',
    };
    const stampCol = stamps[to];

    await db.run(
      `UPDATE batches
          SET status = ?,
              ${stampCol ? `${stampCol} = strftime('%Y-%m-%dT%H:%M:%fZ','now'),` : ''}
              recall_reason = COALESCE(?, recall_reason),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [to, to === 'recalled' ? reason : null, batchId]
    );

    // Propagate the states that individual codes care about.
    if (to === 'printed') {
      await db.run(`UPDATE codes SET status = 'printed' WHERE batch_id = ? AND status = 'issued'`, [batchId]);
    } else if (to === 'released') {
      await db.run(`UPDATE codes SET status = 'released' WHERE batch_id = ? AND status IN ('issued','printed')`, [batchId]);
    } else if (to === 'recalled') {
      // Every not-yet-flagged code in the batch becomes recalled, so any
      // future scan warns the patient immediately.
      await db.run(`UPDATE codes SET status = 'recalled' WHERE batch_id = ? AND status <> 'flagged'`, [batchId]);
    }
  });

  await audit.record({
    actor,
    req,
    action: `batch.${to}`,
    entityType: 'batch',
    entityId: batchId,
    detail: { from: batch.status, to, batchNumber: batch.batch_number, reason },
  });

  logger.info('batch transition', { batch: batch.batch_number, from: batch.status, to });
  return await db.get('SELECT * FROM batches WHERE id = ?', [batchId]);
}

/** Per-batch code statistics for the dashboard. */
export async function batchStats(batchId) {
  const rows = await db.all('SELECT status, COUNT(*) AS n FROM codes WHERE batch_id = ? GROUP BY status', [batchId]);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const scans = await db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN result = 'genuine' THEN 1 ELSE 0 END) AS genuine,
            SUM(CASE WHEN result = 'flagged' THEN 1 ELSE 0 END) AS flagged
       FROM scans WHERE batch_id = ?`,
    [batchId]
  );
  return {
    codes: byStatus,
    totalCodes: rows.reduce((a, r) => a + r.n, 0),
    scans: { total: scans?.total ?? 0, genuine: scans?.genuine ?? 0, flagged: scans?.flagged ?? 0 },
  };
}

/** Paged code listing for a batch. */
export async function listCodes(batchId, { page, pageSize, status, search } = {}) {
  const { limit, offset, ...meta } = db.paginate({ page, pageSize });
  const where = ['c.batch_id = ?'];
  const params = [batchId];

  if (status) {
    where.push('c.status = ?');
    params.push(status);
  }
  if (search) {
    where.push('c.code LIKE ?');
    params.push(`%${String(search).toUpperCase()}%`);
  }

  const clause = `WHERE ${where.join(' AND ')}`;
  const total = await db.scalar(`SELECT COUNT(*) FROM codes c ${clause}`, params);
  const items = await db.all(
    `SELECT c.id, c.code, c.serial, c.unit_index, c.status, c.scan_count,
            c.first_scan_at, c.last_scan_at
       FROM codes c ${clause}
      ORDER BY c.unit_index LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
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
  const batch = await db.get(
    `SELECT b.*, p.sku, p.name FROM batches b JOIN products p ON p.id = b.product_id WHERE b.id = ?`,
    [batchId]
  );
  if (!batch) throw notFound('Batch not found');

  const rows = await db.all('SELECT code, serial, unit_index FROM codes WHERE batch_id = ? ORDER BY unit_index', [batchId]);
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
  return { filename: `codes-${batch.batch_number}.csv`, csv: [header, ...lines].join('\n') };
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
