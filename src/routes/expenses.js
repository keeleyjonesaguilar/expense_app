const express = require('express');
const fs = require('fs');
const path = require('path');

const db = require('../db');
const extraction = require('../lib/extraction');
const { extOf, secureFilename } = require('../lib/util');
const { RECEIPTS_DIR, ALLOWED_RECEIPT_EXT, upload } = require('../lib/uploads');
const { requireAuth, flash } = require('../middleware/auth');
const { STATUS_PENDING, SOURCE_EXPENSE_REPORT } = require('../constants');

const router = express.Router();

// Which fields Settings -> Required Fields has toggled on, beyond Date
// (always required, not toggleable). Defaults preserve the app's original
// hard-required set (amount, category) until an admin changes it.
function getRequiredFields() {
  const raw = db.getSetting('required_fields', null);
  if (!raw) return ['amount', 'category'];
  try {
    return JSON.parse(raw);
  } catch (err) {
    return ['amount', 'category'];
  }
}

const listCategories = db.prepare('SELECT * FROM categories ORDER BY name');
const listVendors = db.prepare('SELECT * FROM vendors ORDER BY name');
const findVendorByName = db.prepare('SELECT * FROM vendors WHERE name = ?');
const insertVendor = db.prepare('INSERT INTO vendors (name) VALUES (?)');
const insertTransaction = db.prepare(`
  INSERT INTO transactions
    (date, amount, description, notes, link, quantity, category_id, vendor_id, employee_id,
     is_one_time, source, status, submitted_by_id, receipt_path)
  VALUES (@date, @amount, @description, @notes, @link, @quantity, @category_id, @vendor_id, @employee_id,
          @is_one_time, @source, @status, @submitted_by_id, @receipt_path)
`);
const myTransactions = db.prepare(`
  SELECT t.*, c.name AS category_name, v.name AS vendor_name
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN vendors v ON v.id = t.vendor_id
  WHERE t.submitted_by_id = ?
  ORDER BY t.created_at DESC
`);

function findOrCreateVendor(name) {
  if (!name) return null;
  let vendor = findVendorByName.get(name);
  if (!vendor) {
    const info = insertVendor.run(name);
    vendor = { id: info.lastInsertRowid, name };
  }
  return vendor;
}

// GET/POST /submit -- ported from app.py's submit_expense().
router.get('/submit', requireAuth, (req, res) => {
  res.render('submit_expense', {
    title: 'Submit Expense',
    categories: listCategories.all(),
    vendors: listVendors.all(),
    extracted: null,
    required_fields: getRequiredFields(),
  });
});

router.post('/submit', requireAuth, upload.single('receipt'), async (req, res) => {
  const categories = listCategories.all();
  const requiredFields = getRequiredFields();

  if (req.body.extract_only !== undefined) {
    const file = req.file;
    let extracted = null;
    if (file && file.originalname && ALLOWED_RECEIPT_EXT.has(extOf(file.originalname))) {
      const fname = secureFilename(`${req.currentUser.id}_${Date.now() / 1000}_${file.originalname}`);
      const destPath = path.join(RECEIPTS_DIR, fname);
      fs.writeFileSync(destPath, file.buffer);
      const ftype = extOf(fname) === 'pdf' ? 'pdf' : 'image';
      extracted = await extraction.extractFromDocument(destPath, ftype);
      extracted.receipt_path = `receipts/${fname}`;
    } else {
      flash(req, 'warning', 'Please attach a PNG, JPG, or PDF receipt to extract.');
    }
    return res.render('submit_expense', {
      title: 'Submit Expense',
      categories,
      extracted,
      vendors: listVendors.all(),
      required_fields: requiredFields,
    });
  }

  const dateStr = req.body.date;
  const amountStr = req.body.amount;
  const categoryId = req.body.category_id;
  const vendorName = (req.body.vendor_name || '').trim();
  const description = (req.body.description || '').trim();
  const notes = (req.body.notes || '').trim();
  const link = (req.body.link || '').trim() || null;
  const quantityStr = req.body.quantity;
  const isOneTime = Boolean(req.body.is_one_time);
  const receiptPath = req.body.receipt_path || null;

  const errors = [];
  const validDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !Number.isNaN(Date.parse(dateStr));
  if (!validDate) errors.push('A valid date is required.');

  const amount = parseFloat(amountStr);
  const quantity = quantityStr !== undefined && quantityStr !== '' ? parseFloat(quantityStr) : null;

  // Amount and category are always validated (their DB columns/downstream
  // logic depend on them); the rest are only required when Settings ->
  // Required Fields has them toggled on.
  if (!Number.isFinite(amount)) errors.push('A valid amount is required.');
  if (!categoryId) errors.push('Please choose a category.');
  if (requiredFields.includes('vendor') && !vendorName) errors.push('Vendor is required.');
  if (requiredFields.includes('quantity') && !Number.isFinite(quantity)) errors.push('Quantity is required.');
  if (requiredFields.includes('notes') && !notes) errors.push('Notes are required.');
  if (requiredFields.includes('receipt') && !receiptPath) errors.push('A scanned receipt is required.');

  if (errors.length) {
    for (const e of errors) flash(req, 'danger', e);
    return res.render('submit_expense', {
      title: 'Submit Expense',
      categories,
      extracted: null,
      vendors: listVendors.all(),
      required_fields: requiredFields,
    });
  }

  const vendor = vendorName ? findOrCreateVendor(vendorName) : null;

  insertTransaction.run({
    date: dateStr,
    amount,
    description,
    notes,
    link,
    quantity: Number.isFinite(quantity) ? quantity : null,
    category_id: parseInt(categoryId, 10),
    vendor_id: vendor ? vendor.id : null,
    employee_id: req.currentUser.id,
    is_one_time: isOneTime ? 1 : 0,
    source: SOURCE_EXPENSE_REPORT,
    status: STATUS_PENDING,
    submitted_by_id: req.currentUser.id,
    receipt_path: receiptPath,
  });

  flash(req, 'success', 'Expense report submitted for approval.');
  res.redirect('/my-reports');
});

// GET /my-reports
router.get('/my-reports', requireAuth, (req, res) => {
  const txs = myTransactions.all(req.currentUser.id).map((t) => ({
    ...t,
    category: t.category_name ? { name: t.category_name } : null,
    vendor: t.vendor_name ? { name: t.vendor_name } : null,
  }));
  res.render('my_reports', { title: 'My Reports', txs });
});

module.exports = router;
