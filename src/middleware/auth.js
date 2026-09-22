/**
 * Authentication and authorisation middleware.
 *
 * Three layers, applied in order:
 *   attachUser        - resolves a session if one is present (never rejects)
 *   requireAuth       - rejects anonymous requests
 *   requirePermission - rejects authenticated-but-not-entitled requests
 *   requireCsrf       - rejects cross-site state changes
 */
import { config } from '../config.js';
import * as authService from '../services/auth.js';
import { unauthorized, forbidden } from '../lib/errors.js';

/**
 * Attach `req.user` / `req.session` when the caller presents a valid session.
 * Accepts either the httpOnly cookie (browser) or a Bearer token (API client).
 */
export async function attachUser(req, res, next) {
  const bearer = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = req.cookies?.[config.session.cookieName] ?? bearer;
  if (!token) return next();

  const resolved = await authService.resolveSession(token);
  if (resolved) {
    req.user = resolved.user;
    req.session = resolved.session;
    req.authVia = bearer && !req.cookies?.[config.session.cookieName] ? 'bearer' : 'cookie';
  }
  return next();
}

/** Reject anonymous callers. */
export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized('Please sign in to continue.'));
  return next();
}

/**
 * Reject callers whose role lacks `permission`.
 * This is the single enforcement point for the role matrix in services/auth.js.
 */
export function requirePermission(permission) {
  return function permissionGuard(req, res, next) {
    if (!req.user) return next(unauthorized('Please sign in to continue.'));
    if (!authService.can(req.user.role, permission)) {
      return next(forbidden(`Your role (${req.user.role}) cannot perform this action.`));
    }
    return next();
  };
}

/**
 * CSRF protection, double-submit style.
 *
 * The session cookie is SameSite=Strict, which already blocks the classic
 * cross-site form post. This is defence in depth for the cases SameSite does
 * not cover (older browsers, and same-site-but-untrusted subdomains): a state-
 * changing request must echo the CSRF token in a header, which a cross-origin
 * attacker cannot read.
 *
 * Bearer-token API clients are exempt, because a token in an Authorization
 * header is never attached automatically by the browser - there is no CSRF
 * vector to defend against.
 */
export function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session) return next();
  if (req.authVia === 'bearer') return next();

  const presented = req.get('x-csrf-token') ?? req.body?.csrfToken;
  if (!presented || presented !== req.session.csrf_token) {
    return next(forbidden('Your session could not be verified. Please refresh the page and try again.'));
  }
  return next();
}

export default { attachUser, requireAuth, requirePermission, requireCsrf };
