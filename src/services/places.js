/**
 * Where a pack was bought, against where it was checked.
 *
 * Two different facts, and they are allowed to differ: a person in Bacoor
 * checks a pack bought in Las Piñas all the time. What this measures is how
 * far apart they are, and labels it - it never refuses anything. A label is
 * for the security team to weigh, because a claim that a pack came from the
 * other end of the country is either someone misleading them or stock that
 * travelled where it should not have, and both are worth a look.
 *
 *   nearby        up to 50 km apart: where people live, work and shop
 *   plausible     50-300 km in the same island group: bought while visiting
 *                 the province; or, without GPS, merely the same island group
 *   inconsistent  over 300 km, or a different island group
 *   unknown       one side or the other is missing
 *
 * "Where it was checked" comes from one of two sources, and the record says
 * which. GPS is the phone's own location, asked for only on a suspicious
 * result or a report, with the person's permission each time. Without it,
 * the internet connection's location is all there is, and on mobile data that
 * can be tens of kilometres out - so it is only trusted to tell island groups
 * apart, never to measure distance.
 *
 * Nothing more precise than a city is ever kept: a GPS reading is reduced to
 * the nearest city or municipality here, and distances are measured between
 * the two places' own coordinates, not from where the person stood.
 *
 * The places are src/data/ph-places.json, built from Wikidata by
 * scripts/fetch-ph-places.js.
 */
import { createRequire } from 'node:module';

import { badRequest } from '../lib/errors.js';

/** Up to this far apart, a purchase place and a check are simply nearby. */
export const NEARBY_KM = 50;
/** Up to this far, and in the same island group, a purchase place is plausible. */
export const PLAUSIBLE_KM = 300;
/** A GPS reading vaguer than this (in metres) says nothing a city can use. */
export const MAX_GPS_ACCURACY_M = 20_000;
/** A reading this far from every listed place is not in the Philippines. */
const MAX_NEAREST_KM = 60;

// Vercel ships a serverless function with only the files its tracer (@vercel/nft)
// can see the code load. It follows a call to a function NAMED `require` with a
// literal path - so the name matters: `createRequire(...)('../data/...')`,
// called without one, is not followed, the list is left out of the function,
// and the whole API fails to start. tests/vercel-bundle.test.js holds this.
const require = createRequire(import.meta.url);
const DATA = require('../data/ph-places.json');

/**
 * Every place, as { code, name, province, region, island, lat, lng, label }.
 * The label is what a person reads and picks: "Bacoor, Cavite", or the
 * region for a city that belongs to no province ("Makati, Metro Manila").
 */
const PLACES = DATA.places.map(([code, name, province, region, island, lat, lng]) => ({
  code, name, province, region, island, lat, lng,
  label: `${name}, ${province ?? region}`,
}));
const BY_CODE = new Map(PLACES.map((p) => [p.code, p]));

/** The list the portal's picker searches: code and label only - no coordinates. */
export function list() {
  return PLACES.map((p) => [p.code, p.label]);
}

export function byCode(code) {
  return BY_CODE.get(String(code ?? '')) ?? null;
}

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * The listed place nearest a point, or null when the point is nowhere near
 * any of them (abroad, or a nonsense reading). A straight scan: 1,642 places
 * is nothing, and this runs once per request that brings a location.
 */
export function nearest(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null;
  let bestKm = Infinity;
  for (const p of PLACES) {
    const km = distanceKm({ lat, lng }, p);
    if (km < bestKm) {
      best = p;
      bestKm = km;
    }
  }
  return bestKm <= MAX_NEAREST_KM ? best : null;
}

/**
 * Where the internet connection says the request came from, as a place.
 *
 * Vercel sends the connection's approximate coordinates; the nearest place to
 * them is used. Without those (another host, local development), a city name
 * that matches exactly one place is used instead. Anything outside the
 * Philippines is no answer at all.
 */
export function fromConnection(req) {
  const h = (name) => req?.get?.(name) || null;
  const country = h('x-vercel-ip-country') || h('cf-ipcountry') || h('x-geo-country');
  if (country && country.toUpperCase() !== 'PH') return null;

  const lat = Number.parseFloat(h('x-vercel-ip-latitude'));
  const lng = Number.parseFloat(h('x-vercel-ip-longitude'));
  if (Number.isFinite(lat) && Number.isFinite(lng)) return nearest(lat, lng);

  let city = h('x-vercel-ip-city') || h('x-geo-city');
  if (!city) return null;
  try {
    city = decodeURIComponent(city);
  } catch {
    /* kept as it came */
  }
  const matches = PLACES.filter((p) => p.name.toLowerCase() === city.trim().toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

/**
 * A GPS reading from the browser, checked and reduced to a place.
 * Returns null when there is none or it is too vague to place a city.
 */
export function fromGps(location) {
  if (location === undefined || location === null) return null;
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  const accuracy = location.accuracy === undefined ? 0 : Number(location.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw badRequest('The location must have a latitude and a longitude.');
  }
  if (!Number.isFinite(accuracy) || accuracy > MAX_GPS_ACCURACY_M) return null;
  return nearest(lat, lng);
}

/** How a purchase place sits against where the check was made. See the top of the file. */
export function assess(purchase, located, source) {
  if (!purchase || !located) return { consistency: 'unknown', distanceKm: null };
  const km = distanceKm(purchase, located);
  if (source !== 'gps') {
    // The connection cannot measure distance; it can only tell island groups apart.
    return { consistency: purchase.island === located.island ? 'plausible' : 'inconsistent', distanceKm: null };
  }
  const rounded = Math.round(km);
  if (km <= NEARBY_KM) return { consistency: 'nearby', distanceKm: rounded };
  if (purchase.island !== located.island) return { consistency: 'inconsistent', distanceKm: rounded };
  return { consistency: km <= PLAUSIBLE_KM ? 'plausible' : 'inconsistent', distanceKm: rounded };
}

/**
 * Everything stored about the place of one check or report, from what the
 * browser sent. `placeCode` is the purchase place picked from the list;
 * `location` a GPS reading, if the person allowed one. The row fields come
 * back ready to write - the same on a check place and on a report.
 */
export function facts({ placeCode, outlet, location, req }) {
  const purchase = placeCode ? byCode(placeCode) : null;
  if (placeCode && !purchase) throw badRequest('That place is not on the list. Choose it again.');

  const gps = fromGps(location);
  const located = gps ?? fromConnection(req);
  const source = gps ? 'gps' : located ? 'network' : 'none';
  const { consistency, distanceKm: km } = assess(purchase, located, source);

  return {
    purchase_place_code: purchase?.code ?? null,
    purchase_place: purchase?.label ?? null,
    purchase_island: purchase?.island ?? null,
    // 200, the limit the report's "where did you buy it" always had.
    purchase_outlet: outlet ? String(outlet).trim().slice(0, 200) || null : null,
    located_place_code: located?.code ?? null,
    located_place: located?.label ?? null,
    located_island: located?.island ?? null,
    location_source: source,
    place_distance_km: km,
    place_consistency: consistency,
  };
}

export default {
  NEARBY_KM, PLAUSIBLE_KM, MAX_GPS_ACCURACY_M,
  list, byCode, distanceKm, nearest, fromConnection, fromGps, assess, facts,
};
