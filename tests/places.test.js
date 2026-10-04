/**
 * Where a pack was bought, against where it was checked.
 *
 * The thresholds were agreed with the business: up to 50 km is nearby; up to
 * 300 km in the same island group is plausible; beyond that, or across island
 * groups, is inconsistent. Without GPS only the island group can be compared.
 * These pin the rules with real places, so a change to a number or to the
 * city list shows up as a failing case someone has to look at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import * as places from '../src/services/places.js';

const code = (label) => {
  const hit = places.list().find(([, l]) => l === label);
  assert.ok(hit, `${label} is on the list`);
  return hit[0];
};
const place = (label) => places.byCode(code(label));
const BACOOR = 'Bacoor, Cavite';

/** A request as Express presents it, with only the headers given. */
const req = (headers) => ({ get: (name) => headers[name.toLowerCase()] ?? undefined });

test('the list is every city and municipality, with codes unique and no coordinates handed out', () => {
  const list = places.list();
  assert.equal(list.length, 1642, 'the PSA count of cities and municipalities');
  assert.equal(new Set(list.map(([c]) => c)).size, list.length, 'codes are unique');
  assert.equal(new Set(list.map(([, l]) => l)).size, list.length, 'labels are unique, so a pick is unambiguous');
  assert.ok(list.every((entry) => entry.length === 2), 'code and label only');
});

test('with GPS: the agreed tiers, measured between real places', () => {
  const cases = [
    ['Las Piñas, Metro Manila', 'nearby'],
    ['Quezon City, Metro Manila', 'nearby'],
    ['Batangas City, Batangas', 'plausible'],
    ['Baguio, Cordillera Administrative Region', 'plausible'],
    ['Laoag, Ilocos Norte', 'inconsistent'], // same island group, but over 300 km
    ['Cebu City, Central Visayas', 'inconsistent'], // another island group
    ['Zamboanga, Zamboanga Peninsula', 'inconsistent'],
  ];
  for (const [bought, expected] of cases) {
    const { consistency, distanceKm } = places.assess(place(bought), place(BACOOR), 'gps');
    assert.equal(consistency, expected, `${bought} vs ${BACOOR}`);
    assert.ok(Number.isInteger(distanceKm));
  }
  // Nearby wins even across island groups: a ferry town and its neighbour.
  assert.equal(places.assess(place('Matnog, Sorsogon'), place('Allen, Northern Samar'), 'gps').consistency, 'nearby');
});

test('without GPS only the island group is compared, and no distance is claimed', () => {
  const same = places.assess(place('Laoag, Ilocos Norte'), place(BACOOR), 'network');
  assert.deepEqual(same, { consistency: 'plausible', distanceKm: null });
  const other = places.assess(place('Zamboanga, Zamboanga Peninsula'), place(BACOOR), 'network');
  assert.deepEqual(other, { consistency: 'inconsistent', distanceKm: null });
  // The known cost of a coarse source: neighbours across a strait look apart.
  assert.equal(places.assess(place('Matnog, Sorsogon'), place('Allen, Northern Samar'), 'network').consistency, 'inconsistent');
});

test('a missing side is unknown, never a guess', () => {
  assert.equal(places.assess(null, place(BACOOR), 'gps').consistency, 'unknown');
  assert.equal(places.assess(place(BACOOR), null, 'none').consistency, 'unknown');
});

test('a GPS reading is reduced to the nearest place, and a vague or foreign one to nothing', () => {
  assert.equal(places.fromGps({ lat: 14.4624, lng: 120.9645, accuracy: 30 }).label, BACOOR);
  assert.equal(places.fromGps({ lat: 14.4624, lng: 120.9645, accuracy: 25_000 }), null, 'too vague');
  assert.equal(places.fromGps({ lat: 35.68, lng: 139.69 }), null, 'Tokyo is no Philippine city');
  assert.equal(places.fromGps(undefined), null);
  assert.throws(() => places.fromGps({ lat: 'north', lng: 120 }), /latitude and a longitude/);
});

test('the connection: Vercel coordinates first, then a city name that names one place', () => {
  const vercel = req({ 'x-vercel-ip-country': 'PH', 'x-vercel-ip-latitude': '14.45', 'x-vercel-ip-longitude': '120.98' });
  assert.equal(places.fromConnection(vercel).label, 'Las Piñas, Metro Manila');

  assert.equal(places.fromConnection(req({ 'x-vercel-ip-country': 'JP', 'x-vercel-ip-latitude': '14.45', 'x-vercel-ip-longitude': '120.98' })), null);
  assert.equal(places.fromConnection(req({ 'x-vercel-ip-city': 'Las%20Pi%C3%B1as' })).label, 'Las Piñas, Metro Manila');
  assert.equal(places.fromConnection(req({ 'x-vercel-ip-city': 'San Jose' })), null, 'nine San Joses - no guess');
  assert.equal(places.fromConnection(req({})), null);
});

test('facts: what is stored holds places, never coordinates', () => {
  const stored = places.facts({
    placeCode: code('Zamboanga, Zamboanga Peninsula'),
    outlet: '  Mercury Drug, Veterans Ave  ',
    location: { lat: 14.4624, lng: 120.9645, accuracy: 15 },
    req: req({}),
  });
  assert.equal(stored.purchase_place, 'Zamboanga, Zamboanga Peninsula');
  assert.equal(stored.purchase_outlet, 'Mercury Drug, Veterans Ave');
  assert.equal(stored.located_place, BACOOR);
  assert.equal(stored.location_source, 'gps');
  assert.equal(stored.place_consistency, 'inconsistent');
  assert.ok(!JSON.stringify(stored).includes('14.4624'), 'no raw latitude');
  assert.ok(!Object.keys(stored).some((k) => /lat|lng|accuracy/.test(k)));

  assert.throws(() => places.facts({ placeCode: '0000000000', req: req({}) }), /not on the list/);
  assert.equal(places.facts({ req: req({}) }).location_source, 'none');
});
