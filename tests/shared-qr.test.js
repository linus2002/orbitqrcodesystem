/**
 * A batch with one shared QR: the same code printed on every pack.
 *
 * Everyone who checks it is told it is genuine, with no duplicate flag and
 * no alert - many people checking one code is the point. What still applies:
 * recall, withdrawal (void), expiry and an unreleased batch. And a shared
 * batch has exactly one code.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedUser, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';
import * as serialization from '../src/services/serialization.js';
import { qrPayload } from '../src/lib/codes.js';
import { config } from '../src/config.js';

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
let client;

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  await seedUser({ ...ADMIN, role: 'admin' });
  await db.insert('product', { sku: 'VEN100', name: 'Venapto', strength: '100 mg', manufacturer: 'Adley' });
  client.clearCookies();
  await resetRateLimits();
});

async function sharedBatch({ expiryDays = 700 } = {}) {
  await client.login(ADMIN.email, ADMIN.password);
  const res = await client.post('/api/admin/batches', {
    productId: 1, batchNumber: 'VEN100-S1', quantity: 1, sharedCode: true,
    mfgDate: '2026-11-01', expiryDate: new Date(Date.now() + expiryDays * 86400000).toISOString().slice(0, 10),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.shared_code, 1);
  await serialization.issueCodes(res.body.id, {});
  await serialization.transition(res.body.id, 'printed', {});
  await serialization.transition(res.body.id, 'released', {});
  client.clearCookies();
  const codes = await db.findMany('code', { batch_id: res.body.id });
  assert.equal(codes.length, 1, 'a shared batch has exactly one code');
  return { batchId: res.body.id, code: codes[0].code };
}

test('many different people checking the one shared QR are all told it is genuine', async () => {
  const { code } = await sharedBatch();
  await giveDetails(client);
  const results = [];
  results.push(await client.post('/api/verify', { code }, { fromIp: '198.51.100.1' }));
  for (let i = 0; i < 5; i++) {
    results.push(await client.post('/api/verify', { code }, { fromIp: `203.0.113.${i + 2}`, person: await client.newPerson() }));
  }
  for (const r of results) {
    assert.equal(r.status, 200);
    assert.equal(r.body.result, 'genuine');
    assert.equal(r.body.reason, 'ok_shared');
    assert.equal(r.body.scanNumber, undefined, 'no check count: it is not about this pack');
  }
  assert.equal(await db.count('alert'), 0);
  assert.notEqual((await db.getCode(code)).status, 'flagged');
});

test('the QR deep link of a shared code verifies too', async () => {
  const { code } = await sharedBatch();
  const url = new URL(qrPayload(code, config.secrets.code, config.publicBaseUrl));
  await giveDetails(client);
  const res = await client.post('/api/verify', { code, signature: url.searchParams.get('s') });
  assert.equal(res.body.result, 'genuine');
});

test('a recalled shared batch is still flagged', async () => {
  const { batchId, code } = await sharedBatch();
  await serialization.transition(batchId, 'recalled', { reason: 'Contamination found in QA' });
  await giveDetails(client);
  const res = await client.post('/api/verify', { code });
  assert.equal(res.body.result, 'flagged');
  assert.equal(res.body.reason, 'recalled');
});

test('a shared batch must have a quantity of 1', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const res = await client.post('/api/admin/batches', {
    productId: 1, batchNumber: 'VEN100-S2', quantity: 500, sharedCode: true,
    mfgDate: '2026-11-01', expiryDate: '2028-11-01',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /quantity to 1/);
});

test('an ordinary batch keeps the duplicate rule', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const res = await client.post('/api/admin/batches', {
    productId: 1, batchNumber: 'VEN100-U1', quantity: 2, mfgDate: '2026-11-01', expiryDate: '2028-11-01',
  });
  assert.equal(res.body.shared_code, 0);
  await serialization.issueCodes(res.body.id, {});
  await serialization.transition(res.body.id, 'printed', {});
  await serialization.transition(res.body.id, 'released', {});
  client.clearCookies();
  const [{ code }] = await db.findMany('code', { batch_id: res.body.id });
  await giveDetails(client);
  await client.post('/api/verify', { code }, { fromIp: '198.51.100.1' });
  const second = await client.post('/api/verify', { code }, { fromIp: '203.0.113.9', person: await client.newPerson() });
  assert.equal(second.body.result, 'flagged');
  assert.equal(second.body.reason, 'duplicate_scan');
});
