/**
 * Authentication routes for the admin surface.
 */
import { Router } from 'express';
import { config } from '../config.js';
import * as authService from '../services/auth.js';
import { validate } from '../lib/validate.js';
import { createLimiter, rateLimit } from '../lib/ratelimit.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { badRequest } from '../lib/errors.js';

const router = Router();

/**
 * Login limiter keyed by IP *and* submitted email, so one attacker cannot
 * lock every account from a single address, and a distributed attack against
 * one account is still throttled.
 */
const loginLimiter = createLimiter({
  name: 'login',
  windowMs: 15 * 60_000,
  max: config.rateLimit.loginPer15Min,
});

/** Cookie options shared by set and clear, so they always match. */
function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true, // JavaScript can never read the session token
    secure: config.session.cookieSecure, // HTTPS only in production
    sameSite: 'strict', // primary CSRF defence
    path: '/',
    maxAge: maxAgeMs,
  };
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
router.post(
  '/login',
  rateLimit({
    limiters: [loginLimiter],
    keyFn: (req) => `${req.clientIp}|${String(req.body?.email ?? '').toLowerCase()}`,
  }),
  async (req, res) => {
    const { email, password } = validate(req.body, {
      email: { type: 'email', required: true },
      password: { type: 'string', required: true, max: 200 },
    });

    const { user, token, csrfToken, expiresAt } = await authService.login(email, password, req);
    const maxAge = config.session.ttlHours * 3600 * 1000;

    res.cookie(config.session.cookieName, token, cookieOptions(maxAge));
    // The CSRF token is readable by JavaScript on purpose - that is what makes
    // the double-submit check possible. It is useless without the httpOnly
    // session cookie that an attacker cannot read.
    res.cookie(config.session.csrfCookieName, csrfToken, {
      ...cookieOptions(maxAge),
      httpOnly: false,
    });

    res.json({ user, csrfToken, expiresAt });
  }
);

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
router.post('/logout', requireAuth, requireCsrf, async (req, res) => {
  await authService.logout(req.session.id, { actor: req.user, req });
  res.clearCookie(config.session.cookieName, cookieOptions());
  res.clearCookie(config.session.csrfCookieName, { ...cookieOptions(), httpOnly: false });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me - who am I, and what may I do
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: authService.publicUser(req.user),
    csrfToken: req.session.csrf_token,
    sessionExpiresAt: req.session.expires_at,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/change-password
// ---------------------------------------------------------------------------
router.post('/change-password', requireAuth, requireCsrf, async (req, res) => {
  const { currentPassword, newPassword } = validate(req.body, {
    currentPassword: { type: 'string', required: true, max: 200 },
    newPassword: { type: 'string', required: true, max: 200 },
  });

  await authService.changePassword(req.user.id, currentPassword, newPassword, {
    req,
    currentSessionId: req.session.id,
  });

  res.json({ ok: true, message: 'Password changed. Other devices have been signed out.' });
});

// ---------------------------------------------------------------------------
// PATCH /api/auth/profile - change your own name and picture
// ---------------------------------------------------------------------------

/** 200KB of data URL. The browser sends about 30KB after resizing. */
const MAX_AVATAR_BYTES = 200 * 1024;

/** Only raster formats a browser will render inline, and never SVG. */
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Check an uploaded avatar.
 *
 * The browser downsizes before uploading, but that is a convenience, not a
 * control: this endpoint is reachable directly. SVG is refused outright
 * because an SVG is a document that can carry script, and this one would be
 * served from our own origin and rendered in another user's page.
 */
function checkAvatar(value) {
  if (value === null) return null;

  const m = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(value));
  if (!m) throw badRequest('That picture could not be read. Upload a JPEG, PNG or WebP.');

  const [, mime, payload] = m;
  if (!AVATAR_TYPES.includes(mime)) {
    throw badRequest('Upload a JPEG, PNG or WebP image.');
  }
  if (Buffer.byteLength(payload, 'base64') > MAX_AVATAR_BYTES) {
    throw badRequest('That picture is too large. Choose one under 200KB.');
  }
  return value;
}

router.patch('/profile', requireAuth, requireCsrf, async (req, res) => {
  const data = validate(req.body, {
    fullName: { type: 'string', max: 120 },
    // `avatar` is handled outside validate(): it is a data URL, not a field
    // shape the validator knows about.
  });

  const patch = {};
  if (data.fullName !== undefined) patch.fullName = data.fullName;
  if ('avatar' in req.body) patch.avatar = checkAvatar(req.body.avatar);

  const user = await authService.updateProfile(req.user.id, patch, { req });
  res.json({ user });
});

// ---------------------------------------------------------------------------
// GET /api/auth/sessions - where am I signed in
// ---------------------------------------------------------------------------
router.get('/sessions', requireAuth, async (req, res) => {
  res.json({
    items: (await authService.listSessions(req.user.id)).map((s) => ({
      ...s,
      current: s.id === req.session.id,
    })),
  });
});

export default router;
