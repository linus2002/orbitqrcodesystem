/**
 * Using another product's leaflet.
 *
 * A new strength of a medicine is usually covered by the leaflet its sister
 * strength already has. Before this, the only way to give it that leaflet was
 * to publish a new version to both - a revision on the first product's
 * record that changed nothing. These pin the alternative: the new product
 * gets the source's CURRENT version as it stands (same text, same PDF), the
 * source is untouched, and the two end up on one shared version exactly as a
 * joint publish would have left them.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';

let client;

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const REGULATOR = { email: 'regulator@test.local', password: 'RegulatorPass!2026' };
const REASON = 'ELT50 is covered by the same leaflet as ELT25.';

const SECTIONS = [
  { heading: 'What Eltrombopag is for', body: 'Low platelet counts.' },
  { heading: 'How to take it', body: 'Once a day, on an empty stomach.' },
];
const pdfBytes = Buffer.from('%PDF-1.4\n% eltrombopag\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

let elt25;
let elt50;

beforeEach(async () => {
  await freshDb();
  await seedBasics({ quantity: 4 }); // product 1 (AMX25) with leaflet v1.0
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  await seedUser({ ...REGULATOR, role: 'regulator', name: 'Rita Regulator' });
  client.clearCookies();
  await resetRateLimits();
  elt25 = (await db.insert('product', { sku: 'ELT25', name: 'Eltrombopag', strength: '25 mg', manufacturer: 'Northbridge' })).id;
  elt50 = (await db.insert('product', { sku: 'ELT50', name: 'Eltrombopag', strength: '50 mg', manufacturer: 'Northbridge' })).id;
});

async function uploadPdf() {
  const begin = await client.post('/api/admin/leaflet-files', { name: 'eltrombopag.pdf', size: pdfBytes.length });
  await client.raw(`/api/admin/leaflet-files/${begin.body.fileId}/chunks/0`, { body: pdfBytes, contentType: 'application/pdf' });
  return begin.body.fileId;
}

/** ELT25's leaflet, published the ordinary way. */
async function publishElt25(body = {}) {
  const res = await client.post(`/api/admin/products/${elt25}/leaflets`, {
    version: '1.0', sections: SECTIONS, reason: 'First edition for ELT25.', ...body,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
}

const adopt = (id, body) =>
  client.post(`/api/admin/products/${id}/leaflets/adopt`, {
    fromProductId: elt25, version: '1.0', reason: REASON, ...body,
  });

test('a product takes on another product\'s current leaflet without a new version', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  await publishElt25();

  const res = await adopt(elt50);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.version, '1.0');
  assert.equal(res.body.copiedFrom.sku, 'ELT25');

  // The source is untouched: still one version, the one it had.
  assert.equal(await db.count('leaflet', { product_id: elt25 }), 1);

  // A patient scanning ELT50's leaflet QR reads ELT25's leaflet.
  const page = await client.get('/api/product/ELT50/leaflet');
  assert.equal(page.status, 200);
  assert.equal(page.body.leaflet.version, '1.0');
  assert.deepEqual(page.body.leaflet.sections, SECTIONS);
});

test('the PDF is shared, not copied, and serves the same document', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const fileId = await uploadPdf();
  await publishElt25({ pdf: { fileId } });

  const res = await adopt(elt50);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.file_id, fileId);
  assert.equal(res.body.pdf.filename, 'eltrombopag.pdf');
  assert.equal(await db.count('leafletFile'), 1, 'no second file');

  const served = await fetch(`${client.base}/api/product/ELT50/leaflet.pdf`);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), pdfBytes);
});

test('the two share one version afterwards, and a joint publish then works', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  await publishElt25();
  await adopt(elt50);

  // What the Leaflet QR screen and the publish form list for each product.
  const list = await client.get('/api/admin/leaflet-codes');
  const version = (sku) => list.body.items.find((p) => p.sku === sku).leaflet_version;
  assert.equal(version('ELT50'), version('ELT25'));

  const next = await client.post(`/api/admin/products/${elt25}/leaflets`, {
    version: '2.0', sections: SECTIONS, reason: 'Revised for both strengths.', alsoApplyTo: [elt50],
  });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.equal((await client.get('/api/product/ELT50/leaflet')).body.leaflet.version, '2.0');
});

test('a product with a leaflet of its own switches to the other, keeping its own in history', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  await publishElt25();
  // ELT50 was given a leaflet of its own before anyone noticed.
  await db.insert('leaflet', {
    product_id: elt50, version: '0.9', sections: [{ heading: 'Old', body: 'Its own text.' }],
    effective_from: '2026-01-01T00:00:00.000Z',
  });

  assert.equal((await adopt(elt50)).status, 201);
  const page = await client.get('/api/product/ELT50/leaflet');
  assert.equal(page.body.leaflet.version, '1.0');
  const old = page.body.history.find((h) => h.version === '0.9');
  assert.ok(old, 'its own version is kept');
  assert.equal(old.current, false);
});

test('if the source changed since it was checked, nothing is copied', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  await publishElt25();
  await client.post(`/api/admin/products/${elt25}/leaflets`, {
    version: '1.1', sections: SECTIONS, reason: 'A correction made meanwhile.',
  });

  const res = await adopt(elt50, { version: '1.0' }); // what the person was shown
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /now v1\.1/);
  assert.equal(await db.count('leaflet', { product_id: elt50 }), 0);
});

test('a version number the product already used is refused, with what to do instead', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  await publishElt25();
  await db.insert('leaflet', {
    product_id: elt50, version: '1.0', sections: [{ heading: 'Own', body: 'Different text.' }],
    effective_from: '2026-01-01T00:00:00.000Z',
  });
  // ...and superseded since, so its 1.0 is history, not what it shows.
  await db.insert('leaflet', {
    product_id: elt50, version: '1.5', sections: [{ heading: 'Own', body: 'Newer text.' }],
    effective_from: '2026-02-01T00:00:00.000Z',
  });

  const res = await adopt(elt50);
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /Also applies to/);
});

test('adopting what a product already shows changes nothing', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  await publishElt25();
  await adopt(elt50);

  const again = await adopt(elt50);
  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /nothing to change/);
  assert.equal(await db.count('leaflet', { product_id: elt50 }), 1);
});

test('the audit log records it as a publish, naming where it came from', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  await publishElt25();
  const res = await adopt(elt50);

  const entry = await db.findOne('auditLog', { action: 'leaflet.publish', entity_id: String(res.body.id) });
  const detail = JSON.parse(entry.detail_json);
  assert.equal(detail.sku, 'ELT50');
  assert.equal(detail.reason, REASON);
  assert.equal(detail.copiedFrom.sku, 'ELT25');
});

test('refused: itself, a source with no leaflet, no reason, and a role without products:write', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  assert.equal((await adopt(elt50)).status, 409, 'ELT25 has nothing to use yet');

  await publishElt25();
  assert.equal((await adopt(elt25)).status, 400, 'not from itself');
  assert.equal((await adopt(elt50, { reason: undefined })).status, 422);

  client.clearCookies();
  await client.login(REGULATOR.email, REGULATOR.password);
  assert.equal((await adopt(elt50)).status, 403);
  assert.equal(await db.count('leaflet', { product_id: elt50 }), 0);
});
