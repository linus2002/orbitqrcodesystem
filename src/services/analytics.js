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
 *
 * GROQ has no GROUP BY. A figure broken down by day, country or batch selects
 * the window's scans ONCE, as a short projected list, and counts within that
 * list in the same request:
 *
 *   {"s": *[window]{created_at, result}} { "day1": count(s[...]), ... }
 *
 * so the dataset is scanned once per request, not once per figure. Only the
 * narrow projection travels, never whole scan documents.
 */
import * as db from '../db/index.js';
import { TYPES } from '../db/schema.js';

/** GROQ filter for live (non-test) scans. */
const LIVE_SCANS = '_type == "scan" && is_test == 0';

/**
 * Percentage change, or null when there is nothing to compare against.
 *
 * Null rather than 0 or 100 when the previous period was empty: "up 100%" from
 * a base of zero is arithmetic, not information, and on a dashboard it reads
 * as a trend somebody might act on.
 */
function changePct(current, previous) {
  if (!previous) return null;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

/** Ids of every sandbox batch; their codes are left out of live figures. */
const testBatchIds = () => db.query('*[_type == "batch" && is_test == 1].id');

/** Headline numbers for the dashboard. */
export async function overview({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const today = new Date(new Date().toDateString()).toISOString();

  /*
   * The window immediately before this one, the same length. That is what
   * makes a count mean something: 57 flagged checks is unreadable on its own,
   * and "57, up from 31" is the whole point of putting it on a dashboard.
   */
  const previousSince = new Date(Date.now() - days * 2 * 86400000).toISOString();

  // Codes are counted per status by the Lake: the registry is far too large
  // to project, unlike the scans of one window.
  const codeStatus = (st) =>
    `count(*[_type == "code" && !(batch_id in $testBatches)${st ? ` && status == "${st}"` : ''}])`;
  const r = await db.query(
    `{
       "s": *[${LIVE_SCANS} && created_at >= $previousSince]{created_at, result},
       "b": *[_type == "batch" && is_test == 0].status,
       "a": *[_type == "alert" && status in ["open", "investigating"]]{status, severity},
       "codesTotal": ${codeStatus()},
       "codesVerified": ${codeStatus('verified')},
       "codesFlagged": ${codeStatus('flagged')},
       "reportsNew": count(*[_type == "consumerReport" && status == "new"])
     }{
       "total": count(s[created_at >= $since]),
       "genuine": count(s[created_at >= $since && result == "genuine"]),
       "flagged": count(s[created_at >= $since && result == "flagged"]),
       "invalid": count(s[created_at >= $since && result == "invalid"]),
       "previousTotal": count(s[created_at < $since]),
       "previousFlagged": count(s[created_at < $since && result == "flagged"]),
       "today": count(s[created_at >= $today]),
       codesTotal, codesVerified, codesFlagged,
       "batchesTotal": count(b),
       "batchesActive": count(b[@ in ["released", "distributed"]]),
       "batchesRecalled": count(b[@ == "recalled"]),
       "alertsOpen": count(a[status == "open"]),
       "alertsInvestigating": count(a[status == "investigating"]),
       "alertsUrgent": count(a[severity in ["high", "critical"]]),
       reportsNew
     }`,
    { since, previousSince, today, testBatches: await testBatchIds() }
  );

  const total = r.total;
  const flagged = r.flagged;

  return {
    windowDays: days,
    scans: {
      total,
      genuine: r.genuine,
      flagged,
      invalid: r.invalid,
      today: r.today,
      previousTotal: r.previousTotal,
      previousFlagged: r.previousFlagged,
      changePct: changePct(total, r.previousTotal),
      flaggedChangePct: changePct(flagged, r.previousFlagged),
      // The single number the security team watches. Expressed per-thousand
      // because a healthy rate is a fraction of a percent.
      flagRatePerThousand: total ? Number(((flagged / total) * 1000).toFixed(1)) : 0,
    },
    codes: {
      total: r.codesTotal,
      verified: r.codesVerified,
      flagged: r.codesFlagged,
    },
    batches: {
      total: r.batchesTotal,
      active: r.batchesActive,
      recalled: r.batchesRecalled,
    },
    alerts: {
      open: r.alertsOpen,
      investigating: r.alertsInvestigating,
      urgent: r.alertsUrgent,
    },
    reports: {
      new: r.reportsNew,
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

  // Days are UTC calendar days, as substr(created_at, 1, 10) grouped them.
  const dayList = [];
  for (let i = 0; i < days; i++) {
    dayList.push(new Date(since.getTime() + i * 86400000).toISOString().slice(0, 10));
  }

  const params = { since: since.toISOString() };
  const parts = dayList.map((d, i) => {
    params[`d${i}`] = `${d}T00:00:00.000Z`;
    params[`e${i}`] = new Date(Date.parse(`${d}T00:00:00.000Z`) + 86400000).toISOString();
    const range = `created_at >= $d${i} && created_at < $e${i}`;
    return `"${d}": {
      "genuine": count(s[${range} && result == "genuine"]),
      "flagged": count(s[${range} && result == "flagged"]),
      "invalid": count(s[${range} && result == "invalid"])
    }`;
  });
  const byDay = await db.query(
    `{"s": *[${LIVE_SCANS} && created_at >= $since]{created_at, result}}{${parts.join(',\n')}}`,
    params
  );

  return dayList.map((day) => ({
    day,
    genuine: byDay[day]?.genuine ?? 0,
    flagged: byDay[day]?.flagged ?? 0,
    invalid: byDay[day]?.invalid ?? 0,
  }));
}

/** Where scans are coming from - drives the "flags clustering" view. */
export async function geoBreakdown({ days = 30, limit = 12 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const window = `${LIVE_SCANS} && created_at >= $since`;

  // The window's scans, reduced to a (country, region) key and a result.
  const rows = `*[${window}]{"k": coalesce(country, "") + "|" + coalesce(region, ""), result}`;

  // Step 1: the distinct pairs.
  const keys = await db.query(`array::unique(${rows}[].k)`, { since });
  if (!keys.length) return [];

  // Step 2: the two counts for every pair, from one pass over the window.
  const params = { since };
  const parts = keys.map((k, i) => {
    params[`k${i}`] = k;
    return `{"i": ${i}, "total": count(s[k == $k${i}]), "flagged": count(s[k == $k${i} && result == "flagged"])}`;
  });
  const counts = (await db.query(`{"s": ${rows}}{"rows": [${parts.join(', ')}]}`, params)).rows;

  return counts
    .map((c) => {
      const [country, region] = keys[c.i].split('|');
      return { country: country || 'Unknown', region, total: c.total, flagged: c.flagged };
    })
    .sort((a, b) => b.flagged - a.flagged || b.total - a.total)
    .slice(0, limit);
}

/** Batches ranked by flag rate - the "which product line is being copied" view. */
export async function topFlaggedBatches({ days = 30, limit = 8 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const window = `${LIVE_SCANS} && created_at >= $since`;

  // The window's batch-linked scans once, reduced to (batch, result); each
  // batch's two counts come from that one list. Only batches with at least
  // one flag qualify (the old HAVING).
  const r = await db.query(
    `{"s": *[${window} && defined(batch_id)]{batch_id, result}}{
       "ids": array::unique(s[result == "flagged"][].batch_id),
       s
     }`,
    { since }
  );
  if (!r.ids.length) return [];

  const tally = new Map(r.ids.map((id) => [id, { scans: 0, flagged: 0 }]));
  for (const x of r.s) {
    const t = tally.get(x.batch_id);
    if (!t) continue;
    t.scans += 1;
    if (x.result === 'flagged') t.flagged += 1;
  }

  const rows = (
    await db.findMany('batch', { id: { in: r.ids } }, {
      fields: ['batch_number', 'status', 'expiry_date'],
      extra: {
        product_name: '*[_type == "product" && id == ^.product_id][0].name',
        sku: '*[_type == "product" && id == ^.product_id][0].sku',
      },
    })
  ).map((b) => ({ ...b, ...tally.get(b.id) }));

  return rows
    .map(({ id, batch_number, status, expiry_date, product_name, sku, scans, flagged }) => ({
      id, batch_number, status, expiry_date, product_name, sku, scans, flagged,
    }))
    .sort((a, b) => b.flagged - a.flagged || b.scans - a.scans)
    .slice(0, limit);
}

/**
 * Paged scan log. SECURITY-TEAM ONLY (permission 'scans:read').
 * Raw IPs are never returned; `ip_hash` stays server-side.
 */
export async function listScans({ page, pageSize, result, reason, channel, batchId, codeId, from, to, includeTest } = {}) {
  const { limit, offset, ...meta } = db.paginate({ page, pageSize });
  const where = {
    is_test: includeTest ? undefined : 0,
    result: result || undefined,
    reason: reason || undefined,
    channel: channel || undefined,
    batch_id: batchId ? Number(batchId) : undefined,
    code_id: codeId ? Number(codeId) : undefined,
    created_at: from || to ? { gte: from || undefined, lte: to || undefined } : undefined,
  };

  const total = await db.count('scan', where);
  const items = await db.findMany('scan', where, {
    order: ['created_at desc', 'id desc'],
    limit,
    offset,
    // Named explicitly: ip_hash, msisdn_hash and user_agent must not leave.
    fields: ['code_text', 'result', 'reason', 'channel', 'scan_number', 'country', 'region', 'city',
      'signature_state', 'is_test', 'created_at'],
    extra: {
      batch_number: '*[_type == "batch" && id == ^.batch_id][0].batch_number',
      product_name: '*[_type == "product" && id == ^.product_id][0].name',
      sku: '*[_type == "product" && id == ^.product_id][0].sku',
    },
  });

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
  const range = { start: `${start}T00:00:00.000Z`, end: `${end}T23:59:59.999Z` };

  const batches = await db.findMany(
    'batch',
    { is_test: 0, created_at: { gte: range.start, lte: range.end } },
    {
      order: 'created_at desc',
      fields: ['batch_number', 'mfg_date', 'expiry_date', 'quantity', 'status',
        'codes_issued_at', 'released_at', 'recalled_at', 'recall_reason'],
      extra: {
        sku: '*[_type == "product" && id == ^.product_id][0].sku',
        product_name: '*[_type == "product" && id == ^.product_id][0].name',
        manufacturer: '*[_type == "product" && id == ^.product_id][0].manufacturer',
        codes_issued: 'count(*[_type == "code" && batch_id == ^.id])',
      },
    }
  );
  // The report lists what the batch is, not the store's internal id.
  for (const b of batches) delete b.id;

  const inRange = 'created_at >= $start && created_at <= $end';
  const alertParts = [];
  for (const type of TYPES.alert.fields.type.enum) {
    for (const status of TYPES.alert.fields.status.enum) {
      alertParts.push(
        `{"type": "${type}", "status": "${status}", "n": count(*[_type == "alert" && type == "${type}" && status == "${status}" && ${inRange}])}`
      );
    }
  }

  const r = await db.query(
    `{
       "scans": count(*[${LIVE_SCANS} && ${inRange}]),
       "genuine": count(*[${LIVE_SCANS} && ${inRange} && result == "genuine"]),
       "flagged": count(*[${LIVE_SCANS} && ${inRange} && result == "flagged"]),
       "alerts": [${alertParts.join(', ')}]
     }`,
    range
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
      totalChecks: r.scans,
      genuine: r.genuine,
      flagged: r.flagged,
    },
    // Only the combinations that occurred, as GROUP BY returned them.
    alerts: r.alerts.filter((a) => a.n > 0),
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
