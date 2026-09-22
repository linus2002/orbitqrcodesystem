# Deploying Orbit QR Counterfeit System

There are two supported shapes, and the database decides which you are in.

| | Vercel | Railway / Render / Fly |
|---|---|---|
| Database | Turso (hosted) | SQLite file on a disk |
| Instances | many, serverless | exactly one |
| Rate limiting | `rate_hits` table | process memory |
| Config | `TURSO_DATABASE_URL` | `DB_FILE` + a volume |

**[Vercel](#vercel) is the quickest to stand up** and needs no container. The
data layer uses libSQL, which speaks the same SQLite dialect against a hosted
Turso database, so nothing about the application changes between the two.

The single-instance rule for the disk-backed hosts is not a formality: that
database holds every code issued and every scan recorded, and two instances
would each get their own diverging copy of it.

A `Dockerfile` is included for the three container hosts below.

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
| `DB_FILE` | `/data/qrshield.db` | Container hosts only; must be on the mounted disk |
| `TURSO_DATABASE_URL` | `libsql://...` | Vercel only; without it, writes are discarded |
| `TURSO_AUTH_TOKEN` | the database token | Vercel only |
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

## Vercel

Everything runs here: the SPA on the CDN, the API as one serverless function
([`api/index.js`](api/index.js)), the data in Turso.

### 1. Create the database

```bash
npm i -g @tursodatabase/cli
turso auth signup
turso db create orbit-qr
turso db show orbit-qr --url            # -> libsql://orbit-qr-<org>.turso.io
turso db tokens create orbit-qr         # -> the auth token
```

### 2. Apply the schema

Point the local tooling at Turso once, and the migration runs against it:

```bash
TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... npm run db:migrate
```

Re-run this after any change to `src/db/schema.sql`; it is idempotent.

### 3. Set the environment variables

In **Project → Settings → Environment Variables**, for Production *and*
Preview:

| Variable | Value |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://orbit-qr-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | the token from step 1 |
| `NODE_ENV` | `production` |
| `PUBLIC_BASE_URL` | your `https://...vercel.app` domain |
| `COOKIE_SECURE` | `true` |
| `SESSION_SECRET` | generated (see above) |
| `CODE_SECRET` | generated (see above) |
| `SMS_WEBHOOK_SECRET` | generated (see above) |

`RATELIMIT_STORE` needs no value: it selects the shared SQL store on its own
whenever `TURSO_DATABASE_URL` is set.

### 4. Deploy

Import the repo and deploy. [`vercel.json`](vercel.json) supplies the build
command, the output directory, the `/api/*` route to the function, the SPA
fallback and the security headers.

> Without `TURSO_DATABASE_URL` the function falls back to a local file in an
> ephemeral filesystem, and **every write is silently discarded** between
> invocations. The function logs an error at cold start when this happens -
> check the runtime logs if data seems to vanish.

### Creating the first admin

```bash
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node -e "
import('./src/db/index.js').then(async db => {
  const { hashPassword } = await import('./src/lib/crypto.js');
  db.open();
  await db.run(
    'INSERT INTO users (email, full_name, role, password_hash, status) VALUES (?,?,?,?,?)',
    ['you@example.com', 'Your Name', 'admin', hashPassword('a-strong-password'), 'active']
  );
  console.log('admin created');
});
"
```

### Backups

Turso keeps point-in-time restore on its own; `turso db shell orbit-qr .dump`
takes a copy you hold yourself. The scan history is the audit trail you would
need after a recall, so do take one.

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

On Vercel this is already handled: Turso is shared by every instance, and
`RATELIMIT_STORE=sql` shares the rate-limit counters through the same
database.

On a container host, the constraint is SQLite-on-local-disk, not the app.
`src/db/index.js` is the only file that talks to the driver — every service
goes through `db.get/all/run/scalar/tx` — so moving to Turso is a matter of
setting `TURSO_DATABASE_URL`, and moving to PostgreSQL would mean rewriting
that one file plus the column types in `src/db/schema.sql`. Set
`RATELIMIT_STORE=sql` at the same time, since per-IP counters have to be
shared to mean anything.
