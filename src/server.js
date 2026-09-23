/**
 * QR Shield - HTTP server.
 *
 * Wires together: security headers -> body parsing -> session resolution ->
 * routes -> error handling. Order matters and is commented at each step.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, ROOT } from './config.js';
import * as db from './db/index.js';
import logger from './lib/logger.js';
import { securityHeaders, clientIp, cors } from './middleware/security.js';
import { attachUser } from './middleware/auth.js';
import { requestLogger, notFoundHandler, errorHandler } from './middleware/errors.js';
import * as authService from './services/auth.js';

import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import smsRoutes from './routes/sms.js';

/**
 * The built React bundle. Produced by `npm run build` (Vite), which emits
 * hashed asset filenames into dist/assets plus a single index.html.
 */
const DIST_DIR = path.join(ROOT, 'dist');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');

export function createApp() {
  const app = express();

  // --- Proxy awareness ----------------------------------------------------
  // Behind a load balancer this must be set so req.ip is the real client and
  // `secure` cookies are recognised. '1' = trust exactly one proxy hop; set it
  // to the real hop count rather than `true`, which would let a client spoof
  // X-Forwarded-For and defeat rate limiting.
  app.set('trust proxy', config.isProd ? 1 : 'loopback');
  app.disable('x-powered-by');
  app.set('etag', false);

  // --- Cross-cutting middleware -------------------------------------------
  app.use(securityHeaders);
  app.use(clientIp);
  app.use(cors);
  app.use(requestLogger);

  // Body limits are deliberately tight: no endpoint needs a large payload, and
  // a small cap is free protection against memory-exhaustion attempts.
  /*
   * A spreadsheet upload arrives as the raw file on this one path, so the
   * import endpoint needs no multipart parser - there is one file and no other
   * fields. Mounted BEFORE the JSON parser and scoped to the path, so nothing
   * else in the API starts accepting binary bodies.
   *
   * 8MB holds a workbook of tens of thousands of rows; past that the file is
   * almost certainly not a product list.
   */
  app.use(
    '/api/admin/import',
    express.raw({
      type: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'application/octet-stream',
        'text/csv',
      ],
      limit: '8mb',
    })
  );

  /*
   * The profile endpoint carries an avatar as a data URL, which base64 pushes
   * past the 64kb every other endpoint gets. Widened here alone rather than
   * globally: 64kb is the right ceiling for a login or a batch request, and
   * raising it everywhere to suit one route would give every endpoint a larger
   * body to parse before it can reject it.
   *
   * 512kb leaves room for a 200KB image plus base64 overhead and the rest of
   * the object; the route itself enforces the real limit.
   */
  app.use('/api/auth/profile', express.json({ limit: '512kb' }));

  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());

  // Resolve a session if one is presented. Never rejects; guards do that.
  app.use(attachUser);

  // --- API ----------------------------------------------------------------
  app.use('/api', publicRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/sms', smsRoutes);

  // --- Static assets ------------------------------------------------------
  app.use(
    express.static(DIST_DIR, {
      index: false,
      etag: true,
      setHeaders(res, filePath) {
        // Vite fingerprints everything under /assets, so those files can be
        // cached indefinitely - a new build produces new filenames.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );

  // --- SPA fallback -------------------------------------------------------
  // Unmatched API routes have already been answered with JSON by
  // notFoundHandler, so anything reaching here is a client route: /, /v/:code,
  // /login and /admin/*. React Router resolves it in the browser, including
  // its own 404.
  app.use(notFoundHandler);
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!fs.existsSync(INDEX_HTML)) {
      return res
        .status(503)
        .type('text/plain')
        .send(
          'The frontend has not been built yet.\n\nRun `npm run build` (or `npm run dev` for ' +
            'the Vite dev server) and reload.\n'
        );
    }
    return res.sendFile(INDEX_HTML);
  });
  app.use(errorHandler);

  return app;
}

/** Start listening. Exported so tests can start an ephemeral server. */
export async function start({ port = config.port } = {}) {
  db.open();
  await db.migrate({ silent: true });

  const app = createApp();
  const server = app.listen(port, () => {
    logger.info(`QR Shield listening on http://localhost:${port}`, {
      env: config.env,
      publicBaseUrl: config.publicBaseUrl,
    });
  });

  // Expire old session rows hourly so the table cannot grow without bound.
  // Fire-and-forget on a timer, so a failed prune is logged rather than
  // surfacing as an unhandled rejection that would take the process down.
  const prune = setInterval(() => {
    authService
      .pruneSessions()
      .catch((err) => logger.error('session prune failed', { error: err.message }));
  }, 3600_000);
  if (typeof prune.unref === 'function') prune.unref();

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// Start only when run directly, not when imported by a test.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) await start();

export default createApp;
