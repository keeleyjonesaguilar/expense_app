const express = require('express');

const db = require('../db');
const { flash } = require('../middleware/auth');
const { STATUS_PENDING, SOURCE_SUPPLY_REQUEST } = require('../constants');
const { toISODate } = require('../lib/util');

const router = express.Router();

const listCategories = db.prepare('SELECT * FROM categories ORDER BY name');
const listTags = db.prepare('SELECT id, name, category_id FROM tags ORDER BY name');
const insertRequest = db.prepare(`
  INSERT INTO transactions
    (date, amount, description, notes, link, quantity, category_id, is_one_time, source, status)
  VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const linkRequestTag = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)');

// GET/POST /request-supplies -- a public, no-login form for two related use
// cases that used to go through separate Google Forms: everyday office
// supplies, and event/professional-development requests (a conference, a
// speaking engagement, a networking coffee -- anything Business Development
// or Professional Development). A "request type" toggle at the top of the
// form switches which fields show; both submit to the same handler below,
// distinguished by which category the request lands in. No authentication
// gate: the link itself is the access control (shared directly with
// employees), same trust model as the forms they replace. Submissions land
// in the same Approvals queue as expense reports, with amount defaulted to
// 0 since nothing's been spent yet -- an admin fills in the real cost when
// they approve/fulfill it from the Transactions page.
const DEFAULT_INTRO = 'No login needed — fill this out and it goes straight to the approvals queue.';
const DEFAULT_EVENT_INTRO =
  'No login needed — request to attend a conference, speaking engagement, or other event/professional-development opportunity.';

// The two categories a "type: event" request is allowed to land in. Office
// Expenses is the only category "type: supplies" is allowed to use.
const EVENT_CATEGORY_NAMES = ['Business Development', 'Professional Development'];

function loadFormData() {
  const categories = listCategories.all();
  return {
    officeCategory: categories.find((c) => c.name === 'Office Expenses') || null,
    eventCategories: categories.filter((c) => EVENT_CATEGORY_NAMES.includes(c.name)),
    tags: listTags.all(),
  };
}

function renderForm(res, extra) {
  const { officeCategory, eventCategories, tags } = loadFormData();
  res.render('request_supplies', {
    title: 'Request Supplies',
    office_category: officeCategory,
    event_categories: eventCategories,
    tags,
    submitted: false,
    intro_text: db.getSetting('request_form_intro', DEFAULT_INTRO),
    event_intro_text: db.getSetting('event_request_form_intro', DEFAULT_EVENT_INTRO),
    ...extra,
  });
}

router.get('/request-supplies', (req, res) => {
  renderForm(res, { submitted: req.query.submitted === '1' });
});

router.post('/request-supplies', (req, res) => {
  const { officeCategory, eventCategories, tags } = loadFormData();
  const requestType = req.body.request_type === 'event' ? 'event' : 'supplies';
  const requesterName = (req.body.requester_name || '').trim();
  const department = (req.body.department || '').trim();
  const item = (req.body.item || '').trim();
  const quantity =
    req.body.quantity !== undefined && req.body.quantity !== '' ? parseFloat(req.body.quantity) : null;
  const justification = (req.body.justification || '').trim();
  const link = (req.body.link || '').trim() || null;
  const eventDate = (req.body.event_date || '').trim();
  const tagIds = []
    .concat(req.body.tag_id || [])
    .map((v) => parseInt(v, 10))
    .filter((id) => tags.some((t) => t.id === id));

  let categoryId = null;
  if (requestType === 'event') {
    const requested = parseInt(req.body.category_id, 10);
    if (eventCategories.some((c) => c.id === requested)) categoryId = requested;
  } else {
    categoryId = officeCategory ? officeCategory.id : null;
  }
  // A request can only ever carry tags from its own category -- silently
  // drop anything else rather than trust the client's toggle state.
  const validTagIds = tagIds.filter((id) => tags.find((t) => t.id === id).category_id === categoryId);
  // Events are effectively always one-off costs -- the supplies side keeps
  // the explicit checkbox since recurring supply needs (e.g. a standing
  // order of paper) are common.
  const isOneTime = requestType === 'event' ? 1 : req.body.is_one_time !== undefined ? 1 : 0;

  const errors = [];
  if (!requesterName) errors.push('Please enter your name.');
  if (!item) {
    errors.push(requestType === 'event' ? 'Please name the event or program.' : 'Please describe what you need.');
  }
  if (!categoryId) errors.push(requestType === 'event' ? 'Please choose Business Development or Professional Development.' : 'Please choose a category.');

  if (errors.length) {
    for (const e of errors) flash(req, 'danger', e);
    return renderForm(res, { submitted: false });
  }

  const noteParts = [`Requested by: ${requesterName}${department ? ` (${department})` : ''}`];
  if (requestType === 'event' && eventDate) noteParts.push(`Needed by: ${eventDate}`);
  if (justification) noteParts.push(justification);

  const info = insertRequest.run(
    toISODate(new Date()),
    item.slice(0, 500),
    noteParts.join(' | ').slice(0, 500),
    link,
    Number.isFinite(quantity) ? quantity : null,
    categoryId,
    isOneTime,
    SOURCE_SUPPLY_REQUEST,
    STATUS_PENDING
  );

  for (const tagId of validTagIds) linkRequestTag.run(info.lastInsertRowid, tagId);

  res.redirect('/request-supplies?submitted=1');
});

module.exports = router;
