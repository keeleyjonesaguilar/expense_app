const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin, flash } = require('../middleware/auth');
const {
  STATUS_PENDING,
  STATUS_APPROVED,
  STATUS_REJECTED,
  STATUS_AWAITING_ORDER,
  SOURCE_MANUAL,
  SOURCE_SUPPLY_REQUEST,
} = require('../constants');
const { toCsv } = require('../lib/csv');
const { TX_JOIN_SELECT, hydrate, computeSpendSummary } = require('../lib/reportData');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const listCategories = db.prepare('SELECT * FROM categories ORDER BY name');
const listEmployees = db.prepare('SELECT * FROM users ORDER BY name');
const findVendorByName = db.prepare('SELECT * FROM vendors WHERE name = ?');
const insertVendor = db.prepare('INSERT INTO vendors (name) VALUES (?)');
const getTxById = db.prepare('SELECT * FROM transactions WHERE id = ?');

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

  // Years with at least one approved transaction, most recent first --
  // drives the year selector. A year with data always appears even if
  // every transaction in it nets to $0, per spec (don't silently drop it).
  const availableYears = db
    .prepare("SELECT DISTINCT strftime('%Y', date) AS y FROM transactions WHERE status = ? ORDER BY 1 DESC")
    .all(STATUS_APPROVED)
    .map((r) => r.y)
    .filter(Boolean);

  const currentCalendarYear = String(new Date().getFullYear());
  const dashboardDefault = db.getSetting('dashboard_year_default', 'current-year');
  let selectedYear = req.query.year && availableYears.includes(req.query.year) ? req.query.year : null;
  if (!selectedYear) {
    if (dashboardDefault === 'most-recent' && availableYears.length) {
      selectedYear = availableYears[0];
    } else if (availableYears.includes(currentCalendarYear)) {
      selectedYear = currentCalendarYear;
    } else {
      selectedYear = availableYears[0] || currentCalendarYear;
    }
  }

  const summary = computeSpendSummary(txs, selectedYear);

  const pendingCount = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE status = ?')
    .get(STATUS_PENDING).n;
  // Money that's been requested/approved but not yet actually spent --
  // pending submissions plus supply requests approved but not yet ordered.
  // Distinct from pending_count (a count, not a dollar figure).
  const upcomingSpend = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE status IN (?, ?)')
    .get(STATUS_PENDING, STATUS_AWAITING_ORDER).total;

  res.render('admin_dashboard', {
    title: 'Dashboard',
    available_years: availableYears,
    selected_year: selectedYear,
    total_spend: summary.totalSpend,
    onetime_total: summary.onetimeTotal,
    recurring_total: summary.recurringTotal,
    event_marketing_total: summary.eventMarketingTotal,
    pending_count: pendingCount,
    upcoming_spend: upcomingSpend,
    top_categories: summary.topCategories.slice(0, 10),
    top_vendors: summary.topVendors.slice(0, 10),
    by_employee: summary.byEmployeeSorted,
    months_sorted: summary.monthsSorted,
    year_over_year: summary.yearOverYear,
    no_prior_year_data: summary.noPriorYearData,
    prev_year: summary.prevYear,
    curr_year: summary.currYear,
  });
});

// GET /admin/approvals -- old URL, kept as a redirect for bookmarks/links.
router.get('/admin/approvals', (req, res) => {
  res.redirect('/admin/transactions/requests');
});

// GET /admin/transactions/requests -- "Item Requests": everything that
// goes through the pending -> (awaiting-order ->) approved/rejected flow
// EXCEPT expense reports, which are reviewed inline on the main
// Transactions tab instead (filter by Status: Pending there). In practice
// this is supply requests. Filterable by status and category; defaults to
// "Open" (pending + awaiting-order) so resolved items don't clutter the
// default view but are still reachable.
router.get('/admin/transactions/requests', (req, res) => {
  const status = req.query.status || 'open';
  const catId = req.query.category_id ? parseInt(req.query.category_id, 10) : null;

  const clauses = ["t.source != 'expense_report'"];
  const params = [];
  if (status === 'open') {
    clauses.push('t.status IN (?, ?)');
    params.push(STATUS_PENDING, STATUS_AWAITING_ORDER);
  } else if (status !== 'any') {
    clauses.push('t.status = ?');
    params.push(status);
  }
  if (catId) {
    clauses.push('t.category_id = ?');
    params.push(catId);
  }

  const requests = db
    .prepare(`${TX_JOIN_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY t.created_at DESC`)
    .all(...params)
    .map(hydrate);

  res.render('item_requests', {
    title: 'Item Requests',
    requests,
    categories: listCategories.all(),
    filters: { status, category_id: req.query.category_id || '' },
  });
});

// GET /admin/transactions/requests/:id -- full detail for one request:
// approve/reject (with a reason) if pending, confirm-ordered if awaiting
// order, or a read-only summary (incl. rejection reason) once resolved.
router.get('/admin/transactions/requests/:id', (req, res) => {
  const tx = db.prepare(`${TX_JOIN_SELECT} WHERE t.id = ?`).get(req.params.id);
  if (!tx) return res.status(404).send('Not Found');
  res.render('item_request_detail', { title: 'Item Request', t: hydrate(tx) });
});

router.post('/admin/approvals/:txId/approve', (req, res) => {
  const tx = getTxById.get(req.params.txId);
  if (!tx) return res.status(404).send('Not Found');
  // A supply request hasn't actually been purchased yet -- Approve just
  // authorizes it; it only becomes a real ledger entry once someone clicks
  // Confirm Ordered. Everything else (expense reports, manual entries) is
  // already-spent money, so Approve finalizes it immediately as before.
  const newStatus = tx.source === SOURCE_SUPPLY_REQUEST ? STATUS_AWAITING_ORDER : STATUS_APPROVED;
  db.prepare('UPDATE transactions SET status = ?, approved_by_id = ?, approved_at = datetime(\'now\') WHERE id = ?').run(
    newStatus,
    req.currentUser.id,
    tx.id
  );
  flash(
    req,
    'success',
    newStatus === STATUS_AWAITING_ORDER
      ? `Approved (awaiting order): ${tx.description || tx.id}`
      : `Approved: ${tx.description || tx.id}`
  );
  // Callers pass a hidden `next` field to control where this lands (the
  // Item Requests list, an item's own detail page, back to the
  // Transactions tab for an inline expense-report approval, etc.) --
  // defaults to the Item Requests list, the main place these are reviewed.
  res.redirect(req.body.next || '/admin/transactions/requests');
});

router.post('/admin/approvals/:txId/confirm-ordered', (req, res) => {
  const tx = getTxById.get(req.params.txId);
  if (!tx || tx.status !== STATUS_AWAITING_ORDER) return res.status(404).send('Not Found');
  db.prepare("UPDATE transactions SET status = ?, ordered_at = datetime('now') WHERE id = ?").run(
    STATUS_APPROVED,
    tx.id
  );
  flash(req, 'success', `Marked ordered: ${tx.description || tx.id}`);
  res.redirect(req.body.next || '/admin/transactions/requests');
});

router.post('/admin/approvals/:txId/reject', (req, res) => {
  const tx = getTxById.get(req.params.txId);
  if (!tx) return res.status(404).send('Not Found');
  db.prepare(
    "UPDATE transactions SET status = ?, approved_by_id = ?, approved_at = datetime('now'), rejection_reason = ? WHERE id = ?"
  ).run(STATUS_REJECTED, req.currentUser.id, req.body.reason || '', tx.id);
  flash(req, 'info', `Rejected: ${tx.description || tx.id}`);
  res.redirect(req.body.next || '/admin/transactions/requests');
});

// GET /admin/transactions
router.get('/admin/transactions', (req, res) => {
  const clauses = [];
  const params = [];

  const catId = req.query.category_id ? parseInt(req.query.category_id, 10) : null;
  const empId = req.query.employee_id ? parseInt(req.query.employee_id, 10) : null;
  const oneTime = req.query.one_time;
  const status = req.query.status;
  const uploadId = req.query.upload_id ? parseInt(req.query.upload_id, 10) : null;

  if (uploadId) {
    clauses.push('t.upload_id = ?');
    params.push(uploadId);
  }
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
  // Pending/awaiting-order rows aren't real spend yet -- they belong in
  // Approvals, not the ledger. Default the ledger view to approved-only;
  // an explicit status filter (including picking "any") overrides that.
  if (status) {
    clauses.push('t.status = ?');
    params.push(status);
  } else if (status === undefined) {
    clauses.push('t.status = ?');
    params.push(STATUS_APPROVED);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const txs = db.prepare(`${TX_JOIN_SELECT} ${where} ORDER BY t.date DESC`).all(...params).map(hydrate);

  res.render('transactions', {
    title: 'Transactions',
    txs,
    categories: listCategories.all(),
    employees: listEmployees.all(),
    filters: { ...req.query, status: status === undefined ? STATUS_APPROVED : status },
  });
});

// GET /admin/transactions/export.csv -- full ledger export, all columns.
router.get('/admin/transactions/export.csv', (req, res) => {
  const txs = db.prepare(`${TX_JOIN_SELECT} ORDER BY t.date DESC`).all().map(hydrate);
  const header = [
    'Date', 'Amount', 'Quantity', 'Unit Price', 'Category', 'Vendor', 'Description',
    'Notes', 'Link', 'One-Time', 'Status', 'Source', 'Employee', 'Submitted By',
  ];
  const rows = txs.map((t) => [
    t.date,
    t.amount,
    t.quantity != null ? t.quantity : '',
    t.unit_price != null ? t.unit_price : '',
    t.category ? t.category.name : '',
    t.vendor ? t.vendor.name : '',
    t.description || '',
    t.notes || '',
    t.link || '',
    t.is_one_time ? 'Yes' : 'No',
    t.status,
    t.source,
    t.employee ? t.employee.name : '',
    t.submitted_by ? t.submitted_by.name : '',
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv([header, ...rows]));
});

router.post('/admin/transactions/:txId/update', (req, res) => {
  const tx = getTxById.get(req.params.txId);
  if (!tx) return res.status(404).send('Not Found');

  const catId = req.body.category_id ? parseInt(req.body.category_id, 10) : null;
  const vendorName = (req.body.vendor_name || '').trim();
  const isOneTime = req.body.is_one_time !== undefined ? 1 : 0;
  const notes = req.body.notes !== undefined ? req.body.notes : tx.notes;
  const description = req.body.description !== undefined ? req.body.description.trim() : tx.description;
  const amount = req.body.amount !== undefined && req.body.amount !== '' ? parseFloat(req.body.amount) : tx.amount;
  const link = req.body.link !== undefined ? req.body.link.trim() || null : tx.link;
  const quantity =
    req.body.quantity !== undefined && req.body.quantity !== '' ? parseFloat(req.body.quantity) : null;
  const unitPrice =
    req.body.unit_price !== undefined && req.body.unit_price !== '' ? parseFloat(req.body.unit_price) : null;

  let vendorId = tx.vendor_id;
  if (vendorName) {
    const vendor = findOrCreateVendor(vendorName);
    vendorId = vendor.id;
  }

  db.prepare(
    `UPDATE transactions
     SET category_id = COALESCE(?, category_id), vendor_id = ?, is_one_time = ?, notes = ?,
         description = ?, amount = ?, link = ?, quantity = ?, unit_price = ?
     WHERE id = ?`
  ).run(
    catId,
    vendorId,
    isOneTime,
    notes,
    description,
    Number.isFinite(amount) ? amount : tx.amount,
    link,
    Number.isFinite(quantity) ? quantity : null,
    Number.isFinite(unitPrice) ? unitPrice : null,
    tx.id
  );

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
       (date, amount, description, notes, link, category_id, vendor_id, employee_id,
        is_one_time, source, status, approved_by_id, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    req.body.date,
    parseFloat(req.body.amount),
    req.body.description || '',
    req.body.notes || '',
    (req.body.link || '').trim() || null,
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
