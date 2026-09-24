/**
 * Admin API.
 *
 * Every route here requires a session and a specific permission. The
 * permission names map to the role matrix in services/auth.js, which is the
 * single place roles are defined - no route invents its own rule.
 *
 * Note where 'scans:read' is required: the regulator role does not hold it,
 * so a regulator physically cannot reach individual patient scan rows, only
 * the aggregate compliance endpoints.
 */
import { Router } from 'express';
import * as db from '../db/index.js';
import { config, LOCAL_BASE_URL_WARNING } from '../config.js';
import * as analytics from '../services/analytics.js';
import * as alertService from '../services/alerts.js';
import * as serialization from '../services/serialization.js';
import * as authService from '../services/auth.js';
import * as audit from '../services/audit.js';
import * as importer from '../services/importer.js';
import * as leaflets from '../services/leaflets.js';
import { validate } from '../lib/validate.js';
import { buildWorkbook, sendWorkbook, readSheet } from '../lib/spreadsheet.js';
import { normalizeCode, qrPayload } from '../lib/codes.js';
import { notFound, badRequest, conflict, forbidden } from '../lib/errors.js';
import { requireAuth, requirePermission, requireCsrf } from '../middleware/auth.js';

const router = Router();

// Everything below is authenticated, and every mutation is CSRF-checked.
router.use(requireAuth, requireCsrf);

/** Send a CSV download response. */
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

/** Parse shared list query parameters. */
const listQuery = (req) => ({
  page: req.query.page,
  pageSize: req.query.pageSize,
});

// ===========================================================================
// Dashboard
// ===========================================================================

router.get('/overview', requirePermission('dashboard:view'), async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  res.json({
    overview: await analytics.overview({ days }),
    trend: await analytics.scanTrend({ days: Math.min(days, 30) }),
    topBatches: await analytics.topFlaggedBatches({ days }),
    geo: await analytics.geoBreakdown({ days }),
  });
});

router.get('/trend', requirePermission('dashboard:view'), async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
  res.json({ items: await analytics.scanTrend({ days }) });
});

// ===========================================================================
// Products
// ===========================================================================

router.get('/products', requirePermission('products:read'), async (req, res) => {
  const items = await db.all(
    `SELECT p.*,
            (SELECT COUNT(*) FROM batches b WHERE b.product_id = p.id) AS batch_count,
            (SELECT COUNT(*) FROM codes c WHERE c.product_id = p.id)   AS code_count
       FROM products p ORDER BY p.name`
  );
  res.json({ items, total: items.length });
});

router.post('/products', requirePermission('products:write'), async (req, res) => {
  const data = validate(req.body, {
    sku: {
      type: 'string',
      required: true,
      min: 2,
      max: 12,
      pattern: /^[A-Za-z0-9]+$/,
      patternMessage: 'may contain only letters and digits (it becomes part of every code)',
    },
    name: { type: 'string', required: true, max: 160 },
    genericName: { type: 'string', max: 160 },
    strength: { type: 'string', max: 60 },
    dosageForm: { type: 'string', max: 60 },
    packSize: { type: 'string', max: 60 },
    manufacturer: { type: 'string', required: true, max: 160 },
    category: { type: 'string', max: 60 },
  });

  const sku = data.sku.toUpperCase();
  if (await db.get('SELECT id FROM products WHERE sku = ?', [sku])) {
    throw conflict(`A product with SKU ${sku} already exists.`);
  }

  const { lastInsertRowid } = await db.run(
    `INSERT INTO products (sku, name, generic_name, strength, dosage_form, pack_size, manufacturer, category)
     VALUES (?,?,?,?,?,?,?,?)`,
    [sku, data.name, data.genericName ?? null, data.strength ?? null, data.dosageForm ?? null,
     data.packSize ?? null, data.manufacturer, data.category ?? null]
  );

  await audit.record({ actor: req.user, req, action: 'product.create', entityType: 'product', entityId: lastInsertRowid, detail: { sku } });
  res.status(201).json(await db.get('SELECT * FROM products WHERE id = ?', [lastInsertRowid]));
});

router.get('/products/:id', requirePermission('products:read'), async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) throw notFound('Product not found');
  res.json({
    ...product,
    leaflets: await db.all(
      'SELECT id, version, language, effective_from FROM leaflets WHERE product_id = ? ORDER BY effective_from DESC',
      [product.id]
    ),
    batches: await db.all(
      'SELECT id, batch_number, status, mfg_date, expiry_date, quantity, is_test FROM batches WHERE product_id = ? ORDER BY created_at DESC',
      [product.id]
    ),
  });
});

router.patch('/products/:id', requirePermission('products:write'), async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) throw notFound('Product not found');

  const data = validate(req.body, {
    name: { type: 'string', max: 160 },
    genericName: { type: 'string', max: 160 },
    strength: { type: 'string', max: 60 },
    dosageForm: { type: 'string', max: 60 },
    packSize: { type: 'string', max: 60 },
    manufacturer: { type: 'string', max: 160 },
    category: { type: 'string', max: 60 },
    status: { type: 'enum', values: ['active', 'discontinued'] },
  });

  // The SKU is intentionally immutable: it is embedded in every code already
  // printed on packs, so changing it would orphan them.
  await db.run(
    `UPDATE products SET name = COALESCE(?, name), generic_name = COALESCE(?, generic_name),
            strength = COALESCE(?, strength), dosage_form = COALESCE(?, dosage_form),
            pack_size = COALESCE(?, pack_size), manufacturer = COALESCE(?, manufacturer),
            category = COALESCE(?, category), status = COALESCE(?, status),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [data.name ?? null, data.genericName ?? null, data.strength ?? null, data.dosageForm ?? null,
     data.packSize ?? null, data.manufacturer ?? null, data.category ?? null, data.status ?? null,
     product.id]
  );

  await audit.record({ actor: req.user, req, action: 'product.update', entityType: 'product', entityId: product.id, detail: data });
  res.json(await db.get('SELECT * FROM products WHERE id = ?', [product.id]));
});

/**
 * Publish a new leaflet version for a product - and for the other products
 * the same document covers.
 *
 * One real-world leaflet routinely spans several strengths of a medicine:
 * Beltro-25 and Beltro-50 share a single document. But a leaflet row belongs
 * to one product. So a publish may name the other products the document
 * covers, and writes one row per product with identical version, language
 * and content, in ONE transaction - either every strength gets the new
 * version or none does, so two strengths of one medicine can never end up
 * telling patients different things.
 *
 * The grouping is not stored: the shared version string IS the grouping.
 * That keeps the schema unchanged, and the form reconstructs the set on the
 * next revision from whichever products share the current version.
 *
 * A reason is required and goes into the audit trail. Whoever operates this
 * after handover will be asked by an inspector who changed a leaflet and why,
 * and the answer has to already be in the log.
 */
router.post('/products/:id/leaflets', requirePermission('products:write'), async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) throw notFound('Product not found');

  const data = validate(req.body, {
    version: { type: 'string', required: true, max: 20 },
    language: { type: 'string', max: 8, default: 'en' },
    sections: { type: 'array', required: true, max: 40 },
    // Same bounds as a code void: long enough to mean something, short enough
    // to read in the audit log.
    reason: { type: 'string', required: true, min: 5, max: 300 },
    alsoApplyTo: { type: 'array', max: 50 },
  });

  for (const s of data.sections) {
    if (!s?.heading || !s?.body) throw badRequest('Every leaflet section needs a heading and a body.');
  }

  // Every product this document covers: the named one first, no repeats.
  const extraIds = (data.alsoApplyTo ?? []).map((v) => Number.parseInt(v, 10));
  if (extraIds.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw badRequest('alsoApplyTo must be a list of product ids.');
  }
  const ids = [...new Set([product.id, ...extraIds])];
  const marks = ids.map(() => '?').join(',');

  const products = await db.all(`SELECT id, sku FROM products WHERE id IN (${marks})`, ids);
  if (products.length !== ids.length) {
    throw badRequest('One of the products to publish to does not exist.');
  }
  products.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  /*
   * Checked up front and named, rather than left to the UNIQUE constraint:
   * a constraint failure would be a 500 that says nothing about which
   * strength already had the version, and with several products in one
   * publish that is the first thing the person needs to know.
   */
  const taken = await db.all(
    `SELECT p.sku FROM leaflets l JOIN products p ON p.id = l.product_id
      WHERE l.product_id IN (${marks}) AND l.version = ? AND l.language = ?`,
    [...ids, data.version, data.language]
  );
  if (taken.length) {
    throw conflict(
      `Version ${data.version} (${data.language}) already exists for ` +
        `${taken.map((t) => t.sku).join(', ')}. Use a new version number.`
    );
  }

  const sectionsJson = JSON.stringify(data.sections);
  const coverage = await db.tx(async () => {
    const rows = [];
    for (const p of products) {
      const { lastInsertRowid } = await db.run(
        `INSERT INTO leaflets (product_id, version, language, sections_json) VALUES (?,?,?,?)`,
        [p.id, data.version, data.language, sectionsJson]
      );
      rows.push({ leafletId: lastInsertRowid, productId: p.id, sku: p.sku });
    }
    return rows;
  });

  // One entry per product, so the trail for any single SKU is complete on its
  // own - and each names the whole set, so the grouping is on record even
  // though the schema does not store it.
  const covers = coverage.map((c) => c.sku);
  for (const c of coverage) {
    await audit.record({
      actor: req.user,
      req,
      action: 'leaflet.publish',
      entityType: 'leaflet',
      entityId: c.leafletId,
      detail: { sku: c.sku, version: data.version, language: data.language, reason: data.reason, covers },
    });
  }

  // The named product's row, as before, plus what else was written.
  const primary = await db.get('SELECT * FROM leaflets WHERE id = ?', [coverage[0].leafletId]);
  res.status(201).json({ ...primary, coverage });
});

// ===========================================================================
// Batches
// ===========================================================================

router.get('/batches', requirePermission('batches:read'), async (req, res) => {
  const { limit, offset, ...meta } = db.paginate(listQuery(req));
  const where = [];
  const params = [];

  if (req.query.status) { where.push('b.status = ?'); params.push(req.query.status); }
  if (req.query.productId) { where.push('b.product_id = ?'); params.push(req.query.productId); }
  if (req.query.includeTest !== 'true') where.push('b.is_test = 0');
  if (req.query.search) {
    where.push('(b.batch_number LIKE ? OR p.name LIKE ? OR p.sku LIKE ?)');
    const q = `%${req.query.search}%`;
    params.push(q, q, q);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await db.scalar(`SELECT COUNT(*) FROM batches b JOIN products p ON p.id = b.product_id ${clause}`, params);
  const items = await db.all(
    `SELECT b.*, p.name AS product_name, p.sku,
            (SELECT COUNT(*) FROM codes c WHERE c.batch_id = b.id) AS codes_issued,
            (SELECT COUNT(*) FROM scans s WHERE s.batch_id = b.id AND s.result = 'flagged') AS flagged_scans
       FROM batches b JOIN products p ON p.id = b.product_id
       ${clause} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  res.json({ items, total, ...meta });
});

router.post('/batches', requirePermission('batches:write'), async (req, res) => {
  const data = validate(req.body, {
    productId: { type: 'int', required: true, min: 1 },
    batchNumber: { type: 'string', required: true, max: 40, pattern: /^[A-Za-z0-9-]+$/, patternMessage: 'may contain letters, digits and hyphens only' },
    mfgDate: { type: 'date', required: true },
    expiryDate: { type: 'date', required: true },
    quantity: { type: 'int', required: true, min: 1, max: serialization.MAX_BATCH_QUANTITY },
    isTest: { type: 'bool', default: false },
    leafletId: { type: 'int', min: 1 },
    notes: { type: 'string', max: 500 },
  });

  const product = await db.get('SELECT * FROM products WHERE id = ?', [data.productId]);
  if (!product) throw badRequest('That product does not exist.');
  if (new Date(data.expiryDate) <= new Date(data.mfgDate)) {
    throw badRequest('The expiry date must be after the manufacturing date.');
  }
  if (await db.get('SELECT id FROM batches WHERE batch_number = ?', [data.batchNumber])) {
    throw conflict(`Batch ${data.batchNumber} already exists.`);
  }

  // Default to the product's newest leaflet, so a batch always has one.
  const leafletId =
    data.leafletId ??
    await db.get('SELECT id FROM leaflets WHERE product_id = ? ORDER BY effective_from DESC LIMIT 1', [product.id])?.id ??
    null;

  const { lastInsertRowid } = await db.run(
    `INSERT INTO batches (batch_number, product_id, mfg_date, expiry_date, quantity, is_test, leaflet_id, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [data.batchNumber, product.id, data.mfgDate, data.expiryDate, data.quantity,
     data.isTest ? 1 : 0, leafletId, data.notes ?? null, req.user.id]
  );

  await audit.record({ actor: req.user, req, action: 'batch.create', entityType: 'batch', entityId: lastInsertRowid, detail: { batchNumber: data.batchNumber, quantity: data.quantity, isTest: data.isTest } });
  res.status(201).json(await db.get('SELECT * FROM batches WHERE id = ?', [lastInsertRowid]));
});

router.get('/batches/:id', requirePermission('batches:read'), async (req, res) => {
  const batch = await db.get(
    `SELECT b.*, p.name AS product_name, p.sku, p.strength, p.manufacturer
       FROM batches b JOIN products p ON p.id = b.product_id WHERE b.id = ?`,
    [req.params.id]
  );
  if (!batch) throw notFound('Batch not found');

  res.json({
    ...batch,
    stats: await serialization.batchStats(batch.id),
    shipments: await db.all('SELECT * FROM shipments WHERE batch_id = ? ORDER BY shipped_at DESC', [batch.id]),
    openAlerts: await db.scalar(
      `SELECT COUNT(*) FROM alerts WHERE batch_id = ? AND status IN ('open','investigating')`,
      [batch.id]
    ),
  });
});

/** Run the serialization engine for a batch. */
router.post('/batches/:id/issue-codes', requirePermission('batches:write'), async (req, res) => {
  res.status(201).json(await serialization.issueCodes(Number(req.params.id), { actor: req.user, req }));
});

/** Move a batch through its lifecycle. */
router.post('/batches/:id/transition', requirePermission('batches:write'), async (req, res) => {
  const { to, reason } = validate(req.body, {
    to: { type: 'enum', required: true, values: ['printed', 'released', 'distributed', 'recalled', 'closed'] },
    reason: { type: 'string', max: 500 },
  });
  res.json(await serialization.transition(Number(req.params.id), to, { actor: req.user, req, reason: reason ?? null }));
});

router.get('/batches/:id/codes', requirePermission('codes:read'), async (req, res) => {
  res.json(
    await serialization.listCodes(Number(req.params.id), {
      ...listQuery(req),
      status: req.query.status,
      search: req.query.search,
    })
  );
});

/** CSV hand-off for the packaging line's printer. */
router.get('/batches/:id/codes.csv', requirePermission('codes:export'), async (req, res) => {
  const { filename, csv } = await serialization.exportCsv(Number(req.params.id));
  await audit.record({ actor: req.user, req, action: 'codes.export', entityType: 'batch', entityId: req.params.id });
  sendCsv(res, filename, csv);
});

/**
 * Printable label sheet data: codes plus their rendered QR images.
 *
 * Returns SVG markup rather than a rendered page so the dashboard can lay the
 * labels out for printing, and so nothing has to embed a QR encoder in the
 * browser. Capped at 60 labels per request to keep the response small.
 */
router.get('/batches/:id/labels', requirePermission('codes:read'), async (req, res) => {
  const batch = await db.get(
    `SELECT b.*, p.name AS product_name, p.sku, p.strength
       FROM batches b JOIN products p ON p.id = b.product_id WHERE b.id = ?`,
    [req.params.id]
  );
  if (!batch) throw notFound('Batch not found');

  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 60);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const codes = await db.all(
    'SELECT id, code, serial, unit_index FROM codes WHERE batch_id = ? ORDER BY unit_index LIMIT ? OFFSET ?',
    [batch.id, limit, offset]
  );

  const items = await Promise.all(
    codes.map(async (c) => ({ ...c, svg: await serialization.qrSvg(c.code) }))
  );

  res.json({
    batch: {
      batchNumber: batch.batch_number,
      productName: batch.product_name,
      sku: batch.sku,
      strength: batch.strength,
      mfgDate: batch.mfg_date,
      expiryDate: batch.expiry_date,
    },
    items,
    total: await db.scalar('SELECT COUNT(*) FROM codes WHERE batch_id = ?', [batch.id]),
    // Undefined when the base URL is a real one, so a correctly configured
    // deployment returns exactly the response it returned before.
    warning: config.publicBaseUrlIsLocal ? LOCAL_BASE_URL_WARNING : undefined,
  });
});

// ===========================================================================
// Codes
// ===========================================================================

/** Look up one code and its full scan history - the investigation view. */
router.get('/codes/lookup', requirePermission('codes:read'), async (req, res) => {
  const code = normalizeCode(String(req.query.code ?? ''));
  if (!code) throw badRequest('Provide a code to look up.');

  const row = await db.get(
    `SELECT c.*, b.batch_number, b.status AS batch_status, b.expiry_date, b.mfg_date, b.is_test,
            p.name AS product_name, p.sku, p.strength
       FROM codes c JOIN batches b ON b.id = c.batch_id JOIN products p ON p.id = c.product_id
      WHERE c.code = ?`,
    [code]
  );
  if (!row) throw notFound('That code is not in the registry.');

  res.json({
    ...row,
    qrPayload: qrPayload(row.code, config.secrets.code, config.publicBaseUrl),
    scans: await db.all(
      `SELECT id, result, reason, channel, scan_number, country, region, city, signature_state, created_at
         FROM scans WHERE code_id = ? ORDER BY created_at DESC LIMIT 100`,
      [row.id]
    ),
    alerts: await db.all('SELECT id, type, severity, status, title, created_at FROM alerts WHERE code_id = ?', [row.id]),
  });
});

/** Withdraw a single code (e.g. a unit destroyed or known stolen). */
router.post('/codes/:id/void', requirePermission('batches:write'), async (req, res) => {
  const { reason } = validate(req.body, { reason: { type: 'string', required: true, min: 5, max: 300 } });
  const code = await db.get('SELECT * FROM codes WHERE id = ?', [req.params.id]);
  if (!code) throw notFound('Code not found');

  await db.run(`UPDATE codes SET status = 'void' WHERE id = ?`, [code.id]);
  await audit.record({ actor: req.user, req, action: 'code.void', entityType: 'code', entityId: code.id, detail: { code: code.code, reason } });
  res.json({ ok: true, code: await db.get('SELECT * FROM codes WHERE id = ?', [code.id]) });
});

/** QR image for a single code, as SVG. */
router.get('/codes/:id/qr.svg', requirePermission('codes:read'), async (req, res) => {
  const code = await db.get('SELECT code FROM codes WHERE id = ?', [req.params.id]);
  if (!code) throw notFound('Code not found');
  res.type('image/svg+xml').send(await serialization.qrSvg(code.code));
});

// ===========================================================================
// Scans - security team only (a regulator has no 'scans:read')
// ===========================================================================

router.get('/scans', requirePermission('scans:read'), async (req, res) => {
  res.json(
    await analytics.listScans({
      ...listQuery(req),
      result: req.query.result,
      reason: req.query.reason,
      channel: req.query.channel,
      batchId: req.query.batchId,
      from: req.query.from,
      to: req.query.to,
      includeTest: req.query.includeTest === 'true',
    })
  );
});

router.get('/scans.csv', requirePermission('scans:read'), async (req, res) => {
  const { items } = await analytics.listScans({
    page: 1,
    pageSize: 5000,
    result: req.query.result,
    from: req.query.from,
    to: req.query.to,
    includeTest: req.query.includeTest === 'true',
  });
  await audit.record({ actor: req.user, req, action: 'scans.export', detail: { rows: items.length } });
  sendCsv(res, `scans-${new Date().toISOString().slice(0, 10)}.csv`, analytics.toCsv(items));
});

// ===========================================================================
// Alerts
// ===========================================================================

router.get('/alerts', requirePermission('alerts:read'), async (req, res) => {
  res.json(
    await alertService.list({
      ...listQuery(req),
      status: req.query.status,
      severity: req.query.severity,
      type: req.query.type,
      batchId: req.query.batchId,
    })
  );
});

router.get('/alerts/counts', requirePermission('alerts:read'), async (req, res) => {
  res.json(await alertService.counts());
});

router.get('/alerts/:id', requirePermission('alerts:read'), async (req, res) => {
  const alert = await alertService.getById(Number(req.params.id));
  if (!alert) throw notFound('Alert not found');
  res.json(alert);
});

router.patch('/alerts/:id', requirePermission('alerts:write'), async (req, res) => {
  const data = validate(req.body, {
    status: { type: 'enum', values: ['open', 'investigating', 'resolved', 'dismissed'] },
    assignedTo: { type: 'int', min: 1 },
    note: { type: 'string', max: 2000 },
  });

  // Closing an alert must say why: that note is the investigation record.
  if ((data.status === 'resolved' || data.status === 'dismissed') && !data.note) {
    throw badRequest('Please add a note explaining how this alert was resolved.');
  }

  const updated = await alertService.updateStatus(Number(req.params.id), { ...data, actor: req.user });
  if (!updated) throw notFound('Alert not found');

  await audit.record({ actor: req.user, req, action: `alert.${data.status ?? 'update'}`, entityType: 'alert', entityId: req.params.id, detail: data });
  res.json(updated);
});

// ===========================================================================
// Consumer reports
// ===========================================================================

router.get('/reports', requirePermission('reports:read'), async (req, res) => {
  const { limit, offset, ...meta } = db.paginate(listQuery(req));
  const where = [];
  const params = [];
  if (req.query.status) { where.push('r.status = ?'); params.push(req.query.status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = await db.scalar(`SELECT COUNT(*) FROM consumer_reports r ${clause}`, params);
  const items = await db.all(
    `SELECT r.*, c.code AS registry_code, b.batch_number, p.name AS product_name
       FROM consumer_reports r
       LEFT JOIN codes c ON c.id = r.code_id
       LEFT JOIN batches b ON b.id = c.batch_id
       LEFT JOIN products p ON p.id = b.product_id
       ${clause} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  res.json({ items, total, ...meta });
});

router.patch('/reports/:id', requirePermission('reports:write'), async (req, res) => {
  const { status } = validate(req.body, {
    status: { type: 'enum', required: true, values: ['new', 'reviewing', 'closed'] },
  });
  const report = await db.get('SELECT * FROM consumer_reports WHERE id = ?', [req.params.id]);
  if (!report) throw notFound('Report not found');

  await db.run('UPDATE consumer_reports SET status = ? WHERE id = ?', [status, report.id]);
  await audit.record({ actor: req.user, req, action: 'report.update', entityType: 'report', entityId: report.id, detail: { status } });
  res.json(await db.get('SELECT * FROM consumer_reports WHERE id = ?', [report.id]));
});

// ===========================================================================
// Shipments (distribution leg)
// ===========================================================================

router.get('/shipments', requirePermission('batches:read'), async (req, res) => {
  const { limit, offset, ...meta } = db.paginate(listQuery(req));
  const total = await db.scalar('SELECT COUNT(*) FROM shipments');
  const items = await db.all(
    `SELECT s.*, b.batch_number, p.name AS product_name
       FROM shipments s JOIN batches b ON b.id = s.batch_id JOIN products p ON p.id = b.product_id
      ORDER BY s.shipped_at DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  res.json({ items, total, ...meta });
});

router.post('/shipments', requirePermission('batches:write'), async (req, res) => {
  const data = validate(req.body, {
    batchId: { type: 'int', required: true, min: 1 },
    reference: { type: 'string', required: true, max: 40 },
    quantity: { type: 'int', required: true, min: 1 },
    fromSite: { type: 'string', required: true, max: 120 },
    toName: { type: 'string', required: true, max: 160 },
    toType: { type: 'enum', values: ['distributor', 'pharmacy', 'hospital'], default: 'pharmacy' },
    toRegion: { type: 'string', max: 120 },
  });

  const batch = await db.get('SELECT * FROM batches WHERE id = ?', [data.batchId]);
  if (!batch) throw badRequest('That batch does not exist.');
  if (!['released', 'distributed'].includes(batch.status)) {
    throw conflict(`Batch ${batch.batch_number} is "${batch.status}" and cannot be shipped until it is released.`);
  }

  const { lastInsertRowid } = await db.run(
    `INSERT INTO shipments (reference, batch_id, quantity, from_site, to_name, to_type, to_region)
     VALUES (?,?,?,?,?,?,?)`,
    [data.reference, data.batchId, data.quantity, data.fromSite, data.toName, data.toType, data.toRegion ?? null]
  );

  await audit.record({ actor: req.user, req, action: 'shipment.create', entityType: 'shipment', entityId: lastInsertRowid, detail: data });
  res.status(201).json(await db.get('SELECT * FROM shipments WHERE id = ?', [lastInsertRowid]));
});

router.patch('/shipments/:id/receive', requirePermission('batches:write'), async (req, res) => {
  const shipment = await db.get('SELECT * FROM shipments WHERE id = ?', [req.params.id]);
  if (!shipment) throw notFound('Shipment not found');

  await db.run(
    `UPDATE shipments SET status = 'received', received_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [shipment.id]
  );
  await audit.record({ actor: req.user, req, action: 'shipment.receive', entityType: 'shipment', entityId: shipment.id });
  res.json(await db.get('SELECT * FROM shipments WHERE id = ?', [shipment.id]));
});

// ===========================================================================
// Users (admin only)
// ===========================================================================

router.get('/users', requirePermission('users:read'), async (req, res) => {
  const items = await authService.listUsers();
  res.json({ items, total: items.length });
});

router.post('/users', requirePermission('users:write'), async (req, res) => {
  const data = validate(req.body, {
    email: { type: 'email', required: true },
    fullName: { type: 'string', required: true, max: 120 },
    role: { type: 'enum', required: true, values: ['admin', 'security', 'regulator'] },
    password: { type: 'string', required: true, max: 200 },
  });
  res.status(201).json(await authService.createUser(data, { actor: req.user, req }));
});

router.patch('/users/:id', requirePermission('users:write'), async (req, res) => {
  const data = validate(req.body, {
    fullName: { type: 'string', max: 120 },
    role: { type: 'enum', values: ['admin', 'security', 'regulator'] },
    status: { type: 'enum', values: ['active', 'suspended'] },
  });
  res.json(await authService.updateUser(Number(req.params.id), data, { actor: req.user, req }));
});

router.post('/users/:id/reset-password', requirePermission('users:write'), async (req, res) => {
  // The temporary password is returned exactly once and is never stored in
  // plaintext; it must be handed over out of band.
  res.json(await authService.resetPassword(Number(req.params.id), { actor: req.user, req }));
});

// ===========================================================================
// Audit log
// ===========================================================================

router.get('/audit', requirePermission('audit:read'), async (req, res) => {
  res.json(
    await audit.list({
      ...listQuery(req),
      action: req.query.action,
      actorId: req.query.actorId,
      entityType: req.query.entityType,
      from: req.query.from,
      to: req.query.to,
    })
  );
});

// ===========================================================================
// Compliance reporting (the regulator's surface)
// ===========================================================================

router.get('/compliance', requirePermission('batches:read'), async (req, res) => {
  res.json(await analytics.complianceReport({ from: req.query.from, to: req.query.to }));
});

router.get('/compliance.csv', requirePermission('batches:read'), async (req, res) => {
  const report = await analytics.complianceReport({ from: req.query.from, to: req.query.to });
  await audit.record({ actor: req.user, req, action: 'compliance.export', detail: report.period });
  sendCsv(res, `compliance-${report.period.from}-to-${report.period.to}.csv`, analytics.toCsv(report.batches));
});

// ===========================================================================
// Settings
// ===========================================================================

router.get('/settings', requirePermission('dashboard:view'), async (req, res) => {
  res.json({
    items: await db.all('SELECT * FROM settings ORDER BY key'),
    runtime: {
      environment: config.env,
      publicBaseUrl: config.publicBaseUrl,
      smsProvider: config.sms.provider,
      rateLimits: config.rateLimit,
      sessionTtlHours: config.session.ttlHours,
    },
  });
});

router.patch('/settings/:key', requirePermission('settings:write'), async (req, res) => {
  const { value } = validate(req.body, { value: { type: 'string', required: true, max: 500 } });
  await db.run(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [req.params.key, value, req.user.id]
  );
  await audit.record({ actor: req.user, req, action: 'settings.update', entityType: 'setting', entityId: req.params.key, detail: { value } });
  res.json(await db.get('SELECT * FROM settings WHERE key = ?', [req.params.key]));
});

// ===========================================================================
// Leaflet QR codes
//
// One per medicine, pointing at that product's patient information. Not to be
// confused with the pack codes: these are unsigned links for a shelf talker or
// a carton, and they make no claim that any particular pack is genuine.
// ===========================================================================

/** Every product with its leaflet and the URL its QR carries. */
router.get('/leaflet-codes', requirePermission('products:read'), async (req, res) => {
  const lang = String(req.query.lang ?? 'en');
  const items = await leaflets.listLeafletCodes({ lang });
  res.json({
    items,
    total: items.length,
    // Surfaced so the screen can say how many QRs would lead nowhere.
    missing: items.filter((i) => !i.hasLeaflet).length,
    lang,
    warning: config.publicBaseUrlIsLocal ? LOCAL_BASE_URL_WARNING : undefined,
  });
});

/** One product's leaflet QR as an SVG, for download or for the screen. */
router.get('/leaflet-codes/:sku.svg', requirePermission('products:read'), async (req, res) => {
  const svg = await leaflets.leafletQrSvg(req.params.sku, {
    lang: String(req.query.lang ?? 'en'),
    width: Math.min(Math.max(Number(req.query.width) || 240, 80), 1024),
  });

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  // Regenerated from the URL every time, so it can be cached briefly without
  // risk of serving a QR for a leaflet that has since been replaced - the URL
  // does not change when a new leaflet version is published.
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="leaflet-${req.params.sku}.svg"`);
  }
  res.send(svg);
});

/** Print sheet data: every product that has a leaflet, with its QR. */
router.get('/leaflet-codes/sheet', requirePermission('products:read'), async (req, res) => {
  const items = await leaflets.leafletSheet({ lang: String(req.query.lang ?? 'en') });
  res.json({
    items,
    total: items.length,
    warning: config.publicBaseUrlIsLocal ? LOCAL_BASE_URL_WARNING : undefined,
  });
});

// ===========================================================================
// Spreadsheets
//
// Export is a read of whatever the matching list endpoint would return, so a
// download and the screen it came from can never disagree. Import is the
// reverse, and deliberately narrower: only products and batches, because a
// code is minted and signed by this system and must never arrive from a file.
// ===========================================================================

/** The sheet each export offers, and the query that fills it. */
const EXPORTS = {
  products: {
    permission: 'products:read',
    columns: [
      { header: 'SKU', key: 'sku' },
      { header: 'Name', key: 'name', width: 30 },
      { header: 'Generic name', key: 'generic_name', width: 26 },
      { header: 'Strength', key: 'strength' },
      { header: 'Dosage form', key: 'dosage_form' },
      { header: 'Pack size', key: 'pack_size' },
      { header: 'Manufacturer', key: 'manufacturer', width: 26 },
      { header: 'Category', key: 'category' },
      { header: 'Status', key: 'status' },
      { header: 'Batches', key: 'batch_count' },
      { header: 'Codes', key: 'code_count' },
    ],
    // The same shape the /products list returns, so an export and the screen
    // it came from can never disagree.
    load: () =>
      db.all(
        `SELECT p.*,
                (SELECT COUNT(*) FROM batches b WHERE b.product_id = p.id) AS batch_count,
                (SELECT COUNT(*) FROM codes c WHERE c.product_id = p.id)   AS code_count
           FROM products p ORDER BY p.name`
      ),
  },
  batches: {
    permission: 'batches:read',
    columns: [
      { header: 'Batch number', key: 'batch_number', width: 22 },
      { header: 'Product SKU', key: 'sku' },
      { header: 'Product', key: 'product_name', width: 28 },
      { header: 'Manufacturing date', key: 'mfg_date' },
      { header: 'Expiry date', key: 'expiry_date' },
      { header: 'Quantity', key: 'quantity' },
      { header: 'Status', key: 'status' },
      { header: 'Test batch', key: 'is_test' },
      { header: 'Codes issued', key: 'codes_issued' },
      { header: 'Notes', key: 'notes', width: 40 },
    ],
    load: () =>
      db.all(
        `SELECT b.*, p.name AS product_name, p.sku,
                (SELECT COUNT(*) FROM codes c WHERE c.batch_id = b.id) AS codes_issued
           FROM batches b JOIN products p ON p.id = b.product_id
          ORDER BY b.created_at DESC`
      ),
  },
};

/** Download a list as a workbook. */
router.get('/export/:entity.xlsx', async (req, res) => {
  const spec = EXPORTS[req.params.entity];
  if (!spec) throw notFound('There is no export for that.');
  // Checked here rather than with requirePermission, because which permission
  // applies depends on the entity in the path.
  if (!authService.can(req.user.role, spec.permission)) {
    throw forbidden(`Your role (${req.user.role}) cannot export that.`);
  }

  const rows = await spec.load();
  // A checkbox reads better than 1/0 in a spreadsheet somebody will scan.
  const items = rows.map((r) => ({ ...r, is_test: r.is_test ? 'yes' : '' }));

  const buffer = await buildWorkbook([
    { name: req.params.entity, columns: spec.columns, rows: items },
  ]);

  await audit.record({
    actor: req.user,
    req,
    action: `${req.params.entity}.export`,
    detail: { rows: items.length, format: 'xlsx' },
  });

  const today = new Date().toISOString().slice(0, 10);
  sendWorkbook(res, `${req.params.entity}-${today}.xlsx`, buffer);
});

/**
 * The import template: the accepted headings, with one worked example row per
 * sheet so the expected date and quantity formats are visible rather than
 * described.
 */
router.get('/import/template.xlsx', requirePermission('products:read'), async (req, res) => {
  const example = {
    products: {
      sku: 'AMX25',
      name: 'Amoxicillin 250 mg',
      'generic name': 'Amoxicillin trihydrate',
      strength: '250 mg',
      'dosage form': 'Capsule',
      'pack size': '21 capsules',
      manufacturer: 'Northbridge Pharmaceuticals',
      category: 'Antibiotic',
    },
    batches: {
      'product sku': 'AMX25',
      'batch number': 'AMX25-2609A',
      'manufacturing date': '2026-09-01',
      'expiry date': '2028-09-01',
      quantity: 1200,
      'test batch': 'no',
      notes: 'Delete this example row before importing',
    },
  };

  const buffer = await buildWorkbook([
    {
      name: 'products',
      columns: importer.TEMPLATE_COLUMNS.products.map((c) => ({ header: c.header, key: c.header })),
      rows: [example.products],
      note: 'SKU and Name and Manufacturer are required. A SKU that already exists updates that product.',
    },
    {
      name: 'batches',
      columns: importer.TEMPLATE_COLUMNS.batches.map((c) => ({ header: c.header, key: c.header })),
      rows: [example.batches],
      note: 'Dates as YYYY-MM-DD. The product SKU must already exist. Batch numbers are never reused.',
    },
  ]);

  sendWorkbook(res, 'orbit-import-template.xlsx', buffer);
});

/**
 * Import products or batches from an uploaded workbook.
 *
 * The body is the file itself rather than a multipart form: one file, no other
 * fields, and it saves carrying a multipart parser for a single endpoint.
 *
 * `?dryRun=1` validates and reports without writing, which is what the
 * dashboard calls first so somebody can see what a file will do before it
 * does it.
 */
router.post('/import/:entity', async (req, res) => {
  const entity = req.params.entity;
  const handlers = {
    products: { permission: 'products:write', run: importer.importProducts },
    batches: { permission: 'batches:write', run: importer.importBatches },
  };
  const handler = handlers[entity];
  if (!handler) throw notFound('Only products and batches can be imported.');
  if (!authService.can(req.user.role, handler.permission)) {
    throw forbidden(`Your role (${req.user.role}) cannot import that.`);
  }

  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    throw badRequest('No file was received. Attach a .xlsx or .csv file.');
  }

  let sheet;
  try {
    sheet = await readSheet(req.body, { sheetName: entity });
  } catch {
    throw badRequest('That file could not be read as a spreadsheet. Save it as .xlsx or .csv and try again.');
  }

  if (!sheet.rows.length) {
    throw badRequest('That sheet has no rows below the heading row.');
  }

  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const result = await handler.run(sheet.rows, { actor: req.user, req, dryRun });

  res.json({ entity, dryRun, ...result });
});

export default router;
