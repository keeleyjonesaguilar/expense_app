const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { STATUS_APPROVED, STATUS_PENDING, STATUS_AWAITING_ORDER } = require('../constants');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const listCategories = db.prepare('SELECT * FROM categories ORDER BY name');

// GET /admin/forecast -- ported from app.py's forecast(), then revised:
// the original "YTD annualized" signal (methodB) badly overshoots early in
// a calendar year (e.g. in February, "annualize 1 month of data" is wild),
// so it's replaced with a rolling trailing-12-months actual total, which is
// already a 12-month figure and needs no annualizing multiply. A separate
// "Pipeline" figure (pending + awaiting-order spend in that category) is
// shown alongside the recommendation rather than folded into it, so
// approving/ordering a request later doesn't double-count it.
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

  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const trailing12moStartIso = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10);

  const currentYear = now.getUTCFullYear();
  const priorYear = currentYear - 1;

  const byCatPriorYear = new Map(); // catName -> prior calendar year total (non-one-time)
  const byCatTrailing12mo = new Map(); // catName -> trailing-365-day total (non-one-time)

  for (const t of txs) {
    if (!t.date || !t.category_name || t.is_one_time) continue;
    if (t.date >= trailing12moStartIso && t.date <= todayIso) {
      byCatTrailing12mo.set(t.category_name, (byCatTrailing12mo.get(t.category_name) || 0) + t.amount);
    }
    const year = parseInt(t.date.slice(0, 4), 10);
    if (year === priorYear) {
      byCatPriorYear.set(t.category_name, (byCatPriorYear.get(t.category_name) || 0) + t.amount);
    }
  }

  const pipelineByCategoryId = new Map();
  for (const row of db
    .prepare('SELECT category_id, SUM(amount) AS total FROM transactions WHERE status IN (?, ?) GROUP BY category_id')
    .all(STATUS_PENDING, STATUS_AWAITING_ORDER)) {
    if (row.category_id != null) pipelineByCategoryId.set(row.category_id, row.total);
  }

  const forecastRows = [];
  for (const cat of listCategories.all()) {
    const prior = byCatPriorYear.get(cat.name) || 0;
    const trailing12mo = byCatTrailing12mo.get(cat.name) || 0;
    const methodA = prior * growth;
    const methodB = trailing12mo;
    const pipeline = pipelineByCategoryId.get(cat.id) || 0;

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
      basis = `max(prior year x ${growth}, trailing 12mo actual)`;
    }

    forecastRows.push({
      category: cat.name,
      prior_year: priorYear,
      prior_total: round2(prior),
      trailing12mo_total: round2(trailing12mo),
      method_a: round2(methodA),
      method_b: round2(methodB),
      pipeline: round2(pipeline),
      recommended_annual: rec,
      recommended_monthly: round2(rec / 12),
      basis,
    });
  }

  forecastRows.sort((a, b) => b.recommended_annual - a.recommended_annual);
  const totalAnnual = round2(forecastRows.reduce((sum, r) => sum + r.recommended_annual, 0));
  const totalPipeline = round2(forecastRows.reduce((sum, r) => sum + r.pipeline, 0));

  res.render('forecast', {
    title: 'Forecast',
    rows: forecastRows,
    growth_factor: growth,
    total_annual: totalAnnual,
    total_pipeline: totalPipeline,
    current_year: currentYear,
    prior_year: priorYear,
  });
});

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = router;
