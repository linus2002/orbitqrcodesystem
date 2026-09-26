/**
 * The duplicate rule, for people who gave their details.
 *
 * A re-check used to count as the same source only from the same internet
 * address within 15 minutes, so a patient re-checking their own pack the
 * next day, or after moving from Wi-Fi to mobile data, was told it might be
 * a copy. Now the person is known:
 *   - their own second check is a harmless repeat;
 *   - after two checks the pack is not checked again for them, nothing is
 *     recorded, and they are shown their last answer;
 *   - one person re-checking never raises or escalates an alert;
 *   - somebody else is judged by the usual rule;
 *   - a recall is always shown, however often a pack is checked.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';
import * as serialization from '../src/services/serialization.js';

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
  await giveDetails(client);
  await resetRateLimits();
});

const check = (code, opts = {}) => client.post('/api/verify', { code }, { fromIp: '198.51.100.7', ...opts });
const codeRow = (code) => db.getCode(code);
const alertsFor = async (code) => db.findMany('alert', { code_id: (await codeRow(code)).id });

/** Pretend a check happened a while ago. */
const age = (scanId, minutes) =>
  db.update('scan', scanId, { created_at: new Date(Date.now() - minutes * 60000).toISOString() });

test('a person re-checking their own pack the next day is told it is genuine', async () => {
  const first = await check(codes[0]);
  await age(first.body.scanId, 24 * 60);

  const again = await check(codes[0]);
  assert.equal(again.body.result, 'genuine');
  assert.equal(again.body.reason, 'ok_repeat_same_source');
  assert.equal(again.body.message, 'This pack is genuine. You have checked it before.');
  assert.equal((await codeRow(codes[0])).verified_count, 1, 'still one person');
  assert.equal((await alertsFor(codes[0])).length, 0);
});

test('a person re-checking after their phone changes network is told it is genuine', async () => {
  await check(codes[0], { fromIp: '198.51.100.7' });
  const again = await check(codes[0], { fromIp: '203.0.113.50' });
  assert.equal(again.body.result, 'genuine');
  assert.equal((await alertsFor(codes[0])).length, 0);
});

test('after two checks the pack is not checked again for that person, and nothing is recorded', async () => {
  await check(codes[0]);
  const second = await check(codes[0]);
  const scansBefore = await db.count('scan');
  const codeBefore = await codeRow(codes[0]);

  const third = await check(codes[0], { fromIp: '203.0.113.9' });
  assert.equal(third.status, 200);
  assert.equal(third.body.reason, 'check_limit');
  assert.equal(third.body.result, 'genuine', 'their last answer');
  assert.match(third.body.message, /already checked this pack twice/);
  assert.equal(third.body.scanNumber, undefined, 'not a check, so no number');
  assert.equal(third.body.scanId, second.body.scanId, 'a report links to their last check');
  assert.ok(third.body.leaflet, 'they can still read the leaflet');

  assert.equal(await db.count('scan'), scansBefore, 'no scan recorded');
  const codeAfter = await codeRow(codes[0]);
  assert.equal(codeAfter.scan_count, codeBefore.scan_count);
  assert.equal(codeAfter.verified_count, codeBefore.verified_count);
  assert.equal((await alertsFor(codes[0])).length, 0);
});

test('somebody else checking the pack is judged by the usual rule', async () => {
  await check(codes[0]);
  const other = await client.newPerson();
  const theirs = await check(codes[0], { fromIp: '203.0.113.20', person: other });
  assert.equal(theirs.body.result, 'flagged');
  assert.equal(theirs.body.reason, 'duplicate_scan');
  assert.equal((await alertsFor(codes[0])).length, 1);
});

test('one person re-checking a flagged pack cannot escalate the alert, and is then stopped', async () => {
  await check(codes[0]);
  const other = await client.newPerson();
  await check(codes[0], { fromIp: '203.0.113.20', person: other });
  const [alert] = await alertsFor(codes[0]);

  const again = await check(codes[0], { fromIp: '203.0.113.21', person: other });
  assert.equal(again.body.result, 'flagged', 'the same answer again');
  const [after1] = await alertsFor(codes[0]);
  assert.equal(after1.severity, alert.severity);
  assert.equal(JSON.parse(after1.detail_json).occurrences, 1, 'not folded in as another sighting');

  const third = await check(codes[0], { fromIp: '203.0.113.22', person: other });
  assert.equal(third.body.reason, 'check_limit');
  assert.equal(third.body.result, 'flagged');
  assert.match(third.body.message, /do not use it until you have checked with your pharmacist/);
  assert.equal(third.body.leaflet, null, 'no dosing text beside a warning');
  assert.equal((await alertsFor(codes[0])).length, 1);
});

test('a third person is still a new sighting, and escalates the alert as before', async () => {
  await check(codes[0]);
  await check(codes[0], { fromIp: '203.0.113.20', person: await client.newPerson() });
  await check(codes[0], { fromIp: '203.0.113.30', person: await client.newPerson() });
  const [alert] = await alertsFor(codes[0]);
  assert.equal(JSON.parse(alert.detail_json).occurrences, 2);
});

test('a recall is always shown, however often the pack was checked', async () => {
  await check(codes[0]);
  await check(codes[0]);
  await serialization.transition(1, 'recalled', { reason: 'Contamination found at the plant' });

  const third = await check(codes[0]);
  assert.equal(third.body.result, 'flagged');
  assert.equal(third.body.reason, 'recalled');
});

test('the limit is per pack', async () => {
  await check(codes[0]);
  await check(codes[0]);
  const another = await check(codes[1]);
  assert.equal(another.body.result, 'genuine');
  assert.equal(another.body.reason, 'ok');
});

test('without details given, the old rule still applies', async () => {
  await db.insert('setting', { key: 'portal.require_details', value: 'off' });
  client.clearCookies();
  await check(codes[0], { fromIp: '198.51.100.7' });
  const sameNetwork = await check(codes[0], { fromIp: '198.51.100.7' });
  assert.equal(sameNetwork.body.reason, 'ok_repeat_same_source', 'same address, within 15 minutes');
  const otherNetwork = await check(codes[0], { fromIp: '203.0.113.50' });
  assert.equal(otherNetwork.body.reason, 'duplicate_scan', 'an address alone is not a person');
});
