#!/usr/bin/env node
/**
 * Delete the database file and rebuild it from scratch, then reseed.
 *
 *   npm run db:reset
 *
 * Refuses to run when NODE_ENV=production - this destroys the code registry,
 * which in a live system is unrecoverable and would orphan every printed pack.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { config } from '../src/config.js';

if (config.isProd) {
  console.error('Refusing to reset the database while NODE_ENV=production.');
  process.exit(1);
}

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const file = `${config.db.file}${suffix}`;
  if (!fs.existsSync(file)) continue;

  try {
    fs.rmSync(file);
    console.log(`removed ${file}`);
  } catch (err) {
    // The overwhelmingly common cause is that the development server is still
    // running and holding the database open. Say so, instead of surfacing a
    // raw EPERM/EBUSY stack trace that reads like a bug in the script.
    if (err.code === 'EPERM' || err.code === 'EBUSY') {
      console.error(
        `\nCannot delete ${file} - it is still in use.\n\n` +
          'Stop anything using the database first (usually `npm start` or `npm run dev`\n' +
          'in another terminal), then run this again.\n'
      );
      process.exit(1);
    }
    throw err;
  }
}

const result = spawnSync(process.execPath, ['scripts/seed.js'], { stdio: 'inherit' });
process.exit(result.status ?? 0);
