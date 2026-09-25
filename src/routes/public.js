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
import * as settingsService from '../services/settings.js';
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
    await db.migrate({ silent: true });
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
  const codeRow = normalized ? await db.getCode(normalized) : null;

  // The report, its alert and the link between them land together or not at all.
  const report = await db.tx(async () => {
    const row = await db.insert('consumerReport', {
      code_text: normalized,
      code_id: codeRow?.id ?? null,
      scan_id: data.scanId ?? null,
      reporter_name: data.reporterName ?? null,
      reporter_contact: data.reporterContact ?? null,
      purchase_location: data.purchaseLocation ?? null,
      description: data.description,
    });

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

    if (alert) await db.update('consumerReport', row, { alert_id: alert.id });
    return row.id;
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
// GET /api/portal - what the public page shows that staff can change
// ---------------------------------------------------------------------------
router.get('/portal', async (req, res) => {
  // The notice, the support number and the SMS shortcode. None is sensitive,
  // and all three are read fresh so a change shows on the next page load.
  res.json(await settingsService.portal());
});

// ---------------------------------------------------------------------------
// GET /api/product/:sku/leaflet - the public leaflet
// ---------------------------------------------------------------------------
router.get('/product/:sku/leaflet', async (req, res) => {
  const product = await db.findOne('product', { sku: String(req.params.sku).toUpperCase() });
  if (!product) throw notFound('Product not found');

  const lang = String(req.query.lang ?? 'en');

  /*
   * Every version for this medicine and language, newest first. The newest
   * IS the current one: publishing a new version is what supersedes the old,
   * and the dates already say which is which, so nothing has to mark it.
   *
   * The current version is the default and the only thing a QR ever opens -
   * a safety correction has to reach everyone holding the medicine, including
   * packs printed before it. Older versions stay reachable by ?version= so a
   * patient or an inspector can see what the leaflet said before, and they
   * come back flagged as superseded so nobody reads outdated dosing without
   * being told.
   *
   * Metadata only here; the full text is fetched for the one version shown.
   * A patient may be on a slow connection, and every past version is weight
   * they did not ask for.
   */
  const versions = await db.findMany('leaflet', { product_id: product.id, language: lang }, {
    order: ['effective_from desc', 'id desc'],
    fields: ['id', 'version', 'effective_from'],
  });
  if (!versions.length) throw notFound('No leaflet is published for this product');

  const wanted =
    req.query.version === undefined
      ? versions[0]
      : versions.find((v) => v.version === String(req.query.version));
  if (!wanted) throw notFound('That version of the leaflet does not exist');

  const leaflet = await db.get('leaflet', wanted.id);

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
      sections: leaflet.sections,
      // Said explicitly rather than left for the page to work out from the
      // history: it drives a warning the reader must see before the content.
      superseded: wanted.id !== versions[0].id,
    },
    history: versions.map((v, i) => ({
      version: v.version,
      effectiveFrom: v.effective_from,
      current: i === 0,
    })),
  });
});

export default router;
