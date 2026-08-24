/**
 * Optional demo-data seeder. Run this AFTER the app has started once (so
 * instance/app.db and the category table exist): `npm run seed` (or
 * `node seed_demo.js`).
 *
 * Populates a year of realistic-looking transactions across several
 * categories/employees/vendors, plus a couple of marketing events with
 * connections and logged outcomes, so a new install has something to look at
 * instead of an empty dashboard. Safe to run multiple times only if you
 * delete instance/app.db first -- it does not de-duplicate.
 *
 * Ported from seed_demo.py. Uses a small seeded PRNG (mulberry32) in place of
 * Python's random.seed(42) -- the exact sequence of "random" values won't
 * match the Python version bit-for-bit, but the seeding is still
 * deterministic run-to-run here, and the resulting data looks the same kind
 * of realistic.
 */
require('dotenv').config();
const db = require('./src/db');
const bcrypt = require('bcryptjs');

const { STATUS_APPROVED, SOURCE_BULK_IMPORT } = require('./src/constants');

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const randFloat = (min, max) => rand() * (max - min) + min;
const choice = (arr) => arr[Math.floor(rand() * arr.length)];

const VENDOR_BY_CATEGORY = {
  'Office Supplies': ['Staples', 'Amazon.com', 'Office Depot'],
  Beverages: ['Costco', 'Walmart', 'Amazon.com'],
  'Coffee Supplies': ['Amazon.com', 'Costco'],
  'Office Snacks & Candy': ['Amazon.com', 'Costco'],
  'Kitchen Supplies': ['Amazon.com', 'Target'],
  'Printer Supplies': ['Amazon.com', 'Staples'],
  'Cleaning Supplies': ['Amazon.com', 'Costco'],
  'Computer Accessories': ['Amazon.com', 'Best Buy'],
  'Computer Equipment': ['Best Buy', 'Amazon.com'],
  'Office Furniture': ['Staples', 'Amazon.com'],
  'Personal Development': ['Udemy', 'LinkedIn Learning'],
  'Food & Meals': ['Chipotle', 'DoorDash', "Domino's"],
  'Safety Supplies': ['Grainger', 'Amazon.com'],
  'Vehicle Supplies': ['AutoZone', 'Amazon.com'],
  'Shipping Supplies': ['Pirate Ship', 'UPS Store'],
};

const CATEGORY_MONTHLY_RANGE = {
  'Office Supplies': [60, 220],
  Beverages: [30, 120],
  'Coffee Supplies': [20, 90],
  'Office Snacks & Candy': [25, 100],
  'Kitchen Supplies': [10, 80],
  'Printer Supplies': [30, 150],
  'Cleaning Supplies': [20, 70],
  'Safety Supplies': [0, 200],
  'Vehicle Supplies': [0, 150],
  'Shipping Supplies': [0, 60],
  'Food & Meals': [20, 150],
  'Personal Development': [0, 250],
};

const EMPLOYEES = [
  ['Jamie Rivera', 'Operations'],
  ['Morgan Blake', 'Field Services'],
  ['Casey Nguyen', 'Administration'],
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDate(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// Returns [{year, month}] for the last `monthsBack` months, oldest first.
function monthRange(monthsBack) {
  const today = new Date();
  let y = today.getFullYear();
  let m = today.getMonth() + 1;
  const months = [];
  for (let i = 0; i < monthsBack; i++) {
    months.push({ y, m });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return months.reverse();
}

const existingCount = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
if (existingCount > 0) {
  console.log('Transactions already exist -- skipping seed (delete instance/app.db to reseed).');
  process.exit(0);
}

const insertUser = db.prepare(
  'INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)'
);
const employees = EMPLOYEES.map(([name, dept]) => {
  const email = `${name.split(' ')[0].toLowerCase()}@example.com`;
  const passwordHash = bcrypt.hashSync('password123', 10);
  const info = insertUser.run(name, email, passwordHash, 'employee', dept);
  return { id: info.lastInsertRowid, name };
});

const catByName = {};
for (const c of db.prepare('SELECT * FROM categories').all()) catByName[c.name] = c;

const findVendorByName = db.prepare('SELECT * FROM vendors WHERE name = ?');
const insertVendor = db.prepare('INSERT INTO vendors (name) VALUES (?)');
const vendorCache = {};
function getVendor(name) {
  if (!vendorCache[name]) {
    let v = findVendorByName.get(name);
    if (!v) {
      const info = insertVendor.run(name);
      v = { id: info.lastInsertRowid, name };
    }
    vendorCache[name] = v;
  }
  return vendorCache[name];
}

const insertTx = db.prepare(`
  INSERT INTO transactions
    (date, amount, description, category_id, vendor_id, employee_id, is_one_time, source, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let count = 0;
for (const { y, m } of monthRange(12)) {
  for (const [catName, [lo, hi]] of Object.entries(CATEGORY_MONTHLY_RANGE)) {
    if (rand() < 0.15) continue; // not every category has spend every month
    const nTransactions = randInt(1, 3);
    for (let i = 0; i < nTransactions; i++) {
      const amt = Math.round((randFloat(lo, hi) / nTransactions) * 100) / 100;
      if (amt <= 0) continue;
      const day = randInt(1, 27);
      const vendorName = choice(VENDOR_BY_CATEGORY[catName] || ['Amazon.com']);
      const emp = rand() < 0.4 ? choice(employees) : null;
      insertTx.run(
        isoDate(y, m, day),
        amt,
        `${catName} purchase`,
        catByName[catName].id,
        getVendor(vendorName).id,
        emp ? emp.id : null,
        0,
        SOURCE_BULK_IMPORT,
        STATUS_APPROVED
      );
      count += 1;
    }
  }
}

// A couple of one-time growth/move purchases in a recent month.
const recent = monthRange(2)[0];
for (const [catName, amt, desc] of [
  ['Computer Equipment', 2400.0, '3 new-hire laptops'],
  ['Office Furniture', 1650.0, 'New-hire desks and chairs'],
  ['Conference Room Equipment', 980.0, 'New conference room TV + mount'],
]) {
  insertTx.run(
    isoDate(recent.y, recent.m, 10),
    amt,
    desc,
    catByName[catName].id,
    getVendor('Amazon.com').id,
    null,
    1,
    SOURCE_BULK_IMPORT,
    STATUS_APPROVED
  );
  count += 1;
}

console.log(`Seeded ${count} transactions across ${employees.length} employees.`);

// Marketing events
const ev1MonthRange = monthRange(4)[0];
const ev2MonthRange = monthRange(2)[0];
const insertEvent = db.prepare(
  'INSERT INTO marketing_events (name, event_type, date, cost, location, notes) VALUES (?, ?, ?, ?, ?, ?)'
);
const ev1Info = insertEvent.run(
  'Regional Contractors Expo',
  'conference',
  isoDate(ev1MonthRange.y, ev1MonthRange.m, 15),
  2100.0,
  'Raleigh, NC',
  'Booth + 2 staff travel.'
);
const ev2Info = insertEvent.run(
  'Chamber of Commerce Mixer',
  'networking',
  isoDate(ev2MonthRange.y, ev2MonthRange.m, 20),
  150.0,
  'Local',
  'Monthly networking mixer.'
);
const ev1Id = ev1Info.lastInsertRowid;
const ev2Id = ev2Info.lastInsertRowid;

const insertConnection = db.prepare(
  'INSERT INTO event_connections (event_id, contact_name, company, title, follow_up_status) VALUES (?, ?, ?, ?, ?)'
);
const c1Info = insertConnection.run(ev1Id, 'Taylor Osei', 'BuildRight Construction', 'Procurement Manager', 'meeting-scheduled');
insertConnection.run(ev1Id, 'Riley Chen', 'Summit Developers', '', 'contacted');
const c3Info = insertConnection.run(ev2Id, 'Alex Moreno', 'Moreno & Sons', '', 'closed');
const c1Id = c1Info.lastInsertRowid;
const c3Id = c3Info.lastInsertRowid;

const insertOutcome = db.prepare(
  'INSERT INTO event_outcomes (event_id, connection_id, description, estimated_value, outcome_type) VALUES (?, ?, ?, ?, ?)'
);
insertOutcome.run(ev1Id, c1Id, 'Signed annual safety-supply contract', 8500.0, 'deal');
insertOutcome.run(ev2Id, c3Id, 'Referral to a new commercial client', 1200.0, 'referral');

console.log('Seeded 2 marketing events with connections and outcomes.');
