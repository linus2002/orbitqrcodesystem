/**
 * Error handling and request logging.
 *
 * The central rule: an AppError is safe to show a user; anything else is a
 * bug and must be reduced to a generic message plus a correlation id. Stack
 * traces, SQL text and file paths never reach a client.
 */
import { AppError } from '../lib/errors.js';
import { randomId } from '../lib/crypto.js';
import { config } from '../config.js';
import logger from '../lib/logger.js';

/** Log each request once it completes, with its duration. */
export function requestLogger(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // Static assets would drown out anything useful.
    if (req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/vendor/')) return;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode}`, {
      ms: Number(ms.toFixed(1)),
      user: req.user?.id ?? null,
    });
  });
  next();
}

/** 404 for unmatched API routes. */
export function notFoundHandler(req, res, next) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: { code: 'not_found', message: `No API route matches ${req.method} ${req.path}` },
    });
  }
  return next();
}

/**
 * Terminal error handler. Must keep all four arguments: Express identifies an
 * error handler by arity, and dropping `next` silently disables it.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Body-parser raises this for malformed JSON.
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'bad_request', message: 'Request body is not valid JSON.' },
    });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'payload_too_large', message: 'Request body is too large.' },
    });
  }

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error(err.message, { code: err.code, stack: err.stack });
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  // Unexpected: log everything, disclose nothing.
  const incidentId = randomId(8);
  logger.error('UNHANDLED ERROR', {
    incidentId,
    message: err?.message,
    stack: err?.stack,
    path: req.originalUrl,
    method: req.method,
  });

  return res.status(500).json({
    error: {
      code: 'server_error',
      message: 'Something went wrong on our side. Please try again.',
      incidentId,
      // Surface the real message in development only.
      ...(config.isProd ? {} : { debug: err?.message }),
    },
  });
}

export default { requestLogger, notFoundHandler, errorHandler };
