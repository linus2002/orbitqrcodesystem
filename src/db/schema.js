/**
 * The data model, as Sanity document types.
 *
 * This file replaces schema.sql. It is the one place a document type is
 * defined, and three things are generated from it:
 *
 *   - write validation in src/db/index.js: required fields, enumerations and
 *     defaults, which SQL enforced with NOT NULL, CHECK and DEFAULT. Sanity
 *     enforces none of those on API writes, so the store layer does, on every
 *     insert and update. A buggy caller still cannot write a status the
 *     application does not understand.
 *   - unique keys: SQL UNIQUE constraints become claim documents with a
 *     deterministic _id, created in the same transaction as the row, so a
 *     duplicate fails atomically instead of relying on a check-then-insert.
 *   - the Sanity Studio schema (scripts/gen-studio-schema.js).
 *
 * Row shape is kept exactly as it was in SQL - snake_case fields, an integer
 * `id` - so the API responses, the React client and every service keep
 * working unchanged. Foreign keys stay integer fields (`batch_id`) rather
 * than Sanity references: a strong reference would block deletes that SQL
 * allowed with ON DELETE SET NULL, and the append-only logs must be able to
 * outlive what they point at.
 *
 * Document ids: `<type>-<id>`, except a code, whose id is `code-<CODE>`. The
 * verification lookup is by the printed code, and making it the document id
 * turns the hottest query in the system into a direct fetch - and makes a
 * duplicate code impossible by construction.
 */

/** Timestamp helper: ISO-8601 UTC with milliseconds, as SQL stored them. */
export const now = () => new Date().toISOString();

const NOW = { default: now };

/**
 * Field kinds:
 *   string | text | int | bool01 | date | datetime | json | array
 *
 * `bool01` is 0/1 rather than true/false: the SQL columns were integers and
 * every caller compares with `=== 1`.
 * `json` is a JSON document kept as a string (audit and alert detail): its
 * shape is open-ended, which a Studio schema cannot describe field by field.
 */
export const TYPES = {
  user: {
    table: 'users',
    title: 'Staff user',
    fields: {
      email: { kind: 'string', required: true },
      full_name: { kind: 'string', required: true },
      password_hash: { kind: 'string', required: true, secret: true },
      role: { kind: 'string', required: true, enum: ['admin', 'security', 'regulator'] },
      status: { kind: 'string', required: true, enum: ['active', 'suspended'], default: 'active' },
      failed_attempts: { kind: 'int', required: true, default: 0 },
      locked_until: { kind: 'datetime' },
      last_login_at: { kind: 'datetime' },
      must_change_pw: { kind: 'bool01', required: true, default: 0 },
      avatar: { kind: 'text', secret: true },
      created_by: { kind: 'int' },
      created_at: { kind: 'datetime', required: true, ...NOW },
      updated_at: { kind: 'datetime', required: true, ...NOW },
    },
    // Emails are compared case-insensitively; callers lower-case before writing.
    unique: [['email']],
  },

  session: {
    table: 'sessions',
    title: 'Session',
    // The id is the random session id carried in the token, not a counter.
    idKind: 'string',
    internal: true,
    fields: {
      user_id: { kind: 'int', required: true },
      csrf_token: { kind: 'string', required: true, secret: true },
      ip: { kind: 'string' },
      user_agent: { kind: 'string' },
      created_at: { kind: 'datetime', required: true, ...NOW },
      expires_at: { kind: 'datetime', required: true },
      revoked_at: { kind: 'datetime' },
    },
  },

  product: {
    table: 'products',
    title: 'Product',
    fields: {
      sku: { kind: 'string', required: true },
      name: { kind: 'string', required: true },
      generic_name: { kind: 'string' },
      strength: { kind: 'string' },
      dosage_form: { kind: 'string' },
      pack_size: { kind: 'string' },
      manufacturer: { kind: 'string', required: true },
      category: { kind: 'string' },
      status: { kind: 'string', required: true, enum: ['active', 'discontinued'], default: 'active' },
      created_at: { kind: 'datetime', required: true, ...NOW },
      updated_at: { kind: 'datetime', required: true, ...NOW },
    },
    unique: [['sku']],
  },

  leaflet: {
    table: 'leaflets',
    title: 'Patient leaflet',
    fields: {
      product_id: { kind: 'int', required: true },
      version: { kind: 'string', required: true },
      language: { kind: 'string', required: true, default: 'en' },
      // [{ heading, body }] - stored as real structured content, so the
      // leaflet reads properly in the Studio.
      sections: { kind: 'array', required: true, of: { heading: 'string', body: 'text' } },
      // The PDF this version was published as, if any (a leafletFile). With
      // one attached the sections may be empty; they stay the accessible form.
      file_id: { kind: 'int' },
      effective_from: { kind: 'datetime', required: true, ...NOW },
      created_at: { kind: 'datetime', required: true, ...NOW },
    },
    unique: [['product_id', 'version', 'language']],
  },

  batch: {
    table: 'batches',
    title: 'Batch',
    fields: {
      batch_number: { kind: 'string', required: true },
      product_id: { kind: 'int', required: true },
      mfg_date: { kind: 'date', required: true },
      expiry_date: { kind: 'date', required: true },
      quantity: { kind: 'int', required: true, min: 1 },
      serial_width: { kind: 'int', required: true, default: 5 },
      status: {
        kind: 'string',
        required: true,
        enum: ['planned', 'codes_issued', 'printed', 'released', 'distributed', 'recalled', 'closed'],
        default: 'planned',
      },
      is_test: { kind: 'bool01', required: true, default: 0 },
      leaflet_id: { kind: 'int' },
      codes_issued_at: { kind: 'datetime' },
      printed_at: { kind: 'datetime' },
      released_at: { kind: 'datetime' },
      recalled_at: { kind: 'datetime' },
      recall_reason: { kind: 'text' },
      notes: { kind: 'text' },
      created_by: { kind: 'int' },
      created_at: { kind: 'datetime', required: true, ...NOW },
      updated_at: { kind: 'datetime', required: true, ...NOW },
    },
    unique: [['batch_number']],
  },

  code: {
    table: 'codes',
    title: 'Pack code',
    fields: {
      code: { kind: 'string', required: true },
      batch_id: { kind: 'int', required: true },
      product_id: { kind: 'int', required: true },
      unit_index: { kind: 'int', required: true },
      serial: { kind: 'string', required: true },
      status: {
        kind: 'string',
        required: true,
        enum: ['issued', 'printed', 'released', 'verified', 'flagged', 'recalled', 'void'],
        default: 'issued',
      },
      // Kept separate on purpose - see docs/DATA-MODEL.md.
      scan_count: { kind: 'int', required: true, default: 0 },
      verified_count: { kind: 'int', required: true, default: 0 },
      first_scan_at: { kind: 'datetime' },
      last_scan_at: { kind: 'datetime' },
      flagged_at: { kind: 'datetime' },
      created_at: { kind: 'datetime', required: true, ...NOW },
    },
    // `code` is unique through the document id itself (code-<CODE>).
  },

  scan: {
    table: 'scans',
    title: 'Scan',
    appendOnly: true,
    fields: {
      code_text: { kind: 'string', required: true },
      code_id: { kind: 'int' },
      batch_id: { kind: 'int' },
      product_id: { kind: 'int' },
      // Who checked, when the portal asked (a verifier). Web checks only.
      verifier_id: { kind: 'int' },
      result: { kind: 'string', required: true, enum: ['genuine', 'flagged', 'invalid'] },
      reason: { kind: 'string', required: true },
      channel: { kind: 'string', required: true, enum: ['web', 'sms', 'api'], default: 'web' },
      signature_state: { kind: 'string', enum: ['valid', 'invalid', 'absent'] },
      scan_number: { kind: 'int' },
      // Pseudonymised - never the raw address or number.
      ip_hash: { kind: 'string', secret: true },
      msisdn_hash: { kind: 'string', secret: true },
      user_agent: { kind: 'string' },
      country: { kind: 'string' },
      region: { kind: 'string' },
      city: { kind: 'string' },
      is_test: { kind: 'bool01', required: true, default: 0 },
      created_at: { kind: 'datetime', required: true, ...NOW },
    },
  },

  alert: {
    table: 'alerts',
    title: 'Alert',
    fields: {
      type: {
        kind: 'string',
        required: true,
        enum: ['duplicate_scan', 'unknown_code', 'recalled_scan', 'expired_scan',
          'guess_attack', 'consumer_report', 'batch_anomaly'],
      },
      severity: { kind: 'string', required: true, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
      status: { kind: 'string', required: true, enum: ['open', 'investigating', 'resolved', 'dismissed'], default: 'open' },
      title: { kind: 'string', required: true },
      detail_json: { kind: 'json' },
      // Lifted out of detail_json so the guessing detector can filter on it:
      // GROQ cannot look inside a JSON string the way json_extract could.
      ip_hash: { kind: 'string', secret: true },
      code_id: { kind: 'int' },
      batch_id: { kind: 'int' },
      scan_id: { kind: 'int' },
      assigned_to: { kind: 'int' },
      resolution_note: { kind: 'text' },
      resolved_by: { kind: 'int' },
      resolved_at: { kind: 'datetime' },
      created_at: { kind: 'datetime', required: true, ...NOW },
      updated_at: { kind: 'datetime', required: true, ...NOW },
    },
  },

  consumerReport: {
    table: 'consumer_reports',
    title: 'Consumer report',
    fields: {
      code_text: { kind: 'string' },
      code_id: { kind: 'int' },
      scan_id: { kind: 'int' },
      alert_id: { kind: 'int' },
      reporter_name: { kind: 'string' },
      reporter_contact: { kind: 'string' },
      purchase_location: { kind: 'string' },
      description: { kind: 'text', required: true },
      status: { kind: 'string', required: true, enum: ['new', 'reviewing', 'closed'], default: 'new' },
      created_at: { kind: 'datetime', required: true, ...NOW },
    },
  },

  shipment: {
    table: 'shipments',
    title: 'Shipment',
    fields: {
      reference: { kind: 'string', required: true },
      batch_id: { kind: 'int', required: true },
      quantity: { kind: 'int', required: true, min: 1 },
      from_site: { kind: 'string', required: true },
      to_name: { kind: 'string', required: true },
      to_type: { kind: 'string', required: true, enum: ['distributor', 'pharmacy', 'hospital'], default: 'pharmacy' },
      to_region: { kind: 'string' },
      status: { kind: 'string', required: true, enum: ['in_transit', 'received', 'disputed'], default: 'in_transit' },
      shipped_at: { kind: 'datetime', required: true, ...NOW },
      received_at: { kind: 'datetime' },
      created_at: { kind: 'datetime', required: true, ...NOW },
    },
    unique: [['reference']],
  },

  auditLog: {
    table: 'audit_log',
    title: 'Audit entry',
    appendOnly: true,
    fields: {
      actor_id: { kind: 'int' },
      actor_email: { kind: 'string' },
      action: { kind: 'string', required: true },
      entity_type: { kind: 'string' },
      entity_id: { kind: 'string' },
      detail_json: { kind: 'json' },
      ip: { kind: 'string', secret: true },
      user_agent: { kind: 'string' },
      created_at: { kind: 'datetime', required: true, ...NOW },
    },
  },

  smsLog: {
    table: 'sms_log',
    title: 'SMS message',
    appendOnly: true,
    fields: {
      direction: { kind: 'string', required: true, enum: ['inbound', 'outbound'] },
      msisdn_hash: { kind: 'string', required: true, secret: true },
      body: { kind: 'text', required: true },
      scan_id: { kind: 'int' },
      provider: { kind: 'string' },
      status: { kind: 'string', required: true, default: 'ok' },
      created_at: { kind: 'datetime', required: true, ...NOW },
    },
  },

  setting: {
    table: 'settings',
    title: 'Setting',
    // Keyed by the setting name rather than a counter.
    idKind: 'string',
    fields: {
      key: { kind: 'string', required: true },
      value: { kind: 'string', required: true },
      description: { kind: 'text' },
      updated_by: { kind: 'int' },
      updated_at: { kind: 'datetime', required: true, ...NOW },
    },
  },

  /*
   * The people who check medicines on the public portal.
   *
   * Before the portal will check a pack it asks, once, who is asking: name,
   * mobile number, email and their relation to the medicine. The point is to
   * be able to reach the person - a pack that later turns out counterfeit or
   * recalled is a safety follow-up - so unlike a scan these ARE stored in
   * clear, under the consent recorded here. Shown only to roles holding
   * scans:read, never to a regulator. Staff can switch the question off
   * (setting portal.require_details).
   *
   * The browser keeps a random token in a cookie; only its keyed digest is
   * stored, so a copy of the dataset cannot be used to pose as anyone.
   */
  verifier: {
    table: 'verifiers',
    title: 'Customer',
    fields: {
      token_hash: { kind: 'string', required: true, secret: true },
      full_name: { kind: 'string', required: true },
      phone: { kind: 'string', required: true }, // normalised, e.g. +639171234567
      email: { kind: 'string', required: true }, // lower-cased
      role: {
        kind: 'string',
        required: true,
        enum: ['patient', 'caregiver', 'pharmacist', 'health_worker', 'retailer', 'other'],
      },
      city: { kind: 'string' },
      purchase_location: { kind: 'string' },
      consent_at: { kind: 'datetime', required: true },
      // Which privacy notice they agreed to (client/src/portal/PrivacyPolicy.jsx).
      policy_version: { kind: 'string' },
      ip_hash: { kind: 'string', secret: true },
      user_agent: { kind: 'string' },
      check_count: { kind: 'int', required: true, default: 0 },
      last_check_at: { kind: 'datetime' },
      created_at: { kind: 'datetime', required: true, ...NOW },
    },
    unique: [['token_hash']],
  },

  /*
   * A leaflet's PDF, uploaded in pieces.
   *
   * A file may be 25 MB; a request to a serverless function may not. So the
   * browser announces the file, sends it a few MB at a time, and each piece
   * becomes a file asset (see services/leaflets.js). This document is the
   * index: which pieces, in what order, and whether the upload is finished.
   * The bytes themselves are never in a document.
   */
  leafletFile: {
    table: 'leaflet_files',
    title: 'Leaflet PDF',
    fields: {
      filename: { kind: 'string', required: true },
      size: { kind: 'int', required: true }, // announced when the upload began
      sha256: { kind: 'string', required: true, default: '' }, // set when sealed
      status: { kind: 'string', required: true, enum: ['pending', 'ready'], default: 'pending' },
      received: { kind: 'int', required: true, default: 0 },
      chunks: { kind: 'int', required: true, default: 0 },
      // One entry per piece, in order: the asset holding it, and its digest.
      pieces: {
        kind: 'array',
        required: true,
        default: () => [],
        of: { asset_id: 'string', url: 'string', size: 'number', sha256: 'string' },
      },
      created_at: { kind: 'datetime', required: true, ...NOW },
    },
  },
};

/**
 * Bookkeeping documents the store itself owns. Never shown as data.
 *
 *   counter    the next integer id for each type (SQL's AUTOINCREMENT)
 *   uniqueKey  a claim on one unique value (SQL's UNIQUE)
 *   rateLimit  one sliding-window bucket per limiter key (the old rate_hits)
 */
export const INTERNAL_TYPES = ['counter', 'uniqueKey', 'rateLimit'];

/** Every document type the application writes, bookkeeping included. */
export const ALL_TYPES = [...Object.keys(TYPES), ...INTERNAL_TYPES];

export function spec(type) {
  const s = TYPES[type];
  if (!s) throw new Error(`unknown document type "${type}"`);
  return s;
}

export default { TYPES, INTERNAL_TYPES, ALL_TYPES, spec, now };
