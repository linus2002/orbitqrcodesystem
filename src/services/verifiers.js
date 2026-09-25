/**
 * Who is checking a medicine.
 *
 * Before the public portal will check a pack it asks, once, for the person's
 * name, mobile number, email and their relation to the medicine. The point is
 * to be able to reach them: a pack that later turns out to be counterfeit or
 * recalled is a safety follow-up, and a phone number is what makes one
 * possible. Every check they make afterwards is recorded against them.
 *
 * The browser gets a random token in a cookie. Only a keyed digest of it is
 * stored, so the database cannot be used to pose as a person, and the cookie
 * grants nothing beyond "the portal will check packs for you" - it opens no
 * account and reveals nothing.
 *
 * The gate itself is a stored setting (portal.require_details), so staff can
 * switch it off without a deploy if it turns out to keep people from checking.
 */
import * as db from '../db/index.js';
import { config } from '../config.js';
import { validate } from '../lib/validate.js';
import { hmac, randomToken, pseudonymize } from '../lib/crypto.js';
import { AppError, validationFailed, notFound } from '../lib/errors.js';
import * as settings from './settings.js';

export const COOKIE = 'qrs_checker';
const COOKIE_DAYS = 180;

/** Who the person is in relation to the medicine, as shown on the form. */
export const ROLES = {
  patient: 'Patient',
  caregiver: 'Caregiver or family member',
  pharmacist: 'Pharmacist',
  health_worker: 'Doctor, nurse or health worker',
  retailer: 'Retailer or distributor',
  other: 'Other',
};

/**
 * Normalise a mobile number to E.164.
 *
 * Philippine mobiles are accepted in the forms people actually type - 0917
 * 123 4567, 63917..., +63 917... - and anything else must already be a full
 * international number. Landlines are refused: the number is for SMS.
 */
export function normalizePhone(raw) {
  const s = String(raw ?? '').replace(/[\s().-]/g, '');
  if (/^09\d{9}$/.test(s)) return `+63${s.slice(1)}`;
  if (/^639\d{9}$/.test(s)) return `+${s}`;
  if (/^\+639\d{9}$/.test(s)) return s;
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  return null;
}

/** The cookie the browser keeps. Shared by set and clear so they match. */
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.session.cookieSecure,
    // Lax, not strict: the cookie must survive arriving from a QR scan, and
    // it protects nothing that a cross-site request could abuse.
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_DAYS * 86_400_000,
  };
}

const tokenHash = (token) => hmac(token, config.secrets.session, 'hex');

/** What the portal is told about the person: enough to say "checking as". */
export function publicView(row) {
  if (!row) return null;
  return {
    name: row.full_name,
    phone: row.phone,
    email: row.email,
    role: row.role,
    roleLabel: ROLES[row.role] ?? row.role,
    city: row.city,
  };
}

/**
 * Record a person and issue their token.
 *
 * Every field is validated in one pass so the form can highlight all of them
 * at once. Consent is a real field, not an assumption: the row records when
 * it was given, and the request is refused without it.
 */
export async function register(body, { req } = {}) {
  const raw = body && typeof body === 'object' ? body : {};
  let data = {};
  let errors = [];
  try {
    data = validate(raw, {
      fullName: { type: 'string', required: true, min: 2, max: 120 },
      phone: { type: 'string', required: true, max: 32 },
      email: { type: 'email', required: true },
      role: { type: 'enum', required: true, values: Object.keys(ROLES) },
      city: { type: 'string', max: 120 },
      purchaseLocation: { type: 'string', max: 200 },
      consent: { type: 'bool', required: true },
      // Which privacy notice the form showed, so the record says what was agreed to.
      policyVersion: { type: 'string', max: 40 },
    });
  } catch (err) {
    if (err.code !== 'validation_failed') throw err;
    errors = [...err.details];
  }

  // The two checks the generic validator cannot make, added to its list
  // rather than raised after it, so the form hears about everything at once.
  const given = (field) => raw[field] !== undefined && raw[field] !== null && raw[field] !== '';
  const phone = normalizePhone(raw.phone);
  if (given('phone') && !phone) {
    errors.push({ field: 'phone', message: 'must be a mobile number, e.g. 0917 123 4567' });
  }
  const consented =
    raw.consent === true || ['1', 'true', 'yes', 'on'].includes(String(raw.consent).toLowerCase());
  if (given('consent') && !consented) {
    errors.push({ field: 'consent', message: 'is required - tick the box to continue' });
  }
  if (errors.length) throw validationFailed(errors);

  const token = randomToken(32);
  const { lastInsertRowid } = await db.run(
    `INSERT INTO verifiers
       (token_hash, full_name, phone, email, role, city, purchase_location,
        consent_at, policy_version, ip_hash, user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tokenHash(token),
      data.fullName,
      phone,
      data.email,
      data.role,
      data.city || null,
      data.purchaseLocation || null,
      new Date().toISOString(),
      data.policyVersion || null,
      pseudonymize(req?.clientIp, config.secrets.session),
      req?.get?.('user-agent')?.slice(0, 300) ?? null,
    ]
  );

  const row = await db.get('SELECT * FROM verifiers WHERE id = ?', [lastInsertRowid]);
  return { verifier: row, token };
}

/** The person behind this request, from their cookie, or null. */
export async function fromRequest(req) {
  const token = req.cookies?.[COOKIE];
  if (typeof token !== 'string' || !token || token.length > 128) return null;
  return db.get('SELECT * FROM verifiers WHERE token_hash = ?', [tokenHash(token)]);
}

/**
 * Express middleware: the gate in front of every verification route.
 *
 * Attaches req.verifier whenever the cookie is valid, so a check is recorded
 * against the person even when the gate is switched off. With the gate on
 * and no valid cookie, refuses with a code the portal recognises and answers
 * by showing the form.
 */
export async function requireDetails(req, res, next) {
  try {
    req.verifier = await fromRequest(req);
    if (!req.verifier && (await settings.get('portal.require_details')) === 'on') {
      throw new AppError(
        403,
        'details_required',
        'Please tell us who you are before checking a pack.'
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** One more check by this person. */
export async function touch(id) {
  await db.run(
    'UPDATE verifiers SET check_count = check_count + 1, last_check_at = ? WHERE id = ?',
    [new Date().toISOString(), id]
  );
}

// token_hash is never selected for staff: it is a credential, not a detail.
const STAFF_COLUMNS = `v.id, v.full_name, v.phone, v.email, v.role, v.city, v.purchase_location,
                       v.consent_at, v.policy_version, v.check_count, v.last_check_at, v.created_at`;

/** The people list for staff, newest first, searchable by name, number or email. */
export async function list({ page, pageSize, search, role, from, to } = {}) {
  const { limit, offset, ...meta } = db.paginate({ page, pageSize });
  const where = [];
  const params = [];

  if (role) { where.push('v.role = ?'); params.push(role); }
  if (search?.trim()) {
    const like = `%${search.trim().toLowerCase()}%`;
    where.push('(LOWER(v.full_name) LIKE ? OR v.phone LIKE ? OR v.email LIKE ?)');
    params.push(like, like, like);
  }
  if (from) { where.push('v.created_at >= ?'); params.push(from); }
  if (to) { where.push('v.created_at <= ?'); params.push(to); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await db.scalar(`SELECT COUNT(*) FROM verifiers v ${clause}`, params);
  const items = await db.all(
    `SELECT ${STAFF_COLUMNS},
            (SELECT COUNT(*) FROM scans s WHERE s.verifier_id = v.id AND s.result = 'flagged')
              AS flagged_count
       FROM verifiers v
       ${clause}
      ORDER BY v.created_at DESC, v.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items, total, ...meta };
}

/** One person and their recent checks. */
export async function detail(id) {
  const person = await db.get(`SELECT ${STAFF_COLUMNS} FROM verifiers v WHERE v.id = ?`, [id]);
  if (!person) throw notFound('No such person');

  const scans = await db.all(
    `SELECT s.id, s.code_text, s.result, s.reason, s.channel, s.city, s.region, s.country,
            s.created_at, b.batch_number, p.name AS product_name
       FROM scans s
       LEFT JOIN batches b  ON b.id = s.batch_id
       LEFT JOIN products p ON p.id = s.product_id
      WHERE s.verifier_id = ?
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 25`,
    [id]
  );
  return { ...person, scans };
}

export default {
  COOKIE, ROLES, normalizePhone, cookieOptions, publicView,
  register, fromRequest, requireDetails, touch, list, detail,
};
