/**
 * Pack-code QR downloads, the batch QR ZIP, and the in-app viewer's
 * spreadsheet preview.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';
import { qrPayload } from '../src/lib/codes.js';
import { config } from '../src/config.js';

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const REGULATOR = { email: 'reg@test.local', password: 'RegulatorPass!2026' };
let client;

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});
beforeEach(async () => {
  await freshDb();
  await seedBasics({ quantity: 12 });
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  await seedUser({ ...REGULATOR, role: 'regulator' });
  client.clearCookies();
  await resetRateLimits();
  await client.login(ADMIN.email, ADMIN.password);
});

const decodePng = (bytes) => {
  const png = PNG.sync.read(bytes);
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
};

test('one pack code downloads as a print-ready PNG that scans to its signed URL', async () => {
  const code = await db.findOne('code', {}, { order: 'unit_index asc' });
  const res = await client.bytes(`/api/admin/codes/${code.id}/qr.png?download=1&width=600`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="${code.code}.png"`);
  assert.equal(PNG.sync.read(res.bytes).width, 600);
  assert.equal(decodePng(res.bytes), qrPayload(code.code, config.secrets.code, config.publicBaseUrl));
});

test('one pack code downloads as SVG, and the download is in the audit log', async () => {
  const code = await db.findOne('code');
  const res = await client.bytes(`/api/admin/codes/${code.id}/qr.svg?download=1`);
  assert.equal(res.status, 200);
  assert.match(res.bytes.toString('utf8'), /^<svg/);
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="${code.code}.svg"`);
  const entry = await db.findOne('auditLog', { action: 'codes.qr_download' });
  assert.ok(entry, 'download recorded');
});

test('the on-screen QR is unchanged: inline, no attachment', async () => {
  const code = await db.findOne('code');
  const res = await client.bytes(`/api/admin/codes/${code.id}/qr.svg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), null);
});

test("a batch's QRs come as one ZIP: a file per code in packing order, plus codes.csv", async () => {
  const res = await client.bytes('/api/admin/batches/1/qr.zip?format=png&width=300');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /filename="AMX25-T1-qr-png\.zip"/);

  const zip = await JSZip.loadAsync(res.bytes);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  assert.equal(names.length, 13, '12 images + codes.csv');
  assert.ok(names.includes('AMX25-T1-qr-png/codes.csv'));

  const codes = await db.findMany('code', { batch_id: 1 }, { order: 'unit_index asc' });
  assert.equal(names[0], `AMX25-T1-qr-png/01-${codes[0].code}.png`);
  const first = await zip.file(names[0]).async('nodebuffer');
  assert.equal(decodePng(first), qrPayload(codes[0].code, config.secrets.code, config.publicBaseUrl));

  const csv = (await zip.file('AMX25-T1-qr-png/codes.csv').async('string')).trim().split('\n');
  assert.equal(csv[0], 'unit,code,file,url');
  assert.equal(csv.length, 13);
  assert.ok(csv[1].startsWith(`1,${codes[0].code},01-${codes[0].code}.png,`));
});

test('the SVG ZIP holds SVG files', async () => {
  const res = await client.bytes('/api/admin/batches/1/qr.zip');
  const zip = await JSZip.loadAsync(res.bytes);
  const svg = Object.keys(zip.files).find((n) => n.endsWith('.svg'));
  assert.match(await zip.file(svg).async('string'), /^<svg/);
});

test('a regulator cannot download codes', async () => {
  client.clearCookies();
  await client.login(REGULATOR.email, REGULATOR.password);
  assert.equal((await client.bytes('/api/admin/batches/1/qr.zip')).status, 403);
  const code = await db.findOne('code');
  assert.equal((await client.bytes(`/api/admin/codes/${code.id}/qr.png?download=1`)).status, 403);
});

test('a stored export can be viewed as a table, with its headings as written', async () => {
  await client.bytes('/api/admin/export/batches.xlsx');
  const [file] = (await client.get('/api/admin/files?kind=export')).body.items;

  const res = await client.get(`/api/admin/files/${file.id}/preview`);
  assert.equal(res.status, 200);
  assert.ok(res.body.columns.includes('Batch number'));
  assert.equal(res.body.total, 1);
  assert.equal(res.body.rows.length, 1);
  assert.ok(res.body.rows[0].includes('AMX25-T1'));
  assert.equal(res.body.truncated, false);
  assert.equal(res.body.file.id, file.id);
});

test('pages other than the leaflet PDF still refuse to be framed (see leaflet-pdf.test.js)', async () => {
  const res = await client.bytes('/api/health');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
