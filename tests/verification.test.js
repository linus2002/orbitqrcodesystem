/**
 * The verification decision matrix.
 *
 * This is the behaviour patients depend on, so each rule gets an explicit
 * test - including the two that are easy to get wrong:
 *   - a failed scan must not make the next genuine scan look like a duplicate
 *   - a patient refreshing the page must not be told their medicine is fake
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics } from './helpers.js';
import * as db from '../src/db/index.js';
import { config } from '../src/config.js';
import { buildCode, serialWidthFor } from '../src/lib/codes.js';
import * as verification from '../src/services/verification.js';
import * as serialization from '../src/services/serialization.js';

const ctx = (ip = '198.51.100.1') => ({ req: { clientIp: ip, get: () => null } });

let codes;
beforeEach(async () => {
  await freshDb();
  codes = (await seedBasics()).codes;
});

test('a first check of a released code is genuine and shows the leaflet', async () => {
  const r = await verification.verify(codes[0], ctx());
  assert.equal(r.result, 'genuine');
  assert.equal(r.reason, 'ok');
  assert.equal(r.scanNumber, 1);
  assert.equal(r.product.name, 'Amoxicillin');
  assert.ok(r.leaflet.sections.length > 0, 'a genuine result includes the leaflet');
  assert.equal(r.reportable, false);
});

test('a second check from a different device is flagged as a duplicate', async () => {
  await verification.verify(codes[0], ctx('198.51.100.1'));
  const r = await verification.verify(codes[0], ctx('203.0.113.9'));

  assert.equal(r.result, 'flagged');
  assert.equal(r.reason, 'duplicate_scan');
  assert.equal(r.scanNumber, 2);
  assert.equal(r.leaflet, null, 'dosing information must NOT appear beside a counterfeit warning');
  assert.equal(r.reportable, true);
});

test('re-checking from the same device inside the grace window stays genuine', async () => {
  const first = await verification.verify(codes[0], ctx('198.51.100.1'));
  const second = await verification.verify(codes[0], ctx('198.51.100.1'));
  const third = await verification.verify(codes[0], ctx('198.51.100.1'));

  assert.equal(first.reason, 'ok');
  assert.equal(second.result, 'genuine');
  assert.equal(second.reason, 'ok_repeat_same_source');
  assert.equal(third.result, 'genuine');

  // The repeat must not inflate the counter that defines "duplicate"...
  const row = await db.get('SELECT scan_count, verified_count FROM codes WHERE code = ?', [codes[0]]);
  assert.equal(row.verified_count, 1);
  // ...and must not create an alert.
  assert.equal(await db.scalar('SELECT COUNT(*) FROM alerts'), 0);
});

test('a failed scan does not make the first genuine scan look like a duplicate', async () => {
  // Regression test. A scan before the batch was released used to bump the
  // same counter that duplicate detection reads, so the first real patient
  // scan was reported as a counterfeit.
  await freshDb();
  await db.run(`INSERT INTO products (sku, name, manufacturer) VALUES ('AMX25','Amoxicillin','N')`);
  await db.run(
    `INSERT INTO batches (batch_number, product_id, mfg_date, expiry_date, quantity)
     VALUES ('AMX25-T2', 1, '2026-09-01', '2028-09-01', 10)`
  );
  await serialization.issueCodes(1, {});
  const code = (await db.get('SELECT code FROM codes WHERE unit_index = 0')).code;

  const early = await verification.verify(code, ctx());
  assert.equal(early.reason, 'not_released', 'scanning before release is suspicious');

  await serialization.transition(1, 'printed', {});
  await serialization.transition(1, 'released', {});

  const real = await verification.verify(code, ctx());
  assert.equal(real.result, 'genuine', 'the first real patient scan must be genuine');
  assert.equal(real.scanNumber, 1);
});

test('an unknown code is flagged and raises an alert', async () => {
  const r = await verification.verify('AMX25-260921-00483-K7', ctx());
  // That literal code has a checksum that does not match our secret, so it is
  // caught as invalid before the registry is even consulted.
  assert.equal(r.result, 'invalid');
  assert.equal(r.reason, 'checksum_failed');

  // Build a code that is structurally perfect but not in the registry.
  const fabricated = fabricateValidLookingCode();
  const r2 = await verification.verify(fabricated, ctx());
  assert.equal(r2.result, 'flagged');
  assert.equal(r2.reason, 'unknown_code');
  assert.equal(await db.scalar(`SELECT COUNT(*) FROM alerts WHERE type = 'unknown_code'`), 1);
});

test('a mistyped code is invalid, not flagged as counterfeit', async () => {
  const good = codes[0];
  const typo = `${good.slice(0, -1)}${good.at(-1) === '0' ? '1' : '0'}`;
  const r = await verification.verify(typo, ctx());

  assert.equal(r.result, 'invalid', 'a typo must never be presented as a counterfeit');
  assert.equal(r.reason, 'checksum_failed');
  assert.match(r.message, /mistyped/i);
  assert.equal(await db.scalar(`SELECT COUNT(*) FROM alerts WHERE type = 'duplicate_scan'`), 0);
});

test('a recalled batch warns the patient and raises a critical alert', async () => {
  await serialization.transition(1, 'distributed', {});
  await serialization.transition(1, 'recalled', { reason: 'Cold chain excursion' });

  const r = await verification.verify(codes[1], ctx());
  assert.equal(r.result, 'flagged');
  assert.equal(r.reason, 'recalled');
  assert.equal(r.batch.recallReason, 'Cold chain excursion');

  const alert = await db.get(`SELECT * FROM alerts WHERE type = 'recalled_scan'`);
  assert.equal(alert.severity, 'critical');
});

test('an expired pack is flagged even though the code is real', async () => {
  await freshDb();
  const seeded = await seedBasics({ expiryDays: -10 });
  const r = await verification.verify(seeded.codes[0], ctx());

  assert.equal(r.result, 'flagged');
  assert.equal(r.reason, 'expired');
  assert.equal(r.batch.isExpired, true);
  assert.equal(r.leaflet, null);
});

test('a code from a batch that was never released is flagged', async () => {
  await freshDb();
  await db.run(`INSERT INTO products (sku, name, manufacturer) VALUES ('AMX25','Amoxicillin','N')`);
  await db.run(
    `INSERT INTO batches (batch_number, product_id, mfg_date, expiry_date, quantity)
     VALUES ('AMX25-T3', 1, '2026-09-01', '2028-09-01', 5)`
  );
  await serialization.issueCodes(1, {});
  const code = (await db.get('SELECT code FROM codes WHERE unit_index = 0')).code;

  const r = await verification.verify(code, ctx());
  assert.equal(r.reason, 'not_released');
});

test('a voided code is refused', async () => {
  await db.run(`UPDATE codes SET status = 'void' WHERE code = ?`, [codes[2]]);
  const r = await verification.verify(codes[2], ctx());
  assert.equal(r.result, 'flagged');
  assert.equal(r.reason, 'void');
});

test('pilot batches never pollute the live alert queue', async () => {
  await db.run(`UPDATE batches SET is_test = 1 WHERE id = 1`);
  await verification.verify(codes[3], ctx('1.1.1.1'));
  await verification.verify(codes[3], ctx('2.2.2.2')); // would normally be a duplicate alert

  assert.equal(await db.scalar('SELECT COUNT(*) FROM alerts'), 0, 'sandbox scans raise no alerts');
  assert.equal(await db.scalar('SELECT COUNT(*) FROM scans WHERE is_test = 1'), 2, 'but are still logged');
});

test('every attempt is written to the scan log', async () => {
  await verification.verify(codes[0], ctx());
  await verification.verify('not-a-code', ctx());
  await verification.verify(fabricateValidLookingCode(), ctx());

  const rows = await db.all('SELECT result, reason FROM scans ORDER BY id');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.result), ['genuine', 'invalid', 'flagged']);
});

test('repeated duplicate scans fold into one alert and escalate it', async () => {
  await verification.verify(codes[0], ctx('1.1.1.1'));
  for (let i = 0; i < 12; i++) await verification.verify(codes[0], ctx(`10.0.0.${i}`));

  const alerts = await db.all(`SELECT * FROM alerts WHERE type = 'duplicate_scan'`);
  assert.equal(alerts.length, 1, 'one incident, not one alert per scan');
  assert.equal(alerts[0].severity, 'critical', 'severity escalates with repetition');
  assert.equal(JSON.parse(alerts[0].detail_json).occurrences, 12);
});

test('bulk verification summarises a shipment', async () => {
  const summary = await verification.verifyBulk([codes[0], codes[1], 'rubbish'], ctx());
  assert.equal(summary.checked, 3);
  assert.equal(summary.genuine, 2);
  assert.equal(summary.invalid, 1);
});

test('sustained failed lookups raise a code-guessing alert', async () => {
  for (let i = 0; i < 10; i++) {
    await verification.verify(fabricateValidLookingCode(i), ctx('192.0.2.50'));
  }
  const alert = await db.get(`SELECT * FROM alerts WHERE type = 'guess_attack'`);
  assert.ok(alert, 'a guessing burst from one source must be detected');
  assert.equal(alert.severity, 'high');
});

/**
 * A structurally valid code - correct checksum, computed with the app's own
 * secret - that is deliberately absent from the registry. This is what a
 * counterfeiter who had somehow learned the checksum rule would present.
 */
function fabricateValidLookingCode(n = 0) {
  return buildCode({
    sku: 'ZZZ99',
    mfgDate: '2026-09-21',
    serial: 10_000 + n,
    width: serialWidthFor(1),
    secret: config.secrets.code,
  });
}
