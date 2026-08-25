const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const { ESTABLISHED_CATEGORIES } = require('./constants');

const BASE_DIR = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Database path resolution. Ported from app.py's _database_uri(): the Python
// version defaults to a local sqlite file at BASE_DIR/instance/app.db, and
// only overrides that when DATABASE_URL is set. Note this is intentionally
// independent of DATA_DIR (DATA_DIR only relocates receipts/uploads, not the
// db file) -- same as the Python original.
//
// This port is SQLite-only (see task scope): a DATABASE_URL is honored only
// when it uses the sqlite:// scheme; anything else (e.g. a Postgres URL,
// which the Python version supported via SQLAlchemy) is ignored with a
// warning and we fall back to the local default, rather than trying to
// speak Postgres from here.
// ---------------------------------------------------------------------------
function resolveDbPath() {
  const url = process.env.DATABASE_URL;
  const defaultPath = path.join(BASE_DIR, 'instance', 'app.db');
  if (!url) return defaultPath;

  if (url.startsWith('sqlite:////')) {
    // Four slashes -> absolute path (matches SQLAlchemy's sqlite:// convention).
    return '/' + url.slice('sqlite:////'.length);
  }
  if (url.startsWith('sqlite:///')) {
    // Three slashes -> path relative to the process's cwd.
    return path.resolve(url.slice('sqlite:///'.length));
  }

  console.warn(
    `DATABASE_URL "${url}" is not a sqlite:// URL -- this port only supports SQLite. ` +
      `Falling back to the default local database at ${defaultPath}.`
  );
  return defaultPath;
}

const DB_PATH = resolveDbPath();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema. Mirrors models.py exactly (one table per model, same columns/
// relationships), created with CREATE TABLE IF NOT EXISTS -- the equivalent
// of SQLAlchemy's db.create_all() (create what's missing, leave existing
// tables alone).
// ---------------------------------------------------------------------------
function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'employee',
      department TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'semi-variable',
      recurrence_basis TEXT NOT NULL DEFAULT 'recurring-monthly'
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      notes TEXT,
      link TEXT,
      quantity REAL,
      unit_price REAL,
      category_id INTEGER REFERENCES categories(id),
      vendor_id INTEGER REFERENCES vendors(id),
      employee_id INTEGER REFERENCES users(id),
      is_one_time INTEGER DEFAULT 0,
      source TEXT DEFAULT 'manual',
      status TEXT DEFAULT 'approved',
      submitted_by_id INTEGER REFERENCES users(id),
      approved_by_id INTEGER REFERENCES users(id),
      approved_at TEXT,
      ordered_at TEXT,
      rejection_reason TEXT,
      receipt_path TEXT,
      extracted_raw_text TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_employee ON transactions(employee_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_submitted_by ON transactions(submitted_by_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT,
      stored_filename TEXT,
      file_type TEXT,
      uploaded_by_id INTEGER REFERENCES users(id),
      uploaded_at TEXT DEFAULT (datetime('now')),
      row_count INTEGER DEFAULT 0,
      imported_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'processed'
    );

    CREATE TABLE IF NOT EXISTS marketing_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      event_type TEXT DEFAULT 'networking',
      date TEXT,
      cost REAL DEFAULT 0,
      location TEXT,
      notes TEXT,
      created_by_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES marketing_events(id),
      contact_name TEXT,
      company TEXT,
      title TEXT,
      email TEXT,
      phone TEXT,
      notes TEXT,
      follow_up_status TEXT DEFAULT 'new',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_event_connections_event ON event_connections(event_id);

    CREATE TABLE IF NOT EXISTS event_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES marketing_events(id),
      connection_id INTEGER REFERENCES event_connections(id),
      description TEXT NOT NULL,
      estimated_value REAL DEFAULT 0,
      outcome_type TEXT DEFAULT 'other',
      date_logged TEXT,
      logged_by_id INTEGER REFERENCES users(id),
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_event_outcomes_event ON event_outcomes(event_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// Ported from models.py's seed_categories(): insert any established category
// that doesn't already exist by name. Safe to call on every boot.
function seedCategories() {
  const insert = db.prepare('INSERT INTO categories (name, kind, recurrence_basis) VALUES (?, ?, ?)');
  const exists = db.prepare('SELECT 1 FROM categories WHERE name = ?');
  const seedAll = db.transaction((rows) => {
    for (const [name, kind, recurrenceBasis] of rows) {
      if (!exists.get(name)) insert.run(name, kind, recurrenceBasis);
    }
  });
  seedAll(ESTABLISHED_CATEGORIES);
}

// Ported from app.py create_app() lines ~72-91: on first boot, if no admin
// role exists yet, create one from ADMIN_EMAIL/ADMIN_PASSWORD env vars (same
// default fallback values), warning if the default password is in use.
function bootstrapAdmin() {
  const existingAdmin = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();

  if (existingAdmin) {
    // Keep the first admin's credentials in sync with ADMIN_EMAIL/
    // ADMIN_PASSWORD on every boot, but only when those env vars are
    // actually set -- otherwise a stale value here could clobber a
    // password changed some other way. This exists because a mismatch
    // between "what's in the database" and "what the env vars say" (e.g.
    // after changing ADMIN_PASSWORD in Render's dashboard without also
    // resetting the existing user) is a real, recurring failure mode:
    // the login page always reflects the env vars, so the two silently
    // drifting apart is confusing to debug from the outside.
    if (process.env.ADMIN_PASSWORD) {
      const email = process.env.ADMIN_EMAIL || existingAdmin.email;
      const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
      try {
        db.prepare('UPDATE users SET email = ?, password_hash = ? WHERE id = ?').run(
          email,
          passwordHash,
          existingAdmin.id
        );
      } catch (err) {
        // UNIQUE constraint -- ADMIN_EMAIL collides with a different
        // existing user's email. Leave that user's email alone but still
        // sync the password, rather than crashing the whole boot over it.
        if (!/UNIQUE constraint failed/i.test(err.message)) throw err;
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, existingAdmin.id);
      }
    }
    return;
  }

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  if (adminPassword === 'admin123') {
    console.warn(
      'Using the default admin password (admin123) -- set ADMIN_EMAIL and ' +
        'ADMIN_PASSWORD env vars before deploying this anywhere reachable by others.'
    );
  }

  const passwordHash = bcrypt.hashSync(adminPassword, 10);
  try {
    db.prepare(
      'INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)'
    ).run('Admin', adminEmail, passwordHash, 'admin', 'Management');
  } catch (err) {
    // UNIQUE constraint (email already taken by a non-admin row somehow) --
    // matches the Python version's IntegrityError-swallow-and-rollback.
    if (!/UNIQUE constraint failed/i.test(err.message)) throw err;
  }
}

// Small key/value settings store (headcount, the supply-request form's
// editable intro text, etc.) -- simple enough not to need a dedicated table
// per setting.
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value
  );
}

createSchema();

// Defensive migrations for columns added after these tables may already
// exist on a deployed disk (CREATE TABLE IF NOT EXISTS won't add them).
function addColumnIfMissing(table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}

addColumnIfMissing('uploads', 'stored_filename TEXT');
addColumnIfMissing('transactions', 'link TEXT');
addColumnIfMissing('transactions', 'quantity REAL');
addColumnIfMissing('transactions', 'unit_price REAL');
addColumnIfMissing('transactions', 'ordered_at TEXT');
addColumnIfMissing('categories', "recurrence_basis TEXT NOT NULL DEFAULT 'recurring-monthly'");

seedCategories();
bootstrapAdmin();

// Attached directly to the exported db instance (rather than changing the
// module's export shape) since every route does `const db = require('../db')`
// and calls `db.prepare(...)` on it directly.
db.getSetting = getSetting;
db.setSetting = setSetting;

module.exports = db;
