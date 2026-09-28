/**
 * What "where did you buy it" needs from outside the page: the list of
 * cities and towns, the phone's location (only when the person taps for it),
 * and the rules for which towns it offers to tap.
 */
import { api } from '../lib/api.js';

let loading = null;

/** The list, as [[code, label]], fetched once per page and shared. */
export function loadPlaces() {
  loading ??= api('/api/places')
    .then((res) => res.places)
    .catch((err) => {
      loading = null; // let the next picker try again
      throw err;
    });
  return loading;
}

/** Lower case, accents off: "Las Piñas" is found by typing "las pinas". */
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * The places matching what was typed: those whose name starts with it
 * first, then those with any word starting with it. At most `limit`.
 */
export function searchPlaces(places, term, limit = 8) {
  const t = fold(term.trim());
  if (t.length < 2) return [];
  const first = [];
  const rest = [];
  for (const entry of places) {
    const label = fold(entry[1]);
    if (label.startsWith(t)) first.push(entry);
    else if (label.split(/[\s,()-]+/).some((word) => word.startsWith(t))) rest.push(entry);
    if (first.length >= limit) break;
  }
  return [...first, ...rest].slice(0, limit);
}

/**
 * The phone's location, asked for now - the phone shows its own "allow?"
 * first. Resolves { lat, lng, accuracy }; rejects with a sentence a person
 * can read. Coarse is enough (only the city is kept), which is also quicker
 * and kinder to the battery.
 */
export function askLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This phone or browser cannot share its location. You can still send this.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        }),
      (err) =>
        reject(
          new Error(
            err.code === 1
              ? 'Location was not shared. That is fine - you can still send this.'
              : 'Your location could not be found. You can still send this.'
          )
        ),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 }
    );
  });
}

/**
 * The shop box after a town is picked. An offer's shop (last time's) fills
 * the box if it is empty; a shop filled that way goes again when a different
 * town is picked, so last time's shop never rides along with another town.
 * Anything the person typed is theirs and is left alone.
 */
export function shopAfterPick({ outlet, filled }, offer) {
  const untouched = !outlet.trim() || (filled !== null && outlet === filled);
  if (offer?.outlet && untouched) return { outlet: offer.outlet, filled: offer.outlet };
  if (filled !== null && outlet === filled) return { outlet: '', filled: null };
  return { outlet, filled };
}

/**
 * The towns worth offering: where this person bought their last pack (with
 * its shop), and where their connection says they are now - each saying where
 * it came from. Offered, never filled in.
 */
export function placeOffers(portal) {
  const offers = [];
  const last = portal?.checker?.lastPurchase;
  if (last?.code) {
    offers.push({
      place: { code: last.code, label: last.label },
      outlet: last.outlet ?? '',
      why: last.outlet ? `Where you bought your last pack (${last.outlet})` : 'Where you bought your last pack',
    });
  }
  const here = portal?.here;
  if (here?.code && here.code !== last?.code) {
    offers.push({
      place: { code: here.code, label: here.label },
      outlet: '',
      why: 'Near where you are now, going by your internet connection - it can be a town or two out',
    });
  }
  return offers;
}
