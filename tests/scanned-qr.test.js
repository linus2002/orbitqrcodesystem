/**
 * Telling the two QR codes on a carton apart in the portal's scanner.
 *
 * The pack's own QR is checked as before. The medicine's leaflet QR is
 * recognised and offered as the leaflet, instead of being checked as a code
 * and reported as malformed. The addresses are the ones the server prints.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import './setup-env.js';
import { config } from '../src/config.js';
import { qrPayload } from '../src/lib/codes.js';
import { leafletUrl } from '../src/services/leaflets.js';
import { readScannedQr, leafletPath } from '../client/src/lib/scanned.js';

const CODE = 'AMX2026-260925-52266-2E';

test("a pack's own QR is read as its code and signature", () => {
  const printed = qrPayload(CODE, config.secrets.code, 'https://orbitqrcode.vercel.app');
  const read = readScannedQr(printed);
  assert.equal(read.kind, 'code');
  assert.equal(read.code, CODE);
  assert.equal(read.signature, new URL(printed).searchParams.get('s'));
});

test("the carton's leaflet QR is recognised, not checked as a code", () => {
  const read = readScannedQr(leafletUrl('AMX25'));
  assert.deepEqual(read, { kind: 'leaflet', sku: 'AMX25', lang: null });
  assert.equal(leafletPath(read), '/leaflet/AMX25');
});

test('a leaflet QR in another language keeps the language', () => {
  const read = readScannedQr(leafletUrl('AMX25', { lang: 'fil' }));
  assert.deepEqual(read, { kind: 'leaflet', sku: 'AMX25', lang: 'fil' });
  assert.equal(leafletPath(read), '/leaflet/AMX25?lang=fil');
});

test('anything else is read exactly as before', () => {
  assert.deepEqual(readScannedQr(CODE), { kind: 'code', code: CODE, signature: null }, 'a bare code');
  assert.deepEqual(
    readScannedQr('https://example.com/some/path/AMX25-1'),
    { kind: 'code', code: 'AMX25-1', signature: null },
    'an unrelated link: its last part, as before'
  );
  assert.deepEqual(
    readScannedQr('https://example.com/v/%E0%A4%A'),
    { kind: 'code', code: 'https://example.com/v/%E0%A4%A', signature: null },
    'invalid encoding falls back to the raw text, as before'
  );
  assert.equal(readScannedQr('https://example.com/leaflet/A/B').kind, 'code', 'only /leaflet/SKU is a leaflet');
});
