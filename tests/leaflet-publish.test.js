/**
 * Publishing a leaflet.
 *
 * The endpoint has existed since the leaflet QR landed but nothing called it,
 * so it went untested: a leaflet could only be created by the seed. These
 * cover the contract the Products screen now depends on, and the consequence
 * that matters most - what a patient reaches after a leaflet is published,
 * since a leaflet QR points at a fixed address and starts opening the newest
 * version the moment one exists.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';

let client;

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const REGULATOR = { email: 'regulator@test.local', password: 'RegulatorPass!2026' };

const SECTIONS = [
  { heading: 'What this medicine is for', body: 'A short explanation for a patient.' },
  { heading: 'How to take it', body: 'One tablet twice a day, after food.' },
];

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  await seedBasics({ quantity: 4 });
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  await seedUser({ ...REGULATOR, role: 'regulator', name: 'Rita Regulator' });
  client.clearCookies();
  await resetRateLimits();
});

/** A second product, deliberately without a leaflet. */
async function productWithoutLeaflet() {
  const { lastInsertRowid } = await db.run(
    `INSERT INTO products (sku, name, strength, dosage_form, manufacturer)
     VALUES ('TES12', 'Testamol', '500 mg', 'Tablet', 'Northbridge')`
  );
  return lastInsertRowid;
}

test('a published leaflet is what the public page then serves', async () => {
  const id = await productWithoutLeaflet();
  await client.login(ADMIN.email, ADMIN.password);

  const before = await client.get('/api/product/TES12/leaflet');
  assert.equal(before.status, 404, 'nothing to read before publishing');

  const res = await client.post(`/api/admin/products/${id}/leaflets`, {
    version: '1.0',
    language: 'en',
    sections: SECTIONS,
  });
  assert.equal(res.status, 201);

  const after = await client.get('/api/product/TES12/leaflet');
  assert.equal(after.status, 200);
  assert.equal(after.body.leaflet.version, '1.0');
  assert.deepEqual(after.body.leaflet.sections, SECTIONS);
});

test('the leaflet QR screen stops reporting the medicine as missing', async () => {
  const id = await productWithoutLeaflet();
  await client.login(ADMIN.email, ADMIN.password);

  const before = await client.get('/api/admin/leaflet-codes');
  assert.equal(before.body.missing, 1, 'the new product has no leaflet yet');

  await client.post(`/api/admin/products/${id}/leaflets`, {
    version: '1.0',
    sections: SECTIONS,
  });

  const after = await client.get('/api/admin/leaflet-codes');
  assert.equal(after.body.missing, 0, 'and now none are missing');
});

test('a newer version becomes what the QR opens, and the old one is kept', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  await client.post('/api/admin/products/1/leaflets', {
    version: '2.0',
    sections: [{ heading: 'Revised', body: 'Replaces the seeded 1.0.' }],
  });

  const page = await client.get('/api/product/AMX25/leaflet');
  assert.equal(page.body.leaflet.version, '2.0', 'the newest is served');

  const kept = await db.all('SELECT version FROM leaflets WHERE product_id = 1 ORDER BY id');
  assert.deepEqual(kept.map((l) => l.version), ['1.0', '2.0'], 'the earlier version survives');
});

test('a section missing its body is refused', async () => {
  const id = await productWithoutLeaflet();
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.post(`/api/admin/products/${id}/leaflets`, {
    version: '1.0',
    sections: [{ heading: 'A heading with nothing under it' }],
  });

  assert.equal(res.status, 400);
  assert.equal(await db.scalar('SELECT COUNT(*) FROM leaflets WHERE product_id = ?', [id]), 0);
});

test('sections are required, so an empty leaflet cannot be published', async () => {
  const id = await productWithoutLeaflet();
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.post(`/api/admin/products/${id}/leaflets`, { version: '1.0' });

  // 422, not 400: a missing required field is caught by validate() before the
  // handler runs, whereas a section with a heading and no body reaches the
  // handler and is rejected there. The two are worth keeping distinct.
  assert.equal(res.status, 422);
  assert.equal(await db.scalar('SELECT COUNT(*) FROM leaflets WHERE product_id = ?', [id]), 0);
});

test('a regulator cannot publish a leaflet', async () => {
  const id = await productWithoutLeaflet();
  await client.login(REGULATOR.email, REGULATOR.password);

  const res = await client.post(`/api/admin/products/${id}/leaflets`, {
    version: '1.0',
    sections: SECTIONS,
  });

  assert.equal(res.status, 403, 'products:write is not in the regulator role');
  assert.equal(await db.scalar('SELECT COUNT(*) FROM leaflets WHERE product_id = ?', [id]), 0);
});

test('publishing is recorded in the audit log', async () => {
  const id = await productWithoutLeaflet();
  await client.login(ADMIN.email, ADMIN.password);

  await client.post(`/api/admin/products/${id}/leaflets`, {
    version: '1.0',
    sections: SECTIONS,
  });

  const entry = await db.get(
    `SELECT * FROM audit_log WHERE action = 'leaflet.publish' ORDER BY id DESC LIMIT 1`
  );
  assert.ok(entry, 'an audit entry exists');
  assert.equal(entry.actor_email, ADMIN.email);
});
