#!/usr/bin/env node
/**
 * First-run setup.
 *
 *   npm run setup
 *
 * Creates a .env with freshly generated secrets (never overwriting an existing
 * one), applies the schema, and loads the demonstration data.
 *
 * The generated CODE_SECRET is the important one: it signs the checksum of
 * every code this installation will ever mint. Rotating it later invalidates
 * every code already printed on a physical pack, so the file it lands in
 * should be treated as a permanent, backed-up secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

const secret = () => crypto.randomBytes(48).toString('base64url');

console.log('\nQR Shield setup\n' + '='.repeat(52));

if (fs.existsSync(ENV_PATH)) {
  console.log('\n.env already exists - leaving it untouched.');
  console.log('Delete it first if you want fresh secrets generated.');
} else {
  const template = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  const env = template
    .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${secret()}`)
    .replace(/^CODE_SECRET=.*$/m, `CODE_SECRET=${secret()}`)
    .replace(/^SMS_WEBHOOK_SECRET=.*$/m, `SMS_WEBHOOK_SECRET=${secret()}`);

  fs.writeFileSync(ENV_PATH, env, { mode: 0o600 });
  console.log('\nCreated .env with freshly generated secrets.');
  console.log('  SESSION_SECRET     rotating this signs everyone out');
  console.log('  CODE_SECRET        treat as PERMANENT once codes are printed');
  console.log('  SMS_WEBHOOK_SECRET give this to your SMS gateway');
}

console.log('\nApplying the database schema and demo data...\n');
const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed.js')], {
  stdio: 'inherit',
  cwd: ROOT,
});

if (result.status !== 0) {
  console.error('\nSetup failed while seeding.');
  process.exit(result.status ?? 1);
}

console.log('='.repeat(52));
console.log('Setup complete. Start the server with:\n');
console.log('  npm start\n');
