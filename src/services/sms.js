/**
 * SMS fallback.
 *
 * The field guide flags "no connectivity, no check" as a HIGH risk: in
 * low-connectivity areas a buyer cannot reach the web portal. SMS is the
 * answer, because a text works on any handset on any 2G network.
 *
 * A patient texts the code to a shortcode; the gateway POSTs it to
 * /api/sms/inbound; we run the identical verification logic and text back a
 * plain-language answer.
 *
 * PROVIDERS: `console` (development - prints the reply) and `twilio` are
 * implemented. Adding another gateway means adding one entry to PROVIDERS;
 * nothing else in the system changes.
 */
import { config } from '../config.js';
import * as db from '../db/index.js';
import { pseudonymize } from '../lib/crypto.js';
import * as verification from './verification.js';
import logger from '../lib/logger.js';

/** SMS bodies must stay short: one segment is 160 GSM-7 characters. */
const MAX_SMS = 320; // two segments, enough for a result plus the batch line

/**
 * Compose the reply text for a verification result.
 * Plain words only: this may be read by someone with limited literacy, on a
 * feature phone, in a pharmacy queue.
 */
export function composeReply(result) {
  const lines = [];

  switch (result.result) {
    case 'genuine':
      lines.push('GENUINE. This pack is authentic.');
      if (result.product?.name) {
        lines.push(`${result.product.name}${result.product.strength ? ` ${result.product.strength}` : ''}`);
      }
      if (result.batch?.expiryDate) lines.push(`Expires ${result.batch.expiryDate}`);
      if (result.batch?.expiringSoon) lines.push('NOTE: expires soon.');
      break;

    case 'flagged':
      if (result.reason === verification.REASONS.DUPLICATE_SCAN) {
        lines.push('WARNING. This code was already used. The pack may be copied.');
      } else if (result.reason === verification.REASONS.RECALLED) {
        lines.push('RECALLED. Do not use. Return it to the pharmacy.');
      } else if (result.reason === verification.REASONS.EXPIRED) {
        lines.push('EXPIRED. Do not use this pack.');
      } else {
        lines.push('WARNING. This code is not recognised. Do not use this pack.');
      }
      lines.push('Return it to your pharmacy and report it.');
      break;

    default:
      lines.push('Sorry, that code was not readable.');
      lines.push('Check it and send again, e.g. AMX25-260921-00483-K7');
  }

  return lines.join(' ').slice(0, MAX_SMS);
}

/**
 * Handle one inbound text.
 *
 * @param {string} from    sender's phone number (never stored raw)
 * @param {string} body    raw message text
 * @param {object} [req]
 */
export function handleInbound(from, body, req = null) {
  const msisdnHash = pseudonymize(from, config.secrets.session);

  // Tolerate "CHECK <code>" / "VERIFY <code>" prefixes and stray punctuation.
  const cleaned = String(body ?? '')
    .replace(/^\s*(check|verify|qr|shield)\s+/i, '')
    .trim();

  db.run(`INSERT INTO sms_log (direction, msisdn_hash, body, provider) VALUES ('inbound', ?, ?, ?)`, [
    msisdnHash,
    cleaned.slice(0, 200),
    config.sms.provider,
  ]);

  const result = verification.verify(cleaned, { channel: 'sms', msisdn: from, req });
  const reply = composeReply(result);

  db.run(
    `INSERT INTO sms_log (direction, msisdn_hash, body, scan_id, provider) VALUES ('outbound', ?, ?, ?, ?)`,
    [msisdnHash, reply, result.scanId ?? null, config.sms.provider]
  );

  // Fire and forget: the gateway's HTTP response must not wait on delivery.
  send(from, reply).catch((err) => logger.error('sms send failed', { error: err.message }));

  return { reply, result };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const PROVIDERS = {
  /** Development: print the message instead of sending it. */
  async console(to, text) {
    logger.info(`[SMS -> ${maskNumber(to)}] ${text}`);
    return { ok: true, provider: 'console' };
  },

  /** Twilio REST API. Uses global fetch - no SDK dependency. */
  async twilio(to, text) {
    const { accountSid, authToken } = config.sms.twilio;
    if (!accountSid || !authToken) {
      throw new Error('SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set');
    }
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: config.sms.from, Body: text }),
      }
    );
    if (!res.ok) throw new Error(`Twilio responded ${res.status}: ${await res.text()}`);
    return { ok: true, provider: 'twilio' };
  },
};

/** Send an outbound message through the configured provider. */
export async function send(to, text) {
  const provider = PROVIDERS[config.sms.provider] ?? PROVIDERS.console;
  return provider(to, text);
}

/** Show only the last 3 digits of a number in logs. */
function maskNumber(n) {
  const s = String(n);
  return s.length <= 3 ? '***' : `${'*'.repeat(Math.max(0, s.length - 3))}${s.slice(-3)}`;
}

export default { handleInbound, composeReply, send };
