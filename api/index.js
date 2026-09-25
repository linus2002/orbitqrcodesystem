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
 *  - No boot check and no hourly session pruner. A function instance is
 *    short-lived and may be one of many, so the Sanity connection is checked
 *    at build time instead: vercel.json runs `npm run build:vercel`, which
 *    calls `scripts/migrate.js --hosted-only` before bundling the client.
 *    Expired sessions are cleaned opportunistically rather than on a timer
 *    this process owns.
 *
 * Static files are served by Vercel's CDN, not by this function - vercel.json
 * routes only /api/* here.
 */
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import logger from '../src/lib/logger.js';

if (!config.sanity.enabled) {
  // Without Sanity this would keep data in the function's ephemeral
  // filesystem: every write would be silently discarded on the next
  // invocation. Far better to fail loudly at cold start.
  logger.error(
    'Sanity is not configured (SANITY_PROJECT_ID, SANITY_DATASET, SANITY_API_TOKEN). ' +
      'A serverless deployment has no persistent disk, so the data must live in Sanity. See DEPLOY.md.'
  );
}

const app = createApp();

export default app;
