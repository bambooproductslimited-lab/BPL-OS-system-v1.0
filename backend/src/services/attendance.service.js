var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

function todayISO() { return new Date().toISOString().slice(0, 10); }
function nowHM() { return new Date().toTimeString().slice(0, 5); }

// kernel.js: handlers['attendance.clockIn']
async function clockIn(ctx) {
  if (!ctx.can('attendance.self')) fail('forbidden', 'Your role does not allow this action (attendance.self).');
  var t = todayISO();
  var existing = await pool.query('SELECT id FROM attendance WHERE employee_id = $1 AND date = $2', [ctx.employee.id, t]);
  if (existing.rows[0]) fail('conflict', 'You have already clocked in today.');

  var settingsRes = await pool.query('SELECT late_after FROM settings WHERE id = 1');
  var now = nowHM();
  var lateAfter = settingsRes.rows[0] ? settingsRes.rows[0].late_after.slice(0, 5) : '08:15';
  var status = now > lateAfter ? 'late' : 'present';

  var res = await pool.query(
    "INSERT INTO attendance (employee_id, date, clock_in, status, source) VALUES ($1,$2,$3,$4,'web') RETURNING *",
    [ctx.employee.id, t, now, status]
  );
  var rec = res.rows[0];
  await audit(pool, ctx, 'attendance.clockIn', 'attendance', rec.id, 'Clocked in at ' + now + (status === 'late' ? ' (late).' : '.'));
  return rowToAttendance(rec);
}

// kernel.js: handlers['attendance.clockOut']
async function clockOut(ctx) {
  if (!ctx.can('attendance.self')) fail('forbidden', 'Your role does not allow this action (attendance.self).');
  var t = todayISO();
  var res = await pool.query('SELECT * FROM attendance WHERE employee_id = $1 AND date = $2', [ctx.employee.id, t]);
  var rec = res.rows[0];
  if (!rec) fail('conflict', 'You have not clocked in today.');
  if (rec.clock_out) fail('conflict', 'You have already clocked out today.');

  var now = nowHM();
  var updated = await pool.query('UPDATE attendance SET clock_out = $1 WHERE id = $2 RETURNING *', [now, rec.id]);
  await audit(pool, ctx, 'attendance.clockOut', 'attendance', rec.id, 'Clocked out at ' + now + '.');
  return rowToAttendance(updated.rows[0]);
}

// kernel.js: handlers['attendance.list']
async function list(ctx, params) {
  var date = (params && params.date) || todayISO();
  var mine = !ctx.can('attendance.read.all');

  var scopeEmployees;
  if (mine) {
    scopeEmployees = [ctx.employee];
  } else {
    var empRes = await pool.query('SELECT id, department_id, manager_id, code, first_name, last_name FROM employees WHERE status != \'terminated\'');
    scopeEmployees = [];
    for (var i = 0; i < empRes.rows.length; i++) {
      if (await visibleEmployee(ctx, empRes.rows[i])) scopeEmployees.push(empRes.rows[i]);
    }
  }

  var attRes = await pool.query('SELECT * FROM attendance WHERE date = $1', [date]);
  var byEmp = {};
  attRes.rows.forEach(function (r) { byEmp[r.employee_id] = r; });

  var ids = scopeEmployees.map(function (e) { return e.id; });
  var deptRes = ids.length ? await pool.query('SELECT e.id AS emp_id, d.name FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.id = ANY($1)', [ids]) : { rows: [] };
  var deptByEmp = {};
  deptRes.rows.forEach(function (r) { deptByEmp[r.emp_id] = r.name; });

  return {
    date: date,
    scopeSize: scopeEmployees.length,
    rows: scopeEmployees.map(function (e) {
      var r = byEmp[e.id];
      return {
        id: r ? r.id : null, employeeId: e.id, name: e.first_name + ' ' + e.last_name, code: e.code,
        department: deptByEmp[e.id] || '—', clockIn: r ? r.clock_in : null, clockOut: r ? r.clock_out : null,
        status: r ? r.status : 'absent', note: r ? r.note : ''
      };
    })
  };
}

// kernel.js: handlers['attendance.adjust']
async function adjust(ctx, p) {
  if (!ctx.can('attendance.adjust')) fail('forbidden', 'Your role does not allow this action (attendance.adjust).');

  var rec;
  if (p.id) {
    var res = await pool.query('SELECT * FROM attendance WHERE id = $1', [p.id]);
    rec = res.rows[0];
  }
  if (!rec) {
    var emp = await fetchEmployeeById(p.employeeId);
    if (!emp) fail('notfound', 'Employee not found.');
    var date = V.date(p.date, 'Date');
    var insertRes = await pool.query(
      "INSERT INTO attendance (employee_id, date, status, source) VALUES ($1,$2,'present','adjustment') RETURNING *",
      [emp.id, date]
    );
    rec = insertRes.rows[0];
  }

  var status = p.status ? V.oneOf(p.status, ['present', 'late', 'absent', 'leave', 'off'], 'Status') : rec.status;
  var note = V.text(p.note, 'Reason for the correction', 200);

  var updated = await pool.query(
    'UPDATE attendance SET clock_in = COALESCE($1, clock_in), clock_out = COALESCE($2, clock_out), status = $3, note = $4, adjusted_by = $5 WHERE id = $6 RETURNING *',
    [p.clockIn !== undefined ? (p.clockIn || null) : rec.clock_in, p.clockOut !== undefined ? (p.clockOut || null) : rec.clock_out, status, note, ctx.employee.id, rec.id]
  );

  await audit(pool, ctx, 'attendance.adjust', 'attendance', rec.id, 'Corrected attendance for ' + rec.date + ': ' + note);
  return rowToAttendance(updated.rows[0]);
}

// kernel.js: handlers['attendance.delete']
async function remove(ctx, id) {
  if (!ctx.can('attendance.adjust')) fail('forbidden', 'Your role does not allow this action (attendance.adjust).');
  var res = await pool.query('SELECT * FROM attendance WHERE id = $1', [id]);
  var rec = res.rows[0];
  if (!rec) fail('notfound', 'Attendance record not found.');
  await pool.query('DELETE FROM attendance WHERE id = $1', [id]);
  await audit(pool, ctx, 'attendance.delete', 'attendance', id, 'Deleted attendance record for ' + rec.date + '.');
  return true;
}

function rowToAttendance(r) {
  return {
    id: r.id, employeeId: r.employee_id, date: r.date,
    clockIn: r.clock_in ? r.clock_in.slice(0, 5) : null, clockOut: r.clock_out ? r.clock_out.slice(0, 5) : null,
    status: r.status, source: r.source, note: r.note, adjustedBy: r.adjusted_by
  };
}

module.exports = { clockIn: clockIn, clockOut: clockOut, list: list, adjust: adjust, remove: remove, rowToAttendance: rowToAttendance };
