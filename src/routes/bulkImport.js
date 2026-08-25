const express = require('express');
const fs = require('fs');
const path = require('path');

const db = require('../db');
const extraction = require('../lib/extraction');
const { extOf, secureFilename } = require('../lib/util');
const { UPLOADS_DIR, ALLOWED_IMPORT_EXT, upload } = require('../lib/uploads');
const { requireAuth, requireAdmin, flash } = require('../middleware/auth');
const { STATUS_APPROVED, SOURCE_BULK_IMPORT } = require('../constants');
const { toCsv } = require('../lib/csv');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const listCategories = db.prepare('SELECT * FROM categories ORDER BY name');
const listEmployees = db.prepare('SELECT * FROM users ORDER BY name');
const listRecentUploads = db.prepare('SELECT * FROM uploads ORDER BY uploaded_at DESC LIMIT 10');
const getUpload = db.prepare('SELECT * FROM uploads WHERE id = ?');
const insertUpload = db.prepare(
  'INSERT INTO uploads (filename, stored_filename, file_type, uploaded_by_id, row_count) VALUES (?, ?, ?, ?, ?)'
);
const updateUploadRowCount = db.prepare('UPDATE uploads SET row_count = ? WHERE id = ?');
const findVendorByName = db.prepare('SELECT * FROM vendors WHERE name = ?');
const insertVendor = db.prepare('INSERT INTO vendors (name) VALUES (?)');

function findOrCreateVendor(name) {
  if (!name) return null;
  let vendor = findVendorByName.get(name);
  if (!vendor) {
    const info = insertVendor.run(name);
    vendor = { id: info.lastInsertRowid, name };
  }
  return vendor;
}

function previewCachePath(uploadId) {
  return path.join(UPLOADS_DIR, `preview_${uploadId}.json`);
}

// GET /admin/import/template.csv -- a blank starter file with the canonical
// column set (matches what a Transactions CSV export re-imports as, per
// the round-trip requirement), plus one clearly marked example row so a
// future upload is pre-formatted correctly. Uploads using the older
// Amazon/Staples-export-style headers (Standard Item Name, Item Net Total,
// etc.) still work fine -- those aliases weren't removed, this is just the
// template's own preferred shape.
router.get('/admin/import/template.csv', (req, res) => {
  const header = ['Date', 'Amount', 'Vendor', 'Category', 'Quantity', 'Employee', 'One-Time', 'Notes'];
  const example = ['2026-01-15', '19.28', 'Amazon', 'Office Supplies', '2', '', 'no', 'EXAMPLE ROW -- delete before uploading'];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="import-template.csv"');
  res.send(toCsv([header, example]));
});

// A field can't be re-mapped to these -- they aren't real extraction
// targets (order_number has no dedicated column; it's just folded into
// notes as a deliberate special case, not something to point a column at
// directly from the remap UI).
const REMAPPABLE_FIELDS = [
  'date', 'amount', 'vendor', 'category', 'quantity', 'unit_price',
  'link', 'notes', 'employee', 'one_time', 'description',
];

function readCache(uploadId) {
  const cachePath = previewCachePath(uploadId);
  if (!fs.existsSync(cachePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  // Older cache files (pre-column-mapping) were a bare array -- normalize
  // so a preview created just before a redeploy doesn't 500.
  return Array.isArray(parsed) ? { rows: parsed, columnMapping: [] } : parsed;
}

// GET/POST /admin/import -- ported from app.py's bulk_import().
router.get('/admin/import', (req, res) => {
  const uploadId = req.query.upload_id ? parseInt(req.query.upload_id, 10) : null;
  let previewRows = null;
  let columnMapping = null;
  let sheets = null;
  let currentSheet = req.query.sheet || null;

  if (uploadId) {
    const uploadRow = getUpload.get(uploadId);

    // A workbook with more than one sheet (e.g. a multi-year export with a
    // transaction log per year plus summary tabs) needs a human to pick the
    // right one -- list them so the template can render a picker, and
    // re-extract when a different sheet is chosen via ?sheet=. Re-extract
    // is also how a manual column remap (?map[Column Name]=field) takes
    // effect, without needing to re-upload the file.
    if (uploadRow && uploadRow.file_type === 'spreadsheet' && uploadRow.stored_filename) {
      const storedPath = path.join(UPLOADS_DIR, uploadRow.stored_filename);
      if (fs.existsSync(storedPath)) {
        sheets = extraction.listSpreadsheetSheets(storedPath);
        if (sheets && (req.query.sheet || req.query.map)) {
          const { rows, columnMapping: mapping } = extraction.extractFromSpreadsheet(
            storedPath,
            req.query.sheet,
            req.query.map
          );
          fs.writeFileSync(previewCachePath(uploadId), JSON.stringify({ rows, columnMapping: mapping }));
          updateUploadRowCount.run(rows.length, uploadId);
          if (!currentSheet) currentSheet = req.query.sheet;
        }
      }
    }

    const cached = readCache(uploadId);
    if (cached) {
      previewRows = cached.rows;
      columnMapping = cached.columnMapping;
    }
  }

  res.render('bulk_import', {
    title: 'Bulk Import',
    categories: listCategories.all(),
    employees: listEmployees.all(),
    preview_rows: previewRows,
    column_mapping: columnMapping,
    remappable_fields: REMAPPABLE_FIELDS,
    upload_id: uploadId,
    sheets,
    current_sheet: currentSheet,
    recent_uploads: listRecentUploads.all(),
  });
});

router.post('/admin/import', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file || !file.originalname) {
    flash(req, 'warning', 'Please choose a file.');
    return res.redirect('/admin/import');
  }

  const extn = extOf(file.originalname);
  if (!ALLOWED_IMPORT_EXT.has(extn)) {
    flash(req, 'danger', 'Unsupported file type.');
    return res.redirect('/admin/import');
  }

  const fname = secureFilename(`${Date.now() / 1000}_${file.originalname}`);
  const destPath = path.join(UPLOADS_DIR, fname);
  fs.writeFileSync(destPath, file.buffer);

  let rows;
  let columnMapping;
  let fileType;
  let defaultSheet = null;
  if (['csv', 'xlsx', 'xls'].includes(extn)) {
    ({ rows, columnMapping } = extraction.extractFromSpreadsheet(destPath));
    fileType = 'spreadsheet';
    if (extn !== 'csv') {
      const sheets = extraction.listSpreadsheetSheets(destPath);
      const picked = sheets.find((s) => s.looksLikeTransactions) || sheets[0];
      defaultSheet = picked ? picked.name : null;
      if (sheets.length > 1) {
        flash(
          req,
          'info',
          `This workbook has ${sheets.length} sheets -- showing "${defaultSheet}". Use the sheet picker below to import a different one.`
        );
      }
    }
  } else if (extn === 'pdf') {
    rows = [await extraction.extractFromDocument(destPath, 'pdf')];
    columnMapping = [];
    fileType = 'pdf';
  } else {
    rows = [await extraction.extractFromDocument(destPath, 'image')];
    columnMapping = [];
    fileType = 'image';
  }

  const info = insertUpload.run(file.originalname, fname, fileType, req.currentUser.id, rows.length);
  const uploadId = info.lastInsertRowid;

  // Stash rows in a simple file-based cache keyed by upload id -- mirrors the
  // Python version's approach (no session-based store needed for this size).
  fs.writeFileSync(previewCachePath(uploadId), JSON.stringify({ rows, columnMapping }));

  const sheetParam = defaultSheet ? `&sheet=${encodeURIComponent(defaultSheet)}` : '';
  res.redirect(`/admin/import?upload_id=${uploadId}${sheetParam}`);
});

router.post('/admin/import/:uploadId/commit', (req, res) => {
  const uploadId = parseInt(req.params.uploadId, 10);
  const cached = readCache(uploadId);
  if (!cached) {
    flash(req, 'danger', 'Preview expired, please re-upload.');
    return res.redirect('/admin/import');
  }
  const rows = cached.rows;

  const catByName = {};
  for (const c of listCategories.all()) catByName[c.name] = c.id;
  const employeeIds = new Set(listEmployees.all().map((e) => e.id));

  const insertTx = db.prepare(`
    INSERT INTO transactions
      (date, amount, description, notes, link, quantity, unit_price, category_id, vendor_id,
       employee_id, is_one_time, source, status, approved_by_id, approved_at, extracted_raw_text, upload_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
  `);

  let imported = 0;
  const n = rows.length;
  for (let i = 0; i < n; i++) {
    if (req.body[`skip_${i}`]) continue;
    const dateStr = req.body[`date_${i}`];
    const amountStr = req.body[`amount_${i}`];
    if (!dateStr || !amountStr) continue;

    const amount = parseFloat(amountStr);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !Number.isFinite(amount)) continue;

    const catName = req.body[`category_${i}`];
    const catId = catByName[catName] || null;
    const vendorName = (req.body[`vendor_${i}`] || '').trim();
    const vendor = vendorName ? findOrCreateVendor(vendorName) : null;
    const isOneTime = req.body[`one_time_${i}`] !== undefined ? 1 : 0;
    const quantityStr = req.body[`quantity_${i}`];
    const unitPriceStr = req.body[`unit_price_${i}`];
    const quantity = quantityStr !== undefined && quantityStr !== '' ? parseFloat(quantityStr) : null;
    const unitPrice = unitPriceStr !== undefined && unitPriceStr !== '' ? parseFloat(unitPriceStr) : null;
    const link = (req.body[`link_${i}`] || '').trim() || null;
    const employeeIdRaw = req.body[`employee_id_${i}`] ? parseInt(req.body[`employee_id_${i}`], 10) : null;
    const employeeId = employeeIdRaw && employeeIds.has(employeeIdRaw) ? employeeIdRaw : null;

    insertTx.run(
      dateStr,
      amount,
      (req.body[`description_${i}`] || '').slice(0, 500),
      (req.body[`notes_${i}`] || '').slice(0, 500),
      link,
      Number.isFinite(quantity) ? quantity : null,
      Number.isFinite(unitPrice) ? unitPrice : null,
      catId,
      vendor ? vendor.id : null,
      employeeId,
      isOneTime,
      SOURCE_BULK_IMPORT,
      STATUS_APPROVED,
      req.currentUser.id,
      (rows[i].raw_text || '').slice(0, 5000),
      uploadId
    );
    imported += 1;
  }

  db.prepare('UPDATE uploads SET imported_count = ? WHERE id = ?').run(imported, uploadId);
  fs.unlinkSync(previewCachePath(uploadId));

  flash(req, 'success', `Imported ${imported} of ${n} rows.`);
  res.redirect(`/admin/transactions?upload_id=${uploadId}`);
});

module.exports = router;
