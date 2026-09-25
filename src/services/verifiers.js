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
 * stored, so the dataset cannot be used to pose as a person, and the cookie
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
 * it was given and which notice was shown, and the request is refused
 * without it.
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
  const row = await db.insert('verifier', {
    token_hash: tokenHash(token),
    full_name: data.fullName,
    phone,
    email: data.email,
    role: data.role,
    city: data.city || null,
    purchase_location: data.purchaseLocation || null,
    consent_at: db.now(),
    policy_version: data.policyVersion || null,
    ip_hash: pseudonymize(req?.clientIp, config.secrets.session),
    user_agent: req?.get?.('user-agent')?.slice(0, 300) ?? null,
  });
  return { verifier: row, token };
}

/** The person behind this request, from their cookie, or null. */
export async function fromRequest(req) {
  const token = req.cookies?.[COOKIE];
  if (typeof token !== 'string' || !token || token.length > 128) return null;
  return (await db.findOne('verifier', { token_hash: tokenHash(token) })) ?? null;
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

/** One more check by this person. The count is incremented on the server, never read-then-written. */
export async function touch(id) {
  await db.update('verifier', id, { last_check_at: db.now() }, { inc: { check_count: 1 } });
}

// token_hash is never selected for staff: it is a credential, not a detail.
// ip_hash and user_agent likewise stay behind.
const STAFF_FIELDS = [
  'full_name', 'phone', 'email', 'role', 'city', 'purchase_location',
  'consent_at', 'policy_version', 'check_count', 'last_check_at', 'created_at',
];

/**
 * The people list for staff, newest first.
 *
 * Search matches the start of any word of the name or email, and a mobile
 * number typed the way people type them (0917 123 4567, +63 917...), which
 * is normalised before it is compared - the stored form is always +63...
 */
export async function list({ page, pageSize, search, role, from, to } = {}) {
  const { limit, offset, ...meta } = db.paginate({ page, pageSize });
  const where = {
    role: role || undefined,
    created_at: from || to ? { gte: from || undefined, lte: to || undefined } : undefined,
  };
  const params = {};

  const term = String(search ?? '').trim().toLowerCase();
  if (term) {
    const alts = ['lower(full_name) match $term', 'lower(email) match $term'];
    params.term = `${term}*`;
    const phone = normalizePhone(term);
    if (phone) {
      alts.push('phone == $phone');
      params.phone = phone;
    } else if (/^\+?\d[\d ]*$/.test(term)) {
      // A partial number: try it as typed, and as the +63 form of a 09... start.
      const digits = term.replace(/\s/g, '');
      const prefixes = [digits];
      if (digits.startsWith('0')) prefixes.push(`+63${digits.slice(1)}`);
      else if (digits.startsWith('63')) prefixes.push(`+${digits}`);
      else if (!digits.startsWith('+')) prefixes.push(`+${digits}`);
      params.prefixes = prefixes;
      alts.push('count($prefixes[string::startsWith(^.phone, @)]) > 0');
    }
    where.$raw = `(${alts.join(' || ')})`;
  }

  const total = await db.count('verifier', where, { params });
  const items = await db.findMany('verifier', where, {
    order: ['created_at desc', 'id desc'],
    limit,
    offset,
    params,
    fields: STAFF_FIELDS,
    extra: {
      flagged_count: 'count(*[_type == "scan" && verifier_id == ^.id && result == "flagged"])',
    },
  });
  return { items, total, ...meta };
}

/** One person and their recent checks. */
export async function detail(id) {
  const person = await db.findOne('verifier', { id: Number(id) }, { fields: STAFF_FIELDS });
  if (!person) throw notFound('No such person');

  const scans = await db.findMany('scan', { verifier_id: person.id }, {
    order: ['created_at desc', 'id desc'],
    limit: 25,
    fields: ['code_text', 'result', 'reason', 'channel', 'city', 'region', 'country', 'created_at'],
    extra: {
      batch_number: '*[_type == "batch" && id == ^.batch_id][0].batch_number',
      product_name: '*[_type == "product" && id == ^.product_id][0].name',
    },
  });
  return { ...person, scans };
}

export default {
  COOKIE, ROLES, normalizePhone, cookieOptions, publicView,
  register, fromRequest, requireDetails, touch, list, detail,
};
