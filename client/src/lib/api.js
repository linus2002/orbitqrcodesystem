/**
 * API client.
 *
 * Unchanged in behaviour from the pre-React version: it attaches the CSRF
 * token to state-changing requests, sends cookies same-origin, and turns an
 * error body into a thrown ApiError carrying a usable message.
 *
 * Note there is no `esc()` helper any more. React escapes everything it
 * renders by default, which removes the single largest category of mistake in
 * the old string-templated UI - a product name or a free-text patient report
 * can no longer be concatenated into markup by accident.
 */

export class ApiError extends Error {
  constructor(status, body) {
    const message =
      body?.error?.message ??
      (status === 0 ? 'Cannot reach the server.' : `Request failed (${status})`);
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code ?? 'error';
    this.details = body?.error?.details ?? null;
  }

  /** Per-field messages from a 422, keyed by field name. */
  get fieldErrors() {
    const out = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details) if (d?.field) out[d.field] = d.message;
    }
    return out;
  }

  /** The first field message, or the general message - what a form shows. */
  get formMessage() {
    return Object.values(this.fieldErrors)[0] ?? this.message;
  }
}

/** Read the readable CSRF cookie set at login. */
export function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)qrs_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Perform an API request.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.body]    serialised as JSON
 * @param {object} [options.query]   nullish and empty values are dropped
 * @param {AbortSignal} [options.signal]
 */
export async function api(path, { method = 'GET', body, query, signal } = {}) {
  let url = path;
  if (query) {
    const params = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = csrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, null);
  }

  if (res.status === 204) return null;

  const contentType = res.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) throw new ApiError(res.status, typeof payload === 'object' ? payload : null);
  return payload;
}
