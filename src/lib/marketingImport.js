// Bulk import for Marketing & ROI events (a spreadsheet of past
// networking/conference/sponsorship events) -- parallel to, but separate
// from, extraction.js's transaction import: a different target table with
// its own, much smaller column set (name/type/date/cost/location/notes),
// so it doesn't share the transaction column-alias machinery.
const fs = require('fs');
const path = require('path');
const { parse: parseCsv } = require('csv-parse/sync');
const XLSX = require('xlsx');

const { toISODate } = require('./util');

const VALID_EVENT_TYPES = ['networking', 'conference', 'marketing', 'sponsorship'];

// Column headers this recognizes, case-insensitive, first match per field
// wins. Anything not listed here just isn't auto-mapped -- there's no
// admin-editable alias table for this importer (unlike the transaction
// one) since event spreadsheets are rare enough not to warrant it yet.
const FIELD_ALIASES = {
  date: ['date', 'event date'],
  name: ['event name', 'name', 'event', 'title'],
  type: ['type', 'event type'],
  cost: ['ticket price', 'cost', 'price', 'total cost', 'amount'],
  location: ['event city, state', 'location', 'city, state', 'city'],
  association: ['association', 'org', 'organization', 'host'],
  attendees: ['attendees', 'attendee', 'who attended'],
  notes: ['notes', 'note'],
};

function findCol(columns, aliases) {
  const lower = {};
  for (const c of columns) lower[String(c).toLowerCase().trim()] = c;
  for (const alias of aliases) {
    if (alias in lower) return lower[alias];
  }
  return null;
}

function cleanStr(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function coerceDate(value) {
  if (value instanceof Date) return toISODate(value);
  if (typeof value === 'number') {
    // Excel serial date (days since 1899-12-30) -- same convention as the
    // transaction importer's coerceDate.
    const epoch = Date.UTC(1899, 11, 30);
    return toISODate(new Date(epoch + value * 86400000));
  }
  const s = cleanStr(value);
  return s === null ? null : toISODate(s);
}

function coerceCost(value) {
  if (typeof value === 'number') return value;
  const s = cleanStr(value);
  if (s === null) return 0;
  const n = parseFloat(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// No event-type column in most real-world sheets (this one included) --
// guess from the event name using the same keyword-rule spirit as the
// expense categorizer, defaulting to "networking" since that's what most
// association mixers/socials/meetings actually are.
function guessEventType(name) {
  const s = (name || '').toLowerCase();
  if (/\b(conference|summit|expo|convention)\b/.test(s)) return 'conference';
  if (/\bsponsor/.test(s)) return 'sponsorship';
  if (/\b(marketing|advertis|seo|campaign)\b/.test(s)) return 'marketing';
  return 'networking';
}

function extractMarketingEvents(filepath) {
  let records;
  if (filepath.toLowerCase().endsWith('.csv')) {
    const content = fs.readFileSync(filepath, 'utf8').replace(/="([^"]*)"/g, '"$1"');
    records = parseCsv(content, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
  } else {
    const workbook = XLSX.readFile(filepath);
    const name = workbook.SheetNames[0];
    records = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: null, raw: true });
  }

  if (!records.length) return { rows: [], columnMapping: [] };
  const columns = Object.keys(records[0]);
  const cols = {};
  for (const field of Object.keys(FIELD_ALIASES)) cols[field] = findCol(columns, FIELD_ALIASES[field]);
  const columnMapping = columns.map((column) => ({
    column,
    matchedField: Object.keys(cols).find((key) => cols[key] === column) || null,
  }));

  const rows = records
    .map((r) => {
      const name = cleanStr(cols.name ? r[cols.name] : null);
      if (!name) return null; // a row with no event name at all isn't a real row (e.g. a trailing blank line)

      const explicitType = cleanStr(cols.type ? r[cols.type] : null);
      const eventType = VALID_EVENT_TYPES.includes((explicitType || '').toLowerCase())
        ? explicitType.toLowerCase()
        : guessEventType(name);

      const noteParts = [];
      const association = cleanStr(cols.association ? r[cols.association] : null);
      if (association) noteParts.push(`Association: ${association}`);
      const attendees = cleanStr(cols.attendees ? r[cols.attendees] : null);
      if (attendees) noteParts.push(`Attendees: ${attendees}`);
      const sheetNotes = cleanStr(cols.notes ? r[cols.notes] : null);
      if (sheetNotes) noteParts.push(sheetNotes);

      return {
        date: cols.date ? coerceDate(r[cols.date]) : null,
        name,
        event_type: eventType,
        cost: cols.cost ? coerceCost(r[cols.cost]) : 0,
        location: cleanStr(cols.location ? r[cols.location] : null) || '',
        notes: noteParts.join(' | ').slice(0, 1000),
      };
    })
    .filter(Boolean);

  return { rows, columnMapping };
}

module.exports = { extractMarketingEvents, VALID_EVENT_TYPES };
