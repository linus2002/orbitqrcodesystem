/**
 * Stored settings - the values the team can change without a deploy.
 *
 * Until now the table had no readers: the Settings screen saved values that
 * changed nothing, and accepted any key at all. This module is the one place
 * a setting is defined, validated and read, and nothing outside this list can
 * be written.
 *
 * Read fresh from the database every time, never cached. On a serverless
 * deployment several instances serve traffic at once, and a cached value
 * would let two of them disagree about whether the same scan is a duplicate.
 * These are single-row primary-key reads, and the duplicate threshold is only
 * read for codes that have already been verified once.
 *
 * A stored value that fails validation - hand-edited, or left from an older
 * version - is ignored in favour of the default rather than trusted, and the
 * default always reproduces the behaviour the system had before settings
 * took effect.
 */
import * as db from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import logger from '../lib/logger.js';

/*
 * Every setting. `check` returns the normalised value or throws with a
 * message the Settings screen can show as it is.
 */
export const SETTINGS = {
  'portal.banner': {
    label: 'Portal notice',
    description:
      'Shown at the top of the public verification page, e.g. a recall notice. Leave empty to show nothing.',
    kind: 'text',
    default: '',
    check(v) {
      const s = String(v ?? '').trim();
      if (s.length > 200) throw badRequest('The portal notice must be at most 200 characters.');
      return s;
    },
  },

  'support.phone': {
    label: 'Support phone number',
    description: 'Shown to patients on a result that says not to use the pack.',
    kind: 'text',
    default: '',
    check(v) {
      const s = String(v ?? '').trim();
      // Digits, spaces, + ( ) - and letters, so vanity numbers such as
      // "+234 800 QRSHIELD" stay valid. Empty hides it.
      if (s && !/^[+0-9A-Za-z ()-]{3,30}$/.test(s)) {
        throw badRequest('Enter a phone number of 3-30 characters: digits, spaces, + ( ) - and letters only.');
      }
      return s;
    },
  },

  'support.sms_shortcode': {
    label: 'SMS shortcode',
    description: 'The number patients text a code to when they have no internet.',
    kind: 'text',
    default: '32123',
    check(v) {
      const s = String(v ?? '').trim();
      if (!/^[0-9]{3,8}$/.test(s)) throw badRequest('The SMS shortcode must be 3-8 digits.');
      return s;
    },
  },

  'alerts.duplicate_threshold': {
    label: 'Duplicate threshold',
    description:
      'How many devices may verify one pack before it is flagged as a duplicate. 1 is the ' +
      'safest: a second device is flagged. Raising it lets a cloned pack pass more checks ' +
      'before anyone is alerted.',
    kind: 'int',
    min: 1,
    max: 3,
    default: 1,
    check(v) {
      const n = Number(String(v ?? '').trim());
      if (!Number.isInteger(n) || n < 1 || n > 3) {
        throw badRequest('The duplicate threshold must be a whole number from 1 to 3.');
      }
      return n;
    },
  },

  'portal.require_details': {
    label: 'Ask who is checking',
    description:
      'When on, the public portal asks for a name, mobile number and email before it will ' +
      'check a pack, and each check is recorded against that person. Off lets anyone check ' +
      'anonymously, as before.',
    kind: 'choice',
    options: ['on', 'off'],
    default: 'on',
    check(v) {
      const s = String(v ?? '').trim().toLowerCase();
      if (!['on', 'off'].includes(s)) throw badRequest('Set this to on or off.');
      return s;
    },
  },
};

const known = (key) => Object.prototype.hasOwnProperty.call(SETTINGS, key);

/** One setting's effective value: the stored one if valid, else the default. */
export async function get(key) {
  if (!known(key)) throw new Error(`settings.get: unknown key "${key}"`);
  const spec = SETTINGS[key];
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return spec.default;
  try {
    return spec.check(row.value);
  } catch {
    logger.warn('stored setting is invalid; using the default', { key });
    return spec.default;
  }
}

/** Every setting, for the Settings screen: definition plus effective value. */
export async function list() {
  const rows = await db.all('SELECT key, value, updated_at FROM settings');
  const stored = Object.fromEntries(rows.map((r) => [r.key, r]));
  const out = [];
  for (const [key, spec] of Object.entries(SETTINGS)) {
    out.push({
      key,
      label: spec.label,
      description: spec.description,
      kind: spec.kind,
      min: spec.min,
      max: spec.max,
      options: spec.options,
      value: String(await get(key)),
      updatedAt: stored[key]?.updated_at ?? null,
    });
  }
  return out;
}

/**
 * Change a setting. Unknown keys are refused - the table used to accept
 * anything, which becomes a real problem the moment values have effects.
 * Returns the previous and new effective values for the audit trail.
 */
export async function update(key, value, { actor } = {}) {
  if (!known(key)) throw badRequest(`"${key}" is not a setting that can be changed.`);
  const spec = SETTINGS[key];
  const next = spec.check(value);
  const previous = await get(key);

  await db.run(
    `INSERT INTO settings (key, value, description, updated_by, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
                                     updated_at = excluded.updated_at`,
    [key, String(next), spec.description, actor?.id ?? null]
  );
  return { key, from: previous, to: next };
}

/** What the public portal needs. Nothing here is sensitive. */
export async function portal() {
  return {
    banner: await get('portal.banner'),
    supportPhone: await get('support.phone'),
    smsShortcode: await get('support.sms_shortcode'),
    detailsRequired: (await get('portal.require_details')) === 'on',
  };
}

export default { SETTINGS, get, list, update, portal };
