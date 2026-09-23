/**
 * Public API - no authentication, by design.
 *
 * A patient must be able to check a pack instantly, with no account, no app
 * and no friction. Everything here is therefore anonymous and consequently
 * rate limited, because an open verification endpoint is exactly what a
 * counterfeiter would grind for valid codes.
 */
import { Router } from 'express';
import { config } from '../config.js';
import * as db from '../db/index.js';
import * as verification from '../services/verification.js';
import * as alerts from '../services/alerts.js';
import { normalizeCode } from '../lib/codes.js';
import { validate } from '../lib/validate.js';
import { createLimiter, rateLimit } from '../lib/ratelimit.js';
import { notFound, badRequest } from '../lib/errors.js';
import logger from '../lib/logger.js';

const router = Router();

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

// Two windows stacked: a burst limit that still allows a person to fix a typo
// a few times, and an hourly ceiling that makes bulk enumeration impractical.
const verifyBurst = createLimiter({
  name: 'verify-min',
  windowMs: 60_000,
  max: config.rateLimit.verifyPerMin,
});
const verifyHourly = createLimiter({
  name: 'verify-hour',
  windowMs: 3_600_000,
  max: config.rateLimit.verifyPerHour,
});
const reportLimiter = createLimiter({
  name: 'report',
  windowMs: 3_600_000,
  max: config.rateLimit.reportPerHour,
});
const bulkLimiter = createLimiter({ name: 'verify-bulk', windowMs: 3_600_000, max: 20 });

/** When someone hits the ceiling, that is itself a signal worth recording. */
const onVerifyLimit = (req) => {
  logger.warn('verification rate limit hit', { ip: req.clientIp });
};

// ---------------------------------------------------------------------------
// GET /api/health - liveness probe for the load balancer
// ---------------------------------------------------------------------------
router.get('/health', async (req, res) => {
  let dbOk = true;
  try {
    await db.scalar('SELECT 1');
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'qr-shield',
    time: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// ---------------------------------------------------------------------------
// POST /api/verify - THE core endpoint
// ---------------------------------------------------------------------------
/**
 * Body: { code: string, signature?: string }
 *
 * Always responds 200 with a result body, even for a counterfeit. "Flagged" is
 * a successful verification that returned bad news, not an HTTP error - using
 * a 4xx here would make every client treat a detected fake as a network fault.
 */
router.post(
  '/verify',
  rateLimit({ limiters: [verifyBurst, verifyHourly], onLimit: onVerifyLimit }),
  async (req, res) => {
    const { code, signature } = validate(req.body, {
      code: { type: 'string', required: true, max: 64 },
      signature: { type: 'string', max: 32 },
    });

    const result = await verification.verify(code, {
      channel: 'web',
      signature: signature ?? null,
      req,
    });

    res.json(result);
  }
);

// ---------------------------------------------------------------------------
// GET /api/verify/:code - convenience for the QR deep link
// ---------------------------------------------------------------------------
router.get(
  '/verify/:code',
  rateLimit({ limiters: [verifyBurst, verifyHourly], onLimit: onVerifyLimit }),
  async (req, res) => {
    const result = await verification.verify(req.params.code, {
      channel: 'web',
      signature: typeof req.query.s === 'string' ? req.query.s : null,
      req,
    });
    res.json(result);
  }
);

// ---------------------------------------------------------------------------
// POST /api/verify/bulk - a pharmacist checking a delivery
// ---------------------------------------------------------------------------
/**
 * Body: { codes: string[] }  (max 100)
 *
 * The field guide's "pharmacist checking a whole shipment on arrival follows
 * the same lookup, batched rather than one code at a time".
 */
router.post('/verify/bulk', rateLimit({ limiters: [bulkLimiter] }), async (req, res) => {
  const { codes } = validate(req.body, {
    codes: { type: 'array', required: true, max: 100 },
  });
  if (!codes.length) throw badRequest('Provide at least one code.');

  res.json(await verification.verifyBulk(codes, { req }));
});

// ---------------------------------------------------------------------------
// POST /api/report - the "direct report, bypassing the portal" path
// ---------------------------------------------------------------------------
/**
 * A patient can report a suspect pack whatever the scan said - including when
 * the code looked genuine but the packaging seems wrong. Every report creates
 * a HIGH severity alert, because a human bothering to fill in this form is a
 * stronger signal than most automated ones.
 */
router.post('/report', rateLimit({ limiters: [reportLimiter] }), async (req, res) => {
  const data = validate(req.body, {
    code: { type: 'string', max: 64 },
    description: { type: 'string', required: true, min: 10, max: 2000 },
    reporterName: { type: 'string', max: 120 },
    reporterContact: { type: 'string', max: 160 },
    purchaseLocation: { type: 'string', max: 200 },
    scanId: { type: 'int', min: 1 },
  });

  const normalized = data.code ? normalizeCode(data.code) : null;
  const codeRow = normalized ? await db.get('SELECT id, batch_id FROM codes WHERE code = ?', [normalized]) : null;

  const report = await db.tx(async () => {
    const { lastInsertRowid } = await db.run(
      `INSERT INTO consumer_reports
         (code_text, code_id, scan_id, reporter_name, reporter_contact, purchase_location, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized,
        codeRow?.id ?? null,
        data.scanId ?? null,
        data.reporterName ?? null,
        data.reporterContact ?? null,
        data.purchaseLocation ?? null,
        data.description,
      ]
    );

    const alert = await alerts.raise({
      type: 'consumer_report',
      codeId: codeRow?.id ?? null,
      batchId: codeRow?.batch_id ?? null,
      scanId: data.scanId ?? null,
      context: {
        summary: data.description.slice(0, 120),
        code: normalized,
        purchaseLocation: data.purchaseLocation ?? null,
        hasContactDetails: Boolean(data.reporterContact),
      },
    });

    if (alert) {
      await db.run('UPDATE consumer_reports SET alert_id = ? WHERE id = ?', [alert.id, lastInsertRowid]);
    }
    return lastInsertRowid;
  });

  logger.info('consumer report filed', { reportId: report, code: normalized });

  res.status(201).json({
    ok: true,
    reference: `RPT-${String(report).padStart(6, '0')}`,
    message:
      'Thank you. Your report has been sent to the brand security team. ' +
      'Please keep the pack and its packaging - do not use the product.',
  });
});

// ---------------------------------------------------------------------------
// GET /api/product/:sku/leaflet - the public leaflet
// ---------------------------------------------------------------------------
router.get('/product/:sku/leaflet', async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE sku = ?', [
    String(req.params.sku).toUpperCase(),
  ]);
  if (!product) throw notFound('Product not found');

  const leaflet = await db.get(
    `SELECT * FROM leaflets WHERE product_id = ? AND language = ?
      ORDER BY effective_from DESC LIMIT 1`,
    [product.id, String(req.query.lang ?? 'en')]
  );
  if (!leaflet) throw notFound('No leaflet is published for this product');

  res.json({
    product: {
      sku: product.sku,
      name: product.name,
      strength: product.strength,
      dosageForm: product.dosage_form,
      manufacturer: product.manufacturer,
    },
    leaflet: {
      version: leaflet.version,
      language: leaflet.language,
      effectiveFrom: leaflet.effective_from,
      sections: JSON.parse(leaflet.sections_json),
    },
  });
});

export default router;
