// Per-employee investment ROI: what the company has spent developing an
// employee (Professional Development spend attributed to them, Team
// Engagement/Employee Retention spend attributed to them, and the cost of
// any Marketing & ROI event they're a logged attendee of) weighed against
// what's come back -- manually-logged returns (a deal closed, a referral, a
// skill applied) PLUS an automatic share of any Marketing & ROI event's
// logged outcome value: an event's total outcome value is split evenly
// across its attendees, same formula as the invested side already used for
// cost. Meant as an input to eval/compensation conversations, not an
// automated score -- nothing here scores or ranks anyone.
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin, flash } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const PROF_DEV_CATEGORY = 'Professional Development';
const TEAM_ENGAGEMENT_CATEGORY = 'Team Engagement/Employee Retention';

const listEmployees = db.prepare('SELECT id, name, department FROM employees WHERE active = 1 ORDER BY name');

// Direct spend attributed to one employee under Professional Development or
// Team Engagement -- both categories where a transaction's employee_id
// meaningfully means "this was spent on/for them", unlike e.g. Office
// Expenses where employee_id is usually just "who submitted the receipt".
const directInvestment = db.prepare(`
  SELECT COALESCE(SUM(t.amount), 0) AS total
  FROM transactions t
  JOIN categories c ON c.id = t.category_id
  WHERE t.employee_id = ? AND t.status = 'approved' AND c.name IN (?, ?)
`);

// Every event this employee attended, with that event's cost (the invested
// side) and enough to compute this employee's share of its logged outcome
// value (the returned side): total outcome value / how many people attended.
const eventsForEmployee = db.prepare(`
  SELECT e.id, e.name, e.date, e.cost,
    (SELECT COALESCE(SUM(eo.estimated_value), 0) FROM event_outcomes eo WHERE eo.event_id = e.id) AS outcome_value,
    (SELECT COUNT(*) FROM event_attendees ea2 WHERE ea2.event_id = e.id) AS attendee_count
  FROM event_attendees ea
  JOIN marketing_events e ON e.id = ea.event_id
  WHERE ea.employee_id = ?
  ORDER BY e.date DESC
`);

const manualReturnedTotal = db.prepare(
  'SELECT COALESCE(SUM(estimated_value), 0) AS total FROM employee_returns WHERE employee_id = ?'
);

function computeRoi(employeeId) {
  const direct = directInvestment.get(employeeId, PROF_DEV_CATEGORY, TEAM_ENGAGEMENT_CATEGORY).total;
  const events = eventsForEmployee.all(employeeId);
  const eventInvestment = events.reduce((sum, e) => sum + (e.cost || 0), 0);
  const eventReturnShare = events.reduce(
    (sum, e) => sum + (e.attendee_count > 0 ? e.outcome_value / e.attendee_count : 0),
    0
  );
  const manualReturned = manualReturnedTotal.get(employeeId).total;
  const invested = direct + eventInvestment;
  const returned = manualReturned + eventReturnShare;
  return {
    invested,
    directInvestment: direct,
    eventInvestment,
    manualReturned,
    eventReturnShare,
    returned,
    net: returned - invested,
  };
}

// GET /admin/employees/roi -- one row per employee, invested vs. returned.
router.get('/admin/employees/roi', (req, res) => {
  const employees = listEmployees.all().map((e) => ({ ...e, ...computeRoi(e.id) }));
  res.render('employees_roi', { title: 'Employee ROI', employees });
});

// GET /admin/employees/:id/roi -- the breakdown behind one employee's
// numbers, plus the form to log a new return entry.
router.get('/admin/employees/:id/roi', (req, res) => {
  const employee = db.prepare('SELECT id, name FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).send('Not Found');

  const transactions = db
    .prepare(
      `SELECT t.id, t.date, t.amount, t.description, c.name AS category_name
       FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.employee_id = ? AND t.status = 'approved' AND c.name IN (?, ?)
       ORDER BY t.date DESC`
    )
    .all(employee.id, PROF_DEV_CATEGORY, TEAM_ENGAGEMENT_CATEGORY);

  const events = eventsForEmployee.all(employee.id).map((e) => ({
    ...e,
    return_share: e.attendee_count > 0 ? e.outcome_value / e.attendee_count : 0,
  }));

  const returns = db
    .prepare('SELECT * FROM employee_returns WHERE employee_id = ? ORDER BY date_logged DESC, id DESC')
    .all(employee.id);

  res.render('employee_roi_detail', {
    title: `${employee.name} — ROI`,
    employee,
    roi: computeRoi(employee.id),
    transactions,
    events,
    returns,
  });
});

router.post('/admin/employees/:id/returns', (req, res) => {
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).send('Not Found');

  const description = (req.body.description || '').trim();
  if (!description) {
    flash(req, 'danger', 'A description is required.');
    return res.redirect(`/admin/employees/${employee.id}/roi`);
  }

  db.prepare(
    'INSERT INTO employee_returns (employee_id, description, estimated_value, date_logged, logged_by_id, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    employee.id,
    description,
    parseFloat(req.body.estimated_value || 0) || 0,
    req.body.date_logged || new Date().toISOString().slice(0, 10),
    req.currentUser.id,
    (req.body.notes || '').trim()
  );
  flash(req, 'success', 'Return logged.');
  res.redirect(`/admin/employees/${employee.id}/roi`);
});

module.exports = router;
