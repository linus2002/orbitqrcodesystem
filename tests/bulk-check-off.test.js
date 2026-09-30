/**
 * The bulk check is switched off (bulkCheck in routes/public.js).
 *
 * Two halves. While switched off: the address answers exactly as one that
 * does not exist - for someone who has given their details and for someone
 * who has not, and however often it is called, so neither the details check
 * nor the rate limit gives it away - and nothing is checked or recorded.
 * Checking one pack at a time is untouched.
 *
 * Switched back on: it checks a delivery as before. That half, with
 * bulk-supply-check.test.js, keeps the unused code honest - if a later
 * change breaks it, this says so now, not on the day it is switched back on.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';
import { bulkCheck } from '../src/routes/public.js';

let client;
let codes;

before(async () => {
  client = await startServer();
});
after(async () => {
  bulkCheck.enabled = false;
  await client.close();
});

beforeEach(async () => {
  bulkCheck.enabled = false;
  await freshDb();
  codes = (await seedBasics({ quantity: 4 })).codes;
  client.clearCookies();
  await resetRateLimits();
});

const bulk = (list = [codes[0], codes[1]]) => client.post('/api/verify/bulk', { codes: list });

/** What any address that does not exist answers. */
const NOT_FOUND = { error: { code: 'not_found', message: 'No API route matches POST /api/verify/bulk' } };

test('it is switched off', () => {
  assert.equal(bulkCheck.enabled, false);
});

test('to someone who has not given details, it answers as an address that does not exist', async () => {
  const res = await bulk();
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, NOT_FOUND);

  const unknown = await client.post('/api/verify/bulky', { codes: [codes[0]] });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, res.body.error.code, 'the same answer as a made-up address');
});

test('to someone who has given details, it answers the same', async () => {
  await giveDetails(client);
  const res = await bulk();
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, NOT_FOUND);
});

test('nothing is checked or recorded', async () => {
  await giveDetails(client);
  const before = await db.getCode(codes[0]);
  await bulk();

  assert.equal(await db.count('scan'), 0);
  assert.equal(await db.count('alert'), 0);
  const after = await db.getCode(codes[0]);
  assert.equal(after.scan_count, before.scan_count);
  assert.equal(after.status, before.status);
});

test('the rate limit never answers for it, so that does not give it away either', async () => {
  // Its own limit is 20 an hour.
  for (let i = 0; i < 25; i++) {
    const res = await bulk();
    assert.equal(res.status, 404, `call ${i + 1}`);
  }
});

test('checking one pack at a time is untouched', async () => {
  await giveDetails(client);
  const single = await client.post('/api/verify', { code: codes[0] });
  assert.equal(single.status, 200);
  assert.equal(single.body.result, 'genuine');

  const deepLink = await client.get(`/api/verify/${encodeURIComponent(codes[1])}`);
  assert.equal(deepLink.status, 200);
  assert.equal(deepLink.body.result, 'genuine');
});

test('switched back on, it checks a delivery as before', async () => {
  bulkCheck.enabled = true;

  const refused = await bulk();
  assert.equal(refused.status, 403, 'still behind the details check');
  assert.equal(refused.body.error.code, 'details_required');

  await giveDetails(client);
  const res = await bulk([codes[0], codes[1], 'rubbish']);
  assert.equal(res.status, 200);
  assert.equal(res.body.checked, 3);
  assert.equal(res.body.genuine, 2);
  assert.equal(res.body.invalid, 1);
  assert.equal(await db.count('scan', { channel: 'api' }), 3);
});
