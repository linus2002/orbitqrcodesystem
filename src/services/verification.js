/**
 * Verification service - the single most important code path in the system.
 *
 * It answers one question: "is the pack in this patient's hand genuine?"
 * Everything else in QR Shield exists to feed or follow up on this decision.
 *
 * DECISION ORDER (deliberate - earlier rules win):
 *
 *   1. Structural / checksum failure  -> 'invalid'  (a TYPO, treated gently)
 *   2. Code not in the registry       -> 'flagged'  (unknown_code)
 *   3. Code's batch was recalled      -> 'flagged'  (recalled)
 *   4. Code's batch never released    -> 'flagged'  (not_released - leaked from the line)
 *   5. Code voided by the team        -> 'flagged'  (void)
 *   6. Batch past its expiry date     -> 'flagged'  (expired - real product, unsafe)
 *   7. Already verified elsewhere     -> 'flagged'  (duplicate_scan)
 *   8. Otherwise                      -> 'genuine'
 *
 * Rule 1 is separated from the rest on purpose. A mistyped code is
 * overwhelmingly the common case, and telling a patient "COUNTERFEIT" because
 * they typed O instead of 0 destroys trust in the whole system. Structural
 * failures get their own result value and a "check your typing" message.
 *
 * Rule 7 has a deliberate exception: see SAME_SOURCE_GRACE_MS.
 */
import * as db from '../db/index.js';
import { config } from '../config.js';
import { parseCode, checkSignature } from '../lib/codes.js';
import { pseudonymize } from '../lib/crypto.js';
import * as leaflets from './leaflets.js';
import * as alerts from './alerts.js';
import * as settings from './settings.js';
import logger from '../lib/logger.js';

/**
 * A patient who refreshes the result page, or scans the same pack twice while
 * showing a pharmacist, must not be told their genuine medicine is a fake.
 * Repeat scans from the same source inside this window are treated as one
 * verification event.
 */
const SAME_SOURCE_GRACE_MS = 15 * 60 * 1000;

/** Machine-readable reasons; also stored in scans.reason. */
export const REASONS = {
  OK: 'ok',
  OK_REPEAT_SAME_SOURCE: 'ok_repeat_same_source',
  EMPTY: 'empty',
  MALFORMED: 'malformed',
  CHECKSUM_FAILED: 'checksum_failed',
  UNKNOWN_CODE: 'unknown_code',
  DUPLICATE_SCAN: 'duplicate_scan',
  RECALLED: 'recalled',
  EXPIRED: 'expired',
  NOT_RELEASED: 'not_released',
  VOID: 'void',
};

/** Patient-facing copy. Deliberately plain, non-technical, and actionable. */
const MESSAGES = {
  [REASONS.OK]: 'This pack is genuine. It has been verified for the first time.',
  [REASONS.OK_REPEAT_SAME_SOURCE]:
    'This pack is genuine. You have already checked it from this device.',
  [REASONS.EMPTY]: 'Please enter the code printed on the pack.',
  [REASONS.MALFORMED]:
    'That code is not in the expected format. It should look like AMX25-260921-00483-K7.',
  [REASONS.CHECKSUM_FAILED]:
    'That code does not look quite right - please check for a mistyped character and try again.',
  [REASONS.UNKNOWN_CODE]:
    'This code is not in our records. Do not use this product. Please report it and return it to the pharmacy.',
  [REASONS.DUPLICATE_SCAN]:
    'Warning: this code has already been verified elsewhere. That can mean the pack has been copied. Do not use it until you have checked with your pharmacist.',
  [REASONS.RECALLED]:
    'This batch has been recalled. Do not use this product. Return it to your pharmacy.',
  [REASONS.EXPIRED]:
    'This pack is genuine, but it is past its expiry date. Do not use it - return it to your pharmacy.',
  [REASONS.NOT_RELEASED]:
    'This code exists but the batch was never released for sale. Do not use this product and please report it.',
  [REASONS.VOID]:
    'This code has been withdrawn by the manufacturer. Do not use this product.',
};

/**
 * Approximate location for a scan.
 *
 * INTEGRATION POINT: in production put a GeoIP database (MaxMind GeoLite2 or
 * IP2Location) behind this function. Until then we read the coarse geo headers
 * that CDNs already provide, which is enough for the dashboard's "where are
 * flags clustering" view and avoids storing anything more precise than a city.
 */
export function resolveGeo(req) {
  if (!req) return { country: null, region: null, city: null };
  const h = (name) => req.get?.(name) || null;
  return {
    country: h('cf-ipcountry') || h('x-vercel-ip-country') || h('x-geo-country') || null,
    region: h('x-vercel-ip-country-region') || h('x-geo-region') || null,
    city: h('x-vercel-ip-city') || h('x-geo-city') || null,
  };
}

/** Days from today until `isoDate` (negative when already past). */
function daysUntil(isoDate) {
  const target = new Date(`${isoDate}T23:59:59Z`).getTime();
  return Math.ceil((target - Date.now()) / 86400000);
}

/**
 * Shape the public leaflet payload: the CURRENT leaflet for the medicine.
 *
 * Deliberately not the one pinned on the batch. A leaflet correction has to
 * reach everyone holding the medicine, including packs printed before it -
 * a newly added warning is for exactly the people holding the older stock,
 * and showing them the leaflet as it stood when their box was packed would
 * hide it from them. So a scan of any batch, however old, opens the newest
 * version, the same one the leaflet QR on the carton opens.
 *
 * `batches.leaflet_id` is kept and still written: it records which version
 * shipped with a batch, which is an audit question, not a display one.
 *
 * English only here, as it was: a pack scan carries no language, and the
 * leaflet page is where a reader chooses one.
 */
async function loadLeaflet(batch) {
  const leaflet = await db.get(
    `SELECT l.*, f.filename AS pdf_filename, f.size AS pdf_size
       FROM leaflets l
       LEFT JOIN leaflet_files f ON f.id = l.file_id
      WHERE l.product_id = ? AND l.language = 'en'
      ORDER BY l.effective_from DESC, l.id DESC LIMIT 1`,
    [batch.product_id]
  );
  if (!leaflet) return null;
  let sections = [];
  try {
    sections = JSON.parse(leaflet.sections_json);
  } catch {
    logger.error('leaflet sections_json is not valid JSON', { leafletId: leaflet.id });
  }
  return {
    version: leaflet.version,
    language: leaflet.language,
    sections,
    // The PDF, when this version has one: the result card offers it, and the
    // sections stay for a screen reader.
    pdf: leaflets.pdfInfo(batch.sku, leaflet),
  };
}

/**
 * Count recent failed lookups from one source and raise a guessing alert once
 * the threshold is crossed. This is the detective control that pairs with the
 * preventive rate limiter.
 */
async function detectGuessing(ipHash, scanId) {
  if (!ipHash) return;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const attempts = await db.scalar(
    `SELECT COUNT(*) FROM scans
      WHERE ip_hash = ? AND created_at >= ?
        AND reason IN ('unknown_code', 'checksum_failed', 'malformed')`,
    [ipHash, since]
  );

  if (attempts >= config.rateLimit.guessAlertThreshold) {
    // Fire once per hour per source rather than on every subsequent attempt.
    const recent = await db.get(
      `SELECT id FROM alerts
        WHERE type = 'guess_attack' AND status IN ('open','investigating')
          AND json_extract(detail_json, '$.ipHash') = ?
          AND created_at >= ?
        LIMIT 1`,
      [ipHash, since]
    );
    if (!recent) {
      await alerts.raise({
        type: 'guess_attack',
        scanId,
        context: { ipHash, attempts, windowHours: 1 },
      });
    }
  }
}

/**
 * Verify a code.
 *
 * @param {string} rawCode        what the patient submitted or the QR carried
 * @param {object} ctx
 * @param {'web'|'sms'|'api'} [ctx.channel]
 * @param {string} [ctx.signature] the `s` parameter from a scanned QR URL
 * @param {object} [ctx.req]       express request (ip, user-agent, geo)
 * @param {string} [ctx.msisdn]    phone number, SMS channel only
 * @param {number} [ctx.verifierId] who is checking, when the portal asked (see verifiers)
 * @returns {object} public-safe result
 */
export async function verify(rawCode, ctx = {}) {
  const { channel = 'web', signature = null, req = null, msisdn = null, verifierId = null } = ctx;

  const ipHash = pseudonymize(req?.clientIp, config.secrets.session);
  const msisdnHash = pseudonymize(msisdn, config.secrets.session);
  const geo = resolveGeo(req);
  const userAgent = req?.get?.('user-agent')?.slice(0, 300) ?? null;

  const parsed = parseCode(rawCode, config.secrets.code);

  // --- 1. Structural failure: a typo, not a counterfeit --------------------
  if (!parsed.ok) {
    const reason =
      parsed.error === 'empty'
        ? REASONS.EMPTY
        : parsed.error === 'checksum'
          ? REASONS.CHECKSUM_FAILED
          : REASONS.MALFORMED;

    // An empty submission is a UI event, not a security event: do not log it.
    let scanId = null;
    if (reason !== REASONS.EMPTY) {
      scanId = await logScan({
        codeText: parsed.code ?? String(rawCode ?? '').slice(0, 64),
        result: 'invalid',
        reason,
        channel,
        ipHash,
        verifierId,
        msisdnHash,
        userAgent,
        geo,
        signatureState: checkSignature(parsed.code ?? '', signature, config.secrets.code),
      });
      await detectGuessing(ipHash, scanId);
    }

    return publicResult({
      result: 'invalid',
      reason,
      scanId,
      code: parsed.code ?? null,
      retryable: true,
    });
  }

  const { code } = parsed;
  const signatureState = checkSignature(code, signature, config.secrets.code);

  // --- 2. Registry lookup --------------------------------------------------
  const row = await db.get(
    `SELECT c.*,
            b.batch_number, b.mfg_date, b.expiry_date, b.status AS batch_status,
            b.is_test, b.leaflet_id, b.product_id AS batch_product_id, b.recall_reason,
            p.sku, p.name AS product_name, p.generic_name, p.strength,
            p.dosage_form, p.pack_size, p.manufacturer
       FROM codes c
       JOIN batches b  ON b.id = c.batch_id
       JOIN products p ON p.id = c.product_id
      WHERE c.code = ?`,
    [code]
  );

  if (!row) {
    const scanId = await logScan({
      codeText: code,
      result: 'flagged',
      reason: REASONS.UNKNOWN_CODE,
      channel,
      ipHash,
      verifierId,
      msisdnHash,
      userAgent,
      geo,
      signatureState,
    });
    await alerts.raise({
      type: 'unknown_code',
      scanId,
      context: { code, channel, country: geo.country, signatureState },
    });
    await detectGuessing(ipHash, scanId);

    return publicResult({
      result: 'flagged',
      reason: REASONS.UNKNOWN_CODE,
      scanId,
      code,
      reportable: true,
    });
  }

  const isTest = row.is_test === 1;
  // "Scan number" as the patient understands it means "the Nth time this pack
  // was successfully verified", so it counts genuine verifications only.
  const scanNumber = row.verified_count + 1;

  // --- 3-7. Ordered status rules ------------------------------------------
  let result = 'genuine';
  let reason = REASONS.OK;

  if (row.batch_status === 'recalled') {
    result = 'flagged';
    reason = REASONS.RECALLED;
  } else if (row.status === 'void') {
    result = 'flagged';
    reason = REASONS.VOID;
  } else if (['planned', 'codes_issued', 'printed'].includes(row.batch_status)) {
    // The code is real but the batch never left QA. A pack bearing it in the
    // wild means codes leaked off the packaging line.
    result = 'flagged';
    reason = REASONS.NOT_RELEASED;
  } else if (daysUntil(row.expiry_date) < 0) {
    result = 'flagged';
    reason = REASONS.EXPIRED;
  } else if (
    row.verified_count > 0 &&
    // How many devices may verify a pack before it counts as a duplicate.
    // Read only once a pack has been verified, so a first scan costs nothing
    // extra. The default of 1 is exactly the rule this replaced
    // (verified_count > 0): a second device is flagged.
    row.verified_count >= (await settings.get('alerts.duplicate_threshold'))
  ) {
    // Grace window: the same source re-checking the same pack is one event.
    const lastSameSource = await db.get(
      `SELECT created_at FROM scans
        WHERE code_id = ? AND result = 'genuine'
          AND ip_hash IS NOT NULL AND ip_hash = ?
        ORDER BY created_at DESC LIMIT 1`,
      [row.id, ipHash]
    );
    const withinGrace =
      lastSameSource &&
      Date.now() - new Date(lastSameSource.created_at).getTime() < SAME_SOURCE_GRACE_MS;

    if (withinGrace) {
      result = 'genuine';
      reason = REASONS.OK_REPEAT_SAME_SOURCE;
    } else {
      result = 'flagged';
      reason = REASONS.DUPLICATE_SCAN;
    }
  }

  // --- Persist: scan row, counters and alert, atomically -------------------
  const scanId = await db.tx(async () => {
    const id = await logScan({
      codeText: code,
      codeId: row.id,
      batchId: row.batch_id,
      productId: row.product_id,
      result,
      reason,
      channel,
      scanNumber,
      ipHash,
      verifierId,
      msisdnHash,
      userAgent,
      geo,
      signatureState,
      isTest,
    });

    // A grace re-scan must not inflate the counter that defines "duplicate".
    if (reason !== REASONS.OK_REPEAT_SAME_SOURCE) {
      await db.run(
        `UPDATE codes
            SET scan_count = scan_count + 1,
                verified_count = verified_count + CASE WHEN ? = 'genuine' THEN 1 ELSE 0 END,
                first_scan_at = COALESCE(first_scan_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                last_scan_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                status = CASE
                  WHEN ? = 'genuine' AND status IN ('issued','printed','released') THEN 'verified'
                  WHEN ? = 'flagged' AND status <> 'recalled' THEN 'flagged'
                  ELSE status END,
                flagged_at = CASE WHEN ? = 'flagged' THEN
                  COALESCE(flagged_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE flagged_at END
          WHERE id = ?`,
        [result, result, result, result, row.id]
      );
    } else {
      await db.run(
        `UPDATE codes SET last_scan_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        [row.id]
      );
    }
    return id;
  });

  // --- Alerting (never inside the transaction: it is best-effort) ----------
  const alertType = {
    [REASONS.DUPLICATE_SCAN]: 'duplicate_scan',
    [REASONS.RECALLED]: 'recalled_scan',
    [REASONS.EXPIRED]: 'expired_scan',
    [REASONS.NOT_RELEASED]: 'batch_anomaly',
    [REASONS.VOID]: 'batch_anomaly',
  }[reason];

  if (alertType) {
    await alerts.raise({
      type: alertType,
      codeId: row.id,
      batchId: row.batch_id,
      scanId,
      isTest,
      context: {
        code,
        scanNumber,
        batchNumber: row.batch_number,
        product: row.product_name,
        reason,
        channel,
        country: geo.country,
        city: geo.city,
        signatureState,
      },
    });
  }

  logger.info('verification', { code, result, reason, scanNumber, channel, isTest });

  // --- Public payload ------------------------------------------------------
  const expiryDays = daysUntil(row.expiry_date);
  return publicResult({
    result,
    reason,
    scanId,
    code,
    scanNumber,
    isTest,
    product: {
      sku: row.sku,
      name: row.product_name,
      genericName: row.generic_name,
      strength: row.strength,
      dosageForm: row.dosage_form,
      packSize: row.pack_size,
      manufacturer: row.manufacturer,
    },
    batch: {
      number: row.batch_number,
      mfgDate: row.mfg_date,
      expiryDate: row.expiry_date,
      daysToExpiry: expiryDays,
      isExpired: expiryDays < 0,
      expiringSoon: expiryDays >= 0 && expiryDays <= 90,
      recallReason: row.batch_status === 'recalled' ? row.recall_reason : null,
    },
    // The leaflet is shown only when the pack is trustworthy. Rendering
    // official dosing information next to a counterfeit warning would be
    // actively dangerous.
    leaflet: result === 'genuine' ? await loadLeaflet(row) : null,
    firstVerifiedAt: row.first_scan_at,
    reportable: result !== 'genuine',
  });
}

/** Insert one scan row. Returns its id. */
async function logScan({
  codeText,
  codeId = null,
  batchId = null,
  productId = null,
  result,
  reason,
  channel,
  scanNumber = null,
  ipHash = null,
  verifierId = null,
  msisdnHash = null,
  userAgent = null,
  geo = {},
  signatureState = null,
  isTest = false,
}) {
  const { lastInsertRowid } = await db.run(
    `INSERT INTO scans
       (code_text, code_id, batch_id, product_id, result, reason, channel,
        signature_state, scan_number, ip_hash, verifier_id, msisdn_hash, user_agent,
        country, region, city, is_test)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      String(codeText).slice(0, 64),
      codeId,
      batchId,
      productId,
      result,
      reason,
      channel,
      signatureState,
      scanNumber,
      ipHash,
      verifierId,
      msisdnHash,
      userAgent,
      geo.country ?? null,
      geo.region ?? null,
      geo.city ?? null,
      isTest ? 1 : 0,
    ]
  );
  return Number(lastInsertRowid);
}

/** Assemble the response body, attaching the patient-facing message. */
function publicResult(payload) {
  return {
    result: payload.result,
    reason: payload.reason,
    message: MESSAGES[payload.reason] ?? 'Unable to verify this code.',
    verifiedAt: new Date().toISOString(),
    ...payload,
  };
}

/**
 * Bulk check, for a pharmacist verifying a shipment on arrival.
 *
 * Same decision logic per code, but the response is a compact summary rather
 * than a full patient-facing payload.
 */
export async function verifyBulk(codes, ctx = {}) {
  const unique = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];

  /*
   * Checked one at a time rather than with Promise.all: each verification
   * writes a scan row inside a transaction, and the connection serves a single
   * transaction at a time. Running them concurrently would have them fighting
   * over it, and a shipment check is not latency-critical.
   */
  const results = [];
  for (const raw of unique) {
    const r = await verify(raw, { ...ctx, channel: 'api' });
    results.push({
      code: r.code ?? raw,
      result: r.result,
      reason: r.reason,
      product: r.product?.name ?? null,
      batch: r.batch?.number ?? null,
      expiryDate: r.batch?.expiryDate ?? null,
    });
  }

  return {
    checked: results.length,
    genuine: results.filter((r) => r.result === 'genuine').length,
    flagged: results.filter((r) => r.result === 'flagged').length,
    invalid: results.filter((r) => r.result === 'invalid').length,
    results,
  };
}

export default { verify, verifyBulk, REASONS, resolveGeo };
