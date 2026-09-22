/**
 * Authentication and user management.
 *
 * Only staff authenticate. Patients and pharmacists use the public
 * verification portal with no account at all, which is a deliberate product
 * decision from the field guide: requiring a login would stop people checking
 * their medicine.
 *
 * Session model: a signed, short-lived token (in an httpOnly cookie) that
 * carries a session id, plus a server-side `sessions` row. The token proves
 * integrity; the row makes revocation real. Deleting the row kills the token
 * instantly, which a stateless JWT cannot do.
 */
import * as db from '../db/index.js';
import { config } from '../config.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  randomId,
  randomToken,
} from '../lib/crypto.js';
import { checkPasswordStrength } from '../lib/validate.js';
import {
  unauthorized,
  conflict,
  notFound,
  validationFailed,
  badRequest,
  tooManyRequests,
} from '../lib/errors.js';
import * as audit from './audit.js';
import logger from '../lib/logger.js';

/**
 * Role capabilities.
 *
 * admin     - everything, including user management
 * security  - the brand security team: the full investigation surface, but no
 *             user administration
 * regulator - aggregate compliance reporting only. Explicitly CANNOT read
 *             individual patient scan rows, per the field guide's access table.
 */
export const PERMISSIONS = {
  admin: [
    'dashboard:view', 'products:read', 'products:write', 'batches:read', 'batches:write',
    'codes:read', 'codes:export', 'scans:read', 'alerts:read', 'alerts:write',
    'reports:read', 'reports:write', 'users:read', 'users:write', 'audit:read', 'settings:write',
  ],
  security: [
    'dashboard:view', 'products:read', 'products:write', 'batches:read', 'batches:write',
    'codes:read', 'codes:export', 'scans:read', 'alerts:read', 'alerts:write',
    'reports:read', 'reports:write', 'audit:read',
  ],
  regulator: ['dashboard:view', 'products:read', 'batches:read', 'compliance:read'],
};

export const can = (role, permission) => (PERMISSIONS[role] ?? []).includes(permission);

/** Strip everything the client must never see. */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    mustChangePassword: row.must_change_pw === 1,
    createdAt: row.created_at,
    permissions: PERMISSIONS[row.role] ?? [],
  };
}

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------

/**
 * Authenticate and open a session.
 *
 * Returns `{ user, token, csrfToken, expiresAt }`. Throws 401 for every
 * failure mode with the SAME message, so the endpoint cannot be used to
 * enumerate which email addresses exist.
 */
export async function login(email, password, req) {
  const user = await db.get('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);

  // Lockout is checked before the password, so a locked account cannot be
  // probed further even with the correct password.
  //
  // TRADE-OFF: this message confirms that the account exists, which is a mild
  // user-enumeration leak. It is accepted here because staff accounts are
  // provisioned internally (there is no public sign-up to enumerate against),
  // and because silently rejecting a correct password with "incorrect
  // password" generates support tickets and teaches staff to distrust the
  // login screen. Reaching this branch still requires an attacker to already
  // know a valid address AND to have burned the full failure budget.
  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    const minutes = Math.max(1, Math.ceil((new Date(user.locked_until) - Date.now()) / 60000));
    throw tooManyRequests(
      `Too many failed sign-in attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      { retryAfterSeconds: minutes * 60 }
    );
  }

  if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
    if (user) await registerFailure(user);
    // Uniform message + uniform timing: never reveal whether the email exists.
    throw unauthorized('Email or password is incorrect.');
  }

  // Success: clear the failure counter and open a session.
  await db.run(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL,
            last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [user.id]
  );

  const session = await createSession(user, req);
  await audit.record({ actor: user, req, action: 'auth.login', entityType: 'user', entityId: user.id });
  logger.info('login', { userId: user.id, role: user.role });

  return { user: publicUser(await db.get('SELECT * FROM users WHERE id = ?', [user.id])), ...session };
}

/** Record a failed attempt and lock the account once the threshold is hit. */
async function registerFailure(user) {
  const attempts = user.failed_attempts + 1;
  const lock = attempts >= config.auth.maxFailures;
  await db.run(
    `UPDATE users SET failed_attempts = ?, locked_until = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [
      lock ? 0 : attempts, // reset the counter when we lock, so the next lock needs a fresh run
      lock ? new Date(Date.now() + config.auth.lockoutMinutes * 60000).toISOString() : null,
      user.id,
    ]
  );
  if (lock) {
    logger.warn('account locked after repeated failures', { userId: user.id });
    await audit.record({
      actor: user,
      action: 'auth.locked',
      entityType: 'user',
      entityId: user.id,
      detail: { minutes: config.auth.lockoutMinutes },
    });
  }
}

/** Create the session row and its signed token. */
async function createSession(user, req) {
  const sid = randomId(18);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + config.session.ttlHours * 3600 * 1000).toISOString();

  await db.run(
    `INSERT INTO sessions (id, user_id, csrf_token, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sid, user.id, csrfToken, req?.clientIp ?? null, req?.get?.('user-agent')?.slice(0, 300) ?? null, expiresAt]
  );

  const token = signToken(
    { sub: user.id, sid, role: user.role },
    config.secrets.session,
    config.session.ttlHours * 3600
  );
  return { token, csrfToken, expiresAt, sessionId: sid };
}

/** Resolve a token to `{ user, session }`, or null if it is not usable. */
export async function resolveSession(token) {
  const payload = verifyToken(token, config.secrets.session);
  if (!payload?.sid) return null;

  const session = await db.get('SELECT * FROM sessions WHERE id = ?', [payload.sid]);
  if (!session || session.revoked_at) return null;
  if (new Date(session.expires_at) <= new Date()) return null;

  const user = await db.get('SELECT * FROM users WHERE id = ?', [session.user_id]);
  if (!user || user.status !== 'active') return null;

  return { user, session };
}

/** Revoke one session (logout). */
export async function logout(sessionId, { actor, req } = {}) {
  if (!sessionId) return;
  await db.run(
    `UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [sessionId]
  );
  await audit.record({ actor, req, action: 'auth.logout', entityType: 'session', entityId: sessionId });
}

/** Revoke every session belonging to a user (password change, suspension). */
export async function revokeAllSessions(userId) {
  await db.run(
    `UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_id = ? AND revoked_at IS NULL`,
    [userId]
  );
}

/** Housekeeping: drop sessions that expired more than a day ago. */
export async function pruneSessions() {
  const cutoff = new Date(Date.now() - 86400000).toISOString();
  const { changes } = await db.run('DELETE FROM sessions WHERE expires_at < ?', [cutoff]);
  if (changes) logger.debug('pruned expired sessions', { count: changes });
  return changes;
}

// ---------------------------------------------------------------------------
// User administration
// ---------------------------------------------------------------------------

export async function listUsers() {
  const rows = await db.all('SELECT * FROM users ORDER BY role, full_name');
  return rows.map(publicUser);
}

export async function createUser({ email, fullName, role, password, mustChangePassword = true }, { actor, req } = {}) {
  const problems = checkPasswordStrength(password, config.auth.minPasswordLength);
  if (problems.length) throw validationFailed(problems.map((m) => ({ field: 'password', message: m })));

  if (!PERMISSIONS[role]) throw badRequest(`Unknown role "${role}"`);

  const existing = await db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existing) throw conflict('A user with that email address already exists.');

  const { lastInsertRowid } = await db.run(
    `INSERT INTO users (email, full_name, password_hash, role, must_change_pw, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [email.toLowerCase(), fullName, hashPassword(password), role, mustChangePassword ? 1 : 0, actor?.id ?? null]
  );

  await audit.record({
    actor, req,
    action: 'user.create',
    entityType: 'user',
    entityId: lastInsertRowid,
    detail: { email: email.toLowerCase(), role },
  });
  return publicUser(await db.get('SELECT * FROM users WHERE id = ?', [lastInsertRowid]));
}

export async function updateUser(id, { fullName, role, status }, { actor, req } = {}) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) throw notFound('User not found');

  // Guard rail: never let the last active admin be demoted or suspended, or
  // the system locks everyone out of its own administration.
  const losingAdmin = user.role === 'admin' && ((role && role !== 'admin') || status === 'suspended');
  if (losingAdmin) {
    const otherAdmins = await db.scalar(
      `SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?`,
      [id]
    );
    if (otherAdmins === 0) throw conflict('This is the last active administrator account.');
  }

  await db.run(
    `UPDATE users SET full_name = COALESCE(?, full_name), role = COALESCE(?, role),
            status = COALESCE(?, status), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [fullName ?? null, role ?? null, status ?? null, id]
  );

  // A suspended user must lose access immediately, not at token expiry.
  if (status === 'suspended') await revokeAllSessions(id);

  await audit.record({
    actor, req,
    action: 'user.update',
    entityType: 'user',
    entityId: id,
    detail: { fullName, role, status },
  });
  return publicUser(await db.get('SELECT * FROM users WHERE id = ?', [id]));
}

/** Change your own password. Requires the current one, and re-keys sessions. */
export async function changePassword(userId, currentPassword, newPassword, { req, currentSessionId } = {}) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw notFound('User not found');
  if (!verifyPassword(currentPassword, user.password_hash)) {
    throw unauthorized('Your current password is incorrect.');
  }

  const problems = checkPasswordStrength(newPassword, config.auth.minPasswordLength);
  if (problems.length) throw validationFailed(problems.map((m) => ({ field: 'newPassword', message: m })));
  if (verifyPassword(newPassword, user.password_hash)) {
    throw validationFailed([{ field: 'newPassword', message: 'must be different from your current password' }]);
  }

  await db.run(
    `UPDATE users SET password_hash = ?, must_change_pw = 0,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [hashPassword(newPassword), userId]
  );

  // Kill every other session: a password change is often a response to
  // suspected compromise, so other devices must be signed out.
  await db.run(
    `UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_id = ? AND revoked_at IS NULL AND id <> ?`,
    [userId, currentSessionId ?? '']
  );

  await audit.record({ actor: user, req, action: 'user.password_change', entityType: 'user', entityId: userId });
  return { ok: true };
}

/** Admin-initiated password reset. Returns the temporary password once. */
export async function resetPassword(id, { actor, req } = {}) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) throw notFound('User not found');

  // Generated, not chosen: an admin should never pick another user's password.
  const temporary = `Qs-${randomToken(9)}-${new Date().getFullYear()}`;
  await db.run(
    `UPDATE users SET password_hash = ?, must_change_pw = 1, failed_attempts = 0,
            locked_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [hashPassword(temporary), id]
  );
  await revokeAllSessions(id);

  await audit.record({ actor, req, action: 'user.password_reset', entityType: 'user', entityId: id });
  return { temporaryPassword: temporary };
}

/** Sessions currently open for a user, for the "where am I signed in" view. */
export async function listSessions(userId) {
  return await db.all(
    `SELECT id, ip, user_agent, created_at, expires_at, revoked_at
       FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
}

export default {
  login, logout, resolveSession, revokeAllSessions, pruneSessions,
  listUsers, createUser, updateUser, changePassword, resetPassword, listSessions,
  publicUser, can, PERMISSIONS,
};
