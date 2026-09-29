/**
 * SMS gateway webhook.
 *
 * Your telecom provider POSTs inbound texts here. The endpoint is public (the
 * gateway cannot hold a session) so it is protected by a shared secret and by
 * its own rate limit.
 *
 * Twilio example configuration:
 *   Messaging -> A message comes in -> Webhook
 *   https://your-host/api/sms/inbound?key=YOUR_SMS_WEBHOOK_SECRET
 */
import { Router } from 'express';
import { config } from '../config.js';
import * as sms from '../services/sms.js';
import { timingSafeEqual } from '../lib/crypto.js';
import { createLimiter, rateLimit } from '../lib/ratelimit.js';
import { AppError, forbidden, badRequest } from '../lib/errors.js';
import { normalizePhone } from '../services/verifiers.js';

const router = Router();

const smsLimiter = createLimiter({ name: 'sms-inbound', windowMs: 60_000, max: 60 });

// Each sender is limited as a web visitor is. Every text arrives from the
// gateway's one address, so an address-keyed limit is a single bucket shared
// by the whole country; the sender's number is the fair key.
const perNumberMinute = createLimiter({ name: 'sms-number-min', windowMs: 60_000, max: config.rateLimit.verifyPerMin });
const perNumberHour = createLimiter({ name: 'sms-number-hour', windowMs: 3_600_000, max: config.rateLimit.verifyPerHour });
const sender = (req) => {
  const from = req.body?.from ?? req.body?.From;
  return from ? normalizePhone(from) ?? String(from) : null;
};

/**
 * Shared-secret check, accepted from a header or a query parameter because
 * gateways differ in what they can send. Compared in constant time.
 *
 * With no secret configured - production without SMS_WEBHOOK_SECRET - the
 * webhook is off: every request is refused with 503, and the rest of the
 * server runs as normal.
 */
function requireWebhookSecret(req, res, next) {
  if (!config.secrets.smsWebhook) {
    return next(new AppError(503, 'sms_not_configured', 'SMS checking is not set up on this server.'));
  }
  const presented = req.get('x-webhook-secret') ?? req.query.key ?? '';
  if (!presented || !timingSafeEqual(String(presented), config.secrets.smsWebhook)) {
    return next(forbidden('Invalid webhook credentials.'));
  }
  return next();
}

// ---------------------------------------------------------------------------
// POST /api/sms/inbound
// ---------------------------------------------------------------------------
/**
 * Accepts either JSON `{ from, body }` or Twilio's form encoding
 * `From` / `Body`, and answers with TwiML when the caller is Twilio so the
 * reply is delivered in the same HTTP round trip.
 */
router.post(
  '/inbound',
  requireWebhookSecret,
  rateLimit({ limiters: [smsLimiter] }),
  rateLimit({ limiters: [perNumberMinute, perNumberHour], keyFn: sender }),
  async (req, res) => {
    const from = req.body?.from ?? req.body?.From;
    const body = req.body?.body ?? req.body?.Body;

    if (!from || !body) {
      throw badRequest('Both a sender number and a message body are required.');
    }

    const { reply, result } = await sms.handleInbound(String(from), String(body), req);

    // Twilio-style synchronous reply.
    if (String(req.query.format) === 'twiml' || req.body?.MessageSid) {
      res.type('text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`
      );
      return;
    }

    res.json({ ok: true, reply, result: result.result, reason: result.reason });
  }
);

/** Escape the five XML entities so a reply can never break the TwiML document. */
function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  })[c]);
}

export default router;
