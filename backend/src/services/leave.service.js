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

function rowToLeaveType(r) {
  return { id: r.id, name: r.name, daysPerYear: r.days_per_year, paid: r.paid, active: r.active };
}

// kernel.js: handlers['leave.types.all'] — the admin management list:
// every leave type including inactive ones (unlike listTypes() above,
// which is what the "request leave" picker shows), so HR/Admin can see
// and edit a type without it ever appearing as choosable again — reviving
// one is a deliberate "Active" toggle, not just editing its other fields.
async function listAllTypes(ctx) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var res = await pool.query('SELECT id, name, days_per_year, paid, active FROM leave_types ORDER BY active DESC, name');
  return res.rows.map(rowToLeaveType);
}

function validateDaysPerYear(v) {
  var n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail('invalid', 'Days per year must be a whole number, 0 or more.');
  return n;
}

// kernel.js: handlers['leave.types.create']
async function createType(ctx, p) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var name = V.text(p.name, 'Name', 60);
  var daysPerYear = validateDaysPerYear(p.daysPerYear);
  var paid = !!p.paid;
  var res = await pool.query('INSERT INTO leave_types (name, days_per_year, paid) VALUES ($1,$2,$3) RETURNING *', [name, daysPerYear, paid]);
  await audit(pool, ctx, 'leave.type.create', 'leave_type', res.rows[0].id, 'Created leave type "' + name + '" (' + daysPerYear + ' day(s)/year).');
  return rowToLeaveType(res.rows[0]);
}

// kernel.js: handlers['leave.types.update'] — every field optional so the
// admin screen can send just the one thing that changed (e.g. only
// toggling Active off doesn't need to resend name/days/paid).
async function updateType(ctx, id, p) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var res = await pool.query('SELECT * FROM leave_types WHERE id = $1', [id]);
  var type = res.rows[0];
  if (!type) fail('notfound', 'Leave type not found.');

  var name = p.name !== undefined ? V.text(p.name, 'Name', 60) : type.name;
  var daysPerYear = p.daysPerYear !== undefined ? validateDaysPerYear(p.daysPerYear) : type.days_per_year;
  var paid = p.paid !== undefined ? !!p.paid : type.paid;
  var active = p.active !== undefined ? !!p.active : type.active;

  var updated = await pool.query(
    'UPDATE leave_types SET name = $1, days_per_year = $2, paid = $3, active = $4 WHERE id = $5 RETURNING *',
    [name, daysPerYear, paid, active, id]
  );
  await audit(pool, ctx, 'leave.type.update', 'leave_type', id, 'Updated leave type "' + name + '".');
  return rowToLeaveType(updated.rows[0]);
}

// Internal — an employee's personal annual entitlement for a leave type,
// if HR has ever set one (a promotion, a negotiated offer, a part-year
// proration that should persist year over year instead of resetting to
// the company default every rollover). Falls back to the leave type's own
// days_per_year when no override exists — the ordinary, unremarkable case
// for most employees.
async function resolveDaysPerYear(employeeId, leaveTypeId, typeDaysPerYear) {
  var res = await pool.query(
    'SELECT days_per_year FROM employee_leave_entitlements WHERE employee_id = $1 AND leave_type_id = $2',
    [employeeId, leaveTypeId]
  );
  return res.rows[0] ? res.rows[0].days_per_year : typeDaysPerYear;
}

// kernel.js: handlers['leave.entitlements'] — one employee's personal
// annual entitlement for every active leave type (resolved: their own
// override if set, otherwise the type's company-wide default), so the
// admin screen can show what's actually being granted and which rows are
// a deliberate customization vs. just following the type's default.
async function getEntitlements(ctx, employeeId) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var emp = await fetchEmployeeById(employeeId);
  if (!emp) fail('notfound', 'Employee not found.');

  var typesRes = await pool.query('SELECT id, name, days_per_year FROM leave_types WHERE active ORDER BY name');
  var overridesRes = await pool.query('SELECT leave_type_id, days_per_year FROM employee_leave_entitlements WHERE employee_id = $1', [employeeId]);
  var overrideByType = {};
  overridesRes.rows.forEach(function (r) { overrideByType[r.leave_type_id] = r.days_per_year; });

  return typesRes.rows.map(function (t) {
    var override = overrideByType[t.id];
    return {
      leaveTypeId: t.id, name: t.name, companyDefault: t.days_per_year,
      daysPerYear: override !== undefined ? override : t.days_per_year, isCustom: override !== undefined
    };
  });
}

// A leave_balances row, once granted, is a stored fact — it doesn't
// silently track a leave type or an employee_leave_entitlements override
// as either one changes later. Without this, changing a base entitlement
// would visibly do nothing until the year's balance is next (re)granted
// (next year's rollover, or never, if this year's row already exists),
// which looks like the change didn't work. Called only when the admin
// screen tells us which year they're actually looking at, and only
// touches a row that already exists there — it never creates one (that's
// still rollover's/the self-heal grant's job) and never touches "used".
async function syncBalanceForYear(employeeId, leaveType, year) {
  // Gate on leaveType.paid, not days_per_year > 0 — a type whose company
  // default happens to be 0 (e.g. Maternity/paternity, until HR sets up
  // each eligible employee individually) is still a real, capped balance
  // once a personal override exists; only an actually-unlimited type
  // (Unpaid leave, paid: false) has no balance concept to sync at all.
  if (!year || !leaveType.paid) return;
  var existing = await pool.query('SELECT id FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3', [employeeId, leaveType.id, year]);
  if (!existing.rows[0]) return;
  var emp = await fetchEmployeeById(employeeId);
  var companyId = await employeeCompanyId(emp.department_id);
  var holidays = await countHolidays(companyId, year);
  var resolvedDaysPerYear = await resolveDaysPerYear(employeeId, leaveType.id, leaveType.days_per_year);
  var entitled = Math.max(0, resolvedDaysPerYear - holidays);
  await pool.query('UPDATE leave_balances SET entitled = $1 WHERE id = $2', [entitled, existing.rows[0].id]);
}

// kernel.js: handlers['leave.balances.recalculate'] — force every one of
// this employee's existing balance rows for a year back onto the current
// formula (their resolved entitlement net of that year's holidays), not
// just the one row a Save/Reset on the Base Entitlement table happens to
// touch. Needed because a leave type's company default or a company's
// holiday list can change AFTER a year's balances were already granted —
// nothing walks back and fixes rows nobody's individually re-saved, so
// they're left showing whatever was true at grant time. Only touches
// rows that already exist (never creates one — that's rollover's/the
// self-heal grant's job) and never touches "used".
async function recalculateBalances(ctx, employeeId, year) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var emp = await fetchEmployeeById(employeeId);
  if (!emp) fail('notfound', 'Employee not found.');
  year = Number(year);
  if (!Number.isInteger(year)) fail('invalid', 'Invalid year.');

  var typesRes = await pool.query('SELECT id, name, days_per_year, paid FROM leave_types WHERE active');
  var updated = 0;
  for (var i = 0; i < typesRes.rows.length; i++) {
    var before = await pool.query('SELECT entitled FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3', [employeeId, typesRes.rows[i].id, year]);
    if (!before.rows[0]) continue;
    await syncBalanceForYear(employeeId, typesRes.rows[i], year);
    var after = await pool.query('SELECT entitled FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3', [employeeId, typesRes.rows[i].id, year]);
    if (after.rows[0].entitled !== before.rows[0].entitled) updated++;
  }
  await audit(pool, ctx, 'leave.balances.recalculate', 'employee', emp.id, 'Recalculated ' + emp.first_name + ' ' + emp.last_name + '’s ' + year + ' leave balances against current policy (' + updated + ' changed).');
  return { year: year, updated: updated, checked: typesRes.rows.length };
}

// kernel.js: handlers['leave.entitlements.set']
async function setEntitlement(ctx, p) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var emp = await fetchEmployeeById(p.employeeId);
  if (!emp) fail('notfound', 'Employee not found.');
  var typeRes = await pool.query('SELECT * FROM leave_types WHERE id = $1', [p.leaveTypeId]);
  var type = typeRes.rows[0];
  if (!type) fail('invalid', 'Unknown leave type.');
  var daysPerYear = validateDaysPerYear(p.daysPerYear);

  await pool.query(
    'INSERT INTO employee_leave_entitlements (employee_id, leave_type_id, days_per_year) VALUES ($1,$2,$3) ' +
    'ON CONFLICT (employee_id, leave_type_id) DO UPDATE SET days_per_year = $3',
    [emp.id, type.id, daysPerYear]
  );
  await syncBalanceForYear(emp.id, type, p.year ? Number(p.year) : null);
  await audit(pool, ctx, 'leave.entitlement.set', 'employee', emp.id, 'Set ' + emp.first_name + ' ' + emp.last_name + '’s personal ' + type.name.toLowerCase() + ' entitlement to ' + daysPerYear + ' day(s)/year.');
  return { leaveTypeId: type.id, name: type.name, companyDefault: type.days_per_year, daysPerYear: daysPerYear, isCustom: true };
}

// kernel.js: handlers['leave.entitlements.clear'] — removes the personal
// override, reverting the employee to the leave type's company-wide
// default going forward.
async function clearEntitlement(ctx, employeeId, leaveTypeId, year) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var res = await pool.query('DELETE FROM employee_leave_entitlements WHERE employee_id = $1 AND leave_type_id = $2 RETURNING id', [employeeId, leaveTypeId]);
  if (!res.rows[0]) fail('notfound', 'No custom entitlement set for that employee/leave type.');
  var typeRes = await pool.query('SELECT * FROM leave_types WHERE id = $1', [leaveTypeId]);
  if (typeRes.rows[0]) await syncBalanceForYear(employeeId, typeRes.rows[0], year ? Number(year) : null);
  var emp = await fetchEmployeeById(employeeId);
  await audit(pool, ctx, 'leave.entitlement.clear', 'employee', employeeId, 'Reverted ' + (emp ? emp.first_name + ' ' + emp.last_name : 'an employee') + '’s leave entitlement to the company default.');
  return { ok: true };
}

// kernel.js: handlers['leave.balances'] — every active leave type's
// entitled/used for one employee/year, HR/Admin-only (this is the
// underlying entitlement, not the self-service summary me.routes.js
// already exposes to an employee about their own balance). Synthesizes a
// zero-entitled row for any active type with no leave_balances row yet
// (nothing there to edit otherwise) rather than omitting it.
async function getBalances(ctx, employeeId, year) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  year = year ? Number(year) : new Date().getFullYear();
  if (!Number.isInteger(year)) fail('invalid', 'Invalid year.');
  var emp = await fetchEmployeeById(employeeId);
  if (!emp) fail('notfound', 'Employee not found.');
  var companyId = await employeeCompanyId(emp.department_id);
  var holidays = await countHolidays(companyId, year);

  var typesRes = await pool.query('SELECT id, name, days_per_year, paid FROM leave_types WHERE active ORDER BY name');
  var balRes = await pool.query('SELECT * FROM leave_balances WHERE employee_id = $1 AND year = $2', [employeeId, year]);
  var byType = {};
  balRes.rows.forEach(function (r) { byType[r.leave_type_id] = r; });
  var overridesRes = await pool.query('SELECT leave_type_id, days_per_year FROM employee_leave_entitlements WHERE employee_id = $1', [employeeId]);
  var overrideByType = {};
  overridesRes.rows.forEach(function (r) { overrideByType[r.leave_type_id] = r.days_per_year; });

  return typesRes.rows.map(function (t) {
    var b = byType[t.id];
    // This employee's own gross entitlement (their personal override, if
    // HR ever set one — see employee_leave_entitlements — else the type's
    // company-wide default), not necessarily the same figure another
    // employee on the same type would see.
    var daysPerYear = overrideByType[t.id] !== undefined ? overrideByType[t.id] : t.days_per_year;
    // No row yet — preview what rollover/the next request would actually
    // grant (daysPerYear net of this company's holidays for the year)
    // rather than showing a bare, misleading 0.
    var previewEntitled = daysPerYear > 0 ? Math.max(0, daysPerYear - holidays) : daysPerYear;
    return {
      leaveTypeId: t.id, name: t.name, daysPerYear: daysPerYear, isCustomEntitlement: overrideByType[t.id] !== undefined, paid: t.paid, holidays: holidays,
      entitled: b ? b.entitled : previewEntitled, used: b ? b.used : 0, hasRow: !!b
    };
  });
}

// kernel.js: handlers['leave.balances.set'] — HR/Admin correction of one
// employee's entitled days for one leave type/year: proration for a new
// hire, a one-off correction, above/below the type's flat default. used
// is never editable here — it only ever moves via an approved request
// (decide() below), so it always reflects what's actually been taken.
async function setBalance(ctx, p) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var emp = await fetchEmployeeById(p.employeeId);
  if (!emp) fail('notfound', 'Employee not found.');
  var typeRes = await pool.query('SELECT * FROM leave_types WHERE id = $1', [p.leaveTypeId]);
  var type = typeRes.rows[0];
  if (!type) fail('invalid', 'Unknown leave type.');
  var year = Number(p.year);
  if (!Number.isInteger(year)) fail('invalid', 'Invalid year.');
  var entitled = validateDaysPerYear(p.entitled);

  var res = await pool.query(
    'INSERT INTO leave_balances (employee_id, leave_type_id, year, entitled, used) VALUES ($1,$2,$3,$4,0) ' +
    'ON CONFLICT (employee_id, leave_type_id, year) DO UPDATE SET entitled = $4 RETURNING *',
    [emp.id, type.id, year, entitled]
  );
  await audit(pool, ctx, 'leave.balance.set', 'employee', emp.id, 'Set ' + emp.first_name + ' ' + emp.last_name + '’s ' + year + ' ' + type.name.toLowerCase() + ' entitlement to ' + entitled + ' day(s).');
  return { leaveTypeId: type.id, name: type.name, entitled: entitled, used: res.rows[0].used };
}

function rowToHoliday(r) {
  return { id: r.id, companyId: r.company_id, date: r.date, name: r.name };
}

// kernel.js: handlers['leave.holidays'] — one company's public holidays.
// Each company keeps its own list (a restaurant/bar can stay open on a
// day the factory closes for) — used two ways: shrinking what a leave
// type actually grants for that company/year (countHolidays below) and
// excluding a holiday date from an individual request's day count
// (businessDays() in utils/validate.js), the same way Sundays already are.
async function listHolidays(ctx, companyId, year) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var args = [companyId];
  var where = 'company_id = $1';
  if (year) { args.push(String(year) + '-01-01', String(year) + '-12-31'); where += ' AND date BETWEEN $2 AND $3'; }
  var res = await pool.query('SELECT * FROM holidays WHERE ' + where + ' ORDER BY date', args);
  return res.rows.map(rowToHoliday);
}

// kernel.js: handlers['leave.holidays.add']
async function addHoliday(ctx, p) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var date = V.date(p.date, 'Date');
  var name = V.text(p.name, 'Name', 100);
  var companyRes = await pool.query('SELECT id, name FROM companies WHERE id = $1', [p.companyId]);
  var company = companyRes.rows[0];
  if (!company) fail('invalid', 'Unknown company.');
  try {
    var res = await pool.query('INSERT INTO holidays (company_id, date, name) VALUES ($1,$2,$3) RETURNING *', [company.id, date, name]);
    await audit(pool, ctx, 'leave.holiday.add', 'holiday', res.rows[0].id, 'Added ' + company.name + ' holiday: ' + name + ' (' + date + ').');
    return rowToHoliday(res.rows[0]);
  } catch (err) {
    if (err.code === '23505') fail('conflict', 'That date is already a holiday for ' + company.name + '.');
    throw err;
  }
}

// kernel.js: handlers['leave.holidays.remove']
async function removeHoliday(ctx, id) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var res = await pool.query('DELETE FROM holidays WHERE id = $1 RETURNING *', [id]);
  if (!res.rows[0]) fail('notfound', 'Holiday not found.');
  await audit(pool, ctx, 'leave.holiday.remove', 'holiday', id, 'Removed holiday: ' + res.rows[0].name + ' (' + res.rows[0].date + ').');
  return { ok: true };
}

// Internal — how many of a company's holidays fall in a given year.
// Always clamp-floored at 0 wherever this is subtracted from a leave
// type's days_per_year (Math.max(0, ...) at each call site below), so a
// company with more holidays than a type's flat default never grants a
// negative entitlement.
async function countHolidays(companyId, year) {
  if (!companyId) return 0;
  var res = await pool.query(
    'SELECT count(*)::int AS n FROM holidays WHERE company_id = $1 AND date BETWEEN $2 AND $3',
    [companyId, String(year) + '-01-01', String(year) + '-12-31']
  );
  return res.rows[0].n;
}

// Internal — the actual set of a company's holiday dates ('YYYY-MM-DD',
// same string shape V.date/pool.js's DATE parser already use throughout
// this file) between two dates, for businessDays() to exclude from one
// specific request's day count.
async function holidayDatesInRange(companyId, start, end) {
  if (!companyId) return new Set();
  var res = await pool.query('SELECT date FROM holidays WHERE company_id = $1 AND date BETWEEN $2 AND $3', [companyId, start, end]);
  return new Set(res.rows.map(function (r) { return r.date; }));
}

// Internal — an employee's company_id via their department. Several
// callers need this (requestLeave, rollover, getBalances) since
// holidays.company_id is per-company but ctx.employee/employees rows only
// carry department_id.
async function employeeCompanyId(departmentId) {
  var res = await pool.query('SELECT company_id FROM departments WHERE id = $1', [departmentId]);
  return res.rows[0] ? res.rows[0].company_id : null;
}

// kernel.js: handlers['leave.rollover'] — bulk-grants every active
// employee a balance row for the given year, per active leave type, using
// that type's current days_per_year default. The same grant
// employees.service.js's create() already gives a brand-new hire
// automatically, just run in bulk for an existing headcount at the start
// of a new year. Idempotent (ON CONFLICT DO NOTHING) so it never clobbers
// a custom entitled value HR already set via setBalance — re-running it,
// or a stray double-click, is always safe.
async function rollover(ctx, year) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  year = Number(year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail('invalid', 'Enter a valid year.');

  var typesRes = await pool.query('SELECT id, days_per_year, paid FROM leave_types WHERE active');
  var empRes = await pool.query(
    "SELECT e.id, d.company_id FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.status = 'active'"
  );

  // Each company's holiday count for the year, fetched once rather than
  // per employee — cheap even for a large headcount since there are only
  // a handful of companies.
  var companyIds = Array.from(new Set(empRes.rows.map(function (e) { return e.company_id; }).filter(Boolean)));
  var holidaysByCompany = {};
  for (var c = 0; c < companyIds.length; c++) holidaysByCompany[companyIds[c]] = await countHolidays(companyIds[c], year);

  // Every personal entitlement override, fetched once and keyed by
  // "employeeId:leaveTypeId" — an N+1 query per employee/type here would
  // otherwise mean hundreds of round-trips for a real headcount.
  var overridesRes = await pool.query('SELECT employee_id, leave_type_id, days_per_year FROM employee_leave_entitlements');
  var overrideByKey = {};
  overridesRes.rows.forEach(function (r) { overrideByKey[r.employee_id + ':' + r.leave_type_id] = r.days_per_year; });

  var granted = 0;
  for (var i = 0; i < empRes.rows.length; i++) {
    var holidays = holidaysByCompany[empRes.rows[i].company_id] || 0;
    for (var j = 0; j < typesRes.rows.length; j++) {
      var typeDaysPerYear = typesRes.rows[j].days_per_year;
      var override = overrideByKey[empRes.rows[i].id + ':' + typesRes.rows[j].id];
      var resolvedDaysPerYear = override !== undefined ? override : typeDaysPerYear;
      // Gate on paid, not typeDaysPerYear > 0 — see syncBalanceForYear's
      // comment: a type whose company default is 0 (e.g. Maternity/
      // paternity) still needs a real, capped grant for an employee with
      // a personal override; only an actually-unlimited type (paid: false)
      // has no balance to grant at all.
      var entitled = typesRes.rows[j].paid ? Math.max(0, resolvedDaysPerYear - holidays) : typeDaysPerYear;
      var insertRes = await pool.query(
        'INSERT INTO leave_balances (employee_id, leave_type_id, year, entitled, used) VALUES ($1,$2,$3,$4,0) ' +
        'ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING',
        [empRes.rows[i].id, typesRes.rows[j].id, year, entitled]
      );
      granted += insertRes.rowCount;
    }
  }
  await audit(pool, ctx, 'leave.rollover', 'leave_type', String(year), 'Granted ' + year + ' leave balances (' + granted + ' new record(s), ' + empRes.rows.length + ' active employee(s)).');
  return { year: year, granted: granted, employees: empRes.rows.length, types: typesRes.rows.length };
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

  var companyId = await employeeCompanyId(ctx.employee.department_id);
  var holidaySet = await holidayDatesInRange(companyId, start, end);
  var days = businessDays(start, end, holidaySet);
  if (days <= 0) fail('invalid', 'That range has no working days to take as leave (weekends and public holidays are already excluded).');

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
  // Gate on type.paid, not type.days_per_year > 0 — a type whose company
  // default happens to be 0 (e.g. Maternity/paternity, until HR sets up
  // each eligible employee individually) still needs real enforcement
  // once this employee has a personal override; only a genuinely
  // unlimited type (Unpaid leave, paid: false) skips balance tracking
  // altogether. Using the flat default here used to mean an employee
  // with, say, a 4-day Maternity override could take unlimited days —
  // the enforcement check below never even ran.
  if (type.paid) {
    if (!bal) {
      // No balance row for this year yet — a new year started since this
      // employee last got one (see rollover() below, the proactive bulk
      // version of this same grant), or this leave type didn't exist when
      // they were hired. Auto-grant this employee's own entitlement now
      // (their personal override if HR set one, else the type's
      // company-wide default — see resolveDaysPerYear — net of this
      // company's holidays for the year) rather than either silently
      // letting the request through unlimited (the bug this replaces — an
      // absent row used to skip the check entirely) or blocking someone
      // who's genuinely entitled.
      var holidaysThisYear = await countHolidays(companyId, year);
      var resolvedDaysPerYear = await resolveDaysPerYear(ctx.employee.id, type.id, type.days_per_year);
      var grantEntitled = Math.max(0, resolvedDaysPerYear - holidaysThisYear);
      var insertBalRes = await pool.query(
        'INSERT INTO leave_balances (employee_id, leave_type_id, year, entitled, used) VALUES ($1,$2,$3,$4,0) RETURNING *',
        [ctx.employee.id, type.id, year, grantEntitled]
      );
      bal = insertBalRes.rows[0];
    }
    if (days > bal.entitled - bal.used) {
      fail('invalid', 'That exceeds your remaining ' + type.name.toLowerCase() + ' (' + (bal.entitled - bal.used) + ' days left).');
    }
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

module.exports = {
  listTypes: listTypes, list: list, requestLeave: requestLeave, decide: decide, cancel: cancel, rowToLeaveRequest: rowToLeaveRequest,
  listAllTypes: listAllTypes, createType: createType, updateType: updateType,
  getBalances: getBalances, setBalance: setBalance, rollover: rollover, recalculateBalances: recalculateBalances,
  listHolidays: listHolidays, addHoliday: addHoliday, removeHoliday: removeHoliday,
  getEntitlements: getEntitlements, setEntitlement: setEntitlement, clearEntitlement: clearEntitlement
};
