/**
 * Leaflet QR codes.
 *
 * A DIFFERENT ARTEFACT FROM THE PACK CODES, and the distinction matters:
 *
 *   pack code     one per unit, serialized and signed, proves this particular
 *                 pack is genuine. Scanning it twice is the counterfeit
 *                 signal, so every scan is recorded.
 *
 *   leaflet code  one per medicine, not serialized, not signed, carries no
 *                 claim about any pack. It opens the patient information for
 *                 that product - for a shelf talker, a poster, a carton, a
 *                 pharmacy counter card.
 *
 * Because a leaflet QR makes no authenticity claim, it needs no secret and no
 * scan record: it is a link, and the URL is the whole of it. That is also why
 * these are generated on demand rather than stored. A QR is a picture of a
 * URL; keeping the images would be a cache that can drift from the leaflet it
 * points at, while regenerating one costs a millisecond.
 */
import QRCode from 'qrcode';

import * as db from '../db/index.js';
import { config, LOCAL_BASE_URL_WARNING } from '../config.js';
import { notFound } from '../lib/errors.js';
import logger from '../lib/logger.js';

/**
 * The id of a product's current leaflet, or null if none is published.
 *
 * Recorded on a batch when it is created, as the version it shipped with -
 * whether the batch is created in the dashboard or imported from a sheet, so
 * both paths agree. Same ordering as the public page, so "current" means the
 * same thing everywhere.
 */
export async function currentLeafletId(productId, { lang = 'en' } = {}) {
  const row = await db.findOne(
    'leaflet',
    { product_id: Number(productId), language: lang },
    { order: ['effective_from desc', 'id desc'], fields: ['id'] }
  );
  return row?.id ?? null;
}

/** The public address a leaflet QR points at. */
export function leafletUrl(sku, { lang } = {}) {
  const base = `${config.publicBaseUrl}/leaflet/${encodeURIComponent(String(sku).toUpperCase())}`;
  return lang && lang !== 'en' ? `${base}?lang=${encodeURIComponent(lang)}` : base;
}

/**
 * Every product, with its current leaflet and the URL its QR would carry.
 *
 * Products WITHOUT a leaflet are included rather than filtered out: a QR
 * printed for a medicine whose leaflet was never published would lead a
 * patient to a dead end, so the gap has to be visible on this screen.
 */
export async function listLeafletCodes({ lang = 'en' } = {}) {
  // The current leaflet per product: newest effective_from, then newest id -
  // the same ordering currentLeafletId and the public page use.
  const current = '*[_type == "leaflet" && product_id == ^.id && language == $lang] | order(effective_from desc, id desc)[0]';
  const rows = await db.findMany('product', {}, {
    order: 'name asc',
    fields: ['sku', 'name', 'strength', 'dosage_form', 'manufacturer', 'status'],
    extra: {
      leaflet_id: `${current}.id`,
      leaflet_version: `${current}.version`,
      leaflet_language: `${current}.language`,
      effective_from: `${current}.effective_from`,
      leaflet_versions: 'count(*[_type == "leaflet" && product_id == ^.id])',
    },
    params: { lang },
  });

  return rows.map((r) => ({
    ...r,
    hasLeaflet: Boolean(r.leaflet_id),
    url: leafletUrl(r.sku, { lang }),
  }));
}

/** One product's leaflet QR, as an SVG string. */
export async function leafletQrSvg(sku, { lang = 'en', width = 240 } = {}) {
  const product = await db.findOne('product', { sku: String(sku).toUpperCase() }, { fields: ['sku'] });
  if (!product) throw notFound('Product not found');

  /*
   * Error-correction level Q, as on the pack labels: these get printed small
   * and on surfaces that scuff, and a leaflet QR that fails to scan at a
   * pharmacy counter is worse than no QR at all.
   */
  return QRCode.toString(leafletUrl(product.sku, { lang }), {
    type: 'svg',
    errorCorrectionLevel: 'Q',
    margin: 1,
    width,
  });
}

/** One product's leaflet QR, as a PNG data URL (for the print sheet). */
export async function leafletQrDataUrl(sku, { lang = 'en', width = 320 } = {}) {
  return QRCode.toDataURL(leafletUrl(sku, { lang }), {
    errorCorrectionLevel: 'Q',
    margin: 1,
    width,
  });
}

/**
 * A printable sheet: every product that HAS a leaflet, with its QR.
 *
 * Products without one are left out here - this is the artefact that goes to
 * a printer, and a QR leading to "no leaflet published" should never reach a
 * shelf. The list screen is where that gap is shown instead.
 */
export async function leafletSheet({ lang = 'en' } = {}) {
  const products = (await listLeafletCodes({ lang })).filter((p) => p.hasLeaflet);

  // A leaflet QR carries nothing but its URL, so a local base URL leaves it
  // with no recoverable meaning at all once it is on a shelf talker.
  if (config.publicBaseUrlIsLocal) {
    logger.warn(LOCAL_BASE_URL_WARNING, { artefact: 'leaflet sheet', lang, products: products.length });
  }

  return Promise.all(
    products.map(async (p) => ({
      sku: p.sku,
      name: p.name,
      strength: p.strength,
      dosageForm: p.dosage_form,
      version: p.leaflet_version,
      url: p.url,
      qr: await leafletQrDataUrl(p.sku, { lang }),
    }))
  );
}

export default { currentLeafletId, leafletUrl, listLeafletCodes, leafletQrSvg, leafletQrDataUrl, leafletSheet };
