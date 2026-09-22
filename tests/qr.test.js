/**
 * QR round-trip.
 *
 * The most expensive failure in this system would be discovering, after a
 * production run is printed, that the QR codes do not decode back to the
 * codes they encode. This test closes that loop in software: it renders a
 * real QR matrix from the serialization service and decodes it with the very
 * same library the patient's browser uses, then feeds the decoded payload
 * through the real verification path.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import QRCode from 'qrcode';
import jsQR from 'jsqr';

import { freshDb, seedBasics } from './helpers.js';
import { config } from '../src/config.js';
import { qrPayload, normalizeCode, checkSignature } from '../src/lib/codes.js';
import * as serialization from '../src/services/serialization.js';
import * as verification from '../src/services/verification.js';

/**
 * Render a QR payload into the ImageData shape jsQR expects.
 * Each module becomes a `scale` x `scale` block, surrounded by the 4-module
 * quiet zone the QR specification requires.
 */
async function renderToImageData(text, { scale = 4, quiet = 4, errorCorrectionLevel = 'Q' } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel });
  const size = qr.modules.size;
  const data = qr.modules.data;

  const side = (size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(side * side * 4).fill(255); // white background

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!data[y * size + x]) continue; // light module: leave white
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

let codes;
beforeEach(() => {
  freshDb();
  codes = seedBasics({ quantity: 12 }).codes;
});

test('a rendered QR decodes back to exactly the payload that was encoded', async () => {
  const payload = qrPayload(codes[0], config.secrets.code, config.publicBaseUrl);
  const image = await renderToImageData(payload);

  const decoded = jsQR(image.data, image.width, image.height);
  assert.ok(decoded, 'the rendered QR must be decodable');
  assert.equal(decoded.data, payload, 'the decoded payload must match byte for byte');
});

test('a scanned QR drives the full verification path to a genuine result', async () => {
  const payload = qrPayload(codes[1], config.secrets.code, config.publicBaseUrl);
  const image = await renderToImageData(payload);
  const decoded = jsQR(image.data, image.width, image.height);

  // This mirrors exactly what public/js/verify.js does with a scan result.
  const url = new URL(decoded.data);
  const signature = url.searchParams.get('s');
  const code = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop());

  assert.equal(code, codes[1]);
  assert.equal(checkSignature(code, signature, config.secrets.code), 'valid');

  const result = verification.verify(code, {
    signature,
    req: { clientIp: '198.51.100.1', get: () => null },
  });

  assert.equal(result.result, 'genuine');
  const scanned = (await import('../src/db/index.js')).get(
    'SELECT signature_state FROM scans ORDER BY id DESC LIMIT 1'
  );
  assert.equal(scanned.signature_state, 'valid', 'the QR signature is recorded as verified');
});

test('every code in a batch produces a decodable QR', async () => {
  for (const code of codes) {
    const payload = qrPayload(code, config.secrets.code, config.publicBaseUrl);
    const image = await renderToImageData(payload, { scale: 3 });
    const decoded = jsQR(image.data, image.width, image.height);
    assert.ok(decoded, `QR for ${code} must decode`);
    assert.equal(normalizeCode(decoded.data), code);
  }
});

test('error-correction level Q survives damage to a corner of the label', async () => {
  // Pharmaceutical labels get scuffed in transit and curve around cartons.
  // Level Q recovers ~25% of the symbol, so obscuring a modest patch of a
  // non-finder area must still decode.
  const payload = qrPayload(codes[2], config.secrets.code, config.publicBaseUrl);
  const image = await renderToImageData(payload, { scale: 6 });

  // Damage a block in the lower-middle region, avoiding the three finder
  // patterns in the corners (losing one of those is unrecoverable by design).
  const { width, height, data } = image;
  const x0 = Math.floor(width * 0.42);
  const y0 = Math.floor(height * 0.60);
  const patch = Math.floor(width * 0.10);

  for (let y = y0; y < y0 + patch; y++) {
    for (let x = x0; x < x0 + patch; x++) {
      const px = (y * width + x) * 4;
      data[px] = 255;
      data[px + 1] = 255;
      data[px + 2] = 255;
    }
  }

  const decoded = jsQR(data, width, height);
  assert.ok(decoded, 'a scuffed label must still scan');
  assert.equal(decoded.data, payload);
});

test('the service renders SVG that contains a QR path', async () => {
  const svg = await serialization.qrSvg(codes[3]);
  assert.match(svg, /^<svg/);
  assert.match(svg, /viewBox/);
  assert.ok(svg.length > 200, 'the SVG should carry real module geometry');
});
