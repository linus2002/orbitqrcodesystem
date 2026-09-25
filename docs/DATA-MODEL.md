# Data model

Thirteen document types in one Sanity dataset. They are defined in
[`src/db/schema.js`](../src/db/schema.js) - required fields, enumerations,
defaults and unique keys - and that file is the only definition: the store
layer validates every write against it, and the Studio schema is generated
from it. This document explains *why* the model is shaped the way it is.

---

## Shape

```
                    product ──< leaflet
                        │
                        v
                     batch ──────< shipment
                        │
                        v
                      code ──────< scan >──── (channel: web | sms | api)
                        │              │
                        └──────> alert <────── consumerReport
                                   │
                              (assigned to)
                                   v
                      user ──< session          auditLog     smsLog     setting
```

| Type | Grows with | Purpose |
|---|---|---|
| `product` | catalogue size | SKU, name, strength, manufacturer |
| `leaflet` | catalogue x versions | Versioned patient information leaflets |
| `batch` | production runs | One per run, with its lifecycle status |
| `code` | **units manufactured** | The code registry. The largest type |
| `scan` | **verification attempts** | Append-only log of every check |
| `alert` | suspicious events | The security team's work queue |
| `consumerReport` | patient reports | Direct reports from the portal |
| `shipment` | distribution events | Where each batch was sent |
| `user` | staff | Staff accounts only |
| `session` | logins | Server-side session records, for revocation |
| `auditLog` | admin actions | Append-only |
| `smsLog` | SMS traffic | Inbound and outbound messages |
| `setting` | fixed, small | Runtime-tunable values |

Three more types are the store's own bookkeeping, never shown as data:
`counter` (the next integer id per type), `uniqueKey` (a claim on one unique
value) and `rateLimit` (one sliding-window bucket per limiter key).

---

## How a relational model lives in a document store

The rows kept their SQL shape - snake_case fields and an integer `id` - so the
API, the React client and every service read exactly what they always did.
What SQL used to guarantee is now guaranteed by `src/db/index.js`:

| SQL had | Now |
|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | A `counter` document per type, incremented atomically by the Lake. Ids are reserved outside transactions, like a sequence: a failed write leaves a gap, never a reused id. |
| `UNIQUE` | A `uniqueKey` claim document with a deterministic `_id`, created in the same transaction as the row. A second row with the same value fails the whole transaction - no check-then-insert race. |
| `NOT NULL`, `CHECK`, `DEFAULT` | Validated on every insert and update against `schema.js`. An unknown field is refused too, so a typo cannot silently vanish. |
| Transactions | `db.tx(fn)` buffers every write in `fn` and commits them as one Sanity transaction. Reads inside see committed data only. |
| Foreign keys | Plain integer fields (`batch_id`), not Sanity references - a strong reference would block the deletes SQL allowed with `SET NULL`, and the append-only logs must outlive what they name. The services own the integrity rules, as they already checked existence before every write. |
| Indexes | Document ids chosen for the hot paths (below). |

### Document ids

`<type>-<id>` - `batch-12`, `user-3` - so a row is fetched by id without a
query. The exception is a code, whose document id is **the code itself**
(`code-AMX25-260921-087498-Z7`): the verification lookup is by the printed
code, so the hottest read in the system is a direct fetch however large the
registry grows, and a duplicate code is impossible by construction.

### Aggregates without GROUP BY

GROQ has no `GROUP BY`. Every dashboard figure is a `count()` computed by the
Lake - never documents fetched and counted in Node - and a grouped figure (by
day, by country, by batch) is found in two steps: the distinct keys, then one
count per key, in a single request. See
[`src/services/analytics.js`](../src/services/analytics.js).

### Operations that are not atomic

Two operations can outgrow a single Sanity transaction, and are written so
that a partial run is harmless:

- **Issuing codes** writes them in chunks, each with `createIfNotExists`, and
  marks the batch `codes_issued` only after the last. Issuance is
  deterministic, so an interrupted run is finished by running it again.
- **A batch transition** relabels the batch's codes first, then the batch.
  Verification decides from the batch status, not the per-code label, so a
  half-relabelled batch changes no scan result, and the transition can simply
  be repeated.

---

## Decisions worth explaining

### `code.scan_count` vs `code.verified_count`

Two counters, and keeping them separate is load-bearing.

- `scan_count` - every attempt against this code, including failures.
- `verified_count` - attempts that actually returned `genuine`.

Duplicate detection keys off `verified_count`. If it used total attempts, a
single failed scan - say, someone checking a code before its batch was released
- would make the *first genuine patient scan* report as a duplicate, telling
someone their real medicine was counterfeit.

This was a real bug during development and has a named regression test in
`tests/verification.test.js`.

### `batch.is_test`

The field guide's sandbox flag. Scans of a pilot batch are logged in full but
suppressed from every live figure and never raise alerts. Analytics queries
carry `is_test = 0` by default; the dashboard has an explicit opt-in checkbox.

Without this, a pilot run would make the flag rate meaningless for weeks.

### Privacy: nothing identifying is stored raw

`scan.ip_hash` and `scan.msisdn_hash` (and `smsLog.msisdn_hash`) hold a
keyed HMAC digest, never the address or phone number. That still supports "how
many attempts came from one source", which is what guessing detection and the
same-device grace window need, without holding data that identifies a patient.

Location is stored only to city granularity, and only when a CDN supplies it.

### Timestamps are ISO-8601 text

`2026-09-21T14:03:11.412Z`, always UTC with milliseconds. They sort
lexicographically, so GROQ range filters and `order()` work on them directly.

### Enumerations are enforced on write

Every status and type field is checked against its list in `schema.js` by
the store layer on every insert and update. A buggy service or an import
script cannot write a status the application does not understand. (The
Studio is read-only for the same reason: an edit there would bypass it.)

### Append-only tables

`scan`, `auditLog` and `smsLog` documents have no update or delete path
anywhere in the application. That is what makes the audit trail admissible during a
track-and-trace inspection.

---

## Scale

Every code and every scan is one document, so the dataset grows with units
manufactured and with verifications. Check the Sanity plan's document limit
against the volume you intend to issue before a large batch, and export the
dataset on a schedule (see DEPLOY.md).
