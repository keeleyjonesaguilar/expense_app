const express = require('express');
const fs = require('fs');
const path = require('path');

const db = require('../db');
const extraction = require('../lib/extraction');
const { extOf, secureFilename } = require('../lib/util');
const { UPLOADS_DIR, ALLOWED_IMPORT_EXT, upload } = require('../lib/uploads');
const { requireAuth, requireAdmin, flash } = require('../middleware/auth');
const { STATUS_APPROVED, SOURCE_BULK_IMPORT } = require('../constants');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const listCategories = db.prepare('SELECT * FROM categories ORDER BY name');
const listRecentUploads = db.prepare('SELECT * FROM uploads ORDER BY uploaded_at DESC LIMIT 10');
const insertUpload = db.prepare(
  'INSERT INTO uploads (filename, file_type, uploaded_by_id, row_count) VALUES (?, ?, ?, ?)'
);
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

// GET/POST /admin/import -- ported from app.py's bulk_import().
router.get('/admin/import', (req, res) => {
  const uploadId = req.query.upload_id ? parseInt(req.query.upload_id, 10) : null;
  let previewRows = null;
  if (uploadId) {
    const cachePath = previewCachePath(uploadId);
    if (fs.existsSync(cachePath)) {
      previewRows = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }
  }

  res.render('bulk_import', {
    title: 'Bulk Import',
    categories: listCategories.all(),
    preview_rows: previewRows,
    upload_id: uploadId,
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
  let fileType;
  if (['csv', 'xlsx', 'xls'].includes(extn)) {
    rows = extraction.extractFromSpreadsheet(destPath);
    fileType = 'spreadsheet';
  } else if (extn === 'pdf') {
    rows = [await extraction.extractFromDocument(destPath, 'pdf')];
    fileType = 'pdf';
  } else {
    rows = [await extraction.extractFromDocument(destPath, 'image')];
    fileType = 'image';
  }

  const info = insertUpload.run(file.originalname, fileType, req.currentUser.id, rows.length);
  const uploadId = info.lastInsertRowid;

  // Stash rows in a simple file-based cache keyed by upload id -- mirrors the
  // Python version's approach (no session-based store needed for this size).
  fs.writeFileSync(previewCachePath(uploadId), JSON.stringify(rows));

  res.redirect(`/admin/import?upload_id=${uploadId}`);
});

router.post('/admin/import/:uploadId/commit', (req, res) => {
  const uploadId = parseInt(req.params.uploadId, 10);
  const cachePath = previewCachePath(uploadId);
  if (!fs.existsSync(cachePath)) {
    flash(req, 'danger', 'Preview expired, please re-upload.');
    return res.redirect('/admin/import');
  }
  const rows = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

  const catByName = {};
  for (const c of listCategories.all()) catByName[c.name] = c.id;

  const insertTx = db.prepare(`
    INSERT INTO transactions
      (date, amount, description, category_id, vendor_id, is_one_time, source, status,
       approved_by_id, approved_at, extracted_raw_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
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

    insertTx.run(
      dateStr,
      amount,
      (req.body[`description_${i}`] || '').slice(0, 500),
      catId,
      vendor ? vendor.id : null,
      isOneTime,
      SOURCE_BULK_IMPORT,
      STATUS_APPROVED,
      req.currentUser.id,
      (rows[i].raw_text || '').slice(0, 5000)
    );
    imported += 1;
  }

  db.prepare('UPDATE uploads SET imported_count = ? WHERE id = ?').run(imported, uploadId);
  fs.unlinkSync(cachePath);

  flash(req, 'success', `Imported ${imported} of ${n} rows.`);
  res.redirect('/admin/transactions');
});

module.exports = router;
