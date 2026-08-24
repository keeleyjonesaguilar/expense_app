// Entry point for the Node/Express port of the Flask "Corporate Spend & ROI
// Tracker" prototype. See README.md for the one known behavioral difference
// from the Python version (no OCR fallback for scanned/image-only PDFs).
require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');

// Side-effecting require: opens/creates the SQLite database, creates the
// schema if missing, seeds the established categories, and bootstraps the
// first admin account -- mirrors app.py's create_app() startup sequence.
require('./src/db');

const { attachUser, popFlash } = require('./src/middleware/auth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Equivalent of Flask's static_folder -- templates reference these as
// /static/vendor/... (was url_for('static', filename='vendor/...')).
app.use('/static', express.static(path.join(__dirname, 'public')));

// The bulk-import commit form posts several fields per row (date/amount/
// category/vendor/description/notes) -- a few hundred imported rows easily
// exceeds Express's default 1000-parameter cap, so raise it well past what
// even a large spreadsheet import would need.
app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 100000 }));

app.use(
  session({
    secret: process.env.SECRET_KEY || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
  })
);

app.use(attachUser);
app.use(popFlash);

// Small view-formatting helpers exposed to every EJS template, standing in
// for Jinja's strftime/format filters used throughout the original
// templates (e.g. "%.2f"|format(x), "{:,.2f}".format(x), date.strftime(...)).
app.use((req, res, next) => {
  res.locals.fmt2 = (n) => Number(n || 0).toFixed(2);
  res.locals.fmtMoney = (n) =>
    Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  res.locals.fmtDate = (isoDate) => {
    if (!isoDate) return '';
    const [y, m, d] = String(isoDate).slice(0, 10).split('-');
    return y && m && d ? `${m}/${d}/${y}` : '';
  };
  res.locals.fmtDateTime = (isoDateTime) => {
    if (!isoDateTime) return '';
    // Stored as SQLite's datetime('now') -> "YYYY-MM-DD HH:MM:SS" (UTC).
    const s = String(isoDateTime);
    const [datePart, timePart] = s.split(' ');
    const [y, m, d] = (datePart || '').split('-');
    const hm = (timePart || '').slice(0, 5);
    return y && m && d ? `${m}/${d}/${y} ${hm}` : s;
  };
  next();
});

// GET / -- ported from app.py's index(): redirect to the right home page
// depending on auth state / role.
app.get('/', (req, res) => {
  if (!req.currentUser) return res.redirect('/login');
  return res.redirect(req.currentUser.role === 'admin' ? '/admin' : '/my-reports');
});

app.use(require('./src/routes/auth'));
app.use(require('./src/routes/supplyRequest'));
app.use(require('./src/routes/expenses'));
app.use(require('./src/routes/admin'));
app.use(require('./src/routes/bulkImport'));
app.use(require('./src/routes/forecast'));
app.use(require('./src/routes/marketing'));
app.use(require('./src/routes/settings'));
app.use(require('./src/routes/reports'));
app.use(require('./src/routes/data'));

// Centralized error handler -- an uncaught error here would otherwise crash
// the process (unlike Flask's dev server, which shows a traceback page and
// keeps running); this at least returns a response and logs server-side.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (res.headersSent) return next(err);
  // An error thrown by early middleware (e.g. body-parser, before attachUser
  // runs) means res.locals.currentUser was never set -- the error view (via
  // partials/head) needs it regardless of where the request failed.
  if (!res.locals.currentUser) {
    res.locals.currentUser = { is_authenticated: false, is_admin: false, name: null, role: null, id: null };
  }
  const status = err.status || err.statusCode || 500;
  res.status(status).render('error', { title: 'Error', message: 'Something went wrong.' });
});

const PORT = process.env.PORT || 5051;
app.listen(PORT, () => {
  console.log(`Spend Tracker (Node) listening on port ${PORT}`);
});
