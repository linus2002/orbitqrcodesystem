/**
 * Authentication routes for the admin surface.
 */
import { Router } from 'express';
import { config } from '../config.js';
import * as authService from '../services/auth.js';
import { validate } from '../lib/validate.js';
import { createLimiter, rateLimit } from '../lib/ratelimit.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { badRequest, notFound, validationFailed } from '../lib/errors.js';
import * as db from '../db/index.js';
import * as files from '../services/files.js';

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
// POST /api/auth/tour-done - the guided tour was finished or skipped
// ---------------------------------------------------------------------------
router.post('/tour-done', requireAuth, requireCsrf, async (req, res) => {
  res.json({ user: await authService.completeTour(req.user.id) });
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
  // The bytes must BE what the data URL claims: a label is only a label.
  const bytes = Buffer.from(payload, 'base64');
  files.checkImage(bytes, { limit: MAX_AVATAR_BYTES });
  // Stored as a file where the store keeps files (Postgres, and the local
  // store); kept inline as before only on Sanity, which cannot list them.
  return db.filesIndexed() ? bytes : value;
}

router.patch('/profile', requireAuth, requireCsrf, async (req, res) => {
  /*
   * A name cannot be blanked. The form already says so, but the endpoint is
   * reachable directly. Two cases: a name of only spaces is trimmed to
   * nothing, which `min` catches; an empty string counts as "not supplied" to
   * validate() and would be silently ignored, so it is refused here instead -
   * someone clearing their name should be told no, not shown a success.
   */
  if (typeof req.body?.fullName === 'string' && req.body.fullName.trim() === '') {
    throw validationFailed([{ field: 'fullName', message: 'cannot be empty' }]);
  }
  const data = validate(req.body, {
    fullName: { type: 'string', min: 1, max: 120 },
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
// GET /api/auth/avatar/:id - a staff member's picture
// ---------------------------------------------------------------------------
/**
 * Staff only: a picture of a member of staff is not for the public. The id
 * changes with every upload, so the response can be cached for good.
 */
router.get('/avatar/:id', requireAuth, async (req, res) => {
  const info = await db.fileInfo(req.params.id);
  if (!info || info.kind !== 'avatar') throw notFound('No such picture');
  const bytes = await db.readFile(info.id);
  if (!bytes) throw notFound('No such picture');
  res.setHeader('Content-Type', info.contentType);
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.end(bytes);
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
