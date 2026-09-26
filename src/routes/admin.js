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
import * as settingsService from '../services/settings.js';
import * as verifierService from '../services/verifiers.js';
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

/** Every product with its batch and code counts - the list and its export. */
const productsWithCounts = () =>
  db.findMany('product', {}, {
    order: 'name asc',
    extra: {
      batch_count: 'count(*[_type == "batch" && product_id == ^.id])',
      code_count: 'count(*[_type == "code" && product_id == ^.id])',
    },
  });

router.get('/products', requirePermission('products:read'), async (req, res) => {
  const items = await productsWithCounts();
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
  if (await db.findOne('product', { sku }, { fields: ['id'] })) {
    throw conflict(`A product with SKU ${sku} already exists.`);
  }

  const product = await db.insert('product', {
    sku,
    name: data.name,
    generic_name: data.genericName ?? null,
    strength: data.strength ?? null,
    dosage_form: data.dosageForm ?? null,
    pack_size: data.packSize ?? null,
    manufacturer: data.manufacturer,
    category: data.category ?? null,
  });

  await audit.record({ actor: req.user, req, action: 'product.create', entityType: 'product', entityId: product.id, detail: { sku } });
  res.status(201).json(product);
});

router.get('/products/:id', requirePermission('products:read'), async (req, res) => {
  const product = await db.get('product', req.params.id);
  if (!product) throw notFound('Product not found');
  res.json({
    ...product,
    leaflets: await db.findMany('leaflet', { product_id: product.id }, {
      order: 'effective_from desc',
      fields: ['id', 'version', 'language', 'effective_from'],
    }),
    batches: await db.findMany('batch', { product_id: product.id }, {
      order: 'created_at desc',
      fields: ['id', 'batch_number', 'status', 'mfg_date', 'expiry_date', 'quantity', 'is_test'],
      // How many pack codes exist for the batch: the product screen lists its
      // codes from here, so an admin can find a pack's code without leaving
      // the product.
      extra: { codes_issued: 'count(*[_type == "code" && batch_id == ^.id])' },
    }),
  });
});

router.patch('/products/:id', requirePermission('products:write'), async (req, res) => {
  const product = await db.get('product', req.params.id);
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
  // Only the fields supplied change (the COALESCE of the SQL this replaced).
  await db.update('product', product, {
    name: data.name,
    generic_name: data.genericName,
    strength: data.strength,
    dosage_form: data.dosageForm,
    pack_size: data.packSize,
    manufacturer: data.manufacturer,
    category: data.category,
    status: data.status,
  });

  await audit.record({ actor: req.user, req, action: 'product.update', entityType: 'product', entityId: product.id, detail: data });
  res.json(await db.get('product', product.id));
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
  const product = await db.get('product', req.params.id);
  if (!product) throw notFound('Product not found');

  const data = validate(req.body, {
    version: { type: 'string', required: true, max: 20 },
    language: { type: 'string', max: 8, default: 'en' },
    sections: { type: 'array', max: 40 },
    // Same bounds as a code void: long enough to mean something, short enough
    // to read in the audit log.
    reason: { type: 'string', required: true, min: 5, max: 300 },
    alsoApplyTo: { type: 'array', max: 50 },
  });

  const sections = data.sections ?? [];
  for (const s of sections) {
    if (!s?.heading || !s?.body) throw badRequest('Every leaflet section needs a heading and a body.');
  }

  // The PDF, when one was attached: the id of an upload already sent in
  // pieces (see /leaflet-files below). It is sealed inside the transaction,
  // so a publish that fails leaves the upload pending and reusable.
  const pdfFileId = req.body?.pdf?.fileId ? Number.parseInt(req.body.pdf.fileId, 10) : null;
  if (pdfFileId !== null && !Number.isInteger(pdfFileId)) throw badRequest('pdf.fileId must be a number.');
  if (!sections.length && !pdfFileId) {
    throw badRequest('A leaflet needs a PDF or at least one section.');
  }

  // Every product this document covers: the named one first, no repeats.
  const extraIds = (data.alsoApplyTo ?? []).map((v) => Number.parseInt(v, 10));
  if (extraIds.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw badRequest('alsoApplyTo must be a list of product ids.');
  }
  const ids = [...new Set([product.id, ...extraIds])];

  const products = await db.findMany('product', { id: { in: ids } }, { fields: ['id', 'sku'] });
  if (products.length !== ids.length) {
    throw badRequest('One of the products to publish to does not exist.');
  }
  products.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  /*
   * Checked up front and named, rather than left to the unique key: a key
   * clash would be a bare 409 that says nothing about which strength already
   * had the version, and with several products in one publish that is the
   * first thing the person needs to know.
   */
  const taken = await db.findMany(
    'leaflet',
    { product_id: { in: ids }, version: data.version, language: data.language },
    { fields: ['product_id'], extra: { sku: '*[_type == "product" && id == ^.product_id][0].sku' } }
  );
  if (taken.length) {
    throw conflict(
      `Version ${data.version} (${data.language}) already exists for ` +
        `${taken.map((t) => t.sku).join(', ')}. Use a new version number.`
    );
  }

  // Only the two fields a section has: the body is stored as it is sent.
  const cleaned = sections.map((s) => ({ heading: String(s.heading), body: String(s.body) }));
  let pdf = null;
  const written = await db.tx(async () => {
    // One file, however many strengths the publish covers: they are the same
    // document, and the sharing is what keeps them saying the same thing.
    if (pdfFileId) pdf = await leaflets.finishPdf(pdfFileId);
    const rows = [];
    for (const p of products) {
      const leaflet = await db.insert('leaflet', {
        product_id: p.id,
        version: data.version,
        language: data.language,
        sections: cleaned,
        file_id: pdf?.id ?? null,
      });
      rows.push({ leaflet, coverage: { leafletId: leaflet.id, productId: p.id, sku: p.sku } });
    }
    return rows;
  });
  const coverage = written.map((w) => w.coverage);

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
      detail: {
        sku: c.sku, version: data.version, language: data.language, reason: data.reason, covers,
        pdf: pdf ? { filename: pdf.filename, size: pdf.size, sha256: pdf.sha256 } : null,
      },
    });
  }

  // The named product's row, as before, plus what else was written.
  res.status(201).json({
    ...written[0].leaflet,
    coverage,
    pdf: pdf ? { filename: pdf.filename, size: pdf.size } : null,
  });
});

// ---------------------------------------------------------------------------
// Leaflet PDF upload, in pieces
//
// A file may be 25 MB; a request may not. So the browser announces the file,
// sends it 3 MB at a time in order, and the publish above points at the
// finished upload. Anything announced and never published is dropped after a
// day (services/leaflets.js).
// ---------------------------------------------------------------------------
router.post('/leaflet-files', requirePermission('products:write'), async (req, res) => {
  const { name, size } = validate(req.body, {
    name: { type: 'string', max: 200 },
    size: { type: 'int', required: true, min: 1 },
  });
  res.status(201).json(await leaflets.beginPdf({ name, size }));
});

/** Body: the piece itself, as application/pdf or application/octet-stream. */
router.put('/leaflet-files/:id/chunks/:seq', requirePermission('products:write'), async (req, res) => {
  const seq = Number.parseInt(req.params.seq, 10);
  if (!Number.isInteger(seq) || seq < 0) throw badRequest('The chunk number must be a whole number.');
  if (!Buffer.isBuffer(req.body)) {
    throw badRequest('Send the chunk as the raw request body, as application/pdf.');
  }
  res.json(await leaflets.addPdfChunk(Number.parseInt(req.params.id, 10), seq, req.body));
});

// ===========================================================================
// Batches
// ===========================================================================

/** The product fields and counts shown beside every batch in a list. */
const BATCH_EXTRA = {
  product_name: '*[_type == "product" && id == ^.product_id][0].name',
  sku: '*[_type == "product" && id == ^.product_id][0].sku',
  codes_issued: 'count(*[_type == "code" && batch_id == ^.id])',
};

router.get('/batches', requirePermission('batches:read'), async (req, res) => {
  const { limit, offset, ...meta } = db.paginate(listQuery(req));
  const params = {};
  const where = {
    status: req.query.status || undefined,
    product_id: req.query.productId ? Number(req.query.productId) : undefined,
    is_test: req.query.includeTest !== 'true' ? 0 : undefined,
  };
  if (req.query.search) {
    // The batch number, or its product's name or SKU (a LIKE on the join).
    // Word-prefix matching: GROQ's match works on words, not substrings.
    params.search = `${String(req.query.search).replace(/[*"\\]/g, '')}*`;
    where.$raw =
      'batch_number match $search || product_id in *[_type == "product" && (name match $search || sku match $search)].id';
  }

  const total = await db.count('batch', where, { params });
  const items = await db.findMany('batch', where, {
    order: 'created_at desc',
    limit,
    offset,
    params,
    extra: {
      ...BATCH_EXTRA,
      flagged_scans: 'count(*[_type == "scan" && batch_id == ^.id && result == "flagged"])',
    },
  });
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

  const product = await db.get('product', data.productId);
  if (!product) throw badRequest('That product does not exist.');
  if (new Date(data.expiryDate) <= new Date(data.mfgDate)) {
    throw badRequest('The expiry date must be after the manufacturing date.');
  }
  if (await db.findOne('batch', { batch_number: data.batchNumber }, { fields: ['id'] })) {
    throw conflict(`Batch ${data.batchNumber} already exists.`);
  }

  // Record the product's newest leaflet as the one this batch shipped with.
  // (It was always null: `await db.get(...)?.id` applied `?.id` to the
  // Promise, not the row, because `await` binds looser than `?.`.) Display
  // does not use this - a scan shows the current leaflet - it is the record.
  const leafletId = data.leafletId ?? (await leaflets.currentLeafletId(product.id));

  const batch = await db.insert('batch', {
    batch_number: data.batchNumber,
    product_id: product.id,
    mfg_date: data.mfgDate,
    expiry_date: data.expiryDate,
    quantity: data.quantity,
    is_test: data.isTest ? 1 : 0,
    leaflet_id: leafletId,
    notes: data.notes ?? null,
    created_by: req.user.id,
  });

  await audit.record({ actor: req.user, req, action: 'batch.create', entityType: 'batch', entityId: batch.id, detail: { batchNumber: data.batchNumber, quantity: data.quantity, isTest: data.isTest } });
  res.status(201).json(batch);
});

/** A batch with the product fields its detail and label views show. */
async function batchWithProduct(id) {
  const batch = await db.get('batch', id);
  if (!batch) return undefined;
  const p = await db.get('product', batch.product_id);
  return { ...batch, product_name: p?.name ?? null, sku: p?.sku ?? null, strength: p?.strength ?? null, manufacturer: p?.manufacturer ?? null };
}

router.get('/batches/:id', requirePermission('batches:read'), async (req, res) => {
  const batch = await batchWithProduct(req.params.id);
  if (!batch) throw notFound('Batch not found');

  res.json({
    ...batch,
    stats: await serialization.batchStats(batch.id),
    // Empty while shipments are switched off (services/auth.js), so the field
    // stays for anything that reads it but no shipment shows through here.
    shipments: authService.can(req.user.role, 'shipments:read')
      ? await db.findMany('shipment', { batch_id: batch.id }, { order: 'shipped_at desc' })
      : [],
    openAlerts: await db.count('alert', { batch_id: batch.id, status: { in: ['open', 'investigating'] } }),
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
  const batch = await batchWithProduct(req.params.id);
  if (!batch) throw notFound('Batch not found');

  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 60);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const codes = await db.findMany('code', { batch_id: batch.id }, {
    order: 'unit_index asc',
    limit,
    offset,
    fields: ['id', 'code', 'serial', 'unit_index'],
  });

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
    total: await db.count('code', { batch_id: batch.id }),
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

  const found = await db.getCode(code);
  if (!found) throw notFound('That code is not in the registry.');
  const b = await db.get('batch', found.batch_id);
  const p = await db.get('product', found.product_id);
  const row = {
    ...found,
    batch_number: b?.batch_number ?? null,
    batch_status: b?.status ?? null,
    expiry_date: b?.expiry_date ?? null,
    mfg_date: b?.mfg_date ?? null,
    is_test: b?.is_test ?? 0,
    product_name: p?.name ?? null,
    sku: p?.sku ?? null,
    strength: p?.strength ?? null,
  };

  res.json({
    ...row,
    qrPayload: qrPayload(row.code, config.secrets.code, config.publicBaseUrl),
    scans: await db.findMany('scan', { code_id: row.id }, {
      order: 'created_at desc',
      limit: 100,
      fields: ['id', 'result', 'reason', 'channel', 'scan_number', 'country', 'region', 'city', 'signature_state', 'created_at'],
    }),
    alerts: await db.findMany('alert', { code_id: row.id }, {
      fields: ['id', 'type', 'severity', 'status', 'title', 'created_at'],
    }),
  });
});

/** Withdraw a single code (e.g. a unit destroyed or known stolen). */
router.post('/codes/:id/void', requirePermission('batches:write'), async (req, res) => {
  const { reason } = validate(req.body, { reason: { type: 'string', required: true, min: 5, max: 300 } });
  const code = await db.get('code', req.params.id);
  if (!code) throw notFound('Code not found');

  await db.update('code', code, { status: 'void' });
  await audit.record({ actor: req.user, req, action: 'code.void', entityType: 'code', entityId: code.id, detail: { code: code.code, reason } });
  res.json({ ok: true, code: await db.getCode(code.code) });
});

/** QR image for a single code, as SVG. */
router.get('/codes/:id/qr.svg', requirePermission('codes:read'), async (req, res) => {
  const code = await db.get('code', req.params.id);
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
// Customers - the people who gave their details on the portal
//
// Behind 'scans:read' for the same reason the scan log is: these rows name
// individual patients, and a regulator gets aggregates only.
// ===========================================================================

router.get('/customers', requirePermission('scans:read'), async (req, res) => {
  res.json(
    await verifierService.list({
      ...listQuery(req),
      search: req.query.search,
      role: req.query.role,
      from: req.query.from,
      to: req.query.to,
    })
  );
});

router.get('/customers.csv', requirePermission('scans:read'), async (req, res) => {
  const { items } = await verifierService.list({
    page: 1,
    pageSize: 5000,
    search: req.query.search,
    role: req.query.role,
  });
  await audit.record({ actor: req.user, req, action: 'customers.export', detail: { rows: items.length } });
  sendCsv(
    res,
    `customers-${new Date().toISOString().slice(0, 10)}.csv`,
    analytics.toCsv(items, [
      'id', 'full_name', 'phone', 'email', 'role', 'city', 'purchase_location',
      'check_count', 'flagged_count', 'last_check_at', 'consent_at', 'created_at', 'browsers',
    ])
  );
});

router.get('/customers/:id', requirePermission('scans:read'), async (req, res) => {
  res.json(await verifierService.detail(req.params.id));
});

/*
 * A person's own request, under the privacy notice: correct their details,
 * or remove them (which is also how a withdrawn agreement is honoured).
 * Admin only, a reason every time, both in the audit log. See
 * services/verifiers.js for what removal keeps and what it clears.
 */
router.patch('/customers/:id', requirePermission('customers:write'), async (req, res) => {
  res.json(await verifierService.correct(req.params.id, req.body, { actor: req.user, req }));
});

router.post('/customers/:id/remove', requirePermission('customers:write'), async (req, res) => {
  const { reason } = validate(req.body, { reason: { type: 'string', required: true, min: 5, max: 300 } });
  res.json(await verifierService.remove(req.params.id, { reason, actor: req.user, req }));
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

/*
 * Closing an alert by acting on its code.
 *
 * Both routes below change the code AND resolve the alert in one
 * transaction, so a code can never be corrected while its alert stays open,
 * or the other way round. Both require a reason, which becomes the alert's
 * resolution note and goes into the audit trail - whoever operates this after
 * handover will be asked who changed a code and why.
 *
 * Neither touches scan_count, verified_count or the scan history. Those are
 * the evidence; correcting a status never rewrites it.
 */

/** Load an alert that is still open and has a code attached. */
async function openAlertWithCode(id) {
  const row = await db.get('alert', id);
  if (!row) throw notFound('Alert not found');
  const code = row.code_id ? await db.get('code', row.code_id) : undefined;
  const batch = code ? await db.get('batch', code.batch_id) : undefined;
  const alert = {
    id: row.id,
    status: row.status,
    code_id: row.code_id,
    code: code?.code ?? null,
    code_status: code?.status ?? null,
    verified_count: code?.verified_count ?? null,
    batch_status: batch?.status ?? null,
  };
  if (alert.status === 'resolved' || alert.status === 'dismissed') {
    throw conflict('This alert is already closed.');
  }
  if (!alert.code_id) {
    // An unknown-code alert has no code row: there is nothing to correct.
    throw badRequest('This alert is not linked to a code.');
  }
  return alert;
}

/**
 * The status a flagged code returns to when the flag was a false positive.
 *
 * A code's `flagged` status is a label: verification never reads it, and
 * re-evaluates batch, void, expiry and prior verifications on every scan. So
 * clearing it changes nothing a patient sees - a second device scanning
 * afterwards is flagged again by the duplicate rule, exactly as before.
 */
function unflaggedStatus({ verified_count: verified, batch_status: batch }) {
  if (batch === 'recalled') return 'recalled'; // a recall always wins
  if (verified > 0) return 'verified';
  // Never verified: back to what its batch implies, not to "verified" - that
  // would claim a successful check that never happened.
  if (batch === 'codes_issued') return 'issued';
  if (batch === 'printed') return 'printed';
  return 'released';
}

const closingReason = (body) =>
  validate(body, { reason: { type: 'string', required: true, min: 5, max: 300 } }).reason;

/** Resolve an alert as a false positive, clearing its code's flag. */
router.post('/alerts/:id/false-positive', requirePermission('alerts:write'), async (req, res) => {
  const reason = closingReason(req.body);
  const alert = await openAlertWithCode(Number(req.params.id));

  if (alert.code_status === 'void') {
    throw conflict('This code has been voided. A voided code cannot be cleared as a false positive.');
  }

  const from = alert.code_status;
  const to = from === 'flagged' ? unflaggedStatus(alert) : from;
  const note = `False positive: ${reason}`;

  await db.tx(async () => {
    if (to !== from) {
      await db.update('code', alert, { status: to });
    }
    await alertService.updateStatus(alert.id, { status: 'resolved', note, actor: req.user });
  });

  // No pack code in the detail: the id identifies it, and codes already
  // reach too many places they should not.
  if (to !== from) {
    await audit.record({ actor: req.user, req, action: 'code.unflag', entityType: 'code', entityId: alert.code_id, detail: { alertId: alert.id, from, to, reason } });
  }
  await audit.record({ actor: req.user, req, action: 'alert.resolved', entityType: 'alert', entityId: alert.id, detail: { falsePositive: true, codeStatus: { from, to }, reason } });

  res.json({ alert: await alertService.getById(alert.id), codeStatus: { from, to } });
});

/**
 * Void the alert's code and resolve the alert - for a pack confirmed
 * counterfeit, destroyed or stolen. Every later scan of it is refused.
 * Needs batches:write as well, the permission the stand-alone void uses.
 */
router.post(
  '/alerts/:id/void-code',
  requirePermission('alerts:write'),
  requirePermission('batches:write'),
  async (req, res) => {
    const reason = closingReason(req.body);
    const alert = await openAlertWithCode(Number(req.params.id));
    const from = alert.code_status;

    await db.tx(async () => {
      await db.update('code', alert, { status: 'void' });
      await alertService.updateStatus(alert.id, { status: 'resolved', note: `Code voided: ${reason}`, actor: req.user });
    });

    await audit.record({ actor: req.user, req, action: 'code.void', entityType: 'code', entityId: alert.code_id, detail: { alertId: alert.id, from, reason } });
    await audit.record({ actor: req.user, req, action: 'alert.resolved', entityType: 'alert', entityId: alert.id, detail: { codeVoided: true, reason } });

    res.json({ alert: await alertService.getById(alert.id), codeStatus: { from, to: 'void' } });
  }
);

// ===========================================================================
// Consumer reports
// ===========================================================================

router.get('/reports', requirePermission('reports:read'), async (req, res) => {
  const { limit, offset, ...meta } = db.paginate(listQuery(req));
  const where = { status: req.query.status || undefined };

  const total = await db.count('consumerReport', where);
  const rows = await db.findMany('consumerReport', where, { order: 'created_at desc', limit, offset });

  // The registry code, its batch and product, for the reports that name one.
  const codes = new Map(
    (await db.findMany('code', { id: { in: rows.map((r) => r.code_id).filter(Boolean) } }, {
      fields: ['code', 'batch_id'],
      extra: {
        batch_number: '*[_type == "batch" && id == ^.batch_id][0].batch_number',
        product_name: '*[_type == "batch" && id == ^.batch_id][0]{"n": *[_type == "product" && id == ^.product_id][0].name}.n',
      },
    })).map((c) => [c.id, c])
  );
  // Who made the check a report is about, when they gave their details: the
  // report keeps that check (only ever the reporter's own - see /api/report).
  // Behind scans:read, like the Customers screen, because it names a person.
  const checkers = new Map();
  if (authService.can(req.user.role, 'scans:read')) {
    const scans = await db.findMany('scan', { id: { in: rows.map((r) => r.scan_id).filter(Boolean) } }, {
      fields: ['verifier_id'],
    });
    const people = new Map(
      (await db.findMany('verifier', { id: { in: scans.map((s) => s.verifier_id).filter(Boolean) } }, {
        fields: ['full_name', 'phone', 'email', 'role'],
      })).map((p) => [p.id, p])
    );
    for (const s of scans) {
      const p = people.get(s.verifier_id);
      if (p) checkers.set(s.id, { id: p.id, name: p.full_name, phone: p.phone, email: p.email, role: p.role });
    }
  }

  const items = rows.map((r) => {
    const c = codes.get(r.code_id);
    return {
      ...r,
      registry_code: c?.code ?? null,
      batch_number: c?.batch_number ?? null,
      product_name: c?.product_name ?? null,
      checker: checkers.get(r.scan_id) ?? null,
    };
  });
  res.json({ items, total, ...meta });
});

router.patch('/reports/:id', requirePermission('reports:write'), async (req, res) => {
  const { status } = validate(req.body, {
    status: { type: 'enum', required: true, values: ['new', 'reviewing', 'closed'] },
  });
  const report = await db.get('consumerReport', req.params.id);
  if (!report) throw notFound('Report not found');

  await db.update('consumerReport', report, { status });
  await audit.record({ actor: req.user, req, action: 'report.update', entityType: 'report', entityId: report.id, detail: { status } });
  res.json(await db.get('consumerReport', report.id));
});

// ===========================================================================
// Shipments (distribution leg)
//
// Switched off: no role holds shipments:read or shipments:write, so every
// route here answers 403. They are kept, and tested, so switching shipments
// back on is one line (SHIPMENTS_ENABLED in services/auth.js).
// ===========================================================================

router.get('/shipments', requirePermission('shipments:read'), async (req, res) => {
  const { limit, offset, ...meta } = db.paginate(listQuery(req));
  const total = await db.count('shipment');
  const items = await db.findMany('shipment', {}, {
    order: 'shipped_at desc',
    limit,
    offset,
    extra: {
      batch_number: '*[_type == "batch" && id == ^.batch_id][0].batch_number',
      product_name: '*[_type == "batch" && id == ^.batch_id][0]{"n": *[_type == "product" && id == ^.product_id][0].name}.n',
    },
  });
  res.json({ items, total, ...meta });
});

router.post('/shipments', requirePermission('shipments:write'), async (req, res) => {
  const data = validate(req.body, {
    batchId: { type: 'int', required: true, min: 1 },
    reference: { type: 'string', required: true, max: 40 },
    quantity: { type: 'int', required: true, min: 1 },
    fromSite: { type: 'string', required: true, max: 120 },
    toName: { type: 'string', required: true, max: 160 },
    toType: { type: 'enum', values: ['distributor', 'pharmacy', 'hospital'], default: 'pharmacy' },
    toRegion: { type: 'string', max: 120 },
  });

  const batch = await db.get('batch', data.batchId);
  if (!batch) throw badRequest('That batch does not exist.');
  if (!['released', 'distributed'].includes(batch.status)) {
    throw conflict(`Batch ${batch.batch_number} is "${batch.status}" and cannot be shipped until it is released.`);
  }

  if (await db.findOne('shipment', { reference: data.reference }, { fields: ['id'] })) {
    throw conflict(`Shipment ${data.reference} already exists.`);
  }

  const shipment = await db.insert('shipment', {
    reference: data.reference,
    batch_id: data.batchId,
    quantity: data.quantity,
    from_site: data.fromSite,
    to_name: data.toName,
    to_type: data.toType,
    to_region: data.toRegion ?? null,
  });

  await audit.record({ actor: req.user, req, action: 'shipment.create', entityType: 'shipment', entityId: shipment.id, detail: data });
  res.status(201).json(shipment);
});

router.patch('/shipments/:id/receive', requirePermission('shipments:write'), async (req, res) => {
  const shipment = await db.get('shipment', req.params.id);
  if (!shipment) throw notFound('Shipment not found');

  await db.update('shipment', shipment, { status: 'received', received_at: db.now() });
  await audit.record({ actor: req.user, req, action: 'shipment.receive', entityType: 'shipment', entityId: shipment.id });
  res.json(await db.get('shipment', shipment.id));
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
    // The defined settings only, each with its effective value - not raw
    // table rows, so a stray key can never appear as if it did something.
    items: await settingsService.list(),
    runtime: {
      environment: config.env,
      publicBaseUrl: config.publicBaseUrl,
      smsProvider: config.sms.provider,
      rateLimits: config.rateLimit,
      sessionTtlHours: config.session.ttlHours,
    },
  });
});

/**
 * Change one setting. Only defined keys, each validated by its own rule in
 * services/settings.js. The audit entry records the value before and after,
 * so a change to how duplicates are detected is always traceable.
 */
router.patch('/settings/:key', requirePermission('settings:write'), async (req, res) => {
  if (!req.body || !('value' in req.body)) throw badRequest('A value is required.');
  // An empty string is a real value here: it hides the portal notice.
  const change = await settingsService.update(req.params.key, req.body.value, { actor: req.user });
  await audit.record({ actor: req.user, req, action: 'settings.update', entityType: 'setting', entityId: change.key, detail: { from: change.from, to: change.to } });
  res.json((await settingsService.list()).find((s) => s.key === change.key));
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
    load: () => productsWithCounts(),
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
    load: () => db.findMany('batch', {}, { order: 'created_at desc', extra: BATCH_EXTRA }),
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
