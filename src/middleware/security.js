/**
 * Security middleware: response headers, client IP resolution and CORS.
 *
 * Written out rather than pulled from `helmet` so every header choice is
 * visible and justified in one place - useful when this has to pass a
 * pharmaceutical security review.
 */
import { config } from '../config.js';

/**
 * Content-Security-Policy.
 *
 * script-src is 'self' with NO 'unsafe-inline' and NO CDN. That is the header
 * that actually stops cross-site scripting, and it is why the QR decoder is
 * vendored into /vendor instead of loaded from a CDN, and why the frontend
 * carries no inline <script> blocks.
 *
 * style-src is likewise 'self': the UI uses SVG presentation attributes and
 * CSS classes for dynamic geometry, so no inline style attribute is ever
 * needed.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:", // data:/blob: are needed for generated QR images
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:", // the camera stream for QR scanning
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'", // clickjacking: this app is never framed
  'upgrade-insecure-requests',
].join('; ');

/** Apply security headers to every response. */
export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // The portal needs the camera; it needs nothing else.
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  // Never let an intermediary cache an authenticated API response.
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  }

  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Do not advertise the stack.
  res.removeHeader('X-Powered-By');
  next();
}

/**
 * Resolve the client IP once, consistently, for rate limiting and for the
 * pseudonymised scan record.
 *
 * `req.ip` already honours the `trust proxy` setting configured in server.js.
 * Getting this wrong matters: if a proxy header were trusted blindly, an
 * attacker could spoof a new IP per request and bypass rate limiting entirely.
 */
export function clientIp(req, res, next) {
  req.clientIp = req.ip || req.socket?.remoteAddress || null;
  next();
}

/**
 * CORS.
 *
 * The portal and dashboard are served from the same origin, so cross-origin
 * access is DENIED by default. Set CORS_ORIGINS to a comma-separated allowlist
 * only if a separate front end or partner integration genuinely needs it.
 */
export function cors(req, res, next) {
  const allowed = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const origin = req.get('origin');
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(origin && allowed.includes(origin) ? 204 : 403);
  return next();
}

export default { securityHeaders, clientIp, cors };
