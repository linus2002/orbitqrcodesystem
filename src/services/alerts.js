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
    ? await db.findOne(
        'alert',
        { type, code_id: codeId, status: { in: ['open', 'investigating'] } },
        { order: 'id desc' }
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
    const changes = { detail_json: JSON.stringify(merged), severity };
    if (scanId !== null && scanId !== undefined) changes.scan_id = scanId;

    await db.update('alert', existing, changes);
    logger.info('alert folded', { id: existing.id, type, occurrences, severity });
    // Built rather than re-read: inside a transaction the write is not
    // visible yet.
    return { ...existing, ...changes, updated_at: db.now() };
  }

  const detail = { ...context, occurrences: 1, firstSeenAt: new Date().toISOString() };
  const alert = await db.insert('alert', {
    type,
    severity: spec.severity,
    status: 'open',
    title: spec.title(context),
    detail_json: JSON.stringify(detail),
    // Kept as its own field so guessing detection can filter on it.
    ip_hash: context.ipHash ?? null,
    code_id: codeId,
    batch_id: batchId,
    scan_id: scanId,
  });

  logger.warn('alert raised', { id: alert.id, type, severity: spec.severity });
  notify(type, spec.severity, spec.title(context));
  return alert;
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

/**
 * Attach the code, batch and product fields every alert view shows.
 *
 * Done as one query per related type rather than per alert. The batch is the
 * alert's own, or its code's when it carries none - COALESCE(a.batch_id,
 * c.batch_id) in the SQL this replaced.
 */
async function withContext(alerts, { codeFields = [], batchFields = [], productFields = [] } = {}) {
  const ids = (list) => [...new Set(list.filter((v) => v !== null && v !== undefined))];
  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));

  const codes = byId(await db.findMany('code', { id: { in: ids(alerts.map((a) => a.code_id)) } }, {
    fields: ['code', 'batch_id', ...codeFields],
  }));
  const batchOf = (a) => a.batch_id ?? codes.get(a.code_id)?.batch_id ?? null;
  const batches = byId(await db.findMany('batch', { id: { in: ids(alerts.map(batchOf)) } }, {
    fields: ['batch_number', 'product_id', ...batchFields],
  }));
  const products = byId(await db.findMany('product', {
    id: { in: ids([...batches.values()].map((b) => b.product_id)) },
  }, { fields: ['name', ...productFields] }));

  return alerts.map((a) => {
    const c = codes.get(a.code_id);
    const b = batches.get(batchOf(a));
    const p = b ? products.get(b.product_id) : undefined;
    return { a, c, b, p };
  });
}

/** Paged, filtered alert queue for the dashboard. */
export async function list({ page, pageSize, status, severity, type, batchId } = {}) {
  const { limit, offset, ...meta } = db.paginate({ page, pageSize });
  const where = {
    status: status || undefined,
    severity: severity || undefined,
    type: type || undefined,
    batch_id: batchId ? Number(batchId) : undefined,
  };

  const total = await db.count('alert', where);
  const rows = await db.findMany('alert', where, {
    order: [
      'select(status == "open" => 0, status == "investigating" => 1, 2) asc',
      'select(severity == "critical" => 0, severity == "high" => 1, severity == "medium" => 2, 3) asc',
      'created_at desc',
    ],
    limit,
    offset,
    extra: { assignee_name: '*[_type == "user" && id == ^.assigned_to][0].full_name' },
  });

  const items = (await withContext(rows)).map(({ a, c, b, p }) => {
    const { ip_hash, ...r } = a;
    return {
      ...r,
      code: c?.code ?? null,
      batch_number: b?.batch_number ?? null,
      product_name: p?.name ?? null,
      detail: r.detail_json ? JSON.parse(r.detail_json) : null,
    };
  });

  return {
    items,
    total,
    ...meta,
  };
}

/** Full detail for one alert, including the scans that produced it. */
export async function getById(id) {
  const row = await db.get('alert', id);
  if (!row) return null;
  const [{ c, b, p }] = await withContext([row], {
    codeFields: ['scan_count', 'status', 'verified_count'],
    batchFields: ['expiry_date', 'status'],
    productFields: ['sku'],
  });
  const alert = {
    ...row,
    code: c?.code ?? null,
    scan_count: c?.scan_count ?? null,
    code_status: c?.status ?? null,
    verified_count: c?.verified_count ?? null,
    batch_number: b?.batch_number ?? null,
    expiry_date: b?.expiry_date ?? null,
    batch_status: b?.status ?? null,
    product_name: p?.name ?? null,
    sku: p?.sku ?? null,
  };

  const relatedScans = alert.code_id
    ? await db.findMany('scan', { code_id: alert.code_id }, {
        order: 'created_at desc',
        limit: 50,
        fields: ['id', 'result', 'reason', 'channel', 'country', 'region', 'city', 'created_at'],
      })
    : [];

  const { ip_hash, ...rest } = alert;
  return {
    ...rest,
    detail: alert.detail_json ? JSON.parse(alert.detail_json) : null,
    scans: relatedScans,
  };
}

/** Move an alert through its workflow. Returns the updated row. */
export async function updateStatus(id, { status, assignedTo, note, actor }) {
  const alert = await db.get('alert', id);
  if (!alert) return null;

  const resolving = status === 'resolved' || status === 'dismissed';
  const changes = {
    status: status ?? undefined,
    assigned_to: assignedTo ?? undefined,
    resolution_note: note ?? undefined,
  };
  if (resolving) {
    changes.resolved_by = actor?.id ?? null;
    changes.resolved_at = db.now();
  }
  await db.update('alert', alert, changes);
  // Built rather than re-read, so this also works inside a transaction.
  const merged = { ...alert, updated_at: db.now() };
  for (const [k, v] of Object.entries(changes)) if (v !== undefined) merged[k] = v;
  return merged;
}

/** Counts for the dashboard header. */
export async function counts() {
  const STATUSES = ['open', 'investigating', 'resolved', 'dismissed'];
  const parts = STATUSES.map((st) => `"${st}": count(*[_type == "alert" && status == "${st}"])`);
  parts.push('"critical": count(*[_type == "alert" && status in ["open", "investigating"] && severity == "critical"])');
  parts.push('"high": count(*[_type == "alert" && status in ["open", "investigating"] && severity == "high"])');
  return db.query(`{${parts.join(', ')}}`);
}

export default { raise, list, getById, updateStatus, counts };
