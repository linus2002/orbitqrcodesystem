/**
 * Cryptographic helpers.
 *
 * Deliberately built on `node:crypto` only — no bcrypt/jsonwebtoken native or
 * third-party dependency. Everything here is standard, audited primitive use:
 *
 *   - passwords  : scrypt (memory-hard KDF) with a per-user random salt
 *   - sessions   : compact HMAC-SHA256 signed tokens (JWT-shaped, HS256)
 *   - QR codes   : truncated HMAC-SHA256 signature bound to each serial
 *   - comparisons: always timing-safe
 */
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

// scrypt cost parameters. N=2^15 keeps a single hash around ~100ms on typical
// server hardware, which is a sane brute-force cost/latency trade-off.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** Hash a plaintext password into a self-describing storage string. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(normalize(password), salt, SCRYPT.keylen, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

/**
 * Verify a password against a stored hash. Returns false (never throws) for
 * malformed records so a corrupt row can't crash the login path.
 */
export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(normalize(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Unicode-normalise so visually identical passwords hash identically.
const normalize = (s) => String(s).normalize('NFKC');

/** Length-safe constant-time buffer comparison. */
export function timingSafeEqual(a, b) {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  // crypto.timingSafeEqual throws on length mismatch, which would itself leak
  // length. Hash both sides first so the comparison is always equal-length.
  const ha = crypto.createHash('sha256').update(bufA).digest();
  const hb = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

export function hmac(data, secret, encoding = 'base64url') {
  return crypto.createHmac('sha256', secret).update(String(data)).digest(encoding);
}

/** One-way, salted digest for values we must correlate but never store raw. */
export function pseudonymize(value, secret) {
  if (value === null || value === undefined || value === '') return null;
  return hmac(`pii:${value}`, secret, 'hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Session tokens (JWT-shaped, HS256)
// ---------------------------------------------------------------------------

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/**
 * Issue a signed token. `payload.sub` is the user id, `payload.sid` the
 * server-side session row id — the session row is what makes revocation work,
 * so a stolen token dies the moment the session is deleted.
 */
export function signToken(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u({ ...payload, iat: now, exp: now + ttlSeconds });
  const signature = hmac(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

/** Verify signature + expiry. Returns the payload, or null if anything is off. */
export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = hmac(`${header}.${body}`, secret);
  if (!timingSafeEqual(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Random identifiers
// ---------------------------------------------------------------------------

export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Cryptographically uniform integer in [0, max) — no modulo bias. */
export function randomInt(max) {
  return crypto.randomInt(0, max);
}

export { crypto };
