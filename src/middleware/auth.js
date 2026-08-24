const db = require('../db');

const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');

// Equivalent of Flask-Login's user_loader + current_user: looks the session
// user up on every request and exposes it both on req.currentUser (for route
// handlers) and res.locals.currentUser (for EJS views, matching the
// current_user.is_authenticated / current_user.is_admin usage in the Jinja
// templates -- an "anonymous user" shape is used when nobody's logged in so
// templates don't need null checks).
function attachUser(req, res, next) {
  let user = null;
  if (req.session && req.session.userId) {
    user = getUserById.get(req.session.userId) || null;
    if (!user) {
      // Session points at a user that no longer exists -- clear it.
      req.session.userId = null;
    }
  }

  req.currentUser = user;
  res.locals.currentUser = user
    ? { ...user, is_authenticated: true, is_admin: user.role === 'admin' }
    : { is_authenticated: false, is_admin: false, name: null, role: null, id: null };

  next();
}

// Equivalent of Flask-Login's @login_required.
function requireAuth(req, res, next) {
  if (!req.currentUser) {
    return res.redirect('/login');
  }
  next();
}

// Equivalent of app.py's admin_required decorator (abort(403) if not an
// authenticated admin).
function requireAdmin(req, res, next) {
  if (!req.currentUser || req.currentUser.role !== 'admin') {
    return res.status(403).render('error', { message: "You don't have access to that page." });
  }
  next();
}

// ---------------------------------------------------------------------------
// Flash messages -- equivalent of Flask's flash()/get_flashed_messages().
// Stored on the session, popped (read + cleared) on the next request that
// renders a page.
// ---------------------------------------------------------------------------
function flash(req, category, message) {
  if (!req.session.flashMessages) req.session.flashMessages = [];
  req.session.flashMessages.push([category, message]);
}

function popFlash(req, res, next) {
  res.locals.messages = req.session.flashMessages || [];
  req.session.flashMessages = [];
  next();
}

module.exports = { attachUser, requireAuth, requireAdmin, flash, popFlash };
