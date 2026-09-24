/**
 * Closing an alert by acting on its code: "resolve as false positive" and
 * "void this code".
 *
 * The properties that matter most:
 *   - clearing a flag changes nothing a patient sees: a second device scanning
 *     afterwards is flagged again by the duplicate rule, as before;
 *   - a recall always wins, and a voided code cannot be cleared;
 *   - the evidence (counters, scan history) is never rewritten;
 *   - both the code change and the alert resolution happen together, with
 *     who and why on record;
 *   - only admin and security can do either.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';
import * as serialization from '../src/services/serialization.js';

let client;
let codes;

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const SECURITY = { email: 'security@test.local', password: 'SecurityPass!2026' };
const REGULATOR = { email: 'regulator@test.local', password: 'RegulatorPass!2026' };
const REASON = 'Same patient re-checked on a second phone; confirmed by call.';

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
  await seedUser({ ...REGULATOR, role: 'regulator', name: 'Rita Regulator' });
  client.clearCookies();
  await resetRateLimits();
});

/** Verify from one device, then another: a duplicate_scan alert and a flagged code. */
async function duplicate(code) {
  await client.post('/api/verify', { code }, { fromIp: '198.51.100.7' });
  await client.post('/api/verify', { code }, { fromIp: '203.0.113.20' });
  const row = await db.get('SELECT * FROM codes WHERE code = ?', [code]);
  const alert = await db.get(`SELECT * FROM alerts WHERE code_id = ? AND type = 'duplicate_scan'`, [row.id]);
  return { row, alert };
}

const codeRow = (id) => db.get('SELECT * FROM codes WHERE id = ?', [id]);

// ---------------------------------------------------------------------------
// False positive
// ---------------------------------------------------------------------------

test('a false positive clears the flag to verified and resolves the alert', async () => {
  const { row, alert } = await duplicate(codes[0]);
  assert.equal(row.status, 'flagged');
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.post(`/api/admin/alerts/${alert.id}/false-positive`, { reason: REASON });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.codeStatus, { from: 'flagged', to: 'verified' });
  assert.equal((await codeRow(row.id)).status, 'verified');
  const closed = await db.get('SELECT * FROM alerts WHERE id = ?', [alert.id]);
  assert.equal(closed.status, 'resolved');
  assert.equal(closed.resolution_note, `False positive: ${REASON}`);
});

test('the counters and scan history are left exactly as they were', async () => {
  const { row, alert } = await duplicate(codes[1]);
  const scansBefore = await db.scalar('SELECT COUNT(*) FROM scans WHERE code_id = ?', [row.id]);
  await client.login(ADMIN.email, ADMIN.password);

  await client.post(`/api/admin/alerts/${alert.id}/false-positive`, { reason: REASON });

  const after = await codeRow(row.id);
  assert.equal(after.scan_count, row.scan_count);
  assert.equal(after.verified_count, row.verified_count);
  assert.equal(after.flagged_at, row.flagged_at, 'when it was flagged stays on record');
  assert.equal(await db.scalar('SELECT COUNT(*) FROM scans WHERE code_id = ?', [row.id]), scansBefore);
});

test('after clearing, a scan from yet another device is flagged again', async () => {
  const { row, alert } = await duplicate(codes[2]);
  await client.login(ADMIN.email, ADMIN.password);
  await client.post(`/api/admin/alerts/${alert.id}/false-positive`, { reason: REASON });

  const res = await client.post('/api/verify', { code: codes[2] }, { fromIp: '192.0.2.99' });

  assert.equal(res.body.result, 'flagged', 'clearing the label never weakens detection');
  assert.equal((await codeRow(row.id)).status, 'flagged');
});

test('a code in a recalled batch stays recalled', async () => {
  const { row, alert } = await duplicate(codes[3]);
  await serialization.transition(1, 'recalled', { reason: 'Contamination found at the plant.' });
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.post(`/api/admin/alerts/${alert.id}/false-positive`, { reason: REASON });

  assert.equal(res.status, 200);
  // Recall skips rows already flagged; clearing the flag must land on recalled.
  assert.equal(res.body.codeStatus.to, 'recalled');
  assert.equal((await codeRow(row.id)).status, 'recalled');
});

test('a code never verified goes back to what its batch implies, not to verified', async () => {
  // Flag a code directly, as if it had been flagged before any genuine check.
  const row = await db.get('SELECT * FROM codes WHERE code = ?', [codes[4]]);
  await db.run(`UPDATE codes SET status = 'flagged' WHERE id = ?`, [row.id]);
  const { lastInsertRowid } = await db.run(
    `INSERT INTO alerts (type, severity, status, title, code_id) VALUES ('batch_anomaly', 'medium', 'open', 'Test', ?)`,
    [row.id]
  );
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.post(`/api/admin/alerts/${lastInsertRowid}/false-positive`, { reason: REASON });

  assert.equal(res.body.codeStatus.to, 'released', 'the batch is released; nothing was verified');
});

test('a voided code cannot be cleared', async () => {
  const { row, alert } = await duplicate(codes[5]);
  await db.run(`UPDATE codes SET status = 'void' WHERE id = ?`, [row.id]);
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.post(`/api/admin/alerts/${alert.id}/false-positive`, { reason: REASON });

  assert.equal(res.status, 409);
  assert.equal((await codeRow(row.id)).status, 'void');
  assert.equal((await db.get('SELECT status FROM alerts WHERE id = ?', [alert.id])).status, 'open');
});

test('a reason is required, and nothing changes without one', async () => {
  const { row, alert } = await duplicate(codes[0]);
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.post(`/api/admin/alerts/${alert.id}/false-positive`, { reason: 'ok' });

  assert.equal(res.status, 422);
  assert.equal((await codeRow(row.id)).status, 'flagged');
  assert.equal((await db.get('SELECT status FROM alerts WHERE id = ?', [alert.id])).status, 'open');
});

test('a closed alert cannot be acted on again', async () => {
  const { alert } = await duplicate(codes[1]);
  await client.login(ADMIN.email, ADMIN.password);
  await client.post(`/api/admin/alerts/${alert.id}/false-positive`, { reason: REASON });

  const again = await client.post(`/api/admin/alerts/${alert.id}/false-positive`, { reason: REASON });

  assert.equal(again.status, 409);
});

test('an alert with no code is refused', async () => {
  const { lastInsertRowid } = await db.run(
    `INSERT INTO alerts (type, severity, status, title) VALUES ('unknown_code', 'medium', 'open', 'Unknown code')`
  );
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.post(`/api/admin/alerts/${lastInsertRowid}/false-positive`, { reason: REASON });

  assert.equal(res.status, 400);
});

test('who and why are recorded, and the pack code is not', async () => {
  const { row, alert } = await duplicate(codes[2]);
  await client.login(SECURITY.email, SECURITY.password);

  await client.post(`/api/admin/alerts/${alert.id}/false-positive`, { reason: REASON });

  const unflag = await db.get(`SELECT * FROM audit_log WHERE action = 'code.unflag'`);
  assert.ok(unflag);
  assert.equal(unflag.actor_email, SECURITY.email, 'security may do this too');
  assert.equal(unflag.entity_id, String(row.id));
  const detail = JSON.parse(unflag.detail_json);
  assert.deepEqual([detail.from, detail.to, detail.reason], ['flagged', 'verified', REASON]);
  assert.equal(unflag.detail_json.includes(codes[2]), false, 'no pack code in the audit detail');

  const resolved = await db.get(`SELECT * FROM audit_log WHERE action = 'alert.resolved'`);
  assert.equal(JSON.parse(resolved.detail_json).falsePositive, true);
});

test('a regulator can do neither', async () => {
  const { row, alert } = await duplicate(codes[3]);
  await client.login(REGULATOR.email, REGULATOR.password);

  const fp = await client.post(`/api/admin/alerts/${alert.id}/false-positive`, { reason: REASON });
  const vd = await client.post(`/api/admin/alerts/${alert.id}/void-code`, { reason: REASON });

  assert.equal(fp.status, 403);
  assert.equal(vd.status, 403);
  assert.equal((await codeRow(row.id)).status, 'flagged');
});

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

test('voiding from an alert voids the code, resolves the alert, and refuses later scans', async () => {
  const { row, alert } = await duplicate(codes[4]);
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.post(`/api/admin/alerts/${alert.id}/void-code`, { reason: 'Confirmed counterfeit.' });

  assert.equal(res.status, 200);
  assert.equal((await codeRow(row.id)).status, 'void');
  const closed = await db.get('SELECT * FROM alerts WHERE id = ?', [alert.id]);
  assert.equal(closed.status, 'resolved');
  assert.equal(closed.resolution_note, 'Code voided: Confirmed counterfeit.');

  const scan = await client.post('/api/verify', { code: codes[4] }, { fromIp: '192.0.2.50' });
  assert.equal(scan.body.result, 'flagged');
  assert.equal(scan.body.reason, 'void');

  const entry = await db.get(`SELECT * FROM audit_log WHERE action = 'code.void'`);
  assert.equal(entry.actor_email, ADMIN.email);
  assert.equal(JSON.parse(entry.detail_json).reason, 'Confirmed counterfeit.');
});

test('the alert detail tells the screen what the code and batch are', async () => {
  const { alert } = await duplicate(codes[5]);
  await client.login(ADMIN.email, ADMIN.password);

  const res = await client.get(`/api/admin/alerts/${alert.id}`);

  assert.equal(res.body.code_status, 'flagged');
  assert.equal(res.body.batch_status, 'released');
  assert.ok(res.body.verified_count >= 1);
});
