#!/usr/bin/env node
/**
 * Copy an existing SQL database into the Sanity dataset. One-off.
 *
 *   npm run db:import-sql -- --from postgres     (reads DATABASE_URL)
 *   npm run db:import-sql -- --from turso        (reads TURSO_DATABASE_URL, TURSO_AUTH_TOKEN)
 *   npm run db:import-sql -- --from ./data/qrshield.db
 *   ... --to-file ./data/rehearsal.json   (try it locally first)
 *
 * For moving a deployment that ran on Supabase, Turso or a local SQLite file
 * across to Sanity without losing its registry. Every row keeps its id, so
 * printed QR codes, audit entries and alert references all still resolve, and
 * each type's id counter is set past the highest id copied.
 *
 * SAFE TO RE-RUN: a document that already exists is left as it is, so an
 * interrupted import can simply be started again. Every row passes through
 * the same validation the application applies (src/db/schema.js), so a row
 * the old database let through with a bad status stops the import and is
 * named, rather than arriving in Sanity broken.
 *
 * Not copied: sessions (everyone signs in again - a session is not worth
 * carrying across a database move) and rate-limit counters (short-lived).
 *
 * Sanity must be configured (SANITY_PROJECT_ID, SANITY_DATASET,
 * SANITY_API_TOKEN). Prints neither the connection string nor the token.
 */
import * as db from '../src/db/index.js';
import { TYPES } from '../src/db/schema.js';

const argv = process.argv.slice(2);
const from = argv[argv.indexOf('--from') + 1];
if (!argv.includes('--from') || !from) {
  console.error('Usage: npm run db:import-sql -- --from postgres | turso | <path to .db file>');
  process.exit(1);
}
// --to-file rehearses the import into a local store file instead.
const toFile = argv.includes('--to-file') ? argv[argv.indexOf('--to-file') + 1] : null;
if (!toFile && !db.usingSanity()) {
  console.error('Sanity is not configured. Set SANITY_PROJECT_ID, SANITY_DATASET and SANITY_API_TOKEN first.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Source: a tiny `rows(sql, args)` over whichever engine holds the data
// ---------------------------------------------------------------------------

async function openSource() {
  if (from === 'postgres') {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    const pg = (await import('pg')).default;
    // Counts and ids arrive as strings otherwise (int8 / numeric).
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
    let n = 0;
    return {
      name: 'PostgreSQL',
      rows: async (sql, args = []) => (await pool.query(sql.replace(/\?/g, () => `$${++n}`), args)).rows,
      reset: () => { n = 0; },
      close: () => pool.end(),
    };
  }
  const { createClient } = await import('@libsql/client');
  const client =
    from === 'turso'
      ? createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined })
      : createClient({ url: `file:${from.replace(/\\/g, '/')}` });
  return {
    name: from === 'turso' ? 'Turso' : `SQLite file ${from}`,
    rows: async (sql, args = []) => (await client.execute({ sql, args })).rows.map((r) => ({ ...r })),
    reset: () => {},
    close: () => client.close(),
  };
}

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

/** One SQL row -> the row shape db.insertMany takes. */
function convert(type, row) {
  const spec = TYPES[type];
  const out = { id: row.id === undefined ? undefined : Number(row.id) };
  for (const [name, def] of Object.entries(spec.fields)) {
    let v = row[name];
    if (v === undefined || v === null) continue;
    if (v instanceof Date) v = def.kind === 'date' ? v.toISOString().slice(0, 10) : v.toISOString();
    if (def.kind === 'int') v = Number(v);
    if (def.kind === 'bool01') v = v === true || Number(v) === 1 ? 1 : 0;
    out[name] = v;
  }
  if (type === 'leaflet') out.sections = JSON.parse(row.sections_json ?? '[]');
  if (type === 'alert' && row.detail_json) {
    try {
      out.ip_hash = JSON.parse(row.detail_json).ipHash ?? undefined;
    } catch {
      /* detail kept as it is */
    }
  }
  if (type === 'setting') delete out.id;
  return out;
}

/** type -> SQL table, in an order where nothing is copied before what it names. */
const ORDER = ['user', 'product', 'leaflet', 'batch', 'code', 'scan', 'alert',
  'consumerReport', 'shipment', 'auditLog', 'smsLog', 'setting'];

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const source = await openSource();
db.open(toFile ?? undefined);
await db.migrate({ silent: true });
console.log(`Copying ${source.name} -> ${db.describe()}\n`);

const PAGE = 2000;
try {
  for (const type of ORDER) {
    const table = TYPES[type].table;
    const keyed = TYPES[type].idKind === 'string';
    let copied = 0;
    let maxId = 0;
    for (let offset = 0; ; offset += PAGE) {
      source.reset();
      const rows = await source.rows(
        `SELECT * FROM ${table} ORDER BY ${keyed ? 'key' : 'id'} LIMIT ? OFFSET ?`,
        [PAGE, offset]
      );
      if (!rows.length) break;
      const docs = rows.map((r) => convert(type, r));
      try {
        await db.insertMany(type, docs, { ifNotExists: true });
      } catch (err) {
        throw new Error(`${table}: ${err.message}`);
      }
      copied += docs.length;
      for (const d of docs) if (Number.isInteger(d.id) && d.id > maxId) maxId = d.id;
      process.stdout.write(`\r  ${table.padEnd(18)} ${String(copied).padStart(8)}`);
      if (rows.length < PAGE) break;
    }
    // New rows continue after the highest id copied, never on top of one.
    if (!keyed && maxId) {
      const id = `counter-${type}`;
      await db.backend().mutate([
        { createIfNotExists: { _id: id, _type: 'counter', doc_type: type, value: 0 } },
      ]);
      const current = await db.backend().getDocument(id);
      if ((current?.value ?? 0) < maxId) {
        await db.backend().mutate([{ patch: { id, set: { value: maxId } } }]);
      }
    }
    process.stdout.write(`\r  ${table.padEnd(18)} ${String(copied).padStart(8)} rows\n`);
  }
  console.log('\nDone. Staff will need to sign in again: sessions are not copied.');
} catch (err) {
  console.error(`\n\nImport stopped: ${err.message}\nFix the row named above and run the import again - it resumes.`);
  process.exitCode = 1;
} finally {
  await source.close();
  await db.close();
}
