/**
 * The leaflet recorded on a batch when it is created.
 *
 * Creating a batch in the dashboard always stored null, because
 * `await db.get(...)?.id` applied `?.id` to the Promise rather than the row.
 * A batch now records the product's current leaflet as the one it shipped
 * with. Display is unaffected - a scan shows the medicine's current leaflet
 * regardless - so this is the audit record, and the tests check the record.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';

let client;
const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  await seedBasics({ quantity: 4 }); // product 1 (AMX25), leaflet id 1 = v1.0
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  client.clearCookies();
  await resetRateLimits();
  await client.login(ADMIN.email, ADMIN.password);
});

const newBatch = (batchNumber, extra = {}) =>
  client.post('/api/admin/batches', {
    batchNumber,
    productId: 1,
    mfgDate: '2026-09-01',
    expiryDate: '2028-09-01',
    quantity: 10,
    ...extra,
  });

const leafletOf = async (batchNumber) =>
  (await db.findOne('batch', { batch_number: batchNumber })).leaflet_id;

test('a batch created in the dashboard records the current leaflet, not null', async () => {
  const res = await newBatch('AMX25-D1');

  assert.equal(res.status, 201);
  assert.equal(await leafletOf('AMX25-D1'), 1);
});

test('after a newer leaflet is published, new batches record the newer one', async () => {
  const { id: v2 } = await db.insert('leaflet', {
    product_id: 1, version: '2.0', language: 'en',
    sections: [{ heading: 'H', body: 'B' }], effective_from: '2026-10-01T00:00:00.000Z',
  });

  await newBatch('AMX25-D2');

  assert.equal(await leafletOf('AMX25-D2'), v2);
  assert.equal(await leafletOf('AMX25-T1'), 1, 'an existing batch keeps what it shipped with');
});

test('an explicit leafletId is still honoured', async () => {
  await newBatch('AMX25-D3', { leafletId: 1 });

  assert.equal(await leafletOf('AMX25-D3'), 1);
});

test('a product with no leaflet gives a batch with none, not an error', async () => {
  const product = await db.insert('product', { sku: 'NOLF1', name: 'No Leaflet', manufacturer: 'Northbridge' });

  const res = await newBatch('NOLF1-D1', { productId: product.id });

  assert.equal(res.status, 201);
  assert.equal(await leafletOf('NOLF1-D1'), null);
});
