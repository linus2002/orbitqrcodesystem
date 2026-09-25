/**
 * Test environment.
 *
 * This module MUST be imported before anything that reads configuration.
 * ES module imports are evaluated before the importing module's body runs, so
 * assigning these variables at the top of helpers.js would be too late -
 * src/config.js would already have loaded the developer's real .env file and
 * the tests would silently run against production-shaped secrets.
 *
 * Keeping the assignments in their own module, imported first, guarantees the
 * ordering.
 */
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-not-used-anywhere-real';
process.env.CODE_SECRET = 'test-code-secret-not-used-anywhere-real';
process.env.SMS_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.DB_FILE = ':memory:';

// Never the hosted dataset. The suite writes and wipes freely, so it runs on
// the in-memory store whatever the shell or a .env says - blanking these
// makes that unconditional rather than a matter of which file got loaded.
process.env.SANITY_PROJECT_ID = '';
process.env.SANITY_DATASET = '';
process.env.SANITY_API_TOKEN = '';
process.env.RATELIMIT_STORE = 'memory';
process.env.PUBLIC_BASE_URL = 'http://test.local';
process.env.SMS_PROVIDER = 'console';

// Keep the limits predictable rather than inheriting whatever .env happens to say.
process.env.RL_VERIFY_PER_MIN = '12';
process.env.RL_VERIFY_PER_HOUR = '80';
// High enough that the account-lockout test exercises the lockout itself
// rather than tripping the per-IP login limiter first.
process.env.RL_LOGIN_PER_15MIN = '50';
process.env.GUESS_ALERT_THRESHOLD = '8';
process.env.LOGIN_MAX_FAILURES = '5';

// config.js only loads a .env file when one exists on disk; the values above
// were set first, and config prefers process.env for anything already defined
// only if the file does not override it - so point it at a path that has none.
process.env.QRSHIELD_SKIP_DOTENV = '1';
