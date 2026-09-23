/**
 * Bulk import of products and batches from a spreadsheet.
 *
 * Two rules shape this:
 *
 * 1. EVERY ROW IS VALIDATED THE SAME WAY THE API VALIDATES ONE. An import is
 *    not a back door: the SKU pattern matters because the SKU becomes part of
 *    every printed code, and the expiry-after-manufacture check matters
 *    because a batch that fails it would flag every pack as expired.
 *
 * 2. A BAD ROW NEVER STOPS A GOOD ONE, and nothing is written until the whole
 *    file has been checked. Somebody uploading 300 products should not have to
 *    fix one typo, re-upload, and discover the next one - they get every
 *    problem at once, against row numbers they can go and look at.
 *
 * Codes are deliberately NOT importable. A code is minted and signed by the
 * system; accepting one from a spreadsheet would let an unsigned value into
 * the table that decides whether a pack is genuine.
 */
import * as db from '../db/index.js';
import * as audit from './audit.js';
import { validate } from '../lib/validate.js';
import { cellText, cellDate, cellInt, cellBool } from '../lib/spreadsheet.js';
import { MAX_BATCH_QUANTITY } from './serialization.js';

/**
 * Column headings accepted for each field.
 *
 * Several spellings per field, because the file comes from whatever the
 * person already had open. The template uses the first one.
 */
const PRODUCT_COLUMNS = {
  sku: ['sku', 'product sku', 'code'],
  name: ['name', 'product name', 'brand name'],
  genericName: ['generic name', 'generic', 'inn'],
  strength: ['strength', 'dose', 'dosage'],
  dosageForm: ['dosage form', 'form'],
  packSize: ['pack size', 'pack', 'presentation'],
  manufacturer: ['manufacturer', 'maker', 'principal'],
  category: ['category', 'therapeutic area', 'class'],
};

const BATCH_COLUMNS = {
  sku: ['product sku', 'sku', 'product'],
  batchNumber: ['batch number', 'batch', 'lot', 'lot number'],
  mfgDate: ['manufacturing date', 'mfg date', 'manufactured', 'mfg'],
  expiryDate: ['expiry date', 'expiry', 'expires', 'exp date'],
  quantity: ['quantity', 'units', 'qty', 'pack count'],
  isTest: ['test batch', 'pilot', 'sandbox'],
  notes: ['notes', 'note', 'remarks'],
};

/** Pull a field out of a row, trying each accepted heading in turn. */
function field(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && cellText(row[name]) !== '') return row[name];
  }
  return undefined;
}

/** Shape one spreadsheet row into the object the API validator expects. */
function readProductRow(row) {
  return {
    sku: cellText(field(row, PRODUCT_COLUMNS.sku)).toUpperCase(),
    name: cellText(field(row, PRODUCT_COLUMNS.name)),
    genericName: cellText(field(row, PRODUCT_COLUMNS.genericName)),
    strength: cellText(field(row, PRODUCT_COLUMNS.strength)),
    dosageForm: cellText(field(row, PRODUCT_COLUMNS.dosageForm)),
    packSize: cellText(field(row, PRODUCT_COLUMNS.packSize)),
    manufacturer: cellText(field(row, PRODUCT_COLUMNS.manufacturer)),
    category: cellText(field(row, PRODUCT_COLUMNS.category)),
  };
}

const PRODUCT_RULES = {
  sku: {
    type: 'string',
    required: true,
    min: 2,
    max: 12,
    pattern: /^[A-Za-z0-9]+$/,
    patternMessage: 'may contain only letters and digits (it becomes part of every code)',
  },
  name: { type: 'string', required: true, max: 160 },
  genericName: { type: 'string', max: 160 },
  strength: { type: 'string', max: 60 },
  dosageForm: { type: 'string', max: 60 },
  packSize: { type: 'string', max: 60 },
  manufacturer: { type: 'string', required: true, max: 160 },
  category: { type: 'string', max: 60 },
};

/** Turn a validation failure into one readable line. */
function problems(err) {
  if (Array.isArray(err?.details) && err.details.length) {
    return err.details.map((d) => `${d.field}: ${d.message}`).join('; ');
  }
  return err.message;
}

/**
 * Import products.
 *
 * An existing SKU updates that product's descriptive fields; the SKU itself is
 * never changed, because it is already embedded in every code issued for it.
 *
 * @returns {{created: number, updated: number, errors: Array<{row: number, message: string}>, rows: Array}}
 */
export async function importProducts(sheetRows, { actor, req, dryRun = false } = {}) {
  const errors = [];
  const planned = [];
  const seen = new Map();

  for (const raw of sheetRows) {
    const rowNo = raw.__row;
    const shaped = readProductRow(raw);

    let data;
    try {
      data = validate(shaped, PRODUCT_RULES);
    } catch (err) {
      errors.push({ row: rowNo, message: problems(err) });
      continue;
    }

    const sku = data.sku.toUpperCase();
    // A file that lists the same SKU twice would otherwise create it and then
    // immediately update it, which reads as a silent overwrite.
    if (seen.has(sku)) {
      errors.push({ row: rowNo, message: `SKU ${sku} appears twice in this file (also row ${seen.get(sku)})` });
      continue;
    }
    seen.set(sku, rowNo);

    const existing = await db.get('SELECT id FROM products WHERE sku = ?', [sku]);
    planned.push({ row: rowNo, sku, data, action: existing ? 'update' : 'create', id: existing?.id });
  }

  if (dryRun) {
    return {
      created: planned.filter((p) => p.action === 'create').length,
      updated: planned.filter((p) => p.action === 'update').length,
      errors,
      rows: planned.map((p) => ({ row: p.row, sku: p.sku, name: p.data.name, action: p.action })),
    };
  }

  let created = 0;
  let updated = 0;

  for (const p of planned) {
    const d = p.data;
    if (p.action === 'create') {
      const { lastInsertRowid } = await db.run(
        `INSERT INTO products (sku, name, generic_name, strength, dosage_form, pack_size, manufacturer, category)
         VALUES (?,?,?,?,?,?,?,?)`,
        [p.sku, d.name, d.genericName || null, d.strength || null, d.dosageForm || null,
         d.packSize || null, d.manufacturer, d.category || null]
      );
      created += 1;
      p.id = lastInsertRowid;
    } else {
      await db.run(
        `UPDATE products
            SET name = ?, generic_name = ?, strength = ?, dosage_form = ?,
                pack_size = ?, manufacturer = ?, category = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`,
        [d.name, d.genericName || null, d.strength || null, d.dosageForm || null,
         d.packSize || null, d.manufacturer, d.category || null, p.id]
      );
      updated += 1;
    }
  }

  await audit.record({
    actor,
    req,
    action: 'products.import',
    detail: { created, updated, rejected: errors.length },
  });

  return { created, updated, errors, rows: planned.map((p) => ({ row: p.row, sku: p.sku, action: p.action })) };
}

/**
 * Import batches.
 *
 * Batches reference their product by SKU rather than by id, because a SKU is
 * what somebody has in front of them; an id is an implementation detail they
 * would have to look up.
 *
 * An existing batch number is rejected rather than updated. Batch numbers
 * identify physical production runs, and codes may already be printed against
 * one - quietly changing its quantity or expiry would put the database out of
 * step with packs already in circulation.
 *
 * Codes are NOT issued here. Importing a batch creates it in `planned` status,
 * and issuing codes stays a deliberate, audited step in the dashboard.
 */
export async function importBatches(sheetRows, { actor, req, dryRun = false } = {}) {
  const errors = [];
  const planned = [];
  const seen = new Map();

  for (const raw of sheetRows) {
    const rowNo = raw.__row;

    const sku = cellText(field(raw, BATCH_COLUMNS.sku)).toUpperCase();
    const batchNumber = cellText(field(raw, BATCH_COLUMNS.batchNumber));
    const mfgDate = cellDate(field(raw, BATCH_COLUMNS.mfgDate));
    const expiryDate = cellDate(field(raw, BATCH_COLUMNS.expiryDate));
    const quantity = cellInt(field(raw, BATCH_COLUMNS.quantity));

    const shaped = { sku, batchNumber, mfgDate, expiryDate, quantity };

    let data;
    try {
      data = validate(shaped, {
        sku: { type: 'string', required: true, max: 12 },
        batchNumber: {
          type: 'string',
          required: true,
          max: 40,
          pattern: /^[A-Za-z0-9-]+$/,
          patternMessage: 'may contain letters, digits and hyphens only',
        },
        mfgDate: { type: 'date', required: true },
        expiryDate: { type: 'date', required: true },
        quantity: { type: 'int', required: true, min: 1, max: MAX_BATCH_QUANTITY },
      });
    } catch (err) {
      // A date that Excel handed over in an unreadable shape reads as
      // "required" otherwise, which sends the person looking for a blank cell
      // that is not blank.
      const raw_mfg = cellText(field(raw, BATCH_COLUMNS.mfgDate));
      const raw_exp = cellText(field(raw, BATCH_COLUMNS.expiryDate));
      const hints = [];
      if (raw_mfg && !mfgDate) hints.push(`manufacturing date "${raw_mfg}" is not a date this can read - use YYYY-MM-DD`);
      if (raw_exp && !expiryDate) hints.push(`expiry date "${raw_exp}" is not a date this can read - use YYYY-MM-DD`);
      errors.push({ row: rowNo, message: hints.length ? hints.join('; ') : problems(err) });
      continue;
    }

    if (new Date(data.expiryDate) <= new Date(data.mfgDate)) {
      errors.push({ row: rowNo, message: 'the expiry date must be after the manufacturing date' });
      continue;
    }

    const product = await db.get('SELECT id, sku FROM products WHERE sku = ?', [data.sku]);
    if (!product) {
      errors.push({ row: rowNo, message: `no product with SKU ${data.sku} - import the products first` });
      continue;
    }

    const key = data.batchNumber.toUpperCase();
    if (seen.has(key)) {
      errors.push({ row: rowNo, message: `batch ${data.batchNumber} appears twice in this file (also row ${seen.get(key)})` });
      continue;
    }
    seen.set(key, rowNo);

    if (await db.get('SELECT id FROM batches WHERE batch_number = ?', [data.batchNumber])) {
      errors.push({ row: rowNo, message: `batch ${data.batchNumber} already exists - batch numbers identify a production run and are never reused` });
      continue;
    }

    planned.push({
      row: rowNo,
      data,
      productId: product.id,
      isTest: cellBool(field(raw, BATCH_COLUMNS.isTest)),
      notes: cellText(field(raw, BATCH_COLUMNS.notes)).slice(0, 500),
    });
  }

  if (dryRun) {
    return {
      created: planned.length,
      updated: 0,
      errors,
      rows: planned.map((p) => ({
        row: p.row,
        batchNumber: p.data.batchNumber,
        sku: p.data.sku,
        quantity: p.data.quantity,
        action: 'create',
      })),
    };
  }

  let created = 0;
  for (const p of planned) {
    await db.run(
      `INSERT INTO batches (batch_number, product_id, mfg_date, expiry_date, quantity, is_test, notes)
       VALUES (?,?,?,?,?,?,?)`,
      [p.data.batchNumber, p.productId, p.data.mfgDate, p.data.expiryDate,
       p.data.quantity, p.isTest ? 1 : 0, p.notes || null]
    );
    created += 1;
  }

  await audit.record({
    actor,
    req,
    action: 'batches.import',
    detail: { created, rejected: errors.length },
  });

  return {
    created,
    updated: 0,
    errors,
    rows: planned.map((p) => ({ row: p.row, batchNumber: p.data.batchNumber, action: 'create' })),
  };
}

/** The column headings the template offers, in order. */
export const TEMPLATE_COLUMNS = {
  products: Object.entries(PRODUCT_COLUMNS).map(([key, names]) => ({ key, header: names[0] })),
  batches: Object.entries(BATCH_COLUMNS).map(([key, names]) => ({ key, header: names[0] })),
};

export default { importProducts, importBatches, TEMPLATE_COLUMNS };
