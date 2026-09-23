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

/**
 * Download a file the API generates, and hand it to the browser.
 *
 * A plain <a href> cannot be used: these routes need the CSRF header, and a
 * link cannot send one. So the file is fetched, turned into a blob, and given
 * to a synthetic link - which is also what lets an error come back as a
 * readable message instead of the browser navigating away to a JSON page.
 */
export async function download(path, { filename } = {}) {
  const res = await fetch(path, {
    headers: { 'X-CSRF-Token': csrfToken() ?? '' },
    credentials: 'same-origin',
  });

  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON; the status is all we have */
    }
    throw new ApiError(res.status, body);
  }

  const blob = await res.blob();
  const name =
    filename ??
    /filename="?([^"]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
    'download';

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Upload a file as the raw request body.
 *
 * The import endpoint takes one file and nothing else, so there is no reason
 * to build a multipart form - the file IS the body.
 */
export async function upload(path, file, { query } = {}) {
  let url = path;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': file.type || 'application/octet-stream',
      'X-CSRF-Token': csrfToken() ?? '',
    },
    credentials: 'same-origin',
    body: file,
  });

  const payload = (res.headers.get('content-type') ?? '').includes('application/json')
    ? await res.json()
    : await res.text();

  if (!res.ok) throw new ApiError(res.status, typeof payload === 'object' ? payload : null);
  return payload;
}
