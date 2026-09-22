/**
 * A small declarative validator.
 *
 * Every request body that reaches a route handler has already been through
 * this, so handlers can trust their inputs. Written by hand rather than pulled
 * from npm because the rule set is tiny and this keeps the dependency surface
 * (and therefore the supply-chain risk) minimal - which matters for a system
 * whose entire purpose is anti-counterfeiting.
 *
 * Usage:
 *   const data = validate(req.body, {
 *     email:    { type: 'email', required: true },
 *     quantity: { type: 'int', min: 1, max: 100000, required: true },
 *     status:   { type: 'enum', values: ['open', 'closed'], default: 'open' },
 *   });
 */
import { validationFailed } from './errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CHECKERS = {
  string(value, rule, field, errors) {
    let v = String(value).trim();
    if (rule.lowercase) v = v.toLowerCase();
    if (rule.min !== undefined && v.length < rule.min) {
      errors.push({ field, message: `must be at least ${rule.min} characters` });
    }
    if (rule.max !== undefined && v.length > rule.max) {
      errors.push({ field, message: `must be at most ${rule.max} characters` });
    }
    if (rule.pattern && !rule.pattern.test(v)) {
      errors.push({ field, message: rule.patternMessage ?? 'has an invalid format' });
    }
    return v;
  },

  email(value, rule, field, errors) {
    const v = String(value).trim().toLowerCase();
    if (!EMAIL_RE.test(v) || v.length > 254) {
      errors.push({ field, message: 'must be a valid email address' });
    }
    return v;
  },

  int(value, rule, field, errors) {
    const v = Number.parseInt(value, 10);
    if (!Number.isFinite(v)) {
      errors.push({ field, message: 'must be a whole number' });
      return undefined;
    }
    if (rule.min !== undefined && v < rule.min) {
      errors.push({ field, message: `must be at least ${rule.min}` });
    }
    if (rule.max !== undefined && v > rule.max) {
      errors.push({ field, message: `must be at most ${rule.max}` });
    }
    return v;
  },

  bool(value) {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  },

  date(value, rule, field, errors) {
    const v = String(value).trim().slice(0, 10);
    if (!DATE_RE.test(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) {
      errors.push({ field, message: 'must be a date in YYYY-MM-DD format' });
    }
    return v;
  },

  enum(value, rule, field, errors) {
    const v = String(value).trim();
    if (!rule.values.includes(v)) {
      errors.push({ field, message: `must be one of: ${rule.values.join(', ')}` });
    }
    return v;
  },

  array(value, rule, field, errors) {
    if (!Array.isArray(value)) {
      errors.push({ field, message: 'must be a list' });
      return [];
    }
    if (rule.max !== undefined && value.length > rule.max) {
      errors.push({ field, message: `must contain at most ${rule.max} items` });
    }
    return value;
  },
};

/**
 * Validate and coerce `input` against `schema`.
 * Throws a 422 AppError listing every problem at once, so the UI can highlight
 * all bad fields in a single pass instead of one error at a time.
 */
export function validate(input, schema) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  const errors = [];

  for (const [field, rule] of Object.entries(schema)) {
    let value = source[field];

    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (rule.required) {
        errors.push({ field, message: 'is required' });
        continue;
      }
      if (rule.default !== undefined) out[field] = rule.default;
      continue;
    }

    const checker = CHECKERS[rule.type ?? 'string'];
    if (!checker) throw new Error(`validate: unknown rule type "${rule.type}"`);

    const coerced = checker(value, rule, field, errors);
    if (coerced !== undefined) out[field] = coerced;
  }

  if (errors.length) throw validationFailed(errors);
  return out;
}

/** Password policy, applied on every password create/change. */
export function checkPasswordStrength(password, minLength = 12) {
  const problems = [];
  const p = String(password);
  if (p.length < minLength) problems.push(`must be at least ${minLength} characters`);
  if (!/[a-z]/.test(p)) problems.push('must contain a lowercase letter');
  if (!/[A-Z]/.test(p)) problems.push('must contain an uppercase letter');
  if (!/\d/.test(p)) problems.push('must contain a digit');
  // Cheap defence against the handful of passwords that show up in every leak.
  const COMMON = ['password', '12345678', 'qwerty', 'letmein', 'admin123', 'changeme'];
  if (COMMON.some((c) => p.toLowerCase().includes(c))) {
    problems.push('must not contain a common password phrase');
  }
  return problems;
}

export default validate;
