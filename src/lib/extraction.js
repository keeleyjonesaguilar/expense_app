/**
 * Document extraction pipeline: turns an uploaded spreadsheet, PDF, or image
 * into a list of candidate transaction rows with a *suggested* category/
 * vendor/amount/date. Nothing here writes to the database directly --
 * callers always show the suggestions to a human for review before
 * committing, because OCR and keyword-based categorization both make
 * mistakes.
 *
 * Ported from extraction.py. The regex category-matching rules and the
 * date/amount/vendor-guessing heuristics are translated verbatim in logic.
 *
 * KNOWN LIMITATION vs. the Python version: the Python original falls back to
 * rendering each PDF page as an image and running Tesseract OCR on it
 * (PyMuPDF + pytesseract) when a PDF has no extractable text layer (i.e. a
 * scanned document). That fallback needs native PDF-to-image rendering
 * (poppler/canvas), which reintroduces the native-build-tool pain this port
 * otherwise avoids by using pure-JS/WASM deps. This port skips that fallback:
 * a text-less PDF returns a low-confidence/empty result gracefully instead of
 * crashing. Plain image uploads (jpg/png) still get full OCR via
 * tesseract.js, matching the Python behavior for that case.
 */
const fs = require('fs');
const path = require('path');
const { parse: parseCsv } = require('csv-parse/sync');
const XLSX = require('xlsx');

const db = require('../db');
const { toISODate } = require('./util');

// ---------------------------------------------------------------------------
// Category keyword rules -- ordered most-specific-first so a broad word
// (e.g. "office") doesn't steal a match that a more specific phrase should
// win. This is a starting ruleset; the admin can always override a
// suggestion, and every suggestion is labeled "suggested" until approved.
// ---------------------------------------------------------------------------
const RULES = [
  [/\b(gift card|giftcard|visa gift|amazon gift)\b/i, 'Gift Cards'],
  [/\b(conference room|projector|tv mount|video bar|meeting room)\b/i, 'Conference Room Equipment'],
  [/\b(monitor|docking station|laptop stand|keyboard|mouse pad|webcam|usb hub|cable)\b/i, 'Computer Accessories'],
  [/\b(laptop|desktop|computer|macbook|chromebook)\b/i, 'Computer Equipment'],
  [/\b(phone case|airtag|charger|earbuds|headphone|tablet|ipad)\b/i, 'Electronics & IT Equipment'],
  [/\b(fire extinguisher|first aid|band-?aid|bandage|medical kit|aed)\b/i, 'First Aid & Medical Supplies'],
  [/\b(hard hat|safety glasses|ppe|safety vest|steel toe|respirator|ear plug)\b/i, 'Safety Supplies'],
  [/\b(pest control|exterminator|termite|rodent)\b/i, 'Pest Control'],
  [/\b(pallet|freight|fedex|ups|usps|shipping label|postage|pirate ship)\b/i, 'Shipping Supplies'],
  [/\b(oil change|tire|car wash|vehicle|windshield|dash cam)\b/i, 'Vehicle Supplies'],
  [/\b(binder|binding|comb bind|laminat)\b/i, 'Binding Supplies'],
  [/\b(course|training|certification|udemy|textbook|workshop|seminar|conference ticket|tuition)\b/i, 'Personal Development'],
  [/\b(cleaning|disinfect|sanitiz|paper towel dispenser|trash bag|mop|broom)\b/i, 'Cleaning Supplies'],
  [/\b(coffee|k-?cup|creamer|espresso)\b/i, 'Coffee Supplies'],
  [/\b(soda|energy drink|sparkling water|juice|celsius|gatorade|bodyarmor)\b/i, 'Beverages'],
  [/\b(candy|chocolate|snack|chips|granola|popcorn)\b/i, 'Office Snacks & Candy'],
  [/\b(lunch|dinner|restaurant|doordash|grubhub|catering|donuts|pizza|domino)\b/i, 'Food & Meals'],
  [/\b(paper towel|napkin|toilet paper|tissue)\b/i, 'Paper Products'],
  [/\b(printer ink|toner|ink cartridge)\b/i, 'Printer Supplies'],
  [/\b(business card|printing service|print shop|banner|signage|flyer)\b/i, 'Printing Services'],
  [/\b(label maker|label printer|barcode label)\b/i, 'Label Supplies'],
  [/\b(dish|cup|mug|cooler|kitchen|utensil|microwave|fridge|refrigerator)\b/i, 'Kitchen Supplies'],
  [/\b(decor|frame|plant|artwork|rug)\b/i, 'Office Decor'],
  [/\b(desk|chair|filing cabinet|table|cubicle|standing desk)\b/i, 'Office Furniture'],
  [/\b(file organizer|binder clip|folder|divider|storage bin|label tape)\b/i, 'Office Organization'],
  [/\b(software|subscription|saas|glideapps|hubspot|zoom|slack)\b/i, 'Services'],
  [/\b(pen|paper|notebook|stapler|scissors|tape|sticky note|envelope)\b/i, 'Office Supplies'],
  [/\b(event ticket|sponsorship|booth|expo|nawic|networking event)\b/i, 'Events'],
  [/\b(maintenance|repair|hvac|hardware store|tool|drill|screwdriver)\b/i, 'Maintenance / Hardware Supplies'],
];

function suggestCategory(text) {
  if (!text) return 'Miscellaneous';
  for (const [pattern, cat] of RULES) {
    if (pattern.test(text)) return cat;
  }
  return 'Miscellaneous';
}

const DATE_PATTERNS = [/(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/, /(\d{4}-\d{2}-\d{2})/];
const AMOUNT_PATTERN = /\$?\s*(\d{1,6}(?:,\d{3})*\.\d{2})/g;
const AMOUNT_PATTERN_FULL = /^\$?\s*(\d{1,6}(?:,\d{3})*\.\d{2})$/;

function parseTwoDigitYear(y) {
  // Same behavior as Python's strptime %y: 00-68 -> 2000-2068, 69-99 -> 1969-1999.
  const n = parseInt(y, 10);
  return n <= 68 ? 2000 + n : 1900 + n;
}

function tryDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseDateGuess(text) {
  for (const pat of DATE_PATTERNS) {
    const m = text.match(pat);
    if (!m) continue;
    const raw = m[1];

    // yyyy-mm-dd
    let parts = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (parts) {
      const result = tryDate(parseInt(parts[1], 10), parseInt(parts[2], 10), parseInt(parts[3], 10));
      if (result) return result;
      continue;
    }

    // m/d/yyyy, m/d/yy, m-d-yyyy, m-d-yy (mirrors trying each strptime format
    // in order in the Python version: %m/%d/%Y, %m/%d/%y, %m-%d-%Y, %m-%d-%y)
    parts = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (parts) {
      const month = parseInt(parts[1], 10);
      const day = parseInt(parts[2], 10);
      let year = parts[3];
      year = year.length === 4 ? parseInt(year, 10) : parseTwoDigitYear(year);
      const result = tryDate(year, month, day);
      if (result) return result;
    }
  }
  return null;
}

function parseAmountGuess(text) {
  const amounts = [];
  let m;
  AMOUNT_PATTERN.lastIndex = 0;
  while ((m = AMOUNT_PATTERN.exec(text)) !== null) {
    amounts.push(parseFloat(m[1].replace(/,/g, '')));
  }
  if (!amounts.length) return null;
  // heuristic: the total is usually the largest dollar figure on a receipt
  return Math.max(...amounts);
}

function guessVendor(text) {
  // first non-empty line is very often the vendor/merchant name on a receipt
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line && !AMOUNT_PATTERN_FULL.test(line) && line.length > 2) {
      return line.slice(0, 120);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spreadsheet extraction
// ---------------------------------------------------------------------------
// Column-alias matching is DB-backed (the `column_aliases` table, seeded
// from constants.js's DEFAULT_COLUMN_ALIASES on first boot) so Settings ->
// Import Mapping can teach the matcher new source-column names without a
// code change. Reloaded per call rather than cached, since it's a tiny
// table and this keeps a just-added Settings alias effective immediately.
function loadColumnAliases() {
  const rows = db.prepare('SELECT field, alias FROM column_aliases').all();
  const map = {};
  for (const { field, alias } of rows) {
    if (!map[field]) map[field] = [];
    map[field].push(alias);
  }
  return map;
}

function findCol(columns, aliases) {
  const lower = {};
  for (const c of columns) lower[String(c).toLowerCase().trim()] = c;
  for (const alias of aliases) {
    if (alias in lower) return lower[alias];
  }
  return null;
}

// Spreadsheet exports like Amazon order histories use "N/a" as a blank
// placeholder in cells that don't apply to a given row (e.g. quantity on a
// sponsorship line item). Treat that the same as an empty cell everywhere.
function cleanStr(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s || /^n\/?a$/i.test(s)) return null;
  return s;
}

function coerceAmount(value) {
  const s = cleanStr(value);
  if (s === null && typeof value !== 'number') return null;
  const n = typeof value === 'number' ? value : parseFloat(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function coerceDate(value) {
  if (value instanceof Date) return toISODate(value);
  if (typeof value === 'number') {
    // Excel serial date (days since 1899-12-30).
    const epoch = Date.UTC(1899, 11, 30);
    const dt = new Date(epoch + value * 86400000);
    return toISODate(dt);
  }
  const s = cleanStr(value);
  return s === null ? null : toISODate(s);
}

// A sheet "looks like" a transaction log if its header row has both a
// recognizable date column and a recognizable amount column -- distinguishes
// e.g. a workbook's "2025"/"2026" transaction-log tabs from a plain
// single-column "Categories" list or other summary tabs that happen to share
// the same workbook.
function sheetLooksLikeTransactions(headerRow, aliasMap) {
  const cols = headerRow.map((c) => String(c || '').toLowerCase().trim());
  const hasAlias = (aliases) => (aliases || []).some((a) => cols.includes(a));
  return hasAlias(aliasMap.date) && hasAlias(aliasMap.amount);
}

// Lists sheet names in an xlsx/xls workbook, flagging which ones look like
// transaction logs (see above) so callers can default to a sensible sheet
// and still let a human override it for an unusual workbook layout. Returns
// null for CSVs, which have no concept of multiple sheets.
function listSpreadsheetSheets(filepath) {
  if (filepath.toLowerCase().endsWith('.csv')) return null;
  const aliasMap = loadColumnAliases();
  const workbook = XLSX.readFile(filepath);
  return workbook.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, blankrows: false });
    return {
      name,
      rowCount: Math.max(0, rows.length - 1),
      looksLikeTransactions: rows.length > 0 && sheetLooksLikeTransactions(rows[0], aliasMap),
    };
  });
}

function parseOneTimeValue(raw, fallback) {
  const s = cleanStr(raw);
  if (s === null) return fallback;
  const lower = s.toLowerCase();
  if (['yes', 'true', '1', 'one-time', 'one time', 'one_time'].includes(lower)) return true;
  if (['no', 'false', '0', 'recurring'].includes(lower)) return false;
  return fallback;
}

// Resolves, for each column in `columns`, which field (if any) it maps to --
// explicit `overrideMap` entries (raw source column name -> field name, or
// 'none' to force-exclude) win over the alias-based auto-match. Returns the
// per-field source-column map plus a per-column summary
// ({column, matchedField}) for the review-grid UI.
function resolveColumnMapping(columns, aliasMap, overrideMap) {
  const cols = {};
  for (const key of Object.keys(aliasMap)) {
    cols[key] = findCol(columns, aliasMap[key]);
  }
  if (overrideMap) {
    for (const [sourceCol, targetField] of Object.entries(overrideMap)) {
      if (!columns.includes(sourceCol)) continue;
      // Clear this column from whatever field auto-matched it, then
      // reassign per the override (unless the override says 'none').
      for (const key of Object.keys(cols)) {
        if (cols[key] === sourceCol) cols[key] = null;
      }
      if (targetField && targetField !== 'none') cols[targetField] = sourceCol;
    }
  }
  const columnMapping = columns.map((column) => ({
    column,
    matchedField: Object.keys(cols).find((key) => cols[key] === column) || null,
  }));
  return { cols, columnMapping };
}

// Returns { rows, columnMapping }. `sheetName`, for xlsx/xls, picks a
// specific sheet -- if omitted, the first sheet that looks like a
// transaction log wins (see sheetLooksLikeTransactions), falling back to
// the first sheet in the workbook if none do. `overrideMap` (optional),
// keyed by raw source column name, lets a caller manually re-map a column
// to a different field (or 'none' to exclude it) ahead of the normal
// alias-based auto-match -- used by the bulk-import review grid's
// "Re-map & Preview" control; not persisted (Settings -> Import Mapping is
// what teaches the matcher new aliases permanently).
function extractFromSpreadsheet(filepath, sheetName, overrideMap) {
  let records;
  const aliasMap = loadColumnAliases();
  if (filepath.toLowerCase().endsWith('.csv')) {
    const content = fs.readFileSync(filepath, 'utf8');
    records = parseCsv(content, { columns: true, skip_empty_lines: true, relax_column_count: true });
  } else {
    const workbook = XLSX.readFile(filepath);
    let name = sheetName && workbook.SheetNames.includes(sheetName) ? sheetName : null;
    if (!name) {
      name = workbook.SheetNames.find((n) => {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[n], { header: 1, raw: true, blankrows: false });
        return rows.length > 0 && sheetLooksLikeTransactions(rows[0], aliasMap);
      });
    }
    if (!name) name = workbook.SheetNames[0];
    records = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: null, raw: true });
  }

  if (!records.length) return { rows: [], columnMapping: [] };
  const columns = Object.keys(records[0]);
  const { cols, columnMapping } = resolveColumnMapping(columns, aliasMap, overrideMap);
  const employees = db.prepare('SELECT id, name FROM users').all();
  const findEmployee = (name) => {
    if (!name) return null;
    const lower = name.toLowerCase();
    return employees.find((e) => e.name.toLowerCase() === lower) || null;
  };

  const rows = records.map((r) => {
    const desc = cleanStr(cols.description ? r[cols.description] : null) || '';
    const amt = cols.amount ? coerceAmount(r[cols.amount]) : null;
    const dateVal = cols.date ? coerceDate(r[cols.date]) : null;
    const vendor = cleanStr(cols.vendor ? r[cols.vendor] : null);
    const link = cleanStr(cols.link ? r[cols.link] : null);
    const quantity = coerceAmount(cols.quantity ? r[cols.quantity] : null);
    const unitPrice = coerceAmount(cols.unit_price ? r[cols.unit_price] : null);
    const employeeName = cleanStr(cols.employee ? r[cols.employee] : null);
    const employee = findEmployee(employeeName);

    // The source sheet's own category column is authoritative -- an admin
    // (or the exporting system) already assigned it, so trust it over the
    // keyword-guessed category instead of just using it as a tie-breaker.
    const explicitCategory = cleanStr(cols.category ? r[cols.category] : null);
    const suggestedCategory = explicitCategory || suggestCategory(desc);
    // Events are almost always one-off (a sponsorship, a conference ticket)
    // rather than a recurring monthly cost -- that's the fallback when the
    // sheet doesn't have its own One-Time-style column; an explicit
    // yes/no/recurring value in a matched column wins over the fallback.
    const eventsFallback = suggestedCategory === 'Events';
    const suggestOneTime = parseOneTimeValue(cols.one_time ? r[cols.one_time] : null, eventsFallback);

    // Order-# has no dedicated Transaction column, so it goes in notes
    // rather than being silently dropped -- this is a deliberate, matched
    // alias, unlike a genuinely unrecognized column (which is dropped
    // entirely, not folded into notes; see resolveColumnMapping/
    // columnMapping for what wasn't imported anywhere).
    const noteParts = [];
    const sheetNotes = cleanStr(cols.notes ? r[cols.notes] : null);
    if (sheetNotes) noteParts.push(sheetNotes);
    const orderNumber = cleanStr(cols.order_number ? r[cols.order_number] : null);
    if (orderNumber) noteParts.push(`Order #: ${orderNumber}`);

    return {
      date: dateVal,
      amount: amt,
      description: desc.slice(0, 500),
      vendor,
      link,
      quantity,
      unit_price: unitPrice,
      employee_id: employee ? employee.id : null,
      employee_name: employee ? employee.name : employeeName,
      suggested_category: suggestedCategory,
      suggest_one_time: suggestOneTime,
      notes: noteParts.join(' | ').slice(0, 500),
      raw_text: desc,
    };
  });

  return { rows, columnMapping };
}

// ---------------------------------------------------------------------------
// PDF extraction (text-layer only -- see the module doc comment above for why
// the scanned-PDF OCR fallback from the Python version is not ported).
// ---------------------------------------------------------------------------
async function extractTextFromPdf(filepath) {
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch (err) {
    return '';
  }
  try {
    const buffer = fs.readFileSync(filepath);
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (err) {
    // Malformed/unreadable PDF, or (most commonly) a scanned PDF with no
    // text layer at all -- return empty rather than crashing. The Python
    // version would fall back to rendering+OCR here; this port doesn't (see
    // module doc comment), so the caller gets a low-confidence empty result.
    return '';
  }
}

async function extractTextFromImage(filepath) {
  let Tesseract;
  try {
    Tesseract = require('tesseract.js');
  } catch (err) {
    return '';
  }
  try {
    const { data } = await Tesseract.recognize(filepath, 'eng');
    return data.text || '';
  } catch (err) {
    return '';
  }
}

// file_type in {'pdf','image'}. Returns a single candidate row (a receipt/
// statement usually represents one purchase or one page of a statement) with
// the raw OCR/text kept for the human reviewer.
async function extractFromDocument(filepath, fileType) {
  const text = fileType === 'pdf' ? await extractTextFromPdf(filepath) : await extractTextFromImage(filepath);
  const suggestedCategory = suggestCategory(text);

  return {
    date: parseDateGuess(text),
    amount: parseAmountGuess(text),
    description: guessVendor(text) || path.basename(filepath),
    vendor: guessVendor(text),
    suggested_category: suggestedCategory,
    suggest_one_time: suggestedCategory === 'Events',
    raw_text: text.slice(0, 5000),
  };
}

module.exports = {
  suggestCategory,
  parseDateGuess,
  parseAmountGuess,
  guessVendor,
  listSpreadsheetSheets,
  extractFromSpreadsheet,
  extractFromDocument,
  extractTextFromPdf,
  extractTextFromImage,
};
