#!/usr/bin/env node
/**
 * Create a staff account.
 *
 *   npm run user:create -- --email you@example.com --name "Your Name" --password "..."
 *   npm run user:create -- --email a@b.com --name "Ada" --password "..." --role security
 *
 * Runs against whichever database is configured, so pointing DATABASE_URL at
 * Supabase creates the account there:
 *
 *   DATABASE_URL='postgresql://...' npm run user:create -- --email ... --name ... --password ...
 *
 * This is how the FIRST admin is made: a fresh deployment has an empty users
 * table, and there is no sign-up - staff accounts are only ever created by an
 * administrator, or by this script when there is not yet an administrator to
 * do it.
 *
 * Goes through the same createUser() the dashboard uses, so the password
 * strength rules, the role check and the audit entry all apply.
 */
import * as db from '../src/db/index.js';
import { config } from '../src/config.js';
import * as auth from '../src/services/auth.js';

/**
 * Parse `--key value` pairs.
 *
 * A value runs until the next `--flag`, so a multi-word name survives npm and
 * PowerShell stripping its quotes: `--name "Ada Lovelace"` reaches this script
 * as two separate arguments, and taking only the first would silently create
 * an account called "Ada".
 */
function args(argv) {
  const out = {};
  let key = null;
  for (const token of argv) {
    if (token.startsWith('--')) {
      key = token.slice(2);
      out[key] = 'true';
      continue;
    }
    if (!key) continue;
    out[key] = out[key] === 'true' ? token : `${out[key]} ${token}`;
  }
  return out;
}

const a = args(process.argv.slice(2));
const email = a.email ?? process.env.ADMIN_EMAIL;
const name = a.name ?? process.env.ADMIN_NAME;
const password = a.password ?? process.env.ADMIN_PASSWORD;
const role = a.role ?? 'admin';

if (!email || !name || !password) {
  console.error(`
Create a staff account.

  npm run user:create -- --email you@example.com --name "Your Name" --password "a-strong-password"

Options:
  --email     required
  --name      required
  --password  required (at least ${config.auth.minPasswordLength} characters)
  --role      admin | security | regulator   (default: admin)

Against a hosted database, set DATABASE_URL first.
`);
  process.exit(1);
}

db.open();

const target = config.db.postgresUrl
  ? 'PostgreSQL (hosted)'
  : config.db.url
    ? 'libSQL (hosted)'
    : config.db.file;
console.log(`Database : ${target}`);

try {
  const user = await auth.createUser(
    { email, fullName: name, role, password, mustChangePassword: false },
    {}
  );
  console.log(`\nCreated ${user.role} account:`);
  console.log(`  ${user.email}`);
  console.log(`  ${user.fullName}`);
  console.log(`\nSign in at ${config.publicBaseUrl}/login`);
} catch (err) {
  // The service throws structured API errors; show the useful part.
  const detail = err.details?.map((d) => `  - ${d.message}`).join('\n');
  console.error(`\nCould not create the account: ${err.message}`);
  if (detail) console.error(detail);
  process.exitCode = 1;
} finally {
  await db.close();
}
