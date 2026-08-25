const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db');
const { requireAuth, requireAdmin, flash } = require('../middleware/auth');
const { RECURRENCE_BASIS_OPTIONS, REQUIRABLE_FIELDS } = require('../constants');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const DEFAULT_INTRO = 'No login needed — fill this out and it goes straight to the approvals queue.';

// GET/POST /admin/settings -- General: company headcount + the supply
// request form's editable intro text, both stored in the key/value
// `settings` table (see db.js's getSetting/setSetting).
router.get('/admin/settings', (req, res) => {
  res.render('settings_general', {
    title: 'Settings',
    headcount: db.getSetting('employee_count', ''),
    request_form_intro: db.getSetting('request_form_intro', DEFAULT_INTRO),
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
  db.setSetting('request_form_intro', (req.body.request_form_intro || DEFAULT_INTRO).trim());
  db.setSetting('dashboard_year_default', req.body.dashboard_year_default === 'most-recent' ? 'most-recent' : 'current-year');
  flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/settings');
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

// GET/POST /admin/settings/users -- list + add users. No delete: a user row
// can be referenced by transactions.employee_id/submitted_by_id, and
// removing it would orphan those references.
router.get('/admin/settings/users', (req, res) => {
  res.render('settings_users', {
    title: 'Settings — Users',
    users: db.prepare('SELECT * FROM users ORDER BY name').all(),
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
    db.prepare('INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)').run(
      name,
      email,
      bcrypt.hashSync(password, 10),
      role,
      department
    );
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

// GET/POST /admin/settings/categories -- list + add + inline-edit
// categories (name, kind, recurrence_basis).
router.get('/admin/settings/categories', (req, res) => {
  res.render('settings_categories', {
    title: 'Settings — Categories',
    categories: db.prepare('SELECT * FROM categories ORDER BY name').all(),
    recurrence_options: RECURRENCE_BASIS_OPTIONS,
  });
});

router.post('/admin/settings/categories', (req, res) => {
  const name = (req.body.name || '').trim();
  const kind = req.body.kind || 'semi-variable';
  const recurrenceBasis = req.body.recurrence_basis || 'recurring-monthly';
  const addedReason = (req.body.added_reason || '').trim();
  if (!name) {
    flash(req, 'danger', 'Category name is required.');
    return res.redirect('/admin/settings/categories');
  }
  // A short reason is required on every *new* category (not on edits to an
  // existing one) -- the category list drifted silently in the past
  // (categories added without anyone deciding "yes, this should be
  // permanent"), so this is deliberate friction to make additions a
  // conscious choice, not incidental.
  if (!addedReason) {
    flash(req, 'danger', 'Please note why this category is being added.');
    return res.redirect('/admin/settings/categories');
  }
  try {
    db.prepare('INSERT INTO categories (name, kind, recurrence_basis, added_reason) VALUES (?, ?, ?, ?)').run(
      name,
      kind,
      recurrenceBasis,
      addedReason
    );
    flash(req, 'success', `Added category: ${name}`);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err.message)) {
      flash(req, 'danger', 'That category already exists.');
    } else {
      throw err;
    }
  }
  res.redirect('/admin/settings/categories');
});

router.post('/admin/settings/categories/:id/update', (req, res) => {
  const name = (req.body.name || '').trim();
  const kind = req.body.kind || 'semi-variable';
  const recurrenceBasis = req.body.recurrence_basis || 'recurring-monthly';
  if (!name) {
    flash(req, 'danger', 'Category name is required.');
    return res.redirect('/admin/settings/categories');
  }
  db.prepare('UPDATE categories SET name = ?, kind = ?, recurrence_basis = ? WHERE id = ?').run(
    name,
    kind,
    recurrenceBasis,
    req.params.id
  );
  flash(req, 'success', 'Category updated.');
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
  if ((req.body.confirm || '').trim() !== 'DELETE') {
    flash(req, 'danger', 'Type DELETE exactly to confirm -- nothing was deleted.');
    return res.redirect('/admin/settings/danger-zone');
  }
  const info = db.prepare('DELETE FROM transactions').run();
  flash(req, 'success', `Deleted ${info.changes} transaction(s). Categories, vendors, and users were left alone.`);
  res.redirect('/admin/settings/danger-zone');
});

module.exports = router;
