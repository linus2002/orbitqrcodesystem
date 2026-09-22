/**
 * Unique product code generation, formatting and validation.
 *
 * FORMAT (per the QR Shield field guide):
 *
 *      AMX25 - 260921 - 00483 - K7
 *      -----   ------   -----   --
 *        |        |       |      `- keyed checksum (2 chars), catches typos
 *        |        |       `-------- non-sequential unit serial
 *        |        `---------------- batch manufacturing date, YYMMDD
 *        `------------------------- product SKU + strength
 *
 * Two properties matter and are implemented here:
 *
 * 1. NON-SEQUENTIAL SERIALS. Unit #1 and unit #2 of a batch must not receive
 *    adjacent codes, or reading one pack tells a counterfeiter the next code.
 *    We run the unit index through a keyed format-preserving permutation
 *    (an alternating Feistel network), so serials are scattered uniformly
 *    across the whole serial space while remaining collision-free by
 *    construction. No "generate random, retry on collision" loop is needed.
 *
 * 2. KEYED CHECKSUM. The trailing 2 characters are a truncated HMAC of the
 *    rest of the code, not a public mod-N checksum. This catches typing
 *    mistakes AND means an attacker cannot mint checksum-valid codes offline,
 *    so ~99.9% of blind guesses are rejected before touching the database.
 */
import { hmac } from './crypto.js';

/**
 * Crockford Base32: excludes I, L, O and U so the checksum can never be
 * misread as a similar-looking character on a printed pack.
 */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHECK_LEN = 2; // 32^2 = 1024 possible checksums
const SIG_LEN = 10; // 32^10 = ~1.1e15, the QR-borne signature

/** Map look-alike characters onto their Crockford equivalents. */
function decodeConfusables(s) {
  return s.replace(/[ILOU]/g, (c) => ({ I: '1', L: '1', O: '0', U: 'V' })[c]);
}

/** Render a byte buffer as `len` Base32 characters. */
function toBase32(buf, len) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < len) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= len) break;
  }
  return out.padEnd(len, '0');
}

/** Domain-separated keyed digest, used for both checksum and signature. */
function keyedDigest(domain, body, secret, len) {
  return toBase32(Buffer.from(hmac(`${domain}:${body}`, secret, 'hex'), 'hex'), len);
}

/** The 2-character checksum for a code body (`SKU-YYMMDD-SERIAL`). */
export function computeChecksum(body, secret) {
  return keyedDigest('chk', body.toUpperCase(), secret, CHECK_LEN);
}

/** The 10-character signature carried inside the QR payload (never printed as text). */
export function computeSignature(code, secret) {
  return keyedDigest('sig', code.toUpperCase(), secret, SIG_LEN);
}

// ---------------------------------------------------------------------------
// Serial space sizing
// ---------------------------------------------------------------------------

/**
 * Choose how many digits the unit serial needs.
 *
 * The field guide's example uses 5 digits. We keep 5 as the floor but widen
 * automatically so the serial space is at least 100x the batch quantity. A
 * blind guess of a well-formed serial then has at most a ~1% chance of naming
 * a real unit, before rate limiting and the checksum are even applied.
 */
export function serialWidthFor(quantity, { min = 5, max = 9 } = {}) {
  let width = min;
  while (width < max && quantity * 100 > 10 ** width) width += 1;
  return width;
}

// ---------------------------------------------------------------------------
// Keyed format-preserving permutation (alternating Feistel)
// ---------------------------------------------------------------------------

/**
 * Build a bijection over [0, 10^width) keyed by `key`.
 *
 * The domain is split as a*b (e.g. 10^5 -> 1000 * 100) and we alternate
 * rounds that mix each half modulo its own size. Every round is individually
 * invertible, so the composition is a permutation for ANY round function,
 * which is what guarantees "no two units ever share a serial".
 */
export function serialPermutation(key, width, rounds = 8) {
  const domain = 10 ** width;
  const a = 10 ** Math.ceil(width / 2);
  const b = 10 ** Math.floor(width / 2);

  // Round function: keyed, deterministic, reduced to the target modulus.
  const F = (round, value, mod) => {
    const digest = hmac(`fpe:${round}:${value}`, key, 'hex').slice(0, 12);
    return Number.parseInt(digest, 16) % mod;
  };

  return function permute(index) {
    if (!Number.isInteger(index) || index < 0 || index >= domain) {
      throw new RangeError(`serial index ${index} outside domain 0..${domain - 1}`);
    }
    let L = Math.floor(index / b); // in [0, a)
    let R = index % b; // in [0, b)
    for (let i = 0; i < rounds; i++) {
      if (i % 2 === 0) L = (L + F(i, R, a)) % a;
      else R = (R + F(i, L, b)) % b;
    }
    return L * b + R;
  };
}

// ---------------------------------------------------------------------------
// Building and parsing codes
// ---------------------------------------------------------------------------

/** Format a Date (or ISO string) as the YYMMDD batch-date segment. */
export function dateSegment(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError(`invalid date: ${date}`);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** Assemble a complete code from its parts. */
export function buildCode({ sku, mfgDate, serial, width, secret }) {
  const skuSeg = String(sku).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const dateSeg =
    typeof mfgDate === 'string' && /^\d{6}$/.test(mfgDate) ? mfgDate : dateSegment(mfgDate);
  const serialSeg = String(serial).padStart(width, '0');
  const body = `${skuSeg}-${dateSeg}-${serialSeg}`;
  return `${body}-${computeChecksum(body, secret)}`;
}

/**
 * Normalise anything a human might type or a scanner might emit into the
 * canonical `SKU-YYMMDD-SERIAL-CHK` shape.
 *
 * Accepts: lower case, spaces, underscores, en/em dashes, a full QR URL, and
 * look-alike characters in the numeric and checksum segments.
 */
export function normalizeCode(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';

  // A scanned QR gives us a URL. Pull the code out of the path or ?code=.
  if (/^https?:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      s = url.searchParams.get('code') || url.pathname.split('/').filter(Boolean).pop() || '';
      s = decodeURIComponent(s);
    } catch {
      /* not a parseable URL, fall through and treat it as raw text */
    }
  }

  s = s
    .toUpperCase()
    .replace(/[‐-―_\s.]+/g, '-') // any separator run -> single dash
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const parts = s.split('-');
  if (parts.length !== 4) return s; // let parseCode report the structural error

  const [sku, date, serial, check] = parts;
  return [
    sku.replace(/[^A-Z0-9]/g, ''),
    decodeConfusables(date).replace(/[^0-9]/g, ''),
    decodeConfusables(serial).replace(/[^0-9]/g, ''),
    decodeConfusables(check).replace(/[^A-Z0-9]/g, ''),
  ].join('-');
}

const CODE_RE = /^([A-Z0-9]{2,12})-(\d{6})-(\d{4,9})-([A-Z0-9]{2})$/;

/**
 * Parse and structurally validate a code.
 *
 * Returns `{ ok: true, code, sku, dateSegment, serial, checksum }` or
 * `{ ok: false, error }` where error is 'empty' | 'malformed' | 'checksum'.
 *
 * A checksum failure is a TYPO, not a counterfeit. The caller must present
 * those two cases very differently to the patient.
 */
export function parseCode(raw, secret) {
  const code = normalizeCode(raw);
  if (!code) return { ok: false, error: 'empty' };

  const m = CODE_RE.exec(code);
  if (!m) return { ok: false, error: 'malformed', code };

  const [, sku, dateSeg, serial, checksum] = m;
  const expected = computeChecksum(`${sku}-${dateSeg}-${serial}`, secret);
  if (checksum !== expected) return { ok: false, error: 'checksum', code };

  return { ok: true, code, sku, dateSegment: dateSeg, serial, checksum };
}

/**
 * Verify the QR-borne signature.
 * An absent signature is not a failure: hand-typed codes never carry one.
 */
export function checkSignature(code, signature, secret) {
  if (!signature) return 'absent';
  const expected = computeSignature(code, secret);
  return signature.toUpperCase() === expected ? 'valid' : 'invalid';
}

/** The exact string encoded into the printed QR image for a code. */
export function qrPayload(code, secret, baseUrl) {
  return `${baseUrl}/v/${encodeURIComponent(code)}?s=${computeSignature(code, secret)}`;
}

/**
 * Generate every code for a batch.
 *
 * Yields `{ unitIndex, serial, code, signature }` lazily so a 100k-unit batch
 * never has to be materialised in memory all at once.
 */
export function* generateBatchCodes({ sku, mfgDate, quantity, batchKey, secret }) {
  const width = serialWidthFor(quantity);
  const permute = serialPermutation(`${batchKey}:${secret}`, width);
  const dateSeg = dateSegment(mfgDate);

  for (let unitIndex = 0; unitIndex < quantity; unitIndex++) {
    const serial = permute(unitIndex);
    const code = buildCode({ sku, mfgDate: dateSeg, serial, width, secret });
    yield {
      unitIndex,
      serial: String(serial).padStart(width, '0'),
      code,
      signature: computeSignature(code, secret),
    };
  }
}
