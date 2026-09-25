/**
 * Vercel serverless entry point.
 *
 * Vercel runs backend code from this directory, one function per file. The
 * whole Express app is mounted here rather than split into a function per
 * route, so routing, middleware order, the security headers and the CSRF and
 * session handling stay in one place and behave identically to `npm start`.
 *
 * Two things differ from the long-running server in src/server.js:
 *
 *  - No `listen`. Vercel invokes the exported handler; Express is used purely
 *    as a request handler here.
 *  - No migrate-on-boot and no hourly session pruner. A function instance is
 *    short-lived and may be one of many, so schema changes are applied at
 *    build time instead: vercel.json runs `npm run build:vercel`, which calls
 *    `scripts/migrate.js --hosted-only` against the hosted database before
 *    bundling the client. Expired sessions are cleaned opportunistically
 *    rather than on a timer this process owns.
 *
 * Static files are served by Vercel's CDN, not by this function - vercel.json
 * routes only /api/* here.
 */
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import logger from '../src/lib/logger.js';

if (!config.db.url) {
  // Without Turso this would open a file in the function's ephemeral
  // filesystem: every write would be silently discarded on the next
  // invocation. Far better to fail loudly at cold start.
  logger.error(
    'TURSO_DATABASE_URL is not set. A serverless deployment has no persistent ' +
      'disk, so the database must be hosted. See DEPLOY.md.'
  );
}

const app = createApp();

export default app;
