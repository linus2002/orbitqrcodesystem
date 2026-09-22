/**
 * Database access layer.
 *
 * Uses Node's built-in `node:sqlite` (Node 22.5+), so the project has ZERO
 * native build dependencies: `npm install` never needs a C++ toolchain. That
 * is the main reason SQLite is the default here.
 *
 * Moving to PostgreSQL later means replacing this one file plus the type
 * names in schema.sql. Nothing above this layer talks to the driver directly;
 * services only ever use `db.get/all/run/tx`.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

let handle = null;

/** Absolute path to schema.sql (resolved relative to this module, Windows-safe). */
const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/**
 * Open (or reuse) the database connection.
 *
 * @param {string} [file] override the configured path; ':memory:' for tests.
 */
export function open(file = config.db.file) {
  if (handle) return handle;

  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  handle = new DatabaseSync(file);

  // --- Pragmas ------------------------------------------------------------
  // WAL: readers never block the writer, which matters because the admin
  // dashboard polls while verification traffic is writing scan rows.
  if (file !== ':memory:') handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec('PRAGMA foreign_keys = ON;');
  handle.exec('PRAGMA busy_timeout = 5000;');
  // NORMAL is the right durability/throughput trade-off under WAL: a power
  // loss can cost the last transaction, never the database file's integrity.
  handle.exec('PRAGMA synchronous = NORMAL;');

  return handle;
}

/** The live connection, opening it on first use. */
export function db() {
  return handle ?? open();
}

/** Close the connection (tests, graceful shutdown). */
export function close() {
  if (handle) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
    handle = null;
  }
}

/** Apply schema.sql. Safe to run repeatedly - every statement is IF NOT EXISTS. */
export function migrate({ silent = false } = {}) {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const conn = db();
  conn.exec(sql);
  conn
    .prepare(
      `INSERT INTO schema_meta (key, value) VALUES ('migrated_at', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    )
    .run(new Date().toISOString());
  if (!silent) console.log('[db] schema applied');
  return conn;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Run a statement. Returns `{ changes, lastInsertRowid }` (rowid as Number). */
export function run(sql, params = []) {
  const res = db().prepare(sql).run(...params);
  return {
    changes: Number(res.changes),
    lastInsertRowid: Number(res.lastInsertRowid),
  };
}

/** Fetch a single row, or undefined. */
export function get(sql, params = []) {
  return db().prepare(sql).get(...params);
}

/** Fetch all matching rows. */
export function all(sql, params = []) {
  return db().prepare(sql).all(...params);
}

/** Fetch the first column of the first row (for COUNT(*) and friends). */
export function scalar(sql, params = []) {
  const row = get(sql, params);
  return row ? Object.values(row)[0] : undefined;
}

/**
 * Run `fn` inside a transaction, committing on return and rolling back on
 * throw. Nested calls join the outer transaction rather than failing.
 *
 * Verification uses this so that "log the scan + bump the counter + raise the
 * alert" can never be left half-applied.
 */
let txDepth = 0;
export function tx(fn) {
  const conn = db();
  if (txDepth > 0) return fn(); // already inside a transaction

  conn.exec('BEGIN IMMEDIATE');
  txDepth += 1;
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* connection may already be unwound */
    }
    throw err;
  } finally {
    txDepth -= 1;
  }
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

export default { open, db, close, migrate, run, get, all, scalar, tx, paginate };
