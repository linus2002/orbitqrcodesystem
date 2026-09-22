#!/usr/bin/env node
/**
 * Apply the database schema.
 *
 * Idempotent: every statement in the schema is CREATE ... IF NOT EXISTS, so
 * running this against an existing database is safe and is how you pick up
 * newly added tables or indexes.
 *
 *   npm run db:migrate
 *
 * Works against whichever engine is configured - a local SQLite file, or
 * Postgres when DATABASE_URL is set, in which case the generated
 * schema.postgres.sql is what gets applied.
 */
import * as db from '../src/db/index.js';
import { config } from '../src/config.js';

db.open();
await db.migrate();

const tables = await db.tables();

// Never print the connection string itself: it carries the password.
const target = config.db.postgresUrl
  ? 'PostgreSQL (hosted)'
  : config.db.url
    ? 'libSQL (hosted)'
    : config.db.file;

console.log(`\nDatabase : ${target}`);
console.log(`Tables   : ${tables.length}`);
for (const name of tables) {
  const n = await db.scalar(`SELECT COUNT(*) FROM "${name}"`);
  console.log(`  ${name.padEnd(20)} ${String(n).padStart(8)} rows`);
}
await db.close();
