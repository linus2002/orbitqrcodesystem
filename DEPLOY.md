# Deploying Orbit QR Counterfeit System

The data lives in a **Sanity** dataset, whichever host serves the app. That
makes every host the same shape:

| | Vercel | Railway / Render / Fly |
|---|---|---|
| Data | Sanity | Sanity |
| Instances | many, serverless | as many as you like |
| Rate limiting | shared, in Sanity | shared, in Sanity |
| Config | `SANITY_*` variables | `SANITY_*` variables |

**[Vercel](#vercel) is the quickest to stand up** and needs no container. A
`Dockerfile` is included for the three container hosts.

Without the Sanity variables the app falls back to a local file
(`DB_FILE`). That is for development, or a single container with a volume -
never Vercel, whose disk is discarded after each request.

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

The code registry is the system of record; losing it orphans every pack in
circulation. Export the dataset on a schedule:

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
