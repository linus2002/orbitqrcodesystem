/**
 * Sliding-window rate limiting.
 *
 * The field guide calls rate limiting out explicitly: without it, an attacker
 * can grind the verification API for valid codes. This is the enforcement
 * point for that, and it is applied to /api/verify, /api/report and the login
 * endpoint.
 *
 * SCALING NOTE: state is held in this process's memory, which is correct for a
 * single instance and for the pilot. Behind more than one instance, swap
 * `MemoryStore` for a Redis store implementing the same three methods - no
 * caller changes required.
 */
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

export const store = new MemoryStore();

// Housekeeping: prune anything older than the longest window we use (1 hour).
const SWEEP_MS = 5 * 60 * 1000;
const sweeper = setInterval(() => store.sweep(60 * 60 * 1000), SWEEP_MS);
// Do not hold the event loop open just for housekeeping.
if (typeof sweeper.unref === 'function') sweeper.unref();

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
    consume(key) {
      const count = store.hit(`${name}:${key}`, windowMs);
      return {
        allowed: count <= max,
        count,
        remaining: Math.max(0, max - count),
        retryAfterSec: Math.ceil(windowMs / 1000),
      };
    },
    /** Inspect without consuming. */
    inspect(key) {
      const count = store.peek(`${name}:${key}`, windowMs);
      return { allowed: count < max, count, remaining: Math.max(0, max - count) };
    },
    reset(key) {
      store.reset(`${name}:${key}`);
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

  return function rateLimitMiddleware(req, res, next) {
    const key = keyFn(req);
    if (!key) return next();

    for (const limiter of list) {
      const result = limiter.consume(key);
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
          onLimit?.(req, result, limiter);
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
