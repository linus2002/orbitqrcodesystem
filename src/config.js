/**
 * Central configuration.
 *
 * Every tunable lives here so that nothing else in the codebase reads
 * `process.env` directly — that keeps configuration auditable and makes the
 * whole app trivially testable (tests override this object's inputs via env).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Node 22.5+ can load a .env file natively - no dotenv dependency required.
// Tests set QRSHIELD_SKIP_DOTENV so a developer's local .env can never leak
// into a test run and make results depend on an untracked file.
const envFile = path.join(ROOT, '.env');
if (!process.env.QRSHIELD_SKIP_DOTENV && existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.warn(`[config] could not read .env: ${err.message}`);
  }
}

const str = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};
const int = (key, fallback) => {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
};
const bool = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const NODE_ENV = str('NODE_ENV', 'development');
const isProd = NODE_ENV === 'production';

/** Secrets must never silently fall back to a default in production. */
function secret(key, devFallback) {
  const v = str(key, '');
  if (v) return v;
  if (isProd) {
    throw new Error(
      `[config] ${key} is required in production. Generate one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
    );
  }
  return devFallback;
}

export const config = {
  env: NODE_ENV,
  isProd,
  isTest: NODE_ENV === 'test',
  port: int('PORT', 3000),
  publicBaseUrl: str('PUBLIC_BASE_URL', `http://localhost:${int('PORT', 3000)}`).replace(/\/+$/, ''),

  /*
   * One driver (libSQL) serves both shapes: a local file in development, a
   * hosted Turso database in production. Serverless hosting has no persistent
   * filesystem, so TURSO_DATABASE_URL is what makes a deploy durable - without
   * it the app silently falls back to a file that the platform will discard.
   */
  db: {
    file: path.resolve(ROOT, str('DB_FILE', './data/qrshield.db')),
    url: str('TURSO_DATABASE_URL', ''),
    authToken: str('TURSO_AUTH_TOKEN', ''),
  },

  secrets: {
    session: secret('SESSION_SECRET', 'dev-only-session-secret-do-not-use-in-production'),
    code: secret('CODE_SECRET', 'dev-only-code-secret-do-not-use-in-production'),
    smsWebhook: str('SMS_WEBHOOK_SECRET', 'dev-sms-webhook-secret'),
  },

  session: {
    ttlHours: int('SESSION_TTL_HOURS', 8),
    cookieName: 'qrs_session',
    csrfCookieName: 'qrs_csrf',
    cookieSecure: bool('COOKIE_SECURE', isProd),
  },

  auth: {
    maxFailures: int('LOGIN_MAX_FAILURES', 5),
    lockoutMinutes: int('LOGIN_LOCKOUT_MINUTES', 15),
    minPasswordLength: 12,
  },

  rateLimit: {
    verifyPerMin: int('RL_VERIFY_PER_MIN', 12),
    verifyPerHour: int('RL_VERIFY_PER_HOUR', 80),
    loginPer15Min: int('RL_LOGIN_PER_15MIN', 5),
    reportPerHour: int('RL_REPORT_PER_HOUR', 5),
    /*
     * 'memory' for a single long-running process, 'sql' when more than one
     * instance serves traffic - on serverless the counters must be shared or
     * an attacker just spreads attempts across instances.
     */
    store: str('RATELIMIT_STORE', str('TURSO_DATABASE_URL', '') ? 'sql' : 'memory'),
    guessAlertThreshold: int('GUESS_ALERT_THRESHOLD', 8),
  },

  sms: {
    provider: str('SMS_PROVIDER', 'console'),
    from: str('SMS_FROM', 'QRSHIELD'),
    twilio: {
      accountSid: str('TWILIO_ACCOUNT_SID', ''),
      authToken: str('TWILIO_AUTH_TOKEN', ''),
    },
  },

  seed: {
    adminEmail: str('SEED_ADMIN_EMAIL', 'admin@qrshield.example'),
    adminPassword: str('SEED_ADMIN_PASSWORD', 'ChangeMe!2026'),
  },
};

export default config;
