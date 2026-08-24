// Minimal RFC-4180 CSV writer -- small enough not to need a dependency.
// Quotes a field only when necessary (contains a comma, quote, or newline),
// doubling any embedded quotes, matching how Excel/Sheets read CSVs back.
function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// rows: array of arrays (first row is typically the header). Returns a
// single CSV string using CRLF line endings per RFC 4180.
function toCsv(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

module.exports = { toCsv };
