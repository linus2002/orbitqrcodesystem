/**
 * A leaflet published as a PDF.
 *
 * The artwork department has the leaflet as a PDF, and the carton's leaflet
 * QR should open it. A file may be 25 MB while a request may not (a Vercel
 * function takes 4.5 MB), so the browser announces the file, sends it in
 * pieces - each stored as a file asset - and the publish points at the
 * finished upload. These cover that upload contract, the public address that
 * streams the file back, that the address tracks the current version while
 * older ones stay reachable, that a genuine pack scan offers it, and what is
 * refused - before anything is written.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';
import { PDF_CHUNK_BYTES, PDF_MAX_BYTES } from '../src/services/leaflets.js';

let client;
let codes;

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const REASON = 'First edition as the printed artwork PDF.';

/** The smallest thing a PDF reader accepts; the bytes are what matter here. */
const pdfBytes = (marker = 'A') =>
  Buffer.from(`%PDF-1.4\n% leaflet ${marker}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  codes = (await seedBasics({ quantity: 4 })).codes; // product 1 (AMX25) with a text leaflet v1.0
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  client.clearCookies();
  await resetRateLimits();
});

/** Another product, without a leaflet. */
async function product(sku, name = 'Testamol', strength = '500 mg') {
  const row = await db.insert('product', { sku, name, strength, dosage_form: 'Tablet', manufacturer: 'Northbridge' });
  return row.id;
}

/** Announce a file and send it in pieces, as the Products screen does. Returns the file id. */
async function uploadPdf(bytes, { name = 'Testamol-leaflet.pdf', chunk } = {}) {
  const begin = await client.post('/api/admin/leaflet-files', { name, size: bytes.length });
  assert.equal(begin.status, 201, JSON.stringify(begin.body));
  const size = chunk ?? begin.body.chunkBytes;
  let seq = 0;
  for (let offset = 0; offset < bytes.length; offset += size, seq++) {
    const res = await client.raw(`/api/admin/leaflet-files/${begin.body.fileId}/chunks/${seq}`, {
      body: bytes.subarray(offset, offset + size),
      contentType: 'application/pdf',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  return begin.body.fileId;
}

const publish = (id, body) =>
  client.post(`/api/admin/products/${id}/leaflets`, { version: '1.0', reason: REASON, ...body });

/** Fetch a binary route directly: the test client reads bodies as text. */
async function fetchPdf(path) {
  const res = await fetch(`${client.base}${path}`);
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    length: res.headers.get('content-length'),
    disposition: res.headers.get('content-disposition'),
    bytes: Buffer.from(await res.arrayBuffer()),
  };
}

const fileCount = () => db.count('leafletFile');
const leafletsFor = (id) => db.count('leaflet', { product_id: id });
const pieceCount = async () => (await db.findMany('leafletFile')).reduce((n, f) => n + (f.chunks ?? 0), 0);

// ---------------------------------------------------------------------------
// Publishing and serving
// ---------------------------------------------------------------------------

test('a leaflet can be published as a PDF alone, and the public page then points at it', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);

  const fileId = await uploadPdf(pdfBytes());
  const res = await publish(id, { pdf: { fileId } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.pdf, { filename: 'Testamol-leaflet.pdf', size: pdfBytes().length });

  const file = await db.get('leafletFile', fileId);
  assert.equal(file.status, 'ready', 'the upload is sealed by the publish');
  assert.match(file.sha256, /^[0-9a-f]{64}$/);
  assert.equal(file.pieces.length, 1);
  assert.ok(file.pieces[0].asset_id, 'each piece is an asset');

  client.clearCookies();
  const page = await client.get('/api/product/TES12/leaflet');
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.leaflet.sections, [], 'PDF only: no text sections');
  assert.equal(page.body.leaflet.pdf.url, '/api/product/TES12/leaflet.pdf');
  assert.equal(page.body.leaflet.pdf.filename, 'Testamol-leaflet.pdf');
  assert.equal(page.body.history[0].hasPdf, true);

  const served = await fetchPdf('/api/product/TES12/leaflet.pdf');
  assert.equal(served.status, 200);
  assert.match(served.type, /^application\/pdf/);
  assert.equal(served.length, String(pdfBytes().length), 'the total length is announced up front');
  assert.match(served.disposition, /^inline; filename="Testamol-leaflet\.pdf"/);
  assert.ok(served.bytes.equals(pdfBytes()), 'the bytes come back exactly as uploaded');
});

test('a file sent in many pieces is reassembled exactly, in order', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);

  // A 100 KB file with a recognisable pattern, sent 7 KB at a time: 15 pieces.
  const body = Buffer.alloc(100 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7 + (i >> 8)) & 0xff;
  const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), body]);
  const fileId = await uploadPdf(bytes, { chunk: 7 * 1024 });
  assert.equal((await db.get('leafletFile', fileId)).chunks, 15);

  assert.equal((await publish(id, { pdf: { fileId } })).status, 201);
  client.clearCookies();

  const served = await fetchPdf('/api/product/TES12/leaflet.pdf');
  assert.equal(served.length, String(bytes.length));
  assert.ok(served.bytes.equals(bytes));
});

test('a PDF and text sections can be published together', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);

  const fileId = await uploadPdf(pdfBytes());
  const res = await publish(id, {
    pdf: { fileId },
    sections: [{ heading: 'How to take it', body: 'One tablet twice a day.' }],
  });
  assert.equal(res.status, 201);

  client.clearCookies();
  const page = await client.get('/api/product/TES12/leaflet');
  assert.equal(page.body.leaflet.sections.length, 1);
  assert.ok(page.body.leaflet.pdf);
});

test('the PDF address serves the current version; older versions stay reachable by name', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);
  await publish(id, { version: '1.0', pdf: { fileId: await uploadPdf(pdfBytes('ONE')) } });
  await publish(id, { version: '2.0', pdf: { fileId: await uploadPdf(pdfBytes('TWO')) } });
  client.clearCookies();

  const current = await fetchPdf('/api/product/TES12/leaflet.pdf');
  assert.ok(current.bytes.equals(pdfBytes('TWO')), 'the address with no version is the newest');

  const older = await fetchPdf('/api/product/TES12/leaflet.pdf?version=1.0');
  assert.ok(older.bytes.equals(pdfBytes('ONE')));

  const olderPage = await client.get('/api/product/TES12/leaflet?version=1.0');
  assert.equal(olderPage.body.leaflet.superseded, true);
  assert.equal(olderPage.body.leaflet.pdf.url, '/api/product/TES12/leaflet.pdf?version=1.0');

  assert.equal((await fetchPdf('/api/product/TES12/leaflet.pdf?version=9.9')).status, 404);
});

test('a leaflet published as text has no PDF address, and the PDF route says so', async () => {
  const page = await client.get('/api/product/AMX25/leaflet');
  assert.equal(page.body.leaflet.pdf, null);
  assert.equal(page.body.history[0].hasPdf, false);
  assert.equal((await fetchPdf('/api/product/AMX25/leaflet.pdf')).status, 404);
});

test('a genuine pack scan offers the PDF of the current leaflet', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const fileId = await uploadPdf(pdfBytes(), { name: 'Amoxicillin.pdf' });
  await publish(1, { version: '2.0', pdf: { fileId } });
  client.clearCookies();
  await giveDetails(client);

  const res = await client.post('/api/verify', { code: codes[0] });
  assert.equal(res.body.result, 'genuine');
  assert.equal(res.body.leaflet.version, '2.0');
  assert.equal(res.body.leaflet.pdf.url, '/api/product/AMX25/leaflet.pdf');
  assert.equal(res.body.leaflet.pdf.filename, 'Amoxicillin.pdf');
});

test('one publish across strengths stores the file once and serves it for each', async () => {
  const a = await product('TES12', 'Testamol', '250 mg');
  const b = await product('TES25', 'Testamol', '500 mg');
  await client.login(ADMIN.email, ADMIN.password);

  const fileId = await uploadPdf(pdfBytes());
  const res = await publish(a, { pdf: { fileId }, alsoApplyTo: [b] });
  assert.equal(res.status, 201);
  assert.equal(await fileCount(), 1, 'one document, one file');
  const shared = new Set((await db.findMany('leaflet', { file_id: { ne: null } })).map((l) => l.file_id));
  assert.equal(shared.size, 1);

  client.clearCookies();
  for (const sku of ['TES12', 'TES25']) {
    const served = await fetchPdf(`/api/product/${sku}/leaflet.pdf`);
    assert.equal(served.status, 200, `${sku} serves the shared PDF`);
    assert.ok(served.bytes.equals(pdfBytes()));
  }
});

test('the audit entry names the file', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);
  await publish(id, { pdf: { fileId: await uploadPdf(pdfBytes()) } });

  const entry = await db.findOne('auditLog', { action: 'leaflet.publish' }, { order: 'id desc' });
  const detail = JSON.parse(entry.detail_json);
  assert.equal(detail.pdf.filename, 'Testamol-leaflet.pdf');
  assert.match(detail.pdf.sha256, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// What is refused
// ---------------------------------------------------------------------------

test('neither sections nor a PDF is refused, and nothing is written', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);

  const res = await publish(id, {});
  assert.equal(res.status, 400);
  assert.equal(await leafletsFor(id), 0);
});

test('a file over 25 MB is refused before a single byte is sent', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const res = await client.post('/api/admin/leaflet-files', { name: 'huge.pdf', size: PDF_MAX_BYTES + 1 });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /limit is 25 MB/);
  assert.equal(await fileCount(), 0);
});

test('a piece larger than a request may carry is refused', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const begin = await client.post('/api/admin/leaflet-files', { name: 'x.pdf', size: PDF_CHUNK_BYTES * 2 });
  const tooBig = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(PDF_CHUNK_BYTES)]);
  const res = await client.raw(`/api/admin/leaflet-files/${begin.body.fileId}/chunks/0`, { body: tooBig, contentType: 'application/pdf' });
  assert.equal(res.status, 413);
  assert.equal(await pieceCount(), 0);
});

test('a file that is not a PDF is refused at its first piece', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const bytes = Buffer.from('hello, not a pdf');
  const begin = await client.post('/api/admin/leaflet-files', { name: 'leaflet.pdf', size: bytes.length });
  const res = await client.raw(`/api/admin/leaflet-files/${begin.body.fileId}/chunks/0`, { body: bytes, contentType: 'application/pdf' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /not a PDF/);
  assert.equal(await pieceCount(), 0);
});

test('pieces must arrive in order and add up to the announced size', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const bytes = pdfBytes();
  const begin = await client.post('/api/admin/leaflet-files', { name: 'leaflet.pdf', size: bytes.length });
  const path = (seq) => `/api/admin/leaflet-files/${begin.body.fileId}/chunks/${seq}`;

  const outOfOrder = await client.raw(path(1), { body: bytes, contentType: 'application/pdf' });
  assert.equal(outOfOrder.status, 400);
  assert.match(outOfOrder.body.error.message, /in order/);

  const first = await client.raw(path(0), { body: bytes.subarray(0, 10), contentType: 'application/pdf' });
  assert.equal(first.status, 200);
  assert.equal(first.body.complete, false);

  const overflow = await client.raw(path(1), { body: Buffer.concat([bytes, bytes]), contentType: 'application/pdf' });
  assert.equal(overflow.status, 400);
  assert.match(overflow.body.error.message, /announced size/);

  const rest = await client.raw(path(1), { body: bytes.subarray(10), contentType: 'application/pdf' });
  assert.equal(rest.status, 200);
  assert.equal(rest.body.complete, true);
});

test('publishing with an incomplete upload is refused, and the upload stays reusable', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);
  const bytes = pdfBytes();
  const begin = await client.post('/api/admin/leaflet-files', { name: 'leaflet.pdf', size: bytes.length });
  await client.raw(`/api/admin/leaflet-files/${begin.body.fileId}/chunks/0`, { body: bytes.subarray(0, 10), contentType: 'application/pdf' });

  const res = await publish(id, { pdf: { fileId: begin.body.fileId } });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /incomplete/);
  assert.equal(await leafletsFor(id), 0, 'nothing published');
  assert.equal((await db.get('leafletFile', begin.body.fileId)).status, 'pending');

  // Finish it, and the same upload publishes.
  await client.raw(`/api/admin/leaflet-files/${begin.body.fileId}/chunks/1`, { body: bytes.subarray(10), contentType: 'application/pdf' });
  assert.equal((await publish(id, { pdf: { fileId: begin.body.fileId } })).status, 201);
});

test('an upload already attached to a leaflet cannot be changed or attached again', async () => {
  const id = await product('TES12');
  const other = await product('TES25');
  await client.login(ADMIN.email, ADMIN.password);
  const fileId = await uploadPdf(pdfBytes());
  await publish(id, { pdf: { fileId } });

  const more = await client.raw(`/api/admin/leaflet-files/${fileId}/chunks/1`, { body: pdfBytes(), contentType: 'application/pdf' });
  assert.equal(more.status, 400);
  const again = await publish(other, { pdf: { fileId } });
  assert.equal(again.status, 400);
  assert.match(again.body.error.message, /already attached/);
});

test('an unknown upload id is refused', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);
  assert.equal((await publish(id, { pdf: { fileId: 999 } })).status, 400);
  assert.equal((await client.raw('/api/admin/leaflet-files/999/chunks/0', { body: pdfBytes(), contentType: 'application/pdf' })).status, 404);
});

test('uploads announced but never published are dropped after a day, assets included', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const bytes = pdfBytes('FORGOTTEN');
  const begin = await client.post('/api/admin/leaflet-files', { name: 'forgotten.pdf', size: bytes.length });
  await client.raw(`/api/admin/leaflet-files/${begin.body.fileId}/chunks/0`, { body: bytes, contentType: 'application/pdf' });
  const [piece] = (await db.get('leafletFile', begin.body.fileId)).pieces;
  assert.ok(await db.readFile(piece.asset_id), 'the piece is stored');

  const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000).toISOString();
  await db.update('leafletFile', begin.body.fileId, { created_at: twoDaysAgo });

  // A new upload beginning is when the sweep runs.
  await client.post('/api/admin/leaflet-files', { name: 'new.pdf', size: bytes.length });
  assert.equal(await db.get('leafletFile', begin.body.fileId), undefined);
  assert.equal(await db.readFile(piece.asset_id), undefined, 'and its asset is gone');
  assert.equal(await fileCount(), 1, 'the fresh upload is untouched');
});

test('a piece shared with another file survives the sweep', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);
  // The same bytes twice: content-addressed assets mean one asset, two files.
  const kept = await uploadPdf(pdfBytes('SAME'));
  await publish(id, { pdf: { fileId: kept } });
  const bytes = pdfBytes('SAME');
  const stale = await client.post('/api/admin/leaflet-files', { name: 'dup.pdf', size: bytes.length });
  await client.raw(`/api/admin/leaflet-files/${stale.body.fileId}/chunks/0`, { body: bytes, contentType: 'application/pdf' });
  await db.update('leafletFile', stale.body.fileId, { created_at: new Date(Date.now() - 48 * 3_600_000).toISOString() });

  await client.post('/api/admin/leaflet-files', { name: 'new.pdf', size: 10 });
  assert.equal(await db.get('leafletFile', stale.body.fileId), undefined, 'the stale index is gone');
  client.clearCookies();
  const served = await fetchPdf('/api/product/TES12/leaflet.pdf');
  assert.equal(served.status, 200, 'the published file still serves');
  assert.ok(served.bytes.equals(pdfBytes('SAME')));
});

test('a regulator cannot upload', async () => {
  await seedUser({ email: 'regulator@test.local', password: 'RegulatorPass!2026', role: 'regulator', name: 'Rita' });
  await client.login('regulator@test.local', 'RegulatorPass!2026');
  const res = await client.post('/api/admin/leaflet-files', { name: 'x.pdf', size: 10 });
  assert.equal(res.status, 403);
});

test('the file name is reduced to something safe to send back', async () => {
  const id = await product('TES12');
  await client.login(ADMIN.email, ADMIN.password);

  const fileId = await uploadPdf(pdfBytes(), { name: '..\\evil/name"?.PDF' });
  const res = await publish(id, { pdf: { fileId } });
  assert.equal(res.status, 201);
  assert.ok(!res.body.pdf.filename.includes('/') && !res.body.pdf.filename.includes('\\'));
  assert.ok(!res.body.pdf.filename.includes('"'));
  assert.match(res.body.pdf.filename, /\.pdf$/i);

  const untitled = await client.post('/api/admin/leaflet-files', { size: 10 });
  assert.equal(untitled.status, 201);
  assert.equal((await db.get('leafletFile', untitled.body.fileId)).filename, 'leaflet.pdf');
});
