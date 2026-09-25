/**
 * The printable label sheet.
 *
 * Untested until now, and the screen only ever asked for the first 24 of a
 * batch - so the paging the route already supported was never exercised. The
 * sheet now pages through a whole batch, which makes two properties load
 * bearing: consecutive pages must not overlap (a duplicated label means two
 * cartons carrying the same code, which the system would later read as a
 * counterfeit), and none may be skipped.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';

let client;

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const REGULATOR = { email: 'regulator@test.local', password: 'RegulatorPass!2026' };

/** Bigger than one page, so paging has a remainder to get wrong. */
const QUANTITY = 70;
const PAGE = 60;

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  await seedBasics({ quantity: QUANTITY });
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  await seedUser({ ...REGULATOR, role: 'regulator', name: 'Rita Regulator' });
  client.clearCookies();
  await resetRateLimits();
});

/*
 * The query string is built into the path: the test client passes through
 * method, body, headers and fromIp only, so a `query` option would be
 * silently dropped and every assertion below would be testing the route's
 * defaults instead of its paging.
 */
const labels = (query = {}) => {
  const qs = new URLSearchParams(query).toString();
  return client.get(`/api/admin/batches/1/labels${qs ? `?${qs}` : ''}`);
};

test('total counts the whole batch, not the page', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  const res = await labels({ limit: PAGE, offset: 0 });

  assert.equal(res.status, 200);
  assert.equal(res.body.total, QUANTITY, 'total is the batch, so the pager can size itself');
  assert.equal(res.body.items.length, PAGE, 'but only one page of labels is returned');
});

test('paging covers the batch exactly once, in order', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  const first = await labels({ limit: PAGE, offset: 0 });
  const second = await labels({ limit: PAGE, offset: PAGE });

  assert.equal(second.body.items.length, QUANTITY - PAGE, 'the remainder, not a full page');

  const seen = [...first.body.items, ...second.body.items].map((i) => i.code);
  assert.equal(seen.length, QUANTITY, 'every unit appears');
  assert.equal(new Set(seen).size, QUANTITY, 'and none appears twice');

  const expected = (
    await db.findMany('code', { batch_id: 1 }, { order: 'unit_index asc' })
  ).map((c) => c.code);
  assert.deepEqual(seen, expected, 'in unit_index order, so the sheet matches the CSV');
});

test('an offset past the end is empty rather than an error', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  const res = await labels({ limit: PAGE, offset: 1000 });

  assert.equal(res.status, 200, 'the pager can overshoot without breaking the screen');
  assert.equal(res.body.items.length, 0);
  assert.equal(res.body.total, QUANTITY);
});

test('the per-request ceiling is enforced however large a limit is asked for', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  const res = await labels({ limit: 100000, offset: 0 });

  // Every label carries its own rendered SVG, so an unbounded limit would be
  // a megabyte-scale response. The route clamps rather than trusting.
  assert.ok(res.body.items.length <= PAGE, `clamped to at most ${PAGE}, got ${res.body.items.length}`);
});

test('a negative offset is treated as the start, not as a backwards slice', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  const res = await labels({ limit: 5, offset: -20 });

  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 5);
  const firstCode = (await db.findOne('code', { batch_id: 1 }, { order: 'unit_index asc' })).code;
  assert.equal(res.body.items[0].code, firstCode);
});

test('every label carries a rendered QR and its own code', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  const res = await labels({ limit: 3, offset: 0 });

  for (const item of res.body.items) {
    assert.match(item.svg, /<svg/, 'an SVG, not an empty string');
    assert.match(item.svg, /<path/, 'with drawn modules');
    assert.ok(item.code, 'and the human-readable code printed beneath it');
  }
  assert.equal(res.body.batch.sku, 'AMX25');
});

test('an unknown batch is a 404', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.get('/api/admin/batches/9999/labels');

  assert.equal(res.status, 404);
});

test('a regulator cannot read the label sheet', async () => {
  await client.login(REGULATOR.email, REGULATOR.password);

  const res = await labels({ limit: 5, offset: 0 });

  assert.equal(res.status, 403, 'codes:read is not in the regulator role');
});
