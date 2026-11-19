#!/usr/bin/env node
/**
 * Copy everything from the Sanity dataset into PostgreSQL - once, at cut-over.
 *
 *   npm run db:sanity-to-postgres -- --dry-run     count, change nothing
 *   npm run db:sanity-to-postgres                  copy
 *   npm run db:sanity-to-postgres -- --overwrite   copy into a non-empty database
 *
 * Needs both stores configured: SANITY_PROJECT_ID, SANITY_DATASET and
 * SANITY_API_TOKEN for the source, DATABASE_URL (and DATABASE_SCHEMA /
 * DATABASE_SSL if not the defaults) for the target.
 *
 * WHAT IS COPIED
 *
 *   documents   every published document - products, batches, codes, scans,
 *               users, sessions, alerts, settings, counters, unique-key claims
 *               - unchanged, same ids. Drafts and Sanity's own system
 *               documents are skipped.
 *   files       every file asset (the leaflet PDFs), byte for byte, under the
 *               SAME id, so the leaflet records that point at them keep
 *               working. Each is checked against Sanity's SHA-1 of it.
 *   avatars     a picture still kept inline on a user (a data URL) becomes a
 *               stored avatar file, as new uploads are.
 *
 * Safe to re-run: every write is an upsert keyed on the id. It refuses a
 * target that already holds documents unless --overwrite is given, because
 * once the app runs on Postgres, Postgres has the newer data - re-copying
 * from Sanity then would roll it back.
 *
 * Stop the app (or keep it on Sanity) while this runs, so nothing is written
 * to Sanity after its documents were read. Never prints credentials.
 */
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { SanityBackend } from '../src/db/sanity.js';
import { PostgresBackend } from '../src/db/postgres.js';
import { sniff, MIME, IMAGE_FORMATS, LIMITS } from '../src/services/files.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const overwrite = argv.includes('--overwrite');
const PAGE = 1000;

if (!config.sanity.enabled) {
  console.error('Sanity is not configured: set SANITY_PROJECT_ID, SANITY_DATASET and SANITY_API_TOKEN (the source).');
  process.exit(1);
}
if (!config.postgres.enabled) {
  console.error('DATABASE_URL is not set (the target). See DEPLOY.md, "Coolify".');
  process.exit(1);
}

const source = new SanityBackend(config.sanity);
const target = new PostgresBackend({ ...config.postgres, listen: false });

/** Every document worth copying, a page at a time, in id order. */
const DOC_FILTER =
  '!(_id in path("drafts.**")) && !(_id in path("_.**")) && !string::startsWith(_type, "sanity.") && !string::startsWith(_type, "system.")';

async function* sourceDocs() {
  let after = '';
  for (;;) {
    const page = await source.fetch(`*[${DOC_FILTER} && _id > $after] | order(_id asc) [0...${PAGE}]`, { after });
    if (!page.length) return;
    yield page;
    after = page[page.length - 1]._id;
    if (page.length < PAGE) return;
  }
}

async function upsertDocs(docs) {
  await target.pool.query(
    `INSERT INTO ${target.t} (id, type, rev, created_at, updated_at, doc)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::jsonb[])
     ON CONFLICT (id) DO UPDATE
       SET type = EXCLUDED.type, rev = EXCLUDED.rev, created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at, doc = EXCLUDED.doc`,
    [
      docs.map((d) => d._id),
      docs.map((d) => d._type),
      docs.map((d) => d._rev ?? crypto.randomBytes(9).toString('base64url')),
      docs.map((d) => d._createdAt ?? new Date().toISOString()),
      docs.map((d) => d._updatedAt ?? d._createdAt ?? new Date().toISOString()),
      docs.map((d) => JSON.stringify(d)),
    ]
  );
}

async function upsertFile({ id, kind, filename, contentType, bytes, meta, createdBy }) {
  await target.pool.query(
    `INSERT INTO ${target.f} (id, kind, filename, content_type, size, sha256, bytes, meta, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE
       SET kind = EXCLUDED.kind, filename = EXCLUDED.filename, content_type = EXCLUDED.content_type,
           size = EXCLUDED.size, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, meta = EXCLUDED.meta`,
    [
      id, kind, filename ?? null, contentType, bytes.length,
      crypto.createHash('sha256').update(bytes).digest('hex'), bytes,
      JSON.stringify(meta ?? {}), createdBy ?? null,
    ]
  );
}

/** A user's inline data-URL avatar becomes a stored file; returns the doc to write. */
async function moveAvatar(doc, stats) {
  const m = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(doc.avatar ?? ''));
  if (!m) return doc;
  const bytes = Buffer.from(m[2], 'base64');
  const format = sniff(bytes);
  if (!IMAGE_FORMATS.includes(format) || bytes.length > LIMITS.avatar) {
    // Not something the app would accept today: dropped rather than carried.
    stats.avatarsDropped++;
    const { avatar, ...rest } = doc;
    return rest;
  }
  const id = `avatar-${doc.id}-migrated-${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12)}`;
  if (!dryRun) {
    await upsertFile({
      id, kind: 'avatar', filename: `avatar.${format === 'jpeg' ? 'jpg' : format}`,
      contentType: MIME[format], bytes, createdBy: doc.id, meta: { migratedFrom: 'sanity' },
    });
  }
  stats.avatarsMoved++;
  return { ...doc, avatar: `file:${id}` };
}

async function main() {
  console.log(`Source : ${source.name}`);
  console.log(`Target : ${target.name}${dryRun ? '   (dry run: nothing is written)' : ''}\n`);

  await target.ready;
  const existing = (await target.pool.query(`SELECT count(*)::int AS n FROM ${target.t}`)).rows[0].n;
  if (existing > 0 && !overwrite && !dryRun) {
    console.error(
      `The target already holds ${existing} documents. If the app has been running on Postgres, ` +
        'it has newer data than Sanity and copying again would roll it back.\n' +
        'Re-run with --overwrite only if you are sure the target holds nothing newer.'
    );
    process.exit(1);
  }

  // --- documents ------------------------------------------------------------
  const stats = { avatarsMoved: 0, avatarsDropped: 0 };
  const perType = new Map();
  let total = 0;
  for await (const page of sourceDocs()) {
    const docs = [];
    for (const d of page) {
      perType.set(d._type, (perType.get(d._type) ?? 0) + 1);
      docs.push(d._type === 'user' ? await moveAvatar(d, stats) : d);
    }
    if (!dryRun) await upsertDocs(docs);
    total += page.length;
    process.stdout.write(`\r  documents copied: ${total}`);
  }
  console.log(`\r  documents ${dryRun ? 'found' : 'copied'}: ${total}`);

  // --- files ---------------------------------------------------------------
  const assets = await source.fetch(
    '*[_type == "sanity.fileAsset"]{ _id, url, originalFilename, mimeType, size, sha1hash, _createdAt }'
  );
  let fileBytes = 0;
  for (const [i, a] of assets.entries()) {
    process.stdout.write(`\r  files ${dryRun ? 'found' : 'copied'}: ${i + 1}/${assets.length}`);
    fileBytes += Number(a.size ?? 0);
    if (dryRun) continue;
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(`could not download ${a._id}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (a.sha1hash && crypto.createHash('sha1').update(bytes).digest('hex') !== a.sha1hash) {
      throw new Error(`${a._id} did not arrive intact (SHA-1 mismatch); nothing was stored for it`);
    }
    await upsertFile({
      id: a._id,
      kind: 'leaflet',
      filename: a.originalFilename ?? null,
      contentType: a.mimeType ?? 'application/pdf',
      bytes,
      meta: { migratedFrom: 'sanity' },
    });
  }
  console.log(`\r  files ${dryRun ? 'found' : 'copied'}: ${assets.length} (${(fileBytes / 1048576).toFixed(1)} MB)`);
  if (stats.avatarsMoved || stats.avatarsDropped) {
    console.log(`  avatars moved to files: ${stats.avatarsMoved}${stats.avatarsDropped ? `, dropped (not a valid image): ${stats.avatarsDropped}` : ''}`);
  }

  // --- check -----------------------------------------------------------------
  console.log('\n  type                      sanity   postgres');
  const { rows } = await target.pool.query(`SELECT type, count(*)::int AS n FROM ${target.t} GROUP BY type`);
  const inTarget = new Map(rows.map((r) => [r.type, r.n]));
  let mismatch = false;
  for (const [type, n] of [...perType].sort(([a], [b]) => a.localeCompare(b))) {
    const m = inTarget.get(type) ?? 0;
    const flag = !dryRun && m < n ? '   <-- MISSING' : '';
    if (flag) mismatch = true;
    console.log(`  ${type.padEnd(24)} ${String(n).padStart(8)} ${String(m).padStart(10)}${flag}`);
  }
  if (mismatch) {
    console.error('\nSome documents did not arrive. Re-run with --overwrite; the copy is idempotent.');
    process.exitCode = 1;
  } else if (!dryRun) {
    console.log('\nDone. Point the app at Postgres (DATABASE_URL) and start it; Sanity is no longer read.');
  }
}

try {
  await main();
} finally {
  await target.close();
}
