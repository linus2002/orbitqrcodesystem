/**
 * Outgoing email.
 *
 * PROVIDERS: `console` (development - writes the email to the log, sends
 * nothing) and `brevo` (Brevo's transactional email API; see config.mail).
 * Adding a provider means adding one entry to PROVIDERS, as in sms.js.
 *
 * Sending never throws to the caller: an email that cannot go out is logged
 * and reported as `{ ok: false }`, so a mail outage can never break the
 * request that triggered it.
 */
import { config } from '../config.js';
import logger from '../lib/logger.js';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

/** "Getmeds Alerts <alerts@x.com>" or "alerts@x.com" -> { name?, email }. */
export function parseAddress(value) {
  const m = /^\s*(.*?)\s*<\s*([^<>\s]+)\s*>\s*$/.exec(value);
  if (m) return m[1] ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { email: m[2] };
  return { email: value.trim() };
}

/**
 * What the console provider would have sent, newest last - the last 50, so
 * development and the tests can see an email without a mail service.
 */
export const outbox = [];

const PROVIDERS = {
  async console(message) {
    outbox.push(message);
    if (outbox.length > 50) outbox.shift();
    logger.info('[mail:console] not sent (MAIL_PROVIDER=console)', {
      to: message.bcc ?? message.to,
      subject: message.subject,
    });
    return { ok: true, provider: 'console' };
  },

  async brevo(message) {
    const { apiKey } = config.mail.brevo;
    if (!apiKey) throw new Error('MAIL_PROVIDER=brevo but BREVO_API_KEY is not set');
    if (!config.mail.from) throw new Error('MAIL_PROVIDER=brevo but MAIL_FROM is not set');

    const sender = parseAddress(config.mail.from);
    const recipients = [message.to, message.bcc].flat().filter(Boolean).map((email) => ({ email }));
    // Brevo needs at least one "to". One recipient is addressed directly;
    // several go by Bcc behind the sender, so they do not see each other.
    const addressing =
      recipients.length === 1 ? { to: recipients } : { to: [{ email: sender.email }], bcc: recipients };

    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender,
        ...addressing,
        subject: message.subject,
        textContent: message.text,
        ...(message.html ? { htmlContent: message.html } : {}),
      }),
      // A slow mail service must not hold a function open for long.
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Brevo ${res.status}: ${body.message ?? res.statusText}`);
    return { ok: true, provider: 'brevo', id: body.messageId };
  },
};

/**
 * Send one email: `{ to?, bcc?, subject, text, html? }`.
 * @returns {Promise<{ ok: boolean, provider?: string, error?: string }>}
 */
export async function send(message) {
  const provider = PROVIDERS[config.mail.provider] ?? PROVIDERS.console;
  try {
    return await provider(message);
  } catch (err) {
    logger.error('email not sent', { subject: message.subject, error: err.message });
    return { ok: false, error: err.message };
  }
}

/** Which provider is active, for the Settings page. */
export const describe = () => config.mail.provider;
