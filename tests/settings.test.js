/**
 * Settings that take effect.
 *
 * Until now the settings table had no readers and accepted any key. The
 * properties that matter most:
 *   - the default duplicate threshold behaves EXACTLY like the old rule, so
 *     nothing changes unless someone raises it;
 *   - the threshold cannot leave 1-3, and every change is audited from/to;
 *   - an unknown key cannot be written;
 *   - a corrupted stored value falls back to the safe default.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';

let client;
let codes;

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const SECURITY = { email: 'security@test.local', password: 'SecurityPass!2026' };

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
  await seedUser({ ...SECURITY, role: 'security', name: 'Sam Security' });
  client.clearCookies();
  await resetRateLimits();
});

/** Store a raw value, bypassing validation - as a hand edit would. */
async function storeRaw(key, value) {
  if (await db.get('setting', key)) await db.update('setting', key, { value });
  else await db.insert('setting', { key, value });
}

const setThreshold = (n) => storeRaw('alerts.duplicate_threshold', String(n));

/** Verify one code from several distinct devices; return each result. */
async function fromDevices(code, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const res = await client.post('/api/verify', { code }, { fromIp: `198.51.100.${10 + i}` });
    out.push(res.body.result);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The duplicate threshold
// ---------------------------------------------------------------------------

test('with no setting stored, a second device is flagged - exactly the old rule', async () => {
  assert.deepEqual(await fromDevices(codes[0], 2), ['genuine', 'flagged']);
});

test('threshold 1 is the same as no setting', async () => {
  await setThreshold(1);
  assert.deepEqual(await fromDevices(codes[1], 2), ['genuine', 'flagged']);
});

test('threshold 2 lets a second device through and flags the third', async () => {
  await setThreshold(2);
  assert.deepEqual(await fromDevices(codes[2], 3), ['genuine', 'genuine', 'flagged']);
});

test('the same device re-checking inside the grace window stays genuine at any threshold', async () => {
  await setThreshold(1);
  const first = await client.post('/api/verify', { code: codes[3] }, { fromIp: '198.51.100.50' });
  const again = await client.post('/api/verify', { code: codes[3] }, { fromIp: '198.51.100.50' });
  assert.equal(first.body.result, 'genuine');
  assert.equal(again.body.result, 'genuine');
});

test('a corrupted stored threshold falls back to 1, never to "no limit"', async () => {
  await storeRaw('alerts.duplicate_threshold', 'lots');
  assert.deepEqual(await fromDevices(codes[4], 2), ['genuine', 'flagged']);
});

test('a stored threshold above the range is not trusted either', async () => {
  await storeRaw('alerts.duplicate_threshold', '50');
  assert.deepEqual(await fromDevices(codes[5], 2), ['genuine', 'flagged']);
});

// ---------------------------------------------------------------------------
// Changing settings
// ---------------------------------------------------------------------------

test('the threshold can be changed within 1-3, and the change is audited from and to', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.patch('/api/admin/settings/alerts.duplicate_threshold', { value: '2' });

  assert.equal(res.status, 200);
  assert.equal(res.body.value, '2');
  const entry = await db.findOne('auditLog', { action: 'settings.update' }, { order: 'id desc' });
  assert.equal(entry.actor_email, ADMIN.email);
  assert.equal(entry.entity_id, 'alerts.duplicate_threshold');
  assert.deepEqual(JSON.parse(entry.detail_json), { from: 1, to: 2 });
});

test('the threshold cannot be set outside 1-3 or to a non-number', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  for (const value of ['0', '4', '10', '1.5', 'two', '']) {
    const res = await client.patch('/api/admin/settings/alerts.duplicate_threshold', { value });
    assert.equal(res.status, 400, `"${value}" must be refused`);
  }
  assert.equal(await db.count('setting', { key: 'alerts.duplicate_threshold' }), 0);
});

test('an unknown key cannot be written', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.patch('/api/admin/settings/anything.at_all', { value: 'x' });

  assert.equal(res.status, 400);
  assert.equal(await db.count('setting', { key: 'anything.at_all' }), 0);
});

test('a missing value is refused, but an empty notice is allowed - it hides the notice', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  const missing = await client.patch('/api/admin/settings/portal.banner', {});
  assert.equal(missing.status, 400);

  await client.patch('/api/admin/settings/portal.banner', { value: 'Batch AMX25-2608A recalled.' });
  const cleared = await client.patch('/api/admin/settings/portal.banner', { value: '' });
  assert.equal(cleared.status, 200);
  assert.equal((await client.get('/api/portal')).body.banner, '');
});

test('the other settings validate their own shape', async () => {
  await client.login(ADMIN.email, ADMIN.password);

  const long = await client.patch('/api/admin/settings/portal.banner', { value: 'x'.repeat(201) });
  const badPhone = await client.patch('/api/admin/settings/support.phone', { value: '<script>' });
  const vanity = await client.patch('/api/admin/settings/support.phone', { value: '+234 800 QRSHIELD' });
  const badCode = await client.patch('/api/admin/settings/support.sms_shortcode', { value: '12ab' });
  const goodCode = await client.patch('/api/admin/settings/support.sms_shortcode', { value: '45678' });

  assert.equal(long.status, 400);
  assert.equal(badPhone.status, 400);
  assert.equal(vanity.status, 200, 'vanity numbers stay valid');
  assert.equal(badCode.status, 400);
  assert.equal(goodCode.status, 200);
});

test('only an admin can change settings', async () => {
  await client.login(SECURITY.email, SECURITY.password);

  const res = await client.patch('/api/admin/settings/alerts.duplicate_threshold', { value: '3' });

  assert.equal(res.status, 403, 'settings:write is admin-only');
});

test('the Settings screen lists every defined setting and nothing else', async () => {
  await storeRaw('stray.key', 'x');
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.get('/api/admin/settings');

  assert.deepEqual(
    res.body.items.map((s) => s.key).sort(),
    ['alerts.duplicate_threshold', 'portal.banner', 'support.phone', 'support.sms_shortcode']
  );
  const threshold = res.body.items.find((s) => s.key === 'alerts.duplicate_threshold');
  assert.deepEqual([threshold.value, threshold.kind, threshold.min, threshold.max], ['1', 'int', 1, 3]);
});

// ---------------------------------------------------------------------------
// The public portal
// ---------------------------------------------------------------------------

test('the portal reads the notice, the support number and the shortcode, with safe defaults', async () => {
  const before = await client.get('/api/portal');
  assert.equal(before.status, 200);
  assert.deepEqual(before.body, { banner: '', supportPhone: '', smsShortcode: '32123' });

  await client.login(ADMIN.email, ADMIN.password);
  await client.patch('/api/admin/settings/portal.banner', { value: 'Batch AMX25-2608A recalled.' });
  await client.patch('/api/admin/settings/support.phone', { value: '+63 2 8123 4567' });
  client.clearCookies();

  const after = await client.get('/api/portal');
  assert.deepEqual(after.body, {
    banner: 'Batch AMX25-2608A recalled.',
    supportPhone: '+63 2 8123 4567',
    smsShortcode: '32123',
  });
});
