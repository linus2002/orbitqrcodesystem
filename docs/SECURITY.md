# Security notes

What this system defends against, how, and - just as importantly - what it
does not defend against.

---

## Threat model

| # | Threat | Control | Residual risk |
|---|---|---|---|
| 1 | Counterfeiter invents codes | Keyed HMAC checksum: ~99.9% of guesses fail before the DB is touched | Someone with the `CODE_SECRET` can mint valid codes |
| 2 | Counterfeiter enumerates codes via the API | Two-window rate limiting, plus a detective `guess_attack` alert | Distributed attacks from many IPs are slower to spot |
| 3 | Counterfeiter clones one genuine pack | Duplicate detection; repeats fold into one escalating alert | **The first scan of a cloned pack reads genuine** |
| 4 | Codes leak off the packaging line before release | Batch lifecycle: pre-release scans flag as `not_released` | Depends on operators moving batch state honestly |
| 5 | Recalled or expired stock stays in circulation | Recall and expiry checked on every scan, ahead of duplicate logic | Only catches packs that are actually scanned |
| 6 | Attacker steals a staff session | httpOnly + `SameSite=Strict` cookies, server-side revocable sessions, 8h expiry | An XSS-free frontend is assumed - hence the strict CSP |
| 7 | Attacker brute-forces a staff password | scrypt, per-IP+email rate limit, account lockout | - |
| 8 | Cross-site request forgery | `SameSite=Strict` plus double-submit CSRF token | - |
| 9 | Regulator or auditor over-reaches into patient data | Role matrix enforced server-side; the compliance report is built from aggregates only | - |
| 10 | Patient data leaks from the scan log | IPs and phone numbers stored only as keyed digests; location kept to city granularity | - |
| 11 | Insider tampers with records | Append-only `scans`, `audit_log`, `sms_log`; every admin action audited | An operator with database access can still edit the file |

---

## Controls

### Code integrity

The trailing two characters of every code are a truncated HMAC-SHA256 of the
rest, keyed with `CODE_SECRET`. Two consequences:

- **Typos are caught.** `tests/codes.test.js` exercises several hundred
  single-character mutations; all are rejected.
- **Codes cannot be forged offline.** A public mod-N checksum would let anyone
  generate valid-looking codes. A keyed one means an attacker must query the
  API for every guess, where rate limiting and alerting apply.

Serials come from a keyed format-preserving permutation (an alternating Feistel
network) over the serial space, so they are unpredictable but collision-free by
construction. The space is auto-sized to at least 100x the batch quantity, so a
well-formed blind guess has at most a ~1% chance of naming a real unit -
before the checksum's additional ~1/1024 filter.

> `CODE_SECRET` is effectively permanent. Rotating it invalidates the checksum
> of every code already printed on a physical pack. Back it up; never rotate it
> casually.

### Passwords and sessions

- **scrypt**, N=2^15, r=8, p=1, 64-byte output, per-user random salt. Roughly
  100 ms per hash.
- Comparisons are timing-safe, and both sides are hashed first so lengths
  cannot leak.
- Sessions are HMAC-SHA256 signed tokens **plus** a server-side `sessions` row.
  The token proves integrity; the row makes revocation real. A stateless JWT
  cannot be revoked; this can, and logout, suspension and password change all
  do so immediately.
- Login failures return an identical message whether the account exists or not.

### Content-Security-Policy

```
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:;
object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

`script-src 'self'` with **no `unsafe-inline` and no `unsafe-eval`** is the
header that actually stops XSS. Several design consequences follow from taking
it seriously, and they shaped the Vite configuration:

- Every dependency, including the QR decoder, is **bundled** into
  `dist/assets/` and served from our own origin. Nothing is loaded from a CDN.
- Vite's module-preload polyfill is switched off (`modulePreload.polyfill:
  false`), because it is emitted as an inline `<script>`. The built
  `index.html` therefore contains **no inline script at all** - verified after
  each build.
- There is **no inline `style` attribute** anywhere. Dynamic chart geometry
  uses SVG presentation attributes; the handful of dynamic colours are set
  through the CSSOM, which CSP permits.

A test asserts the policy contains neither `unsafe-inline` nor `unsafe-eval`,
so a future relaxation fails the build rather than slipping through.

### Output escaping

React escapes every value it renders, which removes the largest category of
mistake by construction. This matters more than it looks: product names, batch
numbers and especially free-text consumer reports are all
attacker-influencable. A counterfeiter can write whatever they like into the
"report a problem" form, and it is then rendered in an analyst's browser.

There is exactly **one** `dangerouslySetInnerHTML` in the codebase, in the
printable label sheet (`client/src/admin/views/Batches.jsx`). It renders QR
SVG markup produced by our own server-side `qrcode` renderer from a code in
our own registry - never from user input. Any future use of that API should be
treated as requiring the same justification.

### Separating staff access from the public portal

The public portal carries **no link to the staff sign-in page**. Patients and
pharmacists never need an account, so a visible staff door adds nothing for
them and advertises the admin surface to everyone who scans a pack. Staff
reach `/login` directly.

Be clear about what that does and does not buy:

- It removes the admin surface from a patient's view, which is the point.
- It is **not** access control. `/login` is still reachable by anyone who
  types it, and anyone can guess it. The controls that actually matter are the
  ones already in place: per-IP-and-email rate limiting, account lockout,
  identical error messages, and a role matrix enforced server-side on every
  request.

For real separation in production, put the admin surface somewhere the public
cannot reach at all. In rough order of strength:

| Approach | What it gives you |
|---|---|
| Separate hostname (`admin.example.com`) routed to the same app | Lets you apply different firewall, WAF and TLS policy to the admin surface |
| IP allowlist or VPN in front of `/login` and `/api/admin/*` | Staff traffic only; the internet cannot reach the door at all |
| Separate deployment serving only the admin build | Blast-radius separation; the public app carries no admin code |

The first two are configuration in front of the app and need no code change.
The third is a build change: the dashboard is already a separate lazy-loaded
chunk, so it can be built and served independently.

### Rate limiting

| Endpoint | Limit |
|---|---|
| `POST /api/verify` | 12/min and 80/hour per IP |
| `POST /api/verify/bulk` | 20/hour per IP |
| `POST /api/report` | 5/hour per IP |
| `POST /api/auth/login` | 5 per 15 min per IP+email |
| `POST /api/sms/inbound` | 60/min |

Paired with a detective control: `GUESS_ALERT_THRESHOLD` consecutive failed
lookups from one source in an hour raises a `guess_attack` alert, fired once
per source per hour so it cannot itself become a flood.

> **Client IP resolution matters.** `trust proxy` is set to `loopback` in
> development and exactly one hop in production. Setting it to `true` would let
> any client spoof `X-Forwarded-For` and bypass rate limiting entirely.

### Error handling

`AppError` instances are client-safe and carry a stable machine-readable code.
Anything else is logged in full and reduced to a generic message plus an
`incidentId` that matches the server log. Stack traces, SQL and file paths
never reach a browser.

---

## Deliberate limitations

Stated plainly, because pretending otherwise would be worse than the
limitations themselves.

**A QR code is not a secret.** It can be photographed off a real pack and
reprinted on a hundred fakes. Nothing in software prevents that. What limits it
is (a) the *hidden* code under tamper-evident packaging, which requires opening
the pack, and (b) duplicate detection, which turns one cloned code into an
alert as soon as a second person checks it. **Label quality carries as much of
the defence as this software does.**

**Duplicate detection is retrospective.** The first person to scan a cloned
pack is told "genuine". They are the one person the system cannot protect. It
narrows how long counterfeits circulate; it does not prevent the first sale.

**The same-device grace window is a deliberate trade-off.** Repeat checks from
one source within 15 minutes count as one verification, so a patient refreshing
the page is not told their medicine is fake. A counterfeiter who controls the
scanning device could use that window to check the same code repeatedly without
raising an alert - but they already know their own product is fake, so the
window costs nothing real and prevents a large amount of false alarm.

**Connectivity is required.** SMS covers the gap, but a patient with neither
data nor signal cannot check at the counter.

**Alerts need a staffed response.** Nothing closes the loop automatically, by
design: an automatic recall triggered by an unverified flag would be far more
dangerous than a slow one.

**Rate limiting is per process.** Correct for a single instance and for the
pilot. Behind a load balancer, each instance enforces its own budget - swap
`MemoryStore` in `src/lib/ratelimit.js` for a Redis-backed implementation of
the same three methods.

**The database file is the system of record.** Anyone with filesystem access
can read or edit it. Encrypt at rest, restrict access, and back it up: losing
the code registry orphans every pack in circulation.

---

## Before going live

- [ ] Generate real `SESSION_SECRET`, `CODE_SECRET`, `SMS_WEBHOOK_SECRET`. The
      app refuses to start in production with the development fallbacks.
- [ ] Back up `CODE_SECRET` somewhere durable. It cannot be regenerated once
      codes are printed.
- [ ] `COOKIE_SECURE=true`, TLS terminated in front of the app.
- [ ] `PUBLIC_BASE_URL` set to the real HTTPS origin **before any print run**.
- [ ] `trust proxy` matches the real proxy hop count.
- [ ] Change every seeded account password, or delete the demo accounts.
- [ ] Confirm the sandbox flag is set on pilot batches so test scans stay out
      of live figures.
- [ ] Wire `notify()` in `src/services/alerts.js` to a real channel - email,
      Slack or PagerDuty. Until then, high and critical alerts only reach the
      application log.
- [ ] Decide a retention policy for `scans`. It grows with every check and
      contains pseudonymised but still personal-adjacent data.
