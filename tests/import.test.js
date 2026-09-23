/**
 * Spreadsheet import.
 *
 * The cases here are the ones a file from somebody's desktop actually
 * contains: a SKU typed in lower case, a quantity with a thousands comma, a
 * date Excel turned into a number, a row left blank, the same product listed
 * twice. Each one has a defined answer, and none of them may take the whole
 * import down with it.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { freshDb } from './helpers.js';
import * as db from '../src/db/index.js';
import { importProducts, importBatches } from '../src/services/importer.js';
import { readSheet } from '../src/lib/spreadsheet.js';

/** Build a workbook in memory and read it back the way the route does. */
async function sheetFrom(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('sheet');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const { rows: parsed } = await readSheet(buffer);
  return parsed;
}

beforeEach(async () => {
  await freshDb();
});

test('products import, and a lower-case SKU is stored upper-case', async () => {
  const rows = await sheetFrom(
    ['SKU', 'Name', 'Manufacturer'],
    [['amx25', 'Amoxicillin 250 mg', 'Northbridge']]
  );

  const result = await importProducts(rows, {});
  assert.equal(result.created, 1);
  assert.equal(result.errors.length, 0);

  const product = await db.get('SELECT sku FROM products');
  // The SKU becomes the first segment of every code, so its case is not
  // cosmetic - two cases would be two different code prefixes.
  assert.equal(product.sku, 'AMX25');
});

test('a second import of the same SKU updates rather than duplicating', async () => {
  const first = await sheetFrom(['SKU', 'Name', 'Manufacturer'], [['AMX25', 'Original', 'North']]);
  await importProducts(first, {});

  const second = await sheetFrom(['SKU', 'Name', 'Manufacturer'], [['AMX25', 'Corrected', 'North']]);
  const result = await importProducts(second, {});

  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  assert.equal(await db.scalar('SELECT COUNT(*) FROM products'), 1);
  assert.equal(await db.scalar('SELECT name FROM products'), 'Corrected');
});

test('a bad row is reported against its spreadsheet row and the good ones still import', async () => {
  const rows = await sheetFrom(
    ['SKU', 'Name', 'Manufacturer'],
    [
      ['AMX25', 'Fine', 'North'],
      ['BAD SKU!', 'Invalid characters', 'North'],
      ['PCM50', 'Also fine', 'Corelis'],
    ]
  );

  const result = await importProducts(rows, {});
  assert.equal(result.created, 2, 'the two valid rows are still imported');
  assert.equal(result.errors.length, 1);
  // Row 3: the header is row 1, so the second data row is row 3.
  assert.equal(result.errors[0].row, 3);
  assert.match(result.errors[0].message, /letters and digits/);
});

test('the same SKU twice in one file is refused rather than silently overwritten', async () => {
  const rows = await sheetFrom(
    ['SKU', 'Name', 'Manufacturer'],
    [
      ['AMX25', 'First entry', 'North'],
      ['AMX25', 'Second entry', 'North'],
    ]
  );

  const result = await importProducts(rows, {});
  assert.equal(result.created, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /appears twice/);
  assert.equal(await db.scalar('SELECT name FROM products'), 'First entry');
});

test('a dry run reports what would happen and writes nothing', async () => {
  const rows = await sheetFrom(['SKU', 'Name', 'Manufacturer'], [['AMX25', 'Amoxicillin', 'North']]);

  const result = await importProducts(rows, { dryRun: true });
  assert.equal(result.created, 1);
  assert.equal(await db.scalar('SELECT COUNT(*) FROM products'), 0, 'nothing was written');
});

test('blank rows left behind by Excel are ignored, not reported as errors', async () => {
  const rows = await sheetFrom(
    ['SKU', 'Name', 'Manufacturer'],
    [['AMX25', 'Amoxicillin', 'North'], [], ['', '', '']]
  );

  const result = await importProducts(rows, {});
  assert.equal(result.created, 1);
  assert.equal(result.errors.length, 0);
});

test('batches resolve their product by SKU and accept a comma in the quantity', async () => {
  await importProducts(
    await sheetFrom(['SKU', 'Name', 'Manufacturer'], [['AMX25', 'Amoxicillin', 'North']]),
    {}
  );

  const rows = await sheetFrom(
    ['Product SKU', 'Batch number', 'Manufacturing date', 'Expiry date', 'Quantity'],
    [['AMX25', 'AMX25-2609A', '2026-09-01', '2028-09-01', '1,200']]
  );

  const result = await importBatches(rows, {});
  assert.equal(result.created, 1, result.errors.map((e) => e.message).join('; '));
  assert.equal(await db.scalar('SELECT quantity FROM batches'), 1200);
  // Importing a batch must not mint codes: that stays a deliberate step.
  assert.equal(await db.scalar('SELECT COUNT(*) FROM codes'), 0);
  assert.equal(await db.scalar('SELECT status FROM batches'), 'planned');
});

test('a batch for an unknown product is refused with a usable message', async () => {
  const rows = await sheetFrom(
    ['Product SKU', 'Batch number', 'Manufacturing date', 'Expiry date', 'Quantity'],
    [['NOSUCH', 'X-1', '2026-09-01', '2028-09-01', 100]]
  );

  const result = await importBatches(rows, {});
  assert.equal(result.created, 0);
  assert.match(result.errors[0].message, /no product with SKU NOSUCH/);
});

test('an expiry before the manufacturing date is refused', async () => {
  await importProducts(
    await sheetFrom(['SKU', 'Name', 'Manufacturer'], [['AMX25', 'Amoxicillin', 'North']]),
    {}
  );

  const rows = await sheetFrom(
    ['Product SKU', 'Batch number', 'Manufacturing date', 'Expiry date', 'Quantity'],
    [['AMX25', 'AMX25-2609A', '2026-09-01', '2025-01-01', 100]]
  );

  const result = await importBatches(rows, {});
  assert.equal(result.created, 0);
  // Every pack in such a batch would read as expired the day it was made.
  assert.match(result.errors[0].message, /expiry date must be after/);
});

test('an ambiguous date is refused rather than guessed at', async () => {
  await importProducts(
    await sheetFrom(['SKU', 'Name', 'Manufacturer'], [['AMX25', 'Amoxicillin', 'North']]),
    {}
  );

  const rows = await sheetFrom(
    ['Product SKU', 'Batch number', 'Manufacturing date', 'Expiry date', 'Quantity'],
    [['AMX25', 'AMX25-2609A', '01/02/2026', '2028-09-01', 100]]
  );

  const result = await importBatches(rows, {});
  assert.equal(result.created, 0, '01/02/2026 is January 2nd or February 1st depending on locale');
  assert.match(result.errors[0].message, /not a date this can read/);
});

test('a batch number is never reused', async () => {
  await importProducts(
    await sheetFrom(['SKU', 'Name', 'Manufacturer'], [['AMX25', 'Amoxicillin', 'North']]),
    {}
  );
  const headers = ['Product SKU', 'Batch number', 'Manufacturing date', 'Expiry date', 'Quantity'];
  const row = ['AMX25', 'AMX25-2609A', '2026-09-01', '2028-09-01', 100];

  await importBatches(await sheetFrom(headers, [row]), {});
  const result = await importBatches(await sheetFrom(headers, [row]), {});

  assert.equal(result.created, 0);
  assert.match(result.errors[0].message, /already exists/);
  assert.equal(await db.scalar('SELECT COUNT(*) FROM batches'), 1);
});
