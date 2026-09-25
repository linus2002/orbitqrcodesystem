# QR Shield

An anti-counterfeit verification system for healthcare products. A patient
scans the QR code on a medicine pack, or types the code from under the scratch
panel, and gets an immediate answer: **genuine**, **flagged**, or **check the
code you typed**. Behind that, a brand security team gets a serialization
engine, a scan log, an alert queue, and an audit trail.

Built as a working prototype from the *QR Shield Field Guide*, which remains
the specification of record for the workflow and terminology used here.

**Stack:** React 19 + Vite on the front, Express 5 on the back, and a
**Sanity** dataset as the database. Without Sanity credentials it runs on a
local file, so development and the tests need no account, network or server.

---

## Table of contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Try it](#try-it)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [Testing](#testing)
- [Connecting real QR printing and SMS](#connecting-real-qr-printing-and-sms)
- [Deployment](#deployment)
- [Further documentation](#further-documentation)

---

## What it does

**For a patient or pharmacist** (no account, no app):

- scan a QR with the phone camera, or type the code
- get a plain-language verdict plus batch, expiry and the patient information
  leaflet
- report a suspect pack directly, whatever the scan said
- check by SMS where there is no data connection

**For the brand security team** (authenticated):

- create products and batches, and issue one unique, non-sequential code per
  unit
- export the code list as CSV for the packaging line's printer, or print real
  scannable label sheets
- walk a batch through its lifecycle: `planned -> codes_issued -> printed ->
  released -> distributed`, with `recalled` available from any live state
- work an alert queue of duplicate scans, unknown codes, recalled-batch scans
  and code-guessing bursts
- trace any single code through its entire scan history
- read a complete, append-only audit log

**For a regulator** (authenticated, restricted):

- aggregate serialization and verification reporting for track-and-trace
  compliance, with **no access to individual patient scans** - enforced by the
  API, not just hidden in the UI

---

## Quick start

Requires **Node.js 22.5 or newer** (24 recommended). Nothing else is needed to
start: with no Sanity credentials the app keeps its data in a local file
(`data/qrshield.json`). See [Data: Sanity](#data-sanity) to use the real
dataset.

```bash
npm install
npm run setup     # generates .env with real secrets, loads demo data locally
npm run build     # builds the React frontend into dist/
npm start
```

For day-to-day development use `npm run dev` instead of the last two commands.
That runs the API and the Vite dev server together, with hot module
replacement; open the Vite URL it prints (port 5173), which proxies `/api` to
the API server so cookies and same-origin requests behave exactly as they do
in production.

Then open the app on the port in your `.env` (`PORT`, default 3000).

> This checkout is configured for **port 4000**, because port 3000 was already
> in use on the machine it was built on. If you change `PORT`, change
> `PUBLIC_BASE_URL` to match - that URL is what gets encoded into QR codes, so
> a mismatch produces QR codes that point at the wrong host.

### Data: Sanity

All data - products, leaflets, batches, the code registry, scans, alerts,
users, sessions, the audit log - lives in a Sanity dataset. The server talks
to it with a token; **the browser never does**, and nothing identifying the
project ever reaches it:

- `SANITY_PROJECT_ID`, `SANITY_DATASET` and `SANITY_API_TOKEN` are read by the
  Node server only (`src/config.js`). No endpoint returns them, and Vite only
  bundles variables prefixed `VITE_`, so they cannot leak into the client.
- They live in `.env` locally and in the host's environment settings in
  production. `.env` is git-ignored; never commit them.
- The dataset must be **private**, and the project should list **no CORS
  origin** for the web app, so the project id on its own reads nothing.

To connect:

1. At [sanity.io/manage](https://www.sanity.io/manage), open the project, then
   **API -> Tokens -> Add API token** with **Editor** permissions.
2. Put it in `.env` as `SANITY_API_TOKEN` (the project id and dataset are
   already there). Treat it like a password.
3. Make the dataset private: `cd studio && npx sanity login && npx sanity
   dataset visibility set production private`.
4. `npm run db:migrate` checks the connection and refuses a public dataset.
5. Create the first administrator: `npm run user:create -- --email ... --name
   "..." --password "..."`. (`npm run db:seed` loads demo data but WIPES the
   dataset first, so it refuses against Sanity unless
   `ALLOW_DESTRUCTIVE_RESET=1` is set - use it on a throwaway dataset only.)

Moving from an existing SQL database (Supabase, Turso or a SQLite file)?
`npm run db:import-sql -- --from postgres|turso|<file>` copies every row
across with its id intact; add `--to-file data/rehearsal.json` to try it
locally first. It is safe to re-run.

**The Studio** (`studio/`) is a read-only view of the dataset for staff who
are members of the Sanity project: `cd studio && npm install && npm run dev`.
Its project id comes from `studio/.env` (git-ignored). Nothing can be edited
there - every write goes through the app, which keeps the audit trail. Its
schema is generated from `src/db/schema.js` by `npm run studio:schema`.

### Working on it

The server serves `dist/` from disk, so **it never needs restarting for a
frontend change** - rebuild and reload the browser:

```bash
npm run build     # server can stay running; it picks up the new files
```

Better still, use `npm run dev` while editing. Vite hot-reloads the React app
without a rebuild, and the API runs under `node --watch`, so a change to
`src/` reloads itself too. Nothing needs to be stopped and started by hand.

A restart is only required if you change something read once at boot, such as
`.env` or `src/config.js`.

> **Staff sign in at `/login`.** That page is deliberately not linked from the
> public portal - patients never need an account, and a visible staff door
> just advertises the admin surface. See `docs/SECURITY.md` for how to
> separate it properly in production (separate hostname, IP allowlist or VPN).

`npm run setup` prints the sign-in credentials and a list of sample codes to
try. The defaults are:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@qrshield.example` | `ChangeMe!2026` |
| Security team | `security@qrshield.example` | `SecurityTeam!2026` |
| Regulator | `regulator@qrshield.example` | `Regulator!2026` |

These exist only for the demo dataset. Change them before any real use.

---

## Try it

Paste these into the verification page at `/` to see each outcome. Your exact
codes are printed by `npm run setup`, because serials are generated from your
own `CODE_SECRET`.

| What you want to see | Where to get the code |
|---|---|
| **Genuine** | any unused code from the seed output |
| **Flagged - already verified** | scan a genuine code once, then again from a different device |
| **Flagged - batch recalled** | any code from batch `INS10-2606A` |
| **Flagged - expired** | any code from batch `ART20-2412B` |
| **Invalid - a typo** | change one character of a real code |

Worth doing, because it exercises the whole loop end to end:

1. sign in as the admin, open **Batches & codes**, pick a batch, choose
   **Print labels**
2. print that panel, or just display it on another screen
3. open `/` on your phone and scan one of the printed codes
4. watch the check appear in **Scan log** within seconds

A few behaviours are deliberate and worth noticing:

- **Re-checking the same pack on the same phone stays genuine.** A patient who
  refreshes the page, or shows a pharmacist, must not be told their medicine is
  fake. Repeat checks from the same source inside 15 minutes count as one
  verification.
- **A mistyped code is not a counterfeit.** Checksum failures get their own
  amber "check the code" result, never a red counterfeit warning.
- **A flagged result never shows the leaflet.** Printing official dosing
  instructions next to a counterfeit warning would be actively dangerous.

---

## How it works

### The code

```
AMX25 - 260921 - 087498 - Z7
-----   ------   ------   --
  |        |        |      `- keyed checksum, catches typos
  |        |        `-------- non-sequential unit serial
  |        `----------------- batch manufacturing date, YYMMDD
  `-------------------------- product SKU + strength
```

Two properties do the security work:

**Serials are non-sequential but collision-free.** Each unit index is run
through a keyed format-preserving permutation (an alternating Feistel network)
over the serial space. Reading one pack tells you nothing about the next, and
because a Feistel round is individually invertible, the result is a bijection
by construction - no two units can ever collide, and there is no
"generate-random-and-retry" loop. The serial space is automatically widened so
it is at least 100x the batch quantity.

**The checksum is keyed, not public.** Those last two characters are a
truncated HMAC of the rest of the code. That catches typing mistakes *and*
means an attacker cannot mint checksum-valid codes offline, so ~99.9% of blind
guesses are rejected before the database is touched.

The QR additionally carries a 10-character HMAC signature
(`https://host/v/CODE?s=...`), which lets the system distinguish a genuine
scanned QR from a hand-typed or fabricated code. It is recorded on every scan.

### The verification decision

Rules are applied in this order, and the first match wins:

| # | Condition | Result | Reason |
|---|---|---|---|
| 1 | bad format or checksum | `invalid` | `checksum_failed` / `malformed` |
| 2 | not in the registry | `flagged` | `unknown_code` |
| 3 | batch recalled | `flagged` | `recalled` |
| 4 | code voided | `flagged` | `void` |
| 5 | batch never released | `flagged` | `not_released` |
| 6 | past expiry | `flagged` | `expired` |
| 7 | already verified elsewhere | `flagged` | `duplicate_scan` |
| 8 | otherwise | `genuine` | `ok` |

Rule 1 is separated from the rest deliberately: a mistyped code is the common
case, and telling a patient "COUNTERFEIT" because they typed `O` instead of `0`
destroys trust in the whole system.

Rule 7 keys off a separate `verified_count` column rather than total scan
attempts. This matters: if failed scans counted, a single pre-release scan
would make the first genuine patient scan look like a duplicate. There is a
regression test for exactly that.

### Detection, not enforcement

Per the field guide, a flag **never** triggers an automatic recall. Everything
suspicious creates work for a human in the alert queue. Repeat events fold into
the existing alert for that code and escalate its severity rather than
producing one row per scan, so a pack cloned a thousand times is one incident,
not a thousand.

---

## Project layout

```
src/
  server.js              Express app: middleware order, routes, static, shutdown
  config.js              Every tunable, read from the environment in one place
  db/
    schema.js            Every document type: fields, enums, defaults, unique keys
    index.js             The store: validated writes, queries, transactions
    sanity.js            Sanity backend (production)
    memory.js            In-memory / local-file backend (tests, development)
  lib/
    codes.js             Code format: generation, permutation, checksum, parsing
    crypto.js            scrypt passwords, HMAC tokens, timing-safe comparison
    ratelimit.js         Sliding-window limiter
    validate.js          Declarative request validation
    errors.js            Typed, client-safe errors
    logger.js            Structured logging with redaction
  middleware/
    security.js          CSP and the other security headers, client IP, CORS
    auth.js              Session resolution, permission guards, CSRF
    errors.js            Request logging and the terminal error handler
  services/
    verification.js      The core decision path
    serialization.js     Batch lifecycle and code issuance
    alerts.js            Alert queue with deduplication and escalation
    auth.js              Login, sessions, the role matrix, user management
    analytics.js         Dashboard figures and the compliance report
    audit.js             Append-only audit trail
    sms.js               SMS fallback and provider adapters
  routes/
    public.js            /api/verify, /api/report - anonymous, rate limited
    auth.js              /api/auth/*
    admin.js             /api/admin/* - every route permission-gated
    sms.js               /api/sms/inbound webhook

client/                  React frontend (Vite). Built into dist/.
  index.html             Single HTML entry; React Router handles every route
  src/
    main.jsx             Root render, providers, stylesheet imports
    App.jsx              Top-level routes; the dashboard is lazy-loaded
    lib/
      api.js             Fetch wrapper, CSRF, typed ApiError
      format.js          Date, number and code formatting
      hooks.jsx          Theme, toasts, session, useApi data fetching
    components/          Icon sprite, NotFound
    portal/              The public verification portal
      PortalPage.jsx     Page shell and verification flow
      Scanner.jsx        Camera + jsQR, loaded on demand
      ResultCard.jsx     Genuine / flagged / invalid presentation
      ReportForm.jsx     "Report a problem with this pack"
    login/LoginPage.jsx
    admin/
      AdminApp.jsx       Session guard, permission-driven nav, routing
      components/        Drawer, PageHeader, tables, badges, charts
      views/             One component per dashboard section
    styles/              Design tokens plus per-surface stylesheets

scripts/                 setup, migrate (connection check), seed, reset, dev,
                         import-sql (SQL -> Sanity), gen-studio-schema
studio/                  Read-only Sanity Studio
tests/                   62 unit/integration tests + 24 browser tests
docs/                    API reference, data model, security notes
```

---

## Spreadsheets

Products and batches can be loaded from a spreadsheet, and any list can be
downloaded as one.

| | Where |
|---|---|
| Export | **Export** on the Products and Batches screens |
| Import | **Import**, then **Template** for a file with the right headings |

Import is two steps. The file is checked first and the result shown - how many
rows would be added, how many updated, and every row that cannot be read with
its spreadsheet row number - and nothing is written until that is confirmed. A
row that fails never stops the rest of the file.

Some details worth knowing:

- **A SKU that already exists updates that product.** The SKU itself is never
  changed, because it is already part of every code issued for it.
- **Batch numbers are never reused.** They identify a physical production run,
  and codes may already be printed against one.
- **Importing a batch does not issue codes.** The batch is created in `planned`
  status; issuing codes stays a deliberate, audited step in the dashboard.
- **Codes cannot be imported at all.** A code is minted and signed by this
  system - accepting one from a file would let an unsigned value into the table
  that decides whether a pack is genuine.
- **Dates must be unambiguous.** `2026-09-01` is read; `01/02/2026` is refused
  rather than guessed at, because it means different days in different places.

## Configuration

Everything lives in `.env`, which `npm run setup` generates with freshly
random secrets. `src/config.js` is the authoritative list of every setting the
app reads. The ones that matter most:

| Variable | Why it matters |
|---|---|
| `CODE_SECRET` | Signs the checksum of every code. **Rotating it invalidates every code already printed on a physical pack.** Treat as permanent; back it up. |
| `SESSION_SECRET` | Signs admin sessions. Rotating it signs everyone out, which is harmless. |
| `PUBLIC_BASE_URL` | Baked into every printed QR. Must be the real HTTPS origin before any production print run. |
| `SMS_WEBHOOK_SECRET` | Shared secret your SMS gateway must present. |
| `COOKIE_SECURE` | Set `true` in production so session cookies are HTTPS-only. |
| `RL_VERIFY_PER_MIN` / `RL_VERIFY_PER_HOUR` | Rate limits on the public verification endpoint. |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Runtime values the security team can change without a deploy live in the
`settings` table and are editable from **Settings** in the dashboard.

---

## Testing

```bash
npm test          # 62 unit + integration tests, no browser needed
npm run test:e2e  # 24 browser tests (needs a build and Chrome)
npm run test:all  # everything
```

**`npm test`** - 62 tests across four suites:

- **`codes.test.js`** - the serialization maths. Proves the permutation is a
  bijection across the full 100,000-serial domain, that serials are not
  sequential, that every single-character typo is caught (several hundred
  mutations), and that checksums cannot be forged without the secret.
- **`verification.test.js`** - the decision matrix, one test per rule, plus the
  same-device grace window, alert deduplication and sandbox-batch suppression.
- **`api.test.js`** - a real HTTP server driven through the full middleware
  stack: security headers, cookie flags, CSRF, the role matrix, rate limiting,
  the batch lifecycle, and the SMS webhook.
- **`qr.test.js`** - the round trip that would be expensive to get wrong:
  renders a real QR matrix, decodes it with the same `jsQR` library the
  patient's browser uses, and runs the decoded payload through verification.
  Includes a damaged-label test, because pharmaceutical labels get scuffed.

Tests run against an in-memory store and set their own environment, so they
never touch your `.env`, the development data or the Sanity dataset - the
Sanity variables are blanked before anything loads.

They run one file at a time (`--test-concurrency=1`). Node's default is to run
test files in parallel, which starts several HTTP servers at once and produces
intermittent `fetch failed` errors on a machine that is already short of
memory. Serialising costs a few seconds and makes the suite deterministic.

**`npm run test:e2e`** - 24 tests driving the real React app in headless
Chrome over the DevTools Protocol, against its own temporary store. They
cover every dashboard section, the three result states on the portal, drawer
and filter interaction, the printable label sheet, role-based navigation, and
mobile layout. **Any console error or failed request fails the test**, which is
how two real bugs were caught: a dashboard firing a request its own role was
not allowed to make, and the public portal needlessly probing for a staff
session on every page load.

Chrome is driven directly rather than through Playwright or Puppeteer, to keep
a ~300 MB browser download out of the dependency tree. The suite skips itself
cleanly when no browser is present, so `npm test` still works anywhere.

---

## Connecting real QR printing and SMS

### Printing

Two hand-off paths exist, both from a batch's detail panel:

1. **CSV** (`GET /api/admin/batches/:id/codes.csv`) - one row per unit with the
   code, serial and the exact QR payload string. This is the file a packaging
   line's printer consumes.
2. **Label sheet** - renders real scannable QR SVGs in the browser for printing.

QR images use error-correction level **Q** (~25% recoverable), chosen because a
pharmaceutical label is small, may curve around a carton edge, and has to
survive transit. `tests/qr.test.js` verifies a damaged label still scans.

### SMS

Set `SMS_PROVIDER=twilio` and fill in `TWILIO_ACCOUNT_SID` /
`TWILIO_AUTH_TOKEN`, then point your Twilio number's inbound webhook at:

```
https://your-host/api/sms/inbound?key=YOUR_SMS_WEBHOOK_SECRET&format=twiml
```

A patient texts the code (optionally prefixed `CHECK`) and gets a plain-words
reply. Adding another gateway means adding one entry to `PROVIDERS` in
`src/services/sms.js`; nothing else changes.

### Approximate location

`resolveGeo()` in `src/services/verification.js` currently reads the coarse geo
headers CDNs already provide (`CF-IPCountry` and friends). Drop a MaxMind
GeoLite2 or IP2Location lookup into that one function for real resolution. It
is deliberately coarse - the dashboard needs "where are flags clustering", not
a patient's address.

---

## Deployment

Nothing here assumes a particular host. A minimal production checklist:

1. `npm run build` to produce `dist/`. The server returns a clear 503 telling
   you to build if `dist/` is missing, rather than a confusing 404.
2. `NODE_ENV=production`, and set `SESSION_SECRET`, `CODE_SECRET` and
   `SMS_WEBHOOK_SECRET` to generated values. The app refuses to start in
   production without them.
3. `COOKIE_SECURE=true` and terminate TLS in front of the app.
4. Set `PUBLIC_BASE_URL` to the real HTTPS origin **before printing anything**.
5. Behind a load balancer, check `trust proxy` in `src/server.js` matches your
   real proxy hop count. Getting this wrong lets a client spoof
   `X-Forwarded-For` and bypass rate limiting entirely.
6. Configure Sanity (see [Data: Sanity](#data-sanity)) and back the dataset up
   (`npx sanity dataset export`). The code registry is the system of record;
   losing it orphans every pack in circulation.
7. With Sanity configured, rate limits are shared across instances
   automatically (`RATELIMIT_STORE=db`); without it they are per process.
8. `GET /api/health` is the liveness probe.

---

## Further documentation

| Document | Contents |
|---|---|
| [`docs/API.md`](docs/API.md) | Every endpoint, with request and response examples |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | Document types, relationships, and how Sanity stores them |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, controls, and honest limitations |

---

## Known limitations

These are inherent to the approach, not defects, and the field guide raises
most of them. They are restated here so nobody is surprised.

- **A QR code can be photographed and reprinted.** The code itself is not a
  secret once a pack is on a shelf. What actually defeats cloning is the
  *hidden* code under tamper-evident packaging plus duplicate detection - so
  label quality matters as much as this software does.
- **Verification needs connectivity.** SMS covers the gap, but a patient with
  neither data nor signal cannot check on the spot.
- **Duplicate detection is retrospective.** The first person to scan a cloned
  pack sees "genuine"; the second sees the warning. It narrows counterfeit
  circulation, it does not prevent the first sale.
- **The alert queue needs staffing.** Nothing closes the loop automatically,
  by design.
- **Rate limiting is per process.** Fine for a pilot; use a shared store before
  scaling out.
