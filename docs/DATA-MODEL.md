# Data model

Fourteen tables. The full DDL, with every constraint and index, is
[`src/db/schema.sql`](../src/db/schema.sql) - this document explains *why* it
is shaped the way it is.

---

## Shape

```
                    products ──< leaflets
                        │
                        v
                    batches ──────< shipments
                        │
                        v
                     codes ──────< scans >──── (channel: web | sms | api)
                        │              │
                        └──────> alerts <────── consumer_reports
                                   │
                              (assigned to)
                                   v
                    users ──< sessions          audit_log     sms_log     settings
```

| Table | Rows grow with | Purpose |
|---|---|---|
| `products` | catalogue size | SKU, name, strength, manufacturer |
| `leaflets` | catalogue x versions | Versioned patient information leaflets |
| `batches` | production runs | One row per run, with its lifecycle status |
| `codes` | **units manufactured** | The code registry. The largest table |
| `scans` | **verification attempts** | Append-only log of every check |
| `alerts` | suspicious events | The security team's work queue |
| `consumer_reports` | patient reports | Direct reports from the portal |
| `shipments` | distribution events | Where each batch was sent |
| `users` | staff | Staff accounts only |
| `sessions` | logins | Server-side session records, for revocation |
| `audit_log` | admin actions | Append-only |
| `sms_log` | SMS traffic | Inbound and outbound messages |
| `settings` | fixed, small | Runtime-tunable values |
| `schema_meta` | 1 | Migration bookkeeping |

---

## Decisions worth explaining

### `codes.scan_count` vs `codes.verified_count`

Two counters, and keeping them separate is load-bearing.

- `scan_count` - every attempt against this code, including failures.
- `verified_count` - attempts that actually returned `genuine`.

Duplicate detection keys off `verified_count`. If it used total attempts, a
single failed scan - say, someone checking a code before its batch was released
- would make the *first genuine patient scan* report as a duplicate, telling
someone their real medicine was counterfeit.

This was a real bug during development and has a named regression test in
`tests/verification.test.js`.

### `batches.is_test`

The field guide's sandbox flag. Scans of a pilot batch are logged in full but
suppressed from every live figure and never raise alerts. Analytics queries
carry `is_test = 0` by default; the dashboard has an explicit opt-in checkbox.

Without this, a pilot run would make the flag rate meaningless for weeks.

### Privacy: nothing identifying is stored raw

`scans.ip_hash` and `scans.msisdn_hash` (and `sms_log.msisdn_hash`) hold a
keyed HMAC digest, never the address or phone number. That still supports "how
many attempts came from one source", which is what guessing detection and the
same-device grace window need, without holding data that identifies a patient.

Location is stored only to city granularity, and only when a CDN supplies it.

### Timestamps are ISO-8601 text

`strftime('%Y-%m-%dT%H:%M:%fZ','now')`. They sort lexicographically, so
`BETWEEN` and `ORDER BY` work directly, and they are readable in a manual
`sqlite3` session during an incident. This also ports to PostgreSQL's
`timestamptz` without a data conversion.

### Enumerations are CHECK constraints

Every status and type column is constrained in the database, not only in
application code. A buggy service, a migration script or a manual session
cannot write a status the application does not understand.

### Foreign key delete behaviour

| Relationship | Behaviour | Why |
|---|---|---|
| `codes` -> `batches` | `CASCADE` | Deleting a batch that was never issued should take its codes |
| `batches` -> `products` | `RESTRICT` | A product with production history cannot be deleted |
| `scans` -> `codes` | `SET NULL` | Scans of unknown codes have no code row at all, and the log is append-only |
| `audit_log` -> `users` | `SET NULL` | The trail must survive account deletion - hence the denormalised `actor_email` |

### Append-only tables

`scans`, `audit_log` and `sms_log` have no update or delete path anywhere in
the application. That is what makes the audit trail admissible during a
track-and-trace inspection.

---

## Indexing

The hot path is one exact-match lookup on a unique text column:

```sql
SELECT ... FROM codes WHERE code = ?
```

`idx_codes_lookup` covers it, and `codes.code` is `UNIQUE`, so the lookup is a
single index seek regardless of registry size.

The scan log is indexed for the four ways it is actually queried:

| Index | Serves |
|---|---|
| `idx_scans_code (code_id, created_at)` | "show me this code's history" |
| `idx_scans_time (created_at)` | the trend chart and date filters |
| `idx_scans_result (result, created_at)` | "recent flagged checks" |
| `idx_scans_ip (ip_hash, created_at)` | guessing detection and the grace window |

---

## Scale

Measured on the development machine (Node 24, SQLite, laptop):

| Operation | Result |
|---|---|
| Issue 1,000 codes | ~38 ms |
| Issue 4,560 codes (full seed, 6 batches) | ~130 ms |
| Verification lookup | sub-millisecond |

Issuance runs in a single transaction with one prepared statement, and code
generation is a lazy generator, so a 100,000-unit batch never materialises in
memory.

Practical SQLite ceiling for this workload is on the order of a few million
codes with WAL enabled. Past that, or as soon as you run more than one
application instance, move to PostgreSQL.

---

## Migrating to PostgreSQL

The schema was written to make this a type-name exercise rather than a redesign.
Nothing above `src/db/index.js` touches the driver - services only use
`db.get/all/run/tx`.

1. **Types**

   | SQLite | PostgreSQL |
   |---|---|
   | `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` |
   | `TEXT` timestamps | `TIMESTAMPTZ` |
   | `INTEGER` booleans (`0`/`1` with a CHECK) | `BOOLEAN` |
   | `sections_json` / `detail_json` as `TEXT` | `JSONB` |

2. **Defaults** - replace `strftime('%Y-%m-%dT%H:%M:%fZ','now')` with `now()`.

3. **Case-insensitive email** - swap `COLLATE NOCASE` on `users.email` for
   `CITEXT`, or a unique index on `lower(email)`.

4. **`json_extract`** - used in one place (guessing-alert deduplication in
   `src/services/verification.js`). Becomes `detail_json->>'ipHash'`.

5. **Rewrite `src/db/index.js`** against `pg`. Keep the same exported
   functions; make `tx()` use a pooled client so a transaction stays on one
   connection.

6. **Partition `scans`** by month once the log gets large. It is append-only
   and almost always queried by date range, which is the ideal case for
   declarative partitioning.
