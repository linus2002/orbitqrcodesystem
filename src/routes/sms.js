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
import { forbidden, badRequest } from '../lib/errors.js';

const router = Router();

const smsLimiter = createLimiter({ name: 'sms-inbound', windowMs: 60_000, max: 60 });

/**
 * Shared-secret check, accepted from a header or a query parameter because
 * gateways differ in what they can send. Compared in constant time.
 */
function requireWebhookSecret(req, res, next) {
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
router.post('/inbound', requireWebhookSecret, rateLimit({ limiters: [smsLimiter] }), async (req, res) => {
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
});

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
