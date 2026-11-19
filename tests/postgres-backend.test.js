/**
 * The Postgres backend's own guarantees - the things the shared API suite
 * cannot see because it only ever talks to one instance:
 *
 *   - what is committed survives a restart (Postgres is the store; memory is
 *     a copy)
 *   - a mutation list that fails writes nothing, anywhere
 *   - a write starts from the COMMITTED row, not a stale copy in memory, so a
 *     second instance cannot make this one lose an increment or duplicate a
 *     create
 *   - files keep their bytes, kind and details, and an unknown kind is refused
 *     by the database itself
 *
 * Runs against PGlite - real Postgres compiled to WebAssembly - in-process.
 * The whole API suite can run on it too: TEST_BACKEND=postgres npm test.
 */
import './setup-env.js';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';

import { PostgresBackend, assertSchemaName, describeUrl } from '../src/db/postgres.js';

let pglite;
let server;
let url;
let n = 0;

before(async () => {
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1', maxConnections: 4 });
  await server.start();
  url = `postgres://postgres:secret-password@127.0.0.1:${server.server.address().port}/postgres`;
});

after(async () => {
  await server.stop();
  await pglite.close();
});

/** A backend on a schema of its own - or on `schema`, to share one. */
const open = (schema = `pgb_${++n}`) =>
  new PostgresBackend({ url, schema, poolMax: 1, listen: false });

/** Raw SQL against the database, behind the backend's back - "another instance". */
async function sql(text, params) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

test('documents survive a restart: a new instance loads what the last one committed', async () => {
  const a = open('pgb_restart');
  await a.mutate([{ create: { _id: 'product-1', _type: 'product', id: 1, sku: 'AMX25', name: 'Amoxicillin' } }]);
  await a.mutate([{ patch: { id: 'product-1', set: { name: 'Amoxicillin 250' } } }]);
  await a.close();

  const b = open('pgb_restart');
  const doc = await b.getDocument('product-1');
  assert.equal(doc.name, 'Amoxicillin 250');
  assert.deepEqual(await b.fetch('*[_type == "product"].sku'), ['AMX25']);
  await b.close();
});

test('a mutation list that fails writes nothing - not to Postgres, not to memory', async () => {
  const b = open();
  await assert.rejects(
    b.mutate([
      { create: { _id: 'batch-1', _type: 'batch', id: 1 } },
      { patch: { id: 'batch-does-not-exist', set: { status: 'x' } } },
    ]),
    (err) => err.statusCode === 404
  );
  assert.equal(await b.getDocument('batch-1'), null);
  assert.equal((await sql(`SELECT count(*)::int AS n FROM ${b.schema}.documents`))[0].n, 0);
  await b.close();
});

test('a create of an id that exists is a 409, and createIfNotExists returns the existing one', async () => {
  const b = open();
  await b.mutate([{ create: { _id: 'code-X1', _type: 'code', code: 'X1', scan_count: 0 } }]);
  await assert.rejects(
    b.mutate([{ create: { _id: 'code-X1', _type: 'code', code: 'X1' } }]),
    (err) => err.statusCode === 409
  );
  const [existing] = await b.mutate([{ createIfNotExists: { _id: 'code-X1', _type: 'code', code: 'other' } }]);
  assert.equal(existing.code, 'X1');
  await b.close();
});

test('an increment starts from the committed value, even when this copy is stale', async () => {
  const b = open();
  await b.mutate([{ create: { _id: 'counter-scan', _type: 'counter', value: 0 } }]);

  // Another instance increments to 5 behind this one's back.
  await sql(
    `UPDATE ${b.schema}.documents SET rev = 'other', doc = jsonb_set(doc || '{"_rev":"other"}', '{value}', '5') WHERE id = 'counter-scan'`
  );
  assert.equal((await b.getDocument('counter-scan')).value, 0, 'the copy in memory is stale');

  const [, after] = await b.mutate([
    { createIfNotExists: { _id: 'counter-scan', _type: 'counter', value: 0 } },
    { patch: { id: 'counter-scan', inc: { value: 1 } } },
  ]);
  assert.equal(after.value, 6, 'not 1: the increment was applied to the committed 5');
  await b.close();
});

test('a create that another instance already made is refused, not overwritten', async () => {
  const b = open();
  await sql(
    `INSERT INTO ${b.schema}.documents (id, type, rev, doc) VALUES ('uniqueKey-a', 'uniqueKey', 'r1', '{"_id":"uniqueKey-a","_type":"uniqueKey","_rev":"r1","owner":"someone-else"}')`
  );
  await assert.rejects(
    b.mutate([{ create: { _id: 'uniqueKey-a', _type: 'uniqueKey', owner: 'me' } }]),
    (err) => err.statusCode === 409
  );
  const rows = await sql(`SELECT doc FROM ${b.schema}.documents WHERE id = 'uniqueKey-a'`);
  assert.equal(rows[0].doc.owner, 'someone-else');
  await b.close();
});

test('concurrent increments in one process are never lost', async () => {
  const b = open();
  await b.mutate([{ create: { _id: 'code-C', _type: 'code', scan_count: 0 } }]);
  await Promise.all(
    Array.from({ length: 20 }, () => b.mutate([{ patch: { id: 'code-C', inc: { scan_count: 1 } } }]))
  );
  assert.equal((await b.getDocument('code-C')).scan_count, 20);
  const rows = await sql(`SELECT doc FROM ${b.schema}.documents WHERE id = 'code-C'`);
  assert.equal(rows[0].doc.scan_count, 20);
  await b.close();
});

test('reload() picks up rows another instance changed or deleted', async () => {
  const b = open();
  await b.mutate([
    { create: { _id: 'a', _type: 't', v: 1 } },
    { create: { _id: 'b', _type: 't', v: 1 } },
  ]);
  await sql(`UPDATE ${b.schema}.documents SET doc = jsonb_set(doc, '{v}', '2') WHERE id = 'a'`);
  await sql(`DELETE FROM ${b.schema}.documents WHERE id = 'b'`);
  await b.reload(['a', 'b']);
  assert.equal((await b.getDocument('a')).v, 2);
  assert.equal(await b.getDocument('b'), null);
  await b.close();
});

test('files keep their bytes, kind and details', async () => {
  const b = open();
  const bytes = Buffer.from('%PDF-1.7 a leaflet');
  const stored = await b.uploadFile(bytes, { filename: 'leaflet.pdf', contentType: 'application/pdf', kind: 'leaflet' });
  assert.match(stored.assetId, /^file-[0-9a-f]{40}-pdf$/);
  assert.deepEqual(await b.readFile(stored.assetId), bytes);

  // Same bytes, same id: a repeat upload is a no-op.
  assert.equal((await b.uploadFile(bytes, { filename: 'again.pdf', kind: 'leaflet' })).assetId, stored.assetId);

  await b.uploadFile(Buffer.from('PK\x03\x04 workbook'), {
    id: 'export-1', filename: 'batches.xlsx', kind: 'export', meta: { rows: 3 }, createdBy: 7,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const info = await b.fileInfo('export-1');
  assert.equal(info.kind, 'export');
  assert.equal(info.filename, 'batches.xlsx');
  assert.equal(info.createdBy, 7);
  assert.deepEqual(info.meta, { rows: 3 });
  assert.equal(info.size, 13);
  assert.equal(info.bytes, undefined, 'details never carry the bytes');

  const list = await b.listFiles({ kind: 'export' });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, 'export-1');

  await b.deleteFile(stored.assetId);
  assert.equal(await b.readFile(stored.assetId), undefined);
  await b.close();
});

test('the database itself refuses a file of an unknown kind', async () => {
  const b = open();
  await assert.rejects(b.uploadFile(Buffer.from('x'), { filename: 'x.exe', kind: 'program' }), /check constraint/i);
  await b.close();
});

test('the schema name is checked before it reaches SQL, and logs never show the password', () => {
  assert.throws(() => assertSchemaName('qrshield; DROP TABLE x'), /plain lower-case identifier/);
  assert.equal(assertSchemaName('qrshield'), 'qrshield');
  const named = describeUrl('postgres://user:hunter2@db.internal:5432/postgres');
  assert.equal(named, 'db.internal:5432/postgres');
  assert.doesNotMatch(open().name, /secret-password/);
});
