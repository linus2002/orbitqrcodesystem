#!/usr/bin/env node
/**
 * Apply the database schema.
 *
 * Idempotent: every statement in schema.sql is CREATE ... IF NOT EXISTS, so
 * running this against an existing database is safe and is how you pick up
 * newly added tables or indexes.
 *
 *   npm run db:migrate
 */
import * as db from '../src/db/index.js';
import { config } from '../src/config.js';

db.open();
await db.migrate();

const tables = await db.all(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
);

console.log(`\nDatabase : ${config.db.file}`);
console.log(`Tables   : ${tables.length}`);
for (const t of tables) {
  const n = await db.scalar(`SELECT COUNT(*) FROM "${t.name}"`);
  console.log(`  ${t.name.padEnd(20)} ${String(n).padStart(8)} rows`);
}
await db.close();
