const express = require('express');
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const { RECEIPTS_DIR, UPLOADS_DIR } = require('../lib/uploads');

const router = express.Router();

const DIRS = { receipts: RECEIPTS_DIR, uploads: UPLOADS_DIR };

// GET /data/:subdir/*filename -- ported from app.py's serve_data(). Serves
// receipts/uploads from DATA_DIR (which may be a persistent disk outside the
// public folder in production) rather than relying on Express's static
// middleware, which only serves from one fixed folder.
router.get('/data/:subdir/*', requireAuth, (req, res) => {
  const directory = DIRS[req.params.subdir];
  if (!directory) return res.status(404).send('Not Found');

  const filename = req.params[0];
  const resolved = path.resolve(directory, filename);
  // Guard against path traversal escaping the intended directory.
  if (!resolved.startsWith(path.resolve(directory) + path.sep) && resolved !== path.resolve(directory)) {
    return res.status(404).send('Not Found');
  }

  res.sendFile(resolved, (err) => {
    if (err && !res.headersSent) res.status(404).send('Not Found');
  });
});

module.exports = router;
