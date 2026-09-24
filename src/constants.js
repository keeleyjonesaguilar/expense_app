// The company's 4 top-level spend buckets (redesigned 2026-09-16 per
// leadership review -- replaces the old ~38-category flat list). "kind"
// drives the Spend by Type report's fixed/discretionary split;
// "recurrence_basis" is the default budgeting cadence -- one of
// RECURRENCE_BASIS_OPTIONS below.
// Deliberately just 4, closed set: unlike the old categories, the app does
// not let the AI classifier invent a 5th -- every expense fits one of
// these, with TAGS (see ESTABLISHED_TAGS) carrying the finer-grained detail
// that categories used to carry.
const ESTABLISHED_CATEGORIES = [
  ['Office Expenses', 'semi-variable', 'recurring-monthly'],
  ['Professional Development', 'variable', 'recurring-yearly'],
  ['Business Development', 'discretionary', 'recurring-quarterly'],
  ['Team Engagement/Employee Retention', 'discretionary', 'recurring-quarterly'],
];

// Tags: the finer-grained label within a category (a transaction can carry
// more than one). Purely descriptive -- no kind/cadence of their own, since
// a transaction's budgeting pattern is decided at the category level and a
// multi-tag transaction can't cleanly have more than one. [tag name,
// category name it belongs to].
const ESTABLISHED_TAGS = [
  ['Software & Tech', 'Office Expenses'],
  ['Consumables', 'Office Expenses'],
  ['Supplies', 'Office Expenses'],
  ['PPE', 'Office Expenses'],

  ['Courses', 'Professional Development'],
  ['Renewals', 'Professional Development'],

  ['Memberships', 'Business Development'],
  ['Sponsorships', 'Business Development'],
  ['Events', 'Business Development'],
  ['Conferences', 'Business Development'],
  ['Speaking Engagements', 'Business Development'],
  ['Gifts & Meals', 'Business Development'],

  ['L&L', 'Team Engagement/Employee Retention'],
  ['Holiday Party', 'Team Engagement/Employee Retention'],
  ['Employee Gifts', 'Team Engagement/Employee Retention'],
  ['Summer Social', 'Team Engagement/Employee Retention'],
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
  ESTABLISHED_TAGS,
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
