/**
 * The leaflet shown after a genuine scan is the medicine's CURRENT one, not
 * the one pinned on the batch.
 *
 * This is the regression test for a deliberate behaviour change. A batch
 * still records which leaflet version shipped with it, but a scan no longer
 * displays that version: a correction has to reach everyone holding the
 * medicine, including packs printed before it, and a newly added warning is
 * for exactly the people holding the older stock. Showing them the leaflet
 * as it stood when their box was packed would hide it from them.
 *
 * Both codes on a carton therefore open the same leaflet - the newest - and
 * cannot disagree after a revision.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedBasics, startServer, resetRateLimits, giveDetails } from './helpers.js';
import * as db from '../src/db/index.js';

let client;
let codes;

before(async () => {
  client = await startServer();
});
after(async () => {
  await client.close();
});

beforeEach(async () => {
  await freshDb();
  // Batch 1 is seeded with leaflet_id = 1, the v1.0 leaflet - pinned.
  codes = (await seedBasics({ quantity: 6 })).codes;
  client.clearCookies();
  await giveDetails(client);
  await resetRateLimits();
});

/** Publish a later version directly, dated so it is unambiguously the newest. */
const publishV2 = () =>
  db.run(
    `INSERT INTO leaflets (product_id, version, language, sections_json, effective_from)
     VALUES (1, '2.0', 'en', ?, '2026-10-01T00:00:00.000Z')`,
    [JSON.stringify([{ heading: 'New warning', body: 'Added after the batch was packed.' }])]
  );

test('a scan of a batch pinned to v1.0 shows v2.0 once v2.0 is published', async () => {
  await publishV2();
  assert.equal(
    await db.scalar('SELECT leaflet_id FROM batches WHERE id = 1'),
    1,
    'the batch is genuinely pinned to the older version'
  );

  const res = await client.post('/api/verify', { code: codes[0] }, { fromIp: '198.51.100.7' });

  assert.equal(res.status, 200);
  assert.equal(res.body.result, 'genuine');
  assert.equal(res.body.leaflet.version, '2.0', 'the newest, not the pinned one');
  assert.equal(res.body.leaflet.sections[0].heading, 'New warning', 'with the new content');
});

test('before any revision, the pinned version and the newest are the same thing', async () => {
  // The change is invisible until a second version exists - which is the
  // point: nothing about a single-version medicine moves.
  const res = await client.post('/api/verify', { code: codes[1] }, { fromIp: '198.51.100.8' });

  assert.equal(res.body.result, 'genuine');
  assert.equal(res.body.leaflet.version, '1.0');
});

test('the pinned column is left alone - it is a record, not a display setting', async () => {
  await publishV2();

  await client.post('/api/verify', { code: codes[2] }, { fromIp: '198.51.100.9' });

  assert.equal(await db.scalar('SELECT leaflet_id FROM batches WHERE id = 1'), 1, 'still 1');
});

test('a batch with no pinned leaflet behaves identically', async () => {
  await publishV2();
  await db.run('UPDATE batches SET leaflet_id = NULL WHERE id = 1');

  const res = await client.post('/api/verify', { code: codes[3] }, { fromIp: '198.51.100.10' });

  assert.equal(res.body.result, 'genuine');
  assert.equal(res.body.leaflet.version, '2.0');
});

test('a medicine with no leaflet at all still verifies, with no leaflet', async () => {
  await db.run('DELETE FROM leaflets WHERE product_id = 1');

  const res = await client.post('/api/verify', { code: codes[4] }, { fromIp: '198.51.100.11' });

  assert.equal(res.body.result, 'genuine', 'the leaflet is information, not part of the check');
  assert.equal(res.body.leaflet, null);
});

test('a flagged result still carries no leaflet, whichever version is newest', async () => {
  await publishV2();
  // Verified once from one device, then again from another: a duplicate.
  await client.post('/api/verify', { code: codes[5] }, { fromIp: '198.51.100.12' });
  const res = await client.post('/api/verify', { code: codes[5] }, { fromIp: '203.0.113.5' });

  assert.equal(res.body.result, 'flagged');
  assert.equal(res.body.leaflet, null, 'dosing text never sits beside a counterfeit warning');
});
