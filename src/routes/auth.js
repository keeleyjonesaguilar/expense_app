const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { flash, requireAuth } = require('../middleware/auth');

const router = express.Router();

const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const insertUser = db.prepare(
  'INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)'
);

router.get('/signup', (req, res) => {
  res.render('signup', { title: 'Sign up' });
});

router.post('/signup', (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const pw = req.body.password || '';
  const dept = (req.body.department || '').trim();

  if (findUserByEmail.get(email)) {
    flash(req, 'danger', 'An account with that email already exists.');
    return res.redirect('/signup');
  }

  const passwordHash = bcrypt.hashSync(pw, 10);
  const info = insertUser.run(name, email, passwordHash, 'employee', dept);
  req.session.userId = info.lastInsertRowid;
  flash(req, 'success', 'Welcome! Your account has been created.');
  res.redirect('/my-reports');
});

router.get('/login', (req, res) => {
  res.render('login', { title: 'Log in' });
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const pw = req.body.password || '';
  const user = findUserByEmail.get(email);

  if (user && bcrypt.compareSync(pw, user.password_hash)) {
    req.session.userId = user.id;
    return res.redirect('/');
  }
  flash(req, 'danger', 'Invalid email or password.');
  res.render('login', { title: 'Log in' });
});

router.get('/logout', requireAuth, (req, res) => {
  req.session.userId = null;
  res.redirect('/login');
});

module.exports = router;
