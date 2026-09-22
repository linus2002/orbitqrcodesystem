/**
 * PostgreSQL adapter (Supabase).
 *
 * The application's ~160 queries are written in SQLite's dialect, and they
 * stay that way. Rather than rewrite every call site, this module translates
 * the handful of constructs that actually differ, in one place where the rules
 * can be read and tested:
 *
 *   ?                        ->  $1, $2, ...        (placeholders)
 *   strftime('%Y-%m-...','now')  ->  an ISO-8601 UTC string
 *   INSERT ...               ->  ... RETURNING id   (for lastInsertRowid)
 *
 * Everything else in the query set - CASE, COALESCE, LIKE, ON CONFLICT DO
 * UPDATE, window-less aggregates - is standard SQL that both engines accept.
 *
 * The schema is NOT translated at runtime: schema.postgres.sql is the
 * Postgres form, kept beside the SQLite one.
 */
import pg from 'pg';
import { config } from '../config.js';

const { Pool, types } = pg;

/*
 * Postgres returns 64-bit integers and COUNT(*) as strings, because they can
 * exceed what a JS number holds safely. Every id and count in this schema is
 * far below that, and the application compares them as numbers, so they are
 * parsed here rather than at each of the places that would otherwise have to
 * remember. 20 = int8, 1700 = numeric.
 */
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

/** Tables whose rows have no `id` column, so no RETURNING clause applies. */
const NO_ID_TABLES = new Set(['settings', 'schema_meta', 'rate_hits']);

/** The ISO-8601 UTC string the app stores; SQLite spells it with strftime. */
const NOW_ISO = `to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const STRFTIME = /strftime\(\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*'now'\s*\)/gi;

/**
 * Replace `?` placeholders with `$n`, leaving any inside string literals be.
 *
 * A question mark in a literal is not a placeholder, and this query set does
 * contain them (patient-facing message text), so the scan has to track quotes
 * rather than doing a blind replace.
 */
export function toPositional(sql) {
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      // '' inside a string is an escaped quote, not a terminator.
      if (inString && sql[i + 1] === "'") {
        out += "''";
        i += 1;
        continue;
      }
      inString = !inString;
      out += c;
      continue;
    }
    if (c === '?' && !inString) {
      n += 1;
      out += `$${n}`;
      continue;
    }
    out += c;
  }
  return out;
}

/** Apply every dialect rule to one statement. */
export function translate(sql) {
  return toPositional(sql.replace(STRFTIME, NOW_ISO));
}

/** The table an INSERT targets, or null if the statement is not an insert. */
export function insertTarget(sql) {
  const m = /^\s*INSERT\s+INTO\s+"?(\w+)"?/i.exec(sql);
  return m ? m[1].toLowerCase() : null;
}

export class PostgresDriver {
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString,
      // Supabase terminates TLS with its own certificate chain; verifying it
      // would need the CA bundle shipped alongside the app.
      ssl: { rejectUnauthorized: false },
      // A serverless instance handles one request at a time, and Supabase's
      // pooler is what fans out - a large local pool would just hold
      // connections open across cold starts.
      max: config.isProd ? 1 : 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  /** Run a statement, returning rows plus insert metadata. */
  async execute({ sql, args = [] }, client = null) {
    let text = translate(sql);

    const table = insertTarget(sql);
    const wantsId = table && !NO_ID_TABLES.has(table) && !/RETURNING/i.test(text);
    if (wantsId) text += ' RETURNING id';

    const runner = client ?? this.pool;
    const res = await runner.query(text, args);

    return {
      rows: res.rows,
      columns: res.fields?.map((f) => f.name) ?? [],
      rowsAffected: res.rowCount ?? 0,
      lastInsertRowid: wantsId && res.rows[0] ? res.rows[0].id : undefined,
    };
  }

  /** Run schema DDL, which arrives as one multi-statement string. */
  async executeMultiple(sql) {
    const client = await this.pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  }

  /**
   * Check out one connection and run `fn` against it inside a transaction.
   *
   * A transaction has to stay on a single connection, which is why this hands
   * back an executor bound to that client rather than to the pool.
   */
  async transaction() {
    const client = await this.pool.connect();
    await client.query('BEGIN');
    return {
      execute: (stmt) => this.execute(stmt, client),
      commit: async () => {
        try {
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      },
      rollback: async () => {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      },
    };
  }

  async close() {
    await this.pool.end();
  }
}

export default PostgresDriver;
