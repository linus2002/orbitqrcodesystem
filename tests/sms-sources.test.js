/**
 * Telling text-message senders apart.
 *
 * Every text reaches the system from the SMS gateway's one address. Keyed on
 * that address, everyone texting was one "source": a second phone checking a
 * copied code within 15 minutes of the first was "the same person
 * re-checking" and told genuine, with no duplicate alert - and one sender's
 * typos counted toward a guessing alert for all. A text is now keyed on the
 * sender's number, and each number has its own rate limit.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';
import { config } from '../src/config.js';

let client;
let codes;

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  codes = (await seedBasics({ quantity: 6 })).codes;
  client.clearCookies();
  await resetRateLimits();
});

// All from one address, as a gateway's requests are.
const text = (from, body) =>
  client.post('/api/sms/inbound?key=test-webhook-secret', { from, body }, { fromIp: '203.0.113.200' });

test('a second phone texting the same code is a duplicate, not "the same person"', async () => {
  const first = await text('+639170000001', codes[0]);
  const second = await text('+639170000002', codes[0]);
  const third = await text('+639170000003', codes[0]);

  assert.equal(first.body.result, 'genuine');
  assert.equal(second.body.result, 'flagged');
  assert.equal(second.body.reason, 'duplicate_scan');
  assert.equal(third.body.reason, 'duplicate_scan');
  assert.equal(await db.count('alert', { type: 'duplicate_scan' }), 1, 'one incident, folded');
});

test('the same phone re-texting within 15 minutes is still one check', async () => {
  await text('+639170000001', codes[1]);
  const again = await text('+639170000001', codes[1]);

  assert.equal(again.body.result, 'genuine');
  assert.equal(again.body.reason, 'ok_repeat_same_source');
});

test('the number is the same sender however the gateway writes it', async () => {
  await text('+639170000009', codes[2]);
  const again = await text('09170000009', codes[2]);

  assert.equal(again.body.reason, 'ok_repeat_same_source');
});

test("one sender's mistyped codes do not count toward another's guessing alert", async () => {
  const typos = config.rateLimit.guessAlertThreshold - 1;
  for (let i = 0; i < typos; i++) await text('+639170000011', `AMX25-260901-0000${i}-ZZ`);
  for (let i = 0; i < typos; i++) await text('+639170000012', `AMX25-260901-0000${i}-ZZ`);

  assert.equal(await db.count('alert', { type: 'guess_attack' }), 0, 'each sender stayed under the threshold');

  await text('+639170000011', 'AMX25-260901-00099-ZZ');
  assert.equal(await db.count('alert', { type: 'guess_attack' }), 1, "and the one who crossed it is alerted");
});

test('each number has its own rate limit', async () => {
  const perMinute = config.rateLimit.verifyPerMin;
  for (let i = 0; i < perMinute; i++) {
    const res = await text('+639170000021', codes[3]);
    assert.equal(res.status, 200);
  }
  const over = await text('+639170000021', codes[3]);
  const other = await text('+639170000022', codes[4]);

  assert.equal(over.status, 429);
  assert.equal(other.status, 200, 'another sender is unaffected');
});
