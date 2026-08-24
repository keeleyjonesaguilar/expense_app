const path = require('path');

// Ported from app.py's ext_of(): lowercased extension without the dot, or ''
// if there isn't one.
function extOf(filename) {
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return '';
  return filename.slice(idx + 1).toLowerCase();
}

// Rough equivalent of werkzeug's secure_filename(): strip directory
// components, collapse anything that isn't alphanumeric/dot/dash/underscore
// into an underscore, and trim leading dots/underscores so the result can't
// escape the upload directory or be hidden.
function secureFilename(filename) {
  const base = path.basename(filename).trim();
  let cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_');
  cleaned = cleaned.replace(/^[._]+/, '');
  return cleaned || 'file';
}

// Formats a JS Date (or date-only string) as YYYY-MM-DD, matching how the
// Python side stores/serializes db.Date columns and how the HTML <input
// type="date"> fields expect their value.
function toISODate(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    // Already ISO-ish ("YYYY-MM-DD" or with a time component) -- just take
    // the date part.
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  return null;
}

module.exports = { extOf, secureFilename, toISODate };
