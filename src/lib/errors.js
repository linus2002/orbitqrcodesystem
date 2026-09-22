/**
 * Typed application errors.
 *
 * Anything thrown as an AppError is a *client-visible* condition with a safe
 * message and a stable machine-readable `code`. Anything else that reaches the
 * error handler is treated as an internal fault: it is logged in full but the
 * client only ever sees a generic message and a correlation id. That split is
 * what stops stack traces, SQL fragments or file paths leaking to the browser.
 */
export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

export const badRequest = (msg = 'Invalid request', details) =>
  new AppError(400, 'bad_request', msg, details);

export const validationFailed = (details) =>
  new AppError(422, 'validation_failed', 'Some fields are invalid', details);

export const unauthorized = (msg = 'Authentication required') =>
  new AppError(401, 'unauthorized', msg);

export const forbidden = (msg = 'You do not have access to this resource') =>
  new AppError(403, 'forbidden', msg);

export const notFound = (msg = 'Not found') => new AppError(404, 'not_found', msg);

export const conflict = (msg = 'Conflicts with the current state', details) =>
  new AppError(409, 'conflict', msg, details);

export const tooManyRequests = (msg = 'Too many requests', details) =>
  new AppError(429, 'rate_limited', msg, details);

export const serverError = (msg = 'Something went wrong') =>
  new AppError(500, 'server_error', msg);
