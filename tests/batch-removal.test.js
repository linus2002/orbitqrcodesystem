/**
 * Removing a batch.
 *
 * A batch can be removed only while no code exists for it - a typo in the
 * batch number, the wrong product, a cancelled run. From the first code on,
 * the codes may be with the packaging line and the batch is part of the
 * record for good. These pin that line from both sides, including the case
 * the status alone would miss: an interrupted issuance leaves a batch still
 * "planned" that already has codes.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';

let client;

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const REGULATOR = { email: 'regulator@test.local', password: 'RegulatorPass!2026' };

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  await seedBasics({ quantity: 4 }); // batch 1 (AMX25-T1), codes issued and released
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  await seedUser({ ...REGULATOR, role: 'regulator', name: 'Rita Regulator' });
  client.clearCookies();
  await resetRateLimits();
});

/** A new batch through the API, as the dashboard creates one: planned, no codes. */
async function plannedBatch(batchNumber = 'AMX25-2610A') {
  const res = await client.post('/api/admin/batches', {
    productId: 1, batchNumber, quantity: 5, mfgDate: '2026-09-01', expiryDate: '2028-09-01',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id;
}

const remove = (id) => client.request(`/api/admin/batches/${id}`, { method: 'DELETE' });

test('a planned batch with no codes is removed, and its number can be used again', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const id = await plannedBatch();

  const res = await remove(id);
  assert.equal(res.status, 204);
  assert.equal((await client.get(`/api/admin/batches/${id}`)).status, 404);

  // The number is free: the unique claim went with the row.
  const again = await plannedBatch();
  assert.notEqual(again, id, 'a new batch gets a new id, so its codes cannot match');
  const issued = await client.post(`/api/admin/batches/${again}/issue-codes`);
  assert.equal(issued.status, 201);
});

test('the removal is in the audit log with what the batch was', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const id = await plannedBatch();
  await remove(id);

  const entry = await db.findOne('auditLog', { action: 'batch.delete' });
  assert.ok(entry, 'an audit entry is written');
  assert.equal(entry.entity_id, String(id));
  const detail = JSON.parse(entry.detail_json);
  assert.equal(detail.batchNumber, 'AMX25-2610A');
  assert.equal(detail.sku, 'AMX25');
  assert.equal(detail.quantity, 5);
});

test('a batch whose codes are issued cannot be removed', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const id = await plannedBatch();
  await client.post(`/api/admin/batches/${id}/issue-codes`);

  const res = await remove(id);
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /part of the record/);
  assert.equal((await client.get(`/api/admin/batches/${id}`)).status, 200, 'still there');

  // The seeded batch, released and in circulation, likewise.
  assert.equal((await remove(1)).status, 409);
});

test('a planned batch left with codes by an interrupted issuance cannot be removed', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const id = await plannedBatch();
  // What a run that stopped part-way leaves: codes stored, batch never marked.
  await db.insert('code', {
    code: 'AMX25-260901-000001-AA', batch_id: id, product_id: 1, unit_index: 0, serial: '000001',
  });

  const res = await remove(id);
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /did not finish/);
  assert.equal((await client.get(`/api/admin/batches/${id}`)).body.status, 'planned');
});

test('a planned batch something else refers to is not removed', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const id = await plannedBatch();
  await db.insert('alert', { type: 'batch_anomaly', title: 'Odd batch', batch_id: id });

  const res = await remove(id);
  assert.equal(res.status, 409);
  assert.equal((await client.get(`/api/admin/batches/${id}`)).status, 200);
});

test('removing needs batches:write, and a missing batch is a 404', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const id = await plannedBatch();
  assert.equal((await remove(9999)).status, 404);

  client.clearCookies();
  await client.login(REGULATOR.email, REGULATOR.password);
  assert.equal((await remove(id)).status, 403);
  assert.ok(await db.get('batch', id), 'still there');
});
