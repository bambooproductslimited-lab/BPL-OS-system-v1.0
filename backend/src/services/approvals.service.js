var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

// kernel.js: handlers['approvals.queue']
// Ported in full for the polymorphic shape (subject_type gates which detail
// query runs), but only 'leave_request' has a real detail lookup wired up in
// this pass — procurement_request/expense enrichment lands with those modules.
async function queue(ctx) {
  if (!ctx.can('approval.act')) fail('forbidden', 'Your role does not allow this action (approval.act).');

  var res = await pool.query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC");
  var out = [];

  for (var i = 0; i < res.rows.length; i++) {
    var a = res.rows[i];
    if (!ctx.can(a.assignee_permission)) continue;
    if (a.requested_by === ctx.employee.id) continue;
    var requester = await fetchEmployeeById(a.requested_by);
    if (!(await visibleEmployee(ctx, requester))) continue;

    var empRes = await pool.query('SELECT first_name, last_name, position_title FROM employees WHERE id = $1', [a.requested_by]);
    var e = empRes.rows[0];
    var entry = {
      id: a.id, subjectId: a.subject_id, subjectType: a.subject_type, title: a.title, createdAt: a.created_at,
      requesterName: e ? e.first_name + ' ' + e.last_name : '—', requesterRole: e ? e.position_title : '',
      detail: '', reason: ''
    };

    if (a.subject_type === 'leave_request') {
      var lrRes = await pool.query(
        'SELECT lr.*, lt.name AS type_name FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.id = $1',
        [a.subject_id]
      );
      var lr = lrRes.rows[0];
      if (lr) {
        entry.detail = lr.days + ' day(s) · ' + lr.type_name + ' · ' + lr.start_date + ' → ' + lr.end_date;
        entry.reason = lr.reason;
      }
    }

    out.push(entry);
  }
  return out;
}

module.exports = { queue: queue };
