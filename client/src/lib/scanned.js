/**
 * What a QR scanned in the portal carries.
 *
 * One carton holds two kinds of QR: the pack's own (a /v/CODE?s=... link,
 * unique to that pack) and the medicine's leaflet QR (a /leaflet/SKU link,
 * the same on every carton). The scanner must tell them apart: checking the
 * leaflet link as if it were a pack code can only end in "not in the
 * expected format", and every such try counts toward the code-guessing
 * alert.
 *
 * Returns { kind: 'leaflet', sku, lang } or { kind: 'code', code, signature }.
 * Anything that is not a URL is taken as a bare code, as before.
 */
export function readScannedQr(text) {
  const raw = String(text ?? '');

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'code', code: raw, signature: null };
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] === 'leaflet') {
    return { kind: 'leaflet', sku: decoded(parts[1], parts[1]), lang: url.searchParams.get('lang') };
  }

  return {
    kind: 'code',
    code: decoded(parts.pop() ?? raw, raw),
    signature: url.searchParams.get('s'),
  };
}

/** Percent-decoded, or `fallback` when the text is not valid encoding. */
function decoded(text, fallback) {
  try {
    return decodeURIComponent(text);
  } catch {
    return fallback;
  }
}

/** The portal's own address for a medicine's leaflet page. */
export function leafletPath({ sku, lang }) {
  const base = `/leaflet/${encodeURIComponent(sku)}`;
  return lang && lang !== 'en' ? `${base}?lang=${encodeURIComponent(lang)}` : base;
}
