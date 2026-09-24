const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireAuth, requireAdmin, flash } = require('../middleware/auth');
const { extractMarketingEvents, VALID_EVENT_TYPES } = require('../lib/marketingImport');
const { extOf, secureFilename } = require('../lib/util');
const { UPLOADS_DIR, upload } = require('../lib/uploads');

const router = express.Router();
router.use(requireAuth);

const ALLOWED_MARKETING_IMPORT_EXT = new Set(['csv', 'xlsx', 'xls']);
const marketingPreviewCachePath = (uploadId) => path.join(UPLOADS_DIR, `marketing_preview_${uploadId}.json`);

function withRoi(event) {
  const totalOutcomeValue = event.total_outcome_value || 0;
  const cost = event.cost || 0;
  return {
    ...event,
    total_outcome_value: totalOutcomeValue,
    roi_dollar: totalOutcomeValue - cost,
    roi_ratio: cost ? totalOutcomeValue / cost : null,
  };
}

const EVENT_LIST_SELECT = `
  SELECT e.*,
    (SELECT COALESCE(SUM(estimated_value), 0) FROM event_outcomes WHERE event_id = e.id) AS total_outcome_value,
    (SELECT COUNT(*) FROM event_connections WHERE event_id = e.id) AS connections_count
  FROM marketing_events e
`;

// GET /marketing -- ported from app.py's marketing_list().
router.get('/marketing', (req, res) => {
  const events = db.prepare(`${EVENT_LIST_SELECT} ORDER BY e.date DESC`).all().map(withRoi);
  const totalCost = events.reduce((sum, e) => sum + (e.cost || 0), 0);
  const totalValue = events.reduce((sum, e) => sum + e.total_outcome_value, 0);
  res.render('marketing_list', { title: 'Marketing & ROI', events, total_cost: totalCost, total_value: totalValue });
});

// GET/POST /marketing/new
// prefill_name/prefill_type/prefill_cost/prefill_date (optional query params)
// pre-fill the New Event form -- used by the AI receipt-classification
// "Log this event" links (bulk import review / expense submission) when it
// flags a purchase as event/marketing-related.
router.get('/marketing/new', (req, res) => {
  res.render('marketing_new', {
    title: 'New Event',
    employees: db.prepare('SELECT id, name FROM employees WHERE active = 1 ORDER BY name').all(),
    attendee_ids: [],
    prefill_name: req.query.prefill_name || '',
    prefill_type: req.query.prefill_type || '',
    prefill_cost: req.query.prefill_cost || '',
    prefill_date: req.query.prefill_date || '',
  });
});

const linkAttendee = db.prepare('INSERT OR IGNORE INTO event_attendees (event_id, employee_id) VALUES (?, ?)');
function attendeeIdsFromBody(body) {
  const raw = body.attendee_id;
  const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return ids.map((id) => parseInt(id, 10)).filter((id) => Number.isInteger(id));
}

router.post('/marketing/new', (req, res) => {
  const info = db
    .prepare('INSERT INTO marketing_events (name, event_type, date, cost, location, notes, created_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      req.body.name,
      req.body.event_type || 'networking',
      req.body.date || null,
      parseFloat(req.body.cost || 0) || 0,
      req.body.location || '',
      req.body.notes || '',
      req.currentUser.id
    );
  for (const employeeId of attendeeIdsFromBody(req.body)) linkAttendee.run(info.lastInsertRowid, employeeId);
  flash(req, 'success', 'Event created.');
  res.redirect(`/marketing/${info.lastInsertRowid}`);
});

// GET /marketing/import -- upload form, and (with ?upload_id=) the review
// grid for a just-uploaded spreadsheet of past events. Mirrors the shape of
// the transaction bulk importer (upload -> review -> explicit commit) but
// against marketing_events instead -- nothing is written to the database
// until Commit is clicked below. Registered BEFORE /marketing/:eventId so
// "import" doesn't get swallowed as an :eventId (Express matches routes in
// registration order).
router.get('/marketing/import', requireAdmin, (req, res) => {
  const uploadId = req.query.upload_id ? parseInt(req.query.upload_id, 10) : null;
  let previewRows = null;
  if (uploadId) {
    try {
      previewRows = JSON.parse(fs.readFileSync(marketingPreviewCachePath(uploadId), 'utf8')).rows;
    } catch (err) {
      previewRows = null;
    }
  }
  res.render('marketing_import', {
    title: 'Import Events',
    upload_id: uploadId,
    preview_rows: previewRows,
    event_types: VALID_EVENT_TYPES,
  });
});

router.post('/marketing/import', requireAdmin, upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file || !file.originalname) {
    flash(req, 'warning', 'Please choose a file.');
    return res.redirect('/marketing/import');
  }
  const extn = extOf(file.originalname);
  if (!ALLOWED_MARKETING_IMPORT_EXT.has(extn)) {
    flash(req, 'danger', 'Unsupported file type -- use CSV or Excel.');
    return res.redirect('/marketing/import');
  }

  const fname = secureFilename(`${Date.now() / 1000}_${file.originalname}`);
  const destPath = path.join(UPLOADS_DIR, fname);
  fs.writeFileSync(destPath, file.buffer);

  const { rows } = extractMarketingEvents(destPath);
  const info = db
    .prepare('INSERT INTO uploads (filename, stored_filename, file_type, uploaded_by_id, row_count) VALUES (?, ?, ?, ?, ?)')
    .run(file.originalname, fname, 'marketing', req.currentUser.id, rows.length);
  fs.writeFileSync(marketingPreviewCachePath(info.lastInsertRowid), JSON.stringify({ rows }));

  res.redirect(`/marketing/import?upload_id=${info.lastInsertRowid}`);
});

router.post('/marketing/import/:uploadId/commit', requireAdmin, (req, res) => {
  const uploadId = parseInt(req.params.uploadId, 10);
  let cached;
  try {
    cached = JSON.parse(fs.readFileSync(marketingPreviewCachePath(uploadId), 'utf8'));
  } catch (err) {
    flash(req, 'danger', 'Preview expired -- please re-upload.');
    return res.redirect('/marketing/import');
  }

  const insert = db.prepare(
    'INSERT INTO marketing_events (name, event_type, date, cost, location, notes, created_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  let imported = 0;
  const n = cached.rows.length;
  for (let i = 0; i < n; i++) {
    if (req.body[`skip_${i}`]) continue;
    const name = (req.body[`name_${i}`] || '').trim();
    if (!name) continue;
    const eventType = VALID_EVENT_TYPES.includes(req.body[`event_type_${i}`]) ? req.body[`event_type_${i}`] : 'networking';
    const date = req.body[`date_${i}`] || null;
    const cost = parseFloat(req.body[`cost_${i}`] || 0) || 0;
    const location = (req.body[`location_${i}`] || '').trim();
    const notes = (req.body[`notes_${i}`] || '').trim();
    insert.run(name, eventType, date, cost, location, notes, req.currentUser.id);
    imported++;
  }

  db.prepare('UPDATE uploads SET imported_count = ? WHERE id = ?').run(imported, uploadId);
  flash(req, 'success', `Imported ${imported} event(s).`);
  res.redirect('/marketing');
});

// GET /marketing/:eventId
router.get('/marketing/:eventId', (req, res) => {
  const event = db.prepare(`${EVENT_LIST_SELECT} WHERE e.id = ?`).get(req.params.eventId);
  if (!event) return res.status(404).send('Not Found');

  const connections = db
    .prepare('SELECT * FROM event_connections WHERE event_id = ? ORDER BY created_at ASC')
    .all(event.id);
  const outcomes = db.prepare('SELECT * FROM event_outcomes WHERE event_id = ?').all(event.id);
  const attendees = db
    .prepare('SELECT emp.id, emp.name FROM event_attendees ea JOIN employees emp ON emp.id = ea.employee_id WHERE ea.event_id = ? ORDER BY emp.name')
    .all(event.id);

  res.render('marketing_detail', {
    title: event.name,
    ev: { ...withRoi(event), connections, outcomes, attendees },
    employees: db.prepare('SELECT id, name FROM employees WHERE active = 1 ORDER BY name').all(),
  });
});

// POST /marketing/:eventId/attendees -- replaces the full attendee set (an
// unchecked checkbox just means "not attending", same pattern as
// transaction tags).
router.post('/marketing/:eventId/attendees', (req, res) => {
  const event = db.prepare('SELECT id FROM marketing_events WHERE id = ?').get(req.params.eventId);
  if (!event) return res.status(404).send('Not Found');

  db.prepare('DELETE FROM event_attendees WHERE event_id = ?').run(event.id);
  for (const employeeId of attendeeIdsFromBody(req.body)) linkAttendee.run(event.id, employeeId);
  flash(req, 'success', 'Attendees updated.');
  res.redirect(`/marketing/${event.id}`);
});

// POST /marketing/:eventId/connections/new
router.post('/marketing/:eventId/connections/new', (req, res) => {
  const event = db.prepare('SELECT id FROM marketing_events WHERE id = ?').get(req.params.eventId);
  if (!event) return res.status(404).send('Not Found');

  db.prepare(
    `INSERT INTO event_connections
       (event_id, contact_name, company, title, email, phone, notes, follow_up_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    req.body.contact_name || '',
    req.body.company || '',
    req.body.title || '',
    req.body.email || '',
    req.body.phone || '',
    req.body.notes || '',
    req.body.follow_up_status || 'new'
  );
  flash(req, 'success', 'Connection added.');
  res.redirect(`/marketing/${event.id}`);
});

// POST /marketing/:eventId/outcomes/new
router.post('/marketing/:eventId/outcomes/new', (req, res) => {
  const event = db.prepare('SELECT id FROM marketing_events WHERE id = ?').get(req.params.eventId);
  if (!event) return res.status(404).send('Not Found');

  const connectionId = req.body.connection_id ? parseInt(req.body.connection_id, 10) : null;
  const dateLogged = req.body.date_logged || new Date().toISOString().slice(0, 10);

  db.prepare(
    `INSERT INTO event_outcomes
       (event_id, connection_id, description, estimated_value, outcome_type, date_logged, logged_by_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    connectionId,
    req.body.description,
    parseFloat(req.body.estimated_value || 0) || 0,
    req.body.outcome_type || 'other',
    dateLogged,
    req.currentUser.id,
    req.body.notes || ''
  );
  flash(req, 'success', 'Outcome logged.');
  res.redirect(`/marketing/${event.id}`);
});

module.exports = router;
