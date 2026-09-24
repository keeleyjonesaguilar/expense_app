const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const { ESTABLISHED_CATEGORIES, ESTABLISHED_TAGS, DEFAULT_COLUMN_ALIASES } = require('./constants');

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
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    -- The roster of people spend/events/ROI get attributed to -- deliberately
    -- separate from users (login accounts). Most employees never log in; a
    -- few (admins, anyone submitting their own expense reports) also have a
    -- user account, linked via user_id. See migrateEmployeeReferences() below
    -- for how this was backfilled from the old users-only model.
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      department TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_user_unique ON employees(user_id) WHERE user_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'semi-variable',
      recurrence_basis TEXT NOT NULL DEFAULT 'recurring-monthly'
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category_id INTEGER NOT NULL REFERENCES categories(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tags_category ON tags(category_id);

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
      employee_id INTEGER REFERENCES employees(id),
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

    CREATE TABLE IF NOT EXISTS transaction_tags (
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      tag_id INTEGER NOT NULL REFERENCES tags(id),
      PRIMARY KEY (transaction_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transaction_tags_tag ON transaction_tags(tag_id);

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

    CREATE TABLE IF NOT EXISTS event_attendees (
      event_id INTEGER NOT NULL REFERENCES marketing_events(id),
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      PRIMARY KEY (event_id, employee_id)
    );
    CREATE INDEX IF NOT EXISTS idx_event_attendees_employee ON event_attendees(employee_id);

    -- The "return" side of per-employee investment ROI (see
    -- routes/employees.js): a manually-logged value or note an admin
    -- attributes to an employee -- a deal closed, a referral, a skill
    -- applied on the job -- weighed against what was invested in them
    -- (Professional Development spend + Team Engagement events attended).
    CREATE TABLE IF NOT EXISTS employee_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      description TEXT NOT NULL,
      estimated_value REAL DEFAULT 0,
      date_logged TEXT,
      logged_by_id INTEGER REFERENCES users(id),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_employee_returns_employee ON employee_returns(employee_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS column_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field TEXT NOT NULL,
      alias TEXT NOT NULL,
      UNIQUE(field, alias)
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

// Same insert-if-missing, safe-on-every-boot pattern as seedCategories()
// above, for tags. Must run after seedCategories() (each tag looks up its
// parent category by name).
function seedTags() {
  const findCategory = db.prepare('SELECT id FROM categories WHERE name = ?');
  const insert = db.prepare('INSERT INTO tags (name, category_id) VALUES (?, ?)');
  const exists = db.prepare('SELECT 1 FROM tags WHERE name = ?');
  const seedAll = db.transaction((rows) => {
    for (const [name, categoryName] of rows) {
      if (exists.get(name)) continue;
      const category = findCategory.get(categoryName);
      if (!category) continue; // established tag references a category that isn't seeded (shouldn't happen) -- skip rather than crash boot
      insert.run(name, category.id);
    }
  });
  seedAll(ESTABLISHED_TAGS);
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
addColumnIfMissing('categories', 'added_reason TEXT');
addColumnIfMissing('transactions', 'upload_id INTEGER REFERENCES uploads(id)');
// Two-factor auth (TOTP, e.g. Microsoft/Google Authenticator) -- secret is
// only set once a user has confirmed enrollment by entering a live code
// (see routes/security.js); totp_enabled gates whether login requires it.
addColumnIfMissing('users', 'totp_secret TEXT');
addColumnIfMissing('users', 'totp_enabled INTEGER NOT NULL DEFAULT 0');
// Deactivating a user blocks login without deleting their row (which would
// orphan everything they've submitted/approved/logged).
addColumnIfMissing('users', 'active INTEGER NOT NULL DEFAULT 1');

// Seed the bulk-import column-alias matcher's starting data, same
// insert-if-missing pattern as seedCategories() below.
function seedColumnAliases() {
  const insert = db.prepare('INSERT OR IGNORE INTO column_aliases (field, alias) VALUES (?, ?)');
  const seedAll = db.transaction((rows) => {
    for (const [field, alias] of rows) insert.run(field, alias);
  });
  seedAll(DEFAULT_COLUMN_ALIASES);
}

seedCategories();
seedTags();
seedColumnAliases();
bootstrapAdmin();

// One-time backfill from the old model (every "employee" was just a users
// row) to the new one (a dedicated employees roster, users only for login
// accounts). Employee rows are inserted with the SAME id as the user they
// came from, so every existing transactions.employee_id / event_attendees.
// employee_id / employee_returns.employee_id value already points at the
// right person -- no remapping needed, just repointing which table those
// columns reference. Gated by a settings flag so it only ever runs once;
// safe to run again on a fresh/empty database too (no-ops cleanly).
function recreateTableWithEmployeeFk(table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row) return;
  const newSql = row.sql
    .replace(new RegExp(`CREATE TABLE ${table}\\b`, 'i'), `CREATE TABLE ${table}_migrating`)
    .replace(/employee_id(\s+INTEGER)(\s+NOT NULL)?\s+REFERENCES\s+users\s*\(\s*id\s*\)/i, (m, intType, notNull) =>
      `employee_id${intType}${notNull || ''} REFERENCES employees(id)`
    );
  if (newSql === row.sql.replace(new RegExp(`CREATE TABLE ${table}\\b`, 'i'), `CREATE TABLE ${table}_migrating`)) {
    // No "REFERENCES users(id)" found on employee_id -- already migrated or
    // never pointed at users to begin with; nothing to do.
    return;
  }
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).join(', ');
  db.exec(newSql);
  db.exec(`INSERT INTO ${table}_migrating (${cols}) SELECT ${cols} FROM ${table};`);
  db.exec(`DROP TABLE ${table};`);
  db.exec(`ALTER TABLE ${table}_migrating RENAME TO ${table};`);
}

function migrateEmployeeReferences() {
  if (getSetting('employees_migrated', null)) return;

  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    const users = db.prepare('SELECT id, name, department FROM users').all();
    const insertEmployee = db.prepare(
      'INSERT OR IGNORE INTO employees (id, name, department, active, user_id) VALUES (?, ?, ?, 1, ?)'
    );
    for (const u of users) insertEmployee.run(u.id, u.name, u.department, u.id);

    for (const table of ['transactions', 'event_attendees', 'employee_returns']) {
      recreateTableWithEmployeeFk(table);
    }
  });
  migrate();
  createSchema(); // DROP TABLE above also dropped that table's indexes -- CREATE INDEX IF NOT EXISTS restores them.
  db.pragma('foreign_keys = ON');
  setSetting('employees_migrated', '1');
}

migrateEmployeeReferences();

// Every login-capable user also gets an employee record (created lazily if
// one doesn't already exist) so their own submissions/attendance can be
// attributed via employees.id without assuming the two ids ever match.
function getOrCreateEmployeeForUser(userId) {
  const existing = db.prepare('SELECT id FROM employees WHERE user_id = ?').get(userId);
  if (existing) return existing.id;
  const user = db.prepare('SELECT name, department FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const info = db
    .prepare('INSERT INTO employees (name, department, active, user_id) VALUES (?, ?, 1, ?)')
    .run(user.name, user.department, userId);
  return info.lastInsertRowid;
}

// Attached directly to the exported db instance (rather than changing the
// module's export shape) since every route does `const db = require('../db')`
// and calls `db.prepare(...)` on it directly.
db.getSetting = getSetting;
db.setSetting = setSetting;
db.getOrCreateEmployeeForUser = getOrCreateEmployeeForUser;

module.exports = db;
