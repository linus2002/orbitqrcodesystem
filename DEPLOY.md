# Deploying Orbit QR Counterfeit System

The server is a single long-running Node process that keeps its data in a
SQLite file. It needs two things from a host:

1. a **persistent disk** mounted at `/data`, and
2. **exactly one instance** running.

Both matter. The database holds every code this installation has issued and
every scan ever recorded; on an ephemeral filesystem that history disappears
on each redeploy, and with two instances each gets its own diverging copy.
This rules out serverless platforms (Vercel, Netlify Functions, Cloudflare
Workers) unless the data layer is first ported to a hosted database.

A `Dockerfile` is included and works on all three hosts below.

---

## Before you deploy: generate real secrets

Whichever host you pick, three secrets must be set. Generate each with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

| Variable | What it protects | If it leaks |
|---|---|---|
| `SESSION_SECRET` | Signs staff session cookies | Anyone can forge an admin session. Safe to rotate: it just signs everyone out. |
| `CODE_SECRET` | Signs the payload of every serialized code | Counterfeit codes can be minted that pass verification. **Effectively permanent** — rotating it invalidates every code already printed on a pack. |
| `SMS_WEBHOOK_SECRET` | Authenticates your SMS gateway on `POST /api/sms/inbound` | Anyone can inject fake inbound texts. Safe to rotate with the gateway. |

Set `CODE_SECRET` **before printing anything**, and back it up somewhere you
will still have in five years.

---

## Required environment

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Turns on secret enforcement and secure cookies |
| `DB_FILE` | `/data/qrshield.db` | Must be on the mounted disk |
| `PUBLIC_BASE_URL` | `https://your-domain` | **Baked into every printed QR code.** Set it to the final domain before printing; it cannot be changed afterwards without orphaning every pack in circulation. |
| `COOKIE_SECURE` | `true` | All three hosts terminate TLS |
| `SESSION_SECRET` | *generated* | |
| `CODE_SECRET` | *generated* | |
| `SMS_WEBHOOK_SECRET` | *generated* | |
| `PORT` | host-provided | Read automatically; don't hardcode |

Everything else has a sensible default — `src/config.js` is the authoritative
list, including the rate limits and lockout thresholds.

---

## Railway

Easiest of the three.

1. **New Project → Deploy from GitHub repo**, pick `orbitqrcodesystem`.
   Railway detects the `Dockerfile` on its own.
2. **Settings → Volumes → New Volume**, mount path `/data`.
3. **Variables**: add the table above. Railway injects `PORT`.
4. **Settings → Healthcheck Path**: `/api/health`.
5. Leave replicas at **1**.
6. Deploy, then set `PUBLIC_BASE_URL` to the domain Railway assigns and
   redeploy so the value is live before any code is generated.

## Render

A blueprint is committed, so Render can read the whole configuration:

1. **New → Blueprint**, point it at the repo. It picks up
   [`render.yaml`](render.yaml): Docker runtime, a 1 GB disk at `/data`, the
   health check, and generated values for the three secrets.
2. Fill in `PUBLIC_BASE_URL` when prompted (it is marked `sync: false`).
3. The disk requires a paid plan — the free tier has no persistent storage.

## Fly.io

```bash
fly launch --no-deploy          # reads fly.toml; keep the app name
fly volumes create orbit_data --size 1 --region jnb
fly secrets set SESSION_SECRET=... CODE_SECRET=... SMS_WEBHOOK_SECRET=...
fly secrets set PUBLIC_BASE_URL=https://orbit-qr.fly.dev
fly deploy
```

Edit `primary_region` in [`fly.toml`](fly.toml) first — put it near the
pharmacies doing the scanning. Keep the machine count at 1.

---

## First boot

`npm start` runs `scripts/migrate.js` before the server binds (the `prestart`
hook), so a fresh volume gets its schema automatically. Migration is
idempotent and re-runs harmlessly on every deploy, which is also how new
tables and indexes land.

You then need a first staff account. Open a shell on the host
(`fly ssh console`, or Railway/Render's shell) and run:

```bash
node -e "
import('./src/db/index.js').then(async db => {
  const { hashPassword } = await import('./src/lib/crypto.js');
  db.open();
  db.run(
    'INSERT INTO users (email, full_name, role, password_hash, status) VALUES (?, ?, ?, ?, ?)',
    ['you@example.com', 'Your Name', 'admin', hashPassword('a-strong-password'), 'active']
  );
  console.log('admin created');
});
"
```

> **Do not run `npm run db:seed` against a live deployment.** It clears the
> demo tables first and replaces them with fabricated products, batches and
> scan history. It is for local development only.

---

## Vercel (frontend only)

[`vercel.json`](vercel.json) is committed so the built SPA deploys correctly:
it sets the build command and `dist` as the output, adds the catch-all rewrite
that makes `/login` and `/admin/*` resolve to `index.html`, and re-declares the
security headers from `src/middleware/security.js` - those are set by Express
at runtime, so on a static deploy nothing would send them otherwise.

Note that `vercel.json` rejects any property its schema does not define: a
`comment` key inside a `rewrites` or `headers` entry fails the deploy with
`should NOT have additional property`. That is why the explanations live here
rather than in the file.

**This deploys the interface, not the system.** There is no Node process on a
static deploy, so every `/api/*` call returns 404: no sign-in, no code
verification, no dashboard data. To get a working system with the frontend on
Vercel, run the API on one of the hosts above and add a rewrite pointing at
it:

```json
{ "source": "/api/:path*", "destination": "https://your-api-host/api/:path*" }
```

The API host then needs `PUBLIC_BASE_URL` set to the Vercel domain, and the
session cookie has to be valid for it - see `src/middleware/security.js` for
the CORS origin allowlist.

---

## Verifying a deployment

```bash
curl https://your-domain/api/health        # -> {"status":"ok",...}
curl -I https://your-domain/              # -> 200, serves the SPA
```

Then sign in at `/login` and confirm the dashboard loads. If the page reports
that the frontend has not been built, the image's build stage failed — check
the deploy logs for the `npm run build` step.

## Backups

The whole database is one file, so a backup is a file copy:

```bash
fly ssh console -C "sqlite3 /data/qrshield.db '.backup /data/backup.db'"   # Fly
```

Use `.backup` rather than `cp` — the database runs in WAL mode, and a plain
copy taken mid-write can miss the contents of the write-ahead log. Schedule
this; the scan history is the audit trail you would need after a recall.

## Scaling past one instance

When one box is no longer enough, the constraint is SQLite-on-local-disk, not
the app. `src/db/index.js` is the only file that talks to the driver — every
service goes through `db.get/all/run/tx` — so a move to PostgreSQL means
rewriting that one file plus the column types in `src/db/schema.sql`. The
in-memory rate limiter in `src/lib/ratelimit.js` would move to Redis at the
same time, since per-IP counters have to be shared to mean anything.
