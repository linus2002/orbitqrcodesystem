/**
 * The "where did you buy it" box offers towns; it never fills one in.
 *
 * A guessed town left standing in the box would be saved unread - and a
 * connection guess saved that way would then be "checked" against itself.
 * So the guesses are offers to tap, and last time's shop only comes with
 * last time's town.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { placeOffers, shopAfterPick } from '../client/src/portal/where.js';

const BACOOR = { code: '042103000', label: 'Bacoor, Cavite' };
const LAS_PINAS = { code: '1380200000', label: 'Las Piñas, Metro Manila' };

const portal = ({ last, here } = {}) => ({
  checker: { name: 'Maria Santos', lastPurchase: last ?? null },
  here: here ?? null,
});

test('nothing to offer when neither last time nor the connection is known', () => {
  assert.deepEqual(placeOffers(portal()), []);
  assert.deepEqual(placeOffers(null), []);
});

test('last time and the connection are both offered, each saying where it came from', () => {
  const offers = placeOffers(portal({ last: { ...BACOOR, outlet: 'Mercury Drug, Molino' }, here: LAS_PINAS }));

  assert.deepEqual(offers.map((o) => o.place), [BACOOR, LAS_PINAS]);
  assert.equal(offers[0].why, 'Where you bought your last pack (Mercury Drug, Molino)');
  assert.equal(offers[0].outlet, 'Mercury Drug, Molino');
  assert.match(offers[1].why, /internet connection/);
  assert.equal(offers[1].outlet, '', 'the connection knows no shop');
});

test('the same town is offered once, as last time', () => {
  const offers = placeOffers(portal({ last: { ...BACOOR, outlet: null }, here: BACOOR }));

  assert.equal(offers.length, 1);
  assert.equal(offers[0].why, 'Where you bought your last pack');
});

test("tapping last time's town fills an empty shop box", () => {
  const offer = { place: BACOOR, outlet: 'Mercury Drug, Molino' };
  assert.deepEqual(shopAfterPick({ outlet: '', filled: null }, offer), {
    outlet: 'Mercury Drug, Molino',
    filled: 'Mercury Drug, Molino',
  });
});

test("a shop filled that way goes when another town is picked", () => {
  const after = shopAfterPick({ outlet: 'Mercury Drug, Molino', filled: 'Mercury Drug, Molino' }, null);
  assert.deepEqual(after, { outlet: '', filled: null });
});

test('a shop the person typed is never replaced or cleared', () => {
  const offer = { place: BACOOR, outlet: 'Mercury Drug, Molino' };
  assert.deepEqual(shopAfterPick({ outlet: 'Sidewalk stall', filled: null }, offer), {
    outlet: 'Sidewalk stall',
    filled: null,
  });
  assert.deepEqual(shopAfterPick({ outlet: 'Sidewalk stall', filled: null }, null), {
    outlet: 'Sidewalk stall',
    filled: null,
  });
  // Filled by an offer, then edited: it is theirs now.
  assert.deepEqual(shopAfterPick({ outlet: 'Mercury Drug, Molino 2', filled: 'Mercury Drug, Molino' }, null), {
    outlet: 'Mercury Drug, Molino 2',
    filled: 'Mercury Drug, Molino',
  });
});
