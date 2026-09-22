/**
 * Structured logger.
 *
 * Emits JSON lines in production (so a log drain can parse them) and a compact
 * coloured form in development. Keeps a redaction list so secrets and codes
 * never end up in a log file by accident.
 */
import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[config.isTest ? 'silent' : config.isProd ? 'info' : 'debug'];

const REDACT = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'password_hash',
  'token',
  'csrf',
  'csrf_token',
  'authorization',
  'cookie',
  'secret',
]);

/** Recursively strip sensitive keys before anything is written out. */
function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.has(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

function emit(level, message, meta) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const clean = meta ? redact(meta) : undefined;

  if (config.isProd) {
    process.stdout.write(`${JSON.stringify({ time, level, message, ...clean })}\n`);
    return;
  }
  const tail = clean && Object.keys(clean).length ? ` ${JSON.stringify(clean)}` : '';
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${COLORS[level]}${time.slice(11, 23)} ${level.padEnd(5)}${RESET} ${message}${tail}\n`);
}

export const logger = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};

export default logger;
