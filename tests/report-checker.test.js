/**
 * A patient report, linked to the person who made the check it is about.
 *
 * The report form sends the id of the check it follows. Staff see the report
 * beside the details that person gave before checking - so the link is kept
 * only when the check is the reporter's own. A report naming somebody else's
 * check, or one that does not exist, is still accepted, just not tied to
 * anyone.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits, DETAILS } from './helpers.js';
import * as db from '../src/db/index.js';

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const REPORT = 'The foil seal was already broken when I opened it.';

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
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  client.clearCookies();
  await resetRateLimits();
});

/** A fresh browser that gives its details, then checks a pack. */
async function personChecks(code, details = {}) {
  client.clearCookies();
  const given = await client.post('/api/portal/details', { ...DETAILS, ...details });
  assert.equal(given.status, 201, JSON.stringify(given.body));
  const res = await client.post('/api/verify', { code });
  assert.equal(res.status, 200);
  return res.body.scanId;
}

/** The reports list, as an admin sees it. */
async function reportsAsAdmin() {
  await client.login(ADMIN.email, ADMIN.password);
  const res = await client.get('/api/admin/reports');
  assert.equal(res.status, 200);
  return res.body.items;
}

test("a report after a person's own check is linked to them, and staff see who checked", async () => {
  const scanId = await personChecks(codes[0]);
  const sent = await client.post('/api/report', { code: codes[0], scanId, description: REPORT });
  assert.equal(sent.status, 201);
  assert.equal((await db.findOne('consumerReport', {})).scan_id, scanId);

  const [report] = await reportsAsAdmin();
  assert.equal(report.checker.name, 'Maria Santos');
  assert.equal(report.checker.phone, '+639171234567');
  assert.equal(report.checker.role, 'patient');
});

test("a report naming somebody else's check is kept, but not tied to them", async () => {
  const theirs = await personChecks(codes[1], { fullName: 'Someone Else' });
  await personChecks(codes[2], { fullName: 'The Reporter' });

  const sent = await client.post('/api/report', { code: codes[1], scanId: theirs, description: REPORT });
  assert.equal(sent.status, 201, 'the report itself is still accepted');
  const stored = await db.findOne('consumerReport', {});
  assert.equal(stored.scan_id, null);
  assert.equal((await db.get('alert', stored.alert_id)).scan_id, null);

  const [report] = await reportsAsAdmin();
  assert.equal(report.checker, null, 'Someone Else must not appear on this report');
});

test('a check that does not exist is dropped from the report', async () => {
  await personChecks(codes[3]);
  const sent = await client.post('/api/report', { scanId: 99999, description: REPORT });
  assert.equal(sent.status, 201);
  assert.equal((await db.findOne('consumerReport', {})).scan_id, null);
});

test('with details not asked for, a report keeps its check as before', async () => {
  await db.insert('setting', { key: 'portal.require_details', value: 'off' });
  const check = await client.post('/api/verify', { code: codes[4] });
  const sent = await client.post('/api/report', { code: codes[4], scanId: check.body.scanId, description: REPORT });
  assert.equal(sent.status, 201);
  assert.equal((await db.findOne('consumerReport', {})).scan_id, check.body.scanId);

  const [report] = await reportsAsAdmin();
  assert.equal(report.checker, null, 'an anonymous check names nobody');
});

test('the report form is offered back where the person said they got the medicine', async () => {
  client.clearCookies();
  const given = await client.post('/api/portal/details', { ...DETAILS, purchaseLocation: 'Mercury Drug, Cubao' });
  assert.equal(given.body.checker.purchaseLocation, 'Mercury Drug, Cubao');
  const portal = await client.get('/api/portal');
  assert.equal(portal.body.checker.purchaseLocation, 'Mercury Drug, Cubao');
});
