/**
 * One source making the first check of many different packs.
 *
 * A patient checks the pack or two in their hand. Someone checking dozens of
 * codes they did not buy - read off a shelf, a carton or a photo - makes each
 * of those packs read "already verified elsewhere" to its real buyer. That
 * pattern now raises an unusual_checking alert, once per source per hour.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';
import { config } from '../src/config.js';
import { bulkCheck } from '../src/routes/public.js';

let client;
let codes;
const LIMIT = config.rateLimit.massCheckThreshold;

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  codes = (await seedBasics({ quantity: LIMIT + 6 })).codes;
  client.clearCookies();
  await resetRateLimits();
  await giveDetails(client);
});

/** This browser's person checks `list`, each from its own address so no rate limit applies. */
async function checkAll(list) {
  for (const [i, code] of list.entries()) {
    const res = await client.post('/api/verify', { code }, { fromIp: `198.51.100.${100 + (i % 150)}` });
    assert.equal(res.body.result, 'genuine');
  }
}

test('the default threshold is 20 first checks in an hour', () => {
  assert.equal(LIMIT, 20);
});

test('one person first-checking the threshold of different packs raises one alert', async () => {
  await checkAll(codes.slice(0, LIMIT));

  const alerts = await db.findMany('alert', { type: 'unusual_checking' });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'medium');
  assert.equal(alerts[0].title, `One person checked ${LIMIT} different packs for the first time in an hour`);
});

test('below the threshold, nothing', async () => {
  await checkAll(codes.slice(0, LIMIT - 1));
  assert.equal(await db.count('alert', { type: 'unusual_checking' }), 0);
});

test('more checks in the same hour do not raise a second alert', async () => {
  await checkAll(codes.slice(0, LIMIT + 5));
  assert.equal(await db.count('alert', { type: 'unusual_checking' }), 1);
});

test('re-checking packs already checked does not count - only first checks do', async () => {
  await checkAll(codes.slice(0, 3));
  for (let i = 0; i < LIMIT; i++) {
    const res = await client.post('/api/verify', { code: codes[i % 3] }, { fromIp: `203.0.113.${i + 1}` });
    assert.equal(res.body.result, 'genuine');
  }
  assert.equal(await db.count('alert', { type: 'unusual_checking' }), 0);
});

test('a delivery check of many codes does not count', async () => {
  // The bulk check is switched off (see bulk-check-off.test.js); this is for
  // the day it is switched back on.
  bulkCheck.enabled = true;
  try {
    const res = await client.post('/api/verify/bulk', { codes: codes.slice(0, LIMIT + 5) }, { fromIp: '198.51.100.90' });
    assert.equal(res.body.genuine, LIMIT + 5);
    assert.equal(await db.count('alert', { type: 'unusual_checking' }), 0);
  } finally {
    bulkCheck.enabled = false;
  }
});

test('different people each checking a few packs raise nothing', async () => {
  for (let p = 0; p < 5; p++) {
    const person = await client.newPerson();
    for (let i = 0; i < 5; i++) {
      await client.post('/api/verify', { code: codes[p * 5 + i] }, { fromIp: `198.51.100.${10 + p}`, person });
    }
  }
  assert.equal(await db.count('alert', { type: 'unusual_checking' }), 0);
});
