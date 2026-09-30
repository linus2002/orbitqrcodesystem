/**
 * The bulk check is a delivery being received, not a patient's verification.
 *
 * It used to count every code it checked as a verification. A pharmacist
 * checking a delivery on arrival therefore made each patient who later
 * bought one of those packs the "second device" - told their genuine
 * medicine had already been verified elsewhere. And anyone could spoil a
 * hundred genuine packs a request by "checking" codes read off a shelf.
 *
 * Now a delivery check is decided by the same rules but changes nothing a
 * patient's check depends on; and a pack a patient HAS verified, turning up
 * in a delivery, is flagged whatever the duplicate threshold.
 *
 * The bulk check is switched off (see bulk-check-off.test.js). These tests
 * switch it on, so the rules are right on the day it comes back.
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
  bulkCheck.enabled = true;
});
after(async () => {
  bulkCheck.enabled = false;
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  codes = (await seedBasics({ quantity: 8 })).codes;
  client.clearCookies();
  await resetRateLimits();
  // This browser is the pharmacist's.
  await giveDetails(client, { fullName: 'Pat Pharmacist', role: 'pharmacist' });
});

const bulk = (list) => client.post('/api/verify/bulk', { codes: list }, { fromIp: '198.51.100.40' });

test("a pharmacist's delivery check does not spoil the patient's check", async () => {
  const delivery = await bulk([codes[0], codes[1]]);
  assert.equal(delivery.status, 200);
  assert.deepEqual(delivery.body.results.map((r) => r.result), ['genuine', 'genuine']);

  const patient = await client.newPerson({ fullName: 'Maria Patient' });
  const res = await client.post('/api/verify', { code: codes[0] }, { fromIp: '198.51.100.41', person: patient });

  assert.equal(res.body.result, 'genuine');
  assert.equal(res.body.reason, 'ok');
  assert.equal(res.body.scanNumber, 1, "the patient's check is the pack's first verification");
  assert.equal(res.body.message, 'This pack is genuine. It has been verified for the first time.');
});

test('a delivery check leaves the code as it was: not verified, no first-check time', async () => {
  await bulk([codes[2]]);

  const code = await db.getCode(codes[2]);
  assert.equal(code.verified_count, 0);
  assert.equal(code.status, 'released');
  assert.equal(code.first_scan_at, null);
  assert.equal(code.scan_count, 1, 'the check itself is still counted as a scan');
  assert.equal(await db.count('scan', { code_text: codes[2], channel: 'api' }), 1, 'and recorded');
});

test('checking a whole shelf of codes no longer makes them duplicates for patients', async () => {
  await bulk(codes.slice(0, 6));

  for (const code of codes.slice(0, 6)) {
    const patient = await client.newPerson();
    const res = await client.post('/api/verify', { code }, { fromIp: '198.51.100.42', person: patient });
    assert.equal(res.body.result, 'genuine', `${code} must still be genuine for its buyer`);
  }
  assert.equal(await db.count('alert', { type: 'duplicate_scan' }), 0);
});

test('a pack a patient has already verified is flagged in a delivery, whatever the threshold', async () => {
  const patient = await client.newPerson();
  await client.post('/api/verify', { code: codes[3] }, { fromIp: '198.51.100.43', person: patient });
  // Even with the threshold raised, a verified pack has no business in a delivery.
  await db.insert('setting', { key: 'alerts.duplicate_threshold', value: '3' });

  const res = await bulk([codes[3]]);

  assert.equal(res.body.results[0].result, 'flagged');
  assert.equal(res.body.results[0].reason, 'duplicate_scan');
  assert.equal(await db.count('alert', { type: 'duplicate_scan' }), 1);
});

test('the other rules still apply to a delivery check', async () => {
  const res = await bulk(['AMX25-260901-99999-ZZ', codes[4]]);

  assert.equal(res.body.results[0].result, 'invalid');
  assert.equal(res.body.results[1].result, 'genuine');
});
