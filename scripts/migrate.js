#!/usr/bin/env node
/**
 * Apply the database schema.
 *
 * Idempotent: every statement in the schema is CREATE ... IF NOT EXISTS, so
 * running this against an existing database is safe and is how you pick up
 * newly added tables or indexes. Columns added to existing tables are handled
 * by ensureColumns, which checks before altering.
 *
 *   npm run db:migrate
 *
 * Works against whichever engine is configured - a local SQLite file, or
 * Postgres when DATABASE_URL is set, in which case the generated
 * schema.postgres.sql is what gets applied.
 *
 *   node scripts/migrate.js --hosted-only
 *
 * The form the Vercel build runs. A serverless function has no boot step, so
 * the build is the one moment per deploy where this can run against the
 * hosted database with the project's own environment variables. With no
 * hosted database configured (a preview build, say) it exits 0 without
 * touching anything - it must never create a throwaway local file inside a
 * build container and call that a migration.
 *
 * That check reads process.env directly, before config.js is imported: in a
 * production build config.js refuses to load without the session and code
 * secrets, and a preview build that lacks them should skip, not crash.
 */
const hostedOnly = process.argv.includes('--hosted-only');

if (hostedOnly) {
  const hosted = ['TURSO_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL'].some(
    (key) => (process.env[key] ?? '') !== ''
  );
  if (!hosted) {
    console.log(
      '[db] no hosted database configured (TURSO_DATABASE_URL / DATABASE_URL); ' +
        'skipping migration'
    );
    process.exit(0);
  }
}

const db = await import('../src/db/index.js');
const { config } = await import('../src/config.js');

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
