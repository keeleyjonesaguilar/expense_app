const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Ported from app.py: DATA_DIR defaults to the app's own directory locally,
// overridable via env var for a persistent-disk production host (the app's
// own source directory gets wiped and re-cloned on every deploy there).
const BASE_DIR = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_DIR || BASE_DIR;
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_RECEIPT_EXT = new Set(['png', 'jpg', 'jpeg', 'pdf']);
const ALLOWED_IMPORT_EXT = new Set(['csv', 'xlsx', 'xls', 'pdf', 'png', 'jpg', 'jpeg']);

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB, matches MAX_CONTENT_LENGTH in app.py

// Buffered in memory, then written out ourselves with the exact filename
// scheme app.py uses (so behavior -- including secure_filename sanitizing --
// matches precisely) rather than letting multer pick the destination path.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

module.exports = { RECEIPTS_DIR, UPLOADS_DIR, ALLOWED_RECEIPT_EXT, ALLOWED_IMPORT_EXT, upload };
