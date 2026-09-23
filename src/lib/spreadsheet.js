/**
 * Reading and writing spreadsheets.
 *
 * Two jobs, and the awkward one is reading. A file arriving from somebody's
 * desktop has been through Excel, which is free with other people's data in
 * ways that matter here:
 *
 *   - a SKU like "01234" comes back as the number 1234, losing the zero that
 *     is part of the code printed on every pack
 *   - a batch number like "2024-01" is silently turned into a date
 *   - dates arrive as Date objects, serial numbers or text, depending on the
 *     cell format and the author's locale
 *   - trailing blank rows are "present" but empty
 *
 * So every value is normalised back to what the API expects, and a cell that
 * cannot be read is reported against its row number rather than guessed at.
 */
import ExcelJS from 'exceljs';

/** Excel's day 0. Serial dates count days from here. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/**
 * A cell as a trimmed string.
 *
 * Numbers are rendered without exponent notation, so a long batch number is
 * not handed back as "1.2345e+7".
 */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  // A formula cell carries both the formula and its computed result.
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result);
    if ('text' in value) return cellText(value.text);
    if ('richText' in value) return value.richText.map((r) => r.text).join('').trim();
    if ('hyperlink' in value) return cellText(value.text ?? '');
  }
  return String(value).trim();
}

/**
 * A cell as an ISO date (YYYY-MM-DD), or '' if it is not one.
 *
 * Accepts the three forms Excel produces: a real Date, a serial number, and
 * text. Text is only accepted in ISO or D/M/Y order with a 4-digit year -
 * "01/02/2026" is genuinely ambiguous between locales, so rather than guess
 * at day-month order it is rejected and reported.
 */
export function cellDate(value) {
  if (value === null || value === undefined || value === '') return '';

  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = EXCEL_EPOCH_UTC + Math.round(value) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  const text = cellText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  // D/M/YYYY or D-M-YYYY, only when the day is unambiguous (> 12).
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (m) {
    const [, a, b, year] = m;
    const first = Number(a);
    const second = Number(b);
    if (first > 12 && second <= 12) {
      return `${year}-${String(second).padStart(2, '0')}-${String(first).padStart(2, '0')}`;
    }
    return ''; // ambiguous: let the caller report it against the row
  }
  return '';
}

/** A cell as a whole number, or null when it is not one. */
export function cellInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(cellText(value).replace(/[\s,]/g, ''));
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

/** A cell as a boolean. Blank means false. */
export function cellBool(value) {
  if (value === true || value === false) return value;
  const t = cellText(value).toLowerCase();
  return ['1', 'true', 'yes', 'y'].includes(t);
}

/**
 * Read a sheet into `{ headers, rows }`, where each row carries its own
 * spreadsheet row number.
 *
 * The row number is what makes an error message usable: "row 14" is something
 * the person can go and look at, where "the third product" is not.
 */
export async function readSheet(buffer, { sheetName } = {}) {
  const wb = new ExcelJS.Workbook();

  // A .csv saved from Excel is still a spreadsheet to the person who made it.
  const isZip = buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b; // 'PK'
  if (isZip) {
    await wb.xlsx.load(buffer);
  } else {
    const { Readable } = await import('node:stream');
    await wb.csv.read(Readable.from(buffer.toString('utf8')));
  }

  const ws = sheetName
    ? wb.getWorksheet(sheetName) ?? wb.worksheets[0]
    : wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };

  const headerRow = ws.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = cellText(cell.value).toLowerCase().replace(/\s+/g, ' ').trim();
  });

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const record = { __row: rowNumber };
    let hasValue = false;
    headers.forEach((header, i) => {
      if (!header) return;
      const value = row.getCell(i + 1).value;
      record[header] = value;
      if (cellText(value) !== '') hasValue = true;
    });
    // Excel leaves empty rows behind; importing them as blank records would
    // produce a wall of "name is required" against rows nobody typed in.
    if (hasValue) rows.push(record);
  });

  return { headers: headers.filter(Boolean), rows };
}

/**
 * Build a workbook from one or more sheet definitions.
 *
 * @param {Array<{name: string, columns: Array<{header: string, key: string, width?: number}>, rows: object[], note?: string}>} sheets
 */
export async function buildWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Orbit QR Counterfeit System';
  wb.created = new Date();

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    ws.columns = sheet.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width ?? Math.max(12, c.header.length + 4),
    }));

    // A header that does not stand out gets sorted into the data by someone
    // in a hurry, and freezing it keeps it visible on a long export.
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    for (const row of sheet.rows) ws.addRow(row);

    if (sheet.note) {
      const noteRow = ws.addRow({});
      noteRow.getCell(1).value = sheet.note;
      noteRow.getCell(1).font = { italic: true, color: { argb: 'FF6B7A8D' } };
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Send a workbook as a download. */
export function sendWorkbook(res, filename, buffer) {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}

export default { cellText, cellDate, cellInt, cellBool, readSheet, buildWorkbook, sendWorkbook };
