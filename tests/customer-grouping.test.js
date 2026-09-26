/**
 * One person, however many browsers they gave their details from.
 *
 * The details cookie belongs to a browser, so the same person opening a
 * link in Messenger, Viber or another browser gives their details again and
 * gets another record. Customers shows them as one person - matched on
 * mobile AND email, since a family often shares one phone - with their
 * checks combined, and removing or correcting a person covers every record.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const REASON = 'The person asked by phone on 26 Sept for their details to be removed.';

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
  await resetRateLimits();
});

/** A fresh browser: gives details, checks a pack. Returns its cookie jar's person id. */
async function browser(details, code, ip) {
  client.clearCookies();
  await giveDetails(client, details);
  await client.post('/api/verify', { code }, { fromIp: ip });
  return (await db.findOne('verifier', {}, { order: 'id desc' })).id;
}

async function asAdmin() {
  client.clearCookies();
  await client.login(ADMIN.email, ADMIN.password);
}

test('the same mobile and email from two browsers is one person, with their checks combined', async () => {
  await browser({ fullName: 'Maria Santos' }, codes[0], '198.51.100.1');
  const newest = await browser({ fullName: 'Maria S.' }, codes[1], '198.51.100.2');
  await asAdmin();

  const list = (await client.get('/api/admin/customers')).body;
  assert.equal(list.total, 1);
  const [person] = list.items;
  assert.equal(person.id, newest, 'the newest record stands for them');
  assert.equal(person.full_name, 'Maria S.');
  assert.equal(person.browsers, 2);
  assert.equal(person.check_count, 2);

  const detail = (await client.get(`/api/admin/customers/${person.id}`)).body;
  assert.equal(detail.browsers, 2);
  assert.equal(detail.check_count, 2);
  assert.equal(detail.scans.length, 2, 'checks from both browsers');

  const csv = (await client.get('/api/admin/customers.csv')).body.trim().split('\n');
  assert.equal(csv.length, 2, 'a header and one person');
  assert.ok(csv[0].endsWith(',browsers'));
  assert.ok(csv[1].endsWith(',2'));
});

test('a family sharing one phone stays two people', async () => {
  await browser({ fullName: 'Maria Santos', email: 'maria@gmail.com' }, codes[0], '198.51.100.1');
  await browser({ fullName: 'Jose Santos', email: 'jose@gmail.com' }, codes[1], '198.51.100.2');
  await asAdmin();

  const list = (await client.get('/api/admin/customers')).body;
  assert.equal(list.total, 2);
  assert.deepEqual(list.items.map((p) => p.browsers), [1, 1]);
});

test('removing a person removes them from every browser they used', async () => {
  const first = await browser({}, codes[0], '198.51.100.1');
  const second = await browser({}, codes[1], '198.51.100.2');
  await asAdmin();

  const res = await client.post(`/api/admin/customers/${second}/remove`, { reason: REASON });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  for (const id of [first, second]) {
    const person = await db.get('verifier', id);
    assert.equal(person.phone, '(removed)', `record ${id}`);
    assert.equal(person.email, '(removed)', `record ${id}`);
  }
  const entry = await db.findOne('auditLog', { action: 'customer.remove' });
  assert.equal(JSON.parse(entry.detail_json).records, 2);
});

test('a correction reaches every browser, so the person stays one', async () => {
  const first = await browser({}, codes[0], '198.51.100.1');
  const second = await browser({}, codes[1], '198.51.100.2');
  await asAdmin();

  const res = await client.patch(`/api/admin/customers/${second}`, {
    email: 'maria.santos@example.com',
    reason: 'The person gave a new email address.',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  for (const id of [first, second]) {
    assert.equal((await db.get('verifier', id)).email, 'maria.santos@example.com', `record ${id}`);
  }
  const list = (await client.get('/api/admin/customers')).body;
  assert.equal(list.total, 1);
  assert.equal(list.items[0].browsers, 2);
});

test('removed people are never grouped together', async () => {
  const maria = await browser({ fullName: 'Maria Santos', phone: '0917 111 1111', email: 'maria@gmail.com' }, codes[0], '198.51.100.1');
  const jose = await browser({ fullName: 'Jose Reyes', phone: '0918 222 2222', email: 'jose@gmail.com' }, codes[1], '198.51.100.2');
  await asAdmin();
  await client.post(`/api/admin/customers/${maria}/remove`, { reason: REASON });
  await client.post(`/api/admin/customers/${jose}/remove`, { reason: REASON });

  const list = (await client.get('/api/admin/customers')).body;
  assert.equal(list.total, 2);
  assert.deepEqual(list.items.map((p) => p.full_name), ['(removed)', '(removed)']);
});
