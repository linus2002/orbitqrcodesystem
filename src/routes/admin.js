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
import { config } from '../config.js';
import * as analytics from '../services/analytics.js';
import * as alertService from '../services/alerts.js';
import * as serialization from '../services/serialization.js';
import * as authService from '../services/auth.js';
import * as audit from '../services/audit.js';
import { validate } from '../lib/validate.js';
import { normalizeCode, qrPayload } from '../lib/codes.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
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

router.get('/overview', requirePermission('dashboard:view'), (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  res.json({
    overview: analytics.overview({ days }),
    trend: analytics.scanTrend({ days: Math.min(days, 30) }),
    topBatches: analytics.topFlaggedBatches({ days }),
    geo: analytics.geoBreakdown({ days }),
  });
});

router.get('/trend', requirePermission('dashboard:view'), (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
  res.json({ items: analytics.scanTrend({ days }) });
});

// ===========================================================================
// Products
// ===========================================================================

router.get('/products', requirePermission('products:read'), (req, res) => {
  const items = db.all(
    `SELECT p.*,
            (SELECT COUNT(*) FROM batches b WHERE b.product_id = p.id) AS batch_count,
            (SELECT COUNT(*) FROM codes c WHERE c.product_id = p.id)   AS code_count
       FROM products p ORDER BY p.name`
  );
  res.json({ items, total: items.length });
});

router.post('/products', requirePermission('products:write'), (req, res) => {
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
  if (db.get('SELECT id FROM products WHERE sku = ?', [sku])) {
    throw conflict(`A product with SKU ${sku} already exists.`);
  }

  const { lastInsertRowid } = db.run(
    `INSERT INTO products (sku, name, generic_name, strength, dosage_form, pack_size, manufacturer, category)
     VALUES (?,?,?,?,?,?,?,?)`,
    [sku, data.name, data.genericName ?? null, data.strength ?? null, data.dosageForm ?? null,
     data.packSize ?? null, data.manufacturer, data.category ?? null]
  );

  audit.record({ actor: req.user, req, action: 'product.create', entityType: 'product', entityId: lastInsertRowid, detail: { sku } });
  res.status(201).json(db.get('SELECT * FROM products WHERE id = ?', [lastInsertRowid]));
});

router.get('/products/:id', requirePermission('products:read'), (req, res) => {
  const product = db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) throw notFound('Product not found');
  res.json({
    ...product,
    leaflets: db.all(
      'SELECT id, version, language, effective_from FROM leaflets WHERE product_id = ? ORDER BY effective_from DESC',
      [product.id]
    ),
    batches: db.all(
      'SELECT id, batch_number, status, mfg_date, expiry_date, quantity, is_test FROM batches WHERE product_id = ? ORDER BY created_at DESC',
      [product.id]
    ),
  });
});

router.patch('/products/:id', requirePermission('products:write'), (req, res) => {
  const product = db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
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
  db.run(
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

  audit.record({ actor: req.user, req, action: 'product.update', entityType: 'product', entityId: product.id, detail: data });
  res.json(db.get('SELECT * FROM products WHERE id = ?', [product.id]));
});

/** Publish a new leaflet version for a product. */
router.post('/products/:id/leaflets', requirePermission('products:write'), (req, res) => {
  const product = db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) throw notFound('Product not found');

  const data = validate(req.body, {
    version: { type: 'string', required: true, max: 20 },
    language: { type: 'string', max: 8, default: 'en' },
    sections: { type: 'array', required: true, max: 40 },
  });

  for (const s of data.sections) {
    if (!s?.heading || !s?.body) throw badRequest('Every leaflet section needs a heading and a body.');
  }

  const { lastInsertRowid } = db.run(
    `INSERT INTO leaflets (product_id, version, language, sections_json) VALUES (?,?,?,?)`,
    [product.id, data.version, data.language, JSON.stringify(data.sections)]
  );

  audit.record({ actor: req.user, req, action: 'leaflet.publish', entityType: 'leaflet', entityId: lastInsertRowid, detail: { sku: product.sku, version: data.version } });
  res.status(201).json(db.get('SELECT * FROM leaflets WHERE id = ?', [lastInsertRowid]));
});

// ===========================================================================
// Batches
// ===========================================================================

router.get('/batches', requirePermission('batches:read'), (req, res) => {
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
  const total = db.scalar(`SELECT COUNT(*) FROM batches b JOIN products p ON p.id = b.product_id ${clause}`, params);
  const items = db.all(
    `SELECT b.*, p.name AS product_name, p.sku,
            (SELECT COUNT(*) FROM codes c WHERE c.batch_id = b.id) AS codes_issued,
            (SELECT COUNT(*) FROM scans s WHERE s.batch_id = b.id AND s.result = 'flagged') AS flagged_scans
       FROM batches b JOIN products p ON p.id = b.product_id
       ${clause} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  res.json({ items, total, ...meta });
});

router.post('/batches', requirePermission('batches:write'), (req, res) => {
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

  const product = db.get('SELECT * FROM products WHERE id = ?', [data.productId]);
  if (!product) throw badRequest('That product does not exist.');
  if (new Date(data.expiryDate) <= new Date(data.mfgDate)) {
    throw badRequest('The expiry date must be after the manufacturing date.');
  }
  if (db.get('SELECT id FROM batches WHERE batch_number = ?', [data.batchNumber])) {
    throw conflict(`Batch ${data.batchNumber} already exists.`);
  }

  // Default to the product's newest leaflet, so a batch always has one.
  const leafletId =
    data.leafletId ??
    db.get('SELECT id FROM leaflets WHERE product_id = ? ORDER BY effective_from DESC LIMIT 1', [product.id])?.id ??
    null;

  const { lastInsertRowid } = db.run(
    `INSERT INTO batches (batch_number, product_id, mfg_date, expiry_date, quantity, is_test, leaflet_id, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [data.batchNumber, product.id, data.mfgDate, data.expiryDate, data.quantity,
     data.isTest ? 1 : 0, leafletId, data.notes ?? null, req.user.id]
  );

  audit.record({ actor: req.user, req, action: 'batch.create', entityType: 'batch', entityId: lastInsertRowid, detail: { batchNumber: data.batchNumber, quantity: data.quantity, isTest: data.isTest } });
  res.status(201).json(db.get('SELECT * FROM batches WHERE id = ?', [lastInsertRowid]));
});

router.get('/batches/:id', requirePermission('batches:read'), (req, res) => {
  const batch = db.get(
    `SELECT b.*, p.name AS product_name, p.sku, p.strength, p.manufacturer
       FROM batches b JOIN products p ON p.id = b.product_id WHERE b.id = ?`,
    [req.params.id]
  );
  if (!batch) throw notFound('Batch not found');

  res.json({
    ...batch,
    stats: serialization.batchStats(batch.id),
    shipments: db.all('SELECT * FROM shipments WHERE batch_id = ? ORDER BY shipped_at DESC', [batch.id]),
    openAlerts: db.scalar(
      `SELECT COUNT(*) FROM alerts WHERE batch_id = ? AND status IN ('open','investigating')`,
      [batch.id]
    ),
  });
});

/** Run the serialization engine for a batch. */
router.post('/batches/:id/issue-codes', requirePermission('batches:write'), (req, res) => {
  res.status(201).json(serialization.issueCodes(Number(req.params.id), { actor: req.user, req }));
});

/** Move a batch through its lifecycle. */
router.post('/batches/:id/transition', requirePermission('batches:write'), (req, res) => {
  const { to, reason } = validate(req.body, {
    to: { type: 'enum', required: true, values: ['printed', 'released', 'distributed', 'recalled', 'closed'] },
    reason: { type: 'string', max: 500 },
  });
  res.json(serialization.transition(Number(req.params.id), to, { actor: req.user, req, reason: reason ?? null }));
});

router.get('/batches/:id/codes', requirePermission('codes:read'), (req, res) => {
  res.json(
    serialization.listCodes(Number(req.params.id), {
      ...listQuery(req),
      status: req.query.status,
      search: req.query.search,
    })
  );
});

/** CSV hand-off for the packaging line's printer. */
router.get('/batches/:id/codes.csv', requirePermission('codes:export'), (req, res) => {
  const { filename, csv } = serialization.exportCsv(Number(req.params.id));
  audit.record({ actor: req.user, req, action: 'codes.export', entityType: 'batch', entityId: req.params.id });
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
  const batch = db.get(
    `SELECT b.*, p.name AS product_name, p.sku, p.strength
       FROM batches b JOIN products p ON p.id = b.product_id WHERE b.id = ?`,
    [req.params.id]
  );
  if (!batch) throw notFound('Batch not found');

  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 60);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const codes = db.all(
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
    total: db.scalar('SELECT COUNT(*) FROM codes WHERE batch_id = ?', [batch.id]),
  });
});

// ===========================================================================
// Codes
// ===========================================================================

/** Look up one code and its full scan history - the investigation view. */
router.get('/codes/lookup', requirePermission('codes:read'), (req, res) => {
  const code = normalizeCode(String(req.query.code ?? ''));
  if (!code) throw badRequest('Provide a code to look up.');

  const row = db.get(
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
    scans: db.all(
      `SELECT id, result, reason, channel, scan_number, country, region, city, signature_state, created_at
         FROM scans WHERE code_id = ? ORDER BY created_at DESC LIMIT 100`,
      [row.id]
    ),
    alerts: db.all('SELECT id, type, severity, status, title, created_at FROM alerts WHERE code_id = ?', [row.id]),
  });
});

/** Withdraw a single code (e.g. a unit destroyed or known stolen). */
router.post('/codes/:id/void', requirePermission('batches:write'), (req, res) => {
  const { reason } = validate(req.body, { reason: { type: 'string', required: true, min: 5, max: 300 } });
  const code = db.get('SELECT * FROM codes WHERE id = ?', [req.params.id]);
  if (!code) throw notFound('Code not found');

  db.run(`UPDATE codes SET status = 'void' WHERE id = ?`, [code.id]);
  audit.record({ actor: req.user, req, action: 'code.void', entityType: 'code', entityId: code.id, detail: { code: code.code, reason } });
  res.json({ ok: true, code: db.get('SELECT * FROM codes WHERE id = ?', [code.id]) });
});

/** QR image for a single code, as SVG. */
router.get('/codes/:id/qr.svg', requirePermission('codes:read'), async (req, res) => {
  const code = db.get('SELECT code FROM codes WHERE id = ?', [req.params.id]);
  if (!code) throw notFound('Code not found');
  res.type('image/svg+xml').send(await serialization.qrSvg(code.code));
});

// ===========================================================================
// Scans - security team only (a regulator has no 'scans:read')
// ===========================================================================

router.get('/scans', requirePermission('scans:read'), (req, res) => {
  res.json(
    analytics.listScans({
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

router.get('/scans.csv', requirePermission('scans:read'), (req, res) => {
  const { items } = analytics.listScans({
    page: 1,
    pageSize: 5000,
    result: req.query.result,
    from: req.query.from,
    to: req.query.to,
    includeTest: req.query.includeTest === 'true',
  });
  audit.record({ actor: req.user, req, action: 'scans.export', detail: { rows: items.length } });
  sendCsv(res, `scans-${new Date().toISOString().slice(0, 10)}.csv`, analytics.toCsv(items));
});

// ===========================================================================
// Alerts
// ===========================================================================

router.get('/alerts', requirePermission('alerts:read'), (req, res) => {
  res.json(
    alertService.list({
      ...listQuery(req),
      status: req.query.status,
      severity: req.query.severity,
      type: req.query.type,
      batchId: req.query.batchId,
    })
  );
});

router.get('/alerts/counts', requirePermission('alerts:read'), (req, res) => {
  res.json(alertService.counts());
});

router.get('/alerts/:id', requirePermission('alerts:read'), (req, res) => {
  const alert = alertService.getById(Number(req.params.id));
  if (!alert) throw notFound('Alert not found');
  res.json(alert);
});

router.patch('/alerts/:id', requirePermission('alerts:write'), (req, res) => {
  const data = validate(req.body, {
    status: { type: 'enum', values: ['open', 'investigating', 'resolved', 'dismissed'] },
    assignedTo: { type: 'int', min: 1 },
    note: { type: 'string', max: 2000 },
  });

  // Closing an alert must say why: that note is the investigation record.
  if ((data.status === 'resolved' || data.status === 'dismissed') && !data.note) {
    throw badRequest('Please add a note explaining how this alert was resolved.');
  }

  const updated = alertService.updateStatus(Number(req.params.id), { ...data, actor: req.user });
  if (!updated) throw notFound('Alert not found');

  audit.record({ actor: req.user, req, action: `alert.${data.status ?? 'update'}`, entityType: 'alert', entityId: req.params.id, detail: data });
  res.json(updated);
});

// ===========================================================================
// Consumer reports
// ===========================================================================

router.get('/reports', requirePermission('reports:read'), (req, res) => {
  const { limit, offset, ...meta } = db.paginate(listQuery(req));
  const where = [];
  const params = [];
  if (req.query.status) { where.push('r.status = ?'); params.push(req.query.status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.scalar(`SELECT COUNT(*) FROM consumer_reports r ${clause}`, params);
  const items = db.all(
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

router.patch('/reports/:id', requirePermission('reports:write'), (req, res) => {
  const { status } = validate(req.body, {
    status: { type: 'enum', required: true, values: ['new', 'reviewing', 'closed'] },
  });
  const report = db.get('SELECT * FROM consumer_reports WHERE id = ?', [req.params.id]);
  if (!report) throw notFound('Report not found');

  db.run('UPDATE consumer_reports SET status = ? WHERE id = ?', [status, report.id]);
  audit.record({ actor: req.user, req, action: 'report.update', entityType: 'report', entityId: report.id, detail: { status } });
  res.json(db.get('SELECT * FROM consumer_reports WHERE id = ?', [report.id]));
});

// ===========================================================================
// Shipments (distribution leg)
// ===========================================================================

router.get('/shipments', requirePermission('batches:read'), (req, res) => {
  const { limit, offset, ...meta } = db.paginate(listQuery(req));
  const total = db.scalar('SELECT COUNT(*) FROM shipments');
  const items = db.all(
    `SELECT s.*, b.batch_number, p.name AS product_name
       FROM shipments s JOIN batches b ON b.id = s.batch_id JOIN products p ON p.id = b.product_id
      ORDER BY s.shipped_at DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  res.json({ items, total, ...meta });
});

router.post('/shipments', requirePermission('batches:write'), (req, res) => {
  const data = validate(req.body, {
    batchId: { type: 'int', required: true, min: 1 },
    reference: { type: 'string', required: true, max: 40 },
    quantity: { type: 'int', required: true, min: 1 },
    fromSite: { type: 'string', required: true, max: 120 },
    toName: { type: 'string', required: true, max: 160 },
    toType: { type: 'enum', values: ['distributor', 'pharmacy', 'hospital'], default: 'pharmacy' },
    toRegion: { type: 'string', max: 120 },
  });

  const batch = db.get('SELECT * FROM batches WHERE id = ?', [data.batchId]);
  if (!batch) throw badRequest('That batch does not exist.');
  if (!['released', 'distributed'].includes(batch.status)) {
    throw conflict(`Batch ${batch.batch_number} is "${batch.status}" and cannot be shipped until it is released.`);
  }

  const { lastInsertRowid } = db.run(
    `INSERT INTO shipments (reference, batch_id, quantity, from_site, to_name, to_type, to_region)
     VALUES (?,?,?,?,?,?,?)`,
    [data.reference, data.batchId, data.quantity, data.fromSite, data.toName, data.toType, data.toRegion ?? null]
  );

  audit.record({ actor: req.user, req, action: 'shipment.create', entityType: 'shipment', entityId: lastInsertRowid, detail: data });
  res.status(201).json(db.get('SELECT * FROM shipments WHERE id = ?', [lastInsertRowid]));
});

router.patch('/shipments/:id/receive', requirePermission('batches:write'), (req, res) => {
  const shipment = db.get('SELECT * FROM shipments WHERE id = ?', [req.params.id]);
  if (!shipment) throw notFound('Shipment not found');

  db.run(
    `UPDATE shipments SET status = 'received', received_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [shipment.id]
  );
  audit.record({ actor: req.user, req, action: 'shipment.receive', entityType: 'shipment', entityId: shipment.id });
  res.json(db.get('SELECT * FROM shipments WHERE id = ?', [shipment.id]));
});

// ===========================================================================
// Users (admin only)
// ===========================================================================

router.get('/users', requirePermission('users:read'), (req, res) => {
  const items = authService.listUsers();
  res.json({ items, total: items.length });
});

router.post('/users', requirePermission('users:write'), (req, res) => {
  const data = validate(req.body, {
    email: { type: 'email', required: true },
    fullName: { type: 'string', required: true, max: 120 },
    role: { type: 'enum', required: true, values: ['admin', 'security', 'regulator'] },
    password: { type: 'string', required: true, max: 200 },
  });
  res.status(201).json(authService.createUser(data, { actor: req.user, req }));
});

router.patch('/users/:id', requirePermission('users:write'), (req, res) => {
  const data = validate(req.body, {
    fullName: { type: 'string', max: 120 },
    role: { type: 'enum', values: ['admin', 'security', 'regulator'] },
    status: { type: 'enum', values: ['active', 'suspended'] },
  });
  res.json(authService.updateUser(Number(req.params.id), data, { actor: req.user, req }));
});

router.post('/users/:id/reset-password', requirePermission('users:write'), (req, res) => {
  // The temporary password is returned exactly once and is never stored in
  // plaintext; it must be handed over out of band.
  res.json(authService.resetPassword(Number(req.params.id), { actor: req.user, req }));
});

// ===========================================================================
// Audit log
// ===========================================================================

router.get('/audit', requirePermission('audit:read'), (req, res) => {
  res.json(
    audit.list({
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

router.get('/compliance', requirePermission('batches:read'), (req, res) => {
  res.json(analytics.complianceReport({ from: req.query.from, to: req.query.to }));
});

router.get('/compliance.csv', requirePermission('batches:read'), (req, res) => {
  const report = analytics.complianceReport({ from: req.query.from, to: req.query.to });
  audit.record({ actor: req.user, req, action: 'compliance.export', detail: report.period });
  sendCsv(res, `compliance-${report.period.from}-to-${report.period.to}.csv`, analytics.toCsv(report.batches));
});

// ===========================================================================
// Settings
// ===========================================================================

router.get('/settings', requirePermission('dashboard:view'), (req, res) => {
  res.json({
    items: db.all('SELECT * FROM settings ORDER BY key'),
    runtime: {
      environment: config.env,
      publicBaseUrl: config.publicBaseUrl,
      smsProvider: config.sms.provider,
      rateLimits: config.rateLimit,
      sessionTtlHours: config.session.ttlHours,
    },
  });
});

router.patch('/settings/:key', requirePermission('settings:write'), (req, res) => {
  const { value } = validate(req.body, { value: { type: 'string', required: true, max: 500 } });
  db.run(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [req.params.key, value, req.user.id]
  );
  audit.record({ actor: req.user, req, action: 'settings.update', entityType: 'setting', entityId: req.params.key, detail: { value } });
  res.json(db.get('SELECT * FROM settings WHERE key = ?', [req.params.key]));
});

export default router;
