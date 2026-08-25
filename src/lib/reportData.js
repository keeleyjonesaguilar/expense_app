// Shared transaction-summary logic used by both the admin dashboard and the
// Reports page, so the two don't drift out of sync with two copies of the
// same category/vendor/month/year-over-year math.

const TX_JOIN_SELECT = `
  SELECT t.*,
         c.name AS category_name,
         v.name AS vendor_name,
         emp.name AS employee_name,
         sub.name AS submitted_by_name
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN vendors v ON v.id = t.vendor_id
  LEFT JOIN users emp ON emp.id = t.employee_id
  LEFT JOIN users sub ON sub.id = t.submitted_by_id
`;

function hydrate(t) {
  return {
    ...t,
    category: t.category_name ? { name: t.category_name } : null,
    vendor: t.vendor_name ? { name: t.vendor_name } : null,
    employee: t.employee_name ? { name: t.employee_name } : null,
    submitted_by: t.submitted_by_name ? { name: t.submitted_by_name } : null,
  };
}

// Categories pulled out of the Recurring/One-Time split entirely (see
// partitionSpend below) since they're tracked as their own bucket.
const EVENT_MARKETING_CATEGORIES = new Set(['Events', 'Catering']);

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

    // Event/Marketing (Events, Catering) is pulled out first and is
    // mutually exclusive with Recurring/One-Time by construction -- every
    // other transaction falls into exactly one of those two based on
    // is_one_time. The three buckets always sum to totalSpend.
    if (EVENT_MARKETING_CATEGORIES.has(catName)) {
      eventMarketingTotal += t.amount;
    } else if (t.is_one_time) {
      onetimeTotal += t.amount;
    } else {
      recurringTotal += t.amount;
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

module.exports = { TX_JOIN_SELECT, hydrate, computeSpendSummary };
