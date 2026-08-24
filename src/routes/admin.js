const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin, flash } = require('../middleware/auth');
const { STATUS_PENDING, STATUS_APPROVED, STATUS_REJECTED, SOURCE_MANUAL } = require('../constants');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const listCategories = db.prepare('SELECT * FROM categories ORDER BY name');
const listEmployees = db.prepare('SELECT * FROM users ORDER BY name');
const findVendorByName = db.prepare('SELECT * FROM vendors WHERE name = ?');
const insertVendor = db.prepare('INSERT INTO vendors (name) VALUES (?)');
const getTxById = db.prepare('SELECT * FROM transactions WHERE id = ?');

const TX_JOIN_SELECT = `
  SELECT t.*,
         c.name AS category_name,
         v.name AS vendor_name,
         emp.name AS employee_name,
         sub.name AS submitted_by_name
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN vendors v ON v.id = t.vendor_id
  LEFT JOIN users emp ON emp.id = t.employee_id
  LEFT JOIN users sub ON sub.id = t.submitted_by_id
`;

function hydrate(t) {
  return {
    ...t,
    category: t.category_name ? { name: t.category_name } : null,
    vendor: t.vendor_name ? { name: t.vendor_name } : null,
    employee: t.employee_name ? { name: t.employee_name } : null,
    submitted_by: t.submitted_by_name ? { name: t.submitted_by_name } : null,
  };
}

function findOrCreateVendor(name) {
  if (!name) return null;
  let vendor = findVendorByName.get(name);
  if (!vendor) {
    const info = insertVendor.run(name);
    vendor = { id: info.lastInsertRowid, name };
  }
  return vendor;
}

// GET /admin -- ported from app.py's admin_dashboard().
router.get('/admin', (req, res) => {
  const txs = db.prepare(`${TX_JOIN_SELECT} WHERE t.status = ?`).all(STATUS_APPROVED).map(hydrate);

  const byCategory = new Map();
  const byEmployee = new Map();
  const byVendor = new Map();
  const byMonth = new Map();
  let onetimeTotal = 0;
  let recurringTotal = 0;

  const bump = (map, key, amt) => map.set(key, (map.get(key) || 0) + amt);

  for (const t of txs) {
    const catName = t.category ? t.category.name : 'Uncategorized';
    bump(byCategory, catName, t.amount);
    const empName = t.employee ? t.employee.name : t.submitted_by ? t.submitted_by.name : 'Bulk Import';
    bump(byEmployee, empName, t.amount);
    const vendName = t.vendor ? t.vendor.name : '(no vendor)';
    bump(byVendor, vendName, t.amount);
    const monthKey = t.date ? t.date.slice(0, 7) : 'unknown';
    bump(byMonth, monthKey, t.amount);
    if (t.is_one_time) onetimeTotal += t.amount;
    else recurringTotal += t.amount;
  }

  const pendingCount = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE status = ?')
    .get(STATUS_PENDING).n;
  const totalSpend = [...byCategory.values()].reduce((a, b) => a + b, 0);

  const sortDesc = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  const topCategories = sortDesc(byCategory).slice(0, 10);
  const topVendors = sortDesc(byVendor).slice(0, 10);
  const byEmployeeSorted = sortDesc(byEmployee);
  const monthsSorted = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  res.render('admin_dashboard', {
    title: 'Dashboard',
    total_spend: totalSpend,
    onetime_total: onetimeTotal,
    recurring_total: recurringTotal,
    pending_count: pendingCount,
    top_categories: topCategories,
    top_vendors: topVendors,
    by_employee: byEmployeeSorted,
    months_sorted: monthsSorted,
  });
});

// GET /admin/approvals
router.get('/admin/approvals', (req, res) => {
  const pending = db
    .prepare(`${TX_JOIN_SELECT} WHERE t.status = ? ORDER BY t.created_at ASC`)
    .all(STATUS_PENDING)
    .map(hydrate);
  res.render('approvals', { title: 'Approvals', pending });
});

router.post('/admin/approvals/:txId/approve', (req, res) => {
  const tx = getTxById.get(req.params.txId);
  if (!tx) return res.status(404).send('Not Found');
  db.prepare('UPDATE transactions SET status = ?, approved_by_id = ?, approved_at = datetime(\'now\') WHERE id = ?').run(
    STATUS_APPROVED,
    req.currentUser.id,
    tx.id
  );
  flash(req, 'success', `Approved: ${tx.description || tx.id}`);
  res.redirect('/admin/approvals');
});

router.post('/admin/approvals/:txId/reject', (req, res) => {
  const tx = getTxById.get(req.params.txId);
  if (!tx) return res.status(404).send('Not Found');
  db.prepare(
    "UPDATE transactions SET status = ?, approved_by_id = ?, approved_at = datetime('now'), rejection_reason = ? WHERE id = ?"
  ).run(STATUS_REJECTED, req.currentUser.id, req.body.reason || '', tx.id);
  flash(req, 'info', `Rejected: ${tx.description || tx.id}`);
  res.redirect('/admin/approvals');
});

// GET /admin/transactions
router.get('/admin/transactions', (req, res) => {
  const clauses = [];
  const params = [];

  const catId = req.query.category_id ? parseInt(req.query.category_id, 10) : null;
  const empId = req.query.employee_id ? parseInt(req.query.employee_id, 10) : null;
  const oneTime = req.query.one_time;
  const status = req.query.status;

  if (catId) {
    clauses.push('t.category_id = ?');
    params.push(catId);
  }
  if (empId) {
    clauses.push('(t.employee_id = ? OR t.submitted_by_id = ?)');
    params.push(empId, empId);
  }
  if (oneTime === '1') {
    clauses.push('t.is_one_time = 1');
  } else if (oneTime === '0') {
    clauses.push('t.is_one_time = 0');
  }
  if (status) {
    clauses.push('t.status = ?');
    params.push(status);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const txs = db.prepare(`${TX_JOIN_SELECT} ${where} ORDER BY t.date DESC`).all(...params).map(hydrate);

  res.render('transactions', {
    title: 'Transactions',
    txs,
    categories: listCategories.all(),
    employees: listEmployees.all(),
    filters: req.query,
  });
});

router.post('/admin/transactions/:txId/update', (req, res) => {
  const tx = getTxById.get(req.params.txId);
  if (!tx) return res.status(404).send('Not Found');

  const catId = req.body.category_id ? parseInt(req.body.category_id, 10) : null;
  const vendorName = (req.body.vendor_name || '').trim();
  const isOneTime = req.body.is_one_time !== undefined ? 1 : 0;
  const notes = req.body.notes !== undefined ? req.body.notes : tx.notes;

  let vendorId = tx.vendor_id;
  if (vendorName) {
    const vendor = findOrCreateVendor(vendorName);
    vendorId = vendor.id;
  }

  db.prepare(
    'UPDATE transactions SET category_id = COALESCE(?, category_id), vendor_id = ?, is_one_time = ?, notes = ? WHERE id = ?'
  ).run(catId, vendorId, isOneTime, notes, tx.id);

  flash(req, 'success', 'Transaction updated.');
  res.redirect('/admin/transactions');
});

// GET/POST /admin/transactions/new
router.get('/admin/transactions/new', (req, res) => {
  res.render('new_transaction', {
    title: 'Add Transaction',
    categories: listCategories.all(),
    employees: listEmployees.all(),
  });
});

router.post('/admin/transactions/new', (req, res) => {
  const vendorName = (req.body.vendor_name || '').trim();
  const vendor = vendorName ? findOrCreateVendor(vendorName) : null;
  const employeeId = req.body.employee_id ? parseInt(req.body.employee_id, 10) : null;

  db.prepare(
    `INSERT INTO transactions
       (date, amount, description, notes, category_id, vendor_id, employee_id,
        is_one_time, source, status, approved_by_id, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    req.body.date,
    parseFloat(req.body.amount),
    req.body.description || '',
    req.body.notes || '',
    parseInt(req.body.category_id, 10),
    vendor ? vendor.id : null,
    employeeId,
    req.body.is_one_time !== undefined ? 1 : 0,
    SOURCE_MANUAL,
    STATUS_APPROVED,
    req.currentUser.id
  );

  flash(req, 'success', 'Transaction added.');
  res.redirect('/admin/transactions');
});

module.exports = router;
