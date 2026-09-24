// Per-user two-factor auth (TOTP) enrollment/management -- available to
// any authenticated user (admin or employee) for their OWN account. See
// routes/auth.js for the login-time verification step this enables.
const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { generateSecret, generateURI, verifySync } = require('otplib');
const db = require('../db');
const { requireAuth, flash } = require('../middleware/auth');

const router = express.Router();
// Scoped to this router's own paths only -- an unscoped router.use(requireAuth)
// would gate every request that reaches this router in server.js's app.use()
// chain (including routers mounted after it, like the public, no-login
// /request-supplies form), not just this file's own /account/security/* routes.
router.use('/account/security', requireAuth);

const ISSUER = 'Evolution Safety Resources';

router.get('/account/security', (req, res) => {
  res.render('security', { title: 'Account Security' });
});

// Starts (or restarts) enrollment: generates a fresh secret, stashes it in
// the session (NOT the database -- it only becomes real once confirmed
// below with a live code, so a QR scanned-and-abandoned mid-flow never
// silently enables 2FA the user hasn't actually verified works).
router.post('/account/security/enable', async (req, res, next) => {
  try {
    const secret = generateSecret();
    req.session.pendingTotpSecret = secret;
    req.session.pendingTotpAttempts = 0;

    const uri = generateURI({ issuer: ISSUER, label: req.currentUser.email, secret });
    const qrDataUrl = await QRCode.toDataURL(uri);

    res.render('security_enroll', { title: 'Set Up Two-Factor Auth', secret, qr_data_url: qrDataUrl });
  } catch (err) {
    next(err);
  }
});

router.post('/account/security/confirm', (req, res) => {
  const secret = req.session.pendingTotpSecret;
  const code = (req.body.code || '').trim();

  if (!secret) {
    flash(req, 'danger', 'Enrollment expired -- please start again.');
    return res.redirect('/account/security');
  }

  // verifySync throws on malformed input (anything not exactly 6 digits)
  // rather than returning {valid:false} -- treat that the same as a wrong
  // code instead of letting it 500.
  let isValid = false;
  try {
    isValid = verifySync({ secret, token: code }).valid;
  } catch (err) {
    isValid = false;
  }

  if (!isValid) {
    req.session.pendingTotpAttempts = (req.session.pendingTotpAttempts || 0) + 1;
    if (req.session.pendingTotpAttempts >= 5) {
      req.session.pendingTotpSecret = null;
      flash(req, 'danger', 'Too many incorrect codes -- please start enrollment again.');
      return res.redirect('/account/security');
    }
    flash(req, 'danger', 'Incorrect code. Scan the QR code again or double-check the manual key, then try once more.');
    return res.render('security_enroll', {
      title: 'Set Up Two-Factor Auth',
      secret,
      qr_data_url: null, // avoid re-generating a QR (and its own await) just to re-show the same secret after a wrong code
    });
  }

  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(secret, req.currentUser.id);
  req.session.pendingTotpSecret = null;
  req.session.pendingTotpAttempts = 0;
  flash(req, 'success', 'Two-factor authentication is now enabled on your account.');
  res.redirect('/account/security');
});

router.post('/account/security/disable', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.currentUser.id);
  const pw = req.body.password || '';

  if (!bcrypt.compareSync(pw, user.password_hash)) {
    flash(req, 'danger', 'Incorrect password -- two-factor auth was not disabled.');
    return res.redirect('/account/security');
  }

  db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(req.currentUser.id);
  flash(req, 'success', 'Two-factor authentication has been disabled.');
  res.redirect('/account/security');
});

module.exports = router;
