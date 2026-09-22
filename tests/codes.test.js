/**
 * Code generation and validation.
 *
 * These properties are the security foundation of the whole system: if serials
 * collide, two packs share an identity; if they are predictable, a
 * counterfeiter can mint working codes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateBatchCodes,
  serialPermutation,
  serialWidthFor,
  parseCode,
  normalizeCode,
  computeChecksum,
  computeSignature,
  checkSignature,
  qrPayload,
  dateSegment,
} from '../src/lib/codes.js';

const SECRET = 'unit-test-secret';

test('the serial permutation is a bijection over the whole domain', () => {
  const permute = serialPermutation('key-a', 5);
  const seen = new Set();
  for (let i = 0; i < 100_000; i++) seen.add(permute(i));
  assert.equal(seen.size, 100_000, 'every index must map to a distinct serial');
});

test('serials are not sequential', () => {
  const permute = serialPermutation('key-a', 5);
  let adjacent = 0;
  for (let i = 0; i < 2000; i++) {
    if (Math.abs(permute(i + 1) - permute(i)) === 1) adjacent += 1;
  }
  // With a uniform permutation the expected count over 2000 draws is ~0.04.
  assert.ok(adjacent <= 2, `expected almost no adjacent pairs, saw ${adjacent}`);
});

test('different batch keys produce different orderings', () => {
  const a = serialPermutation('batch-A', 5);
  const b = serialPermutation('batch-B', 5);
  let same = 0;
  for (let i = 0; i < 500; i++) if (a(i) === b(i)) same += 1;
  assert.ok(same < 10, 'two batches must not share a serial ordering');
});

test('serial width scales so the space stays at least 100x the batch size', () => {
  assert.equal(serialWidthFor(500), 5);
  assert.equal(serialWidthFor(5_000), 6);
  assert.equal(serialWidthFor(50_000), 7);
  assert.ok(10 ** serialWidthFor(20_000) >= 20_000 * 100);
});

test('a generated batch has no duplicate codes', () => {
  const codes = [...generateBatchCodes({
    sku: 'AMX25', mfgDate: '2026-09-21', quantity: 3000, batchKey: 'B1', secret: SECRET,
  })];
  assert.equal(codes.length, 3000);
  assert.equal(new Set(codes.map((c) => c.code)).size, 3000);
});

test('every generated code parses and validates', () => {
  for (const { code } of generateBatchCodes({
    sku: 'ART20', mfgDate: '2026-07-13', quantity: 200, batchKey: 'B2', secret: SECRET,
  })) {
    const parsed = parseCode(code, SECRET);
    assert.equal(parsed.ok, true, `${code} should parse`);
    assert.equal(parsed.sku, 'ART20');
    assert.equal(parsed.dateSegment, '260713');
  }
});

test('every single-character typo is caught by the checksum', () => {
  const [{ code }] = [...generateBatchCodes({
    sku: 'AMX25', mfgDate: '2026-09-21', quantity: 1, batchKey: 'B3', secret: SECRET,
  })];

  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let checked = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '-') continue;
    for (const ch of alphabet) {
      if (ch === code[i]) continue;
      const mutated = code.slice(0, i) + ch + code.slice(i + 1);
      assert.equal(parseCode(mutated, SECRET).ok, false, `${mutated} must be rejected`);
      checked += 1;
    }
  }
  assert.ok(checked > 400, 'should have exercised a few hundred mutations');
});

test('a checksum cannot be forged without the secret', () => {
  const body = 'AMX25-260921-00483';
  const real = computeChecksum(body, SECRET);
  const withOtherSecret = computeChecksum(body, 'a-different-secret');
  assert.notEqual(real, withOtherSecret);
  assert.equal(parseCode(`${body}-${withOtherSecret}`, SECRET).error, 'checksum');
});

test('input normalisation tolerates how people actually type', () => {
  const [{ code }] = [...generateBatchCodes({
    sku: 'AMX25', mfgDate: '2026-09-21', quantity: 1, batchKey: 'B4', secret: SECRET,
  })];

  const variants = [
    code.toLowerCase(),
    code.replace(/-/g, ' '),
    code.replace(/-/g, '_'),
    `  ${code}  `,
    code.replace(/-/g, '–'), // en dash, as produced by some copy/paste
  ];
  for (const v of variants) {
    assert.equal(parseCode(v, SECRET).ok, true, `should accept: ${JSON.stringify(v)}`);
  }
});

test('a scanned QR URL is reduced to its code', () => {
  const [{ code }] = [...generateBatchCodes({
    sku: 'AMX25', mfgDate: '2026-09-21', quantity: 1, batchKey: 'B5', secret: SECRET,
  })];
  const url = qrPayload(code, SECRET, 'https://verify.example.com');
  assert.equal(normalizeCode(url), code);
  assert.equal(parseCode(url, SECRET).ok, true);
});

test('QR signatures verify, and a wrong one is detected', () => {
  const code = 'AMX25-260921-00483-K7';
  const sig = computeSignature(code, SECRET);
  assert.equal(checkSignature(code, sig, SECRET), 'valid');
  assert.equal(checkSignature(code, 'AAAAAAAAAA', SECRET), 'invalid');
  // A typed code carries no signature; that is not a failure.
  assert.equal(checkSignature(code, null, SECRET), 'absent');
});

test('empty and malformed input are distinguished from a bad checksum', () => {
  assert.equal(parseCode('', SECRET).error, 'empty');
  assert.equal(parseCode('hello world', SECRET).error, 'malformed');
  assert.equal(parseCode('AMX25-260921-00483-K7', SECRET).error, 'checksum');
});

test('the date segment is UTC-stable', () => {
  assert.equal(dateSegment('2026-09-21'), '260921');
  assert.equal(dateSegment(new Date('2026-01-05T23:59:00Z')), '260105');
});
