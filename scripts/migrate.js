#!/usr/bin/env node
/**
 * Check the data store and report what is in it.
 *
 *   npm run db:migrate
 *
 * A Sanity dataset has no schema to apply - the document types are enforced
 * by the application (src/db/schema.js) on every write - so there is nothing
 * to migrate in the SQL sense. What this still does is the part a deploy
 * relied on: prove the store is reachable with the configured credentials
 * before anything is served from it, and print a document count per type.
 *
 * Against Sanity it also checks that the dataset is PRIVATE, by querying it
 * with no token at all. A public dataset would let anyone who learns the
 * project id read every scan, user and code, so this fails loudly.
 *
 *   node scripts/migrate.js --hosted-only
 *
 * The form the Vercel build runs. With no Sanity configured (a preview build,
 * say) it exits 0 without touching anything - it must never create a
 * throwaway local file inside a build container and call that a database.
 *
 * That check reads process.env directly, before config.js is imported: in a
 * production build config.js refuses to load without the session and code
 * secrets, and a preview build that lacks them should skip, not crash.
 *
 * Never prints the project id or the token.
 */
const hostedOnly = process.argv.includes('--hosted-only');

if (hostedOnly) {
  const hosted = ['SANITY_PROJECT_ID', 'SANITY_DATASET', 'SANITY_API_TOKEN'].every(
    (key) => (process.env[key] ?? '') !== ''
  );
  if (!hosted) {
    console.log('[db] Sanity is not configured (SANITY_PROJECT_ID / SANITY_DATASET / SANITY_API_TOKEN); skipping check');
    process.exit(0);
  }
}

const db = await import('../src/db/index.js');
const { config } = await import('../src/config.js');

db.open();
await db.migrate();

if (db.usingSanity()) {
  const { projectId, dataset, apiVersion } = config.sanity;
  const url = `https://${projectId}.api.sanity.io/v${apiVersion}/data/query/${dataset}?query=${encodeURIComponent('count(*)')}`;
  let exposed = false;
  try {
    const res = await fetch(url);
    // A private dataset answers an anonymous query with no documents at all.
    const body = await res.json().catch(() => ({}));
    exposed = res.ok && Number(body.result) > 0;
  } catch {
    console.warn('[db] could not check the dataset visibility (network); check it by hand');
  }
  if (exposed) {
    console.error(
      '\n[db] THE DATASET IS PUBLIC: anyone who knows the project id can read every document.\n' +
        '     Make it private before going further:\n\n' +
        '       cd studio && npx sanity dataset visibility set <dataset> private\n'
    );
    await db.close();
    process.exit(1);
  }
  // An EMPTY public dataset also answers 0, so an empty store proves nothing.
  const stored = await db.query('count(*)');
  if (stored > 0) console.log('[db] dataset is private');
  else console.warn('[db] dataset is empty, so its visibility cannot be checked yet - make sure it is private');
}

const counts = await db.stats();
console.log(`\nStore    : ${db.describe()}`);
for (const [type, n] of Object.entries(counts)) {
  console.log(`  ${type.padEnd(20)} ${String(n).padStart(8)} documents`);
}
await db.close();
