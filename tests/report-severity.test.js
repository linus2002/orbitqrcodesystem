/**
 * How urgent a patient report is.
 *
 * Anyone can report any code - no details, no check - and every report used
 * to raise a HIGH alert. A stream of reports about genuine packs could bury
 * the real alerts, or push staff toward recalling a genuine batch. A report
 * that follows the reporter's own check of the pack is still high; one with
 * no check behind it starts at medium and says so in its title.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';

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
  codes = (await seedBasics({ quantity: 4 })).codes;
  client.clearCookies();
  await resetRateLimits();
});

const DESCRIPTION = 'The box print is blurry and the seal was loose.';
const reportAlert = () => db.findOne('alert', { type: 'consumer_report' });

test('a report after your own check of the pack is high', async () => {
  await giveDetails(client);
  const check = await client.post('/api/verify', { code: codes[0] }, { fromIp: '198.51.100.70' });

  const res = await client.post('/api/report', { code: codes[0], scanId: check.body.scanId, description: DESCRIPTION });

  assert.equal(res.status, 201);
  const alert = await reportAlert();
  assert.equal(alert.severity, 'high');
  assert.equal(alert.title, `Patient report: ${DESCRIPTION}`);
});

test('a report with no check behind it is medium, and says so', async () => {
  const res = await client.post('/api/report', { code: codes[1], description: DESCRIPTION });

  assert.equal(res.status, 201, 'still accepted - a direct report is allowed');
  const alert = await reportAlert();
  assert.equal(alert.severity, 'medium');
  assert.equal(alert.title, `Patient report (no check made): ${DESCRIPTION}`);
});

test("a report naming somebody else's check counts as no check", async () => {
  await giveDetails(client);
  const theirs = await client.post('/api/verify', { code: codes[2] }, { fromIp: '198.51.100.71' });
  client.clearCookies();

  await client.post('/api/report', { code: codes[2], scanId: theirs.body.scanId, description: DESCRIPTION });

  assert.equal((await reportAlert()).severity, 'medium');
});
