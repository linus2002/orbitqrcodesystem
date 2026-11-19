/**
 * Stored files: what each kind accepts, and that every one the app is meant
 * to keep is kept.
 *
 *   exports   a copy of every workbook downloaded, with who took it
 *   imports   the original of every import that changed something
 *   QR        rendered once, served from the store afterwards
 *   pictures  product images: checked by their bytes, replaced cleanly
 *
 * Avatars are covered in profile.test.js, leaflet PDFs in leaflet-pdf.test.js.
 * Runs on the memory store by default and on Postgres with
 * TEST_BACKEND=postgres - the same assertions against both.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';
import { sniff, safeName } from '../src/services/files.js';

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const REGULATOR = { email: 'reg@test.local', password: 'RegulatorPass!2026' };

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

let client;

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  await seedBasics({ quantity: 3 });
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  await seedUser({ ...REGULATOR, role: 'regulator', name: 'Rita Regulator' });
  client.clearCookies();
  await resetRateLimits();
  await client.login(ADMIN.email, ADMIN.password);
});

async function workbook(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('products');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Telling files apart by their bytes
// ---------------------------------------------------------------------------

test('a file is known by its first bytes, not its name', () => {
  assert.equal(sniff(Buffer.from('%PDF-1.7\n...')), 'pdf');
  assert.equal(sniff(Buffer.from('PK\x03\x04rest-of-zip', 'latin1')), 'xlsx');
  assert.equal(sniff(PNG), 'png');
  assert.equal(sniff(JPEG), 'jpeg');
  assert.equal(sniff(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(sniff(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>')), 'svg');
  assert.equal(sniff(Buffer.from('sku,name\nAMX25,Amoxicillin\n')), 'csv');
  assert.equal(sniff(Buffer.from([0x00, 0x01, 0x02])), null, 'binary that is none of these');
  assert.equal(sniff(Buffer.alloc(0)), null);
});

test('a stored filename cannot carry a path or break a header', () => {
  assert.equal(safeName('..\\..\\windows\\evil.xlsx'), 'evil.xlsx');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('a"; filename=x.exe'), 'a_ filename_x.exe');
  assert.equal(safeName(''), 'file');
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('every export is kept, with who took it, and can be downloaded again', async () => {
  const res = await client.bytes('/api/admin/export/batches.xlsx');
  assert.equal(res.status, 200);

  const list = await client.get('/api/admin/files?kind=export');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  const [file] = list.body.items;
  assert.equal(file.kind, 'export');
  assert.match(file.filename, /^batches-\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.equal(file.createdByName, 'Ada Admin');
  assert.equal(file.meta.entity, 'batches');
  assert.equal(file.meta.rows, 1);

  const again = await client.bytes(file.downloadUrl);
  assert.equal(again.status, 200);
  assert.deepEqual(again.bytes, res.bytes, 'the stored copy is exactly what was downloaded');
  assert.match(again.headers.get('content-disposition'), /attachment; filename="batches-/);
});

test('a regulator cannot list or download the stored spreadsheets', async () => {
  await client.bytes('/api/admin/export/batches.xlsx');
  const [file] = (await client.get('/api/admin/files?kind=export')).body.items;

  client.clearCookies();
  await client.login(REGULATOR.email, REGULATOR.password);
  assert.equal((await client.get('/api/admin/files?kind=export')).status, 403);
  assert.equal((await client.bytes(file.downloadUrl)).status, 403);
});

test('only imports and exports are listed - not avatars, pictures or QR images', async () => {
  assert.equal((await client.get('/api/admin/files?kind=avatar')).status, 400);
  await db.uploadFile(PNG, { id: 'avatar-x', kind: 'avatar', filename: 'a.png', contentType: 'image/png' });
  assert.equal((await client.bytes('/api/admin/files/avatar-x/download')).status, 404);
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

test('the original of an import is kept under its own name; a dry run keeps nothing', async () => {
  const body = await workbook(['SKU', 'Name', 'Manufacturer'], [['NEW1', 'New product', 'Northbridge']]);
  const headers = { 'X-File-Name': encodeURIComponent('Q4 products (final).xlsx') };
  const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  const dry = await client.raw('/api/admin/import/products?dryRun=1', { method: 'POST', body, contentType: xlsx, headers });
  assert.equal(dry.status, 200);
  assert.equal((await client.get('/api/admin/files?kind=import')).body.total, 0);

  const run = await client.raw('/api/admin/import/products', { method: 'POST', body, contentType: xlsx, headers });
  assert.equal(run.status, 200);
  assert.equal(run.body.created, 1);
  assert.ok(run.body.fileId);

  const [file] = (await client.get('/api/admin/files?kind=import')).body.items;
  assert.equal(file.id, run.body.fileId);
  assert.equal(file.filename, 'Q4 products (final).xlsx');
  assert.equal(file.contentType, xlsx);
  assert.deepEqual(file.meta, { entity: 'products', created: 1, updated: 0, errors: 0 });
  assert.deepEqual((await client.bytes(file.downloadUrl)).bytes, body);
});

// ---------------------------------------------------------------------------
// QR images
// ---------------------------------------------------------------------------

test('a QR is rendered once and then served from the store', async () => {
  const code = await db.findOne('code');
  const first = await client.get(`/api/admin/codes/${code.id}/qr.svg`);
  assert.equal(first.status, 200);
  assert.match(first.body, /<svg/);

  const qrs = await db.listFiles({ kind: 'qr' });
  assert.equal(qrs.total, 1);
  assert.equal(qrs.items[0].contentType, 'image/svg+xml');
  assert.equal(qrs.items[0].meta.purpose, 'code');

  const second = await client.get(`/api/admin/codes/${code.id}/qr.svg`);
  assert.equal(second.body, first.body);
  assert.equal((await db.listFiles({ kind: 'qr' })).total, 1, 'not stored twice');
});

// ---------------------------------------------------------------------------
// Product pictures
// ---------------------------------------------------------------------------

test('a product picture is stored, served publicly, replaced and removed', async () => {
  const set = await client.raw('/api/admin/products/1/image', { body: PNG, contentType: 'image/png' });
  assert.equal(set.status, 200);
  const firstId = set.body.image_file_id;
  assert.match(set.body.image_url, /^\/api\/product\/AMX25\/image\?v=product-1-/);

  // Anyone may see it: no session.
  client.clearCookies();
  const served = await client.bytes(set.body.image_url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(served.bytes, PNG);
  assert.match(served.headers.get('cache-control'), /immutable/);
  await client.login(ADMIN.email, ADMIN.password);

  const replaced = await client.raw('/api/admin/products/1/image', { body: JPEG, contentType: 'image/jpeg' });
  assert.equal(replaced.status, 200);
  assert.notEqual(replaced.body.image_file_id, firstId);
  assert.equal(await db.fileInfo(firstId), undefined, 'the replaced picture is deleted');

  const listed = (await client.get('/api/admin/products')).body.items.find((p) => p.sku === 'AMX25');
  assert.equal(listed.image_url, replaced.body.image_url);

  const removed = await client.request('/api/admin/products/1/image', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.image_url, null);
  assert.equal((await client.bytes('/api/product/AMX25/image')).status, 404);
});

test('a picture whose bytes are not an image is refused, whatever it is labelled', async () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const res = await client.raw('/api/admin/products/1/image', { body: html, contentType: 'image/png' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /JPEG, PNG or WebP/);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const res2 = await client.raw('/api/admin/products/1/image', { body: svg, contentType: 'image/png' });
  assert.equal(res2.status, 400);
  assert.equal((await db.get('product', 1)).image_file_id, null);
});

test('a regulator cannot change a product picture', async () => {
  client.clearCookies();
  await client.login(REGULATOR.email, REGULATOR.password);
  const res = await client.raw('/api/admin/products/1/image', { body: PNG, contentType: 'image/png' });
  assert.equal(res.status, 403);
});
