/**
 * Analytics and reporting.
 *
 * Two distinct audiences, and the split between them is a compliance
 * requirement, not a UI preference:
 *
 *   - the SECURITY TEAM sees individual scans, including approximate
 *     location, because that is how a counterfeit cluster gets found;
 *   - a REGULATOR sees aggregate serialization and batch figures ONLY, and
 *     never individual patient scan rows.
 *
 * `await complianceReport()` is therefore built from aggregates exclusively - there
 * is no code path from it to a scan row.
 *
 * Every query here excludes sandbox/test batches by default, so pilot traffic
 * can never distort the live figures.
 */
import * as db from '../db/index.js';

/** SQL fragment excluding test-batch traffic. */
const LIVE_ONLY = 'is_test = 0';

/** Headline numbers for the dashboard. */
export async function overview({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const today = new Date(new Date().toDateString()).toISOString();

  const scans = await db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN result = 'genuine' THEN 1 ELSE 0 END) AS genuine,
            SUM(CASE WHEN result = 'flagged' THEN 1 ELSE 0 END) AS flagged,
            SUM(CASE WHEN result = 'invalid' THEN 1 ELSE 0 END) AS invalid
       FROM scans WHERE ${LIVE_ONLY} AND created_at >= ?`,
    [since]
  );

  const todayScans = await db.scalar(
    `SELECT COUNT(*) FROM scans WHERE ${LIVE_ONLY} AND created_at >= ?`,
    [today]
  );

  const codes = await db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN c.status = 'verified' THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN c.status = 'flagged' THEN 1 ELSE 0 END) AS flagged
       FROM codes c JOIN batches b ON b.id = c.batch_id
      WHERE b.is_test = 0`
  );

  const batches = await db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status IN ('released','distributed') THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'recalled' THEN 1 ELSE 0 END) AS recalled
       FROM batches WHERE is_test = 0`
  );

  const alertCounts = await db.get(
    `SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN status = 'investigating' THEN 1 ELSE 0 END) AS investigating,
            SUM(CASE WHEN status IN ('open','investigating') AND severity IN ('high','critical') THEN 1 ELSE 0 END) AS urgent
       FROM alerts`
  );

  const total = scans?.total ?? 0;
  const flagged = scans?.flagged ?? 0;

  return {
    windowDays: days,
    scans: {
      total,
      genuine: scans?.genuine ?? 0,
      flagged,
      invalid: scans?.invalid ?? 0,
      today: todayScans ?? 0,
      // The single number the security team watches. Expressed per-thousand
      // because a healthy rate is a fraction of a percent.
      flagRatePerThousand: total ? Number(((flagged / total) * 1000).toFixed(1)) : 0,
    },
    codes: {
      total: codes?.total ?? 0,
      verified: codes?.verified ?? 0,
      flagged: codes?.flagged ?? 0,
    },
    batches: {
      total: batches?.total ?? 0,
      active: batches?.active ?? 0,
      recalled: batches?.recalled ?? 0,
    },
    alerts: {
      open: alertCounts?.open ?? 0,
      investigating: alertCounts?.investigating ?? 0,
      urgent: alertCounts?.urgent ?? 0,
    },
    reports: {
      new: await db.scalar(`SELECT COUNT(*) FROM consumer_reports WHERE status = 'new'`) ?? 0,
    },
  };
}

/**
 * Daily scan counts for the trend chart.
 * Gaps are filled with zeros so the chart's x-axis stays evenly spaced - a
 * missing day must read as "no scans", not as a shorter week.
 */
export async function scanTrend({ days = 14 } = {}) {
  const since = new Date(Date.now() - (days - 1) * 86400000);
  since.setHours(0, 0, 0, 0);

  const rows = await db.all(
    `SELECT substr(created_at, 1, 10) AS day,
            SUM(CASE WHEN result = 'genuine' THEN 1 ELSE 0 END) AS genuine,
            SUM(CASE WHEN result = 'flagged' THEN 1 ELSE 0 END) AS flagged,
            SUM(CASE WHEN result = 'invalid' THEN 1 ELSE 0 END) AS invalid
       FROM scans
      WHERE ${LIVE_ONLY} AND created_at >= ?
      GROUP BY day ORDER BY day`,
    [since.toISOString()]
  );

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86400000).toISOString().slice(0, 10);
    const r = byDay.get(d);
    series.push({
      day: d,
      genuine: r?.genuine ?? 0,
      flagged: r?.flagged ?? 0,
      invalid: r?.invalid ?? 0,
    });
  }
  return series;
}

/** Where scans are coming from - drives the "flags clustering" view. */
export async function geoBreakdown({ days = 30, limit = 12 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return await db.all(
    `SELECT COALESCE(country, 'Unknown') AS country,
            COALESCE(region, '') AS region,
            COUNT(*) AS total,
            SUM(CASE WHEN result = 'flagged' THEN 1 ELSE 0 END) AS flagged
       FROM scans
      WHERE ${LIVE_ONLY} AND created_at >= ?
      GROUP BY country, region
      ORDER BY flagged DESC, total DESC
      LIMIT ?`,
    [since, limit]
  );
}

/** Batches ranked by flag rate - the "which product line is being copied" view. */
export async function topFlaggedBatches({ days = 30, limit = 8 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return await db.all(
    `SELECT b.id, b.batch_number, b.status, b.expiry_date, p.name AS product_name, p.sku,
            COUNT(s.id) AS scans,
            SUM(CASE WHEN s.result = 'flagged' THEN 1 ELSE 0 END) AS flagged
       FROM scans s
       JOIN batches b  ON b.id = s.batch_id
       JOIN products p ON p.id = b.product_id
      WHERE s.is_test = 0 AND s.created_at >= ?
      -- p.name and p.sku are listed explicitly: grouping by b.id only makes
      -- the BATCHES columns functionally dependent, not the joined product's.
      GROUP BY b.id, b.batch_number, b.status, b.expiry_date, p.name, p.sku
     HAVING flagged > 0
      ORDER BY flagged DESC, scans DESC
      LIMIT ?`,
    [since, limit]
  );
}

/**
 * Paged scan log. SECURITY-TEAM ONLY (permission 'scans:read').
 * Raw IPs are never returned; `ip_hash` stays server-side.
 */
export async function listScans({ page, pageSize, result, reason, channel, batchId, codeId, from, to, includeTest } = {}) {
  const { limit, offset, ...meta } = db.paginate({ page, pageSize });
  const where = [];
  const params = [];

  if (!includeTest) where.push('s.is_test = 0');
  if (result) { where.push('s.result = ?'); params.push(result); }
  if (reason) { where.push('s.reason = ?'); params.push(reason); }
  if (channel) { where.push('s.channel = ?'); params.push(channel); }
  if (batchId) { where.push('s.batch_id = ?'); params.push(batchId); }
  if (codeId) { where.push('s.code_id = ?'); params.push(codeId); }
  if (from) { where.push('s.created_at >= ?'); params.push(from); }
  if (to) { where.push('s.created_at <= ?'); params.push(to); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await db.scalar(`SELECT COUNT(*) FROM scans s ${clause}`, params);

  const items = await db.all(
    `SELECT s.id, s.code_text, s.result, s.reason, s.channel, s.scan_number,
            s.country, s.region, s.city, s.signature_state, s.is_test, s.created_at,
            b.batch_number, p.name AS product_name, p.sku
       FROM scans s
       LEFT JOIN batches b  ON b.id = s.batch_id
       LEFT JOIN products p ON p.id = s.product_id
       ${clause}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return { items, total, ...meta };
}

/**
 * Regulator-facing compliance report.
 *
 * Aggregates only. Deliberately contains no per-scan, per-device or
 * per-location data, so handing it to an external auditor cannot disclose
 * anything about an individual patient.
 */
export async function complianceReport({ from, to } = {}) {
  const start = from ?? new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const end = to ?? new Date().toISOString().slice(0, 10);
  const params = [`${start}T00:00:00.000Z`, `${end}T23:59:59.999Z`];

  const batches = await db.all(
    `SELECT b.batch_number, p.sku, p.name AS product_name, p.manufacturer,
            b.mfg_date, b.expiry_date, b.quantity, b.status,
            b.codes_issued_at, b.released_at, b.recalled_at, b.recall_reason,
            (SELECT COUNT(*) FROM codes c WHERE c.batch_id = b.id) AS codes_issued
       FROM batches b JOIN products p ON p.id = b.product_id
      WHERE b.is_test = 0 AND b.created_at BETWEEN ? AND ?
      ORDER BY b.created_at DESC`,
    params
  );

  const totals = await db.get(
    `SELECT COUNT(*) AS scans,
            SUM(CASE WHEN result = 'genuine' THEN 1 ELSE 0 END) AS genuine,
            SUM(CASE WHEN result = 'flagged' THEN 1 ELSE 0 END) AS flagged
       FROM scans WHERE ${LIVE_ONLY} AND created_at BETWEEN ? AND ?`,
    params
  );

  const alertSummary = await db.all(
    `SELECT type, status, COUNT(*) AS n FROM alerts
      WHERE created_at BETWEEN ? AND ? GROUP BY type, status`,
    params
  );

  return {
    period: { from: start, to: end },
    generatedAt: new Date().toISOString(),
    serialization: {
      batches: batches.length,
      unitsSerialized: batches.reduce((a, b) => a + b.codes_issued, 0),
      unitsPlanned: batches.reduce((a, b) => a + b.quantity, 0),
      recalledBatches: batches.filter((b) => b.status === 'recalled').length,
    },
    verification: {
      totalChecks: totals?.scans ?? 0,
      genuine: totals?.genuine ?? 0,
      flagged: totals?.flagged ?? 0,
    },
    alerts: alertSummary,
    batches,
  };
}

/** Render any array of flat objects as CSV (used by every export endpoint). */
export function toCsv(rows, columns) {
  if (!rows.length) return '';
  const cols = columns ?? Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Quote when the value contains a delimiter, quote or newline.
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => escape(r[c])).join(','))].join('\n');
}

export default {
  overview,
  scanTrend,
  geoBreakdown,
  topFlaggedBatches,
  listScans,
  complianceReport,
  toCsv,
};
