# QR Shield API reference

All endpoints return JSON unless stated otherwise. All timestamps are ISO-8601
UTC strings.

- [Conventions](#conventions)
- [Public endpoints](#public-endpoints)
- [Authentication](#authentication)
- [Admin endpoints](#admin-endpoints)
- [SMS webhook](#sms-webhook)

---

## Conventions

### Errors

Every failure has the same shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Some fields are invalid",
    "details": [{ "field": "code", "message": "is required" }]
  }
}
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed request |
| 401 | `unauthorized` | No session, or an invalid one |
| 403 | `forbidden` | Authenticated, but the role lacks the permission; also a CSRF failure |
| 403 | `details_required` | A check was refused because this browser has not said who is checking (see [`/api/portal/details`](#post-apiportaldetails)) |
| 404 | `not_found` | No such resource |
| 409 | `conflict` | Refused because of current state (e.g. re-issuing codes) |
| 422 | `validation_failed` | Field-level validation; `details` lists every problem at once |
| 429 | `rate_limited` | Rate limited; a `Retry-After` header is set |
| 500 | `server_error` | Unexpected. Carries an `incidentId` matching the server log |

### Authentication

Two mechanisms, both accepted:

- **Cookie** (browser): `qrs_session`, httpOnly, `SameSite=Strict`. State-changing
  requests must also send `X-CSRF-Token`, read from the readable `qrs_csrf` cookie.
- **Bearer** (API clients): `Authorization: Bearer <token>`. Exempt from CSRF,
  because a header token is never attached automatically by a browser.

### Pagination

List endpoints accept `page` (default 1) and `pageSize` (default 25, max 200),
and return:

```json
{ "items": [], "total": 412, "page": 1, "pageSize": 25 }
```

---

## Public endpoints

No authentication. Rate limited per client IP.

### `GET /api/health`

Liveness probe. Returns 200 when the database is reachable, 503 otherwise.

```json
{ "status": "ok", "service": "qr-shield", "time": "2026-09-21T09:14:02.881Z", "uptimeSeconds": 4210 }
```

---

### `POST /api/verify`

**The core endpoint.** Verifies one code.

Rate limit: `RL_VERIFY_PER_MIN` per minute and `RL_VERIFY_PER_HOUR` per hour.

```json
{ "code": "AMX25-260812-088159-BM", "signature": "3QMWZT8K1P" }
```

`signature` is optional - it is the `s` parameter from a scanned QR URL. A
typed code has none, which is not a failure.

While the `portal.require_details` setting is `on` (the default), every
verify endpoint - this one, `GET /api/verify/:code` and `POST /api/verify/bulk` -
refuses with `403 details_required` until the browser has given its details
through [`POST /api/portal/details`](#post-apiportaldetails). A browser that
has given them is recorded against each check, whether the setting is on or
off.

> **Always returns 200 when the code was processed**, including for a detected
> counterfeit. "Flagged" is a successful verification that returned bad news,
> not a transport error. Clients must branch on `result`, not on HTTP status.

**Genuine:**

```json
{
  "result": "genuine",
  "reason": "ok",
  "message": "This pack is genuine. It has been verified for the first time.",
  "code": "AMX25-260812-088159-BM",
  "scanNumber": 1,
  "scanId": 4127,
  "verifiedAt": "2026-09-21T09:14:02.881Z",
  "product": {
    "sku": "AMX25",
    "name": "Amoxicillin",
    "genericName": "Amoxicillin trihydrate",
    "strength": "250 mg",
    "dosageForm": "Capsule",
    "packSize": "21 capsules",
    "manufacturer": "Northbridge Pharmaceuticals"
  },
  "batch": {
    "number": "AMX25-2608A",
    "mfgDate": "2026-08-12",
    "expiryDate": "2028-08-21",
    "daysToExpiry": 701,
    "isExpired": false,
    "expiringSoon": false,
    "recallReason": null
  },
  "leaflet": {
    "version": "1.0",
    "language": "en",
    "sections": [{ "heading": "How to take it", "body": "..." }],
    "pdf": null
  },
  "firstVerifiedAt": null,
  "reportable": false
}
```

`leaflet` is the medicine's **current** leaflet, not the version the batch
was packed with, so a correction reaches packs printed before it. `pdf` is
`null`, or `{ "url", "filename", "size" }` when that version was published
with a PDF; `url` is a path on this server (see
[`GET /api/product/:sku/leaflet.pdf`](#get-apiproductskuleafletpdf)).

**Flagged** - same shape, but `leaflet` is `null`. Official dosing information
is never rendered beside a counterfeit warning.

```json
{
  "result": "flagged",
  "reason": "duplicate_scan",
  "message": "Warning: this code has already been verified elsewhere. ...",
  "scanNumber": 2,
  "leaflet": null,
  "reportable": true
}
```

**Result values**

| `result` | `reason` | Meaning |
|---|---|---|
| `genuine` | `ok` | First verification of a valid, released, in-date code |
| `genuine` | `ok_repeat_same_source` | Same device re-checking within 15 minutes |
| `flagged` | `unknown_code` | Well-formed but not in the registry |
| `flagged` | `duplicate_scan` | Already verified elsewhere |
| `flagged` | `recalled` | Batch recalled; `batch.recallReason` is populated |
| `flagged` | `expired` | Real product, past expiry |
| `flagged` | `not_released` | Code exists but the batch never left QA |
| `flagged` | `void` | Withdrawn by the manufacturer |
| `invalid` | `checksum_failed` | Almost certainly a typo |
| `invalid` | `malformed` | Not in the expected shape |
| `invalid` | `empty` | Nothing submitted |

---

### `GET /api/verify/:code`

Convenience form for the QR deep link. `?s=SIGNATURE` optional. Identical
response to `POST /api/verify`.

---

### `POST /api/verify/bulk`

A pharmacist checking a delivery. Max 100 codes. Rate limit: 20/hour.

```json
{ "codes": ["AMX25-260812-088159-BM", "AMX25-260812-704910-GV"] }
```

```json
{
  "checked": 2,
  "genuine": 1,
  "flagged": 1,
  "invalid": 0,
  "results": [
    { "code": "AMX25-260812-088159-BM", "result": "genuine", "reason": "ok",
      "product": "Amoxicillin", "batch": "AMX25-2608A", "expiryDate": "2028-08-21" }
  ]
}
```

---

### `POST /api/report`

Report a suspect pack. Works whatever the scan said. Rate limit:
`RL_REPORT_PER_HOUR` per hour. Every report raises a **high** severity alert.

```json
{
  "description": "The foil seal was already broken when I bought this pack.",
  "code": "AMX25-260812-088159-BM",
  "scanId": 4127,
  "purchaseLocation": "Roadside stall near Oshodi market",
  "reporterName": "Chidinma A.",
  "reporterContact": "chidinma.a@example.com"
}
```

Only `description` is required (10-2000 characters). Responds `201`:

```json
{
  "ok": true,
  "reference": "RPT-000042",
  "message": "Thank you. Your report has been sent to the brand security team. ..."
}
```

---

### `GET /api/portal`

What the public page shows that staff can change, read fresh on every
request, plus who this browser said it was (`null` if it has not).

```json
{
  "banner": "",
  "supportPhone": "",
  "smsShortcode": "32123",
  "detailsRequired": true,
  "checker": {
    "name": "Maria Santos", "phone": "+639171234567", "email": "maria@example.com",
    "role": "patient", "roleLabel": "Patient", "city": "Quezon City"
  }
}
```

---

### `POST /api/portal/details`

Who is checking. Asked once per browser. Rate limit: 10/hour.

```json
{
  "fullName": "Maria Santos",
  "phone": "0917 123 4567",
  "email": "maria@example.com",
  "role": "patient",
  "city": "Quezon City",
  "purchaseLocation": "Mercury Drug, Cubao",
  "consent": true,
  "policyVersion": "2026-09-25"
}
```

`fullName` (2-120 characters), `phone`, `email`, `role` and `consent` are
required. `phone` is a mobile number: Philippine forms (`0917...`, `63917...`,
`+63917...`) are stored as `+63...`; anything else must be a full
international number. `role` is one of `patient`, `caregiver`, `pharmacist`,
`health_worker`, `retailer`, `other`. `consent` must be true. A `422` lists
every problem at once.

Responds `201` with `{ "ok": true, "checker": { ... } }` (the shape above) and
sets `qrs_checker`: an httpOnly, `SameSite=Lax` cookie kept for 180 days. The
cookie holds a random token; only a keyed digest of it is stored.

The details are stored as given (name, mobile, email in readable form) so
the person can be contacted about an unsafe pack. Staff see them under
[Customers](#customers).

---

### `DELETE /api/portal/details`

"Not you?" - clears this browser's `qrs_checker` cookie so the form is asked
again. Responds `204`. The stored record is **not** deleted.

---

### `GET /api/product/:sku/leaflet`

A medicine's leaflet, for the page the leaflet QR opens. `?lang=en` optional.
`?version=` names an older version; without it, the current one.

The newest version is the current one: publishing a new version is what
supersedes the old. An older version comes back with `superseded: true`, so
the page can warn before showing it.

```json
{
  "product": {
    "sku": "BEL25", "name": "Beltro", "strength": "25 mg",
    "dosageForm": "Tablet", "manufacturer": "Getmeds"
  },
  "leaflet": {
    "version": "2.0",
    "language": "en",
    "effectiveFrom": "2026-09-24T02:10:00.000Z",
    "sections": [{ "heading": "Dosage", "body": "..." }],
    "superseded": false,
    "pdf": { "url": "/api/product/BEL25/leaflet.pdf", "filename": "beltro.pdf", "size": 482113 }
  },
  "history": [
    { "version": "2.0", "effectiveFrom": "2026-09-24T02:10:00.000Z", "current": true, "hasPdf": true },
    { "version": "1.0", "effectiveFrom": "2026-08-01T00:00:00.000Z", "current": false, "hasPdf": false }
  ]
}
```

`sections` may be empty when a version was published as a PDF only. `404`
when the product does not exist, has no leaflet, or has no such version.

---

### `GET /api/product/:sku/leaflet.pdf`

The leaflet as the uploaded PDF, sent inline (`application/pdf`) so a phone
opens it in its viewer. Same `?lang=` and `?version=` as above. `404` when
that version was published as text only.

---

## Authentication

### `POST /api/auth/login`

Rate limit: `RL_LOGIN_PER_15MIN` per 15 minutes, keyed on IP **and** email.

```json
{ "email": "admin@qrshield.example", "password": "ChangeMe!2026" }
```

```json
{
  "user": {
    "id": 1, "email": "admin@qrshield.example", "fullName": "Adaeze Okonkwo",
    "role": "admin", "status": "active", "mustChangePassword": false,
    "permissions": ["dashboard:view", "products:read", "..."]
  },
  "csrfToken": "szIIZHWOqgUT...",
  "expiresAt": "2026-09-21T17:14:02.881Z"
}
```

Failures return `401` with an identical message whether the account exists or
the password was wrong, so the endpoint cannot be used to enumerate accounts.
After `LOGIN_MAX_FAILURES` failures the account locks and returns `429`.

### `POST /api/auth/logout`

Revokes the session server-side and clears the cookies.

### `GET /api/auth/me`

Current user, CSRF token and session expiry.

### `POST /api/auth/change-password`

```json
{ "currentPassword": "...", "newPassword": "..." }
```

Signs out every **other** session on success.

### `PATCH /api/auth/profile`

Change your own display name and picture. Nothing else: role, status and
email stay with an administrator.

```json
{ "fullName": "Adaeze Okonkwo", "avatar": "data:image/jpeg;base64,/9j/4AAQ..." }
```

Both fields are optional. `fullName` is 1-120 characters and cannot be
blank. `avatar` is a JPEG, PNG or WebP data URL of at most 200KB, or `null`
to remove it; SVG and links to other sites are refused with `400`. Returns
`{ "user": { ... } }`. The audit log records that the picture changed, not
the picture.

### `GET /api/auth/sessions`

Open sessions for the current user, with `current: true` on this one.

---

## Admin endpoints

All under `/api/admin`, all authenticated, each gated on a named permission.

### The role matrix

| Permission | admin | security | regulator |
|---|:--:|:--:|:--:|
| `dashboard:view` | Y | Y | Y |
| `products:read` | Y | Y | Y |
| `products:write` | Y | Y | - |
| `batches:read` | Y | Y | Y |
| `batches:write` | Y | Y | - |
| `codes:read` / `codes:export` | Y | Y | - |
| **`scans:read`** | Y | Y | **-** |
| `alerts:read` / `alerts:write` | Y | Y | - |
| `reports:read` / `reports:write` | Y | Y | - |
| `audit:read` | Y | Y | - |
| `users:read` / `users:write` | Y | - | - |
| `settings:write` | Y | - | - |

A regulator holding no `scans:read` is a deliberate compliance boundary: they
get aggregate serialization figures, never individual patient scans.

### Dashboard

| Endpoint | Permission | Returns |
|---|---|---|
| `GET /overview?days=30` | `dashboard:view` | Headline counts, trend series, top flagged batches, geography |
| `GET /trend?days=14` | `dashboard:view` | Daily genuine/flagged/invalid series, zero-filled |

### Products

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /products` | `products:read` | With batch and code counts |
| `POST /products` | `products:write` | `sku`, `name`, `manufacturer` required |
| `GET /products/:id` | `products:read` | Plus leaflets and batches |
| `PATCH /products/:id` | `products:write` | SKU is immutable - it is in every printed code |
| `POST /products/:id/leaflets` | `products:write` | Publishes a new leaflet version; see below |
| `POST /leaflet-files` | `products:write` | Starts a PDF upload: `{ "name", "size" }`, at most 25 MB |
| `PUT /leaflet-files/:id/chunks/:seq` | `products:write` | One piece of it; see below |

**Publishing a leaflet**

```json
{
  "version": "2.0",
  "language": "en",
  "reason": "Updated renal dosing after the September FDA advisory",
  "sections": [{ "heading": "Dosage", "body": "..." }],
  "pdf": { "fileId": 7 },
  "alsoApplyTo": [12]
}
```

`version` and `reason` (5-300 characters) are required. A leaflet needs
`sections` (at most 40, each with a `heading` and a `body`), a finished PDF
upload, or both; with neither it is refused with `400`. `language` defaults
to `en`.

`alsoApplyTo` lists the ids of other products the same document covers (for
example two strengths of one medicine). One leaflet row is written per
product, all in one transaction, so they never disagree. `409` if any of them
already has that version in that language, naming which. The new version
becomes the current one for every product it covers.

Responds `201` with the named product's new leaflet, plus
`coverage: [{ "leafletId", "productId", "sku" }]` and
`pdf: { "filename", "size" } | null`. The audit log gets one `leaflet.publish`
entry per product, each with the reason and the full list of SKUs covered.

**Uploading the PDF.** A request cannot carry 25 MB, so the file goes up in
pieces before the publish. `POST /leaflet-files` answers
`{ "fileId", "chunkBytes" }`. Each piece is then sent as the raw request body
(`Content-Type: application/pdf` or `application/octet-stream`), at most
3 MB, in order from `seq` 0; the first piece must start with `%PDF-`. Each
answers `{ "fileId", "received", "size", "complete" }`. When `complete` is
true, publish with `"pdf": { "fileId" }`. An upload never published is
dropped after a day.

### Batches

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /batches` | `batches:read` | `?status=`, `?search=`, `?includeTest=true` |
| `POST /batches` | `batches:write` | Creates in `planned` |
| `GET /batches/:id` | `batches:read` | Plus code stats, shipments, open alert count |
| `POST /batches/:id/issue-codes` | `batches:write` | Runs serialization. **409 if already issued** |
| `POST /batches/:id/transition` | `batches:write` | `{ "to": "released" }`; recall requires `reason` |
| `GET /batches/:id/codes` | `codes:read` | Paged |
| `GET /batches/:id/codes.csv` | `codes:export` | The packaging-line hand-off file |
| `GET /batches/:id/labels?limit=12&offset=0` | `codes:read` | Codes plus rendered QR SVG, at most 60 per request; `total` is the batch's code count, for paging through a whole batch |

Legal transitions:

```
planned -> codes_issued -> printed -> released -> distributed -> closed
                              \           \            \
                               `-----------+------------+--> recalled -> closed
```

Anything else returns `409` listing what is allowed.

### Codes

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /codes/lookup?code=...` | `codes:read` | Full history: scans, alerts, QR payload |
| `POST /codes/:id/void` | `batches:write` | Requires `reason` |
| `GET /codes/:id/qr.svg` | `codes:read` | `image/svg+xml` |

### Scans

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /scans` | `scans:read` | `?result=`, `?reason=`, `?channel=`, `?batchId=`, `?from=`, `?to=` |
| `GET /scans.csv` | `scans:read` | Export, max 5000 rows |

Raw IP addresses are never returned. They exist server-side only as a keyed
one-way digest.

### Customers

The people who gave their details on the portal. Behind `scans:read`, like
the scan log, because these rows name individual people; a regulator gets
aggregates only.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /customers` | `scans:read` | Paged, newest first. `?search=` (name, email or mobile), `?role=`, `?from=`, `?to=` |
| `GET /customers.csv` | `scans:read` | Export, max 5000 rows. Recorded in the audit log |
| `GET /customers/:id` | `scans:read` | One person plus their 25 most recent checks |

Each row has the name, mobile number and email as given, role, city, where
they bought the medicine, when they consented and to which notice, how many
checks they have made and when they last checked. The cookie token is never
returned.

### Alerts

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /alerts` | `alerts:read` | Open work sorts first, then by severity |
| `GET /alerts/counts` | `alerts:read` | For the nav badge |
| `GET /alerts/:id` | `alerts:read` | Plus the scans that produced it |
| `PATCH /alerts/:id` | `alerts:write` | Resolving or dismissing **requires** `note` |
| `POST /alerts/:id/false-positive` | `alerts:write` | `{ "reason" }`: clear the code's flag and resolve the alert |
| `POST /alerts/:id/void-code` | `alerts:write` and `batches:write` | `{ "reason" }`: void the code and resolve the alert |

The last two act on the alert's code. Each changes the code and resolves the
alert in one transaction, so neither can happen without the other.
`reason` (5-300 characters) becomes the alert's resolution note and goes into
the audit log. Both answer `{ "alert": { ... }, "codeStatus": { "from", "to" } }`.

- **False positive** returns a flagged code to the status its history
  implies (`verified` if it was ever verified, otherwise what its batch
  implies; a recalled batch stays `recalled`). It changes nothing a patient
  sees: a second device scanning afterwards is flagged again, as before.
  `409` for a voided code.
- **Void**: every later scan of the code is flagged as withdrawn (`void`).

Both refuse with `409` when the alert is already closed, and with `400` when
the alert has no code (an `unknown_code` alert). Neither changes the scan
counts or the scan history.

Alert types: `duplicate_scan`, `unknown_code`, `recalled_scan`, `expired_scan`,
`guess_attack`, `consumer_report`, `batch_anomaly`.

### Reports, shipments, users, audit

| Endpoint | Permission |
|---|---|
| `GET /reports`, `PATCH /reports/:id` | `reports:read` / `reports:write` |
| `GET /shipments`, `POST /shipments`, `PATCH /shipments/:id/receive` | `batches:read` / `batches:write` |
| `GET /users`, `POST /users`, `PATCH /users/:id`, `POST /users/:id/reset-password` | `users:read` / `users:write` |
| `GET /audit` | `audit:read` |

`POST /users/:id/reset-password` returns a generated temporary password
**once**. It is never stored in readable form.

### Compliance

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /compliance?from=&to=` | `batches:read` | Aggregates only |
| `GET /compliance.csv?from=&to=` | `batches:read` | Batch register export |

```json
{
  "period": { "from": "2026-03-25", "to": "2026-09-21" },
  "serialization": { "batches": 4, "unitsSerialized": 3900, "unitsPlanned": 3900, "recalledBatches": 1 },
  "verification": { "totalChecks": 408, "genuine": 319, "flagged": 62 },
  "alerts": [{ "type": "duplicate_scan", "status": "open", "n": 4 }],
  "batches": []
}
```

### Settings

| Endpoint | Permission |
|---|---|
| `GET /settings` | `dashboard:view` |
| `PATCH /settings/:key` | `settings:write` |

`GET /settings` returns each setting with its current value, plus the
server's runtime facts (environment, public base URL, SMS provider, rate
limits, session length). `PATCH` takes `{ "value": ... }`. Only these keys
exist; any other is refused with `400`, and every change is audited with the
value before and after.

| Key | Accepts | Default |
|---|---|---|
| `portal.banner` | Text, at most 200 characters; empty shows nothing | empty |
| `support.phone` | 3-30 characters: digits, spaces, `+ ( ) -`, letters | empty |
| `support.sms_shortcode` | 3-8 digits | `32123` |
| `alerts.duplicate_threshold` | 1-3: how many devices may verify one pack before it is flagged | `1` |
| `portal.require_details` | `on` or `off`: ask who is checking before any check | `on` |

### Leaflet QR codes

One per medicine, pointing at its leaflet page (`/leaflet/:sku`). They are
plain links, not signed, and say nothing about whether a pack is genuine.
The address never changes, so a printed code always opens the current
version.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /leaflet-codes?lang=en` | `products:read` | Every product with its QR address; `missing` counts products with no leaflet yet |
| `GET /leaflet-codes/:sku.svg` | `products:read` | The QR as SVG. `?width=` 80-1024 (default 240), `?download=1` |
| `GET /leaflet-codes/sheet?lang=en` | `products:read` | Print sheet: each product that has a leaflet, with its QR |

These, and the batch label sheet, carry a `warning` when the server's public
base URL is a local address, because a code printed that way leads nowhere.

### Spreadsheets

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /export/products.xlsx` | `products:read` | The product list as a workbook |
| `GET /export/batches.xlsx` | `batches:read` | The batch list as a workbook |
| `GET /import/template.xlsx` | `products:read` | The accepted headings, with one example row per sheet |
| `POST /import/products` | `products:write` | See below |
| `POST /import/batches` | `batches:write` | See below |

An import's request body is the file itself (`.xlsx` or `.csv`, at most
8 MB), not a form. `?dryRun=1` checks it and reports without writing. The
answer is `{ "entity", "dryRun", "created", "updated", "errors", "rows" }`;
each error is `{ "row", "message" }`. Rows with a problem are skipped and the
rest are written.

A product whose SKU already exists is updated. A batch number that already
exists is refused, because a batch number names a production run. Codes are
never imported: they are made and signed by this system. Exports and
imports are recorded in the audit log.

---

## SMS webhook

### `POST /api/sms/inbound`

Public but protected by a shared secret, sent either as `?key=` or the
`X-Webhook-Secret` header, compared in constant time. Rate limit: 60/minute.

Accepts JSON `{ "from", "body" }` or Twilio's form encoding (`From` / `Body`).

```json
{ "ok": true, "reply": "GENUINE. This pack is authentic. Amoxicillin 250 mg Expires 2028-08-21",
  "result": "genuine", "reason": "ok" }
```

With `?format=twiml`, or when Twilio's `MessageSid` is present, responds with
TwiML so the reply is delivered in the same HTTP round trip:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>GENUINE. This pack is authentic. ...</Message></Response>
```

Replies are capped at 320 characters (two GSM-7 segments). Phone numbers are
stored only as a keyed digest.
