/**
 * Spreadsheet exports cannot carry a working formula.
 *
 * The scan and customer exports hold text the public typed on the portal,
 * so a checker who gives their name as =HYPERLINK(...) must not get a
 * formula run on the computer of whoever opens the export. A cell that a
 * spreadsheet would treat as a formula is written as text instead; every
 * ordinary value - mobile numbers included - is written exactly as before.
 */
import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { freshDb, seedBasics, seedUser, startServer, resetRateLimits, DETAILS } from './helpers.js';
import { csvCell, toCsv } from '../src/services/analytics.js';
import { buildWorkbook } from '../src/lib/spreadsheet.js';

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword!2026' };
const EVIL_NAME = '=HYPERLINK("http://evil.example","Click me")';
// How that name must appear in a CSV: text (the apostrophe), quoted, with
// its own quotes doubled.
const EVIL_CELL = `"'=HYPERLINK(""http://evil.example"",""Click me"")"`;

// ---------------------------------------------------------------------------
// The cell rule
// ---------------------------------------------------------------------------

test('a cell that would run as a formula is written as text', () => {
  assert.equal(csvCell('=1+2'), "'=1+2");
  assert.equal(csvCell('+cmd|calc!A0'), "'+cmd|calc!A0");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@SUM(A1:A2)'), "'@SUM(A1:A2)");
  assert.equal(csvCell('  =1+2'), "'  =1+2", 'leading spaces do not hide it');
  assert.equal(csvCell('\t=1+2'), `"'\t=1+2"`, 'a leading tab counts, and is quoted');
  assert.equal(csvCell(EVIL_NAME), EVIL_CELL);
});

test('ordinary values are written exactly as before', () => {
  assert.equal(csvCell('+639171234567'), '+639171234567', 'a mobile number is left alone');
  assert.equal(csvCell(-3), '-3');
  assert.equal(csvCell('-1.5'), '-1.5');
  assert.equal(csvCell('Maria Santos'), 'Maria Santos');
  assert.equal(csvCell('maria@example.com'), 'maria@example.com', 'an @ inside a value is fine');
  assert.equal(csvCell('AMX25-260812-088159-BM'), 'AMX25-260812-088159-BM');
  assert.equal(csvCell('2026-09-26T04:12:00.000Z'), '2026-09-26T04:12:00.000Z');
  assert.equal(csvCell('Quezon City, NCR'), '"Quezon City, NCR"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0), '0');
});

test('a semicolon cannot be used to start a new cell', () => {
  // Some spreadsheets split on semicolons. Quoted, the value stays one cell.
  assert.equal(csvCell('Cubao;=1+2'), '"Cubao;=1+2"');
});

test('a whole export applies the rule to every cell', () => {
  const csv = toCsv([{ name: EVIL_NAME, phone: '+639171234567', checks: 2 }]);
  assert.equal(csv, `name,phone,checks\n${EVIL_CELL},+639171234567,2`);
});

test('the .xlsx exports store such text as text, never as a formula', async () => {
  const buffer = await buildWorkbook([
    { name: 'products', columns: [{ header: 'Name', key: 'name' }], rows: [{ name: '=1+2' }] },
  ]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const cell = wb.worksheets[0].getRow(2).getCell(1);
  assert.equal(cell.type, ExcelJS.ValueType.String);
  assert.equal(cell.value, '=1+2');
  assert.equal(cell.formula, undefined);
});

// ---------------------------------------------------------------------------
// Through the real exports
// ---------------------------------------------------------------------------

describe('through the real exports', () => {
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
    codes = (await seedBasics({ quantity: 4 })).codes;
    await seedUser({ ...ADMIN, role: 'admin', name: 'Ada Admin' });
    client.clearCookies();
    await resetRateLimits();

    // A member of the public gives a formula as their name, then checks a pack.
    const given = await client.post('/api/portal/details', { ...DETAILS, fullName: EVIL_NAME });
    assert.equal(given.status, 201, JSON.stringify(given.body));
    assert.equal((await client.post('/api/verify', { code: codes[0] })).status, 200);

    await client.login(ADMIN.email, ADMIN.password);
  });

  /** The data line of an export that names the checker. */
  const lineWith = (csv, text) => csv.split('\n').find((l) => l.includes(text));

  test('the customers export writes a formula-like name as text', async () => {
    const res = await client.get('/api/admin/customers.csv');
    assert.equal(res.status, 200);
    const line = lineWith(res.body, 'evil.example');
    assert.ok(line.startsWith(`1,${EVIL_CELL},`), line);
    assert.ok(line.includes(',+639171234567,'), 'the mobile number is unchanged');
  });

  test('the scan export writes a formula-like checker name as text', async () => {
    const res = await client.get('/api/admin/scans.csv');
    assert.equal(res.status, 200);
    const line = lineWith(res.body, 'evil.example');
    assert.ok(line.includes(EVIL_CELL), line);
    assert.ok(!/(^|,)=/.test(line), 'no cell of the line starts with =');
  });
});
