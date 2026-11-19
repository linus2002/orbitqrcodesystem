#!/usr/bin/env node
/**
 * Run the whole test suite against PostgreSQL instead of the memory store.
 *
 *   npm run test:postgres
 *
 * Each test gets a fresh schema in PGlite - real Postgres compiled to
 * WebAssembly, started inside the test process (tests/helpers.js) - so this
 * needs no database server and never touches DATABASE_URL. A small script
 * rather than an inline `TEST_BACKEND=postgres npm test`, which Windows'
 * shell does not understand.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', 'tests/**/*.test.js'],
  { stdio: 'inherit', env: { ...process.env, TEST_BACKEND: 'postgres' } }
);
process.exit(result.status ?? 1);
