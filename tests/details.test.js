/**
 * Who is checking: the details the portal asks for before it will check a pack.
 *
 * The gate is enforced by the server, not the page - a request straight at
 * /api/verify with no details is refused - and every check made afterwards is
 * recorded against the person. The security team sees the people; a
 * regulator, who has no scans:read, does not. And staff can switch the
 * question off without a deploy.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits, giveDetails, DETAILS } from './helpers.js';
import * as db from '../src/db/index.js';
import { normalizePhone } from '../src/services/verifiers.js';

let client;
let codes;

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const SECURITY = { email: 'security@test.local', password: 'SecurityPass!2026' };
const REGULATOR = { email: 'regulator@test.local', password: 'RegulatorPass!2026' };

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  codes = (await seedBasics()).codes;
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  await seedUser({ ...SECURITY, role: 'security', name: 'Sam Security' });
  await seedUser({ ...REGULATOR, role: 'regulator', name: 'Rita Regulator' });
  client.clearCookies();
  await resetRateLimits();
});

const lastScan = () => db.findOne('scan', {}, { order: 'id desc' });

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a check is refused until the person says who they are', async () => {
  const single = await client.post('/api/verify', { code: codes[0] });
  assert.equal(single.status, 403);
  assert.equal(single.body.error.code, 'details_required');

  const deepLink = await client.get(`/api/verify/${encodeURIComponent(codes[0])}`);
  assert.equal(deepLink.status, 403);

  const bulk = await client.post('/api/verify/bulk', { codes: [codes[0], codes[1]] });
  assert.equal(bulk.status, 403);

  assert.equal(await db.count('scan'), 0, 'nothing was checked or logged');
});

test('giving details unlocks checking, and every check is recorded against the person', async () => {
  const given = await giveDetails(client);
  assert.equal(given.status, 201);
  assert.deepEqual(given.body.checker, {
    name: 'Maria Santos',
    phone: '+639171234567',
    email: 'maria@gmail.com',
    role: 'patient',
    roleLabel: 'Patient',
    city: 'Quezon City',
  });
  assert.equal(given.body.token, undefined, 'the token travels only in the cookie');

  const res = await client.post('/api/verify', { code: codes[0] });
  assert.equal(res.status, 200);
  assert.equal(res.body.result, 'genuine');

  assert.equal((await lastScan()).verifier_id, 1);

  const person = await db.get('verifier', 1);
  assert.equal(person.check_count, 1);
  assert.ok(person.last_check_at, 'the last check is timestamped');
  assert.ok(person.consent_at, 'consent is recorded, not assumed');
  assert.equal(person.policy_version, '2026-09-25', 'and which notice was agreed to');

  const portal = await client.get('/api/portal');
  assert.equal(portal.body.checker.name, 'Maria Santos', 'the portal knows who this browser is');
});

test('the form is validated as a whole, naming every bad field at once', async () => {
  const res = await giveDetails(client, {
    fullName: 'M',
    phone: '02 8123 4567', // a landline: the number is for SMS
    email: 'not-an-address',
    role: 'alien',
    consent: false,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'validation_failed');

  const fields = res.body.error.details.map((d) => d.field).sort();
  assert.deepEqual(fields, ['consent', 'email', 'fullName', 'phone', 'role']);
  assert.equal(await db.count('verifier'), 0);
});

test('a missing consent box is refused, not defaulted', async () => {
  const { consent, ...withoutConsent } = DETAILS;
  const res = await client.post('/api/portal/details', withoutConsent);
  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d) => d.field === 'consent'));
});

test('mobile numbers are accepted the way people type them, and normalised', () => {
  assert.equal(normalizePhone('0917 123 4567'), '+639171234567');
  assert.equal(normalizePhone('0917-123-4567'), '+639171234567');
  assert.equal(normalizePhone('63 917 123 4567'), '+639171234567');
  assert.equal(normalizePhone('+63 (917) 123 4567'), '+639171234567');
  assert.equal(normalizePhone('+44 7700 900123'), '+447700900123');
  assert.equal(normalizePhone('8123 4567'), null, 'a landline is not a mobile');
  assert.equal(normalizePhone('0917 123'), null, 'too short');
  assert.equal(normalizePhone(''), null);
});

test('the cookie is httpOnly and only a digest of the token is stored', async () => {
  const res = await giveDetails(client);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('qrs_checker='));
  assert.ok(setCookie, 'a checker cookie is set');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);

  const token = setCookie.split(';')[0].split('=')[1];
  const stored = await db.get('verifier', 1);
  assert.notEqual(stored.token_hash, token, 'the raw token is never written to the store');
  assert.notEqual(stored.token_hash, decodeURIComponent(token));
});

test('"not you?" forgets this browser, and the question is asked again', async () => {
  await giveDetails(client);
  assert.equal((await client.post('/api/verify', { code: codes[0] })).status, 200);

  const forget = await client.request('/api/portal/details', { method: 'DELETE' });
  assert.equal(forget.status, 204);

  const again = await client.post('/api/verify', { code: codes[1] });
  assert.equal(again.status, 403);
  assert.equal(again.body.error.code, 'details_required');
});

test('giving details is rate limited, so the store cannot be filled with junk', async () => {
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const res = await giveDetails(client);
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  assert.ok(limited, 'a stream of registrations from one source is refused');
});

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

test('staff can switch the question off, and checking becomes anonymous again', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const changed = await client.patch('/api/admin/settings/portal.require_details', { value: 'off' });
  assert.equal(changed.status, 200);
  client.clearCookies();

  const portal = await client.get('/api/portal');
  assert.equal(portal.body.detailsRequired, false);

  const res = await client.post('/api/verify', { code: codes[0] });
  assert.equal(res.status, 200, 'no details, no gate');
  assert.equal((await lastScan()).verifier_id, null);
});

test('with the question off, a browser that did give details is still recorded', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  await client.patch('/api/admin/settings/portal.require_details', { value: 'off' });
  client.clearCookies();

  await giveDetails(client);
  await client.post('/api/verify', { code: codes[0] });
  assert.equal((await lastScan()).verifier_id, 1);
});

test('the setting takes only on or off', async () => {
  await client.login(ADMIN.email, ADMIN.password);
  const res = await client.patch('/api/admin/settings/portal.require_details', { value: 'maybe' });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Who sees the people
// ---------------------------------------------------------------------------

test('the security team sees the people and their checks; a regulator does not', async () => {
  await giveDetails(client);
  await client.post('/api/verify', { code: codes[0] }, { fromIp: '198.51.100.7' });
  // The same pack from another device: flagged, and still this person's check.
  await client.post('/api/verify', { code: codes[0] }, { fromIp: '203.0.113.20' });

  await client.login(SECURITY.email, SECURITY.password);

  const list = await client.get('/api/admin/customers');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  const [person] = list.body.items;
  assert.equal(person.full_name, 'Maria Santos');
  assert.equal(person.phone, '+639171234567');
  assert.equal(person.email, 'maria@gmail.com');
  assert.equal(person.check_count, 2);
  assert.equal(person.flagged_count, 1);
  assert.equal(person.token_hash, undefined, 'the credential is never listed');
  assert.equal(person.ip_hash, undefined);

  // A number as people type it, a start of the name, part of an email.
  const byPhone = await client.get('/api/admin/customers?search=0917%20123%204567');
  assert.equal(byPhone.body.total, 1, 'by the typed mobile number');
  const byPrefix = await client.get('/api/admin/customers?search=0917');
  assert.equal(byPrefix.body.total, 1, 'by the start of the number');
  const byName = await client.get('/api/admin/customers?search=mar');
  assert.equal(byName.body.total, 1, 'by the start of the name');
  const byEmail = await client.get('/api/admin/customers?search=MARIA@gmail');
  assert.equal(byEmail.body.total, 1, 'by the email, whatever the case');
  const nobody = await client.get('/api/admin/customers?search=juan');
  assert.equal(nobody.body.total, 0);

  const detail = await client.get(`/api/admin/customers/${person.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.scans.length, 2);
  assert.deepEqual(
    detail.body.scans.map((s) => s.result).sort(),
    ['flagged', 'genuine']
  );
  assert.equal(detail.body.token_hash, undefined);

  const scans = await client.get('/api/admin/scans');
  assert.equal(scans.body.items[0].checker_name, 'Maria Santos', 'the scan log names the checker');

  const csv = await client.get('/api/admin/customers.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.body, /maria@gmail\.com/);
  assert.equal(await db.count('auditLog', { action: 'customers.export' }), 1);

  client.clearCookies();
  await client.login(REGULATOR.email, REGULATOR.password);
  assert.equal((await client.get('/api/admin/customers')).status, 403);
  assert.equal((await client.get(`/api/admin/customers/${person.id}`)).status, 403);
  assert.equal((await client.get('/api/admin/customers.csv')).status, 403);
});

test('the people list can be filtered by who they are', async () => {
  await giveDetails(client);
  client.clearCookies();
  await giveDetails(client, { fullName: 'Jose Reyes', phone: '0918 555 0101', email: 'jose@pharmacy.ph', role: 'pharmacist' });

  await client.login(SECURITY.email, SECURITY.password);
  const pharmacists = await client.get('/api/admin/customers?role=pharmacist');
  assert.equal(pharmacists.body.total, 1);
  assert.equal(pharmacists.body.items[0].full_name, 'Jose Reyes');
  assert.equal((await client.get('/api/admin/customers')).body.total, 2);
});
