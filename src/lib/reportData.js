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

// txs: already-hydrated approved transactions (see hydrate() above).
function computeSpendSummary(txs) {
  const byCategory = new Map();
  const byEmployee = new Map();
  const byVendor = new Map();
  const byMonth = new Map();
  let onetimeTotal = 0;
  let recurringTotal = 0;

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
    if (t.is_one_time) onetimeTotal += t.amount;
    else recurringTotal += t.amount;
  }

  const totalSpend = [...byCategory.values()].reduce((a, b) => a + b, 0);
  const sortDesc = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  const topCategories = sortDesc(byCategory);
  const topVendors = sortDesc(byVendor);
  const byEmployeeSorted = sortDesc(byEmployee);
  const monthsSorted = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  // Year-over-year by category, mirroring the "Year vs. Year" sheet from the
  // spreadsheet this app's data model was based on: for the two most recent
  // years present in the data, total spend per category side by side with
  // the year-over-year change.
  const years = [...new Set(txs.filter((t) => t.date).map((t) => t.date.slice(0, 4)))].sort();
  const [prevYear, currYear] = years.slice(-2);
  let yearOverYear = [];
  if (prevYear && currYear) {
    const byCategoryYear = new Map();
    for (const t of txs) {
      if (!t.date) continue;
      const year = t.date.slice(0, 4);
      if (year !== prevYear && year !== currYear) continue;
      const catName = t.category ? t.category.name : 'Uncategorized';
      if (!byCategoryYear.has(catName)) byCategoryYear.set(catName, { [prevYear]: 0, [currYear]: 0 });
      byCategoryYear.get(catName)[year] += t.amount;
    }
    yearOverYear = [...byCategoryYear.entries()]
      .map(([name, totals]) => ({
        name,
        prev: totals[prevYear],
        curr: totals[currYear],
        change: totals[currYear] - totals[prevYear],
      }))
      .sort((a, b) => b.curr - a.curr);
  }

  return {
    totalSpend,
    onetimeTotal,
    recurringTotal,
    topCategories,
    topVendors,
    byEmployeeSorted,
    monthsSorted,
    yearOverYear,
    prevYear,
    currYear,
  };
}

module.exports = { TX_JOIN_SELECT, hydrate, computeSpendSummary };
