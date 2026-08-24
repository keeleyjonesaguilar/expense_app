const express = require('express');
const db = require('../db');
const { requireAuth, flash } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

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
router.get('/marketing/new', (req, res) => {
  res.render('marketing_new', { title: 'New Event' });
});

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
  flash(req, 'success', 'Event created.');
  res.redirect(`/marketing/${info.lastInsertRowid}`);
});

// GET /marketing/:eventId
router.get('/marketing/:eventId', (req, res) => {
  const event = db.prepare(`${EVENT_LIST_SELECT} WHERE e.id = ?`).get(req.params.eventId);
  if (!event) return res.status(404).send('Not Found');

  const connections = db
    .prepare('SELECT * FROM event_connections WHERE event_id = ? ORDER BY created_at ASC')
    .all(event.id);
  const outcomes = db.prepare('SELECT * FROM event_outcomes WHERE event_id = ?').all(event.id);

  res.render('marketing_detail', { title: event.name, ev: { ...withRoi(event), connections, outcomes } });
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
