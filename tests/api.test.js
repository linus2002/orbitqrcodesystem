/**
 * HTTP integration tests.
 *
 * These drive a real server through the full middleware stack, so they cover
 * the things unit tests cannot: security headers, cookie flags, CSRF, the role
 * matrix as actually enforced by the router, and rate limiting.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';

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
  await giveDetails(client);
  await resetRateLimits();
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

test('health check reports the database state', async () => {
  const res = await client.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('a counterfeit is a 200 with a flagged body, not an HTTP error', async () => {
  await client.post('/api/verify', { code: codes[0] }, { fromIp: '198.51.100.7' });
  // A different person on a different device: nothing makes it a repeat.
  const res = await client.post('/api/verify', { code: codes[0] }, {
    fromIp: '203.0.113.20',
    person: await client.newPerson(),
  });

  assert.equal(res.status, 200, 'a detected fake is a successful verification');
  assert.equal(res.body.result, 'flagged');
});

test('verification requires a code and reports which field failed', async () => {
  const res = await client.post('/api/verify', {});
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'validation_failed');
  assert.equal(res.body.error.details[0].field, 'code');
});

test('the QR deep-link route verifies too', async () => {
  const res = await client.get(`/api/verify/${encodeURIComponent(codes[1])}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.result, 'genuine');
});

test('security headers are present on every response', async () => {
  const res = await client.get('/api/health');
  const csp = res.headers.get('content-security-policy');

  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.ok(!csp.includes("'unsafe-inline'"), 'no unsafe-inline anywhere in the CSP');
  assert.ok(!csp.includes("'unsafe-eval'"), 'no unsafe-eval anywhere in the CSP');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-powered-by'), null, 'the stack must not be advertised');
});

test('API responses are never cached by an intermediary', async () => {
  const res = await client.post('/api/verify', { code: codes[2] });
  assert.match(res.headers.get('cache-control'), /no-store/);
});

test('a patient report is accepted and returns a reference', async () => {
  const res = await client.post('/api/report', {
    code: codes[3],
    description: 'The foil seal was already broken when I bought this pack.',
    purchaseLocation: 'Roadside stall',
  });

  assert.equal(res.status, 201);
  assert.match(res.body.reference, /^RPT-\d{6}$/);
  assert.equal(await db.count('consumerReport'), 1);
  assert.equal(await db.count('alert', { type: 'consumer_report' }), 1);
  // The report and its alert are linked, in the one transaction that wrote both.
  const report = await db.findOne('consumerReport', {});
  assert.equal(report.alert_id, (await db.findOne('alert', { type: 'consumer_report' })).id);
});

test('a report needs a real description', async () => {
  const res = await client.post('/api/report', { description: 'bad' });
  assert.equal(res.status, 422);
});

test('verification is rate limited per source', async () => {
  let limited = false;
  for (let i = 0; i < 20; i++) {
    const res = await client.post('/api/verify', { code: 'AMX25-260921-00001-AA' });
    if (res.status === 429) {
      limited = true;
      assert.ok(res.headers.get('retry-after'), 'a 429 must say when to retry');
      break;
    }
  }
  assert.ok(limited, 'the endpoint must refuse sustained hammering');
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('sign-in sets an httpOnly, SameSite=Strict session cookie', async () => {
  const res = await client.post('/api/auth/login', ADMIN);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'admin');

  const setCookie = res.headers.getSetCookie().join(' ');
  assert.match(setCookie, /qrs_session=/);
  assert.match(setCookie, /HttpOnly/i, 'the session token must be unreadable from JavaScript');
  assert.match(setCookie, /SameSite=Strict/i);
});

test('a wrong password gives the same message as an unknown account', async () => {
  const wrongPassword = await client.post('/api/auth/login', { ...ADMIN, password: 'nope-not-it' });
  client.clearCookies();
  const unknownUser = await client.post('/api/auth/login', {
    email: 'nobody@test.local',
    password: 'nope-not-it',
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.equal(
    wrongPassword.body.error.message,
    unknownUser.body.error.message,
    'the response must not reveal whether an account exists'
  );
});

test('an unknown email takes as long to refuse as a wrong password', async () => {
  /** The fastest of three sign-ins: the least noisy measure of the work done. */
  const fastest = async (body) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const res = await client.post('/api/auth/login', body);
      best = Math.min(best, performance.now() - started);
      assert.equal(res.status, 401);
    }
    return best;
  };

  // Three failures, under the lockout threshold of five.
  const wrongPassword = await fastest({ ...ADMIN, password: 'nope-not-it' });
  const unknownUser = await fastest({ email: 'nobody@test.local', password: 'nope-not-it' });

  // Both pay for one password hash (~100ms). Without it an unknown email is
  // answered in a few milliseconds, a gap far wider than this margin.
  assert.ok(
    unknownUser >= wrongPassword * 0.5,
    `unknown email ${unknownUser.toFixed(1)}ms vs wrong password ${wrongPassword.toFixed(1)}ms`
  );
});

test('an account locks after repeated failures', async () => {
  for (let i = 0; i < 5; i++) {
    await client.post('/api/auth/login', { ...ADMIN, password: `wrong-${i}` });
  }
  const res = await client.post('/api/auth/login', ADMIN);
  assert.equal(res.status, 429, 'the correct password must not work while locked');
  assert.match(res.body.error.message, /failed sign-in attempts/i);
});

test('anonymous callers cannot reach the admin API', async () => {
  const res = await client.get('/api/admin/overview');
  assert.equal(res.status, 401);
});

test('signing out revokes the session immediately', async () => {
  await client.post('/api/auth/login', ADMIN);
  assert.equal((await client.get('/api/auth/me')).status, 200);

  await client.post('/api/auth/logout', {});
  const after = await client.get('/api/auth/me');
  assert.equal(after.status, 401);
});

test('a state-changing request without the CSRF token is refused', async () => {
  await client.post('/api/auth/login', ADMIN);

  const blocked = await client.postNoCsrf('/api/admin/products', {
    sku: 'CSRF1', name: 'Test', manufacturer: 'Test',
  });
  assert.equal(blocked.status, 403);

  // The same request with the token succeeds.
  const allowed = await client.post('/api/admin/products', {
    sku: 'CSRF1', name: 'Test', manufacturer: 'Test',
  });
  assert.equal(allowed.status, 201);
});

// ---------------------------------------------------------------------------
// Role-based access control
// ---------------------------------------------------------------------------

test('a regulator cannot read individual patient scans', async () => {
  await client.post('/api/auth/login', REGULATOR);

  for (const path of ['/api/admin/scans', '/api/admin/alerts', '/api/admin/users', '/api/admin/audit']) {
    const res = await client.get(path);
    assert.equal(res.status, 403, `${path} must be forbidden for a regulator`);
  }

  // But the aggregate compliance report is available.
  const compliance = await client.get('/api/admin/compliance');
  assert.equal(compliance.status, 200);
  assert.ok(compliance.body.serialization, 'the regulator gets aggregate figures');
  assert.ok(
    !JSON.stringify(compliance.body).includes('ip_hash'),
    'the compliance report must never carry scan-level identifiers'
  );
});

test('the security team can investigate but cannot manage users', async () => {
  await client.post('/api/auth/login', SECURITY);

  assert.equal((await client.get('/api/admin/scans')).status, 200);
  assert.equal((await client.get('/api/admin/alerts')).status, 200);
  assert.equal((await client.get('/api/admin/audit')).status, 200);
  assert.equal((await client.get('/api/admin/users')).status, 403);
});

test('an admin has the full surface', async () => {
  await client.post('/api/auth/login', ADMIN);
  for (const path of ['/api/admin/overview', '/api/admin/scans', '/api/admin/users', '/api/admin/audit']) {
    assert.equal((await client.get(path)).status, 200, path);
  }
});

// ---------------------------------------------------------------------------
// Batch lifecycle
// ---------------------------------------------------------------------------

test('the batch lifecycle is enforced, and codes are issued only once', async () => {
  await client.post('/api/auth/login', ADMIN);

  const created = await client.post('/api/admin/batches', {
    productId: 1,
    batchNumber: 'AMX25-NEW1',
    mfgDate: '2026-09-01',
    expiryDate: '2028-09-01',
    quantity: 25,
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  // Cannot skip straight to released.
  const skip = await client.post(`/api/admin/batches/${id}/transition`, { to: 'released' });
  assert.equal(skip.status, 409, 'a planned batch cannot jump to released');

  const issued = await client.post(`/api/admin/batches/${id}/issue-codes`, {});
  assert.equal(issued.status, 201);
  assert.equal(issued.body.issued, 25);

  // Re-issuing must be refused: the first set may already be printed.
  const again = await client.post(`/api/admin/batches/${id}/issue-codes`, {});
  assert.equal(again.status, 409);

  assert.equal((await client.post(`/api/admin/batches/${id}/transition`, { to: 'printed' })).status, 200);
  assert.equal((await client.post(`/api/admin/batches/${id}/transition`, { to: 'released' })).status, 200);
});

test('a recall requires a reason', async () => {
  await client.post('/api/auth/login', ADMIN);
  const res = await client.post('/api/admin/batches/1/transition', { to: 'recalled' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /reason/i);
});

test('the code export is valid CSV with one row per unit', async () => {
  await client.post('/api/auth/login', ADMIN);
  const res = await client.get('/api/admin/batches/1/codes.csv');

  assert.equal(res.status, 200);
  const lines = res.body.trim().split('\n');
  assert.equal(lines.length, 41, 'a header plus 40 unit rows');
  assert.match(lines[0], /^unit_index,code,serial,qr_payload/);
});

test('closing an alert requires an explanatory note', async () => {
  await client.post('/api/verify', { code: codes[5] }, { fromIp: '198.51.100.30' });
  // A second person checking the same code is a genuine duplicate, so this
  // raises the alert the test then works through.
  await client.post('/api/verify', { code: codes[5] }, {
    fromIp: '203.0.113.30',
    person: await client.newPerson(),
  });
  await client.post('/api/auth/login', ADMIN);

  const alerts = await client.get('/api/admin/alerts');
  const alertId = alerts.body.items[0].id;

  const noNote = await client.patch(`/api/admin/alerts/${alertId}`, { status: 'resolved' });
  assert.equal(noNote.status, 400);

  const withNote = await client.patch(`/api/admin/alerts/${alertId}`, {
    status: 'resolved',
    note: 'Confirmed a cloned pack; distributor notified.',
  });
  assert.equal(withNote.status, 200);
  assert.equal(withNote.body.status, 'resolved');
});

test('admin actions are written to the audit log', async () => {
  await client.post('/api/auth/login', ADMIN);
  await client.post('/api/admin/products', { sku: 'AUD1', name: 'Audited', manufacturer: 'X' });

  const audit = await client.get('/api/admin/audit');
  const actions = audit.body.items.map((a) => a.action);
  assert.ok(actions.includes('product.create'));
  assert.ok(actions.includes('auth.login'));
});

// ---------------------------------------------------------------------------
// SMS fallback
// ---------------------------------------------------------------------------

test('the SMS webhook verifies a code and replies in plain words', async () => {
  const res = await client.post('/api/sms/inbound?key=test-webhook-secret', {
    from: '+2348012345678',
    body: `CHECK ${codes[7]}`,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.result, 'genuine');
  assert.match(res.body.reply, /GENUINE/);
  assert.equal(await db.count('scan', { channel: 'sms' }), 1);
});

test('the SMS webhook rejects a wrong shared secret', async () => {
  const res = await client.post('/api/sms/inbound?key=not-the-secret', {
    from: '+2348012345678',
    body: codes[8],
  });
  assert.equal(res.status, 403);
});

test('an SMS reply fits inside two message segments', async () => {
  const res = await client.post('/api/sms/inbound?key=test-webhook-secret', {
    from: '+2348011111111',
    body: codes[9],
  });
  assert.ok(res.body.reply.length <= 320, `reply was ${res.body.reply.length} characters`);
});

test('phone numbers are never stored in the clear', async () => {
  await client.post('/api/sms/inbound?key=test-webhook-secret', {
    from: '+2348099999999',
    body: codes[10],
  });

  const rows = await db.findMany('smsLog', {}, { fields: ['msisdn_hash'] });
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(!String(r.msisdn_hash).includes('2348099999999'), 'the raw number must not be stored');
    assert.match(String(r.msisdn_hash), /^[0-9a-f]{32}$/, 'it is stored as a keyed digest');
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test('an unknown API route returns a JSON 404', async () => {
  const res = await client.get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found');
});

test('malformed JSON is rejected cleanly', async () => {
  const res = await fetch(`${client.base}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'bad_request');
});
