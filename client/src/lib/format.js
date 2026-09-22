/** Display formatting helpers shared by the portal and the dashboard. */

export function fmtDate(iso, { withTime = false } = {}) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  if (!withTime) return date;
  return `${date}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** "3 min ago" style relative time, for feeds. */
export function fmtRelative(iso) {
  if (!iso) return '-';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return fmtDate(iso);
}

export const fmtNumber = (n) => Number(n ?? 0).toLocaleString();

/** Turn a snake_case enum into readable words. */
export const humanise = (s) => String(s ?? '').replace(/_/g, ' ');

/**
 * Tidy a code as the patient types it.
 *
 * Deliberately conservative: uppercases, drops characters that can never
 * appear in a code, collapses repeated separators - but does NOT insert the
 * dashes itself. Serial length varies by batch size (5 to 9 digits), so any
 * fixed-position dash insertion would mangle codes from larger batches.
 */
export function formatCodeInput(raw) {
  return String(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9\- ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-');
}

/** Initials for the account avatar. */
export function initials(name) {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
}
