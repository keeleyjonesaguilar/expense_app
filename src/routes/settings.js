const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db');
const { requireAuth, requireAdmin, flash } = require('../middleware/auth');
const { RECURRENCE_BASIS_OPTIONS, REQUIRABLE_FIELDS } = require('../constants');
const { typedConfirmMatches } = require('../lib/confirm');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const DEFAULT_INTRO = 'No login needed — fill this out and it goes straight to the approvals queue.';
const DEFAULT_EVENT_INTRO =
  'No login needed — request to attend a conference, speaking engagement, or other event/professional-development opportunity.';

// GET/POST /admin/settings -- General: company headcount + dashboard
// defaults, stored in the key/value `settings` table (see db.js's
// getSetting/setSetting).
router.get('/admin/settings', (req, res) => {
  res.render('settings_general', {
    title: 'Settings',
    headcount: db.getSetting('employee_count', ''),
    dashboard_year_default: db.getSetting('dashboard_year_default', 'current-year'),
  });
});

router.post('/admin/settings', (req, res) => {
  const headcount = (req.body.employee_count || '').trim();
  if (headcount && !/^\d+$/.test(headcount)) {
    flash(req, 'danger', 'Headcount must be a whole number.');
    return res.redirect('/admin/settings');
  }
  db.setSetting('employee_count', headcount);
  db.setSetting('dashboard_year_default', req.body.dashboard_year_default === 'most-recent' ? 'most-recent' : 'current-year');
  flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/settings');
});

// GET/POST /admin/settings/request-supplies -- editable intro text for the
// two modes of the public /request-supplies form (Office Supplies, and
// Event/Professional Development -- see src/routes/supplyRequest.js).
router.get('/admin/settings/request-supplies', (req, res) => {
  res.render('settings_request_supplies', {
    title: 'Settings — Request Supplies',
    request_form_intro: db.getSetting('request_form_intro', DEFAULT_INTRO),
    event_request_form_intro: db.getSetting('event_request_form_intro', DEFAULT_EVENT_INTRO),
  });
});

router.post('/admin/settings/request-supplies', (req, res) => {
  db.setSetting('request_form_intro', (req.body.request_form_intro || DEFAULT_INTRO).trim());
  db.setSetting('event_request_form_intro', (req.body.event_request_form_intro || DEFAULT_EVENT_INTRO).trim());
  flash(req, 'success', 'Request Supplies settings saved.');
  res.redirect('/admin/settings/request-supplies');
});

// GET/POST /admin/settings/required-fields -- which fields (beyond Date,
// always required) are mandatory on the employee submission form. Read by
// src/routes/expenses.js on every /submit GET and POST.
router.get('/admin/settings/required-fields', (req, res) => {
  let required = [];
  try {
    required = JSON.parse(db.getSetting('required_fields', '["amount","category"]'));
  } catch (err) {
    required = ['amount', 'category'];
  }
  res.render('settings_required_fields', {
    title: 'Settings — Required Fields',
    requirable_fields: REQUIRABLE_FIELDS,
    required,
  });
});

router.post('/admin/settings/required-fields', (req, res) => {
  const required = REQUIRABLE_FIELDS.filter((f) => req.body[f] !== undefined);
  db.setSetting('required_fields', JSON.stringify(required));
  flash(req, 'success', 'Required fields updated.');
  res.redirect('/admin/settings/required-fields');
});

// GET/POST /admin/settings/import-mapping -- view/edit the DB-backed
// column-alias matcher (see src/lib/extraction.js's loadColumnAliases()).
router.get('/admin/settings/import-mapping', (req, res) => {
  const rows = db.prepare('SELECT * FROM column_aliases ORDER BY field, alias').all();
  const byField = {};
  for (const r of rows) {
    if (!byField[r.field]) byField[r.field] = [];
    byField[r.field].push(r);
  }
  res.render('settings_import_mapping', {
    title: 'Settings — Import Mapping',
    by_field: byField,
    fields: Object.keys(byField).sort(),
  });
});

router.post('/admin/settings/import-mapping', (req, res) => {
  const field = (req.body.field || '').trim();
  const alias = (req.body.alias || '').trim().toLowerCase();
  if (!field || !alias) {
    flash(req, 'danger', 'Both a field and an alias are required.');
    return res.redirect('/admin/settings/import-mapping');
  }
  try {
    db.prepare('INSERT INTO column_aliases (field, alias) VALUES (?, ?)').run(field, alias);
    flash(req, 'success', `Added alias "${alias}" -> ${field}.`);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err.message)) {
      flash(req, 'danger', 'That alias already exists for this field.');
    } else {
      throw err;
    }
  }
  res.redirect('/admin/settings/import-mapping');
});

router.post('/admin/settings/import-mapping/:id/delete', (req, res) => {
  db.prepare('DELETE FROM column_aliases WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'Alias removed.');
  res.redirect('/admin/settings/import-mapping');
});

// GET/POST /admin/settings/users -- list + add login accounts. Deactivating
// blocks login without touching anything they've done; deleting is only
// allowed when they have no audit-trail history to orphan (see
// userHasHistory below) -- deactivate is the answer for anyone who's
// actually used the app.
router.get('/admin/settings/users', (req, res) => {
  res.render('settings_users', {
    title: 'Settings — Users',
    users: db.prepare('SELECT * FROM users ORDER BY active DESC, name').all(),
  });
});

router.post('/admin/settings/users', (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const department = (req.body.department || '').trim();
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  const password = req.body.password || '';

  if (!name || !email || password.length < 6) {
    flash(req, 'danger', 'Name, email, and a password of at least 6 characters are required.');
    return res.redirect('/admin/settings/users');
  }

  try {
    const info = db
      .prepare('INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, bcrypt.hashSync(password, 10), role, department);
    // Every login account also gets a linked Employee record right away, so
    // it shows up immediately in Settings -> Employees and can be attributed
    // spend/events without waiting for their first login.
    db.getOrCreateEmployeeForUser(info.lastInsertRowid);
    flash(req, 'success', `Added user: ${name}`);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err.message)) {
      flash(req, 'danger', 'That email is already in use.');
    } else {
      throw err;
    }
  }
  res.redirect('/admin/settings/users');
});

router.post('/admin/settings/users/:id/update', (req, res) => {
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  const department = (req.body.department || '').trim();
  db.prepare('UPDATE users SET role = ?, department = ? WHERE id = ?').run(role, department, req.params.id);
  flash(req, 'success', 'User updated.');
  res.redirect('/admin/settings/users');
});

function activeAdminCount() {
  return db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").get().n;
}

function userHasHistory(userId) {
  const counts = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM transactions WHERE submitted_by_id = ? OR approved_by_id = ?) AS tx,
        (SELECT COUNT(*) FROM uploads WHERE uploaded_by_id = ?) AS uploads,
        (SELECT COUNT(*) FROM marketing_events WHERE created_by_id = ?) AS events,
        (SELECT COUNT(*) FROM event_outcomes WHERE logged_by_id = ?) AS outcomes,
        (SELECT COUNT(*) FROM employee_returns WHERE logged_by_id = ?) AS returns_logged`
    )
    .get(userId, userId, userId, userId, userId, userId);
  return Object.values(counts).some((n) => n > 0);
}

router.post('/admin/settings/users/:id/deactivate', (req, res) => {
  if (!typedConfirmMatches(req, 'deactivate')) {
    flash(req, 'danger', 'Type DEACTIVATE exactly to confirm -- nothing was changed.');
    return res.redirect('/admin/settings/users');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).send('Not Found');
  if (user.role === 'admin' && user.active && activeAdminCount() <= 1) {
    flash(req, 'danger', "Can't deactivate the last active admin.");
    return res.redirect('/admin/settings/users');
  }
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id);
  flash(req, 'success', `Deactivated: ${user.name}. They can no longer log in.`);
  res.redirect('/admin/settings/users');
});

router.post('/admin/settings/users/:id/reactivate', (req, res) => {
  db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'User reactivated.');
  res.redirect('/admin/settings/users');
});

router.post('/admin/settings/users/:id/delete', (req, res) => {
  if (!typedConfirmMatches(req, 'delete')) {
    flash(req, 'danger', 'Type DELETE exactly to confirm -- nothing was deleted.');
    return res.redirect('/admin/settings/users');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).send('Not Found');
  if (user.role === 'admin' && activeAdminCount() <= 1 && user.active) {
    flash(req, 'danger', "Can't delete the last active admin.");
    return res.redirect('/admin/settings/users');
  }
  if (userHasHistory(user.id)) {
    flash(req, 'danger', `Can't delete ${user.name} -- they have submissions, approvals, or logged activity on record. Deactivate instead.`);
    return res.redirect('/admin/settings/users');
  }
  // Unlink (not delete) any Employee record tied to this login -- the
  // roster entry and whatever spend/events it's attributed to stays intact,
  // it just stops being anyone's login.
  db.prepare('UPDATE employees SET user_id = NULL WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  flash(req, 'success', `Deleted user: ${user.name}`);
  res.redirect('/admin/settings/users');
});

// GET/POST /admin/settings/employees -- the roster people get attributed
// spend/events/ROI against. Deliberately separate from Users (logins):
// most employees here never log into the app at all. Deactivating hides
// someone from "assign to" pickers elsewhere without touching their
// history; deleting is only allowed when they have none to orphan.
router.get('/admin/settings/employees', (req, res) => {
  const employees = db
    .prepare(
      `SELECT e.*, u.email AS user_email,
        (SELECT COUNT(*) FROM transactions WHERE employee_id = e.id) AS tx_count,
        (SELECT COUNT(*) FROM event_attendees WHERE employee_id = e.id) AS event_count,
        (SELECT COUNT(*) FROM employee_returns WHERE employee_id = e.id) AS return_count
       FROM employees e
       LEFT JOIN users u ON u.id = e.user_id
       ORDER BY e.active DESC, e.name`
    )
    .all();
  res.render('settings_employees', { title: 'Settings — Employees', employees });
});

router.post('/admin/settings/employees', (req, res) => {
  const name = (req.body.name || '').trim();
  const department = (req.body.department || '').trim();
  if (!name) {
    flash(req, 'danger', 'Name is required.');
    return res.redirect('/admin/settings/employees');
  }
  db.prepare('INSERT INTO employees (name, department, active) VALUES (?, ?, 1)').run(name, department);
  flash(req, 'success', `Added employee: ${name}`);
  res.redirect('/admin/settings/employees');
});

router.post('/admin/settings/employees/:id/update', (req, res) => {
  const name = (req.body.name || '').trim();
  const department = (req.body.department || '').trim();
  if (!name) {
    flash(req, 'danger', 'Name is required.');
    return res.redirect('/admin/settings/employees');
  }
  db.prepare('UPDATE employees SET name = ?, department = ? WHERE id = ?').run(name, department, req.params.id);
  flash(req, 'success', 'Employee updated.');
  res.redirect('/admin/settings/employees');
});

router.post('/admin/settings/employees/:id/deactivate', (req, res) => {
  if (!typedConfirmMatches(req, 'deactivate')) {
    flash(req, 'danger', 'Type DEACTIVATE exactly to confirm -- nothing was changed.');
    return res.redirect('/admin/settings/employees');
  }
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'Employee deactivated -- hidden from new assignments, history untouched.');
  res.redirect('/admin/settings/employees');
});

router.post('/admin/settings/employees/:id/reactivate', (req, res) => {
  db.prepare('UPDATE employees SET active = 1 WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'Employee reactivated.');
  res.redirect('/admin/settings/employees');
});

router.post('/admin/settings/employees/:id/delete', (req, res) => {
  if (!typedConfirmMatches(req, 'delete')) {
    flash(req, 'danger', 'Type DELETE exactly to confirm -- nothing was deleted.');
    return res.redirect('/admin/settings/employees');
  }
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).send('Not Found');
  const inUse = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM transactions WHERE employee_id = ?) +
        (SELECT COUNT(*) FROM event_attendees WHERE employee_id = ?) +
        (SELECT COUNT(*) FROM employee_returns WHERE employee_id = ?) AS n`
    )
    .get(employee.id, employee.id, employee.id).n;
  if (inUse > 0) {
    flash(req, 'danger', `Can't delete ${employee.name} -- they have spend, event attendance, or logged returns on record. Deactivate instead.`);
    return res.redirect('/admin/settings/employees');
  }
  if (employee.user_id) {
    flash(req, 'danger', `Can't delete ${employee.name} -- they're linked to a login account. Remove the login first, or deactivate instead.`);
    return res.redirect('/admin/settings/employees');
  }
  db.prepare('DELETE FROM employees WHERE id = ?').run(employee.id);
  flash(req, 'success', `Deleted employee: ${employee.name}`);
  res.redirect('/admin/settings/employees');
});

// GET /admin/settings/categories -- the 4 main categories (name/kind/cadence
// editable, but the set itself is deliberately closed -- see constants.js)
// plus tag management within them. prefill_tag_name/prefill_category
// (optional query params) pre-fill the Add Tag form -- used by the AI
// receipt-classification "Create it" links (bulk import review / expense
// submission) when it proposes a tag that doesn't exist yet.
router.get('/admin/settings/categories', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  const tags = db
    .prepare(
      `SELECT tags.*, c.name AS category_name,
        (SELECT COUNT(*) FROM transaction_tags WHERE tag_id = tags.id) AS tx_count
       FROM tags JOIN categories c ON c.id = tags.category_id
       ORDER BY c.name, tags.name`
    )
    .all();
  res.render('settings_categories', {
    title: 'Settings — Categories',
    categories,
    tags,
    recurrence_options: RECURRENCE_BASIS_OPTIONS,
    prefill_tag_name: req.query.prefill_tag_name || '',
    prefill_category: req.query.prefill_category || '',
  });
});

router.post('/admin/settings/categories/:id/update', (req, res) => {
  // Name is deliberately NOT editable here -- the 4 category names are
  // referenced by name throughout the AI classifier's prompts and the
  // Marketing & ROI event-type mapping; only kind/cadence can be tuned.
  const kind = req.body.kind || 'semi-variable';
  const recurrenceBasis = req.body.recurrence_basis || 'recurring-monthly';
  db.prepare('UPDATE categories SET kind = ?, recurrence_basis = ? WHERE id = ?').run(
    kind,
    recurrenceBasis,
    req.params.id
  );
  flash(req, 'success', 'Category updated.');
  res.redirect('/admin/settings/categories');
});

// POST /admin/settings/tags -- add a tag within one of the 4 categories.
router.post('/admin/settings/tags', (req, res) => {
  const name = (req.body.name || '').trim();
  const categoryId = parseInt(req.body.category_id, 10);
  if (!name || !categoryId) {
    flash(req, 'danger', 'Tag name and category are required.');
    return res.redirect('/admin/settings/categories');
  }
  try {
    db.prepare('INSERT INTO tags (name, category_id) VALUES (?, ?)').run(name, categoryId);
    flash(req, 'success', `Added tag: ${name}`);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err.message)) {
      flash(req, 'danger', 'That tag already exists.');
    } else {
      throw err;
    }
  }
  res.redirect('/admin/settings/categories');
});

router.post('/admin/settings/tags/:id/update', (req, res) => {
  const name = (req.body.name || '').trim();
  const categoryId = parseInt(req.body.category_id, 10);
  if (!name || !categoryId) {
    flash(req, 'danger', 'Tag name and category are required.');
    return res.redirect('/admin/settings/categories');
  }
  try {
    db.prepare('UPDATE tags SET name = ?, category_id = ? WHERE id = ?').run(name, categoryId, req.params.id);
    flash(req, 'success', 'Tag updated.');
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err.message)) {
      flash(req, 'danger', 'Another tag already has that name.');
    } else {
      throw err;
    }
  }
  res.redirect('/admin/settings/categories');
});

// POST /admin/settings/tags/:id/delete -- only when nothing uses it, so a
// tag actively describing real spend can't be silently removed out from
// under the transactions that rely on it for reporting.
router.post('/admin/settings/tags/:id/delete', (req, res) => {
  if (!typedConfirmMatches(req, 'delete')) {
    flash(req, 'danger', 'Type DELETE exactly to confirm -- nothing was deleted.');
    return res.redirect('/admin/settings/categories');
  }
  const inUse = db.prepare('SELECT COUNT(*) n FROM transaction_tags WHERE tag_id = ?').get(req.params.id).n;
  if (inUse > 0) {
    flash(req, 'danger', `Can't delete -- ${inUse} transaction(s) use this tag.`);
    return res.redirect('/admin/settings/categories');
  }
  db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'Tag deleted.');
  res.redirect('/admin/settings/categories');
});

// GET/POST /admin/settings/vendors -- list + add + inline-edit vendors.
router.get('/admin/settings/vendors', (req, res) => {
  res.render('settings_vendors', {
    title: 'Settings — Vendors',
    vendors: db.prepare('SELECT * FROM vendors ORDER BY name').all(),
  });
});

router.post('/admin/settings/vendors', (req, res) => {
  const name = (req.body.name || '').trim();
  const notes = (req.body.notes || '').trim();
  if (!name) {
    flash(req, 'danger', 'Vendor name is required.');
    return res.redirect('/admin/settings/vendors');
  }
  try {
    db.prepare('INSERT INTO vendors (name, notes) VALUES (?, ?)').run(name, notes);
    flash(req, 'success', `Added vendor: ${name}`);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err.message)) {
      flash(req, 'danger', 'That vendor already exists.');
    } else {
      throw err;
    }
  }
  res.redirect('/admin/settings/vendors');
});

router.post('/admin/settings/vendors/:id/update', (req, res) => {
  const name = (req.body.name || '').trim();
  const notes = (req.body.notes || '').trim();
  if (!name) {
    flash(req, 'danger', 'Vendor name is required.');
    return res.redirect('/admin/settings/vendors');
  }
  try {
    db.prepare('UPDATE vendors SET name = ?, notes = ? WHERE id = ?').run(name, notes, req.params.id);
    flash(req, 'success', 'Vendor updated.');
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err.message)) {
      flash(req, 'danger', 'Another vendor already has that name.');
    } else {
      throw err;
    }
  }
  res.redirect('/admin/settings/vendors');
});

// GET /admin/settings/danger-zone -- on its own tab, away from routine
// settings, so "type DELETE to confirm" isn't just a red border away from
// the headcount field someone's scrolling past.
router.get('/admin/settings/danger-zone', (req, res) => {
  res.render('settings_danger_zone', { title: 'Settings — Danger Zone' });
});

// POST /admin/settings/reset-transactions -- deletes every row from
// transactions (the full ledger: approved/pending/awaiting-order/rejected,
// manual entries, expense reports, bulk imports, supply requests -- all of
// it), but leaves categories/vendors/users/settings untouched. Requires
// typing the literal word DELETE as a confirmation, since there's no undo.
router.post('/admin/settings/reset-transactions', (req, res) => {
  if (!typedConfirmMatches(req, 'delete')) {
    flash(req, 'danger', 'Type DELETE exactly to confirm -- nothing was deleted.');
    return res.redirect('/admin/settings/danger-zone');
  }
  const info = db.prepare('DELETE FROM transactions').run();
  flash(req, 'success', `Deleted ${info.changes} transaction(s). Categories, vendors, and users were left alone.`);
  res.redirect('/admin/settings/danger-zone');
});

module.exports = router;
