var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V, businessDays } = require('../utils/validate');
var { restWeekdays } = require('../utils/workWeek');
var { audit } = require('../utils/audit');
var { visibleEmployee, fetchEmployeeById, assertVisibleEmployee } = require('../middleware/rbac');

// One yearly leave total per person (migration 0123).
//
// Each employee has the total management agreed with them (employees.
// leave_days_total), or else their company's default (companies.
// leave_days_default). Annual, compassionate and sick leave — every leave
// type marked in_pool — all come out of it. The year's company holidays
// come off it on 1 January: 14 days with 13 holidays leaves 1. Each year
// counts its own holidays, so a year with fewer leaves more, and a holiday
// added or removed during the year changes the balance at once — nothing
// is stored, it is worked out from the holiday list every time.
//
// Taking more than is left is allowed: the days over are owed to the
// company. Nothing is deducted by itself — HR settles each case (from pay,
// from next year's leave, waived) and the settlement is recorded.
//
// A holiday inside someone's leave isn't charged again (businessDays()
// already leaves holidays out of a request's day count). Unpaid leave and
// maternity/paternity are outside the pool, with their own rules.
//
// Someone with no total and no company default has no pool: their leave
// types keep the older per-type allowances until HR sets one.

function yearRange(year) { return [String(year) + '-01-01', String(year) + '-12-31']; }

async function companyOf(employeeId) {
  return (await pool.query(
    'SELECT e.id, e.first_name, e.last_name, e.leave_days_total, e.work_days, d.company_id, c.name AS company_name, c.leave_days_default ' +
    'FROM employees e JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id WHERE e.id = $1', [employeeId])).rows[0];
}

// The pool for many employees at once (or one): { employeeId: summary }.
async function poolsFor(employeeIds, year) {
  var out = {};
  if (!employeeIds.length) return out;
  var r = yearRange(year);
  var emps = (await pool.query(
    'SELECT e.id, e.leave_days_total, d.company_id, c.leave_days_default FROM employees e JOIN departments d ON d.id = e.department_id ' +
    'JOIN companies c ON c.id = d.company_id WHERE e.id = ANY($1::uuid[])', [employeeIds])).rows;
  var holidays = {};
  (await pool.query('SELECT company_id, count(*)::int AS n FROM holidays WHERE date BETWEEN $1 AND $2 GROUP BY company_id', r)).rows
    .forEach(function (h) { holidays[h.company_id] = h.n; });
  var taken = {};
  (await pool.query(
    "SELECT lr.employee_id, lr.status, sum(lr.days)::float AS days FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id " +
    "WHERE lt.in_pool AND lr.status IN ('approved', 'pending') AND lr.start_date BETWEEN $2 AND $3 AND lr.employee_id = ANY($1::uuid[]) " +
    'GROUP BY lr.employee_id, lr.status', [employeeIds, r[0], r[1]])).rows
    .forEach(function (t) { (taken[t.employee_id] = taken[t.employee_id] || {})[t.status] = t.days; });
  // Approved days per leave type, for the HR window's per-type "taken".
  var byType = {};
  (await pool.query(
    "SELECT lr.employee_id, lr.leave_type_id, sum(lr.days)::float AS days FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id " +
    "WHERE lt.in_pool AND lr.status = 'approved' AND lr.start_date BETWEEN $2 AND $3 AND lr.employee_id = ANY($1::uuid[]) GROUP BY lr.employee_id, lr.leave_type_id",
    [employeeIds, r[0], r[1]])).rows.forEach(function (t) { (byType[t.employee_id] = byType[t.employee_id] || {})[t.leave_type_id] = t.days; });
  var settled = {};
  (await pool.query('SELECT employee_id, sum(days)::float AS days FROM leave_owed_settlements WHERE year = $1 AND employee_id = ANY($2::uuid[]) GROUP BY employee_id', [year, employeeIds])).rows
    .forEach(function (s) { settled[s.employee_id] = s.days; });
  emps.forEach(function (e) {
    var own = e.leave_days_total, def = e.leave_days_default;
    var total = own !== null && own !== undefined ? own : (def !== null && def !== undefined ? def : null);
    var hol = holidays[e.company_id] || 0;
    var used = (taken[e.id] && taken[e.id].approved) || 0;
    var pending = (taken[e.id] && taken[e.id].pending) || 0;
    var available = total === null ? null : total - hol;
    var left = total === null ? null : available - used;
    var owed = left === null ? 0 : Math.max(0, -left);
    var settledDays = settled[e.id] || 0;
    out[e.id] = {
      year: year, inEffect: total !== null,
      total: total, totalFrom: own !== null && own !== undefined ? 'employee' : (total !== null ? 'company' : null),
      holidays: hol, available: available, used: used, pending: pending,
      left: left === null ? null : Math.max(0, left),
      owed: owed, settled: settledDays, owedOutstanding: Math.max(0, owed - settledDays),
      usedByType: byType[e.id] || {}
    };
  });
  return out;
}

async function poolFor(employeeId, year) {
  return (await poolsFor([employeeId], year))[employeeId] || null;
}

// What a request would do, before it is sent: its working days (holidays
// and rest days left out) and, for a leave type in the pool, what would be
// left — or owed — if it were approved, counting requests still waiting.
async function previewRequest(ctx, p) {
  var employeeId = p.employeeId || (ctx.employee && ctx.employee.id);
  if (!employeeId) fail('invalid', 'No employee.');
  if (employeeId !== ctx.employee.id) await assertVisibleEmployee(ctx, employeeId);
  var start = V.date(p.startDate, 'Start date');
  var end = V.date(p.endDate, 'End date');
  if (end < start) fail('invalid', 'The end date cannot be before the start date.');
  var type = (await pool.query('SELECT * FROM leave_types WHERE id = $1 AND active', [p.leaveTypeId])).rows[0];
  if (!type) fail('invalid', 'Choose a leave type.');
  var emp = await companyOf(employeeId);
  if (!emp) fail('notfound', 'Employee not found.');
  var hols = new Set((await pool.query('SELECT date FROM holidays WHERE company_id = $1 AND date BETWEEN $2 AND $3', [emp.company_id, start, end])).rows.map(function (h) { return h.date; }));
  var days = businessDays(start, end, hols, restWeekdays(emp.work_days));
  var year = Number(start.slice(0, 4));
  var summary = type.in_pool ? await poolFor(employeeId, year) : null;
  var out = { days: days, year: year, inPool: !!type.in_pool && !!(summary && summary.inEffect), pool: summary && summary.inEffect ? summary : null, wouldOwe: 0 };
  if (out.inPool) out.wouldOwe = owedAfter(summary, days + summary.pending);
  return out;
}

// Days owed (still to settle) once `more` days are taken on top of what
// is already used.
function owedAfter(summary, more) {
  var after = summary.available - summary.used - more;
  return Math.max(0, Math.max(0, -after) - summary.settled);
}

// ── owed days: the HR list, and settling them ──────────────────────────

function canManage(ctx) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
}

// Everyone visible who owes days this year (or has settled some), with
// what they owe, what was settled and how.
async function owedList(ctx, year) {
  canManage(ctx);
  year = Number(year) || new Date().getFullYear();
  var ids = (await pool.query("SELECT id FROM employees WHERE status = 'active'")).rows.map(function (r) { return r.id; });
  var pools = await poolsFor(ids, year);
  var who = Object.keys(pools).filter(function (id) { return pools[id].owed > 0 || pools[id].settled > 0; });
  if (!who.length) return { year: year, people: [] };
  var info = (await pool.query(
    'SELECT e.id, e.code, e.first_name, e.last_name, e.department_id, d.name AS department, c.name AS company FROM employees e ' +
    'JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id WHERE e.id = ANY($1::uuid[])', [who])).rows;
  var history = {};
  (await pool.query(
    "SELECT s.*, (b.first_name || ' ' || b.last_name) AS by_name FROM leave_owed_settlements s LEFT JOIN employees b ON b.id = s.settled_by " +
    'WHERE s.year = $1 AND s.employee_id = ANY($2::uuid[]) ORDER BY s.created_at', [year, who])).rows
    .forEach(function (s) {
      (history[s.employee_id] = history[s.employee_id] || []).push({ id: s.id, days: Number(s.days), how: s.how, note: s.note, by: s.by_name || '', at: s.created_at });
    });
  var people = [];
  for (var i = 0; i < info.length; i++) {
    var e = info[i];
    var target = await fetchEmployeeById(e.id);
    if (!(await visibleEmployee(ctx, target))) continue;
    people.push(Object.assign({ employeeId: e.id, code: e.code, name: e.first_name + ' ' + e.last_name, department: e.department, company: e.company, settlements: history[e.id] || [] }, pools[e.id]));
  }
  people.sort(function (a, b) { return b.owedOutstanding - a.owedOutstanding || a.name.localeCompare(b.name); });
  return { year: year, people: people };
}

var HOW = { pay: 'deducted from pay', next_year: 'taken from next year\'s leave', waived: 'waived', other: 'settled another way' };

async function settle(ctx, p) {
  canManage(ctx);
  await assertVisibleEmployee(ctx, p.employeeId);
  var year = Number(p.year);
  if (!Number.isInteger(year)) fail('invalid', 'Invalid year.');
  var how = V.oneOf(p.how, Object.keys(HOW), 'How it was settled');
  var summary = await poolFor(p.employeeId, year);
  if (!summary || !summary.owedOutstanding) fail('conflict', 'Nothing is owed for ' + year + '.');
  var days = p.days === undefined || p.days === '' ? summary.owedOutstanding : Number(p.days);
  if (!(days > 0) || Math.round(days * 2) !== days * 2) fail('invalid', 'Days must be more than 0, in whole or half days.');
  if (days > summary.owedOutstanding) fail('invalid', 'Only ' + summary.owedOutstanding + ' day(s) are owed for ' + year + '.');
  var note = p.note ? V.text(p.note, 'Note', 300) : '';
  if (how === 'other' && !note) fail('invalid', 'Say how it was settled.');
  await pool.query('INSERT INTO leave_owed_settlements (employee_id, year, days, how, note, settled_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [p.employeeId, year, days, how, note, ctx.employee ? ctx.employee.id : null]);
  var e = await companyOf(p.employeeId);
  await audit(pool, ctx, 'leave.owed.settle', 'employee', p.employeeId,
    'Settled ' + days + ' owed leave day(s) of ' + e.first_name + ' ' + e.last_name + ' for ' + year + ': ' + HOW[how] + (note ? ' — ' + note : '') + '.');
  return poolFor(p.employeeId, year);
}

// ── company defaults, and holiday lists not entered yet ────────────────

async function companyDefaults(ctx, year) {
  canManage(ctx);
  year = Number(year) || new Date().getFullYear();
  var rows = (await pool.query(
    "SELECT c.id, c.name, c.code, c.leave_days_default, " +
    "  (SELECT count(*)::int FROM holidays h WHERE h.company_id = c.id AND h.date BETWEEN $1 AND $2) AS holidays, " +
    "  (SELECT count(*)::int FROM holidays h WHERE h.company_id = c.id AND h.date BETWEEN $3 AND $4) AS next_holidays, " +
    "  (SELECT count(*)::int FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.company_id = c.id AND e.status = 'active') AS people, " +
    "  (SELECT count(*)::int FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.company_id = c.id AND e.status = 'active' AND e.leave_days_total IS NULL) AS without_own " +
    'FROM companies c ORDER BY c.name', yearRange(year).concat(yearRange(year + 1)))).rows;
  return rows.map(function (c) {
    return { companyId: c.id, name: c.name, code: c.code, leaveDaysDefault: c.leave_days_default, holidays: c.holidays, nextYearHolidays: c.next_holidays, people: c.people, withoutOwnTotal: c.without_own };
  });
}

async function setCompanyDefault(ctx, companyId, days) {
  canManage(ctx);
  var c = (await pool.query('SELECT id, name FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!c) fail('notfound', 'Company not found.');
  var v = days === null || days === '' || days === undefined ? null : Number(days);
  if (v !== null && (!Number.isInteger(v) || v < 0 || v > 366)) fail('invalid', 'The yearly total must be a whole number of days, 0 to 366.');
  await pool.query('UPDATE companies SET leave_days_default = $2 WHERE id = $1', [companyId, v]);
  await audit(pool, ctx, 'leave.company_total', 'company', companyId, 'Set ' + c.name + '’s yearly leave total to ' + (v === null ? '(none)' : v + ' day(s)') + '.');
  return { companyId: companyId, leaveDaysDefault: v };
}

module.exports = {
  poolFor: poolFor, poolsFor: poolsFor, previewRequest: previewRequest, owedAfter: owedAfter,
  owedList: owedList, settle: settle, companyDefaults: companyDefaults, setCompanyDefault: setCompanyDefault, HOW: HOW
};
