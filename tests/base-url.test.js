/**
 * The public base URL, and the warning raised when it is a local one.
 *
 * The address is baked into a QR when the code is GENERATED - only the code
 * itself is stored, and the payload is rebuilt on every export - so a sheet
 * printed against `http://localhost` cannot be repaired by fixing the setting
 * afterwards. The detection is therefore tested exhaustively rather than on a
 * single happy case, because a false negative means unusable printed cartons
 * and a false positive means crying wolf at every export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics } from './helpers.js';
import { config, isLocalBaseUrl } from '../src/config.js';
import * as serialization from '../src/services/serialization.js';
import * as leaflets from '../src/services/leaflets.js';

test('every shape of local address is recognised', () => {
  for (const url of [
    'http://localhost',
    'http://localhost:3000',
    'http://localhost:4000',
    'https://localhost',
    'https://localhost:5173',
    'http://127.0.0.1',
    'http://127.0.0.1:4000',
    'https://127.0.0.1:8443',
    'http://0.0.0.0:3000',
    'http://[::1]:4000',
    'HTTP://LOCALHOST:4000',
  ]) {
    assert.equal(isLocalBaseUrl(url), true, `${url} should be local`);
  }
});

test('a routable address is not mistaken for a local one', () => {
  for (const url of [
    'https://verify.example.com',
    'https://qrshield.example.com:8443',
    'http://test.local',
    // The trap the anchored pattern exists for: a real host that merely
    // begins with the word localhost.
    'https://localhost.example.com',
    'https://my-localhost.io',
    'https://127.0.0.1.example.com',
  ]) {
    assert.equal(isLocalBaseUrl(url), false, `${url} should NOT be local`);
  }
});

test('a missing or empty value is not reported as local', () => {
  // Absent configuration is a different fault with a different message; this
  // check must not claim it is a localhost problem.
  assert.equal(isLocalBaseUrl(undefined), false);
  assert.equal(isLocalBaseUrl(null), false);
  assert.equal(isLocalBaseUrl(''), false);
});

test('the test environment runs against a routable address', () => {
  // Guards the two assertions below: they only prove anything if the suite is
  // not itself running against localhost.
  assert.equal(config.publicBaseUrlIsLocal, false);
});

test('a code export against a real address carries no warning', async () => {
  await freshDb();
  const { batchId } = await seedBasics({ quantity: 4 });

  const { csv, warning } = await serialization.exportCsv(batchId);

  assert.equal(warning, undefined, 'no warning when the base URL is routable');
  assert.match(csv.split('\n')[0], /^unit_index,code,serial,qr_payload,/);
  assert.equal(csv.includes('localhost'), false, 'no local address reached the file');
});

test('the leaflet sheet still returns a plain list of products', async () => {
  await freshDb();
  await seedBasics({ quantity: 4 });

  const sheet = await leaflets.leafletSheet({ lang: 'en' });

  // The warning is logged rather than returned here, precisely so this shape
  // is unchanged - the route spreads it straight into its response.
  assert.ok(Array.isArray(sheet), 'leafletSheet returns an array');
  assert.equal(sheet.length, 1);
  assert.equal(sheet[0].sku, 'AMX25');
  assert.match(sheet[0].url, /\/leaflet\/AMX25$/);
});
