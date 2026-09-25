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
 * spreads attempts across instances. `DbStore` keeps them in the Sanity
 * dataset instead, and RATELIMIT_STORE=db selects it (the default whenever
 * Sanity is configured).
 *
 * Both implement the same four methods; nothing above this file changes.
 */
import crypto from 'node:crypto';
import * as db from '../db/index.js';
import { config } from '../config.js';
import { pseudonymize } from './crypto.js';
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
 * The same window arithmetic, kept in the Sanity dataset so every instance
 * sees the same counters.
 *
 * One document per limiter key, holding that key's recent hit times. A hit is
 * a single request: create the bucket if it is new and append the hit, in one
 * transaction, which hands back the bucket with every instance's hits in it.
 * The append is performed by the Lake, so two instances recording at the same
 * moment both land - neither overwrites the other.
 *
 * The key is stored only as a keyed digest. Limiter keys carry the client IP
 * and, for login, the email typed; neither belongs in the dataset in clear.
 *
 * Each call is a round trip, so this is only worth paying on a platform that
 * actually runs more than one instance - hence the switch rather than a
 * replacement.
 */
class DbStore {
  docId(key) {
    return `rateLimit-${pseudonymize(key, config.secrets.session)}`;
  }

  async hit(key, windowMs, now = Date.now()) {
    const id = this.docId(key);
    const cutoff = now - windowMs;
    const [, bucket] = await db.backend().mutate([
      { createIfNotExists: { _id: id, _type: 'rateLimit', hits: [] } },
      {
        patch: {
          id,
          set: { last: now },
          insert: { after: 'hits[-1]', items: [{ _key: crypto.randomBytes(6).toString('hex'), ts: now }] },
        },
      },
    ]);

    const hits = bucket?.hits ?? [];
    const live = hits.filter((h) => h.ts > cutoff);

    // Drop expired hits so a bucket cannot grow without bound. Guarded by the
    // revision just read: if another instance appended meanwhile, this prune
    // is skipped rather than allowed to erase that hit - the next one prunes.
    if (live.length < hits.length) {
      db.backend()
        .mutate([{ patch: { id, ifRevisionID: bucket._rev, set: { hits: live } } }])
        .catch(() => {});
    }

    // Now and then, clear out buckets nobody has touched in a day.
    if (Math.random() < 0.01) this.sweep(24 * 3600 * 1000, now).catch(() => {});

    return live.length;
  }

  async peek(key, windowMs, now = Date.now()) {
    const bucket = await db.backend().getDocument(this.docId(key));
    return (bucket?.hits ?? []).filter((h) => h.ts > now - windowMs).length;
  }

  async reset(key) {
    await db.backend().mutate([{ delete: { id: this.docId(key) } }]);
  }

  async sweep(maxWindowMs, now = Date.now()) {
    const ids = await db.backend().fetch('*[_type == "rateLimit" && last < $cutoff][0...200]._id', {
      cutoff: now - maxWindowMs,
    });
    if (ids.length) await db.backend().mutate(ids.map((id) => ({ delete: { id } })));
  }
}

export const store = config.rateLimit.store === 'db' ? new DbStore() : new MemoryStore();

// Housekeeping for the in-memory store only: the shared store prunes per key
// as it goes, and a serverless instance is too short-lived to own a timer.
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
