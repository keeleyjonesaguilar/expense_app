// Ported from models.py -- the established spending categories, kept intact
// per the company's existing budget structure. "kind" drives the forecast's
// one-time-growth special case; "recurrence_basis" is the default budgeting
// cadence for the category (editable per-category in Settings) -- one of
// RECURRENCE_BASIS_OPTIONS below.
const ESTABLISHED_CATEGORIES = [
  ['Beverages', 'semi-variable', 'recurring-monthly'],
  ['Binding Supplies', 'fixed', 'recurring-monthly'],
  ['Books & Training Materials', 'semi-variable', 'recurring-quarterly'],
  ['Cleaning Supplies', 'semi-variable', 'recurring-monthly'],
  ['Coffee Supplies', 'semi-variable', 'recurring-monthly'],
  ['Computer Accessories', 'variable', 'recurring-monthly'],
  ['Computer Equipment', 'one-time-growth', 'one-time'],
  ['Conference Room Equipment', 'one-time-growth', 'one-time'],
  ['Electronics & IT Equipment', 'variable', 'recurring-monthly'],
  ['Event Supplies', 'semi-variable', 'recurring-quarterly'],
  ['First Aid & Medical Supplies', 'semi-variable', 'recurring-quarterly'],
  ['Gift Cards', 'fixed', 'recurring-quarterly'],
  ['Maintenance / Hardware Supplies', 'fixed', 'recurring-monthly'],
  ['Kitchen Supplies', 'semi-variable', 'recurring-monthly'],
  ['Label Supplies', 'fixed', 'recurring-quarterly'],
  ['Office Decor', 'one-time-growth', 'one-time'],
  ['Office Equipment', 'one-time-growth', 'one-time'],
  ['Office Furniture', 'one-time-growth', 'one-time'],
  ['Office Organization', 'one-time-growth', 'one-time'],
  ['Office Snacks & Candy', 'semi-variable', 'recurring-monthly'],
  ['Office Supplies', 'semi-variable', 'recurring-monthly'],
  ['Paper Products', 'semi-variable', 'recurring-monthly'],
  ['Pest Control', 'fixed', 'recurring-monthly'],
  ['Printer Supplies', 'semi-variable', 'recurring-quarterly'],
  ['Printing Services', 'semi-variable', 'recurring-quarterly'],
  ['Safety Supplies', 'variable', 'recurring-quarterly'],
  ['Shipping Supplies', 'variable', 'recurring-monthly'],
  ['Vehicle Supplies', 'fixed', 'recurring-quarterly'],
  ['Services', 'fixed', 'recurring-monthly'],
  ['Subscriptions', 'fixed', 'recurring-monthly'],
  ['Events', 'discretionary', 'recurring-yearly'],
  ['Catering', 'semi-variable', 'recurring-quarterly'],
  ['Personal Development', 'variable', 'recurring-yearly'],
  ['Food & Meals', 'semi-variable', 'recurring-monthly'],
  ['Lunch & Learn', 'semi-variable', 'recurring-monthly'],
  ['Holiday Party', 'discretionary', 'recurring-yearly'],
  ['Miscellaneous', 'semi-variable', 'recurring-monthly'],
];

// The per-category "default basis" choices offered in Settings.
const RECURRENCE_BASIS_OPTIONS = [
  ['one-time', 'One-Time'],
  ['recurring-weekly', 'Recurring — Weekly'],
  ['recurring-monthly', 'Recurring — Monthly'],
  ['recurring-quarterly', 'Recurring — Quarterly'],
  ['recurring-yearly', 'Recurring — Yearly'],
];

const STATUS_PENDING = 'pending';
const STATUS_APPROVED = 'approved';
const STATUS_REJECTED = 'rejected';
// Only used for source = SOURCE_SUPPLY_REQUEST: set when an admin approves
// the request but hasn't actually placed the order yet. Excluded from the
// Transactions page/dashboard totals the same as 'pending' -- only
// STATUS_APPROVED counts as real, booked spend.
const STATUS_AWAITING_ORDER = 'awaiting_order';

const SOURCE_MANUAL = 'manual';
const SOURCE_EXPENSE_REPORT = 'expense_report';
const SOURCE_BULK_IMPORT = 'bulk_import';
const SOURCE_SUPPLY_REQUEST = 'supply_request';

// Bulk-import column-alias seed data: one-time INSERT OR IGNORE into the
// DB-backed `column_aliases` table (see db.js) on first boot, so Settings ->
// Import Mapping has something to show/edit from day one. Aliases added
// later through that Settings page live only in the table, not here.
const DEFAULT_COLUMN_ALIASES = [
  ['date', 'date'],
  ['date', 'order date'],
  ['date', 'transaction date'],
  ['date', 'purchase date'],
  ['amount', 'amount'],
  ['amount', 'total'],
  ['amount', 'item net total'],
  ['amount', 'order total'],
  ['amount', 'price'],
  ['amount', 'cost'],
  ['description', 'description'],
  ['description', 'title'],
  ['description', 'item'],
  ['description', 'item description'],
  ['description', 'product'],
  ['description', 'standard item name'],
  ['vendor', 'vendor'],
  ['vendor', 'seller'],
  ['vendor', 'seller name'],
  ['vendor', 'merchant'],
  ['vendor', 'location'],
  ['vendor', 'supplier'],
  ['vendor', 'store'],
  ['link', 'link'],
  ['link', 'url'],
  ['link', 'product link'],
  ['category', 'category'],
  ['category', 'internal product category'],
  ['category', 'type'],
  ['notes', 'notes'],
  ['notes', 'memo'],
  ['notes', 'comment'],
  ['quantity', 'item quantity'],
  ['quantity', 'quantity'],
  ['quantity', 'qty'],
  ['quantity', 'units'],
  ['unit_price', 'price per item'],
  ['unit_price', 'unit price'],
  ['order_number', 'item/order #'],
  ['order_number', 'order #'],
  ['order_number', 'order number'],
  ['employee', 'employee'],
  ['employee', 'submitted by'],
  ['employee', 'user'],
  ['one_time', 'one-time'],
  ['one_time', 'one time'],
  ['one_time', 'one_time'],
];

// Fields the admin can toggle required/optional on the employee submission
// form (Settings -> Required Fields). Date is deliberately not in this list
// -- it's always required and not toggleable.
const REQUIRABLE_FIELDS = ['amount', 'category', 'vendor', 'quantity', 'receipt', 'notes'];

module.exports = {
  ESTABLISHED_CATEGORIES,
  RECURRENCE_BASIS_OPTIONS,
  STATUS_PENDING,
  STATUS_APPROVED,
  STATUS_REJECTED,
  STATUS_AWAITING_ORDER,
  SOURCE_MANUAL,
  SOURCE_EXPENSE_REPORT,
  SOURCE_BULK_IMPORT,
  SOURCE_SUPPLY_REQUEST,
  DEFAULT_COLUMN_ALIASES,
  REQUIRABLE_FIELDS,
};
