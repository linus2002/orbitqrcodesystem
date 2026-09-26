/**
 * Shipments are switched off (SHIPMENTS_ENABLED in services/auth.js).
 *
 * Two halves. While switched off: no role - not even admin - can list,
 * create or receive a shipment, a batch's detail lists none, no one is told
 * they hold a shipments permission (which is what hides the menu entry), and
 * the shipments already stored are left exactly as they were.
 *
 * Switched back on: the routes still work, with the access each role had
 * before. That half is what keeps the unused code honest - if a later change
 * breaks it, this file says so now, not on the day someone switches
 * shipments back on.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';
import { PERMISSIONS } from '../src/services/auth.js';

let client;
let batchId;

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const SECURITY = { email: 'security@test.local', password: 'SecurityPass!2026' };
const REGULATOR = { email: 'regulator@test.local', password: 'RegulatorPass!2026' };

const SHIPMENT_PERMISSIONS = ['shipments:read', 'shipments:write'];

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  ({ batchId } = await seedBasics({ quantity: 6 }));
  await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
  await seedUser({ ...SECURITY, role: 'security', name: 'Sam Security' });
  await seedUser({ ...REGULATOR, role: 'regulator', name: 'Rita Regulator' });
  // A shipment recorded before the switch, which must survive it untouched.
  await db.insert('shipment', {
    reference: 'SHP-T1', batch_id: batchId, quantity: 6, from_site: 'Plant 1', to_name: 'Mercury Drug Makati',
  });
  client.clearCookies();
  await resetRateLimits();
});

/** Sign in as someone else, from a clean browser. */
async function signInAs(user) {
  client.clearCookies();
  assert.equal((await client.login(user.email, user.password)).status, 200);
}

const newShipment = () => ({
  batchId, reference: 'SHP-T2', quantity: 3, fromSite: 'Plant 1', toName: 'Watsons Cebu', toType: 'pharmacy',
});

/** Grant shipments as they were before the switch, for the length of `fn`. */
async function switchedOn(fn) {
  const granted = {
    admin: SHIPMENT_PERMISSIONS,
    security: SHIPMENT_PERMISSIONS,
    regulator: ['shipments:read'],
  };
  const saved = Object.fromEntries(Object.keys(granted).map((role) => [role, [...PERMISSIONS[role]]]));
  for (const [role, perms] of Object.entries(granted)) PERMISSIONS[role].push(...perms);
  try {
    await fn();
  } finally {
    for (const [role, perms] of Object.entries(saved)) {
      PERMISSIONS[role].splice(0, PERMISSIONS[role].length, ...perms);
    }
  }
}

// ---------------------------------------------------------------------------
// Switched off
// ---------------------------------------------------------------------------

test('no role can list, create or receive a shipment', async () => {
  for (const user of [ADMIN, SECURITY, REGULATOR]) {
    await signInAs(user);
    assert.equal((await client.get('/api/admin/shipments')).status, 403, `${user.email} listed shipments`);
    assert.equal((await client.post('/api/admin/shipments', newShipment())).status, 403, `${user.email} created one`);
    assert.equal((await client.patch('/api/admin/shipments/1/receive', {})).status, 403, `${user.email} received one`);
  }

  // The stored shipment is exactly as it was, and nothing was recorded.
  assert.equal(await db.count('shipment'), 1);
  assert.equal((await db.findOne('shipment', { reference: 'SHP-T1' })).status, 'in_transit');
  const actions = (await db.findMany('auditLog', {})).map((a) => a.action);
  assert.ok(!actions.some((a) => a.startsWith('shipment.')), actions.join(', '));
});

test('a batch detail lists no shipments, and is otherwise unchanged', async () => {
  await signInAs(ADMIN);
  const res = await client.get(`/api/admin/batches/${batchId}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.shipments, []);
  assert.equal(res.body.batch_number, 'AMX25-T1');
  assert.ok(res.body.stats, 'the code stats are still there');
});

test('no one is told they hold a shipments permission, so the menu entry never shows', async () => {
  for (const [role, perms] of Object.entries(PERMISSIONS)) {
    for (const p of SHIPMENT_PERMISSIONS) assert.ok(!perms.includes(p), `${role} holds ${p}`);
  }
  for (const user of [ADMIN, SECURITY, REGULATOR]) {
    await signInAs(user);
    const { permissions } = (await client.get('/api/auth/me')).body.user;
    assert.ok(!permissions.some((p) => p.startsWith('shipments:')), `${user.email}: ${permissions}`);
  }
});

// ---------------------------------------------------------------------------
// Switched back on
// ---------------------------------------------------------------------------

test('switched back on, an admin can list, create and receive shipments', async () => {
  await switchedOn(async () => {
    await signInAs(ADMIN);

    const list = await client.get('/api/admin/shipments');
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].batch_number, 'AMX25-T1');

    const created = await client.post('/api/admin/shipments', newShipment());
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const received = await client.patch(`/api/admin/shipments/${created.body.id}/receive`, {});
    assert.equal(received.status, 200);
    assert.equal(received.body.status, 'received');

    const detail = await client.get(`/api/admin/batches/${batchId}`);
    assert.deepEqual(detail.body.shipments.map((s) => s.reference).sort(), ['SHP-T1', 'SHP-T2']);

    const { permissions } = (await client.get('/api/auth/me')).body.user;
    assert.ok(permissions.includes('shipments:read'), 'the menu entry would show again');
  });
});

test('switched back on, security can change shipments and a regulator can only see them', async () => {
  await switchedOn(async () => {
    await signInAs(SECURITY);
    assert.equal((await client.post('/api/admin/shipments', newShipment())).status, 201);

    await signInAs(REGULATOR);
    assert.equal((await client.get('/api/admin/shipments')).status, 200);
    assert.equal((await client.patch('/api/admin/shipments/1/receive', {})).status, 403);
    assert.equal((await client.post('/api/admin/shipments', { ...newShipment(), reference: 'SHP-T3' })).status, 403);
  });
});
