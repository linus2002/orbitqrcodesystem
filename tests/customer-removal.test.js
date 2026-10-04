/**
 * Removing and correcting a person's details, as the privacy notice
 * promises: on their request, by an administrator, with a reason.
 *
 * What matters most:
 *   - after removal nothing names or reaches the person, and their browser
 *     is asked for details again;
 *   - their past checks stay, as evidence, without their name;
 *   - the audit log says who, which record and why - never the details;
 *   - only an administrator can do it, and never without a reason.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const SECURITY = { email: 'security@test.local', password: 'SecurityPass!2026' };
const REGULATOR = { email: 'regulator@test.local', password: 'RegulatorPass!2026' };
const REASON = 'The person phoned on 26 Sept and asked for their details to be removed.';
const PERSONAL = ['Maria Santos', '+639171234567', 'maria@gmail.com', 'Quezon City', 'Mercury Drug, Cubao'];

let client;
let codes;
let personId;

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  codes = (await seedBasics({ quantity: 4 })).codes;
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  await seedUser({ ...SECURITY, role: 'security', name: 'Sam Security' });
  await seedUser({ ...REGULATOR, role: 'regulator', name: 'Rita Regulator' });
  client.clearCookies();
  await resetRateLimits();

  // Maria gives her details, checks a pack, and reports a problem with it.
  await giveDetails(client, { purchaseLocation: 'Mercury Drug, Cubao' });
  const check = await client.post('/api/verify', { code: codes[0] });
  await client.post('/api/report', {
    code: codes[0],
    scanId: check.body.scanId,
    description: 'The seal looked different from last time.',
    reporterName: 'Maria Santos',
    reporterContact: '+639171234567 / maria@gmail.com',
  });
  personId = (await db.findOne('verifier', {})).id;
});

/** Sign in as staff, keeping Maria's portal cookie in the same jar. */
const signIn = (user) => client.login(user.email, user.password);

test('removal leaves nothing that names or reaches the person', async () => {
  await signIn(ADMIN);
  const res = await client.post(`/api/admin/customers/${personId}/remove`, { reason: REASON });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const person = await db.get('verifier', personId);
  assert.equal(person.full_name, '(removed)');
  assert.equal(person.phone, '(removed)');
  assert.equal(person.email, '(removed)');
  assert.equal(person.city ?? null, null);
  assert.equal(person.purchase_location ?? null, null);
  assert.equal(person.ip_hash ?? null, null);
  assert.equal(person.user_agent ?? null, null);

  const report = await db.findOne('consumerReport', {});
  assert.equal(report.reporter_name ?? null, null, 'the name typed into their report goes too');
  assert.equal(report.reporter_contact ?? null, null);

  // Nothing personal anywhere staff can read it.
  const views = [
    (await client.get('/api/admin/customers')).body,
    (await client.get(`/api/admin/customers/${personId}`)).body,
    (await client.get('/api/admin/customers.csv')).body,
    (await client.get('/api/admin/scans')).body,
  ];
  for (const view of views) {
    const text = typeof view === 'string' ? view : JSON.stringify(view);
    for (const detail of PERSONAL) assert.ok(!text.includes(detail), `"${detail}" still shows`);
  }
});

test('their past checks stay, without their name', async () => {
  const scansBefore = await db.count('scan');
  await signIn(ADMIN);
  await client.post(`/api/admin/customers/${personId}/remove`, { reason: REASON });

  assert.equal(await db.count('scan'), scansBefore);
  const detail = (await client.get(`/api/admin/customers/${personId}`)).body;
  assert.equal(detail.scans.length, 1);
  assert.equal(detail.check_count, 1);
  assert.equal((await client.get('/api/admin/scans')).body.items[0].checker_name, '(removed)');
});

test("their browser is asked for details again", async () => {
  await signIn(ADMIN);
  await client.post(`/api/admin/customers/${personId}/remove`, { reason: REASON });

  const portal = await client.get('/api/portal');
  assert.equal(portal.body.checker, null);
  const check = await client.post('/api/verify', { code: codes[1] });
  assert.equal(check.status, 403);
  assert.equal(check.body.error.code, 'details_required');
});

test('the audit log records who, which record and why - never the details', async () => {
  await signIn(ADMIN);
  await client.post(`/api/admin/customers/${personId}/remove`, { reason: REASON });

  const entry = await db.findOne('auditLog', { action: 'customer.remove' });
  assert.equal(entry.actor_email, ADMIN.email);
  assert.equal(String(entry.entity_id), String(personId));
  assert.equal(JSON.parse(entry.detail_json).reason, REASON);
  for (const detail of PERSONAL) assert.ok(!entry.detail_json.includes(detail));
});

test('a reason is required, and nothing changes without one', async () => {
  await signIn(ADMIN);
  const res = await client.post(`/api/admin/customers/${personId}/remove`, {});
  assert.equal(res.status, 422);
  assert.equal((await db.get('verifier', personId)).full_name, 'Maria Santos');
});

test('removing twice is refused', async () => {
  await signIn(ADMIN);
  await client.post(`/api/admin/customers/${personId}/remove`, { reason: REASON });
  const again = await client.post(`/api/admin/customers/${personId}/remove`, { reason: REASON });
  assert.equal(again.status, 409);
});

test('only an administrator can remove or correct', async () => {
  for (const user of [SECURITY, REGULATOR]) {
    await signIn(user);
    const removal = await client.post(`/api/admin/customers/${personId}/remove`, { reason: REASON });
    assert.equal(removal.status, 403, `${user.email} removed`);
    const correction = await client.patch(`/api/admin/customers/${personId}`, { city: 'Makati', reason: REASON });
    assert.equal(correction.status, 403, `${user.email} corrected`);
  }
  const person = await db.get('verifier', personId);
  assert.equal(person.full_name, 'Maria Santos');
  assert.equal(person.city, 'Quezon City');
});

test('a correction changes only what is sent, checked like the portal form', async () => {
  await signIn(ADMIN);
  const res = await client.patch(`/api/admin/customers/${personId}`, {
    phone: '0918 765 4321',
    city: '',
    reason: 'The person called to give a new mobile number.',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const person = await db.get('verifier', personId);
  assert.equal(person.phone, '+639187654321', 'stored the way the portal stores it');
  assert.equal(person.city ?? null, null, 'an empty city clears it');
  assert.equal(person.full_name, 'Maria Santos', 'untouched');
  assert.equal(person.email, 'maria@gmail.com', 'untouched');

  const entry = await db.findOne('auditLog', { action: 'customer.update' });
  assert.deepEqual(JSON.parse(entry.detail_json).fields.sort(), ['city', 'phone']);
  assert.ok(!entry.detail_json.includes('0918') && !entry.detail_json.includes('+639187654321'), 'no values logged');
});

test('a correction cannot store what the portal form would refuse', async () => {
  await signIn(ADMIN);
  const cases = [
    { phone: '02 8123 4567' },
    { email: 'not-an-email' },
    { fullName: '   ' },
    { city: 'Makati' }, // no reason
  ];
  for (const body of cases) {
    const res = await client.patch(`/api/admin/customers/${personId}`, {
      ...body,
      ...(body.city ? {} : { reason: 'Correction requested by the person.' }),
    });
    assert.equal(res.status, 422, JSON.stringify(body));
  }
  const person = await db.get('verifier', personId);
  assert.equal(person.phone, '+639171234567');
  assert.equal(person.city, 'Quezon City');
});

test('removed details cannot be corrected back in', async () => {
  await signIn(ADMIN);
  await client.post(`/api/admin/customers/${personId}/remove`, { reason: REASON });
  const res = await client.patch(`/api/admin/customers/${personId}`, {
    fullName: 'Maria Santos',
    reason: 'Trying to restore it.',
  });
  assert.equal(res.status, 409);
});
