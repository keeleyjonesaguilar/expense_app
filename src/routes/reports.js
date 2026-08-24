const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { STATUS_APPROVED } = require('../constants');
const { TX_JOIN_SELECT, hydrate, computeSpendSummary } = require('../lib/reportData');
const { toCsv } = require('../lib/csv');

const router = express.Router();
router.use(requireAuth, requireAdmin);

function loadSummary() {
  const txs = db.prepare(`${TX_JOIN_SELECT} WHERE t.status = ?`).all(STATUS_APPROVED).map(hydrate);
  return computeSpendSummary(txs);
}

// GET /admin/reports -- a presentation-styled, printable summary page:
// total spend, category breakdown, year-over-year, and top vendors. Reuses
// the exact same numbers as the dashboard (via computeSpendSummary) so the
// two never disagree.
router.get('/admin/reports', (req, res) => {
  const summary = loadSummary();
  res.render('reports', {
    title: 'Reports',
    total_spend: summary.totalSpend,
    onetime_total: summary.onetimeTotal,
    recurring_total: summary.recurringTotal,
    top_categories: summary.topCategories,
    top_vendors: summary.topVendors.slice(0, 10),
    year_over_year: summary.yearOverYear,
    prev_year: summary.prevYear,
    curr_year: summary.currYear,
    generated_at: new Date().toISOString().slice(0, 10),
  });
});

// GET /admin/reports/export.csv -- the category-breakdown table as CSV.
router.get('/admin/reports/export.csv', (req, res) => {
  const summary = loadSummary();
  const header = ['Category', 'Total Spend'];
  const rows = summary.topCategories.map(([name, total]) => [name, total]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="report-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv([header, ...rows]));
});

module.exports = router;
