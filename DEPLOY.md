# Deploying Orbit QR Counterfeit System

There are two supported shapes, and the database decides which you are in.

| | Vercel | Railway / Render / Fly |
|---|---|---|
| Database | Supabase (Postgres) | SQLite file on a disk |
| Instances | many, serverless | exactly one |
| Rate limiting | `rate_hits` table | process memory |
| Config | `TURSO_DATABASE_URL` | `DB_FILE` + a volume |

**[Vercel + Supabase](#vercel--supabase) is the quickest to stand up** and
needs no container. The data layer carries two drivers behind one interface,
so the application code is identical either way - only `DATABASE_URL` decides.

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
| `DATABASE_URL` | Supabase pooling URI | Vercel/serverless; without it, writes go to a disk that is discarded |
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

## Vercel + Supabase

Everything runs here: the SPA on the CDN, the API as one serverless function
([`api/index.js`](api/index.js)), the data in Supabase.

### 1. Create the Supabase project

At [supabase.com](https://supabase.com), create a project and set a database
password. Then **Project Settings → Database → Connection string → URI**.

Supabase offers two, and the choice matters:

| | Port | Use |
|---|---|---|
| **Connection pooling** (Transaction mode) | 6543 | **This one.** A serverless function scales out, and the pooler is what lets many short-lived instances share a small number of real connections. |
| Direct connection | 5432 | Allows far fewer clients; a function that scales will exhaust them. |

Copy the pooling URI and substitute your password for `[YOUR-PASSWORD]`.

### 2. Apply the schema

```bash
DATABASE_URL='postgresql://postgres.xxxx:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres'   npm run db:migrate
```

The schema applied is [`schema.postgres.sql`](src/db/schema.postgres.sql),
which is **generated** from `schema.sql`. After changing the SQLite schema,
regenerate and re-check it:

```bash
npm run db:pg-schema
```

### 3. Set the environment variables

In **Vercel → Project → Settings → Environment Variables**, for Production:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the pooling URI from step 1 |
| `PUBLIC_BASE_URL` | your `https://...vercel.app` domain |
| `COOKIE_SECURE` | `true` |
| `SESSION_SECRET` | generated (see above) |
| `CODE_SECRET` | generated (see above) |
| `SMS_WEBHOOK_SECRET` | generated (see above) |

Do not set `NODE_ENV`; Vercel manages it. `RATELIMIT_STORE` needs no value
either - it selects the shared SQL store on its own once `DATABASE_URL` is
present.

> The application **refuses to start in production without `SESSION_SECRET`
> and `CODE_SECRET`** ([src/config.js](src/config.js)). That guard is
> deliberate - a deployment signing sessions with a known development key is
> worse than one that will not boot - but it surfaces on Vercel as an opaque
> `FUNCTION_INVOCATION_FAILED`. The real message is in **Project → Logs**.

### 4. Deploy

Redeploy after setting the variables; they only apply to a new build.

### 5. Create the first admin

A fresh deployment has an empty users table and there is no sign-up, so
sign-in fails until an account exists:

```bash
DATABASE_URL='postgresql://...' npm run user:create --   --email you@example.com --name "Your Name" --password "a-strong-password"
```

The password must be at least 12 characters with an uppercase letter and a
digit; the script reports exactly what is missing if it is not. `--role`
takes `admin` (the default), `security` or `regulator`.

This goes through the same `createUser()` the dashboard uses, so the strength
rules, the role check and the audit entry all apply.

> Do not run `npm run db:seed` against Supabase. It clears the demo tables
> first, and its three accounts have passwords published in this repository.

### Backups

Supabase takes daily backups on paid plans; on the free plan, take your own
with `pg_dump` against the direct (5432) connection. The scan history is the
audit trail you would need after a recall.

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

On Vercel this is already handled: Supabase is shared by every instance, and
the rate-limit counters move into the same database automatically once
`DATABASE_URL` is set.

On a container host the constraint is SQLite-on-local-disk, not the app. The
same `DATABASE_URL` switch points it at Supabase instead; set
`RATELIMIT_STORE=sql` at the same time, since per-IP counters have to be
shared to mean anything.
