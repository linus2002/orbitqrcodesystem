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
import { AppError, validationFailed, notFound, conflict, badRequest } from '../lib/errors.js';
import * as settings from './settings.js';
import * as audit from './audit.js';

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

  // One row per person, not per browser: when the same mobile and email were
  // given from several browsers, the newest record stands for them all (its
  // counts are combined below). Mobile AND email, because a family often
  // shares one phone. Removed records are never grouped - "(removed)" is not
  // a person - and only a real number (+...) starts a group.
  const newestOfPerson =
    '(!string::startsWith(phone, "+") || count(*[_type == "verifier" && phone == ^.phone && email == ^.email && id > ^.id]) == 0)';
  where.$raw = where.$raw ? `${where.$raw} && ${newestOfPerson}` : newestOfPerson;

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
  return { items: await withBrowsers(items), total, ...meta };
}

/** Whether a record is part of a person who can be grouped (see list()). */
const groupable = (row) => typeof row.phone === 'string' && row.phone.startsWith('+');
const personKey = (row) => `${row.phone}\n${row.email}`;

/**
 * Every record of the person a record belongs to - one per browser they gave
 * details from, matched on mobile and email - newest first.
 */
async function recordsOf(person) {
  if (!groupable(person)) return [person];
  return db.findMany('verifier', { phone: person.phone, email: person.email }, { order: 'id desc' });
}

/** Each listed person with how many browsers they used and their checks across all of them. */
async function withBrowsers(items) {
  const phones = [...new Set(items.filter(groupable).map((r) => r.phone))];
  const totals = new Map();
  if (phones.length) {
    const all = await db.findMany('verifier', { phone: { in: phones } }, {
      fields: ['phone', 'email', 'check_count'],
      extra: { flagged_count: 'count(*[_type == "scan" && verifier_id == ^.id && result == "flagged"])' },
    });
    for (const r of all) {
      const t = totals.get(personKey(r)) ?? { browsers: 0, check_count: 0, flagged_count: 0 };
      t.browsers += 1;
      t.check_count += r.check_count ?? 0;
      t.flagged_count += r.flagged_count ?? 0;
      totals.set(personKey(r), t);
    }
  }
  return items.map((r) => ({ ...r, browsers: 1, ...(groupable(r) ? totals.get(personKey(r)) : {}) }));
}

/** One person and their recent checks, across every browser they used. */
export async function detail(id) {
  const person = await db.findOne('verifier', { id: Number(id) }, { fields: STAFF_FIELDS });
  if (!person) throw notFound('No such person');

  const records = await recordsOf(person);
  const scans = await db.findMany('scan', { verifier_id: { in: records.map((r) => r.id) } }, {
    order: ['created_at desc', 'id desc'],
    limit: 25,
    fields: ['code_text', 'result', 'reason', 'channel', 'city', 'region', 'country', 'created_at'],
    extra: {
      batch_number: '*[_type == "batch" && id == ^.batch_id][0].batch_number',
      product_name: '*[_type == "product" && id == ^.product_id][0].name',
    },
  });
  return {
    ...person,
    browsers: records.length,
    check_count: records.reduce((n, r) => n + (r.check_count ?? 0), 0),
    scans,
  };
}

// ---------------------------------------------------------------------------
// Removing and correcting a person's details
//
// What the privacy notice promises: a person may ask for their details to be
// corrected or removed, or withdraw their agreement (which is a removal - no
// way to contact them remains). Admin only (customers:write), a reason every
// time, and the audit entry never repeats the personal details themselves.
// ---------------------------------------------------------------------------

/** What a removed person's name, mobile and email read as. */
export const REMOVED = '(removed)';

const isRemoved = (row) => row.full_name === REMOVED && row.phone === REMOVED;

/**
 * Remove a person's details.
 *
 * Anonymised in place rather than deleted: the record's id stays, so their
 * past checks remain in the scan log as evidence - a check still happened,
 * then and there - but nothing names or reaches the person any more. The
 * fields the store requires hold REMOVED; the rest are cleared. Their
 * browser's link is broken with a new random token digest that no cookie
 * matches, so that phone is asked for details again. (The old digest's
 * uniqueness record stays behind; it is random and never issued again.)
 * The name and contact typed into reports about their own checks go too.
 */
export async function remove(id, { reason, actor, req } = {}) {
  const person = await db.get('verifier', Number(id));
  if (!person) throw notFound('No such person');
  if (isRemoved(person)) throw conflict("This person's details have already been removed.");

  // Every browser they gave details from: a person asking to be removed is
  // removed everywhere, not from one browser's record.
  const records = await recordsOf(person);
  const scanIds = (
    await db.findMany('scan', { verifier_id: { in: records.map((r) => r.id) } }, { fields: ['id'] })
  ).map((s) => s.id);
  const reports = scanIds.length
    ? await db.findMany('consumerReport', { scan_id: { in: scanIds } }, { fields: ['id'] })
    : [];

  await db.tx(async () => {
    for (const record of records) {
      await db.update('verifier', record, {
        full_name: REMOVED,
        phone: REMOVED,
        email: REMOVED,
        city: null,
        purchase_location: null,
        ip_hash: null,
        user_agent: null,
        token_hash: tokenHash(randomToken(32)),
      });
    }
    for (const r of reports) {
      await db.update('consumerReport', r.id, { reporter_name: null, reporter_contact: null });
    }
  });

  await audit.record({
    actor, req,
    action: 'customer.remove',
    entityType: 'customer',
    entityId: person.id,
    detail: { reason, records: records.length, reportsCleared: reports.length },
  });
  return detail(person.id);
}

/**
 * Correct a person's details. Only the fields sent change; a city or a
 * "where bought" sent empty is cleared, while a name, mobile or email cannot
 * be. The same checks as the portal form, so a correction can never store
 * what the form would refuse.
 */
export async function correct(id, body = {}, { actor, req } = {}) {
  const person = await db.get('verifier', Number(id));
  if (!person) throw notFound('No such person');
  if (isRemoved(person)) throw conflict('These details have been removed and cannot be corrected.');

  const raw = body ?? {};
  let data = {};
  let errors = [];
  try {
    data = validate(raw, {
      fullName: { type: 'string', min: 2, max: 120 },
      phone: { type: 'string', max: 32 },
      email: { type: 'email' },
      city: { type: 'string', max: 120 },
      purchaseLocation: { type: 'string', max: 200 },
      reason: { type: 'string', required: true, min: 5, max: 300 },
    });
  } catch (err) {
    if (err.code !== 'validation_failed') throw err;
    errors = [...err.details];
  }

  // Sent empty: allowed for the optional two (it clears them), not for the rest.
  const blank = (field) => typeof raw[field] === 'string' && raw[field].trim() === '';
  for (const field of ['fullName', 'phone', 'email']) {
    if (blank(field)) errors.push({ field, message: 'cannot be empty' });
  }
  const phone = data.phone !== undefined ? normalizePhone(data.phone) : undefined;
  if (data.phone !== undefined && !phone) {
    errors.push({ field: 'phone', message: 'must be a mobile number, e.g. 0917 123 4567' });
  }
  if (errors.length) throw validationFailed(errors);

  const changes = {};
  if (data.fullName !== undefined) changes.full_name = data.fullName;
  if (phone !== undefined) changes.phone = phone;
  if (data.email !== undefined) changes.email = data.email;
  if (data.city !== undefined || blank('city')) changes.city = data.city || null;
  if (data.purchaseLocation !== undefined || blank('purchaseLocation')) {
    changes.purchase_location = data.purchaseLocation || null;
  }
  if (!Object.keys(changes).length) throw badRequest('Nothing to change.');

  // Every browser's record of the person, so they stay one person.
  const records = await recordsOf(person);
  await db.tx(async () => {
    for (const record of records) await db.update('verifier', record, changes);
  });
  await audit.record({
    actor, req,
    action: 'customer.update',
    entityType: 'customer',
    entityId: person.id,
    // Which fields and why - not the values, old or new.
    detail: { fields: Object.keys(changes), reason: data.reason, records: records.length },
  });
  return detail(person.id);
}

export default {
  COOKIE, ROLES, REMOVED, normalizePhone, cookieOptions, publicView,
  register, fromRequest, requireDetails, touch, list, detail, remove, correct,
};
