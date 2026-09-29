/**
 * A QR the manufacturer did not print.
 *
 * The code on a pack can be read off the box and copied, but the signature in
 * its QR needs the code secret. A counterfeiter who copies a real code into a
 * QR of their own therefore gives it a wrong signature, or none. That used to
 * be recorded and ignored - the copy checked as genuine. Now:
 *
 *   - a wrong signature is flagged `bad_signature` and raises a high alert;
 *   - a code read from a QR (the deep link or the portal's camera) with no
 *     signature is flagged the same way, since every QR we print has one;
 *   - a typed code needs no signature and is unaffected;
 *   - the flagged check is not a verification, so the genuine pack's own
 *     buyer is not made a "second device";
 *   - a recall, withdrawal or expiry is still what the person is told first.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';
import { config } from '../src/config.js';
import { computeSignature } from '../src/lib/codes.js';
import * as serialization from '../src/services/serialization.js';

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
  codes = (await seedBasics({ quantity: 10 })).codes;
  client.clearCookies();
  await resetRateLimits();
  await giveDetails(client);
});

const sign = (code) => computeSignature(code, config.secrets.code);
const check = (body, ip = '198.51.100.60') => client.post('/api/verify', body, { fromIp: ip });

test('a QR the system printed checks as genuine', async () => {
  const res = await check({ code: codes[0], signature: sign(codes[0]), via: 'qr' });

  assert.equal(res.body.result, 'genuine');
  assert.equal(res.body.reason, 'ok');
});

test('a wrong signature is flagged, alerted and not counted as a verification', async () => {
  const res = await check({ code: codes[1], signature: 'AAAAAAAAAA', via: 'qr' });

  assert.equal(res.body.result, 'flagged');
  assert.equal(res.body.reason, 'bad_signature');
  assert.match(res.body.message, /not printed by the manufacturer/);
  assert.equal(res.body.leaflet, null, 'no dosing information beside a counterfeit warning');

  const alert = await db.findOne('alert', { type: 'bad_signature' });
  assert.equal(alert.severity, 'high');
  const code = await db.getCode(codes[1]);
  assert.equal(code.verified_count, 0);
  assert.equal(code.status, 'flagged');
});

test('a code from a QR with no signature is flagged: every QR we print has one', async () => {
  const res = await check({ code: codes[2], via: 'qr' });

  assert.equal(res.body.result, 'flagged');
  assert.equal(res.body.reason, 'bad_signature');
});

test('a typed code needs no signature', async () => {
  for (const body of [{ code: codes[3] }, { code: codes[4], via: 'typed' }]) {
    const res = await check(body);
    assert.equal(res.body.result, 'genuine', JSON.stringify(body));
  }
});

test("a copied QR does not spoil the genuine pack's own check", async () => {
  await check({ code: codes[5], signature: 'AAAAAAAAAA', via: 'qr' });

  // The real pack, with its real QR, checked by its buyer on another phone.
  const buyer = await client.newPerson();
  const res = await client.post(
    '/api/verify',
    { code: codes[5], signature: sign(codes[5]), via: 'qr' },
    { fromIp: '198.51.100.61', person: buyer }
  );

  assert.equal(res.body.result, 'genuine');
  assert.equal(res.body.scanNumber, 1);
});

test('a recall is still what the person is told first', async () => {
  await serialization.transition(1, 'recalled', { reason: 'Seal failure' });

  const res = await check({ code: codes[6], signature: 'AAAAAAAAAA', via: 'qr' });

  assert.equal(res.body.reason, 'recalled');
});

test('a made-up code in a fake QR still fails its checksum first', async () => {
  const res = await check({ code: 'AMX25-260901-99999-ZZ', signature: 'AAAAAAAAAA', via: 'qr' });
  assert.equal(res.body.result, 'invalid', 'a made-up code fails its checksum first');
});

test('the GET deep-link form flags a wrong signature, and accepts none', async () => {
  const bad = await client.get(`/api/verify/${encodeURIComponent(codes[7])}?s=AAAAAAAAAA`, { fromIp: '198.51.100.62' });
  const none = await client.get(`/api/verify/${encodeURIComponent(codes[8])}`, { fromIp: '198.51.100.62' });

  assert.equal(bad.body.reason, 'bad_signature');
  assert.equal(none.body.result, 'genuine');
});

test('`via` only takes qr or typed', async () => {
  const res = await check({ code: codes[9], via: 'camera' });
  assert.equal(res.status, 422);
});
