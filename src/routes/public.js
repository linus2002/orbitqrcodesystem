/**
 * Public API - no authentication, by design.
 *
 * A patient must be able to check a pack instantly, with no account, no app
 * and no password. What the portal does ask, once, is who is checking - name,
 * mobile number and email - so a pack that later proves counterfeit or
 * recalled can be followed up with the person holding it. That is a cookie
 * and a row, not an account (see services/verifiers.js), and staff can switch
 * the question off. Everything here is otherwise anonymous and consequently
 * rate limited, because an open verification endpoint is exactly what a
 * counterfeiter would grind for valid codes.
 */
import { Router } from 'express';
import { config } from '../config.js';
import * as db from '../db/index.js';
import * as verification from '../services/verification.js';
import * as alerts from '../services/alerts.js';
import * as settingsService from '../services/settings.js';
import * as verifiers from '../services/verifiers.js';
import * as leafletService from '../services/leaflets.js';
import * as places from '../services/places.js';
import { pseudonymize } from '../lib/crypto.js';
import { normalizeCode } from '../lib/codes.js';
import { validate } from '../lib/validate.js';
import { createLimiter, rateLimit } from '../lib/ratelimit.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
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
// Giving details is a once-per-device event; anything like a stream of them
// from one source is someone filling the table with junk.
const detailsLimiter = createLimiter({ name: 'details', windowMs: 3_600_000, max: 10 });
// One place per check, and checks are themselves limited; this only stops a
// script from walking the scan ids.
const placeLimiter = createLimiter({ name: 'check-place', windowMs: 3_600_000, max: 40 });

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
  verifiers.requireDetails,
  async (req, res) => {
    const { code, signature } = validate(req.body, {
      code: { type: 'string', required: true, max: 64 },
      signature: { type: 'string', max: 32 },
    });

    const result = await verification.verify(code, {
      channel: 'web',
      signature: signature ?? null,
      req,
      verifierId: req.verifier?.id ?? null,
    });
    if (req.verifier) await verifiers.touch(req.verifier.id);

    res.json(result);
  }
);

// ---------------------------------------------------------------------------
// GET /api/verify/:code - convenience for the QR deep link
// ---------------------------------------------------------------------------
router.get(
  '/verify/:code',
  rateLimit({ limiters: [verifyBurst, verifyHourly], onLimit: onVerifyLimit }),
  verifiers.requireDetails,
  async (req, res) => {
    const result = await verification.verify(req.params.code, {
      channel: 'web',
      signature: typeof req.query.s === 'string' ? req.query.s : null,
      req,
      verifierId: req.verifier?.id ?? null,
    });
    if (req.verifier) await verifiers.touch(req.verifier.id);
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
router.post(
  '/verify/bulk',
  rateLimit({ limiters: [bulkLimiter] }),
  verifiers.requireDetails,
  async (req, res) => {
    const { codes } = validate(req.body, {
      codes: { type: 'array', required: true, max: 100 },
    });
    if (!codes.length) throw badRequest('Provide at least one code.');

    const summary = await verification.verifyBulk(codes, {
      req,
      verifierId: req.verifier?.id ?? null,
    });
    if (req.verifier) await verifiers.touch(req.verifier.id);
    res.json(summary);
  }
);

// ---------------------------------------------------------------------------
// POST /api/report - the "direct report, bypassing the portal" path
// ---------------------------------------------------------------------------
/**
 * A patient can report a suspect pack whatever the scan said - including when
 * the code looked genuine but the packaging seems wrong. Every report creates
 * a HIGH severity alert, because a human bothering to fill in this form is a
 * stronger signal than most automated ones.
 */
/**
 * The check a report is about, kept only when it is this browser's own.
 *
 * The scan id comes from the browser, and staff see the report beside the
 * person who made that check - so a report naming somebody else's check
 * (or one that does not exist) is kept without it, never tied to them.
 * A check made without details given matches a report made without them,
 * which is how it worked before details were asked for.
 */
async function ownScan(scanId, req) {
  if (!scanId) return null;
  const scan = await db.get('scan', scanId);
  if (!scan) return null;
  const me = await verifiers.fromRequest(req);
  return (scan.verifier_id ?? null) === (me?.id ?? null) ? scan.id : null;
}

/**
 * A GPS reading as the browser sends it, or undefined. Only its shape is
 * checked here; services/places.js decides whether it is usable and reduces
 * it to a city - the coordinates themselves are never stored.
 */
function gpsFrom(body) {
  const loc = body?.location;
  if (loc === undefined || loc === null) return undefined;
  if (typeof loc !== 'object' || Array.isArray(loc)) throw badRequest('location must be { lat, lng, accuracy }.');
  return { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy };
}

router.post('/report', rateLimit({ limiters: [reportLimiter] }), async (req, res) => {
  const data = validate(req.body, {
    code: { type: 'string', max: 64 },
    description: { type: 'string', required: true, min: 10, max: 2000 },
    reporterName: { type: 'string', max: 120 },
    reporterContact: { type: 'string', max: 160 },
    purchaseLocation: { type: 'string', max: 200 },
    // Picked from the city list (GET /api/places); the shop goes in purchaseLocation.
    placeCode: { type: 'string', max: 12 },
    scanId: { type: 'int', min: 1 },
  });

  const normalized = data.code ? normalizeCode(data.code) : null;
  const codeRow = normalized ? await db.getCode(normalized) : null;
  const scanId = await ownScan(data.scanId, req);
  // Where it was bought, against where the report is sent from.
  const place = places.facts({
    placeCode: data.placeCode,
    outlet: data.purchaseLocation,
    location: gpsFrom(req.body),
    req,
  });
  const boughtAt = [place.purchase_outlet, place.purchase_place].filter(Boolean).join(' - ') || null;

  // The report, its alert and the link between them land together or not at all.
  const report = await db.tx(async () => {
    const row = await db.insert('consumerReport', {
      code_text: normalized,
      code_id: codeRow?.id ?? null,
      scan_id: scanId,
      reporter_name: data.reporterName ?? null,
      reporter_contact: data.reporterContact ?? null,
      purchase_location: boughtAt,
      description: data.description,
      ...place,
    });

    const alert = await alerts.raise({
      type: 'consumer_report',
      codeId: codeRow?.id ?? null,
      batchId: codeRow?.batch_id ?? null,
      scanId,
      context: {
        summary: data.description.slice(0, 120),
        code: normalized,
        purchaseLocation: boughtAt,
        placeConsistency: place.place_consistency,
        locationSource: place.location_source,
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
// POST /api/checks/:scanId/place - where the pack behind a check was bought
// ---------------------------------------------------------------------------
/**
 * Body: { placeCode?, outlet?, location?: { lat, lng, accuracy } }
 *
 * Asked on the result, after the check: optional on a genuine one, asked
 * plainly on a suspicious one, which is also the only time the page asks for
 * the phone's location. Stored beside the scan rather than on it, because
 * scans are never edited (see checkPlace in db/schema.js).
 *
 * Only for this browser's own check, and only for a day after it: the scan id
 * is a plain number, so without both a script could pin places on anybody's
 * checks. For a check made without details given, "own" means the same
 * connection, since there is no person to match. One place per check.
 */
const PLACE_WINDOW_MS = 24 * 3_600_000;

router.post('/checks/:scanId/place', rateLimit({ limiters: [placeLimiter] }), async (req, res) => {
  const data = validate(req.body, {
    placeCode: { type: 'string', max: 12 },
    outlet: { type: 'string', max: 120 },
  });
  const location = gpsFrom(req.body);
  if (!data.placeCode && !data.outlet && location === undefined) {
    throw badRequest('Say where the pack was bought, or share a location.');
  }

  const scanId = Number.parseInt(req.params.scanId, 10);
  const scan = Number.isInteger(scanId) && scanId > 0 ? await db.get('scan', scanId) : null;
  const me = await verifiers.fromRequest(req);
  const mine =
    scan &&
    (scan.verifier_id ?? null) === (me?.id ?? null) &&
    (scan.verifier_id || (scan.ip_hash && scan.ip_hash === pseudonymize(req.clientIp, config.secrets.session))) &&
    Date.now() - new Date(scan.created_at).getTime() < PLACE_WINDOW_MS;
  if (!mine) throw notFound('That check was not found.');

  if (await db.findOne('checkPlace', { scan_id: scan.id }, { fields: ['id'] })) {
    throw conflict('Where this pack was bought has already been recorded.');
  }
  const place = places.facts({ placeCode: data.placeCode, outlet: data.outlet, location, req });
  // The unique key on scan_id settles two sends that race each other.
  const row = await db.insert('checkPlace', { scan_id: scan.id, verifier_id: scan.verifier_id ?? null, ...place });

  // What the page may show back: the place, never a verdict on the person.
  res.status(201).json({ ok: true, purchasePlace: row.purchase_place, outlet: row.purchase_outlet });
});

// ---------------------------------------------------------------------------
// GET /api/places - the cities and municipalities the purchase place is picked from
// ---------------------------------------------------------------------------
router.get('/places', (req, res) => {
  // The same for everyone and changed only by a deploy.
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({ places: places.list() });
});

// ---------------------------------------------------------------------------
// GET /api/portal - what the public page shows that staff can change
// ---------------------------------------------------------------------------
router.get('/portal', async (req, res) => {
  // The notice, the support number, the SMS shortcode and whether details
  // are asked for. None is sensitive, and all are read fresh so a change
  // shows on the next page load. `checker` is who this browser said it was,
  // so the page can skip the form for someone who has already filled it in.
  // `here` is the city the connection points to, and `lastPurchase` where the
  // person last said they bought a pack: what "where did you buy it" offers
  // first, so the usual answer is one tap.
  const me = await verifiers.fromRequest(req);
  const checker = verifiers.publicView(me);
  const here = places.fromConnection(req);
  res.json({
    ...(await settingsService.portal()),
    checker: checker && { ...checker, lastPurchase: await verifiers.lastPurchase(me) },
    here: here && { code: here.code, label: here.label },
  });
});

// ---------------------------------------------------------------------------
// /api/portal/details - who is checking
// ---------------------------------------------------------------------------
/**
 * Body: { fullName, phone, email, role, city?, purchaseLocation?, consent }
 *
 * Records the person and sets the cookie that lets this browser check packs.
 * 201 with what the portal shows back ("checking as ..."), never the token.
 */
router.post('/portal/details', rateLimit({ limiters: [detailsLimiter] }), async (req, res) => {
  const { verifier, token } = await verifiers.register(req.body, { req });
  res.cookie(verifiers.COOKIE, token, verifiers.cookieOptions());
  logger.info('portal details given', { verifierId: verifier.id, role: verifier.role });
  res.status(201).json({ ok: true, checker: verifiers.publicView(verifier) });
});

/** "Not you?" - forget this browser's details, so the form is asked again. */
router.delete('/portal/details', async (req, res) => {
  res.clearCookie(verifiers.COOKIE, verifiers.cookieOptions());
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /api/product/:sku/leaflet - the public leaflet
// ---------------------------------------------------------------------------
/** The lang and version a public leaflet request names. */
const leafletQuery = (req) => ({
  lang: String(req.query.lang ?? 'en'),
  version: req.query.version === undefined ? undefined : String(req.query.version),
});

router.get('/product/:sku/leaflet', async (req, res) => {
  const { lang, version } = leafletQuery(req);

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
   * they did not ask for. The PDF, likewise, is only an address here.
   */
  const { product, versions, wanted, current } = await leafletService.resolveLeaflet(
    req.params.sku,
    { lang, version }
  );
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
      superseded: !current,
      // The current version's PDF address names no version, so the page's
      // "Open the leaflet (PDF)" button never goes stale.
      pdf: leafletService.pdfInfo(product.sku, wanted, {
        lang,
        version: current ? undefined : wanted.version,
      }),
    },
    history: versions.map((v, i) => ({
      version: v.version,
      effectiveFrom: v.effective_from,
      current: i === 0,
      hasPdf: Boolean(v.file_id),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/product/:sku/leaflet.pdf - the leaflet as the uploaded document
// ---------------------------------------------------------------------------
/**
 * Sent inline, so a phone opens it in its viewer rather than downloading it.
 * Same ?lang= and ?version= as the page: the current version by default.
 */
router.get('/product/:sku/leaflet.pdf', async (req, res) => {
  const { wanted } = await leafletService.resolveLeaflet(req.params.sku, leafletQuery(req));
  if (!wanted.file_id) throw notFound('This leaflet has no PDF; it is published as text.');

  const file = await leafletService.pdfFile(wanted.file_id);
  if (!file || file.status !== 'ready') throw notFound('The leaflet document is missing.');

  // Streamed a piece at a time with the total length up front: the phone's
  // viewer can show progress, and no single response or query has to carry
  // the whole document (see services/leaflets.js).
  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${file.filename.replace(/"/g, '')}"`);
  res.setHeader('Content-Length', String(file.size));
  for (let seq = 0; seq < Number(file.chunks); seq++) {
    res.write(await leafletService.pdfPiece(file, seq));
  }
  res.end();
});

export default router;
