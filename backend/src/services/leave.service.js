var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V, businessDays } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

// kernel.js: handlers['leave.types']
async function listTypes() {
  var res = await pool.query('SELECT id, name, days_per_year, paid FROM leave_types WHERE active ORDER BY name');
  return res.rows;
}

function rowToLeaveRequest(r) {
  return {
    id: r.id, employeeId: r.employee_id, leaveTypeId: r.leave_type_id,
    startDate: r.start_date, endDate: r.end_date, days: r.days, reason: r.reason,
    status: r.status, createdAt: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    employeeName: r.employee_name, department: r.department_name, company: r.company_name, typeName: r.type_name
  };
}

// kernel.js: handlers['leave.list'] — params.companyId/departmentId narrow
// by the requester's department and its company (the tier added in
// migration 0032), applied after the existing visibility scoping below.
async function list(ctx, params) {
  var statusFilter = params && params.status;
  var companyId = params && params.companyId;
  var departmentId = params && params.departmentId;
  var all = ctx.can('leave.read.all');
  var res = await pool.query(
    'SELECT lr.*, e.first_name, e.last_name, e.department_id, d.name AS department_name, d.company_id, c.name AS company_name, lt.name AS type_name, ' +
    "(e.first_name || ' ' || e.last_name) AS employee_name " +
    'FROM leave_requests lr ' +
    'JOIN employees e ON e.id = lr.employee_id ' +
    'JOIN departments d ON d.id = e.department_id ' +
    'JOIN companies c ON c.id = d.company_id ' +
    'JOIN leave_types lt ON lt.id = lr.leave_type_id ' +
    'ORDER BY lr.created_at DESC'
  );
  // Resolve record-level visibility exactly like kernel's leave.list: own
  // requests always show; everything else needs leave.read.all AND to pass
  // visibleEmployee() (self / department / reporting subtree / all).
  var visible = [];
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    if (r.employee_id === ctx.employee.id) { visible.push(r); continue; }
    if (!all) continue;
    var target = await fetchEmployeeById(r.employee_id);
    if (await visibleEmployee(ctx, target)) visible.push(r);
  }
  if (statusFilter && statusFilter !== 'all') {
    visible = visible.filter(function (r) { return r.status === statusFilter; });
  }
  if (companyId) visible = visible.filter(function (r) { return r.company_id === companyId; });
  if (departmentId) visible = visible.filter(function (r) { return r.department_id === departmentId; });
  return visible.map(rowToLeaveRequest);
}

// kernel.js: handlers['leave.request']
async function requestLeave(ctx, p) {
  if (!ctx.can('leave.request')) fail('forbidden', 'Your role does not allow this action (leave.request).');

  var start = V.date(p.startDate, 'Start date');
  var end = V.date(p.endDate, 'End date');
  if (end < start) fail('invalid', 'The end date cannot be before the start date.');

  var typeRes = await pool.query('SELECT * FROM leave_types WHERE id = $1 AND active', [p.leaveTypeId]);
  var type = typeRes.rows[0];
  if (!type) fail('invalid', 'Choose a leave type.');

  var days = businessDays(start, end);

  var overlapRes = await pool.query(
    "SELECT id FROM leave_requests WHERE employee_id = $1 AND status NOT IN ('rejected','cancelled') " +
    'AND NOT (end_date < $2 OR start_date > $3)',
    [ctx.employee.id, start, end]
  );
  if (overlapRes.rows.length) fail('conflict', 'You already have a leave request covering those dates.');

  var year = new Date().getFullYear();
  var balRes = await pool.query(
    'SELECT * FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3',
    [ctx.employee.id, type.id, year]
  );
  var bal = balRes.rows[0];
  if (bal && type.days_per_year > 0 && days > bal.entitled - bal.used) {
    fail('invalid', 'That exceeds your remaining ' + type.name.toLowerCase() + ' (' + (bal.entitled - bal.used) + ' days left).');
  }

  var reason = V.text(p.reason, 'Reason', 300);

  return withTransaction(async function (client) {
    var insertRes = await client.query(
      'INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *",
      [ctx.employee.id, type.id, start, end, days, reason]
    );
    var req = insertRes.rows[0];

    await client.query(
      'INSERT INTO approvals (subject_type, subject_id, title, requested_by, assignee_permission, department_id, status, created_at) ' +
      "VALUES ('leave_request', $1, 'Leave request', $2, 'leave.approve', $3, 'pending', $4)",
      [req.id, ctx.employee.id, ctx.employee.department_id, req.created_at]
    );

    if (ctx.employee.manager_id) {
      await notify(
        client, ctx.employee.manager_id, 'Leave request to approve',
        ctx.employee.first_name + ' ' + ctx.employee.last_name + ' requested ' + days + ' day(s) of ' + type.name.toLowerCase() + '.',
        'approvals'
      );
    }
    await audit(client, ctx, 'leave.request', 'leave_request', req.id, 'Requested ' + days + ' day(s) of ' + type.name.toLowerCase() + ' (' + start + ' → ' + end + ').');

    return rowToLeaveRequest(req);
  });
}

// kernel.js: handlers['leave.decide']
async function decide(ctx, requestId, decision, note) {
  if (!ctx.can('leave.approve')) fail('forbidden', 'Your role does not allow this action (leave.approve).');
  decision = V.oneOf(decision, ['approved', 'rejected'], 'Decision');

  return withTransaction(async function (client) {
    var reqRes = await client.query('SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE', [requestId]);
    var req = reqRes.rows[0];
    if (!req) fail('notfound', 'Request not found.');
    if (req.status !== 'pending') fail('conflict', 'That request has already been decided.');

    var emp = await fetchEmployeeById(req.employee_id);
    if (!(await visibleEmployee(ctx, emp))) fail('forbidden', 'That request is outside the people you are responsible for.');
    if (emp.id === ctx.employee.id) fail('forbidden', 'You cannot approve your own leave.');

    var empNameRes = await client.query('SELECT first_name, last_name FROM employees WHERE id = $1', [emp.id]);
    var empName = empNameRes.rows[0];

    var decidedAt = new Date();
    var decisionNote = (note || '').trim();
    var updateRes = await client.query(
      'UPDATE leave_requests SET status = $1, decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $5 RETURNING *',
      [decision, ctx.employee.id, decidedAt, decisionNote, req.id]
    );
    req = updateRes.rows[0];

    if (decision === 'approved') {
      var year = new Date().getFullYear();
      await client.query(
        'UPDATE leave_balances SET used = used + $1 WHERE employee_id = $2 AND leave_type_id = $3 AND year = $4',
        [req.days, req.employee_id, req.leave_type_id, year]
      );
    }

    await client.query(
      "UPDATE approvals SET status = $1, decided_by = $2, decided_at = $3, comment = $4 " +
      "WHERE subject_type = 'leave_request' AND subject_id = $5 AND status = 'pending'",
      [decision, ctx.employee.id, decidedAt, decisionNote, req.id]
    );

    await notify(
      client, req.employee_id, 'Leave ' + decision,
      'Your leave request for ' + req.start_date + ' → ' + req.end_date + ' was ' + decision + '.', 'leave'
    );
    var verb = decision.charAt(0).toUpperCase() + decision.slice(1);
    await audit(client, ctx, 'leave.decide', 'leave_request', req.id, verb + ' ' + empName.first_name + ' ' + empName.last_name + '’s leave (' + req.days + ' day(s)).');

    return rowToLeaveRequest(req);
  });
}

// kernel.js: handlers['leave.cancel']
async function cancel(ctx, requestId) {
  return withTransaction(async function (client) {
    var reqRes = await client.query('SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE', [requestId]);
    var req = reqRes.rows[0];
    if (!req) fail('notfound', 'Request not found.');
    if (req.employee_id !== ctx.employee.id) fail('forbidden', 'You can only cancel your own request.');
    if (req.status !== 'pending') fail('conflict', 'Only a pending request can be cancelled.');

    var updateRes = await client.query("UPDATE leave_requests SET status = 'cancelled' WHERE id = $1 RETURNING *", [req.id]);
    req = updateRes.rows[0];

    await client.query(
      "UPDATE approvals SET status = 'cancelled' WHERE subject_id = $1 AND status = 'pending'",
      [req.id]
    );
    await audit(client, ctx, 'leave.cancel', 'leave_request', req.id, 'Cancelled own leave request.');

    return rowToLeaveRequest(req);
  });
}

module.exports = { listTypes: listTypes, list: list, requestLeave: requestLeave, decide: decide, cancel: cancel, rowToLeaveRequest: rowToLeaveRequest };
