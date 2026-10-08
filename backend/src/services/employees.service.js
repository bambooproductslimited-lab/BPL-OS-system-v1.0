var { pool, withTransaction } = require('../db/pool');
var bcrypt = require('bcrypt');
var config = require('../config');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { visibleEmployee, fetchEmployeeById, assertVisibleEmployee } = require('../middleware/rbac');
var { WORK_WEEKS } = require('../utils/workWeek');
var codes = require('./employeeCodes.service');

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
    // A second shift the same day (migration 0112), or null.
    secondShiftStart: r.second_shift_start ? String(r.second_shift_start).slice(0, 5) : null,
    secondShiftEnd: r.second_shift_end ? String(r.second_shift_end).slice(0, 5) : null,
    // The language they read on the kiosk; null follows their account's.
    language: r.language || null,
    // Their work week: 'mon_fri', 'mon_sat', 'all', or null (the usual week).
    workDays: r.work_days || null,
    shift: r.shift_tpl_name ? (r.shift_tpl_name + ' · ' + shiftStart + '–' + shiftEnd) : (shiftStart ? (shiftStart + '–' + (shiftEnd || '?')) : r.shift),
    // The profile photo's version (when it last changed), or null — the
    // picture itself is at /api/messages/people/:id/photo.
    photo: r.photo_key && r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : null,
    // The birthday (MM-DD) for everyone who can see the record; the full
    // date of birth, with the year, only for HR and the person themself.
    birthday: r.date_of_birth ? String(r.date_of_birth).slice(5, 10) : null
  };
  if (ctx && (ctx.can('employee.write') || (ctx.employee && ctx.employee.id === r.id))) out.dateOfBirth = r.date_of_birth ? String(r.date_of_birth).slice(0, 10) : null;
  if (ctx && ctx.can('payroll.manage')) {
    out.payCycle = r.pay_cycle;
    out.dailyRate = Number(r.daily_rate);
    out.hourlyRate = r.hourly_rate == null ? null : Number(r.hourly_rate);
    // Monthly basic salary and allowance (null: paid the daily rate).
    out.basicSalary = r.basic_salary == null ? null : Number(r.basic_salary);
    out.allowance = r.allowance == null ? null : Number(r.allowance);
    out.ssnitNumber = r.ssnit_number || null;
    out.tin = r.tin || null;
  }
  return out;
}

// A date of birth as typed: empty clears it; otherwise a real date that
// makes the person between 14 and 100 years old today.
function birthDate(v) {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;
  var d = V.date(String(v).trim(), 'Date of birth');
  var t = new Date(d + 'T00:00:00Z');
  if (isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) fail('invalid', 'Date of birth must be a valid date.');
  var age = (Date.now() - t.getTime()) / (365.25 * 86400000);
  if (age < 14 || age > 100) fail('invalid', 'Date of birth looks wrong: check the year.');
  return d;
}

// SSNIT number / TIN as typed: trimmed, upper case, spaces dropped; empty
// clears it. Letters, digits and dashes only (an old SSNIT number like
// C018306020094, a Ghana Card number like GHA-123456789-0).
function idNumber(v, label) {
  if (v === undefined) return undefined;
  var t = String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
  if (!t) return null;
  if (!/^[A-Z0-9-]{5,24}$/.test(t)) fail('invalid', label + ' can only have letters, numbers and dashes (5 to 24 of them).');
  return t;
}
// Which other employee already has this SSNIT number or TIN, if any.
async function idTaken(column, value, exceptId, label) {
  if (!value) return;
  var r = (await pool.query('SELECT first_name, last_name FROM employees WHERE upper(' + column + ') = $1 AND ($2::uuid IS NULL OR id <> $2)', [value, exceptId || null])).rows[0];
  if (r) fail('conflict', label + ' ' + value + ' is already on ' + r.first_name + ' ' + r.last_name + '\'s record.');
}

// A second shift in the day (migration 0112): start and end together, or
// neither. Returns undefined when not given, null to clear.
function secondShift(p) {
  if (p.secondShiftStart === undefined && p.secondShiftEnd === undefined) return undefined;
  var a = p.secondShiftStart ? V.time(p.secondShiftStart, 'Second shift start') : null;
  var b = p.secondShiftEnd ? V.time(p.secondShiftEnd, 'Second shift end') : null;
  if (!a !== !b) fail('invalid', 'Give the second shift a start and an end time, or leave both empty.');
  if (a && a === b) fail('invalid', 'The second shift must end at a different time than it starts.');
  return a ? { start: a, end: b } : null;
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
  await addDirectoryFacts(ctx, out);
  return out;
}

// For the directory: who is on approved leave today (and until when),
// who has the OS open right now (the same "online" as Messages: seen in the
// last two minutes), for HR (employee.write) whether each person can sign
// in, and, for whoever may see everyone's attendance, today's clock-in.
var ONLINE_MS = 2 * 60 * 1000;
async function addDirectoryFacts(ctx, list) {
  var ids = list.map(function (e) { return e.id; });
  if (!ids.length) return;
  var leave = await pool.query(
    "SELECT employee_id, to_char(max(end_date), 'YYYY-MM-DD') AS until FROM leave_requests " +
    "WHERE status = 'approved' AND employee_id = ANY($1) AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE GROUP BY employee_id",
    [ids]
  );
  var until = {};
  leave.rows.forEach(function (l) { until[l.employee_id] = l.until; });
  var logins = {};
  var canSeeLogins = ctx.can('employee.write');
  if (canSeeLogins) {
    var users = await pool.query('SELECT employee_id, status, last_login_at FROM users WHERE employee_id = ANY($1)', [ids]);
    users.rows.forEach(function (u) { logins[u.employee_id] = { status: u.status, lastLoginAt: u.last_login_at }; });
  }
  var seen = {};
  (await pool.query('SELECT id, last_seen_at FROM employees WHERE id = ANY($1) AND last_seen_at IS NOT NULL', [ids])).rows.forEach(function (r) { seen[r.id] = r.last_seen_at; });
  var today = null;
  if (ctx.can('attendance.read.all')) {
    today = {};
    (await pool.query(
      'SELECT DISTINCT ON (employee_id) employee_id, clock_in, clock_out, status FROM attendance WHERE employee_id = ANY($1) AND date = $2 ORDER BY employee_id, shift_no',
      [ids, new Date().toISOString().slice(0, 10)])).rows.forEach(function (r) {
      today[r.employee_id] = { status: r.status, clockIn: r.clock_in ? String(r.clock_in).slice(0, 5) : null, clockOut: r.clock_out ? String(r.clock_out).slice(0, 5) : null };
    });
  }
  list.forEach(function (e) {
    e.onLeaveUntil = until[e.id] || null;
    e.online = !!seen[e.id] && Date.now() - new Date(seen[e.id]).getTime() < ONLINE_MS;
    if (canSeeLogins) e.login = logins[e.id] || null;
    if (today) e.today = today[e.id] || null;
  });
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
  await assertDepartmentInReach(ctx, departmentId);
  var positionTitle = V.text(p.positionTitle, 'Job title', 60);
  var employmentType = V.oneOf(p.employmentType || 'permanent', ['permanent', 'contract', 'casual', 'day_rate'], 'Employment type');
  var hireDate = V.date(p.hireDate || new Date().toISOString().slice(0, 10), 'Hire date');
  var dateOfBirth = birthDate(p.dateOfBirth) || null;
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

  // Same compensation gate as update() — but silently ignored rather than
  // a hard failure when unset/lacking payroll.manage, since this is
  // optional reference data (e.g. an imported TimeStation rate), not a
  // user-facing form field where failing loudly would matter.
  var hourlyRate = null;
  if (p.hourlyRate !== undefined && p.hourlyRate !== null && p.hourlyRate !== '' && ctx.can('payroll.manage')) {
    hourlyRate = Math.max(0, Number(p.hourlyRate) || 0);
  }
  var ssnitNumber = null, tin = null;
  if (ctx.can('payroll.manage')) {
    ssnitNumber = idNumber(p.ssnitNumber, 'SSNIT number') || null;
    tin = idNumber(p.tin, 'TIN') || null;
    await idTaken('ssnit_number', ssnitNumber, null, 'SSNIT number');
    await idTaken('tin', tin, null, 'TIN');
  }

  // The ID given, or the next free BPL-nnn.
  var code;
  if (p.code != null && String(p.code).trim()) { code = codes.normalize(p.code); await codes.mustBeFree(pool, code, null); }
  else code = await codes.next(pool);
  var second = secondShift(p);
  var settingsRes = await pool.query('SELECT plants FROM settings WHERE id = 1');
  var defaultLocation = (settingsRes.rows[0] && settingsRes.rows[0].plants[0]) || '';

  return withTransaction(async function (client) {
    var insertRes = await client.query(
      'INSERT INTO employees (code, first_name, last_name, email, phone, department_id, position_title, manager_id, employment_type, hire_date, status, location, shift, shift_start, shift_end, shift_id, hourly_rate, language, ssnit_number, tin, work_days, second_shift_start, second_shift_end, date_of_birth) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *",
      [code, firstName, lastName, email, (p.phone || '').trim(), departmentId, positionTitle, p.managerId || null,
        employmentType, hireDate, p.location || defaultLocation, p.shift || 'Day · 07:00–16:00', shiftStart, shiftEnd, shiftId, hourlyRate,
        p.language ? V.oneOf(p.language, ['en', 'fr', 'zh'], 'Language') : null, ssnitNumber, tin,
        p.workDays ? V.oneOf(p.workDays, WORK_WEEKS, 'Work week') : null,
        second ? second.start : null, second ? second.end : null, dateOfBirth]
    );
    var e = insertRes.rows[0];

    // Not netted against public holidays — an employee's total leave days
    // is manually split across leave types (e.g. 20 days as 5+5+4+6+0),
    // so subtracting the same full-year company holiday count from each
    // small slice independently would over-subtract (12 holidays counted
    // 4 times over would zero out every type on a 20-day total alone).
    // Holidays are instead handled per-request — a holiday date inside an
    // approved request isn't charged against the balance, the same way
    // Sundays already aren't (businessDays() in leave.service.js's
    // requestLeave()).
    var year = new Date().getFullYear();
    var typesRes = await client.query('SELECT id, days_per_year FROM leave_types WHERE active');
    for (var i = 0; i < typesRes.rows.length; i++) {
      var entitled = typesRes.rows[i].days_per_year;
      await client.query(
        'INSERT INTO leave_balances (employee_id, leave_type_id, year, entitled, used) VALUES ($1,$2,$3,$4,0)',
        [e.id, typesRes.rows[i].id, year, entitled]
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

// Someone limited to some companies (viewScope.service.js) can only put
// people into departments of those companies — not add or move someone to
// where they would no longer see them.
async function assertDepartmentInReach(ctx, departmentId) {
  if (!(await visibleEmployee(ctx, { id: null, department_id: departmentId, manager_id: null }))) {
    fail('forbidden', 'That department belongs to a company outside the ones you can see.');
  }
}

// kernel.js: handlers['employees.update']
//
// Checks visibleEmployee (rbac.assertVisibleEmployee): HR-type roles can be
// limited to some companies (viewScope.service.js), so someone outside them
// can't be reached here either.
async function update(ctx, id, p) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  await assertVisibleEmployee(ctx, id);
  if (p.departmentId) await assertDepartmentInReach(ctx, p.departmentId);
  // Pay rate/cycle are compensation data — gated separately behind
  // payroll.manage so a department manager with plain employee.write
  // (who can otherwise edit this same record) can't set someone's pay.
  if ((p.payCycle !== undefined || p.dailyRate !== undefined || p.hourlyRate !== undefined || p.ssnitNumber !== undefined || p.tin !== undefined || p.basicSalary !== undefined || p.allowance !== undefined) && !ctx.can('payroll.manage')) {
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
  var second = secondShift(p);
  if (second !== undefined) {
    var cur2 = e.second_shift_start ? String(e.second_shift_start).slice(0, 5) + '-' + String(e.second_shift_end).slice(0, 5) : null;
    if ((second ? second.start + '-' + second.end : null) !== cur2) {
      changed.push('secondShift');
      values.push(second ? second.start : null); sets.push('second_shift_start = $' + values.length);
      values.push(second ? second.end : null); sets.push('second_shift_end = $' + values.length);
    }
  }
  if (p.workDays !== undefined) {
    var workDays = p.workDays ? V.oneOf(p.workDays, WORK_WEEKS, 'Work week') : null;
    if (workDays !== (e.work_days || null)) { changed.push('workDays'); values.push(workDays); sets.push('work_days = $' + values.length); }
  }
  if (p.dateOfBirth !== undefined) {
    var dob = birthDate(p.dateOfBirth);
    if (dob !== (e.date_of_birth ? String(e.date_of_birth).slice(0, 10) : null)) { changed.push('dateOfBirth'); values.push(dob); sets.push('date_of_birth = $' + values.length); }
  }
  // The kiosk's language for them; empty clears back to their account's.
  if (p.language !== undefined) {
    var language = p.language ? V.oneOf(p.language, ['en', 'fr', 'zh'], 'Language') : null;
    if (language !== (e.language || null)) { changed.push('language'); values.push(language); sets.push('language = $' + values.length); }
  }
  var shiftIdUpdate = await resolveShiftIdUpdate(p, e);
  if (shiftIdUpdate !== undefined && shiftIdUpdate !== e.shift_id) {
    changed.push('shiftId'); values.push(shiftIdUpdate); sets.push('shift_id = $' + values.length);
  }
  if (p.dailyRate !== undefined) {
    var dailyRate = Math.max(0, Number(p.dailyRate) || 0);
    if (dailyRate !== Number(e.daily_rate)) { changed.push('dailyRate'); values.push(dailyRate); sets.push('daily_rate = $' + values.length); }
  }
  // Nullable, unlike dailyRate — "" clears back to "not set" rather than 0,
  // since a report should be able to tell "no rate on file" apart from
  // "genuinely unpaid."
  if (p.hourlyRate !== undefined) {
    var hourlyRate = p.hourlyRate === null || p.hourlyRate === '' ? null : Math.max(0, Number(p.hourlyRate) || 0);
    var curHourlyRate = e.hourly_rate == null ? null : Number(e.hourly_rate);
    if (hourlyRate !== curHourlyRate) { changed.push('hourlyRate'); values.push(hourlyRate); sets.push('hourly_rate = $' + values.length); }
  }

  // Monthly basic and allowance; empty clears (back to the daily rate).
  [['basicSalary', 'basic_salary', 'Basic salary'], ['allowance', 'allowance', 'Allowance']].forEach(function (f) {
    if (p[f[0]] === undefined) return;
    var v = p[f[0]] === null || p[f[0]] === '' ? null : Number(p[f[0]]);
    if (v !== null && !(v >= 0)) fail('invalid', f[2] + ' must be an amount of zero or more.');
    if (v !== null) v = Math.round(v * 100) / 100;
    var cur = e[f[1]] == null ? null : Number(e[f[1]]);
    if (v !== cur) { changed.push(f[0]); values.push(v); sets.push(f[1] + ' = $' + values.length); }
  });
  if (p.allowance !== undefined && p.allowance !== null && p.allowance !== '' && Number(p.allowance) > 0 &&
      (p.basicSalary !== undefined ? (p.basicSalary === null || p.basicSalary === '') : e.basic_salary == null)) {
    fail('invalid', 'Give a basic salary too: the allowance is paid with it.');
  }
  var ssnitNumber = idNumber(p.ssnitNumber, 'SSNIT number');
  if (ssnitNumber !== undefined && ssnitNumber !== (e.ssnit_number || null)) {
    await idTaken('ssnit_number', ssnitNumber, id, 'SSNIT number');
    changed.push('ssnitNumber'); values.push(ssnitNumber); sets.push('ssnit_number = $' + values.length);
  }
  var tin = idNumber(p.tin, 'TIN');
  if (tin !== undefined && tin !== (e.tin || null)) {
    await idTaken('tin', tin, id, 'TIN');
    changed.push('tin'); values.push(tin); sets.push('tin = $' + values.length);
  }

  if (p.code !== undefined) {
    var code = codes.normalize(p.code);
    if (code !== e.code) { await codes.mustBeFree(pool, code, id); changed.push('code'); values.push(code); sets.push('code = $' + values.length); }
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
// Checks visibleEmployee, as update() does.
async function terminate(ctx, id, reason) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  await assertVisibleEmployee(ctx, id);
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
    "SELECT t.id, t.wo_no, t.title, t.status, t.due_date FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id WHERE ta.employee_id = $1 AND t.status NOT IN ('completed', 'cancelled') ORDER BY t.due_date NULLS LAST, t.wo_no",
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
    tasks: tasksRes.rows.map(function (t) { return { id: t.id, number: 'WO-' + String(t.wo_no).padStart(4, '0'), title: t.title, status: t.status, dueDate: t.due_date }; })
  };
}

module.exports = { list: list, get: get, create: create, update: update, terminate: terminate, purgeTerminated: purgeTerminated, profile: profile, rowToEmployee: rowToEmployee };
