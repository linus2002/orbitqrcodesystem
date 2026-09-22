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
    "sections": [{ "heading": "How to take it", "body": "..." }]
  },
  "firstVerifiedAt": null,
  "reportable": false
}
```

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

### `GET /api/product/:sku/leaflet`

The current published leaflet for a product. `?lang=en` optional.

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
| `POST /products/:id/leaflets` | `products:write` | Publishes a new leaflet version |

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
| `GET /batches/:id/labels?limit=24` | `codes:read` | Codes plus rendered QR SVG, max 60 |

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

### Alerts

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /alerts` | `alerts:read` | Open work sorts first, then by severity |
| `GET /alerts/counts` | `alerts:read` | For the nav badge |
| `GET /alerts/:id` | `alerts:read` | Plus the scans that produced it |
| `PATCH /alerts/:id` | `alerts:write` | Resolving or dismissing **requires** `note` |

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
