const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db');
const { requireAuth, requireAdmin, flash } = require('../middleware/auth');
const { RECURRENCE_BASIS_OPTIONS } = require('../constants');

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
  flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/settings');
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
  if (!name) {
    flash(req, 'danger', 'Category name is required.');
    return res.redirect('/admin/settings/categories');
  }
  try {
    db.prepare('INSERT INTO categories (name, kind, recurrence_basis) VALUES (?, ?, ?)').run(
      name,
      kind,
      recurrenceBasis
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

module.exports = router;
