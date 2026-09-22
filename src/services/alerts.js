/**
 * Alert queue - the security team's work list.
 *
 * Design rule taken straight from the field guide: a flag NEVER triggers an
 * automatic recall. Everything here only ever creates work for a human.
 *
 * Deduplication matters more than it looks. If a counterfeiter clones one pack
 * a thousand times, naively creating one alert per scan buries the analyst in
 * a thousand rows describing a single incident. Instead we fold repeat events
 * onto the existing open alert for that code and raise its severity as the
 * repeat count climbs.
 */
import * as db from '../db/index.js';
import logger from '../lib/logger.js';

/** How an alert type maps to a starting severity and a human title. */
const ALERT_SPEC = {
  duplicate_scan: {
    severity: 'high',
    title: (ctx) => `Duplicate scan on ${ctx.code} (scan #${ctx.scanNumber})`,
  },
  unknown_code: {
    severity: 'medium',
    title: (ctx) => `Unknown code presented: ${ctx.code}`,
  },
  recalled_scan: {
    severity: 'critical',
    title: (ctx) => `Recalled batch ${ctx.batchNumber} scanned by a patient`,
  },
  expired_scan: {
    severity: 'low',
    title: (ctx) => `Expired product scanned (batch ${ctx.batchNumber})`,
  },
  guess_attack: {
    severity: 'high',
    title: (ctx) => `Possible code-guessing: ${ctx.attempts} failed lookups from one source`,
  },
  consumer_report: {
    severity: 'high',
    title: (ctx) => `Patient report: ${ctx.summary}`,
  },
  batch_anomaly: {
    severity: 'medium',
    title: (ctx) => `Unusual scan pattern on batch ${ctx.batchNumber}`,
  },
};

/** Escalate severity as duplicates accumulate on the same incident. */
function escalate(current, repeatCount) {
  const ladder = ['low', 'medium', 'high', 'critical'];
  let idx = ladder.indexOf(current);
  if (repeatCount >= 3 && idx < 2) idx = 2;
  if (repeatCount >= 10) idx = 3;
  return ladder[Math.max(0, idx)];
}

/**
 * Raise (or fold into) an alert.
 *
 * @param {object} params
 * @param {string} params.type     one of ALERT_SPEC's keys
 * @param {object} params.context  data used for the title and the detail blob
 * @param {number} [params.codeId]
 * @param {number} [params.batchId]
 * @param {number} [params.scanId]
 * @param {boolean} [params.isTest] scans of sandbox batches never raise alerts
 * @returns {object|null} the alert row, or null when suppressed
 */
export async function raise({ type, context = {}, codeId = null, batchId = null, scanId = null, isTest = false }) {
  const spec = ALERT_SPEC[type];
  if (!spec) throw new Error(`alerts.raise: unknown type "${type}"`);

  // Sandbox / pilot batches must never appear in the live security queue.
  if (isTest) {
    logger.debug('alert suppressed for test batch', { type });
    return null;
  }

  // Fold into an existing open alert for the same code + type, if there is one.
  const existing = codeId
    ? await db.get(
        `SELECT * FROM alerts
          WHERE type = ? AND code_id = ? AND status IN ('open', 'investigating')
          ORDER BY id DESC LIMIT 1`,
        [type, codeId]
      )
    : null;

  if (existing) {
    const detail = existing.detail_json ? JSON.parse(existing.detail_json) : {};
    const occurrences = (detail.occurrences ?? 1) + 1;
    const merged = {
      ...detail,
      ...context,
      occurrences,
      lastSeenAt: new Date().toISOString(),
    };
    const severity = escalate(existing.severity, occurrences);

    await db.run(
      `UPDATE alerts
          SET detail_json = ?, severity = ?, scan_id = COALESCE(?, scan_id),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?`,
      [JSON.stringify(merged), severity, scanId, existing.id]
    );
    logger.info('alert folded', { id: existing.id, type, occurrences, severity });
    return await db.get('SELECT * FROM alerts WHERE id = ?', [existing.id]);
  }

  const detail = { ...context, occurrences: 1, firstSeenAt: new Date().toISOString() };
  const { lastInsertRowid } = await db.run(
    `INSERT INTO alerts (type, severity, status, title, detail_json, code_id, batch_id, scan_id)
     VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`,
    [type, spec.severity, spec.title(context), JSON.stringify(detail), codeId, batchId, scanId]
  );

  logger.warn('alert raised', { id: lastInsertRowid, type, severity: spec.severity });
  notify(type, spec.severity, spec.title(context));
  return await db.get('SELECT * FROM alerts WHERE id = ?', [lastInsertRowid]);
}

/**
 * Alert dispatcher.
 *
 * INTEGRATION POINT: wire this to email / Slack / PagerDuty for the security
 * team. It is intentionally a single choke point so that adding a channel
 * never means touching the verification path.
 */
function notify(type, severity, title) {
  if (severity === 'critical' || severity === 'high') {
    logger.warn(`[NOTIFY security-team] ${severity.toUpperCase()} ${type}: ${title}`);
  }
}

/** Paged, filtered alert queue for the dashboard. */
export async function list({ page, pageSize, status, severity, type, batchId } = {}) {
  const { limit, offset, ...meta } = db.paginate({ page, pageSize });
  const where = [];
  const params = [];

  if (status) {
    where.push('a.status = ?');
    params.push(status);
  }
  if (severity) {
    where.push('a.severity = ?');
    params.push(severity);
  }
  if (type) {
    where.push('a.type = ?');
    params.push(type);
  }
  if (batchId) {
    where.push('a.batch_id = ?');
    params.push(batchId);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await db.scalar(`SELECT COUNT(*) FROM alerts a ${clause}`, params);

  const rows = await db.all(
    `SELECT a.*, c.code AS code, b.batch_number, p.name AS product_name,
            u.full_name AS assignee_name
       FROM alerts a
       LEFT JOIN codes c    ON c.id = a.code_id
       LEFT JOIN batches b  ON b.id = COALESCE(a.batch_id, c.batch_id)
       LEFT JOIN products p ON p.id = b.product_id
       LEFT JOIN users u    ON u.id = a.assigned_to
       ${clause}
      ORDER BY
        CASE a.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END,
        CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        a.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return {
    items: rows.map((r) => ({ ...r, detail: r.detail_json ? JSON.parse(r.detail_json) : null })),
    total,
    ...meta,
  };
}

/** Full detail for one alert, including the scans that produced it. */
export async function getById(id) {
  const alert = await db.get(
    `SELECT a.*, c.code, c.scan_count, b.batch_number, b.expiry_date, p.name AS product_name, p.sku
       FROM alerts a
       LEFT JOIN codes c    ON c.id = a.code_id
       LEFT JOIN batches b  ON b.id = COALESCE(a.batch_id, c.batch_id)
       LEFT JOIN products p ON p.id = b.product_id
      WHERE a.id = ?`,
    [id]
  );
  if (!alert) return null;

  const relatedScans = alert.code_id
    ? await db.all(
        `SELECT id, result, reason, channel, country, region, city, created_at
           FROM scans WHERE code_id = ? ORDER BY created_at DESC LIMIT 50`,
        [alert.code_id]
      )
    : [];

  return {
    ...alert,
    detail: alert.detail_json ? JSON.parse(alert.detail_json) : null,
    scans: relatedScans,
  };
}

/** Move an alert through its workflow. Returns the updated row. */
export async function updateStatus(id, { status, assignedTo, note, actor }) {
  const alert = await db.get('SELECT * FROM alerts WHERE id = ?', [id]);
  if (!alert) return null;

  const resolving = status === 'resolved' || status === 'dismissed';
  await db.run(
    `UPDATE alerts
        SET status = COALESCE(?, status),
            assigned_to = COALESCE(?, assigned_to),
            resolution_note = COALESCE(?, resolution_note),
            resolved_by = CASE WHEN ? THEN ? ELSE resolved_by END,
            resolved_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE resolved_at END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [
      status ?? null,
      assignedTo ?? null,
      note ?? null,
      resolving ? 1 : 0,
      actor?.id ?? null,
      resolving ? 1 : 0,
      id,
    ]
  );
  return await db.get('SELECT * FROM alerts WHERE id = ?', [id]);
}

/** Counts for the dashboard header. */
export async function counts() {
  const rows = await db.all(
    `SELECT status, severity, COUNT(*) AS n FROM alerts GROUP BY status, severity`
  );
  const out = { open: 0, investigating: 0, resolved: 0, dismissed: 0, critical: 0, high: 0 };
  for (const r of rows) {
    out[r.status] = (out[r.status] ?? 0) + r.n;
    if (r.status === 'open' || r.status === 'investigating') {
      if (r.severity === 'critical') out.critical += r.n;
      if (r.severity === 'high') out.high += r.n;
    }
  }
  return out;
}

export default { raise, list, getById, updateStatus, counts };
