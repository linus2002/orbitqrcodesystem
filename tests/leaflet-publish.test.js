/**
 * Publishing a leaflet.
 *
 * The endpoint had existed since the leaflet QR landed but nothing called it,
 * so it went untested: a leaflet could only be created by the seed. These
 * cover the contract the Products screen depends on, and two consequences
 * that matter most:
 *
 *   - what a patient reaches after a leaflet is published, since a leaflet QR
 *     points at a fixed address and starts opening the newest version the
 *     moment one exists; and
 *   - that a publish covering several strengths of one medicine is all or
 *     nothing, so two strengths can never end up saying different things.
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

const REASON = 'Corrected the dosing table after the 2026 review.';

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  await seedBasics({ quantity: 4 }); // product 1 (AMX25) with leaflet v1.0
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  await seedUser({ ...REGULATOR, role: 'regulator', name: 'Rita Regulator' });
  client.clearCookies();
  await resetRateLimits();
});

/** Another product, deliberately without a leaflet. */
async function product(sku, name = 'Testamol', strength = '500 mg') {
  const row = await db.insert('product', {
    sku, name, strength, dosage_form: 'Tablet', manufacturer: 'Northbridge',
  });
  return row.id;
}

const publish = (id, body) =>
  client.post(`/api/admin/products/${id}/leaflets`, { version: '1.0', sections: SECTIONS, reason: REASON, ...body });

const countFor = (id) => db.count('leaflet', { product_id: id });

// ---------------------------------------------------------------------------
// One product
// ---------------------------------------------------------------------------

test('a published leaflet is what the public page then serves', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);

  const before = await client.get('/api/product/TES12/leaflet');
  assert.equal(before.status, 404, 'nothing to read before publishing');

  const res = await publish(id, { language: 'en' });
  assert.equal(res.status, 201);

  const after = await client.get('/api/product/TES12/leaflet');
  assert.equal(after.status, 200);
  assert.equal(after.body.leaflet.version, '1.0');
  assert.deepEqual(after.body.leaflet.sections, SECTIONS);
});

test('the leaflet QR screen stops reporting the medicine as missing', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);

  const before = await client.get('/api/admin/leaflet-codes');
  assert.equal(before.body.missing, 1, 'the new product has no leaflet yet');

  await publish(id);

  const after = await client.get('/api/admin/leaflet-codes');
  assert.equal(after.body.missing, 0, 'and now none are missing');
});

test('a newer version becomes what the QR opens, and the old one is kept', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  await publish(1, { version: '2.0', sections: [{ heading: 'Revised', body: 'Replaces the seeded 1.0.' }] });

  const page = await client.get('/api/product/AMX25/leaflet');
  assert.equal(page.body.leaflet.version, '2.0', 'the newest is served');

  const kept = await db.findMany('leaflet', { product_id: 1 }, { order: 'id asc' });
  assert.deepEqual(kept.map((l) => l.version), ['1.0', '2.0'], 'the earlier version survives');
});

test('a section missing its body is refused', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);

  const res = await publish(id, { sections: [{ heading: 'A heading with nothing under it' }] });

  assert.equal(res.status, 400);
  assert.equal(await countFor(id), 0);
});

test('a leaflet with neither sections nor a PDF cannot be published', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.post(`/api/admin/products/${id}/leaflets`, { version: '1.0', reason: REASON });

  // Sections stopped being required when a PDF became an alternative, so
  // this is the handler's own check, not validate()'s: hence 400, not 422.
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /PDF or at least one section/);
  assert.equal(await countFor(id), 0);
});

test('a regulator cannot publish a leaflet', async () => {
  const id = await product('TES12');
  await client.login(REGULATOR.email, REGULATOR.password);

  const res = await publish(id);

  assert.equal(res.status, 403, 'products:write is not in the regulator role');
  assert.equal(await countFor(id), 0);
});

// ---------------------------------------------------------------------------
// The reason
// ---------------------------------------------------------------------------

test('a reason is required, and nothing is written without one', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);

  const missing = await client.post(`/api/admin/products/${id}/leaflets`, { version: '1.0', sections: SECTIONS });
  assert.equal(missing.status, 422);

  const tooShort = await publish(id, { reason: 'fix' });
  assert.equal(tooShort.status, 422, 'five characters is the floor, as for a code void');

  assert.equal(await countFor(id), 0);
});

test('publishing is recorded in the audit log with who and why', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);

  await publish(id);

  const entry = await db.findOne('auditLog', { action: 'leaflet.publish' }, { order: 'id desc' });
  assert.ok(entry, 'an audit entry exists');
  assert.equal(entry.actor_email, ADMIN.email, 'who');
  const detail = JSON.parse(entry.detail_json);
  assert.equal(detail.reason, REASON, 'why');
  assert.equal(detail.sku, 'TES12');
  assert.equal(detail.version, '1.0');
  assert.deepEqual(detail.covers, ['TES12'], 'the set it covered, even when that is one');
});

// ---------------------------------------------------------------------------
// Several products at once
// ---------------------------------------------------------------------------

test('one publish covers several strengths with identical content', async () => {
  const b25 = await product('BEL25', 'Eltrombopag', '25 mg');
  const b50 = await product('BEL50', 'Eltrombopag', '50 mg');
  await client.login(ADMIN.email, ADMIN.password);

  const res = await publish(b25, { alsoApplyTo: [b50] });

  assert.equal(res.status, 201);
  assert.deepEqual(
    res.body.coverage.map((c) => c.sku),
    ['BEL25', 'BEL50'],
    'the named product first, then the rest'
  );
  assert.equal(res.body.product_id, b25, 'the body is still the named product\'s row');

  const bel = await db.findMany('product', { sku: { in: ['BEL25', 'BEL50'] } }, { order: 'sku asc' });
  const rows = [];
  for (const p of bel) {
    for (const l of await db.findMany('leaflet', { product_id: p.id })) rows.push({ sku: p.sku, ...l });
  }
  assert.equal(rows.length, 2, 'one row per product');
  assert.deepEqual(rows[0].sections, rows[1].sections, 'identical content');
  assert.deepEqual(rows.map((r) => r.version), ['1.0', '1.0'], 'identical version - that IS the grouping');

  for (const sku of ['BEL25', 'BEL50']) {
    const page = await client.get(`/api/product/${sku}/leaflet`);
    assert.equal(page.status, 200, `${sku} serves it`);
    assert.equal(page.body.leaflet.version, '1.0');
  }
});

test('a publish that would leave one strength behind writes nothing at all', async () => {
  const b25 = await product('BEL25', 'Eltrombopag', '25 mg');
  const b50 = await product('BEL50', 'Eltrombopag', '50 mg');
  await client.login(ADMIN.email, ADMIN.password);

  // BEL50 already has v1.0; publishing v1.0 to both must refuse - and must
  // not quietly succeed for BEL25 alone, which would split the pair.
  await publish(b50);

  const res = await publish(b25, { alsoApplyTo: [b50] });

  assert.equal(res.status, 409);
  assert.match(res.body.error?.message ?? '', /BEL50/, 'names the strength that already had it');
  assert.equal(await countFor(b25), 0, 'nothing written for the other');
  assert.equal(await countFor(b50), 1, 'and the existing one untouched');
});

test('an unknown product in the set is refused before anything is written', async () => {
  const b25 = await product('BEL25', 'Eltrombopag', '25 mg');
  await client.login(ADMIN.email, ADMIN.password);

  const res = await publish(b25, { alsoApplyTo: [b25 + 500] });

  assert.equal(res.status, 400);
  assert.equal(await countFor(b25), 0);
});

test('naming the product itself in the set does not publish it twice', async () => {
  const b25 = await product('BEL25', 'Eltrombopag', '25 mg');
  await client.login(ADMIN.email, ADMIN.password);

  const res = await publish(b25, { alsoApplyTo: [b25, b25] });

  assert.equal(res.status, 201);
  assert.equal(res.body.coverage.length, 1);
  assert.equal(await countFor(b25), 1);
});

test('every covered product gets its own audit entry naming the whole set', async () => {
  const b25 = await product('BEL25', 'Eltrombopag', '25 mg');
  const b50 = await product('BEL50', 'Eltrombopag', '50 mg');
  await client.login(ADMIN.email, ADMIN.password);

  await publish(b25, { alsoApplyTo: [b50] });

  const entries = await db.findMany('auditLog', { action: 'leaflet.publish' }, { order: 'id asc' });
  assert.equal(entries.length, 2, 'one per product, so each SKU\'s own trail is complete');
  const details = entries.map((e) => JSON.parse(e.detail_json));
  assert.deepEqual(details.map((d) => d.sku), ['BEL25', 'BEL50']);
  for (const d of details) {
    assert.deepEqual(d.covers, ['BEL25', 'BEL50'], 'the grouping is on record');
    assert.equal(d.reason, REASON);
  }
});
