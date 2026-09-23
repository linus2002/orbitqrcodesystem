-- ===========================================================================
-- QR Shield - database schema
--
-- Target: SQLite (via Node's built-in node:sqlite). The DDL deliberately
-- sticks to portable ANSI constructs so the same model moves to PostgreSQL
-- with only type-name changes (TEXT timestamps -> timestamptz, INTEGER
-- PRIMARY KEY -> BIGSERIAL). See docs/DATA-MODEL.md for the migration notes.
--
-- Conventions
--   * All timestamps are ISO-8601 UTC strings: '2026-09-21T14:03:11.412Z'.
--     They sort lexicographically, which is what makes range queries work.
--   * Enumerations are enforced with CHECK constraints, so bad data cannot be
--     written even by a buggy caller or a manual sqlite3 session.
--   * Every table that the security team can act on carries created_at so the
--     audit trail is reconstructable.
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- users: only staff have accounts. Patients and pharmacists never log in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  full_name       TEXT    NOT NULL,
  password_hash   TEXT    NOT NULL,          -- scrypt$N$r$p$salt$hash
  role            TEXT    NOT NULL CHECK (role IN ('admin', 'security', 'regulator')),
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- Brute-force protection state
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_login_at   TEXT,
  must_change_pw  INTEGER NOT NULL DEFAULT 0 CHECK (must_change_pw IN (0, 1)),
  created_by      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- sessions: server-side record backing each signed token, so that logout and
-- "revoke this session" actually work. A token whose row is gone is dead.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,           -- random, also the token's `sid`
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token  TEXT    NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT    NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- products: the catalogue. sku feeds the first segment of every code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sku           TEXT    NOT NULL UNIQUE,     -- e.g. 'AMX25'
  name          TEXT    NOT NULL,            -- e.g. 'Amoxicillin'
  generic_name  TEXT,
  strength      TEXT,                        -- e.g. '250 mg'
  dosage_form   TEXT,                        -- e.g. 'Capsule'
  pack_size     TEXT,                        -- e.g. '21 capsules'
  manufacturer  TEXT    NOT NULL,
  category      TEXT,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'discontinued')),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products (sku);

-- ---------------------------------------------------------------------------
-- leaflets: the patient information leaflet shown on a genuine result.
-- Versioned, because a leaflet correction must never silently rewrite what an
-- earlier batch shipped with.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leaflets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  version        TEXT    NOT NULL,
  language       TEXT    NOT NULL DEFAULT 'en',
  -- JSON array: [{ "heading": "Dosage", "body": "..." }, ...]
  sections_json  TEXT    NOT NULL,
  effective_from TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (product_id, version, language)
);
CREATE INDEX IF NOT EXISTS idx_leaflets_product ON leaflets (product_id, language);

-- ---------------------------------------------------------------------------
-- batches: one production run. The lifecycle column drives what a scan of a
-- unit from this batch is allowed to return.
--
--   planned      created, no codes issued yet
--   codes_issued serialization engine has minted the unit codes
--   printed      packaging line confirmed the print run
--   released     QA released the batch; units may legitimately be scanned
--   distributed  shipped to distributors/pharmacies
--   recalled     any scan must warn the patient
--   closed       archived
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_number   TEXT    NOT NULL UNIQUE,
  product_id     INTEGER NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  mfg_date       TEXT    NOT NULL,           -- YYYY-MM-DD
  expiry_date    TEXT    NOT NULL,           -- YYYY-MM-DD
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  serial_width   INTEGER NOT NULL DEFAULT 5,
  status         TEXT    NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','codes_issued','printed','released','distributed','recalled','closed')),
  -- Sandbox flag from the field guide: pilot/test scans must never pollute the
  -- live security dashboard.
  is_test        INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  leaflet_id     INTEGER REFERENCES leaflets (id) ON DELETE SET NULL,
  codes_issued_at TEXT,
  printed_at     TEXT,
  released_at    TEXT,
  recalled_at    TEXT,
  recall_reason  TEXT,
  notes          TEXT,
  created_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_batches_product ON batches (product_id);
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches (status);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON batches (expiry_date);

-- ---------------------------------------------------------------------------
-- codes: the code registry. One row per physical unit. This is the largest
-- table in the system, so it is kept narrow and its lookup index is covering.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS codes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,     -- 'AMX25-260921-087498-Z7'
  batch_id      INTEGER NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  unit_index    INTEGER NOT NULL,            -- position in the batch, 0-based
  serial        TEXT    NOT NULL,            -- the permuted serial segment
  status        TEXT    NOT NULL DEFAULT 'issued'
                CHECK (status IN ('issued','printed','released','verified','flagged','recalled','void')),
  -- scan_count     = every attempt against this code, including failed ones.
  -- verified_count = attempts that actually returned 'genuine'.
  -- These MUST stay separate: duplicate detection keys off verified_count, so
  -- that a failed scan (e.g. of a not-yet-released batch) can never cause the
  -- first legitimate patient scan to be reported as a duplicate.
  scan_count    INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  first_scan_at TEXT,
  last_scan_at  TEXT,
  flagged_at    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (batch_id, unit_index)
);
-- The single hottest query in the system: exact-match lookup on verification.
CREATE INDEX IF NOT EXISTS idx_codes_lookup ON codes (code);
CREATE INDEX IF NOT EXISTS idx_codes_batch ON codes (batch_id, status);
CREATE INDEX IF NOT EXISTS idx_codes_status ON codes (status);

-- ---------------------------------------------------------------------------
-- scans: every verification attempt, valid or not. Append-only by policy.
--
-- PRIVACY: we never store a raw IP address or phone number. Both are stored
-- as a keyed one-way digest (see lib/crypto.js pseudonymize), which still
-- supports "how many attempts from this source" without holding the identity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code_text    TEXT    NOT NULL,             -- exactly what was submitted
  code_id      INTEGER REFERENCES codes (id) ON DELETE SET NULL,  -- NULL if unknown
  batch_id     INTEGER REFERENCES batches (id) ON DELETE SET NULL,
  product_id   INTEGER REFERENCES products (id) ON DELETE SET NULL,
  result       TEXT    NOT NULL CHECK (result IN ('genuine', 'flagged', 'invalid')),
  reason       TEXT    NOT NULL,             -- see services/verification.js REASONS
  channel      TEXT    NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'sms', 'api')),
  signature_state TEXT CHECK (signature_state IN ('valid', 'invalid', 'absent')),
  scan_number  INTEGER,                      -- 1 for the first scan of this code
  ip_hash      TEXT,                         -- pseudonymised, never the raw IP
  msisdn_hash  TEXT,                         -- pseudonymised phone, SMS channel
  user_agent   TEXT,
  country      TEXT,
  region       TEXT,
  city         TEXT,
  is_test      INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_scans_code ON scans (code_id, created_at);
CREATE INDEX IF NOT EXISTS idx_scans_time ON scans (created_at);
CREATE INDEX IF NOT EXISTS idx_scans_result ON scans (result, created_at);
CREATE INDEX IF NOT EXISTS idx_scans_ip ON scans (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_scans_batch ON scans (batch_id, created_at);

-- ---------------------------------------------------------------------------
-- alerts: the security team's work queue. Created by the verification service
-- whenever a scan is suspicious, and worked through the admin dashboard.
-- Per the field guide, a flag NEVER triggers an automatic recall.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT    NOT NULL
                  CHECK (type IN ('duplicate_scan','unknown_code','recalled_scan','expired_scan',
                                  'guess_attack','consumer_report','batch_anomaly')),
  severity        TEXT    NOT NULL DEFAULT 'medium'
                  CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status          TEXT    NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  title           TEXT    NOT NULL,
  detail_json     TEXT,                      -- structured context for the UI
  code_id         INTEGER REFERENCES codes (id) ON DELETE SET NULL,
  batch_id        INTEGER REFERENCES batches (id) ON DELETE SET NULL,
  scan_id         INTEGER REFERENCES scans (id) ON DELETE SET NULL,
  assigned_to     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  resolution_note TEXT,
  resolved_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  resolved_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status, severity, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_code ON alerts (code_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts (type, created_at);

-- ---------------------------------------------------------------------------
-- consumer_reports: the field guide's "direct report, bypassing the portal"
-- path. A patient can report a suspect pack whatever the scan said.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consumer_reports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code_text         TEXT,
  code_id           INTEGER REFERENCES codes (id) ON DELETE SET NULL,
  scan_id           INTEGER REFERENCES scans (id) ON DELETE SET NULL,
  alert_id          INTEGER REFERENCES alerts (id) ON DELETE SET NULL,
  reporter_name     TEXT,
  reporter_contact  TEXT,                    -- optional email/phone for follow-up
  purchase_location TEXT,
  description       TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'reviewing', 'closed')),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON consumer_reports (status, created_at);

-- ---------------------------------------------------------------------------
-- shipments: the distribution leg. Lets a pharmacist confirm what they were
-- sent, and lets the security team narrow a cluster of flags to a route.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reference     TEXT    NOT NULL UNIQUE,
  batch_id      INTEGER NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  from_site     TEXT    NOT NULL,
  to_name       TEXT    NOT NULL,
  to_type       TEXT    NOT NULL DEFAULT 'pharmacy'
                CHECK (to_type IN ('distributor', 'pharmacy', 'hospital')),
  to_region     TEXT,
  status        TEXT    NOT NULL DEFAULT 'in_transit'
                CHECK (status IN ('in_transit', 'received', 'disputed')),
  shipped_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  received_at   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_shipments_batch ON shipments (batch_id);

-- ---------------------------------------------------------------------------
-- audit_log: who did what, in the admin surface. Append-only; there is no
-- update or delete path to this table anywhere in the application.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  actor_email  TEXT,                         -- denormalised: survives user deletion
  action       TEXT    NOT NULL,             -- 'batch.release', 'user.create', ...
  entity_type  TEXT,
  entity_id    TEXT,
  detail_json  TEXT,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, created_at);

-- ---------------------------------------------------------------------------
-- sms_log: inbound code checks and outbound replies on the SMS fallback.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  direction   TEXT    NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  msisdn_hash TEXT    NOT NULL,              -- pseudonymised phone number
  body        TEXT    NOT NULL,
  scan_id     INTEGER REFERENCES scans (id) ON DELETE SET NULL,
  provider    TEXT,
  status      TEXT    NOT NULL DEFAULT 'ok',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_time ON sms_log (created_at);

-- ---------------------------------------------------------------------------
-- settings: runtime-tunable values the security team can change without a
-- redeploy (alert thresholds, maintenance banner, ...).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- schema_meta: migration bookkeeping.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- rate_hits: rate-limiting state.
--
-- In a single long-running process these counters live in memory. On a
-- serverless platform each request may land on a different instance, so the
-- counters have to be shared or the limits mean nothing: login lockout and the
-- code-guessing alert are security controls, not conveniences.
--
-- One row per hit, matching the sliding window the limiter implements. Rows
-- are pruned opportunistically, so this table stays small.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_hits (
  key TEXT   NOT NULL,
  -- BIGINT, not INTEGER: this holds Date.now() in milliseconds, which passed
  -- 2^31 in 2001. SQLite's INTEGER is 8 bytes and hides that, but Postgres
  -- INTEGER is 4 and rejects the value outright, taking every rate-limited
  -- endpoint down with it.
  ts  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_hits_key_ts ON rate_hits (key, ts);
