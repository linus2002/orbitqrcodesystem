#!/usr/bin/env node
/**
 * Validate the generated Postgres schema without a server.
 *
 *   node scripts/check-pg-schema.js
 *
 * Runs schema.postgres.sql, and a sample of translated queries, through an
 * in-memory Postgres. This is what catches a SQLite-ism surviving into the
 * generated file - it already caught a PRAGMA and AUTOINCREMENT.
 *
 * It is a syntax check, not a substitute for running against real Postgres:
 * pg-mem does not implement every builtin, so the two this schema needs are
 * registered below. Both are standard in a real server.
 */
import { newDb, DataType } from 'pg-mem';
import fs from 'node:fs';

const db = newDb();
db.public.registerFunction({
  name: 'timezone',
  args: [DataType.text, DataType.timestamptz],
  returns: DataType.timestamp,
  implementation: (_tz, t) => t,
});
db.public.registerFunction({
  name: 'to_char',
  args: [DataType.timestamp, DataType.text],
  returns: DataType.text,
  implementation: (t) => new Date(t).toISOString(),
});

const schema = fs.readFileSync(new URL('../src/db/schema.postgres.sql', import.meta.url), 'utf8');
const stmts = schema
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s && !s.split('\n').every((l) => l.trim().startsWith('--')));

let ok = 0, failed = 0;
for (const stmt of stmts) {
  try {
    db.public.none(stmt + ';');
    ok++;
  } catch (e) {
    failed++;
    const first = stmt.split('\n').find((l) => l.trim() && !l.trim().startsWith('--'));
    console.log(`FAILED: ${first?.slice(0, 70)}`);
    console.log(`   -> ${e.message.split('\n')[0].slice(0, 150)}`);
  }
}
console.log(`\nschema statements: ${ok} ok, ${failed} failed`);

if (!failed) {
  // Exercise the translator's output against the live in-memory schema.
  const { translate } = await import('../src/db/postgres.js');
  const probes = [
    ["INSERT INTO products (sku, name, manufacturer) VALUES (?, ?, ?)", ['AMX25', 'Amoxicillin', 'North']],
    ["SELECT id, sku, name FROM products WHERE sku = ?", ['AMX25']],
    ["UPDATE products SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE sku = ?", ['AMX25']],
    ["SELECT COUNT(*) FROM products WHERE name LIKE ?", ['Amox%']],
  ];
  let q = 0;
  for (const [sql, args] of probes) {
    try {
      db.public.query(translate(sql).replace(/\$(\d+)/g, (_, i) => `'${args[i - 1]}'`));
      q++;
    } catch (e) {
      console.log(`QUERY FAILED: ${sql.slice(0, 60)}\n   -> ${e.message.split('\n')[0].slice(0, 130)}`);
    }
  }
  console.log(`translated queries: ${q}/${probes.length} ran`);
  if (q !== probes.length) process.exitCode = 1;
}
