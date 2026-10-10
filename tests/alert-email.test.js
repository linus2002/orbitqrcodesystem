/**
 * Alert emails.
 *
 * High and critical alerts are emailed to the alert inbox (ALERT_EMAIL_TO,
 * ai@getmeds.ph by default); low and medium ones only wait in
 * the queue. A repeat that lifts an alert into high or critical is emailed
 * too. Sending runs after the alert is stored and never holds up or breaks
 * the check that raised it.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import './setup-env.js';
import { freshDb } from './helpers.js';
import { config } from '../src/config.js';
import * as alerts from '../src/services/alerts.js';
import * as mail from '../src/services/mail.js';

const { outbox } = mail;

/** Wait for the next email the alert sends in the background. */
async function nextEmail(before) {
  for (let i = 0; i < 100; i++) {
    if (outbox.length > before) return outbox[outbox.length - 1];
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

/** Give a background send long enough that "no email" means none was sent. */
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeEach(async () => {
  await freshDb();
  outbox.length = 0;
});

test('alert emails go to ai@getmeds.ph by default', () => {
  assert.deepEqual(config.mail.alertTo, ['ai@getmeds.ph']);
});

test('a high alert is emailed to the alert inbox', async () => {
  await alerts.raise({ type: 'consumer_report', context: { summary: 'Blurry print on the box' } });

  const email = await nextEmail(0);
  assert.ok(email, 'an email was sent');
  assert.deepEqual(email.bcc, ['ai@getmeds.ph']);
  assert.match(email.subject, /^\[Getmeds alert\] HIGH: Patient report: Blurry print on the box/);
  assert.match(email.text, /\/admin\/alerts/);
});

test('a low or medium alert is not emailed', async () => {
  await alerts.raise({ type: 'expired_scan', context: { batchNumber: 'B-1' }, codeId: 7 });
  await alerts.raise({ type: 'unknown_code', context: { code: 'ZZZ99-ABCDEF-12' } });
  await settle();
  assert.equal(outbox.length, 0);
});

test('a repeat that lifts an alert to high is emailed, once', async () => {
  const raise = () => alerts.raise({ type: 'expired_scan', context: { batchNumber: 'B-1' }, codeId: 7 });
  await raise();
  await raise();
  await settle();
  assert.equal(outbox.length, 0, 'still low after two occurrences');

  await raise(); // the third occurrence escalates to high
  const email = await nextEmail(0);
  assert.match(email.subject, /^\[Getmeds alert\] Now HIGH:/);
  assert.match(email.text, /from low to high/);

  await raise(); // still high: nothing new to say
  await settle();
  assert.equal(outbox.length, 1);
});

test('with no alert inbox set, the alert is still raised', async () => {
  const saved = config.mail.alertTo;
  config.mail.alertTo = [];
  try {
    const alert = await alerts.raise({ type: 'guess_attack', context: { attempts: 9 } });
    await settle();
    assert.ok(alert.id);
    assert.equal(outbox.length, 0);
  } finally {
    config.mail.alertTo = saved;
  }
});

// ---------------------------------------------------------------------------
// Brevo
// ---------------------------------------------------------------------------

/** Run `fn` with Brevo selected and fetch replaced by `fake`. */
async function withBrevo(fake, fn) {
  const saved = { provider: config.mail.provider, from: config.mail.from, key: config.mail.brevo.apiKey, fetch: globalThis.fetch };
  Object.assign(config.mail, { provider: 'brevo', from: 'Getmeds Alerts <alerts@getmeds.test>' });
  config.mail.brevo.apiKey = 'test-key';
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    Object.assign(config.mail, { provider: saved.provider, from: saved.from });
    config.mail.brevo.apiKey = saved.key;
    globalThis.fetch = saved.fetch;
  }
}

test('Brevo is sent the sender, the recipient and the text, with the API key', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ messageId: '<m1@brevo>' }), { status: 201 });
  };
  const result = await withBrevo(fake, () =>
    mail.send({ bcc: ['ai@getmeds.ph'], subject: 'Hello', text: 'Body' })
  );

  assert.deepEqual(result, { ok: true, provider: 'brevo', id: '<m1@brevo>' });
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].init.headers['api-key'], 'test-key');
  assert.deepEqual(calls[0].body, {
    sender: { name: 'Getmeds Alerts', email: 'alerts@getmeds.test' },
    to: [{ email: 'ai@getmeds.ph' }],
    subject: 'Hello',
    textContent: 'Body',
  });
});

test('several recipients go by Bcc behind the sender', async () => {
  let body;
  const fake = async (url, init) => {
    body = JSON.parse(init.body);
    return new Response('{}', { status: 201 });
  };
  await withBrevo(fake, () => mail.send({ bcc: ['a@x.test', 'b@x.test'], subject: 's', text: 't' }));
  assert.deepEqual(body.to, [{ email: 'alerts@getmeds.test' }]);
  assert.deepEqual(body.bcc, [{ email: 'a@x.test' }, { email: 'b@x.test' }]);
});

test('a Brevo refusal is reported, not thrown', async () => {
  const fake = async () => new Response(JSON.stringify({ message: 'Key not found' }), { status: 401 });
  const result = await withBrevo(fake, () => mail.send({ to: 'a@x.test', subject: 's', text: 't' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /Brevo 401: Key not found/);
});
