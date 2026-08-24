// Ported from models.py -- the established spending categories, kept intact
// per the company's existing budget structure. "kind" drives how the
// forecast treats it.
const ESTABLISHED_CATEGORIES = [
  ['Beverages', 'semi-variable'],
  ['Binding Supplies', 'fixed'],
  ['Books & Training Materials', 'semi-variable'],
  ['Cleaning Supplies', 'semi-variable'],
  ['Coffee Supplies', 'semi-variable'],
  ['Computer Accessories', 'variable'],
  ['Computer Equipment', 'one-time-growth'],
  ['Conference Room Equipment', 'one-time-growth'],
  ['Electronics & IT Equipment', 'variable'],
  ['Event Supplies', 'semi-variable'],
  ['First Aid & Medical Supplies', 'semi-variable'],
  ['Gift Cards', 'fixed'],
  ['Maintenance / Hardware Supplies', 'fixed'],
  ['Kitchen Supplies', 'semi-variable'],
  ['Label Supplies', 'fixed'],
  ['Office Decor', 'one-time-growth'],
  ['Office Equipment', 'one-time-growth'],
  ['Office Furniture', 'one-time-growth'],
  ['Office Organization', 'one-time-growth'],
  ['Office Snacks & Candy', 'semi-variable'],
  ['Office Supplies', 'semi-variable'],
  ['Paper Products', 'semi-variable'],
  ['Pest Control', 'fixed'],
  ['Printer Supplies', 'semi-variable'],
  ['Printing Services', 'semi-variable'],
  ['Safety Supplies', 'variable'],
  ['Shipping Supplies', 'variable'],
  ['Vehicle Supplies', 'fixed'],
  ['Services', 'fixed'],
  ['Events', 'discretionary'],
  ['Catering', 'semi-variable'],
  ['Personal Development', 'variable'],
  ['Food & Meals', 'semi-variable'],
  ['Lunch & Learn', 'semi-variable'],
  ['Holiday Party', 'discretionary'],
  ['Miscellaneous', 'semi-variable'],
];

const STATUS_PENDING = 'pending';
const STATUS_APPROVED = 'approved';
const STATUS_REJECTED = 'rejected';

const SOURCE_MANUAL = 'manual';
const SOURCE_EXPENSE_REPORT = 'expense_report';
const SOURCE_BULK_IMPORT = 'bulk_import';
const SOURCE_SUPPLY_REQUEST = 'supply_request';

module.exports = {
  ESTABLISHED_CATEGORIES,
  STATUS_PENDING,
  STATUS_APPROVED,
  STATUS_REJECTED,
  SOURCE_MANUAL,
  SOURCE_EXPENSE_REPORT,
  SOURCE_BULK_IMPORT,
  SOURCE_SUPPLY_REQUEST,
};
