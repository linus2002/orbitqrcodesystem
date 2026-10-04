#!/usr/bin/env node
/**
 * Rebuild src/data/ph-places.json - every city and municipality of the
 * Philippines, with the coordinates the purchase-place check measures from.
 *
 *   node scripts/fetch-ph-places.js
 *
 * A developer tool, never run by the build or the server: the file it writes
 * is committed, so what the app compares against is fixed and reviewable,
 * and a change to it shows up as a diff.
 *
 * Source: Wikidata, whose data is public domain (CC0 1.0), so the file carries
 * no licence obligations. It takes every item that is a municipality, a
 * component city, an independent component city or a highly urbanised city
 * of the Philippines and has a PSGC code (P988) - 1,642 in 2026, which is the
 * PSA's own count - with its coordinates (P625), its province and its region.
 * Run it again when the PSA creates or converts a city; check the counts it
 * prints against the PSA before committing.
 */
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Wikidata's IPv6 address times out on some networks. If the request still
// times out, run the script again - the query itself takes a few seconds.
dns.setDefaultResultOrder('ipv4first');

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'src', 'data', 'ph-places.json');

/** The island group of each region, by its Wikidata name. */
const ISLAND_GROUP = {
  'Ilocos Region': 'luzon',
  'Cagayan Valley': 'luzon',
  'Central Luzon': 'luzon',
  Calabarzon: 'luzon',
  Mimaropa: 'luzon',
  'Bicol Region': 'luzon',
  'Metro Manila': 'luzon',
  'Cordillera Administrative Region': 'luzon',
  'Western Visayas': 'visayas',
  'Central Visayas': 'visayas',
  'Eastern Visayas': 'visayas',
  'Negros Island Region': 'visayas',
  'Zamboanga Peninsula': 'mindanao',
  'Northern Mindanao': 'mindanao',
  'Davao Region': 'mindanao',
  Soccsksargen: 'mindanao',
  Caraga: 'mindanao',
  Bangsamoro: 'mindanao',
};

const QUERY = `SELECT ?item ?itemLabel ?code ?lat ?lng ?provLabel ?regionLabel WHERE {
  VALUES ?kind { wd:Q24764 wd:Q106078286 wd:Q29946056 wd:Q106079704 }
  ?item wdt:P31 ?kind ; wdt:P17 wd:Q928 ; wdt:P988 ?code .
  OPTIONAL { ?item p:P625/psv:P625 [ wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lng ] . }
  OPTIONAL { ?item wdt:P131 ?prov . ?prov wdt:P31 wd:Q24746 . }
  OPTIONAL { ?item wdt:P131+ ?region . ?region wdt:P31 wd:Q24698 . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}`;

const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(QUERY)}`, {
  headers: { 'User-Agent': 'QRShield-ph-places/1.0 (scripts/fetch-ph-places.js)' },
});
if (!res.ok) throw new Error(`Wikidata answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
const rows = (await res.json()).results.bindings;

// One entry per item. An item can come back more than once (two codes, say);
// the 10-digit PSGC is the current format, so it wins.
const byItem = new Map();
for (const b of rows) {
  const value = (k) => b[k]?.value ?? null;
  const prev = byItem.get(value('item'));
  const code = value('code');
  if (prev && !(code.length === 10 && prev.code.length !== 10)) continue;
  byItem.set(value('item'), {
    code,
    name: value('itemLabel'),
    province: value('provLabel') ?? prev?.province ?? null,
    region: value('regionLabel') ?? prev?.region ?? null,
    lat: value('lat') === null ? null : Number(value('lat')),
    lng: value('lng') === null ? null : Number(value('lng')),
  });
}

const places = [...byItem.values()];
const problems = [
  ...places.filter((p) => !ISLAND_GROUP[p.region]).map((p) => `${p.name}: unknown region "${p.region}"`),
  ...places.filter((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lng)).map((p) => `${p.name}: no coordinates`),
];
const codes = new Set(places.map((p) => p.code));
if (codes.size !== places.length) problems.push('two places share a PSGC code');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const round = (n) => Math.round(n * 1e4) / 1e4; // about 11 m - far finer than a city
places.sort((a, b) => a.name.localeCompare(b.name) || (a.province ?? '').localeCompare(b.province ?? ''));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      source: 'Wikidata (public domain, CC0 1.0): cities and municipalities of the Philippines with a PSGC code (P988)',
      fetched: new Date().toISOString().slice(0, 10),
      fields: ['code', 'name', 'province', 'region', 'island', 'lat', 'lng'],
      places: places.map((p) => [p.code, p.name, p.province, p.region, ISLAND_GROUP[p.region], round(p.lat), round(p.lng)]),
    },
    null,
    0
  ).replace(/\],\[/g, '],\n[')}\n`
);

const count = (island) => places.filter((p) => ISLAND_GROUP[p.region] === island).length;
console.log(
  `Wrote ${places.length} places to ${path.relative(ROOT, OUT)} ` +
    `(Luzon ${count('luzon')}, Visayas ${count('visayas')}, Mindanao ${count('mindanao')}; ` +
    `${new Set(places.map((p) => p.province).filter(Boolean)).size} provinces, ` +
    `${new Set(places.map((p) => p.region)).size} regions).`
);
