// Advisory (never blocking) duplicate-import detection, shared by the bulk
// importer and the single-receipt "Scan Receipt" flow. A row is flagged as
// a likely accidental re-import if EITHER:
//   1. date + item/description text match an existing transaction, or
//   2. date + amount + vendor match an existing transaction (even if the
//      description text doesn't -- e.g. two receipts for the same
//      date/vendor/amount that got OCR'd or typed slightly differently).
// Matching on vendor/amount alone (without date) is deliberately NOT done
// -- the same item is legitimately reordered often, and would false-positive
// constantly. Pirate Ship is excluded from the date+amount+vendor check
// specifically: postage purchases from it frequently land on the exact same
// price by coincidence, not because they're the same shipment re-entered.
const db = require('../db');

const PIRATE_SHIP_EXCEPTION = 'pirate ship';

const byDateAndDescription = db.prepare(`
  SELECT id, amount FROM transactions
  WHERE date = ? AND TRIM(LOWER(description)) = TRIM(LOWER(?)) AND TRIM(LOWER(description)) != ''
`);

const byDateAmountVendor = db.prepare(`
  SELECT t.id, t.amount FROM transactions t
  JOIN vendors v ON v.id = t.vendor_id
  WHERE t.date = ? AND t.amount = ? AND TRIM(LOWER(v.name)) = TRIM(LOWER(?))
`);

function findDuplicates({ date, description, amount, vendor }) {
  const matches = new Map();
  if (date && description) {
    for (const m of byDateAndDescription.all(date, description)) matches.set(m.id, m);
  }
  if (date && amount != null && vendor && vendor.trim().toLowerCase() !== PIRATE_SHIP_EXCEPTION) {
    for (const m of byDateAmountVendor.all(date, amount, vendor)) matches.set(m.id, m);
  }
  return [...matches.values()];
}

module.exports = { findDuplicates };
