# Deploying Orbit QR Counterfeit System

**Production runs on [Coolify](#coolify-bishnoi-one---production), on the
Bishnoi One server, with its data in PostgreSQL** - the
`ea-bishnoi-one-database` resource. Every record and every stored file
lives there.

| | Coolify (production) | Vercel / Railway / Render / Fly (previous) |
|---|---|---|
| Data | PostgreSQL (`DATABASE_URL`) | Sanity (`SANITY_*`) |
| Files | PostgreSQL `files` table | Sanity assets (leaflet PDFs only) |
| Instances | **one** container | many |
| Config | `DATABASE_URL` + secrets | `SANITY_*` + secrets |

The store is chosen by configuration: `DATABASE_URL` set means Postgres;
otherwise the three `SANITY_*` variables mean Sanity; with neither, the app
keeps its data in a local file (`DB_FILE`), which is for development only.

---

## Coolify (Bishnoi One) - production

### What is stored where

Two tables, in their own schema (`qrshield` by default, `DATABASE_SCHEMA`),
created automatically on every start by `scripts/migrate.js`:

| Table | Holds |
|---|---|
| `qrshield.documents` | every record - products, batches, codes, scans, users, alerts, settings... - one JSONB row each |
| `qrshield.files` | every file, bytes in a `bytea` column, tagged with its `kind` |

| File `kind` | What | Accepted | Limit |
|---|---|---|---|
| `leaflet` | leaflet PDFs, stored in 3 MB pieces | PDF | 25 MB per file |
| `import` | the original of every Excel/CSV import | XLSX, CSV | 8 MB |
| `export` | a copy of every Excel export, with who took it | XLSX (ours) | - |
| `qr` | each rendered QR, kept so it is drawn once | SVG, PNG (ours) | - |
| `avatar` | staff pictures | JPEG, PNG, WebP | 200 KB |
| `product_image` | product pictures | JPEG, PNG, WebP | 2 MB |

A file's type is checked from its bytes, never from its name or the type the
browser claims; uploaded SVG is always refused. Stored imports and exports are
listed, with download links, under **Audit log > Stored spreadsheets**.

The app keeps a copy of every document in memory and answers reads from it;
Postgres is the durable store, and every write commits there before the
copy changes (see [src/db/postgres.js](src/db/postgres.js)). So run **one**
replica. A rolling deploy that briefly overlaps two is safe; scaling out is
not what this is built for.

### 1. A database and role of its own

`ea-bishnoi-one-database` also serves the `ea-bishnoi-one` app. Give QR Shield
its own role and database on that server, so neither app can touch the
other's data. In Coolify open the database > **Terminal**, run `psql -U postgres`
(or whatever the database's "Postgres User" is), then:

```sql
CREATE ROLE qrshield LOGIN PASSWORD '<a long random password>';
CREATE DATABASE qrshield OWNER qrshield;
```

Generate the password with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
(hex, so it needs no URL-escaping).

### 2. The connection string

From the database's page copy **Postgres URL (internal)**. Keep its host and
port, but use the new role and database:

```
DATABASE_URL=postgres://qrshield:<password>@<internal-host>:5432/qrshield
DATABASE_SSL=disable
```

The internal url only works from containers on the same server, which is the
point: leave **Make it publicly available** OFF. Without a public port there
is nothing on the internet to attack. `DATABASE_SSL=disable` is correct for
that private network; set `require` only if you ever connect across the
internet.

### 3. The application

In Bishnoi One > production: **New Resource > Public/Private Repository**, this
repository, branch `main`, **Build Pack: Dockerfile**. Then:

- **Domains**: `https://verify.getmeds.ph` (and move that DNS record from
  Vercel to the Bishnoi One server).
- **Ports Exposes**: `3000`.
- **Environment Variables**: open `.env.coolify` (gitignored, on the machine
  that prepared the cut-over), switch Coolify's editor to **Developer view**
  and paste it in. Fill in `DATABASE_URL` from step 2. Keep `CODE_SECRET`
  exactly as it is: it signs every code already printed.
- **Healthcheck**: path `/api/health`. The Dockerfile has one too.
- **Replicas**: 1.

No volume is needed: nothing is kept on the container's disk.

### 4. Move the data from Sanity - once

With the app NOT yet serving traffic (so Sanity takes no more writes), open
the app's **Terminal** in Coolify, which has both the Sanity variables and
`DATABASE_URL`, and run:

```bash
npm run db:sanity-to-postgres -- --dry-run   # counts only
npm run db:sanity-to-postgres                # copies; prints Sanity vs Postgres counts
```

It copies every document with the same ids, every leaflet PDF byte for byte
(checked against Sanity's SHA-1), and turns inline avatars into stored files.
It refuses a database that already has documents, so it can never roll
newer Postgres data back to Sanity's; `--overwrite` exists only for a retry
after a failed first run.

Then restart the app, sign in, open a product with a leaflet PDF, and verify a
real pack. When all is well: delete the three `SANITY_*` variables from
Coolify and revoke that token at sanity.io/manage.

### 5. Backups

The code registry is the system of record: losing it orphans every pack in
circulation. In Coolify, open the database > **Backups**, add a daily
schedule, and send it to S3-compatible storage off this server - a backup
on the same disk dies with the disk. A dump covers both tables, files
included. To take one by hand:

```bash
pg_dump --format=custom --dbname "$DATABASE_URL" --file qrshield-$(date +%F).dump
```

It contains password hashes and every stored file; keep it as carefully as the
database password.

### Running the tests against Postgres

```bash
npm run test:postgres
```

runs the whole suite on Postgres - PGlite, real Postgres compiled to
WebAssembly, started inside the test process, so no server is needed and
`DATABASE_URL` is never touched.

---

## Before you deploy

### Generate real secrets

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

### Prepare the Sanity project

1. **Token.** [sanity.io/manage](https://www.sanity.io/manage) -> the project
   -> **API -> Tokens -> Add API token**, permission **Editor**. It is shown
   once; store it like a password. Anyone holding it can read and rewrite the
   code registry.
2. **Private dataset.** A public dataset lets anyone who learns the project
   id read every scan, user and code. Make it private:

   ```bash
   cd studio && npx sanity login && npx sanity dataset visibility set production private
   ```

3. **No CORS origin for the app.** The browser never talks to Sanity - only
   the server does, with the token - so the app's domain must NOT be added
   under **API -> CORS origins**. Leave only what the Studio needs
   (`http://localhost:3333` for running it locally).

The project id, dataset and token are read by the Node server alone. No
endpoint returns them and Vite bundles only `VITE_`-prefixed variables, so
none of them can reach a visitor's browser. Keep them in the host's
environment settings, never in a committed file.

---

## Required environment

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Turns on secret enforcement and secure cookies (not on Vercel, which sets it) |
| `SANITY_PROJECT_ID` | your project id | Server-side only |
| `SANITY_DATASET` | `production` | Server-side only |
| `SANITY_API_TOKEN` | the Editor token | **Secret** |
| `PUBLIC_BASE_URL` | `https://your-domain` | **Baked into every printed QR code.** Set it to the final domain before printing; it cannot be changed afterwards without orphaning every pack in circulation. |
| `COOKIE_SECURE` | `true` | All hosts terminate TLS |
| `SESSION_SECRET` | *generated* | |
| `CODE_SECRET` | *generated* | |
| `SMS_WEBHOOK_SECRET` | *generated* | |
| `PORT` | host-provided | Read automatically; don't hardcode |

`RATELIMIT_STORE` needs no value: it selects the shared store in Sanity on its
own once the three Sanity variables are present. Everything else has a
sensible default — `src/config.js` is the authoritative list.

---

## Vercel

Everything runs here: the SPA on the CDN, the API as one serverless function
([`api/index.js`](api/index.js)), the data in Sanity.

1. In **Vercel -> Project -> Settings -> Environment Variables**, for
   Production, set every variable in the table above except `NODE_ENV` and
   `PORT`. Remove any old `DATABASE_URL` / `TURSO_*` values: nothing reads them
   now.
2. Redeploy; variables only apply to a new build. Each build runs
   `scripts/migrate.js --hosted-only` (`vercel.json` -> `npm run
   build:vercel`), which checks the Sanity connection and **fails the build if
   the dataset is public**. A build without the Sanity variables (a preview,
   say) skips the check.

> The application **refuses to start in production without `SESSION_SECRET`
> and `CODE_SECRET`** ([src/config.js](src/config.js)). That surfaces on
> Vercel as an opaque `FUNCTION_INVOCATION_FAILED`; the real message is in
> **Project -> Logs**.

## Railway

1. **New Project -> Deploy from GitHub repo**, pick `orbitqrcodesystem`.
   Railway detects the `Dockerfile` on its own.
2. **Variables**: add the table above. Railway injects `PORT`.
3. **Settings -> Healthcheck Path**: `/api/health`.
4. Deploy, then set `PUBLIC_BASE_URL` to the domain Railway assigns and
   redeploy so the value is live before any code is generated.

No volume is needed once Sanity is configured.

## Render

A blueprint is committed ([`render.yaml`](render.yaml)). **New -> Blueprint**,
point it at the repo, and fill in the values it marks `sync: false` when
prompted: `PUBLIC_BASE_URL` and the three Sanity variables. The blueprint
still attaches a small disk for the fallback file; with Sanity configured it is
unused, and you can remove it and raise `numInstances`.

## Fly.io

```bash
fly launch --no-deploy          # reads fly.toml; keep the app name
fly secrets set SESSION_SECRET=... CODE_SECRET=... SMS_WEBHOOK_SECRET=...
fly secrets set SANITY_PROJECT_ID=... SANITY_DATASET=production SANITY_API_TOKEN=...
fly secrets set PUBLIC_BASE_URL=https://orbit-qr.fly.dev
fly deploy
```

Edit `primary_region` in [`fly.toml`](fly.toml) first — put it near the
pharmacies doing the scanning.

---

## First boot

`npm start` runs `scripts/migrate.js` before the server binds, which checks
the Sanity connection. There is no schema to apply: the document types are
enforced by the application on every write ([src/db/schema.js](src/db/schema.js)).

A fresh dataset has no users and there is no sign-up, so create the first
administrator from your own machine, with the three Sanity variables in
`.env`:

```bash
npm run user:create -- --email you@example.com --name "Your Name" --password "a-strong-password"
```

The password must be at least 12 characters with an uppercase letter and a
digit. `--role` takes `admin` (the default), `security` or `regulator`. This
goes through the same `createUser()` the dashboard uses, so the strength
rules, the role check and the audit entry all apply.

> **Do not run `npm run db:seed` against the live dataset.** It deletes every
> document first and loads fabricated data whose passwords are published in
> this repository. It refuses to run against Sanity unless
> `ALLOW_DESTRUCTIVE_RESET=1` is set; only ever set that for a throwaway
> dataset.

## Moving from Supabase, Turso or SQLite

An existing deployment's data comes across with every id intact, so printed
QR codes, alerts and audit entries all still resolve:

```bash
npm run db:import-sql -- --from postgres --to-file data/rehearsal.json   # rehearse locally
npm run db:import-sql -- --from postgres                                  # then for real
```

`--from postgres` reads `DATABASE_URL`, `--from turso` reads
`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`, and a path reads a SQLite file.
Every row passes the same validation the app applies, and the import is safe to
re-run: it resumes where it stopped and never overwrites. Sessions are not
copied - staff sign in again.

---

## Verifying a deployment

```bash
curl https://your-domain/api/health        # -> {"status":"ok",...}
curl -I https://your-domain/              # -> 200, serves the SPA
```

Then sign in at `/login` and confirm the dashboard loads.

## Backups

On Coolify, see [Backups](#5-backups) above. While data is still on Sanity,
export the dataset on a schedule:

```bash
cd studio && npx sanity dataset export production backup-$(date +%F).tar.gz
```

The export contains every document, including password hashes - store it as
carefully as the token.

## Limits worth knowing

- **Document count.** Every pack code is one document, and every scan is
  another. Sanity plans cap documents per project; check yours against the
  volume you will issue before a large batch.
- **Issuing a large batch** writes its codes in chunks and only marks the
  batch `codes_issued` once every chunk is stored. An issuance cut off
  part-way (a serverless time limit, say) leaves the batch `planned`; run it
  again and it fills in the rest without duplicating anything.
- **API requests.** Each verification is a few requests to Sanity (the
  lookup, the rate-limit buckets, the scan write). Watch the project's usage
  page as traffic grows.
