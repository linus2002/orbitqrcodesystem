#!/usr/bin/env node
/**
 * Seed the database with a realistic demonstration dataset.
 *
 *   npm run db:seed
 *
 * What it creates:
 *   - three staff accounts, one per role
 *   - four products with patient information leaflets
 *   - six batches covering every lifecycle state, including a recalled batch,
 *     an expired batch and a sandbox/pilot batch
 *   - serialized codes for each batch
 *   - ~30 days of backdated scan history, containing a deliberate counterfeit
 *     cluster on the antimalarial line (the highest-risk real-world category)
 *   - the alerts, consumer reports and shipments that history implies
 *
 * Re-running is safe: the script clears the demo tables first.
 */
import * as db from '../src/db/index.js';
import { config } from '../src/config.js';
import { hashPassword, pseudonymize } from '../src/lib/crypto.js';
import * as serialization from '../src/services/serialization.js';
import * as verification from '../src/services/verification.js';

// ---------------------------------------------------------------------------
// Deterministic pseudo-random generator, so every seed run produces the same
// demo data and screenshots/tests stay stable.
// ---------------------------------------------------------------------------
let seedState = 0x2f6e2b1;
const rnd = () => {
  seedState ^= seedState << 13;
  seedState ^= seedState >>> 17;
  seedState ^= seedState << 5;
  return Math.abs(seedState % 100000) / 100000;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const iso = (d) => d.toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const ymd = (d) => d.toISOString().slice(0, 10);

db.open();
await db.migrate({ silent: true });

console.log('Seeding QR Shield demonstration data...\n');

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------
await db.tx(async () => {
  for (const t of [
    'sms_log', 'audit_log', 'consumer_reports', 'alerts', 'scans',
    'shipments', 'codes', 'batches', 'leaflets', 'products', 'sessions', 'users', 'settings',
  ]) {
    await db.run(`DELETE FROM "${t}"`);
  }
  await db.run(`DELETE FROM sqlite_sequence`);
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
const users = [
  { email: config.seed.adminEmail, fullName: 'Adaeze Okonkwo', role: 'admin', password: config.seed.adminPassword },
  { email: 'security@qrshield.example', fullName: 'Marcus Reyes', role: 'security', password: 'SecurityTeam!2026' },
  { email: 'regulator@qrshield.example', fullName: 'Dr. Priya Raman', role: 'regulator', password: 'Regulator!2026' },
];

const userIds = {};
for (const u of users) {
  const { lastInsertRowid } = await db.run(
    `INSERT INTO users (email, full_name, password_hash, role, must_change_pw) VALUES (?,?,?,?,0)`,
    [u.email.toLowerCase(), u.fullName, hashPassword(u.password), u.role]
  );
  userIds[u.role] = lastInsertRowid;
}
console.log(`  users      : ${users.length}`);

// ---------------------------------------------------------------------------
// Products + leaflets
// ---------------------------------------------------------------------------
const PRODUCTS = [
  {
    sku: 'AMX25', name: 'Amoxicillin', genericName: 'Amoxicillin trihydrate',
    strength: '250 mg', dosageForm: 'Capsule', packSize: '21 capsules',
    manufacturer: 'Northbridge Pharmaceuticals', category: 'Antibiotic',
    leaflet: [
      { heading: 'What this medicine is for', body: 'Amoxicillin is an antibiotic used to treat bacterial infections of the chest, ear, throat, urinary tract and skin. It does not work against viral infections such as colds or flu.' },
      { heading: 'How to take it', body: 'Adults and children over 12: one capsule three times a day, spaced evenly. Swallow whole with water. Complete the full course even if you feel better - stopping early allows the infection to return and encourages resistance.' },
      { heading: 'Do not take if', body: 'You have ever had an allergic reaction to penicillin or any other antibiotic. Tell your doctor if you have kidney problems or glandular fever.' },
      { heading: 'Possible side effects', body: 'Common: nausea, diarrhoea, skin rash. Seek urgent medical help for swelling of the face or throat, difficulty breathing, or severe watery diarrhoea.' },
      { heading: 'Storage', body: 'Store below 25 C in the original pack, away from light and moisture. Keep out of the sight and reach of children.' },
      { heading: 'Reporting a problem', body: 'Report suspected side effects to your national pharmacovigilance centre. Report a suspected counterfeit pack using the Report button on this page.' },
    ],
  },
  {
    sku: 'ART20', name: 'Artemether / Lumefantrine', genericName: 'Artemether 20 mg + Lumefantrine 120 mg',
    strength: '20/120 mg', dosageForm: 'Tablet', packSize: '24 tablets',
    manufacturer: 'Northbridge Pharmaceuticals', category: 'Antimalarial',
    leaflet: [
      { heading: 'What this medicine is for', body: 'A fixed-dose combination used to treat uncomplicated malaria caused by Plasmodium falciparum. It is not for preventing malaria.' },
      { heading: 'How to take it', body: 'Adults over 35 kg: four tablets as a single dose, then four tablets again after 8, 24, 36, 48 and 60 hours - 24 tablets over three days. Take with food or a milky drink to help absorption.' },
      { heading: 'Important warning', body: 'Counterfeit antimalarials are widespread. Always verify the pack code before use. If the result is anything other than GENUINE, do not take the medicine and return it to the pharmacy.' },
      { heading: 'Possible side effects', body: 'Common: headache, dizziness, loss of appetite, palpitations. Stop and seek advice if you develop an irregular heartbeat.' },
      { heading: 'Storage', body: 'Store below 30 C in the original blister. Do not use if the blister is torn or the tablets are discoloured.' },
    ],
  },
  {
    sku: 'PCM50', name: 'Paracetamol', genericName: 'Paracetamol (acetaminophen)',
    strength: '500 mg', dosageForm: 'Tablet', packSize: '16 tablets',
    manufacturer: 'Corelis Healthcare', category: 'Analgesic',
    leaflet: [
      { heading: 'What this medicine is for', body: 'Relief of mild to moderate pain and reduction of fever.' },
      { heading: 'How to take it', body: 'Adults: one or two tablets every four to six hours. Do not take more than eight tablets (4 g) in 24 hours.' },
      { heading: 'Overdose warning', body: 'Taking more than the stated dose can cause severe, delayed liver damage even if you feel well. Seek immediate medical help after an overdose - treatment is most effective within eight hours.' },
      { heading: 'Storage', body: 'Store below 25 C. Keep out of the sight and reach of children.' },
    ],
  },
  {
    sku: 'INS10', name: 'Insulin Glargine', genericName: 'Insulin glargine (rDNA origin)',
    strength: '100 units/mL', dosageForm: 'Pre-filled pen', packSize: '5 x 3 mL pens',
    manufacturer: 'Corelis Healthcare', category: 'Antidiabetic',
    leaflet: [
      { heading: 'What this medicine is for', body: 'A long-acting insulin that provides steady background insulin cover for 24 hours in adults and children with diabetes.' },
      { heading: 'How to use it', body: 'Inject under the skin once daily at the same time each day. Rotate injection sites. Never inject into a vein.' },
      { heading: 'Cold chain', body: 'Unopened pens must be kept refrigerated at 2-8 C and never frozen. A pen in use may be kept below 25 C for up to 28 days. If the cold chain was broken, do not use the pen.' },
      { heading: 'Low blood sugar', body: 'Carry fast-acting sugar. Signs of hypoglycaemia include sweating, shaking, hunger and confusion.' },
    ],
  },
];

const productIds = {};
const leafletIds = {};
for (const p of PRODUCTS) {
  const { lastInsertRowid: pid } = await db.run(
    `INSERT INTO products (sku, name, generic_name, strength, dosage_form, pack_size, manufacturer, category)
     VALUES (?,?,?,?,?,?,?,?)`,
    [p.sku, p.name, p.genericName, p.strength, p.dosageForm, p.packSize, p.manufacturer, p.category]
  );
  productIds[p.sku] = pid;

  const { lastInsertRowid: lid } = await db.run(
    `INSERT INTO leaflets (product_id, version, language, sections_json) VALUES (?,?,?,?)`,
    [pid, '1.0', 'en', JSON.stringify(p.leaflet)]
  );
  leafletIds[p.sku] = lid;
}
console.log(`  products   : ${PRODUCTS.length} (each with a leaflet)`);

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------
const BATCHES = [
  { number: 'AMX25-2608A', sku: 'AMX25', mfg: daysAgo(40), expiry: new Date(Date.now() + 700 * 86400000), qty: 1200, target: 'distributed' },
  { number: 'ART20-2607A', sku: 'ART20', mfg: daysAgo(70), expiry: new Date(Date.now() + 540 * 86400000), qty: 1500, target: 'distributed' },
  { number: 'ART20-2412B', sku: 'ART20', mfg: daysAgo(400), expiry: daysAgo(25), qty: 600, target: 'distributed', note: 'Past expiry - still in circulation somewhere.' },
  { number: 'PCM50-2609A', sku: 'PCM50', mfg: daysAgo(12), expiry: new Date(Date.now() + 900 * 86400000), qty: 900, target: 'released' },
  { number: 'INS10-2606A', sku: 'INS10', mfg: daysAgo(95), expiry: new Date(Date.now() + 300 * 86400000), qty: 300, target: 'recalled', recallReason: 'Cold-chain excursion recorded in transit on the Lagos-Kano route; potency cannot be assured.' },
  { number: 'AMX25-2609P', sku: 'AMX25', mfg: daysAgo(5), expiry: new Date(Date.now() + 720 * 86400000), qty: 60, target: 'released', isTest: true, note: 'Pilot / sandbox batch - scans are excluded from live dashboards.' },
];

const batchIds = {};
for (const b of BATCHES) {
  const { lastInsertRowid: bid } = await db.run(
    `INSERT INTO batches (batch_number, product_id, mfg_date, expiry_date, quantity, is_test, leaflet_id, notes, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [b.number, productIds[b.sku], ymd(b.mfg), ymd(b.expiry), b.qty, b.isTest ? 1 : 0,
     leafletIds[b.sku], b.note ?? null, userIds.admin, iso(b.mfg)]
  );
  batchIds[b.number] = bid;

  // Run the real serialization engine, then walk the real lifecycle.
  await serialization.issueCodes(bid, { actor: { id: userIds.admin, email: users[0].email } });

  const path = ['printed', 'released', 'distributed', 'recalled'];
  for (const step of path) {
    const current = (await db.get('SELECT status FROM batches WHERE id = ?', [bid])).status;
    if (current === b.target) break;
    if (step === 'recalled' && b.target !== 'recalled') break;
    await serialization.transition(bid, step, {
      actor: { id: userIds.admin, email: users[0].email },
      reason: step === 'recalled' ? b.recallReason : null,
    });
  }
}
const totalCodes = await db.scalar('SELECT COUNT(*) FROM codes');
console.log(`  batches    : ${BATCHES.length}`);
console.log(`  codes      : ${totalCodes.toLocaleString()} serialized`);

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------
const PHARMACIES = [
  { name: 'Riverside Community Pharmacy', region: 'Lagos', type: 'pharmacy' },
  { name: 'St. Luke Hospital Dispensary', region: 'Lagos', type: 'hospital' },
  { name: 'Kano Central Distributors', region: 'Kano', type: 'distributor' },
  { name: 'Greenfield Chemists', region: 'Abuja', type: 'pharmacy' },
  { name: 'Harmony Health Stores', region: 'Ibadan', type: 'pharmacy' },
];

let shipmentNo = 1000;
for (const b of BATCHES.filter((x) => ['distributed', 'recalled'].includes(x.target))) {
  for (let i = 0; i < 3; i++) {
    const dest = PHARMACIES[(shipmentNo + i) % PHARMACIES.length];
    const shippedAt = daysAgo(between(5, 30));
    await db.run(
      `INSERT INTO shipments (reference, batch_id, quantity, from_site, to_name, to_type, to_region, status, shipped_at, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        `SHP-${shipmentNo++}`, batchIds[b.number], Math.floor(b.qty / 4),
        'Northbridge Plant 2, Ogun', dest.name, dest.type, dest.region,
        i === 2 ? 'in_transit' : 'received', iso(shippedAt),
        i === 2 ? null : iso(new Date(shippedAt.getTime() + 2 * 86400000)),
      ]
    );
  }
}
console.log(`  shipments  : ${await db.scalar('SELECT COUNT(*) FROM shipments')}`);

// ---------------------------------------------------------------------------
// Scan history
//
// Backdated rows are inserted directly rather than through verify(), because
// verify() always stamps "now". The counters on `codes` are then reconciled to
// match, so the data is self-consistent.
// ---------------------------------------------------------------------------
const LOCATIONS = [
  { country: 'NG', region: 'Lagos', city: 'Ikeja' },
  { country: 'NG', region: 'Lagos', city: 'Surulere' },
  { country: 'NG', region: 'Kano', city: 'Kano' },
  { country: 'NG', region: 'FCT', city: 'Abuja' },
  { country: 'NG', region: 'Oyo', city: 'Ibadan' },
  { country: 'GH', region: 'Greater Accra', city: 'Accra' },
];

const INSERT_SCAN = `INSERT INTO scans (code_text, code_id, batch_id, product_id, result, reason, channel,
                      signature_state, scan_number, ip_hash, user_agent, country, region, city, is_test, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** Record a backdated scan and keep the code's counters in step. */
async function historicScan({ code, result, reason, daysBack, channel = 'web', location, ipSeed, scanNumber = 1 }) {
  const when = new Date(daysAgo(daysBack).getTime() + between(0, 86399) * 1000);
  const loc = location ?? pick(LOCATIONS);
  await db.run(INSERT_SCAN, [
    code.code, code.id, code.batch_id, code.product_id, result, reason, channel,
    channel === 'sms' ? null : 'valid', scanNumber,
    pseudonymize(`seed-${ipSeed ?? between(1, 5000)}`, config.secrets.session),
    channel === 'sms' ? null : 'Mozilla/5.0 (Linux; Android 13) Mobile Safari/537.36',
    loc.country, loc.region, loc.city, code.is_test ?? 0, iso(when),
  ]);
  await db.run(
    `UPDATE codes SET scan_count = scan_count + 1,
            verified_count = verified_count + ?,
            first_scan_at = COALESCE(first_scan_at, ?),
            last_scan_at = ?,
            status = CASE WHEN ? = 'flagged' THEN 'flagged'
                          WHEN status IN ('issued','printed','released') THEN 'verified' ELSE status END,
            flagged_at = CASE WHEN ? = 'flagged' THEN COALESCE(flagged_at, ?) ELSE flagged_at END
      WHERE id = ?`,
    [result === 'genuine' ? 1 : 0, iso(when), iso(when), result, result, iso(when), code.id]
  );
  return { when, loc };
}

const codesOf = async (batchNumber, limit, offset = 0) =>
  db.all(
    `SELECT c.*, b.is_test FROM codes c JOIN batches b ON b.id = c.batch_id
      WHERE c.batch_id = ? ORDER BY c.unit_index LIMIT ? OFFSET ?`,
    [batchIds[batchNumber], limit, offset]
  );

// --- Normal, healthy traffic ------------------------------------------------
let genuineCount = 0;
for (const bn of ['AMX25-2608A', 'PCM50-2609A', 'ART20-2607A']) {
  const sample = await codesOf(bn, 140);
  for (const code of sample) {
    if (rnd() > 0.72) continue; // not every unit gets checked
    await historicScan({
      code,
      result: 'genuine',
      reason: 'ok',
      daysBack: between(0, 29),
      channel: rnd() > 0.88 ? 'sms' : 'web',
    });
    genuineCount++;
  }
}

// --- Counterfeit cluster on the antimalarial line ---------------------------
// A single cloned pack scanned repeatedly from several cities is the classic
// signature of a copied QR code, and is what the dashboard must surface.
const clonedCodes = await codesOf('ART20-2607A', 6, 300);
let duplicateCount = 0;
for (const code of clonedCodes) {
  await historicScan({ code, result: 'genuine', reason: 'ok', daysBack: between(20, 28), scanNumber: 1 });
  const copies = between(3, 7);
  for (let i = 0; i < copies; i++) {
    await historicScan({
      code,
      result: 'flagged',
      reason: 'duplicate_scan',
      daysBack: between(1, 18),
      location: pick(LOCATIONS),
      scanNumber: i + 2,
    });
    duplicateCount++;
  }
}

// --- Unknown codes: packs carrying invented codes ---------------------------
let unknownCount = 0;
for (let i = 0; i < 24; i++) {
  const when = daysAgo(between(0, 25));
  await db.run(INSERT_SCAN, [
    `ART20-${String(between(240101, 260931))}-${String(between(10000, 99999))}-${pick(['K7', 'M2', 'Q9', 'B4'])}`,
    null, null, null, 'flagged', 'unknown_code', 'web', 'absent', null,
    pseudonymize(`seed-unknown-${between(1, 40)}`, config.secrets.session),
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4) Mobile/15E148',
    ...Object.values(pick(LOCATIONS)), 0, iso(when)
  
  ]);
  unknownCount++;
}

// --- A code-guessing burst from one source ----------------------------------
const attackerIp = pseudonymize('seed-attacker-1', config.secrets.session);
for (let i = 0; i < 26; i++) {
  await db.run(INSERT_SCAN, [
    `ART20-260712-${String(between(10000, 99999))}-${pick(['A1', 'ZZ', '7K'])}`,
    null, null, null, 'invalid', 'checksum_failed', 'api', 'absent', null,
    attackerIp, 'python-requests/2.31.0', 'RU', null, null, 0,
    iso(new Date(daysAgo(3).getTime() + i * 45000))
  
  ]);
}

console.log(`  scans      : ${await db.scalar('SELECT COUNT(*) FROM scans')} (${genuineCount} genuine, ${duplicateCount} duplicates, ${unknownCount} unknown)`);

// ---------------------------------------------------------------------------
// Alerts derived from that history
// ---------------------------------------------------------------------------
async function alertFor(codeRow, type, severity, title, detail, status, daysBack) {
  const when = iso(daysAgo(daysBack));
  await db.run(
    `INSERT INTO alerts (type, severity, status, title, detail_json, code_id, batch_id, resolution_note, resolved_by, resolved_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      type, severity, status, title, JSON.stringify(detail),
      codeRow?.id ?? null, codeRow?.batch_id ?? null,
      status === 'resolved' ? 'Confirmed as a cloned pack. Distributor notified and the affected route is under review.' : null,
      status === 'resolved' ? userIds.security : null,
      status === 'resolved' ? when : null,
      when, when,
    ]
  );
}

for (const [i, code] of clonedCodes.entries()) {
  const occurrences = await db.scalar(`SELECT COUNT(*) FROM scans WHERE code_id = ? AND result = 'flagged'`, [code.id]);
  await alertFor(
    code, 'duplicate_scan',
    occurrences >= 6 ? 'critical' : 'high',
    `Duplicate scan on ${code.code} (${occurrences} repeats)`,
    { code: code.code, occurrences, batchNumber: 'ART20-2607A', product: 'Artemether / Lumefantrine' },
    i === 0 ? 'resolved' : i === 1 ? 'investigating' : 'open',
    between(1, 15)
  );
}

await alertFor(null, 'guess_attack', 'high',
  'Possible code-guessing: 26 failed lookups from one source',
  { ipHash: attackerIp, attempts: 26, windowHours: 1, userAgent: 'python-requests/2.31.0' },
  'open', 3);

const recalledCode = (await codesOf('INS10-2606A', 1))[0];
await alertFor(recalledCode, 'recalled_scan', 'critical',
  'Recalled batch INS10-2606A scanned by a patient',
  { batchNumber: 'INS10-2606A', product: 'Insulin Glargine', code: recalledCode.code },
  'investigating', 2);

const expiredCode = (await codesOf('ART20-2412B', 1))[0];
await alertFor(expiredCode, 'expired_scan', 'low',
  'Expired product scanned (batch ART20-2412B)',
  { batchNumber: 'ART20-2412B', expiryDate: ymd(daysAgo(25)) },
  'open', 1);

console.log(`  alerts     : ${await db.scalar('SELECT COUNT(*) FROM alerts')}`);

// ---------------------------------------------------------------------------
// Consumer reports
// ---------------------------------------------------------------------------
const REPORTS = [
  {
    code: clonedCodes[0].code,
    name: 'Chidinma A.',
    contact: 'chidinma.a@example.com',
    location: 'Roadside vendor near Oshodi market, Lagos',
    description: 'The app said this code was already used. The printing on the box is blurry and the foil seal was already broken when I bought it. The tablets smell different from the ones I got last month.',
    status: 'reviewing',
  },
  {
    code: null,
    name: 'Anonymous',
    contact: null,
    location: 'Street stall, Kano',
    description: 'There is no QR code on the box at all, only a sticker that looks printed at home. The pharmacy name is spelled wrong on the carton.',
    status: 'new',
  },
  {
    code: clonedCodes[1].code,
    name: 'Emeka O.',
    contact: '+234 800 000 0000',
    location: 'Greenfield Chemists, Abuja',
    description: 'Bought two packs, both gave the same warning. The pharmacist asked me to report it here.',
    status: 'new',
  },
];

for (const r of REPORTS) {
  const codeRow = r.code ? await db.get('SELECT id FROM codes WHERE code = ?', [r.code]) : null;
  await db.run(
    `INSERT INTO consumer_reports (code_text, code_id, reporter_name, reporter_contact, purchase_location, description, status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [r.code, codeRow?.id ?? null, r.name, r.contact, r.location, r.description, r.status, iso(daysAgo(between(1, 10)))]
  );
}
console.log(`  reports    : ${REPORTS.length}`);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
for (const s of [
  ['portal.banner', '', 'Optional notice shown at the top of the public verification portal.'],
  ['alerts.duplicate_threshold', '1', 'Repeat verifications before a duplicate alert is raised.'],
  ['support.phone', '+234 800 QRSHIELD', 'Contact number shown to patients on a flagged result.'],
  ['support.sms_shortcode', '32123', 'Shortcode patients text a code to when offline.'],
]) {
  await db.run('INSERT INTO settings (key, value, description) VALUES (?,?,?)', s);
}

// ---------------------------------------------------------------------------
// One live verification through the real code path, so the demo has a
// "just now" event and the full pipeline is proven end to end by the seed.
// ---------------------------------------------------------------------------
const liveCode = (await codesOf('AMX25-2608A', 1, 900))[0];
const liveResult = await verification.verify(liveCode.code, {
  channel: 'web',
  req: { clientIp: '203.0.113.42', get: () => null },
});

console.log(`  settings   : 4`);
console.log(`\n  Live verification test: ${liveCode.code} -> ${liveResult.result.toUpperCase()}`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n' + '-'.repeat(62));
console.log('  Sign in at http://localhost:3000/login');
console.log('-'.repeat(62));
for (const u of users) {
  console.log(`  ${u.role.padEnd(10)} ${u.email.padEnd(32)} ${u.password}`);
}
console.log('-'.repeat(62));
console.log('\n  Try these codes on the public portal at http://localhost:3000\n');
const samples = [
  ['GENUINE (unused)', (await codesOf('AMX25-2608A', 1, 1100))[0].code],
  ['GENUINE (unused)', (await codesOf('PCM50-2609A', 1, 800))[0].code],
  ['FLAGGED - already verified elsewhere', clonedCodes[0].code],
  ['FLAGGED - batch recalled', (await codesOf('INS10-2606A', 1, 10))[0].code],
  ['FLAGGED - past expiry', (await codesOf('ART20-2412B', 1, 10))[0].code],
  ['INVALID - not a real code', 'AMX25-260921-00483-K7'],
];
for (const [label, code] of samples) {
  console.log(`  ${code.padEnd(26)} ${label}`);
}
console.log('');

db.close();
