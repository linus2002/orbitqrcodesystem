/**
 * Two batches of one product made on the same day.
 *
 * A legacy code is SKU + manufacturing date + serial + checksum, and each
 * batch shuffles its serials over a space only ~100x its size - so two
 * batches of one SKU and one date share a serial space, and a second batch of
 * a few hundred units all but certainly lands on some of the first one's
 * codes. Issuance used to stop there ("code ... already exists"), leaving the
 * second batch impossible to issue. It now passes over a code another batch
 * holds and takes the next from its own sequence.
 *
 * New batches get compact codes (SKU + serial + checksum) whose serial space
 * per SKU is over a billion, so a natural clash is all but impossible - but
 * the same passing-over applies to them, and a batch part-issued in the
 * legacy format still finishes in it. The tests that need a natural clash
 * start their batches in the legacy format (startLegacy).
 *
 * What must hold, whatever happens part-way:
 *   - no code is ever stored twice, and no batch loses a code it has;
 *   - a batch ends with exactly `quantity` codes, unit indexes 0..quantity-1;
 *   - a run cut short finishes on the next run with the codes an unbroken
 *     run would have stored - including when the write that was cut short
 *     had in fact landed;
 *   - a code taken by another issuance between look-up and write is passed
 *     over, not overwritten;
 *   - two issuances at once - of two batches, or of the same one - finish
 *     correctly, and the batch is recorded as issued once;
 *   - anything that does not add up stops the issuance, leaves the batch
 *     planned, and says so, rather than marking it issued.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import './setup-env.js';
import { freshDb, startServer, seedUser } from './helpers.js';
import * as db from '../src/db/index.js';
import * as serialization from '../src/services/serialization.js';
import { config } from '../src/config.js';
import {
  batchCandidates, generateBatchCodes, serialWidthFor, parseCode, serialPermutation, buildCode, dateSegment,
  buildCompactCode, encodeSerial, codeFormatOf, CODE_FORMAT, COMPACT_WIDTH,
} from '../src/lib/codes.js';

const DAY = '2026-09-28';

beforeEach(async () => {
  await freshDb();
  await db.insert('product', {
    sku: 'BEL25', name: 'Beltro', strength: '25 mg', dosage_form: 'Tablet', manufacturer: 'Northbridge',
  });
});

const makeBatch = (batchNumber, quantity, extra = {}) =>
  db.insert('batch', {
    batch_number: batchNumber, product_id: 1, mfg_date: DAY, expiry_date: '2028-09-27', quantity, ...extra,
  });

/** A batch's stored codes, in unit order. */
const storedCodes = async (batchId) =>
  db.findMany('code', { batch_id: batchId }, { order: 'unit_index asc', fields: ['id', 'code', 'unit_index', 'serial'] });

/** The batch's candidates in order - what issuance walks through. */
const candidatesOf = (batch, format = CODE_FORMAT.COMPACT) =>
  batchCandidates({
    sku: 'BEL25', mfgDate: batch.mfg_date, width: serialWidthFor(batch.quantity),
    batchKey: `${batch.batch_number}:${batch.id}`, secret: config.secrets.code, format,
  });

/**
 * Store a batch's first legacy code, as a run of the legacy issuance cut
 * short would have left it - so issuing the batch finishes it in that format.
 */
async function startLegacy(batch) {
  const [c] = candidatesOf(batch, CODE_FORMAT.LEGACY);
  await db.insert('code', { code: c.code, batch_id: batch.id, product_id: 1, unit_index: 0, serial: c.serial });
}

/**
 * What a batch must end with: its first `quantity` candidates that no other
 * batch holds, and how many held ones were passed over on the way.
 */
function expected(batch, heldElsewhere, format) {
  const codes = [];
  let skipped = 0;
  for (const c of candidatesOf(batch, format)) {
    if (heldElsewhere.has(c.code)) skipped += 1;
    else codes.push(c.code);
    if (codes.length === batch.quantity) break;
  }
  return { codes, skipped };
}

/** Everything a correct issuance leaves behind. */
async function assertIssued(batch, heldElsewhere, format = CODE_FORMAT.COMPACT) {
  const rows = await storedCodes(batch.id);
  const want = expected(batch, heldElsewhere, format);

  assert.equal((await db.get('batch', batch.id)).status, 'codes_issued');
  assert.equal(rows.length, batch.quantity);
  assert.deepEqual(rows.map((r) => r.unit_index), [...Array(batch.quantity).keys()], 'unit indexes 0..n-1, no gap');
  assert.deepEqual(rows.map((r) => r.code), want.codes, 'the first free candidates, in order');
  for (const r of rows) {
    assert.equal(heldElsewhere.has(r.code), false, `${r.code} belongs to another batch`);
    assert.equal(parseCode(r.code, config.secrets.code).ok, true, `${r.code} must validate`);
    assert.equal(codeFormatOf(r.code), format, `${r.code} is in the ${format} format`);
  }
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'every code has its own id');
  return { rows, skipped: want.skipped };
}

const codeSet = async (batchId) => new Set((await storedCodes(batchId)).map((r) => r.code));

/**
 * Wrap the store's writes. `onCodeWrite(mutations, real, n)` sees every
 * transaction that creates codes (n counts them from 1) and decides what
 * happens; everything else passes straight through.
 */
function interceptCodeWrites(onCodeWrite) {
  const backend = db.backend();
  const real = backend.mutate.bind(backend);
  let n = 0;
  backend.mutate = async (mutations) => {
    const writesCodes = mutations.some((m) => (m.create ?? m.createIfNotExists)?._type === 'code');
    return writesCodes ? onCodeWrite(mutations, real, ++n) : real(mutations);
  };
  return () => {
    delete backend.mutate;
  };
}

const issueAudits = (batchId) => db.count('auditLog', { action: 'batch.issue_codes', entity_id: String(batchId) });

// ---------------------------------------------------------------------------
// The reported case
// ---------------------------------------------------------------------------

test('a second batch of the same product and day gets all its codes, sharing none', async () => {
  // As reported: a 500-unit pilot batch, then a 1,000-unit batch, same day -
  // both in the legacy format, where their serial spaces overlap.
  const pilot = await makeBatch('BEL25-000TEST', 500, { is_test: 1 });
  const second = await makeBatch('BEL25-0001TEST', 1000);
  await startLegacy(pilot);
  await startLegacy(second);

  await serialization.issueCodes(pilot.id, {});
  const pilotCodes = await codeSet(pilot.id);
  const before = await storedCodes(pilot.id);

  const res = await serialization.issueCodes(second.id, {});

  assert.equal(res.issued, 1000);
  const { skipped } = await assertIssued(second, pilotCodes, CODE_FORMAT.LEGACY);
  assert.ok(skipped > 0, 'the test must actually pass over some of the pilot batch\'s codes');
  assert.deepEqual(await storedCodes(pilot.id), before, 'the first batch is untouched');

  const audit = await db.findOne('auditLog', { action: 'batch.issue_codes', entity_id: String(second.id) });
  assert.equal(JSON.parse(audit.detail_json).skipped, skipped);
});

test('a new batch with no clash gets compact codes: unit i is serial permute(i)', async () => {
  const batch = await makeBatch('BEL25-SOLO', 800);

  await serialization.issueCodes(batch.id, {});

  // Rebuilt from the primitives rather than through the generator.
  const permute = serialPermutation(`BEL25-SOLO:${batch.id}:${config.secrets.code}`, COMPACT_WIDTH, 8, 32);
  const want = Array.from({ length: 800 }, (_, i) => {
    const serial = encodeSerial(permute(i));
    return [i, buildCompactCode({ sku: 'BEL25', serial, secret: config.secrets.code }), serial];
  });
  const rows = await storedCodes(batch.id);
  assert.deepEqual(rows.map((r) => [r.unit_index, r.code, r.serial]), want);
  assert.match(rows[0].code, /^BEL25-[0-9A-Z]{6}-[0-9A-Z]{2}$/);
  assert.equal((await db.get('batch', batch.id)).serial_width, COMPACT_WIDTH);

  // And the generator the rest of the code uses still says the same.
  const generated = [...generateBatchCodes({
    sku: 'BEL25', mfgDate: DAY, quantity: 800, batchKey: `BEL25-SOLO:${batch.id}`, secret: config.secrets.code,
  })];
  assert.deepEqual(generated.map((c) => [c.unitIndex, c.code, c.serial]), want);
});

test('a batch started in the legacy format gets exactly the codes it always did', async () => {
  const batch = await makeBatch('BEL25-SOLO', 800);
  await startLegacy(batch);

  await serialization.issueCodes(batch.id, {});

  // Rebuilt from the primitives, as the legacy issuance did it.
  const width = serialWidthFor(800);
  const permute = serialPermutation(`BEL25-SOLO:${batch.id}:${config.secrets.code}`, width);
  const old = Array.from({ length: 800 }, (_, i) => [
    i,
    buildCode({ sku: 'BEL25', mfgDate: dateSegment(DAY), serial: permute(i), width, secret: config.secrets.code }),
    String(permute(i)).padStart(width, '0'),
  ]);
  const rows = await storedCodes(batch.id);
  assert.deepEqual(rows.map((r) => [r.unit_index, r.code, r.serial]), old);

  const generated = [...generateBatchCodes({
    sku: 'BEL25', mfgDate: DAY, quantity: 800, batchKey: `BEL25-SOLO:${batch.id}`, secret: config.secrets.code,
    format: CODE_FORMAT.LEGACY,
  })];
  assert.deepEqual(generated.map((c) => [c.unitIndex, c.code, c.serial]), old);
});

test('through the API, as the admin screen does it', async () => {
  const client = await startServer();
  try {
    const admin = { email: 'admin@test.local', password: 'AdminPassword!2026' };
    await seedUser({ ...admin, role: 'admin' });
    await client.post('/api/auth/login', admin);

    const ids = [];
    for (const [batchNumber, quantity] of [['BEL25-A', 500], ['BEL25-B', 1000]]) {
      const created = await client.post('/api/admin/batches', {
        productId: 1, batchNumber, mfgDate: DAY, expiryDate: '2028-09-27', quantity,
      });
      assert.equal(created.status, 201);
      ids.push(created.body.id);
    }
    const first = await client.post(`/api/admin/batches/${ids[0]}/issue-codes`, {});
    const second = await client.post(`/api/admin/batches/${ids[1]}/issue-codes`, {});

    assert.equal(first.status, 201);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.issued, 1000);
    const a = await codeSet(ids[0]);
    const b = await codeSet(ids[1]);
    assert.equal([...b].filter((c) => a.has(c)).length, 0);
  } finally {
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// Cut short, and run again
// ---------------------------------------------------------------------------

test('a run cut short finishes on the next run with the codes an unbroken run would store', async () => {
  const first = await makeBatch('BEL25-A', 500);
  const second = await makeBatch('BEL25-B', 1000);
  await serialization.issueCodes(first.id, {});

  // The connection drops on the third code write.
  const restore = interceptCodeWrites((mutations, real, n) => {
    if (n === 3) throw new Error('socket hang up');
    return real(mutations);
  });
  await assert.rejects(serialization.issueCodes(second.id, {}), /socket hang up/);
  restore();

  const partial = await storedCodes(second.id);
  assert.ok(partial.length > 0 && partial.length < 1000, `part-way: ${partial.length}`);
  assert.equal((await db.get('batch', second.id)).status, 'planned');
  assert.equal(await issueAudits(second.id), 0, 'not recorded as issued');

  await serialization.issueCodes(second.id, {});

  const { rows } = await assertIssued(second, await codeSet(first.id));
  // What was stored the first time is kept exactly - same id, same unit.
  const byCode = new Map(rows.map((r) => [r.code, r]));
  for (const p of partial) assert.deepEqual(byCode.get(p.code), p);
  assert.equal(await issueAudits(second.id), 1);
});

test('a write that landed but was reported as failed is kept, not stored twice', async () => {
  const first = await makeBatch('BEL25-A', 500);
  const second = await makeBatch('BEL25-B', 1000);
  await serialization.issueCodes(first.id, {});

  // The second code write reaches the store, then the reply is lost.
  const restore = interceptCodeWrites(async (mutations, real, n) => {
    const out = await real(mutations);
    if (n === 2) throw new Error('ETIMEDOUT');
    return out;
  });
  await assert.rejects(serialization.issueCodes(second.id, {}), /ETIMEDOUT/);
  restore();

  await serialization.issueCodes(second.id, {});
  await assertIssued(second, await codeSet(first.id));
});

test('a batch left part-issued by the old code finishes', async () => {
  // The old code wrote unit i as candidate i, and stopped at the first clash.
  // Both batches are legacy: that code only ever wrote the legacy format.
  const first = await makeBatch('BEL25-A', 500);
  const second = await makeBatch('BEL25-B', 1000);
  await startLegacy(first);
  await serialization.issueCodes(first.id, {});
  const held = await codeSet(first.id);

  const prefix = [];
  for (const c of candidatesOf(second, CODE_FORMAT.LEGACY)) {
    if (held.has(c.code)) break;
    prefix.push({ code: c.code, batch_id: second.id, product_id: 1, unit_index: c.position, serial: c.serial });
  }
  assert.ok(prefix.length > 0 && prefix.length < 1000);
  await db.insertMany('code', prefix);

  await serialization.issueCodes(second.id, {});
  await assertIssued(second, held, CODE_FORMAT.LEGACY);
});

// ---------------------------------------------------------------------------
// At the same moment
// ---------------------------------------------------------------------------

test('a code taken by another batch between look-up and write is passed over', async () => {
  const other = await makeBatch('BEL25-OTHER', 10);
  const batch = await makeBatch('BEL25-B', 1000);

  // Just before the first write, another issuance stores one of its codes.
  let stolen = null;
  const restore = interceptCodeWrites(async (mutations, real, n) => {
    if (n === 1) {
      const victim = mutations.find((m) => m.create?._type === 'code').create;
      stolen = victim.code;
      await real([{ create: { ...victim, _id: victim._id, id: 999999, batch_id: other.id, unit_index: 0 } }]);
    }
    return real(mutations);
  });
  await serialization.issueCodes(batch.id, {});
  restore();

  assert.ok(stolen);
  assert.equal((await db.getCode(stolen)).batch_id, other.id, 'the other batch keeps its code');
  const { skipped } = await assertIssued(batch, new Set([stolen]));
  assert.equal(skipped, 1);
});

test('two batches of the same product and day issued at once both finish, sharing no code', async () => {
  const a = await makeBatch('BEL25-A', 1000);
  const b = await makeBatch('BEL25-B', 1000);

  await Promise.all([serialization.issueCodes(a.id, {}), serialization.issueCodes(b.id, {})]);

  const codesA = await codeSet(a.id);
  const codesB = await codeSet(b.id);
  assert.equal(codesA.size, 1000);
  assert.equal(codesB.size, 1000);
  assert.equal([...codesB].filter((c) => codesA.has(c)).length, 0);
  for (const batch of [a, b]) {
    const rows = await storedCodes(batch.id);
    assert.deepEqual(rows.map((r) => r.unit_index), [...Array(1000).keys()]);
    assert.equal((await db.get('batch', batch.id)).status, 'codes_issued');
  }
});

test('the same batch issued twice at once ends with one set of codes, recorded once', async () => {
  const batch = await makeBatch('BEL25-B', 1000);

  const outcomes = await Promise.allSettled([serialization.issueCodes(batch.id, {}), serialization.issueCodes(batch.id, {})]);

  // Each run finishes, or is told the codes are already issued - nothing else.
  for (const o of outcomes) {
    if (o.status === 'rejected') assert.match(o.reason.message, /already been issued/);
  }
  assert.ok(outcomes.some((o) => o.status === 'fulfilled'));
  await assertIssued(batch, new Set());
  assert.equal(await issueAudits(batch.id), 1, 'recorded as issued exactly once');
});

// ---------------------------------------------------------------------------
// When it does not add up
// ---------------------------------------------------------------------------

test('stored codes that do not match the sequence stop the issuance, writing nothing more', async () => {
  const batch = await makeBatch('BEL25-B', 100);
  const [firstCandidate] = candidatesOf(batch);
  await db.insert('code', {
    code: firstCandidate.code, batch_id: batch.id, product_id: 1, unit_index: 7, serial: firstCandidate.serial,
  });

  await assert.rejects(serialization.issueCodes(batch.id, {}), (err) => err.status === 409 && /do not match/.test(err.message));

  assert.equal(await db.count('code', { batch_id: batch.id }), 1);
  assert.equal((await db.get('batch', batch.id)).status, 'planned');
});

test('a stray code on the batch stops it being marked issued', async () => {
  const batch = await makeBatch('BEL25-B', 100);
  await db.insert('code', { code: 'BEL25-260928-00000-00', batch_id: batch.id, product_id: 1, unit_index: 0, serial: '00000' });

  await assert.rejects(serialization.issueCodes(batch.id, {}), (err) => err.status === 409 && /not the 100 planned/.test(err.message));

  assert.equal((await db.get('batch', batch.id)).status, 'planned');
  assert.equal(await issueAudits(batch.id), 0);
});

test('passing over many codes is fine; a crowded serial space stops with a message', async () => {
  const holder = await makeBatch('BEL25-HOLDER', 10);

  /** See that the first `k` candidates of `batch` are held by other batches. */
  const occupy = async (batch, k) => {
    const rows = [];
    let seen = 0;
    for (const c of candidatesOf(batch)) {
      if (seen === k) break;
      seen += 1;
      // Some may already be held - by the holder, or by a batch issued above.
      if (await db.getCode(c.code)) continue;
      rows.push({ code: c.code, batch_id: holder.id, product_id: 1, unit_index: rows.length, serial: c.serial });
    }
    await db.insertMany('code', rows);
  };

  // 1,000 taken ahead of a 10-unit batch: within the allowance.
  const fine = await makeBatch('BEL25-FINE', 10);
  await occupy(fine, 1000);
  await serialization.issueCodes(fine.id, {});
  const { skipped } = await assertIssued(fine, await codeSet(holder.id));
  assert.equal(skipped, 1000);

  // 1,011 taken: more than the batch plus the allowance - stop, write nothing.
  const crowded = await makeBatch('BEL25-CROWDED', 10);
  await occupy(crowded, 1011);
  await assert.rejects(serialization.issueCodes(crowded.id, {}), (err) => err.status === 409 && /most of the serial numbers/.test(err.message));
  assert.equal(await db.count('code', { batch_id: crowded.id }), 0);
  assert.equal((await db.get('batch', crowded.id)).status, 'planned');
});

test('a batch whose product record is missing is refused, not issued as "NULL-..."', async () => {
  const batch = await db.insert('batch', {
    batch_number: 'X-1', product_id: 42, mfg_date: DAY, expiry_date: '2028-09-27', quantity: 5,
  });

  await assert.rejects(serialization.issueCodes(batch.id, {}), (err) => err.status === 409 && /no product record/.test(err.message));
  assert.equal(await db.count('code', { batch_id: batch.id }), 0);
});

// ---------------------------------------------------------------------------
// Marking the batch issued: a compare-and-set
// ---------------------------------------------------------------------------

const revisionOf = async (batch) =>
  (await db.query('*[_id == $id][0]{ _rev }', { id: db.docIdOf('batch', batch) }))._rev;

test('a change on a stale revision is refused and changes nothing', async () => {
  const batch = await makeBatch('BEL25-B', 5);
  const stale = await revisionOf(batch);
  await db.update('batch', batch, { recall_reason: 'moved on' });

  await assert.rejects(
    db.update('batch', batch, { status: 'codes_issued' }, { ifRevision: stale }),
    (err) => err.statusCode === 409 || err.status === 409
  );
  assert.equal((await db.get('batch', batch.id)).status, 'planned');

  await db.update('batch', batch, { status: 'codes_issued' }, { ifRevision: await revisionOf(batch) });
  assert.equal((await db.get('batch', batch.id)).status, 'codes_issued');
});

test('a batch that changes between the check and the mark is looked at again, and marked once', async () => {
  const batch = await makeBatch('BEL25-B', 50);

  // The first time the mark is tried, something else touches the batch first.
  const backend = db.backend();
  const real = backend.mutate.bind(backend);
  let interfered = 0;
  backend.mutate = async (mutations) => {
    if (!interfered && mutations.some((m) => m.patch?.ifRevisionID)) {
      interfered += 1;
      await real([{ patch: { id: db.docIdOf('batch', batch), set: { recall_reason: 'touched' } } }]);
    }
    return real(mutations);
  };
  try {
    await serialization.issueCodes(batch.id, {});
  } finally {
    delete backend.mutate;
  }

  assert.equal(interfered, 1);
  await assertIssued(batch, new Set());
  assert.equal(await issueAudits(batch.id), 1);
});
