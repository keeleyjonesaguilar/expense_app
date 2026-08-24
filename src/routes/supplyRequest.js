const express = require('express');

const db = require('../db');
const { flash } = require('../middleware/auth');
const { STATUS_PENDING, SOURCE_SUPPLY_REQUEST } = require('../constants');
const { toISODate } = require('../lib/util');

const router = express.Router();

const listCategories = db.prepare('SELECT * FROM categories ORDER BY name');
const insertRequest = db.prepare(`
  INSERT INTO transactions
    (date, amount, description, notes, link, quantity, category_id, is_one_time, source, status)
  VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// GET/POST /request-supplies -- a public, no-login form for the supply
// request use case that used to go through a separate Google Form. No
// authentication gate: the link itself is the access control (shared
// directly with employees), same trust model as the form it replaces.
// Submissions land in the same Approvals queue as expense reports, with
// amount defaulted to 0 since the item hasn't been purchased yet -- an
// admin fills in the real cost when they approve it (or fulfill it) from
// the Transactions page.
const DEFAULT_INTRO = "No login needed — fill this out and it goes straight to the approvals queue.";

router.get('/request-supplies', (req, res) => {
  res.render('request_supplies', {
    title: 'Request Supplies',
    categories: listCategories.all(),
    submitted: req.query.submitted === '1',
    intro_text: db.getSetting('request_form_intro', DEFAULT_INTRO),
  });
});

router.post('/request-supplies', (req, res) => {
  const categories = listCategories.all();
  const requesterName = (req.body.requester_name || '').trim();
  const department = (req.body.department || '').trim();
  const item = (req.body.item || '').trim();
  const categoryId = req.body.category_id;
  const quantity = req.body.quantity !== undefined && req.body.quantity !== '' ? parseFloat(req.body.quantity) : null;
  const justification = (req.body.justification || '').trim();
  const link = (req.body.link || '').trim() || null;
  const isOneTime = req.body.is_one_time !== undefined ? 1 : 0;

  const errors = [];
  if (!requesterName) errors.push('Please enter your name.');
  if (!item) errors.push('Please describe what you need.');
  if (!categoryId) errors.push('Please choose a category.');

  if (errors.length) {
    for (const e of errors) flash(req, 'danger', e);
    return res.render('request_supplies', {
      title: 'Request Supplies',
      categories,
      submitted: false,
      intro_text: db.getSetting('request_form_intro', DEFAULT_INTRO),
    });
  }

  const noteParts = [`Requested by: ${requesterName}${department ? ` (${department})` : ''}`];
  if (justification) noteParts.push(justification);

  insertRequest.run(
    toISODate(new Date()),
    item.slice(0, 500),
    noteParts.join(' | ').slice(0, 500),
    link,
    Number.isFinite(quantity) ? quantity : null,
    parseInt(categoryId, 10),
    isOneTime,
    SOURCE_SUPPLY_REQUEST,
    STATUS_PENDING
  );

  res.redirect('/request-supplies?submitted=1');
});

module.exports = router;
