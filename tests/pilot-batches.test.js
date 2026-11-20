/**
 * Pilot batches: their checks are kept out of the scan log by default - and
 * the log now says how many it is hiding - and a pilot batch can be made
 * live (one way), after which its checks count like any other batch's.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';
import * as verification from '../src/services/verification.js';

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const REGULATOR = { email: 'reg@test.local', password: 'RegulatorPass!2026' };
const ctx = (ip = '10.0.0.1') => ({ ip, channel: 'web', userAgent: 'test' });

let client;
let codes;

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});
beforeEach(async () => {
  await freshDb();
  ({ codes } = await seedBasics({ quantity: 6 }));
  await seedUser({ ...ADMIN, role: 'admin' });
  await seedUser({ ...REGULATOR, role: 'regulator' });
  client.clearCookies();
  await resetRateLimits();
  await client.login(ADMIN.email, ADMIN.password);
});

test('the scan log says how many pilot checks it is hiding, and shows them when asked', async () => {
  await db.update('batch', 1, { is_test: 1 });
  await verification.verify(codes[0], ctx('1.1.1.1'));
  await verification.verify(codes[1], ctx('2.2.2.2'));

  const hidden = (await client.get('/api/admin/scans')).body;
  assert.equal(hidden.total, 0, 'pilot checks are left out by default');
  assert.equal(hidden.hiddenTest, 2, '... and the log says how many');

  const shown = (await client.get('/api/admin/scans?includeTest=true')).body;
  assert.equal(shown.total, 2);
  assert.equal(shown.hiddenTest, 0);
  assert.ok(shown.items.every((s) => s.is_test === 1), 'each row says it is a pilot check');
});

test('a pilot batch made live counts its checks from then on, and it is audited', async () => {
  await db.update('batch', 1, { is_test: 1 });
  await verification.verify(codes[0], ctx('1.1.1.1')); // while still a pilot

  const res = await client.post('/api/admin/batches/1/make-live', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.is_test, 0);

  const after = await verification.verify(codes[1], ctx('2.2.2.2'));
  assert.equal(after.result, 'genuine', 'the patient answer is unchanged');

  const log = (await client.get('/api/admin/scans')).body;
  assert.equal(log.total, 1, 'the check after going live is in the log');
  assert.equal(log.hiddenTest, 1, 'the one before stays a pilot check');

  const entry = await db.findOne('auditLog', { action: 'batch.made_live' });
  assert.ok(entry, 'recorded in the audit log');
});

test('making live is one way, and needs batches:write', async () => {
  // Already live (seedBasics makes a live batch).
  assert.equal((await client.post('/api/admin/batches/1/make-live', {})).status, 400);

  await db.update('batch', 1, { is_test: 1 });
  client.clearCookies();
  await client.login(REGULATOR.email, REGULATOR.password);
  assert.equal((await client.post('/api/admin/batches/1/make-live', {})).status, 403);
  assert.equal((await db.get('batch', 1)).is_test, 1);
});
