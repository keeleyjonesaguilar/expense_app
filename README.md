# Corporate Spend & ROI Tracker — Node/Express port

This is a Node.js/Express + EJS port of the Flask prototype in the sibling
`expense_app` folder, built for full feature parity: auth, employee expense
submission + admin approval, bulk import (spreadsheet/PDF/image) with
category-suggestion, next-year budget forecast, and the marketing/networking
ROI tracker.

## Known limitation vs. the Python version

**No OCR fallback for scanned/image-only PDFs.** The Python original renders
each PDF page to an image and runs Tesseract OCR on it (via PyMuPDF +
pytesseract) when a PDF has no extractable text layer. That fallback needs
native PDF-to-image rendering (poppler/canvas), which would reintroduce the
native-build-tool pain this port otherwise avoids by sticking to pure-JS/WASM
dependencies (`pdf-parse`, `tesseract.js`). This port skips it: a PDF with no
text layer returns a low-confidence/empty extraction result gracefully
instead of crashing (see the comment in `src/lib/extraction.js`). Plain image
uploads (JPG/PNG) still get full OCR via `tesseract.js`, matching the Python
behavior for that case.

## Running locally

```bash
npm install
npm start        # or: npm run dev (uses nodemon)
```

Open `http://localhost:5051` (see `.env.example` / `PORT`). A demo admin
account is created automatically on first boot from `ADMIN_EMAIL`/
`ADMIN_PASSWORD` (defaults to `admin@example.com` / `admin123` -- the app
warns on startup if you leave the default password in place).

To load a year of sample data:

```bash
npm run seed
```

Delete `instance/app.db` any time to start over.

## Structure

```
expense_app_node/
  server.js              Express app entry point (sessions, view engine, route mounting)
  src/
    db.js                 better-sqlite3 connection, schema creation, category seed, admin bootstrap
    constants.js           Established category list + status/source constants (ported from models.py)
    middleware/auth.js       Session -> current-user attachment, login/admin guards, flash messages
    lib/extraction.js         Document extraction pipeline (ported from extraction.py)
    lib/uploads.js             multer config + receipts/uploads directory handling
    lib/util.js                 secure_filename-equivalent, extension/date helpers
    routes/                      One file per route group (auth, expenses, admin, bulkImport, forecast, marketing, data)
  views/                          EJS templates (ported from templates/*.html), views/partials/ = base.html's extends/block equivalent
  public/vendor/                    Bootstrap + Chart.js, copied unchanged from static/vendor/
  seed_demo.js                       Demo data seeder (ported from seed_demo.py)
```

## What could not be ported 1:1

- **Scanned-PDF OCR** -- see "Known limitation" above.
- **Postgres support** -- the Python version could point `DATABASE_URL` at a
  managed Postgres instance via SQLAlchemy. This port is SQLite-only, per the
  porting scope; a non-sqlite `DATABASE_URL` is ignored with a warning and
  the app falls back to the local SQLite file.
- **Session storage** -- Flask's session is a signed client-side cookie by
  default. `express-session` here uses the default in-memory server-side
  store, which is fine for local/small-team use but isn't shared across
  multiple server processes/instances (a real multi-instance production
  deploy would want a shared session store, e.g. backed by the same SQLite
  file or Redis). This doesn't change any user-facing behavior for a single
  instance.
