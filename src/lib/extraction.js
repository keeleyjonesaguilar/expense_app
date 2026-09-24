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
const { classifyReceiptWithAI, classifyDescriptionsBatch, TAG_TO_EVENT_TYPE } = require('./aiClassify');

function eventTypeFromTags(tags) {
  const match = tags.find((t) => TAG_TO_EVENT_TYPE[t.name]);
  return match ? TAG_TO_EVENT_TYPE[match.name] : null;
}

// ---------------------------------------------------------------------------
// Category+tag keyword rules -- ordered most-specific-first so a broad word
// (e.g. "office") doesn't steal a match that a more specific phrase should
// win. Deterministic fallback for when AI classification is off/unreachable
// -- the AI path (aiClassify.js) reads the item's actual meaning and is
// materially more accurate than keyword matching, especially now that
// there are only 4 categories but many more tag distinctions to get right.
// This is a starting ruleset; an admin can always override a suggestion,
// and every suggestion is labeled "suggested" until approved.
// [regex, category name, tag name]
// ---------------------------------------------------------------------------
const RULES = [
  // Team Engagement/Employee Retention
  [/\b(employee gift|birthday gift|anniversary gift)\b/i, 'Team Engagement/Employee Retention', 'Employee Gifts'],
  [/\b(gift card|giftcard|visa gift|amazon gift)\b/i, 'Team Engagement/Employee Retention', 'Employee Gifts'],
  [/\b(lunch\s*(?:and|&)\s*learn|\bl\s*&\s*l\b)\b/i, 'Team Engagement/Employee Retention', 'L&L'],
  [/\b(holiday party|holiday social|christmas party)\b/i, 'Team Engagement/Employee Retention', 'Holiday Party'],
  [/\bsummer (social|party|picnic)\b/i, 'Team Engagement/Employee Retention', 'Summer Social'],

  // Business Development
  [/\b(sponsorship|sponsor a|booth fee)\b/i, 'Business Development', 'Sponsorships'],
  [/\b(conference registration|summit|convention)\b/i, 'Business Development', 'Conferences'],
  [/\b(membership dues|chamber of commerce|association membership)\b/i, 'Business Development', 'Memberships'],
  [/\b(event ticket|expo|nawic|networking event|mixer)\b/i, 'Business Development', 'Events'],
  [/\b(client (?:lunch|dinner)|client meal|client gift)\b/i, 'Business Development', 'Gifts & Meals'],

  // Professional Development
  [/\b(renewal|recertif|license renewal)\b/i, 'Professional Development', 'Renewals'],
  [/\b(course|training|certification|udemy|coursera|textbook|workshop|seminar|tuition)\b/i, 'Professional Development', 'Courses'],

  // Office Expenses
  [/\b(software|subscription|saas|glideapps|hubspot|zoom|slack)\b/i, 'Office Expenses', 'Software & Tech'],
  [/\b(conference room|projector|tv mount|video bar|meeting room)\b/i, 'Office Expenses', 'Software & Tech'],
  [/\b(monitor|docking station|laptop stand|keyboard|mouse pad|webcam|usb hub|cable|speaker)\b/i, 'Office Expenses', 'Software & Tech'],
  [/\b(laptop|desktop|computer|macbook|chromebook)\b/i, 'Office Expenses', 'Software & Tech'],
  [/\b(phone case|airtag|charger|earbuds|headphone|tablet|ipad)\b/i, 'Office Expenses', 'Software & Tech'],
  [/\b(hard hat|safety glasses|\bppe\b|safety vest|steel toe|respirator|ear plug)\b/i, 'Office Expenses', 'PPE'],
  [/\b(fire extinguisher|first aid|band-?aid|bandage|medical kit|aed)\b/i, 'Office Expenses', 'PPE'],
  [/\b(binder|binding|comb bind|laminat)\b/i, 'Office Expenses', 'Consumables'],
  [/\b(cleaning|disinfect|sanitiz|paper towel dispenser|trash bag|mop|broom)\b/i, 'Office Expenses', 'Consumables'],
  [/\b(coffee|k-?cup|creamer|espresso)\b/i, 'Office Expenses', 'Consumables'],
  [/\b(soda|energy drink|sparkling water|juice|celsius|gatorade|bodyarmor)\b/i, 'Office Expenses', 'Consumables'],
  [/\b(candy|chocolate|snack|chips|granola|popcorn)\b/i, 'Office Expenses', 'Consumables'],
  [/\b(paper towel|napkin|toilet paper|tissue)\b/i, 'Office Expenses', 'Consumables'],
  [/\b(printer ink|toner|ink cartridge)\b/i, 'Office Expenses', 'Consumables'],
  [/\b(dish|cup|mug|cooler|kitchen|utensil|microwave|fridge|refrigerator)\b/i, 'Office Expenses', 'Consumables'],
  [/\b(pest control|exterminator|termite|rodent)\b/i, 'Office Expenses', 'Supplies'],
  [/\b(pallet|freight|fedex|ups|usps|shipping label|postage|pirate ship)\b/i, 'Office Expenses', 'Supplies'],
  [/\b(oil change|tire|car wash|vehicle|windshield|dash cam)\b/i, 'Office Expenses', 'Supplies'],
  // "business card" alone false-matched holders/displays (a desk accessory,
  // not a printing job) -- require actual printing intent in the phrase.
  [/\b(business card printing|print(?:ing)? business cards?|printing service|print shop|banner|signage|flyer)\b/i, 'Office Expenses', 'Supplies'],
  [/\b(label maker|label printer|barcode label)\b/i, 'Office Expenses', 'Supplies'],
  [/\b(decor|frame|plant|artwork|rug)\b/i, 'Office Expenses', 'Supplies'],
  [/\b(desk|chair|filing cabinet|table|cubicle|standing desk)\b/i, 'Office Expenses', 'Supplies'],
  [/\b(file organizer|binder clip|folder|divider|storage bin|label tape)\b/i, 'Office Expenses', 'Supplies'],
  [/\b(pen|paper|notebook|stapler|scissors|tape|sticky note|envelope)\b/i, 'Office Expenses', 'Supplies'],
  [/\b(maintenance|repair|hvac|hardware store|tool|drill|screwdriver)\b/i, 'Office Expenses', 'Supplies'],
];

// Returns { category, tag } -- always a real category (defaults to "Office
// Expenses"/"Supplies", the closest thing to a catch-all in the new closed
// 4-category taxonomy) since, unlike the old per-category regex, there's no
// separate "Miscellaneous" category anymore.
function suggestCategoryAndTag(text) {
  if (text) {
    for (const [pattern, category, tag] of RULES) {
      if (pattern.test(text)) return { category, tag };
    }
  }
  return { category: 'Office Expenses', tag: 'Supplies' };
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
async function extractFromSpreadsheet(filepath, sheetName, overrideMap) {
  let records;
  const aliasMap = loadColumnAliases();
  if (filepath.toLowerCase().endsWith('.csv')) {
    // Excel's "preserve leading zeros/exact text" escape (="0123") -- used
    // by Amazon Business exports for UNSPSC codes and ZIP codes -- isn't
    // valid CSV (a quote can't start mid-field) and makes the parser throw.
    // Unwrap it to a plain quoted value before parsing.
    const content = fs.readFileSync(filepath, 'utf8').replace(/="([^"]*)"/g, '"$1"');
    records = parseCsv(content, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
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
  const employees = db.prepare('SELECT id, name FROM employees').all();
  const allCategories = db.prepare('SELECT name, kind, recurrence_basis FROM categories').all();
  const categoryDetails = {};
  for (const c of allCategories) categoryDetails[c.name] = c;
  const matchCategory = (raw) => {
    if (!raw) return null;
    const found = allCategories.find((c) => c.name.toLowerCase() === raw.toLowerCase());
    return found ? found.name : null;
  };
  const findEmployee = (name) => {
    if (!name) return null;
    const lower = name.toLowerCase();
    return employees.find((e) => e.name.toLowerCase() === lower) || null;
  };

  // Two passes: first build every row's deterministic fields plus the
  // regex-based category guess (always available, needed as a fallback
  // regardless); then, for rows where the sheet didn't already give an
  // explicit category (that stays authoritative -- an admin/exporting
  // system already decided it), send the descriptions to the local AI in
  // batches so each item's actual title gets judged on its own merits
  // instead of falling back to a generic bucket. See aiClassify.js's
  // classifyDescriptionsBatch for why this is batched rather than one
  // request per row (one-at-a-time would take hours on a large import).
  const preRows = records.map((r) => {
    const desc = cleanStr(cols.description ? r[cols.description] : null) || '';
    const amt = cols.amount ? coerceAmount(r[cols.amount]) : null;
    const dateVal = cols.date ? coerceDate(r[cols.date]) : null;
    const vendor = cleanStr(cols.vendor ? r[cols.vendor] : null);
    const link = cleanStr(cols.link ? r[cols.link] : null);
    const quantity = coerceAmount(cols.quantity ? r[cols.quantity] : null);
    const unitPrice = coerceAmount(cols.unit_price ? r[cols.unit_price] : null);
    const employeeName = cleanStr(cols.employee ? r[cols.employee] : null);
    const employee = findEmployee(employeeName);

    // The source sheet's own category column is authoritative ONLY when it
    // actually names a real category (case-insensitively) -- an admin (or
    // the exporting system) already assigned it, so trust it over both the
    // keyword-guessed category and the AI's opinion in that case. Text that
    // doesn't match anything real (a spreadsheet's own unrelated taxonomy
    // column, a typo, different casing) is worse than no category at all --
    // treat it as absent so the row still gets a real category via AI/regex
    // instead of silently carrying garbage into the review grid.
    const explicitCategoryRaw = cleanStr(cols.category ? r[cols.category] : null);
    const explicitCategory = matchCategory(explicitCategoryRaw);
    const regexGuess = suggestCategoryAndTag(desc);

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
      explicitCategory,
      regexCategory: explicitCategory || regexGuess.category,
      regexTag: regexGuess.tag,
      one_time_raw: cols.one_time ? r[cols.one_time] : null,
      notes: noteParts.join(' | ').slice(0, 500),
      raw_text: desc,
    };
  });

  const aiItems = preRows
    .map((pr, index) => ({ index, description: pr.description, amount: pr.amount, explicit: !!pr.explicitCategory }))
    .filter((it) => !it.explicit && it.description);
  const aiResults = aiItems.length ? await classifyDescriptionsBatch(aiItems) : new Map();

  // A proposed-new TAG used by exactly ONE item across the whole import is
  // very unlikely to be a real recurring tag -- much more likely an odd
  // one-off item the model over-specifically invented a label for (the old
  // per-category version of this observed things like "Air Fresheners" for
  // a single item). Rather than relying on prompt wording alone to prevent
  // that, drop that one tag deterministically -- prompt tuning reduces how
  // often this happens, this guarantees it can't clutter the review screen
  // regardless of how the model behaves on a given run. A row left with no
  // tags at all after that falls back to the plain regex guess entirely.
  const newTagCounts = new Map();
  for (const ai of aiResults.values()) {
    for (const t of ai.tags) {
      if (!t.is_new) continue;
      const key = `${ai.suggested_category}::${t.name}`;
      newTagCounts.set(key, (newTagCounts.get(key) || 0) + 1);
    }
  }
  for (const [index, ai] of aiResults) {
    ai.tags = ai.tags.filter((t) => !t.is_new || newTagCounts.get(`${ai.suggested_category}::${t.name}`) !== 1);
    if (!ai.tags.length) aiResults.delete(index);
  }

  const rows = preRows.map((pr, index) => {
    const ai = aiResults.get(index);
    const suggestedCategory = ai ? ai.suggested_category : pr.regexCategory;
    const tags = ai ? ai.tags : [{ name: pr.regexTag, is_new: false }];
    // Events/Conferences/Sponsorships are almost always one-off rather than
    // a recurring monthly cost -- that's the fallback when the sheet
    // doesn't have its own One-Time-style column; an explicit yes/no/
    // recurring value in a matched column wins over the fallback.
    const eventsFallback = tags.some((t) => ['Events', 'Conferences', 'Sponsorships'].includes(t.name));
    const suggestOneTime = parseOneTimeValue(pr.one_time_raw, eventsFallback);

    return {
      date: pr.date,
      amount: pr.amount,
      description: pr.description,
      vendor: pr.vendor,
      link: pr.link,
      quantity: pr.quantity,
      unit_price: pr.unit_price,
      employee_id: pr.employee_id,
      employee_name: pr.employee_name,
      suggested_category: suggestedCategory,
      tags,
      suggested_kind: ai ? ai.suggested_kind : categoryDetails[suggestedCategory]?.kind || null,
      suggested_recurrence_basis: ai
        ? ai.suggested_recurrence_basis
        : categoryDetails[suggestedCategory]?.recurrence_basis || null,
      suggested_event_type: ai ? ai.suggested_event_type : eventTypeFromTags(tags),
      suggest_one_time: suggestOneTime,
      notes: pr.notes,
      raw_text: pr.raw_text,
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
//
// Baseline extraction is always the old regex/keyword heuristics below --
// cheap, fully deterministic, and a safe fallback. When OLLAMA_ENABLED=true
// (see aiClassify.js), a local vision-capable LLM is also asked to read the
// receipt (the image directly, or the extracted PDF text) and its answer
// overrides the heuristic fields it filled in, plus adds fields the
// heuristics never had an opinion on: a proposed *new* category's kind
// (fixed/variable/semi-variable/one-time-growth/discretionary) and
// recurrence cadence when the receipt doesn't match anything that already
// exists. If the model is unreachable or its answer doesn't parse, this
// silently falls back to the heuristic-only result -- ai_used tells the
// caller/template which happened.
async function extractFromDocument(filepath, fileType) {
  const text = fileType === 'pdf' ? await extractTextFromPdf(filepath) : await extractTextFromImage(filepath);
  const guess = suggestCategoryAndTag(text);
  const category = db.prepare('SELECT kind, recurrence_basis FROM categories WHERE name = ?').get(guess.category);
  const tags = [{ name: guess.tag, is_new: false }];

  const baseline = {
    date: parseDateGuess(text),
    amount: parseAmountGuess(text),
    description: guessVendor(text) || path.basename(filepath),
    vendor: guessVendor(text),
    suggested_category: guess.category,
    tags,
    suggested_kind: category ? category.kind : null,
    suggested_recurrence_basis: category ? category.recurrence_basis : null,
    suggested_event_type: eventTypeFromTags(tags),
    suggest_one_time: category ? category.recurrence_basis === 'one-time' : false,
    ai_confidence: null,
    ai_used: false,
    raw_text: text.slice(0, 5000),
  };

  const ai = await classifyReceiptWithAI({ imagePath: fileType === 'image' ? filepath : null, text });
  if (!ai) return baseline;

  return {
    ...baseline,
    date: ai.date || baseline.date,
    amount: ai.amount != null ? ai.amount : baseline.amount,
    description: ai.description || baseline.description,
    vendor: ai.vendor || baseline.vendor,
    suggested_category: ai.suggested_category,
    tags: ai.tags,
    suggested_kind: ai.suggested_kind,
    suggested_recurrence_basis: ai.suggested_recurrence_basis,
    suggested_event_type: ai.suggested_event_type,
    suggest_one_time: ai.suggest_one_time,
    ai_confidence: ai.confidence,
    ai_used: true,
  };
}

module.exports = {
  suggestCategoryAndTag,
  parseDateGuess,
  parseAmountGuess,
  guessVendor,
  listSpreadsheetSheets,
  extractFromSpreadsheet,
  extractFromDocument,
  extractTextFromPdf,
  extractTextFromImage,
};
