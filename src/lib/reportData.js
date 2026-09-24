// Shared transaction-summary logic used by both the admin dashboard and the
// Reports page, so the two don't drift out of sync with two copies of the
// same category/vendor/month/year-over-year math.

const TX_JOIN_SELECT = `
  SELECT t.*,
         c.name AS category_name,
         c.kind AS category_kind,
         c.recurrence_basis AS category_recurrence_basis,
         v.name AS vendor_name,
         emp.name AS employee_name,
         sub.name AS submitted_by_name
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN vendors v ON v.id = t.vendor_id
  LEFT JOIN employees emp ON emp.id = t.employee_id
  LEFT JOIN users sub ON sub.id = t.submitted_by_id
`;

function hydrate(t) {
  return {
    ...t,
    category: t.category_name
      ? { name: t.category_name, kind: t.category_kind, recurrence_basis: t.category_recurrence_basis }
      : null,
    vendor: t.vendor_name ? { name: t.vendor_name } : null,
    employee: t.employee_name ? { name: t.employee_name } : null,
    submitted_by: t.submitted_by_name ? { name: t.submitted_by_name } : null,
  };
}

// Display order/labels for the Spend-by-Kind breakdown -- fixed first
// (the "baseline, committed" end of the spectrum) through discretionary
// last (the most controllable/optional end), rather than sorted by dollar
// amount, so the progression itself carries meaning for a board reader.
const KIND_LABELS = [
  ['fixed', 'Fixed'],
  ['semi-variable', 'Semi-Variable'],
  ['variable', 'Variable'],
  ['one-time-growth', 'One-Time / Growth'],
  ['discretionary', 'Discretionary'],
];

// Display order/labels for the Recurring-spend-by-frequency breakdown --
// kept in sync with RECURRENCE_BASIS_OPTIONS in constants.js (not imported
// directly to avoid a circular require; this is display-only formatting).
const RECURRENCE_BASIS_LABELS = [
  ['recurring-weekly', 'Weekly'],
  ['recurring-monthly', 'Monthly'],
  ['recurring-quarterly', 'Quarterly'],
  ['recurring-yearly', 'Yearly'],
  ['one-time', 'One-Time (category default)'],
];

// Pulled out of the Recurring/One-Time split entirely (see computeSpendSummary
// below) since it's tracked as its own bucket -- covers events, conferences,
// sponsorships, memberships, and client gifts/meals (see constants.js's tags
// under this category).
const EVENT_MARKETING_CATEGORY = 'Business Development';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Restricts txs to a single calendar year: Jan 1 - Dec 31 of that year, or
// Jan 1 - today if `year` is the current (in-progress) calendar year, so a
// partial year's data doesn't get compared as if the rest were zero.
function filterToYear(txs, year) {
  if (!year) return txs;
  const y = String(year);
  const isCurrentYear = y === String(new Date().getFullYear());
  const end = isCurrentYear ? todayISO() : `${y}-12-31`;
  const start = `${y}-01-01`;
  return txs.filter((t) => t.date && t.date >= start && t.date <= end);
}

// txs: already-hydrated approved transactions (see hydrate() above).
// `year`, if given, scopes every figure to that calendar year (see
// filterToYear) -- omit it for an all-time summary (e.g. Reports).
function computeSpendSummary(allTxs, year) {
  const txs = filterToYear(allTxs, year);

  const byCategory = new Map();
  const byEmployee = new Map();
  const byVendor = new Map();
  const byMonth = new Map();
  const byRecurrenceBasis = new Map();
  const byKind = new Map();
  let onetimeTotal = 0;
  let recurringTotal = 0;
  let eventMarketingTotal = 0;

  const bump = (map, key, amt) => map.set(key, (map.get(key) || 0) + amt);

  for (const t of txs) {
    const catName = t.category ? t.category.name : 'Uncategorized';
    bump(byCategory, catName, t.amount);
    const empName = t.employee ? t.employee.name : t.submitted_by ? t.submitted_by.name : 'Bulk Import';
    bump(byEmployee, empName, t.amount);
    const vendName = t.vendor ? t.vendor.name : '(no vendor)';
    bump(byVendor, vendName, t.amount);
    const monthKey = t.date ? t.date.slice(0, 7) : 'unknown';
    bump(byMonth, monthKey, t.amount);
    const kind = (t.category && t.category.kind) || 'semi-variable';
    bump(byKind, kind, t.amount);

    // Event/Marketing (Business Development) is pulled out first and is
    // mutually exclusive with Recurring/One-Time by construction -- every
    // other transaction falls into exactly one of those two based on
    // is_one_time. The three buckets always sum to totalSpend.
    if (catName === EVENT_MARKETING_CATEGORY) {
      eventMarketingTotal += t.amount;
    } else if (t.is_one_time) {
      onetimeTotal += t.amount;
    } else {
      recurringTotal += t.amount;
      // Recurring Spend combined into one number hides whether that's
      // mostly a monthly commitment or a pile of quarterly/yearly ones --
      // split it by each transaction's category's recurrence_basis.
      const basis = (t.category && t.category.recurrence_basis) || 'recurring-monthly';
      bump(byRecurrenceBasis, basis, t.amount);
    }
  }

  const totalSpend = [...byCategory.values()].reduce((a, b) => a + b, 0);
  if (Math.abs(recurringTotal + onetimeTotal + eventMarketingTotal - totalSpend) > 0.01) {
    // Should be impossible by construction (every tx lands in exactly one
    // bucket above) -- a mismatch means the partition logic has a gap.
    console.warn(
      `computeSpendSummary: partition mismatch (recurring ${recurringTotal} + one-time ${onetimeTotal} + ` +
        `event/marketing ${eventMarketingTotal} != total ${totalSpend})`
    );
  }

  const sortDesc = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  const topCategories = sortDesc(byCategory);
  const topVendors = sortDesc(byVendor);
  const byEmployeeSorted = sortDesc(byEmployee);
  const monthsSorted = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  // Fixed display order (weekly -> monthly -> quarterly -> yearly), only
  // including rows that actually have spend, rather than sorting by
  // amount -- a cadence progression reads more naturally in that order
  // than shuffled by dollar size.
  const recurringByBasis = RECURRENCE_BASIS_LABELS.map(([key, label]) => [label, byRecurrenceBasis.get(key) || 0]).filter(
    ([, amount]) => amount > 0
  );

  // Spend by Kind: fixed/committed cost vs. variable/discretionary --
  // same fixed-order-not-sorted-by-size reasoning as recurringByBasis.
  const spendByKind = KIND_LABELS.map(([key, label]) => [label, byKind.get(key) || 0]).filter(([, amount]) => amount > 0);

  // Year-over-year by category. When a `year` was given, that's always
  // "current" and year-1 is always "previous" (the pair floats with
  // whatever's selected, per the dashboard's year selector); with no
  // `year` given (e.g. an all-time Reports view), fall back to the two
  // most recent years actually present in the data.
  let prevYear;
  let currYear;
  if (year) {
    currYear = String(year);
    prevYear = String(Number(year) - 1);
  } else {
    const years = [...new Set(allTxs.filter((t) => t.date).map((t) => t.date.slice(0, 4)))].sort();
    [prevYear, currYear] = years.slice(-2);
  }

  let yearOverYear = [];
  let noPriorYearData = false;
  if (prevYear && currYear) {
    const prevYearHasAnyData = allTxs.some((t) => t.date && t.date.slice(0, 4) === prevYear);
    noPriorYearData = !prevYearHasAnyData;

    const byCategoryYear = new Map();
    for (const t of allTxs) {
      if (!t.date) continue;
      const txYear = t.date.slice(0, 4);
      if (txYear !== prevYear && txYear !== currYear) continue;
      const catName = t.category ? t.category.name : 'Uncategorized';
      if (!byCategoryYear.has(catName)) byCategoryYear.set(catName, { [prevYear]: 0, [currYear]: 0 });
      byCategoryYear.get(catName)[txYear] += t.amount;
    }
    yearOverYear = [...byCategoryYear.entries()]
      .map(([name, totals]) => ({
        name,
        prev: totals[prevYear],
        curr: totals[currYear],
        change: totals[currYear] - totals[prevYear],
      }))
      .filter((row) => row.prev !== 0 || row.curr !== 0)
      .sort((a, b) => b.curr - a.curr);
  }

  return {
    totalSpend,
    onetimeTotal,
    recurringTotal,
    recurringByBasis,
    spendByKind,
    eventMarketingTotal,
    topCategories,
    topVendors,
    byEmployeeSorted,
    monthsSorted,
    yearOverYear,
    noPriorYearData,
    prevYear,
    currYear,
  };
}

// Spend by tag (the finer-grained label within a category -- see
// constants.js's ESTABLISHED_TAGS). Queried directly rather than derived
// from an already-hydrated txs array like computeSpendSummary: a
// transaction can carry more than one tag, so this has to join through
// transaction_tags rather than assume one row per transaction. `db` is
// passed in rather than required here to avoid a circular require (db.js
// doesn't depend on this file, but keeping the dependency direction
// explicit and matching how the rest of this module is called from routes
// that already have `db` in scope).
function computeSpendByTag(db, year) {
  const params = ['approved'];
  let yearClause = '';
  if (year) {
    const isCurrentYear = String(year) === String(new Date().getFullYear());
    const end = isCurrentYear ? todayISO() : `${year}-12-31`;
    yearClause = 'AND t.date >= ? AND t.date <= ?';
    params.push(`${year}-01-01`, end);
  }
  const rows = db
    .prepare(
      `SELECT c.name AS category, tg.name AS tag, SUM(t.amount) AS total
       FROM transaction_tags tt
       JOIN tags tg ON tg.id = tt.tag_id
       JOIN categories c ON c.id = tg.category_id
       JOIN transactions t ON t.id = tt.transaction_id
       WHERE t.status = ? ${yearClause}
       GROUP BY c.name, tg.name
       ORDER BY c.name, total DESC`
    )
    .all(...params);

  const byCategory = new Map();
  for (const r of rows) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push([r.tag, r.total]);
  }
  return byCategory;
}

module.exports = { TX_JOIN_SELECT, hydrate, computeSpendSummary, computeSpendByTag };
