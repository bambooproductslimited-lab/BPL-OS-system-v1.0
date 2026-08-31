var { pool, withTransaction } = require('../db/pool');
var bcrypt = require('bcrypt');
var config = require('../config');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

// ctx is optional (some callers, e.g. profile(), only need it to decide
// whether to include payCycle/dailyRate — compensation data, which stays
// out of the payload entirely for anyone without payroll.manage, rather
// than being sent and merely hidden client-side).
//
// shift (the free-text label shown throughout the UI, e.g. "Day ·
// 07:00–16:00") resolves in priority order: the assigned shift template
// (shift_id, joined in as shift_tpl_name/start/end below — see the
// company/department shift catalogue added alongside companies), then the
// per-employee shift_start/shift_end override, then whatever's already
// stored as free text (the historical default, or a legacy import).
function rowToEmployee(r, ctx) {
  var shiftStart = r.shift_tpl_start ? r.shift_tpl_start.slice(0, 5) : (r.shift_start ? r.shift_start.slice(0, 5) : null);
  var shiftEnd = r.shift_tpl_end ? r.shift_tpl_end.slice(0, 5) : (r.shift_end ? r.shift_end.slice(0, 5) : null);
  var out = {
    id: r.id, code: r.code, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone,
    departmentId: r.department_id, positionTitle: r.position_title, managerId: r.manager_id,
    employmentType: r.employment_type, hireDate: r.hire_date, status: r.status, location: r.location,
    shiftId: r.shift_id, shiftName: r.shift_tpl_name || null,
    shiftStart: shiftStart, shiftEnd: shiftEnd,
    shift: r.shift_tpl_name ? (r.shift_tpl_name + ' · ' + shiftStart + '–' + shiftEnd) : (shiftStart ? (shiftStart + '–' + (shiftEnd || '?')) : r.shift)
  };
  if (ctx && ctx.can('payroll.manage')) {
    out.payCycle = r.pay_cycle;
    out.dailyRate = Number(r.daily_rate);
  }
  return out;
}

// kernel.js: handlers['employees.list']
async function list(ctx, params) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var q = String((params && params.q) || '').toLowerCase();
  var includeTerminated = !!(params && params.includeTerminated);

  var res = await pool.query(
    'SELECT e.*, s.name AS shift_tpl_name, s.start_time AS shift_tpl_start, s.end_time AS shift_tpl_end ' +
    'FROM employees e LEFT JOIN shifts s ON s.id = e.shift_id ORDER BY e.code'
  );
  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    if (!(await visibleEmployee(ctx, { id: r.id, department_id: r.department_id, manager_id: r.manager_id }))) continue;
    if (!includeTerminated && r.status === 'terminated') continue;
    if (params && params.departmentId && r.department_id !== params.departmentId) continue;
    if (q) {
      var haystack = (r.first_name + ' ' + r.last_name + ' ' + r.code + ' ' + r.position_title + ' ' + r.email).toLowerCase();
      if (haystack.indexOf(q) < 0) continue;
    }
    out.push(rowToEmployee(r, ctx));
  }
  return out;
}

// kernel.js: handlers['employees.get']
async function get(ctx, id) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var res = await pool.query(
    'SELECT e.*, s.name AS shift_tpl_name, s.start_time AS shift_tpl_start, s.end_time AS shift_tpl_end ' +
    'FROM employees e LEFT JOIN shifts s ON s.id = e.shift_id WHERE e.id = $1',
    [id]
  );
  var e = res.rows[0];
  if (!(await visibleEmployee(ctx, e))) fail('forbidden', 'You do not have access to that employee record.');
  return rowToEmployee(e, ctx);
}

// kernel.js: handlers['employees.create']
async function create(ctx, p) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');

  var firstName = V.text(p.firstName, 'First name', 40);
  var lastName = V.text(p.lastName, 'Last name', 40);
  var email = V.email(p.email);
  var departmentId = p.departmentId;
  var deptRes = await pool.query('SELECT id FROM departments WHERE id = $1', [departmentId]);
  if (!deptRes.rows[0]) fail('invalid', 'Department is not a valid option.');
  var positionTitle = V.text(p.positionTitle, 'Job title', 60);
  var employmentType = V.oneOf(p.employmentType || 'permanent', ['permanent', 'contract', 'casual', 'day_rate'], 'Employment type');
  var hireDate = V.date(p.hireDate || new Date().toISOString().slice(0, 10), 'Hire date');
  var shiftStart = p.shiftStart ? V.time(p.shiftStart, 'Shift start') : null;
  var shiftEnd = p.shiftEnd ? V.time(p.shiftEnd, 'Shift end') : null;
  var shiftId = null;
  if (p.shiftId) {
    var shiftRes = await pool.query('SELECT id FROM shifts WHERE id = $1 AND department_id = $2', [p.shiftId, departmentId]);
    if (!shiftRes.rows[0]) fail('invalid', 'Shift is not a valid option for this department.');
    shiftId = p.shiftId;
  }

  var existing = await pool.query('SELECT id FROM employees WHERE email = $1', [email]);
  if (existing.rows[0]) fail('invalid', 'That email is already in use.');

  var countRes = await pool.query('SELECT count(*)::int AS n FROM employees');
  var code = 'BPL-' + String(countRes.rows[0].n + 1).padStart(3, '0');
  var settingsRes = await pool.query('SELECT plants FROM settings WHERE id = 1');
  var defaultLocation = (settingsRes.rows[0] && settingsRes.rows[0].plants[0]) || '';

  return withTransaction(async function (client) {
    var insertRes = await client.query(
      'INSERT INTO employees (code, first_name, last_name, email, phone, department_id, position_title, manager_id, employment_type, hire_date, status, location, shift, shift_start, shift_end, shift_id) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13,$14,$15) RETURNING *",
      [code, firstName, lastName, email, (p.phone || '').trim(), departmentId, positionTitle, p.managerId || null,
        employmentType, hireDate, p.location || defaultLocation, p.shift || 'Day · 07:00–16:00', shiftStart, shiftEnd, shiftId]
    );
    var e = insertRes.rows[0];

    var typesRes = await client.query('SELECT id, days_per_year FROM leave_types WHERE active');
    var year = new Date().getFullYear();
    for (var i = 0; i < typesRes.rows.length; i++) {
      await client.query(
        'INSERT INTO leave_balances (employee_id, leave_type_id, year, entitled, used) VALUES ($1,$2,$3,$4,0)',
        [e.id, typesRes.rows[i].id, year, typesRes.rows[i].days_per_year]
      );
    }

    if (p.createAccount) {
      var passwordHash = await bcrypt.hash('bamboo123', config.bcryptRounds);
      var roleId = p.roleId;
      if (roleId) {
        var roleRes = await client.query('SELECT id FROM roles WHERE id = $1', [roleId]);
        if (!roleRes.rows[0]) fail('invalid', 'Unknown role.');
      } else {
        var defaultRole = await client.query("SELECT id FROM roles WHERE key = 'employee'");
        roleId = defaultRole.rows[0].id;
      }
      var userRes = await client.query(
        'INSERT INTO users (employee_id, email, password_hash, status, must_change_password) VALUES ($1,$2,$3,\'active\',true) RETURNING id',
        [e.id, e.email, passwordHash]
      );
      await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [userRes.rows[0].id, roleId]);
      await audit(client, ctx, 'user.create', 'user', e.id, 'Created a login for ' + e.first_name + ' ' + e.last_name + '.');
    }

    await audit(client, ctx, 'employee.create', 'employee', e.id, 'Added employee ' + e.code + ' — ' + e.first_name + ' ' + e.last_name + '.');
    return rowToEmployee(e, ctx);
  });
}

var UPDATABLE_FIELDS = ['firstName', 'lastName', 'phone', 'positionTitle', 'departmentId', 'managerId', 'employmentType', 'location', 'shift', 'status'];
var COLUMN_BY_FIELD = {
  firstName: 'first_name', lastName: 'last_name', phone: 'phone', positionTitle: 'position_title',
  departmentId: 'department_id', managerId: 'manager_id', employmentType: 'employment_type',
  location: 'location', shift: 'shift', status: 'status'
};

// shiftId is validated (must belong to the employee's — possibly
// just-updated — department) rather than handled by the generic
// UPDATABLE_FIELDS loop above, which has no way to express that check.
async function resolveShiftIdUpdate(p, e) {
  if (p.shiftId === undefined) return undefined;
  if (!p.shiftId) return null; // explicit clear
  var departmentId = p.departmentId !== undefined ? p.departmentId : e.department_id;
  var shiftRes = await pool.query('SELECT id FROM shifts WHERE id = $1 AND department_id = $2', [p.shiftId, departmentId]);
  if (!shiftRes.rows[0]) fail('invalid', 'Shift is not a valid option for this department.');
  return p.shiftId;
}

// kernel.js: handlers['employees.update']
async function update(ctx, id, p) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  // Pay rate/cycle are compensation data — gated separately behind
  // payroll.manage so a department manager with plain employee.write
  // (who can otherwise edit this same record) can't set someone's pay.
  if ((p.payCycle !== undefined || p.dailyRate !== undefined) && !ctx.can('payroll.manage')) {
    fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  }

  var res = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
  var e = res.rows[0];
  if (!e) fail('notfound', 'Employee not found.');

  var sets = [], values = [], changed = [];
  UPDATABLE_FIELDS.forEach(function (k) {
    if (p[k] !== undefined && p[k] !== e[COLUMN_BY_FIELD[k]]) {
      changed.push(k);
      values.push(p[k]);
      sets.push(COLUMN_BY_FIELD[k] + ' = $' + values.length);
    }
  });
  if (p.status !== undefined) V.oneOf(p.status, ['active', 'inactive', 'terminated'], 'Status');
  if (p.employmentType !== undefined) V.oneOf(p.employmentType, ['permanent', 'contract', 'casual', 'day_rate'], 'Employment type');
  if (p.payCycle !== undefined) {
    V.oneOf(p.payCycle, ['monthly', 'biweekly', 'daily'], 'Pay cycle');
    if (p.payCycle !== e.pay_cycle) { changed.push('payCycle'); values.push(p.payCycle); sets.push('pay_cycle = $' + values.length); }
  }
  // Empty string clears back to "no personal override — follow the company
  // default", not a validation error; only a non-empty value is checked
  // against the HH:MM format.
  if (p.shiftStart !== undefined) {
    var shiftStart = p.shiftStart ? V.time(p.shiftStart, 'Shift start') : null;
    var curShiftStart = e.shift_start ? e.shift_start.slice(0, 5) : null;
    if (shiftStart !== curShiftStart) { changed.push('shiftStart'); values.push(shiftStart); sets.push('shift_start = $' + values.length); }
  }
  if (p.shiftEnd !== undefined) {
    var shiftEnd = p.shiftEnd ? V.time(p.shiftEnd, 'Shift end') : null;
    var curShiftEnd = e.shift_end ? e.shift_end.slice(0, 5) : null;
    if (shiftEnd !== curShiftEnd) { changed.push('shiftEnd'); values.push(shiftEnd); sets.push('shift_end = $' + values.length); }
  }
  var shiftIdUpdate = await resolveShiftIdUpdate(p, e);
  if (shiftIdUpdate !== undefined && shiftIdUpdate !== e.shift_id) {
    changed.push('shiftId'); values.push(shiftIdUpdate); sets.push('shift_id = $' + values.length);
  }
  if (p.dailyRate !== undefined) {
    var dailyRate = Math.max(0, Number(p.dailyRate) || 0);
    if (dailyRate !== Number(e.daily_rate)) { changed.push('dailyRate'); values.push(dailyRate); sets.push('daily_rate = $' + values.length); }
  }

  var newEmail = null;
  if (p.email !== undefined) {
    var em = V.email(p.email);
    if (em !== e.email) { changed.push('email'); newEmail = em; values.push(em); sets.push('email = $' + values.length); }
  }

  if (sets.length) {
    values.push(id);
    await pool.query('UPDATE employees SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $' + values.length, values);
  }

  await audit(pool, ctx, 'employee.update', 'employee', id, 'Updated ' + e.first_name + ' ' + e.last_name + ' (' + (changed.join(', ') || 'no change') + ').');
  var updated = await pool.query(
    'SELECT e.*, s.name AS shift_tpl_name, s.start_time AS shift_tpl_start, s.end_time AS shift_tpl_end ' +
    'FROM employees e LEFT JOIN shifts s ON s.id = e.shift_id WHERE e.id = $1',
    [id]
  );
  return rowToEmployee(updated.rows[0], ctx);
}

// kernel.js: handlers['employees.terminate']
async function terminate(ctx, id, reason) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  if (id === ctx.employee.id) fail('forbidden', 'You cannot terminate your own employee record.');

  return withTransaction(async function (client) {
    var res = await client.query('SELECT * FROM employees WHERE id = $1 FOR UPDATE', [id]);
    var e = res.rows[0];
    if (!e) fail('notfound', 'Employee not found.');
    if (e.status === 'terminated') fail('conflict', 'This employee is already terminated.');

    var updated = await client.query("UPDATE employees SET status = 'terminated', updated_at = now() WHERE id = $1 RETURNING *", [id]);
    await client.query("UPDATE users SET status = 'disabled' WHERE employee_id = $1", [id]);
    await audit(client, ctx, 'employee.terminate', 'employee', id, 'Terminated ' + e.first_name + ' ' + e.last_name + ' — ' + (reason || 'no reason given') + '.');
    return rowToEmployee(updated.rows[0], ctx);
  });
}

// kernel.js: handlers['employees.purgeTerminated']
async function purgeTerminated(ctx) {
  if (!ctx.can('role.manage')) fail('forbidden', 'Your role does not allow this action (role.manage).');
  return withTransaction(async function (client) {
    var res = await client.query("SELECT id, first_name, last_name FROM employees WHERE status = 'terminated'");
    if (!res.rows.length) fail('conflict', 'There are no terminated employees to remove.');
    var names = res.rows.map(function (e) { return e.first_name + ' ' + e.last_name; }).join(', ');
    await client.query("DELETE FROM employees WHERE status = 'terminated'");
    await audit(client, ctx, 'employee.purge', 'employee', '-', 'Permanently removed ' + res.rows.length + ' terminated employee record(s): ' + names + '.');
    return { removed: res.rows.length };
  });
}

// kernel.js: handlers['employees.profile']
async function profile(ctx, id) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var res = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
  var e = res.rows[0];
  if (!e) fail('notfound', 'Employee not found.');
  if (!(await visibleEmployee(ctx, e))) fail('forbidden', 'You do not have access to that employee record.');

  var deptRes = await pool.query('SELECT name FROM departments WHERE id = $1', [e.department_id]);
  var mgrRes = e.manager_id ? await pool.query('SELECT first_name, last_name FROM employees WHERE id = $1', [e.manager_id]) : { rows: [] };
  var attRes = await pool.query('SELECT * FROM attendance WHERE employee_id = $1 ORDER BY date DESC LIMIT 8', [e.id]);
  var leaveRes = await pool.query(
    'SELECT lr.*, lt.name AS type_name FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.employee_id = $1 ORDER BY lr.created_at DESC',
    [e.id]
  );
  var tasksRes = await pool.query(
    'SELECT t.id, t.title, t.status, t.due_date FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id WHERE ta.employee_id = $1',
    [e.id]
  );

  return {
    employee: rowToEmployee(e, ctx),
    departmentName: (deptRes.rows[0] && deptRes.rows[0].name) || '—',
    managerName: mgrRes.rows[0] ? mgrRes.rows[0].first_name + ' ' + mgrRes.rows[0].last_name : '—',
    attendance: attRes.rows,
    leave: leaveRes.rows.map(function (l) {
      return { id: l.id, startDate: l.start_date, endDate: l.end_date, days: l.days, status: l.status, typeName: l.type_name };
    }),
    tasks: tasksRes.rows.map(function (t) { return { id: t.id, title: t.title, status: t.status, dueDate: t.due_date }; })
  };
}

module.exports = { list: list, get: get, create: create, update: update, terminate: terminate, purgeTerminated: purgeTerminated, profile: profile, rowToEmployee: rowToEmployee };
