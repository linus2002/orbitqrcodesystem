/**
 * Database access layer.
 *
 * Two drivers sit behind one interface, chosen by configuration:
 *
 *   Postgres (Supabase)  when DATABASE_URL is set - the production target,
 *                        and the only option that both persists and is shared
 *                        across instances on a serverless platform
 *   libSQL               otherwise - `:memory:` for tests, a local file for
 *                        development, so neither needs a server running
 *
 * Both speak the same SQLite-flavoured SQL: src/db/postgres.js translates the
 * three constructs that differ. Every call is async because a hosted database
 * is a network round trip. Nothing above this layer talks to a driver
 * directly; services only ever use `db.get/all/run/scalar/tx`.
 */
import { createClient } from '@libsql/client';
import { PostgresDriver } from './postgres.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

let handle = null;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The schema for whichever engine is in use (resolved Windows-safe). */
const schemaPath = () =>
  path.join(HERE, config.db.postgresUrl ? 'schema.postgres.sql' : 'schema.sql');

/**
 * Turn the configured target into a libSQL URL.
 *
 * A Turso URL wins when one is set. Otherwise this is a local file, which the
 * driver wants as a `file:` URL rather than a bare path.
 */
function resolveTarget(file) {
  if (config.db.url) {
    return { url: config.db.url, authToken: config.db.authToken || undefined };
  }
  if (file === ':memory:') return { url: ':memory:' };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { url: `file:${file.replace(/\\/g, '/')}` };
}

/**
 * Open (or reuse) the connection.
 *
 * @param {string} [file] override the configured path; ':memory:' for tests.
 */
export function open(file = config.db.file) {
  if (handle) return handle;
  handle = config.db.postgresUrl
    ? new PostgresDriver(config.db.postgresUrl)
    : createClient(resolveTarget(file));
  return handle;
}

/** The live connection, opening it on first use. */
export function db() {
  return handle ?? open();
}

/**
 * Close the connection (tests, graceful shutdown).
 *
 * Awaitable: closing a Postgres pool drains it, whereas libSQL's close is
 * immediate. Callers that do not care can still fire and forget.
 */
export async function close() {
  if (handle) {
    try {
      await handle.close();
    } catch {
      /* already closed */
    }
    handle = null;
    activeTx = null;
    txDepth = 0;
  }
}

/*
 * The transaction currently in flight, if any.
 *
 * libSQL hands back a transaction object that statements must be issued
 * against, but `await tx(fn)` takes a plain callback and the 100-odd call sites
 * inside those callbacks just call `db.run(...)`. Holding the handle here lets
 * every helper below route itself, so a transaction stays invisible to callers
 * - exactly as it was when the driver was synchronous.
 *
 * This is safe because a single request owns the connection for the life of
 * the transaction: `tx` refuses to start a second top-level one concurrently.
 */
let activeTx = null;
let txDepth = 0;

/** Whichever executor statements should go to right now. */
const executor = () => activeTx ?? db();

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Run a statement. Returns `{ changes, lastInsertRowid }` (rowid as Number). */
export async function run(sql, params = []) {
  const res = await executor().execute({ sql, args: params });
  return {
    changes: Number(res.rowsAffected ?? 0),
    lastInsertRowid: res.lastInsertRowid == null ? 0 : Number(res.lastInsertRowid),
  };
}

/** Fetch a single row, or undefined. */
export async function get(sql, params = []) {
  const res = await executor().execute({ sql, args: params });
  return res.rows.length ? { ...res.rows[0] } : undefined;
}

/** Fetch all matching rows. */
export async function all(sql, params = []) {
  const res = await executor().execute({ sql, args: params });
  return res.rows.map((r) => ({ ...r }));
}

/** Fetch the first column of the first row (for COUNT(*) and friends). */
export async function scalar(sql, params = []) {
  const res = await executor().execute({ sql, args: params });
  if (!res.rows.length) return undefined;
  return res.rows[0][res.columns[0]];
}

/** Apply schema.sql. Safe to run repeatedly - every statement is IF NOT EXISTS. */
export async function migrate({ silent = false } = {}) {
  const sql = fs.readFileSync(schemaPath(), 'utf8');
  const conn = db();
  await conn.executeMultiple(sql);
  await run(
    `INSERT INTO schema_meta (key, value) VALUES ('migrated_at', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [new Date().toISOString()]
  );
  if (!silent) console.log('[db] schema applied');
  return conn;
}

/**
 * Run `fn` inside a transaction, committing on return and rolling back on
 * throw. Nested calls join the outer transaction rather than failing.
 *
 * Verification uses this so that "log the scan + bump the counter + raise the
 * alert" can never be left half-applied.
 */
export async function tx(fn) {
  if (txDepth > 0) return fn(); // already inside a transaction

  const transaction = await db().transaction('write');
  activeTx = transaction;
  txDepth += 1;
  try {
    const result = await fn();
    await transaction.commit();
    return result;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      /* connection may already be unwound */
    }
    throw err;
  } finally {
    txDepth -= 1;
    activeTx = null;
  }
}

/**
 * Empty the named tables and restart their identity counters.
 *
 * The two engines reset auto-increment differently: SQLite keeps its counters
 * in sqlite_sequence, a table Postgres does not have, so a plain DELETE loop
 * leaves Postgres identities continuing from where they stopped - and the seed
 * data, which assumes product 1 and batch 1, would be built on ids that no
 * longer start at 1.
 *
 * Destructive by definition; the caller decides whether that is appropriate.
 */
export async function resetTables(names) {
  if (config.db.postgresUrl) {
    const list = names.map((n) => `"${n}"`).join(', ');
    await run(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    return;
  }
  for (const name of names) await run(`DELETE FROM "${name}"`);
  // Present only once a table with AUTOINCREMENT has been written to.
  const seq = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`);
  if (seq) await run('DELETE FROM sqlite_sequence');
}

/**
 * Empty every table and restart identity counters. TESTS ONLY.
 *
 * With SQLite the equivalent is simply opening a new `:memory:` database, so
 * this exists for the Postgres path, where the tests share one real server.
 *
 * Guarded by an explicit opt-in: `npm test` with a production DATABASE_URL
 * still in the shell would otherwise erase that database, and the shape of
 * that accident - one stray environment variable - is far too easy.
 */
export async function resetForTests() {
  if (!config.db.postgresUrl) return;
  if (process.env.ALLOW_DESTRUCTIVE_TEST_DB !== '1') {
    throw new Error(
      'Refusing to wipe a Postgres database. Tests truncate every table, so ' +
        'set ALLOW_DESTRUCTIVE_TEST_DB=1 only when DATABASE_URL points at a ' +
        'throwaway database.'
    );
  }
  const names = await tables();
  if (!names.length) return;
  const list = names.map((n) => `"${n}"`).join(', ');
  await run(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Every table in the database, for migration reporting.
 *
 * The two engines keep their catalogue in different places - sqlite_master
 * versus information_schema - and this is the only query in the codebase that
 * has to know which engine it is talking to.
 */
export async function tables() {
  const rows = config.db.postgresUrl
    ? await all(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name`
      )
    : await all(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      );
  return rows.map((r) => r.name);
}

/**
 * Build a `LIMIT/OFFSET` clause plus a total count, the pattern every admin
 * list endpoint uses. Keeps pagination consistent across the whole API.
 */
export function paginate({ page = 1, pageSize = 25, maxPageSize = 200 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 25, 1), maxPageSize);
  const p = Math.max(Number(page) || 1, 1);
  return { limit: size, offset: (p - 1) * size, page: p, pageSize: size };
}

export default { open, db, close, migrate, run, get, all, scalar, tx, tables, resetTables, resetForTests, paginate };
