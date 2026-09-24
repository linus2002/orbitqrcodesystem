/**
 * Editing your own profile.
 *
 * The interesting cases are all refusals. This is the one endpoint where a
 * person writes to their own user row, so it is the obvious place to try to
 * change a role, an email or a status - and an avatar is the one place a user
 * can put a file on an origin that other users' browsers will render.
 */
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedUser, startServer, resetRateLimits } from './helpers.js';
import * as db from '../src/db/index.js';

/** A real 1x1 PNG, so the data URL is genuinely decodable. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let client;

before(async () => {
  client = await startServer();
});

beforeEach(async () => {
  await freshDb();
  await resetRateLimits();
  await seedUser({ email: 'staff@example.com', password: 'Orbit-Admin-2026', role: 'admin' });
  client.clearCookies();
  await client.login('staff@example.com', 'Orbit-Admin-2026');
});

after(async () => {
  await client.close();
});

test('a person can change their own display name', async () => {
  const res = await client.patch('/api/auth/profile', { fullName: 'Renamed Person' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.fullName, 'Renamed Person');
  assert.equal(await db.scalar('SELECT full_name FROM users'), 'Renamed Person');
});

test('a display name cannot be blanked through the API', async () => {
  const before = await db.scalar('SELECT full_name FROM users');

  // Only spaces: trimmed to nothing, which used to be stored.
  const spaces = await client.patch('/api/auth/profile', { fullName: '    ' });
  // Empty: used to be silently ignored with a 200.
  const empty = await client.patch('/api/auth/profile', { fullName: '' });

  assert.equal(spaces.status, 422);
  assert.equal(empty.status, 422, 'refused, not reported as a success');
  assert.equal(await db.scalar('SELECT full_name FROM users'), before, 'the name is unchanged');
});

test('leaving the name out still lets the picture be changed on its own', async () => {
  const before = await db.scalar('SELECT full_name FROM users');

  const res = await client.patch('/api/auth/profile', { avatar: null });

  assert.equal(res.status, 200);
  assert.equal(await db.scalar('SELECT full_name FROM users'), before);
});

test('an avatar is stored and can be cleared again', async () => {
  const set = await client.patch('/api/auth/profile', { avatar: TINY_PNG });
  assert.equal(set.status, 200);
  assert.equal(set.body.user.avatar, TINY_PNG);

  const cleared = await client.patch('/api/auth/profile', { avatar: null });
  assert.equal(cleared.body.user.avatar, null);
  assert.equal(await db.scalar('SELECT avatar FROM users'), null);
});

test('an SVG avatar is refused', async () => {
  /*
   * An SVG is a document that can carry script, and this one would be served
   * from our own origin and rendered inside another user's page. The size cap
   * would not help: a hostile SVG is tiny.
   */
  const res = await client.patch('/api/auth/profile', {
    avatar: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /JPEG, PNG or WebP/);
  assert.equal(await db.scalar('SELECT avatar FROM users'), null);
});

test('an avatar over the size cap is refused', async () => {
  const res = await client.patch('/api/auth/profile', {
    avatar: `data:image/jpeg;base64,${'A'.repeat(400_000)}`,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /too large/);
});

test('a remote URL is not accepted as an avatar', async () => {
  // Would turn every page showing this user into a request to someone else's
  // server, and the strict img-src CSP would block it anyway.
  const res = await client.patch('/api/auth/profile', {
    avatar: 'https://evil.example/pixel.png',
  });
  assert.equal(res.status, 400);
});

test('role, status and email cannot be changed through the profile', async () => {
  const before = await db.get('SELECT email, role, status FROM users');

  const res = await client.patch('/api/auth/profile', {
    fullName: 'Still Me',
    role: 'admin',
    status: 'active',
    email: 'attacker@example.com',
    mustChangePassword: false,
  });
  assert.equal(res.status, 200, 'the recognised field is still applied');

  const after = await db.get('SELECT email, role, status FROM users');
  assert.deepEqual(after, before, 'nothing else moved');
  assert.equal(res.body.user.fullName, 'Still Me');
});

test('the endpoint refuses an anonymous caller', async () => {
  client.clearCookies();
  const res = await client.patch('/api/auth/profile', { fullName: 'Nobody' });
  assert.equal(res.status, 401);
});
