/**
 * Where the pack behind a check was bought.
 *
 * Asked after the result, per check rather than once per person: a person
 * who checks five packs from five pharmacies should leave five answers. These
 * pin who may give one (only for their own check, within a day), that each
 * check takes one, that the phone's location is reduced to a city before it
 * is written, and that a report carries the same facts.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';
import * as places from '../src/services/places.js';
import * as serialization from '../src/services/serialization.js';

let client;
let codes;

const code = (label) => places.list().find(([, l]) => l === label)[0];
const BACOOR = code('Bacoor, Cavite');
const ZAMBOANGA = code('Zamboanga, Zamboanga Peninsula');
/** A phone standing in Bacoor, as the browser's geolocation reports it. */
const IN_BACOOR = { lat: 14.46, lng: 120.965, accuracy: 25 };

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  codes = (await seedBasics({ quantity: 6 })).codes;
  client.clearCookies();
  await giveDetails(client);
  await resetRateLimits();
});

const check = (c, opts = {}) => client.post('/api/verify', { code: c }, { fromIp: '198.51.100.7', ...opts });
const place = (scanId, body, opts = {}) =>
  client.post(`/api/checks/${scanId}/place`, body, { fromIp: '198.51.100.7', ...opts });

test('a genuine check takes where the pack was bought', async () => {
  const { body: result } = await check(codes[0]);
  assert.equal(result.result, 'genuine');

  const res = await place(result.scanId, { placeCode: BACOOR, outlet: 'Mercury Drug, Molino' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.purchasePlace, 'Bacoor, Cavite');

  const row = await db.findOne('checkPlace', { scan_id: result.scanId });
  assert.equal(row.purchase_place_code, BACOOR);
  assert.equal(row.purchase_outlet, 'Mercury Drug, Molino');
  assert.equal(row.location_source, 'none', 'no GPS, and the test has no connection location');
  assert.equal(row.place_consistency, 'unknown');
  assert.ok(row.verifier_id, 'tied to the person who checked');
});

test('with the phone\'s location, a far-away claim is labelled - and only the city is kept', async () => {
  await serialization.transition(1, 'recalled', { reason: 'Test recall' });
  const { body: result } = await check(codes[0]);
  assert.equal(result.result, 'flagged');

  const res = await place(result.scanId, { placeCode: ZAMBOANGA, location: IN_BACOOR });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const row = await db.findOne('checkPlace', { scan_id: result.scanId });
  assert.equal(row.located_place, 'Bacoor, Cavite');
  assert.equal(row.location_source, 'gps');
  assert.equal(row.place_consistency, 'inconsistent');
  assert.ok(row.place_distance_km > 800);
  const stored = JSON.stringify(await db.query('*[_type == "checkPlace"]'));
  assert.ok(!stored.includes('14.46') && !stored.includes('120.965'), 'no coordinates anywhere in the document');
});

test('without GPS, the connection\'s location is used, and only for the island group', async () => {
  const { body: result } = await check(codes[0]);
  const res = await place(
    result.scanId,
    { placeCode: ZAMBOANGA },
    { headers: { 'X-Vercel-IP-Country': 'PH', 'X-Vercel-IP-Latitude': '14.45', 'X-Vercel-IP-Longitude': '120.98' } }
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = await db.findOne('checkPlace', { scan_id: result.scanId });
  assert.equal(row.location_source, 'network');
  assert.equal(row.located_place, 'Las Piñas, Metro Manila');
  assert.equal(row.place_consistency, 'inconsistent', 'Luzon against Mindanao');
  assert.equal(row.place_distance_km, null, 'no distance claimed from a connection');
});

test('one place per check', async () => {
  const { body: result } = await check(codes[0]);
  assert.equal((await place(result.scanId, { placeCode: BACOOR })).status, 201);
  const again = await place(result.scanId, { placeCode: ZAMBOANGA });
  assert.equal(again.status, 409);
  assert.equal(await db.count('checkPlace', { scan_id: result.scanId }), 1);
});

test('only for your own check, and only for a day', async () => {
  const { body: mine } = await check(codes[0]);

  // Somebody else, with their own details, naming this check.
  const other = await client.newPerson();
  assert.equal((await place(mine.scanId, { placeCode: BACOOR }, { person: other })).status, 404);
  assert.equal((await place(99999, { placeCode: BACOOR })).status, 404);

  await db.update('scan', mine.scanId, { created_at: new Date(Date.now() - 25 * 3_600_000).toISOString() });
  assert.equal((await place(mine.scanId, { placeCode: BACOOR })).status, 404, 'too late');
  assert.equal(await db.count('checkPlace'), 0);
});

test('a check made without details belongs to the connection that made it', async () => {
  await db.insert('setting', { key: 'portal.require_details', value: 'off' });
  client.clearCookies();
  const { body: result } = await check(codes[0], { fromIp: '203.0.113.9' });
  assert.equal(result.result, 'genuine');

  assert.equal((await place(result.scanId, { placeCode: BACOOR }, { fromIp: '203.0.113.50' })).status, 404);
  assert.equal((await place(result.scanId, { placeCode: BACOOR }, { fromIp: '203.0.113.9' })).status, 201);
});

test('refused: nothing given, a place not on the list, a malformed location', async () => {
  const { body: result } = await check(codes[0]);
  assert.equal((await place(result.scanId, {})).status, 400);
  assert.equal((await place(result.scanId, { placeCode: '0000000000' })).status, 400);
  assert.equal((await place(result.scanId, { location: 'Bacoor' })).status, 400);
  assert.equal((await place(result.scanId, { location: { lat: 'x', lng: 1 } })).status, 400);
  assert.equal(await db.count('checkPlace'), 0);
});

test('the portal offers the last place back, and the connection\'s city', async () => {
  const { body: result } = await check(codes[0]);
  await place(result.scanId, { placeCode: BACOOR, outlet: 'Mercury Drug, Molino' });

  const portal = await client.get('/api/portal', {
    headers: { 'X-Vercel-IP-Country': 'PH', 'X-Vercel-IP-Latitude': '14.45', 'X-Vercel-IP-Longitude': '120.98' },
  });
  assert.deepEqual(portal.body.checker.lastPurchase, {
    code: BACOOR, label: 'Bacoor, Cavite', outlet: 'Mercury Drug, Molino',
  });
  assert.equal(portal.body.here.label, 'Las Piñas, Metro Manila');
});

test('the place list is served whole, codes and labels only', async () => {
  const res = await client.get('/api/places');
  assert.equal(res.status, 200);
  assert.equal(res.body.places.length, 1642);
  assert.deepEqual(res.body.places.find(([c]) => c === BACOOR), [BACOOR, 'Bacoor, Cavite']);
});

test('a report carries the place and the location check too', async () => {
  await serialization.transition(1, 'recalled', { reason: 'Test recall' });
  const { body: result } = await check(codes[1]);
  assert.equal(result.result, 'flagged');
  const res = await client.post(
    '/api/report',
    {
      code: codes[1], scanId: result.scanId,
      description: 'The box is a different colour from last month.',
      purchaseLocation: 'Sidewalk stall', placeCode: ZAMBOANGA, location: IN_BACOOR,
    },
    { fromIp: '198.51.100.7' }
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const report = await db.findOne('consumerReport', {});
  assert.equal(report.purchase_location, 'Sidewalk stall - Zamboanga, Zamboanga Peninsula');
  assert.equal(report.purchase_place_code, ZAMBOANGA);
  assert.equal(report.located_place, 'Bacoor, Cavite');
  assert.equal(report.place_consistency, 'inconsistent');
});

test('a report written the old way keeps what was typed', async () => {
  const res = await client.post('/api/report', {
    description: 'Seal was already broken when I opened it.', purchaseLocation: 'Watsons SM Bacoor',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const report = await db.findOne('consumerReport', {});
  assert.equal(report.purchase_location, 'Watsons SM Bacoor');
  assert.equal(report.place_consistency, 'unknown');
});
