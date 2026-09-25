/**
 * Leaflet versions on the public page.
 *
 * Publishing a new version supersedes the old one, and the public route
 * serves the newest by default: a safety correction has to reach everyone
 * holding the medicine, including packs printed before it. Older versions
 * stay reachable by ?version= and come back flagged as superseded.
 *
 * Two of these matter more than the rest. The default must ALWAYS be the
 * newest - serving an old leaflet by default would hide a safety correction
 * from exactly the people it is for. And an older version must ALWAYS say it
 * is superseded, because it is the one thing on the page that could mislead
 * someone about their medicine.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';

let client;

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  await seedBasics({ quantity: 4 }); // product 1 (AMX25) with leaflet v1.0, en
  client.clearCookies();
  await resetRateLimits();
});

/** Publish another version directly, with an explicit date so ordering is not left to the clock. */
async function publish(version, { lang = 'en', effectiveFrom, heading = 'Revised' } = {}) {
  await db.insert('leaflet', {
    product_id: 1,
    version,
    language: lang,
    sections: [{ heading, body: `Body of ${version}.` }],
    effective_from: effectiveFrom ?? new Date().toISOString(),
  });
}

const leaflet = (query = {}) => {
  const qs = new URLSearchParams(query).toString();
  return client.get(`/api/product/AMX25/leaflet${qs ? `?${qs}` : ''}`);
};

test('a single version is current, not superseded, and the history has one entry', async () => {
  const res = await leaflet();

  assert.equal(res.status, 200);
  assert.equal(res.body.leaflet.version, '1.0');
  assert.equal(res.body.leaflet.superseded, false);
  assert.deepEqual(
    res.body.history.map((h) => [h.version, h.current]),
    [['1.0', true]]
  );
});

test('the existing response fields are unchanged', async () => {
  // The fields a client already relied on before history was added.
  const res = await leaflet();

  assert.deepEqual(Object.keys(res.body.product).sort(), ['dosageForm', 'manufacturer', 'name', 'sku', 'strength']);
  assert.equal(res.body.product.sku, 'AMX25');
  assert.equal(res.body.leaflet.language, 'en');
  assert.ok(res.body.leaflet.effectiveFrom);
  assert.ok(Array.isArray(res.body.leaflet.sections));
  assert.ok(res.body.leaflet.sections[0].heading);
});

test('publishing a newer version makes it the default, with the older one listed after it', async () => {
  await publish('2.0', { effectiveFrom: '2026-10-01T00:00:00.000Z' });

  const res = await leaflet();

  assert.equal(res.body.leaflet.version, '2.0', 'the newest is what a QR opens');
  assert.equal(res.body.leaflet.superseded, false);
  assert.equal(res.body.leaflet.sections[0].heading, 'Revised', 'and its own content');
  assert.deepEqual(
    res.body.history.map((h) => [h.version, h.current]),
    [['2.0', true], ['1.0', false]],
    'newest first, exactly one marked current'
  );
});

test('an older version is served on request and says so', async () => {
  await publish('2.0', { effectiveFrom: '2026-10-01T00:00:00.000Z' });

  const res = await leaflet({ version: '1.0' });

  assert.equal(res.status, 200);
  assert.equal(res.body.leaflet.version, '1.0');
  assert.equal(res.body.leaflet.superseded, true, 'flagged, so the page warns before the content');
  assert.equal(res.body.leaflet.sections[0].heading, 'Dosage', 'the old content, not the new');
  // The history is the same whichever version is being read.
  assert.deepEqual(res.body.history.map((h) => h.version), ['2.0', '1.0']);
});

test('asking for the current version by number is not superseded', async () => {
  await publish('2.0', { effectiveFrom: '2026-10-01T00:00:00.000Z' });

  const res = await leaflet({ version: '2.0' });

  assert.equal(res.body.leaflet.version, '2.0');
  assert.equal(res.body.leaflet.superseded, false);
});

test('a version that does not exist is a 404, not the current one', async () => {
  const res = await leaflet({ version: '9.9' });

  assert.equal(res.status, 404, 'never silently substitute another version');
});

test('order is by effective date, not by the order rows were written', async () => {
  // A correction published today but dated to take effect earlier than an
  // existing version must not become the default over it.
  await publish('1.1', { effectiveFrom: '2020-01-01T00:00:00.000Z' });

  const res = await leaflet();

  assert.equal(res.body.leaflet.version, '1.0', 'the later effective date wins');
  assert.deepEqual(res.body.history.map((h) => h.version), ['1.0', '1.1']);
});

test('another language is its own history', async () => {
  await publish('1.0', { lang: 'fil', heading: 'Dosis' });
  await publish('2.0', { lang: 'fil', heading: 'Dosis (binago)', effectiveFrom: '2026-10-01T00:00:00.000Z' });

  const en = await leaflet();
  const fil = await leaflet({ lang: 'fil' });

  assert.deepEqual(en.body.history.map((h) => h.version), ['1.0'], 'English unaffected');
  assert.deepEqual(fil.body.history.map((h) => h.version), ['2.0', '1.0']);
  assert.equal(fil.body.leaflet.sections[0].heading, 'Dosis (binago)');
});

test('an unknown product is still a 404', async () => {
  const res = await client.get('/api/product/NOPE/leaflet');

  assert.equal(res.status, 404);
});
