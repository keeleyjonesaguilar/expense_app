// Needs Review queue: transactions flagged with a review_reason (see db.js)
// -- e.g. an imported row that didn't match any category. The nav's Review
// bell shows the count (res.locals.reviewCount, set in server.js) and links
// here. Each item can be fixed (category + tags) and cleared, or just
// dismissed as-is; the same two actions work in bulk on a selection.
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin, flash } = require('../middleware/auth');
const { TX_JOIN_SELECT, hydrate } = require('../lib/reportData');
const { attachTags } = require('../lib/txTags');

const router = express.Router();
// Scoped to this router's own paths -- an unscoped router.use() would gate
// every request passing through it, including routers mounted after it.
router.use('/admin/review', requireAuth, requireAdmin);

const listCategories = db.prepare('SELECT * FROM categories ORDER BY name');
const listTags = db.prepare(
  'SELECT tags.id, tags.name, tags.category_id, c.name AS category_name FROM tags JOIN categories c ON c.id = tags.category_id ORDER BY c.name, tags.name'
);
const listReasons = db.prepare(
  'SELECT review_reason AS reason, COUNT(*) AS n FROM transactions WHERE review_reason IS NOT NULL GROUP BY review_reason ORDER BY n DESC, review_reason'
);
const getTx = db.prepare('SELECT * FROM transactions WHERE id = ? AND review_reason IS NOT NULL');
const findTagInCategory = db.prepare('SELECT id FROM tags WHERE name = ? AND category_id = ?');
const clearTags = db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ?');
const linkTag = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)');
const setCategoryAndClear = db.prepare('UPDATE transactions SET category_id = ?, review_reason = NULL WHERE id = ?');
const clearReview = db.prepare('UPDATE transactions SET review_reason = NULL WHERE id = ?');

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

// Only same-origin relative paths back into the queue -- never an arbitrary
// redirect target from the form body.
function safeNext(req) {
  const next = req.body.next || '';
  return next.startsWith('/admin/review') ? next : '/admin/review';
}

// "save": set the category, replace the tags with the chosen ones (only
// tags that belong to that category), and clear the flag. "dismiss": clear
// the flag and change nothing else.
function resolve(txId, action, categoryId, tagNames) {
  if (action === 'dismiss') {
    clearReview.run(txId);
    return;
  }
  setCategoryAndClear.run(categoryId, txId);
  clearTags.run(txId);
  for (const name of tagNames) {
    const tag = findTagInCategory.get(name, categoryId);
    if (tag) linkTag.run(txId, tag.id);
  }
}

// GET /admin/review[?reason=...]
router.get('/admin/review', (req, res) => {
  const reason = req.query.reason || '';
  const txs = db
    .prepare(
      `${TX_JOIN_SELECT} WHERE t.review_reason IS NOT NULL ${reason ? 'AND t.review_reason = ?' : ''} ORDER BY t.date DESC, t.id DESC`
    )
    .all(...(reason ? [reason] : []))
    .map(hydrate);
  attachTags(txs);

  const reasons = listReasons.all();
  // Just cleared the last item under this filter -- back to the full queue
  // rather than an empty filtered page.
  if (reason && !txs.length && reasons.length) return res.redirect('/admin/review');
  res.render('review', {
    title: 'Needs Review',
    txs,
    reasons,
    total: reasons.reduce((s, r) => s + r.n, 0),
    reason,
    categories: listCategories.all(),
    tags: listTags.all(),
    currentUrl: req.originalUrl,
  });
});

// POST /admin/review/bulk -- same save/dismiss, applied to every checked row.
router.post('/admin/review/bulk', (req, res) => {
  const action = req.body.action === 'dismiss' ? 'dismiss' : 'save';
  const ids = asArray(req.body.ids).map((id) => parseInt(id, 10)).filter(Number.isFinite);
  const categoryId = parseInt(req.body.category_id, 10);
  if (!ids.length) {
    flash(req, 'warning', 'Select at least one item first.');
    return res.redirect(safeNext(req));
  }
  if (action === 'save' && !categoryId) {
    flash(req, 'warning', 'Choose a category to apply to the selected items.');
    return res.redirect(safeNext(req));
  }
  const tagNames = asArray(req.body.tag);
  let done = 0;
  db.transaction(() => {
    for (const id of ids) {
      if (!getTx.get(id)) continue;
      resolve(id, action, categoryId, tagNames);
      done += 1;
    }
  })();
  flash(req, 'success', `${action === 'dismiss' ? 'Dismissed' : 'Updated and cleared'} ${done} item(s).`);
  res.redirect(safeNext(req));
});

// POST /admin/review/:id -- one row.
router.post('/admin/review/:id', (req, res) => {
  const tx = getTx.get(req.params.id);
  if (!tx) {
    flash(req, 'info', 'That item was already resolved.');
    return res.redirect(safeNext(req));
  }
  const action = req.body.action === 'dismiss' ? 'dismiss' : 'save';
  const categoryId = parseInt(req.body.category_id, 10);
  if (action === 'save' && !categoryId) {
    flash(req, 'warning', 'Choose a category before saving.');
    return res.redirect(safeNext(req));
  }
  db.transaction(() => resolve(tx.id, action, categoryId, asArray(req.body.tag)))();
  const label = tx.description ? (tx.description.length > 60 ? `${tx.description.slice(0, 60)}…` : tx.description) : `#${tx.id}`;
  flash(req, 'success', `${action === 'dismiss' ? 'Dismissed' : 'Saved and cleared'}: ${label}`);
  res.redirect(safeNext(req));
});

module.exports = router;
