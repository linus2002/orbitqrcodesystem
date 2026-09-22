/**
 * Sliding-window rate limiting.
 *
 * The field guide calls rate limiting out explicitly: without it, an attacker
 * can grind the verification API for valid codes. This is the enforcement
 * point for that, and it is applied to /api/verify, /api/report and the login
 * endpoint.
 *
 * STORE: `MemoryStore` is correct for one long-running process. On a
 * serverless platform each request may land on a different instance, so the
 * counters must be shared or the limits mean nothing - an attacker simply
 * spreads attempts across instances. `SqlStore` keeps them in the database
 * instead, and RATELIMIT_STORE=sql selects it.
 *
 * Both implement the same four methods; nothing above this file changes.
 */
import * as db from '../db/index.js';
import { config } from '../config.js';
import { tooManyRequests } from './errors.js';
import logger from './logger.js';

class MemoryStore {
  constructor() {
    /** @type {Map<string, number[]>} key -> sorted list of hit timestamps */
    this.hits = new Map();
  }

  /** Record a hit and return how many fall inside the window. */
  hit(key, windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    const list = this.hits.get(key) ?? [];
    // Drop expired entries, then append. The list stays short because it is
    // pruned on every access.
    let i = 0;
    while (i < list.length && list[i] <= cutoff) i += 1;
    const live = i > 0 ? list.slice(i) : list;
    live.push(now);
    this.hits.set(key, live);
    return live.length;
  }

  /** Count without recording (used for "am I currently blocked?" checks). */
  peek(key, windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    const list = this.hits.get(key) ?? [];
    return list.filter((t) => t > cutoff).length;
  }

  reset(key) {
    this.hits.delete(key);
  }

  /** Drop keys with no live hits so the map cannot grow without bound. */
  sweep(maxWindowMs, now = Date.now()) {
    const cutoff = now - maxWindowMs;
    for (const [key, list] of this.hits) {
      if (!list.length || list[list.length - 1] <= cutoff) this.hits.delete(key);
    }
  }
}

/**
 * The same window arithmetic, kept in the database so every instance sees the
 * same counters.
 *
 * Each call is a round trip, so this is only worth paying on a platform that
 * actually runs more than one instance - hence the switch rather than a
 * replacement.
 */
class SqlStore {
  async hit(key, windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    await db.run('INSERT INTO rate_hits (key, ts) VALUES (?, ?)', [key, now]);
    // Prune this key's expired rows as we go, so the table cannot grow
    // without a separate sweeper process to own it.
    await db.run('DELETE FROM rate_hits WHERE key = ? AND ts <= ?', [key, cutoff]);
    return Number(await db.scalar('SELECT COUNT(*) FROM rate_hits WHERE key = ? AND ts > ?', [key, cutoff]));
  }

  async peek(key, windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    return Number(await db.scalar('SELECT COUNT(*) FROM rate_hits WHERE key = ? AND ts > ?', [key, cutoff]));
  }

  async reset(key) {
    await db.run('DELETE FROM rate_hits WHERE key = ?', [key]);
  }

  async sweep(maxWindowMs, now = Date.now()) {
    await db.run('DELETE FROM rate_hits WHERE ts <= ?', [now - maxWindowMs]);
  }
}

export const store = config.rateLimit.store === 'sql' ? new SqlStore() : new MemoryStore();

// Housekeeping for the in-memory store only: the SQL store prunes per key as
// it goes, and a serverless instance is too short-lived to own a timer.
if (store instanceof MemoryStore) {
  const SWEEP_MS = 5 * 60 * 1000;
  const sweeper = setInterval(() => store.sweep(60 * 60 * 1000), SWEEP_MS);
  // Do not hold the event loop open just for housekeeping.
  if (typeof sweeper.unref === 'function') sweeper.unref();
}

/**
 * Create a reusable limiter.
 *
 * @param {object}   opts
 * @param {string}   opts.name      identifies the limiter in logs
 * @param {number}   opts.windowMs  window length
 * @param {number}   opts.max       allowed hits per window
 */
export function createLimiter({ name, windowMs, max }) {
  return {
    name,
    windowMs,
    max,
    /** Record an attempt. */
    async consume(key) {
      const count = await store.hit(`${name}:${key}`, windowMs);
      return {
        allowed: count <= max,
        count,
        remaining: Math.max(0, max - count),
        retryAfterSec: Math.ceil(windowMs / 1000),
      };
    },
    /** Inspect without consuming. */
    async inspect(key) {
      const count = await store.peek(`${name}:${key}`, windowMs);
      return { allowed: count < max, count, remaining: Math.max(0, max - count) };
    },
    async reset(key) {
      await store.reset(`${name}:${key}`);
    },
  };
}

/**
 * Express middleware wrapping one or more limiters. All supplied limiters must
 * allow the request; the first to reject produces the 429.
 *
 * @param {object}   opts
 * @param {Array}    opts.limiters
 * @param {Function} [opts.keyFn]   derive the bucket key from the request
 * @param {Function} [opts.onLimit] side effect when a request is rejected
 */
export function rateLimit({ limiters, keyFn = (req) => req.clientIp, onLimit }) {
  const list = Array.isArray(limiters) ? limiters : [limiters];

  return async function rateLimitMiddleware(req, res, next) {
    const key = keyFn(req);
    if (!key) return next();

    for (const limiter of list) {
      const result = await limiter.consume(key);
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfterSec));
        res.set('X-RateLimit-Limit', String(limiter.max));
        res.set('X-RateLimit-Remaining', '0');
        logger.warn('rate limit exceeded', {
          limiter: limiter.name,
          count: result.count,
          path: req.path,
        });
        try {
          await onLimit?.(req, result, limiter);
        } catch (err) {
          logger.error('rate limit hook failed', { error: err.message });
        }
        return next(
          tooManyRequests(
            'Too many attempts. Please wait a moment before trying again.',
            { retryAfterSeconds: result.retryAfterSec }
          )
        );
      }
      res.set('X-RateLimit-Limit', String(limiter.max));
      res.set('X-RateLimit-Remaining', String(result.remaining));
    }
    return next();
  };
}

export default { createLimiter, rateLimit, store };
