const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { STATUS_APPROVED } = require('../constants');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const listCategories = db.prepare('SELECT * FROM categories ORDER BY name');

// GET /admin/forecast -- ported from app.py's forecast().
router.get('/admin/forecast', (req, res) => {
  const growthFactor = req.query.growth_factor !== undefined ? parseFloat(req.query.growth_factor) : 1.0;
  const growth = Number.isFinite(growthFactor) ? growthFactor : 1.0;

  const txs = db
    .prepare(
      `SELECT t.*, c.name AS category_name, c.kind AS category_kind
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.status = ?`
    )
    .all(STATUS_APPROVED);

  const byCatYear = new Map(); // catName -> Map(year -> total)
  const yearsSeen = new Set();

  for (const t of txs) {
    if (!t.date || !t.category_name) continue;
    const year = parseInt(t.date.slice(0, 4), 10);
    yearsSeen.add(year);
    if (t.is_one_time) continue;
    if (!byCatYear.has(t.category_name)) byCatYear.set(t.category_name, new Map());
    const yearMap = byCatYear.get(t.category_name);
    yearMap.set(year, (yearMap.get(year) || 0) + t.amount);
  }

  const currentYear = yearsSeen.size ? Math.max(...yearsSeen) : new Date().getFullYear();
  const priorYear = currentYear - 1;
  const jan1 = Date.UTC(currentYear, 0, 1);
  const now = new Date();
  const today =
    now.getUTCFullYear() === currentYear ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) : Date.UTC(currentYear, 11, 31);
  const elapsedDays = Math.max(Math.round((today - jan1) / 86400000) + 1, 1);
  const elapsedMonths = elapsedDays / 30.44;

  const forecastRows = [];
  for (const cat of listCategories.all()) {
    const yearMap = byCatYear.get(cat.name) || new Map();
    const prior = yearMap.get(priorYear) || 0;
    const ytd = yearMap.get(currentYear) || 0;
    const methodA = prior * growth;
    const methodB = ytd ? (ytd / elapsedMonths) * 12 : 0;

    let rec;
    let basis;
    if (cat.kind === 'one-time-growth') {
      const onetimeThisYear = txs
        .filter((t) => t.category_id === cat.id && t.is_one_time && t.date && parseInt(t.date.slice(0, 4), 10) === currentYear)
        .reduce((sum, t) => sum + t.amount, 0);
      rec = round2(Math.max(onetimeThisYear * 0.1, prior * 0.15));
      basis = "One-time/growth category: 10% of this year's one-time spend, floored at 15% of prior year actual.";
    } else {
      rec = round2(Math.max(methodA, methodB));
      basis = `max(prior x ${growth}, YTD annualized)`;
    }

    forecastRows.push({
      category: cat.name,
      prior_year: priorYear,
      prior_total: round2(prior),
      current_year: currentYear,
      ytd_total: round2(ytd),
      method_a: round2(methodA),
      method_b: round2(methodB),
      recommended_annual: rec,
      recommended_monthly: round2(rec / 12),
      basis,
    });
  }

  forecastRows.sort((a, b) => b.recommended_annual - a.recommended_annual);
  const totalAnnual = round2(forecastRows.reduce((sum, r) => sum + r.recommended_annual, 0));

  res.render('forecast', {
    title: 'Forecast',
    rows: forecastRows,
    growth_factor: growth,
    total_annual: totalAnnual,
    current_year: currentYear,
    prior_year: priorYear,
  });
});

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = router;
