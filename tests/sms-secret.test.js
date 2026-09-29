/**
 * The SMS webhook's secret has no public default in production.
 *
 * It fell back to "dev-sms-webhook-secret" whatever the environment, and the
 * repository is public: unset in production, anyone could post fake texts.
 * Unset in production it is now empty, and the webhook refuses everything
 * with 503 - while the server itself still starts, since a missing SMS
 * setting must never take the whole API down.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from './helpers.js';
import { config } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let client;
before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

test('in production without SMS_WEBHOOK_SECRET the server still starts, with no SMS secret', () => {
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { config } = await import('./src/config.js'); await import('./src/server.js');" +
        ' console.log(JSON.stringify(config.secrets.smsWebhook));',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        NODE_ENV: 'production',
        QRSHIELD_SKIP_DOTENV: '1',
        SESSION_SECRET: 'test-session-secret-not-used-anywhere-real',
        CODE_SECRET: 'test-code-secret-not-used-anywhere-real',
        PUBLIC_BASE_URL: 'https://example.test',
        DB_FILE: ':memory:',
      },
    }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').pop(), '""', 'no default secret');
});

test('with no secret configured the webhook refuses everything with 503', async () => {
  const saved = config.secrets.smsWebhook;
  config.secrets.smsWebhook = '';
  try {
    for (const key of ['', 'dev-sms-webhook-secret', 'anything']) {
      const res = await client.post(`/api/sms/inbound?key=${key}`, { from: '+639170000001', body: 'X' });
      assert.equal(res.status, 503, `key "${key}"`);
      assert.equal(res.body.error.code, 'sms_not_configured');
    }
  } finally {
    config.secrets.smsWebhook = saved;
  }
});
