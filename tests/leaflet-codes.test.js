/**
 * Leaflet QR codes.
 *
 * The important property is that a leaflet QR decodes back to the leaflet URL
 * and nothing else - it must never carry a pack code. A leaflet QR is printed
 * on packaging, and packaging is what a counterfeiter copies, so a leaflet
 * code that looked like an authenticity claim would be worse than useless.
 *
 * The decode here goes through the same library the patient's browser uses,
 * for the same reason tests/qr.test.js does: a QR that renders is not the same
 * as a QR that scans.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

import { freshDb, seedBasics } from './helpers.js';
import * as db from '../src/db/index.js';
import * as leaflets from '../src/services/leaflets.js';
import { config } from '../src/config.js';

/** Render text into the ImageData shape jsQR expects. */
async function renderToImageData(text, { scale = 4, quiet = 4 } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'Q' });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const side = (size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(side * side * 4).fill(255);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!data[y * size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * side + ((x + quiet) * scale + dx);
          rgba[px * 4] = 0;
          rgba[px * 4 + 1] = 0;
          rgba[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data: rgba, width: side, height: side };
}

beforeEach(async () => {
  await freshDb();
  await seedBasics({ quantity: 6 });
});

test('a leaflet QR decodes to the leaflet URL for that medicine', async () => {
  const url = leaflets.leafletUrl('AMX25');
  const image = await renderToImageData(url);
  const decoded = jsQR(image.data, image.width, image.height);

  assert.ok(decoded, 'the code scans');
  assert.equal(decoded.data, url);
  assert.match(decoded.data, /\/leaflet\/AMX25$/);
});

test('a leaflet QR carries no pack code and no signature', async () => {
  const url = leaflets.leafletUrl('AMX25');

  // A pack code looks like AMX25-260814-088159-6M and its URL is /v/<code>.
  assert.equal(/\/v\//.test(url), false, 'not a verification deep link');
  assert.equal(/-\d{6}-/.test(url), false, 'carries no serialized code');
  // Nothing derived from CODE_SECRET may appear in a public, unsigned link.
  assert.equal(url.includes(config.secrets.code), false);
});

test('the SKU is upper-cased, so a lower-case link still resolves', async () => {
  assert.equal(leaflets.leafletUrl('amx25'), leaflets.leafletUrl('AMX25'));
});

test('a non-English leaflet carries its language, English does not', async () => {
  assert.match(leaflets.leafletUrl('AMX25', { lang: 'fil' }), /\?lang=fil$/);
  // 'en' is the default the public endpoint already assumes; repeating it in
  // every printed URL would be noise on a label with little room.
  assert.equal(leaflets.leafletUrl('AMX25', { lang: 'en' }).includes('lang='), false);
});

test('the list includes products with no leaflet, flagged as such', async () => {
  await db.insert('product', { sku: 'NOLEAF', name: 'No leaflet yet', manufacturer: 'North' });

  const items = await leaflets.listLeafletCodes();
  const gap = items.find((i) => i.sku === 'NOLEAF');

  assert.ok(gap, 'the product is listed rather than filtered out');
  assert.equal(gap.hasLeaflet, false);
  // Because a QR printed for it would take a patient to a dead end, and this
  // screen is the last place that can be noticed.
  assert.ok(gap.url.endsWith('/leaflet/NOLEAF'));
});

test('the print sheet leaves out medicines with no leaflet', async () => {
  await db.insert('product', { sku: 'NOLEAF', name: 'No leaflet yet', manufacturer: 'North' });

  const sheet = await leaflets.leafletSheet();
  assert.equal(
    sheet.some((s) => s.sku === 'NOLEAF'),
    false,
    'a dead-end QR must not reach a printer'
  );
  assert.ok(sheet.every((s) => s.qr.startsWith('data:image/png')));
});

test('the QR renders as SVG for an existing product and refuses an unknown one', async () => {
  const svg = await leaflets.leafletQrSvg('AMX25');
  assert.match(svg, /^<svg/);
  assert.match(svg, /<path/);

  await assert.rejects(() => leaflets.leafletQrSvg('NOPE'), /not found/i);
});
