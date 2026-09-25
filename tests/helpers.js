/**
 * Test harness.
 *
 * Each suite gets a fresh in-memory database and a real HTTP server on an
 * ephemeral port, so the tests exercise the actual middleware stack -
 * security headers, rate limiting, CSRF, the lot - rather than calling service
 * functions directly and assuming the wiring works.
 */
// MUST be first: it sets the test environment before config.js is evaluated.
import './setup-env.js';

import { after } from 'node:test';

import * as db from '../src/db/index.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/lib/crypto.js';
import * as serialization from '../src/services/serialization.js';

/*
 * Close the database when a test file finishes.
 *
 * freshDb() closes the previous connection before opening the next, but
 * nothing closed the last one, so every test process exited holding a live
 * native libSQL connection - and occasionally segfaulted tearing it down
 * (exit 139 after every test had passed, reported only as 'test failed').
 * Seen in about 1 full-suite run in 5, and only under load: 3 crashes in 96
 * parallel runs of verification.test.js as it was, 0 in 96 with this.
 *
 * Registered here, at the top level of the shared helper, so it applies once
 * to every file that imports it - which is every file that opens a database.
 * Closing is idempotent, so files that close things themselves are unaffected.
 */
after(async () => {
  await db.close();
});

/**
 * A clean database for one test.
 *
 * On SQLite that means a brand new in-memory one. On Postgres the server is
 * shared, so the schema is applied once and every table emptied instead.
 */
export async function freshDb() {
  if (config.db.postgresUrl) {
    db.open();
    await db.migrate({ silent: true });
    await db.resetForTests();
    return db;
  }
  await db.close();
  db.open(':memory:');
  await db.migrate({ silent: true });
  return db;
}

/** Minimal but realistic fixture: one product, one released batch with codes. */
export async function seedBasics({ quantity = 40, expiryDays = 700 } = {}) {
  const expiry = new Date(Date.now() + expiryDays * 86400000).toISOString().slice(0, 10);

  await db.run(
    `INSERT INTO products (sku, name, strength, dosage_form, manufacturer)
     VALUES ('AMX25', 'Amoxicillin', '250 mg', 'Capsule', 'Northbridge')`
  );
  await db.run(
    `INSERT INTO leaflets (product_id, version, sections_json)
     VALUES (1, '1.0', ?)`,
    [JSON.stringify([{ heading: 'Dosage', body: 'One capsule three times a day.' }])]
  );
  await db.run(
    `INSERT INTO batches (batch_number, product_id, mfg_date, expiry_date, quantity, leaflet_id)
     VALUES ('AMX25-T1', 1, '2026-09-01', ?, ?, 1)`,
    [expiry, quantity]
  );

  await serialization.issueCodes(1, {});
  await serialization.transition(1, 'printed', {});
  await serialization.transition(1, 'released', {});

  return {
    batchId: 1,
    productId: 1,
    codes: (await db.all('SELECT * FROM codes WHERE batch_id = 1 ORDER BY unit_index')).map((c) => c.code),
  };
}

/** Create a staff account. */
export async function seedUser({ email, password, role = 'admin', name = 'Test User' }) {
  const { lastInsertRowid } = await db.run(
    `INSERT INTO users (email, full_name, password_hash, role) VALUES (?,?,?,?)`,
    [email.toLowerCase(), name, hashPassword(password), role]
  );
  return lastInsertRowid;
}

/**
 * Start the real app on an ephemeral port.
 * Returns a small client that keeps cookies and the CSRF token, so tests read
 * the way a browser behaves.
 */
export async function startServer() {
  const { createApp } = await import('../src/server.js');
  const app = createApp();

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const cookies = new Map();
  let csrf = null;

  function cookieHeader() {
    return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function storeCookies(res) {
    // Node exposes multiple Set-Cookie headers via getSetCookie().
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' ) cookies.delete(name);
      else cookies.set(name, value);
      if (name === 'qrs_csrf') csrf = decodeURIComponent(value);
    }
  }

  const client = {
    base,

    /**
     * @param {object} [opts]
     * @param {string} [opts.fromIp] simulate a different device.
     *   The app trusts X-Forwarded-For only from loopback, which is exactly
     *   where these tests run, so this is the supported way to make two
     *   requests look like two different patients.
     */
    async request(path, { method = 'GET', body, headers = {}, fromIp } = {}) {
      const h = { ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (cookies.size) h.Cookie = cookieHeader();
      if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) h['X-CSRF-Token'] = csrf;
      if (fromIp) h['X-Forwarded-For'] = fromIp;

      const res = await fetch(`${base}${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      storeCookies(res);

      const type = res.headers.get('content-type') ?? '';
      const payload = type.includes('application/json') ? await res.json() : await res.text();
      return { status: res.status, body: payload, headers: res.headers };
    },

    get: (p, o) => client.request(p, { ...o, method: 'GET' }),
    post: (p, body, o) => client.request(p, { ...o, method: 'POST', body }),
    patch: (p, body, o) => client.request(p, { ...o, method: 'PATCH', body }),

    /** Send a binary body (a PDF chunk), with the session cookies and CSRF token. */
    async raw(path, { method = 'PUT', body, contentType = 'application/octet-stream' } = {}) {
      const h = { 'Content-Type': contentType };
      if (cookies.size) h.Cookie = cookieHeader();
      if (csrf) h['X-CSRF-Token'] = csrf;
      const res = await fetch(`${base}${path}`, { method, headers: h, body });
      storeCookies(res);
      const type = res.headers.get('content-type') ?? '';
      const payload = type.includes('application/json') ? await res.json() : await res.text();
      return { status: res.status, body: payload, headers: res.headers };
    },

    /** Sign in and keep the session for subsequent calls. */
    async login(email, password) {
      const res = await client.post('/api/auth/login', { email, password });
      return res;
    },

    /** Drop the session without signing out (simulates a fresh browser). */
    clearCookies() {
      cookies.clear();
      csrf = null;
    },

    /** Send a request deliberately WITHOUT the CSRF header. */
    async postNoCsrf(path, body) {
      const h = { 'Content-Type': 'application/json' };
      if (cookies.size) h.Cookie = cookieHeader();
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(body),
      });
      return { status: res.status };
    },

    close: () => new Promise((r) => server.close(r)),
  };

  return client;
}

/**
 * The details the portal asks for before it will check a pack.
 *
 * Most suites want checking to just work, so their beforeEach calls
 * giveDetails() right after clearCookies(); details.test.js is where the gate
 * itself is exercised.
 */
export const DETAILS = {
  fullName: 'Maria Santos',
  phone: '0917 123 4567',
  email: 'Maria@gmail.com',
  role: 'patient',
  city: 'Quezon City',
  consent: true,
};

/** Give the portal details for this client, so verification is allowed. */
export async function giveDetails(client, overrides = {}) {
  return client.post('/api/portal/details', { ...DETAILS, ...overrides });
}

/** Clear rate-limit state between tests, whichever store is in use. */
export async function resetRateLimits() {
  const { store } = await import('../src/lib/ratelimit.js');
  if (store.hits) {
    store.hits.clear();          // MemoryStore
  } else {
    await db.run('DELETE FROM rate_hits');  // SqlStore
  }
}
