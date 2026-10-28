var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { businessDays } = require('../utils/validate');
var { restWeekdays } = require('../utils/workWeek');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

// Overtime (migration 0205): hours worked past the day's shift. The person
// asks for it (My space, or here), or their manager puts it in for them; it
// waits in the Approval centre with the leave and the purchases, and once
// approved the next pay run pays it: the hours × their hourly rate × the
// day's multiple — a weekday, a rest day or a public holiday (the company's
// Holidays list). What the clock said that day is shown beside it, so the
// person deciding can see it was worked.
//
// The hourly rate is the person's own (employees.hourly_rate) if they have
// one; else their monthly basic over the month's working days and the hours
// in a day, or their daily rate over the hours in a day. The multiples and
// the hours in a day are the payroll settings' (settings.payroll.overtime).
// Overtime is taxed with the pay (PAYE), not counted for SSNIT.

var DEFAULTS = { weekday: 1.5, restDay: 2, holiday: 2, hoursPerDay: 8 };
var KINDS = ['weekday', 'rest_day', 'holiday'];
var SYSTEM_TITLE = 'Overtime';

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : ''; }
function hm(t) { return t == null ? null : String(t).slice(0, 5); }
function mins(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
function monthOf(day) {
  var y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
  return { start: day.slice(0, 8) + '01', end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
function canDecide(ctx) { return ctx.can('leave.approve'); }
function canPay(ctx) { return ctx.can('payroll.manage'); }

async function rulesOf(db) {
  var row = (await (db || pool).query('SELECT payroll FROM settings WHERE id = 1')).rows[0];
  var r = Object.assign({}, DEFAULTS, ((row && row.payroll) || {}).overtime || {});
  return { weekday: Number(r.weekday), restDay: Number(r.restDay), holiday: Number(r.holiday), hoursPerDay: Number(r.hoursPerDay) };
}
function multipleOf(rules, kind) { return kind === 'holiday' ? rules.holiday : kind === 'rest_day' ? rules.restDay : rules.weekday; }

var EMP = 'SELECT e.*, d.company_id, d.name AS department_name FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = $1';

// A weekday, a rest day (their work week), or a public holiday (theirs).
async function kindOf(db, emp, day) {
  if (emp.company_id && (await db.query('SELECT 1 FROM holidays WHERE company_id = $1 AND date = $2', [emp.company_id, day])).rows[0]) return 'holiday';
  var wd = new Date(day + 'T00:00:00Z').getUTCDay();
  return restWeekdays(emp.work_days).indexOf(wd) >= 0 ? 'rest_day' : 'weekday';
}

// The person's hourly rate for overtime on a day.
function hourlyOf(emp, day, rules) {
  if (Number(emp.hourly_rate) > 0) return round2(emp.hourly_rate);
  var perDay = rules.hoursPerDay > 0 ? rules.hoursPerDay : 8;
  if (emp.basic_salary != null && Number(emp.basic_salary) > 0) {
    var m = monthOf(day);
    var working = businessDays(m.start, m.end, null, restWeekdays(emp.work_days)) || 26;
    return round2(Number(emp.basic_salary) / working / perDay);
  }
  return round2(Number(emp.daily_rate || 0) / perDay);
}

// What the clock said that day: in, out, the hours, and how far past the
// shift's end they stayed.
async function clockOf(db, emp, day) {
  var a = (await db.query("SELECT clock_in, clock_out, status FROM attendance WHERE employee_id = $1 AND date = $2 ORDER BY shift_no NULLS FIRST LIMIT 1", [emp.id, day])).rows[0];
  if (!a || !a.clock_in) return null;
  var out = { in: hm(a.clock_in), out: hm(a.clock_out), hours: null, past: null, shiftEnd: hm(emp.shift_end) };
  if (out.out) {
    var span = mins(out.out) - mins(out.in);
    if (span < 0) span += 1440;
    out.hours = round2(span / 60);
    if (out.shiftEnd) {
      var past = mins(out.out) - mins(out.shiftEnd);
      if (past < -720) past += 1440;
      out.past = round2(Math.max(0, past) / 60);
    }
  }
  return out;
}

var SEL = 'SELECT o.*, e.first_name, e.last_name, e.photo_key, e.photo_updated_at, e.position_title, e.manager_id, d.name AS department_name, d.company_id, c.name AS company_name, ' +
  'dc.first_name AS d_first, dc.last_name AS d_last, ab.first_name AS a_first, ab.last_name AS a_last, pr.run_no ' +
  'FROM overtime_requests o JOIN employees e ON e.id = o.employee_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id ' +
  'LEFT JOIN employees dc ON dc.id = o.decided_by LEFT JOIN employees ab ON ab.id = o.asked_by LEFT JOIN pay_runs pr ON pr.id = o.pay_run_id ';

function rowOut(r, rules, rate) {
  var multiple = r.multiple != null ? Number(r.multiple) : multipleOf(rules, r.day_kind);
  return {
    id: r.id, day: dayText(r.day), hours: Number(r.hours), reason: r.reason, kind: r.day_kind, multiple: multiple, status: r.status,
    person: { id: r.employee_id, name: nameOf(r.first_name, r.last_name), role: r.position_title || '', department: r.department_name || '', company: r.company_name || '',
      photo: r.photo_key ? (r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : 1) : null },
    askedBy: r.asked_by && r.asked_by !== r.employee_id ? nameOf(r.a_first, r.a_last) : null,
    decidedBy: r.decided_by ? nameOf(r.d_first, r.d_last) : null, decidedAt: r.decided_at, note: r.decision_note,
    rate: rate == null ? null : rate,
    amount: r.amount != null ? Number(r.amount) : rate != null ? round2(Number(r.hours) * rate * multiple) : null,
    payRun: r.pay_run_id ? { id: r.pay_run_id, runNo: r.run_no } : null, createdAt: r.created_at
  };
}

async function withRates(rows, rules) {
  var cache = {}, out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i], key = r.employee_id + r.day;
    if (!(key in cache)) { var emp = (await pool.query(EMP, [r.employee_id])).rows[0]; cache[key] = emp ? hourlyOf(emp, dayText(r.day), rules) : null; }
    out.push(rowOut(r, rules, cache[key]));
  }
  return out;
}

// GET /api/overtime?status=open|done&month=YYYY-MM — one's own, and (to
// those who approve) the people in their scope; the month's hours and cost;
// what is approved and waiting for the payroll.
async function overview(ctx, q) {
  q = q || {};
  if (!ctx.employee) fail('forbidden', 'Your account has no employee record.');
  var rules = await rulesOf();
  var month = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : today().slice(0, 7);
  var m = monthOf(month + '-01');
  var all = (await pool.query(SEL + "WHERE (o.day BETWEEN $1 AND $2) OR o.status IN ('pending', 'approved') ORDER BY o.day DESC, o.created_at DESC", [addDays(m.start, -62), m.end])).rows;
  var scope = [];
  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    if (r.employee_id === ctx.employee.id) { scope.push(r); continue; }
    if (!(canDecide(ctx) || canPay(ctx))) continue;
    if (await visibleEmployee(ctx, await fetchEmployeeById(r.employee_id))) scope.push(r);
  }
  var rows = await withRates(scope, rules);
  var mine = rows.filter(function (r) { return r.person.id === ctx.employee.id; });
  var team = rows.filter(function (r) { return r.person.id !== ctx.employee.id; });
  var inMonth = team.filter(function (r) { return r.day >= m.start && r.day <= m.end && ['approved', 'paid'].indexOf(r.status) >= 0; });
  var byPerson = {};
  inMonth.forEach(function (r) {
    var p = byPerson[r.person.id] = byPerson[r.person.id] || { person: r.person, hours: 0, amount: 0, days: 0 };
    p.hours = round2(p.hours + r.hours); p.amount = round2(p.amount + (r.amount || 0)); p.days++;
  });
  // Each day of the month: the hours approved, for the chart.
  var days = [];
  for (var d = m.start; d <= m.end; d = addDays(d, 1)) days.push({ day: d, hours: 0 });
  inMonth.forEach(function (r) { var slot = days.find(function (x) { return x.day === r.day; }); if (slot) slot.hours = round2(slot.hours + r.hours); });
  var people = [];
  if (canDecide(ctx)) {
    var emps = (await pool.query("SELECT e.id, e.first_name, e.last_name, e.department_id FROM employees e WHERE e.status = 'active' ORDER BY e.first_name, e.last_name")).rows;
    for (var j = 0; j < emps.length; j++) if (emps[j].id !== ctx.employee.id && await visibleEmployee(ctx, await fetchEmployeeById(emps[j].id))) people.push({ id: emps[j].id, name: nameOf(emps[j].first_name, emps[j].last_name) });
  }
  return {
    month: month, rules: rules, canDecide: canDecide(ctx), canPay: canPay(ctx), me: { id: ctx.employee.id, name: nameOf(ctx.employee.first_name, ctx.employee.last_name) },
    mine: mine, pending: team.filter(function (r) { return r.status === 'pending'; }),
    approved: team.filter(function (r) { return r.status === 'approved'; }),
    done: team.filter(function (r) { return ['paid', 'rejected', 'cancelled'].indexOf(r.status) >= 0 && r.day >= addDays(m.start, -31); }).slice(0, 60),
    people: people, days: days,
    top: Object.keys(byPerson).map(function (k) { return byPerson[k]; }).sort(function (a, b) { return b.hours - a.hours; }).slice(0, 8),
    summary: {
      hours: round2(inMonth.reduce(function (a, r) { return a + r.hours; }, 0)),
      cost: round2(inMonth.reduce(function (a, r) { return a + (r.amount || 0); }, 0)),
      people: Object.keys(byPerson).length,
      pending: team.filter(function (r) { return r.status === 'pending'; }).length,
      pendingHours: round2(team.filter(function (r) { return r.status === 'pending'; }).reduce(function (a, r) { return a + r.hours; }, 0)),
      toPay: team.filter(function (r) { return r.status === 'approved'; }).length,
      toPayAmount: round2(team.filter(function (r) { return r.status === 'approved'; }).reduce(function (a, r) { return a + (r.amount || 0); }, 0)),
      holidayHours: round2(inMonth.filter(function (r) { return r.kind !== 'weekday'; }).reduce(function (a, r) { return a + r.hours; }, 0))
    }
  };
}

async function requestOf(db, id) {
  var r = (await db.query(SEL + 'WHERE o.id = $1', [uuidOr(id)])).rows[0];
  if (!r) fail('notfound', 'That overtime is gone.');
  return r;
}

// GET /api/overtime/:id — with what the clock said.
async function get(ctx, id) {
  var r = await requestOf(pool, id);
  if (r.employee_id !== ctx.employee.id) {
    if (!(canDecide(ctx) || canPay(ctx))) fail('forbidden', 'Your role does not allow this action (leave.approve).');
    if (!(await visibleEmployee(ctx, await fetchEmployeeById(r.employee_id)))) fail('forbidden', 'That person is outside the people you can see.');
  }
  var rules = await rulesOf();
  var emp = (await pool.query(EMP, [r.employee_id])).rows[0];
  var out = rowOut(r, rules, hourlyOf(emp, dayText(r.day), rules));
  out.clock = await clockOf(pool, emp, dayText(r.day));
  out.monthHours = Number((await pool.query("SELECT coalesce(sum(hours), 0) AS h FROM overtime_requests WHERE employee_id = $1 AND status IN ('approved', 'paid') AND date_trunc('month', day) = date_trunc('month', $2::date)", [r.employee_id, dayText(r.day)])).rows[0].h);
  return out;
}

// POST /api/overtime { employeeId?, day, hours, reason, approve? } — for
// oneself, or (an approver) for someone in their scope, approved at once if
// they say so.
async function create(ctx, p) {
  p = p || {};
  if (!ctx.employee) fail('forbidden', 'Your account has no employee record.');
  var empId = uuidOr(p.employeeId) || ctx.employee.id;
  var forOther = empId !== ctx.employee.id;
  if (forOther) {
    if (!canDecide(ctx)) fail('forbidden', 'Your role does not allow this action (leave.approve).');
    if (!(await visibleEmployee(ctx, await fetchEmployeeById(empId)))) fail('forbidden', 'That person is outside the people you can see.');
  }
  var emp = (await pool.query(EMP, [empId])).rows[0];
  if (!emp || emp.status !== 'active') fail('invalid', 'Who worked it?');
  var day = /^\d{4}-\d{2}-\d{2}$/.test(String(p.day || '')) ? p.day : null;
  if (!day) fail('invalid', 'Which day?');
  if (day > today()) fail('invalid', 'Overtime is asked for once it has been worked.');
  if (day < addDays(today(), -62)) fail('invalid', 'That is more than two months ago: ask payroll.');
  var hours = Math.round(Number(p.hours) * 4) / 4;
  if (!(hours > 0 && hours <= 16)) fail('invalid', 'How many hours? Between a quarter of an hour and 16.');
  var reason = text(p.reason, 400);
  if (reason.length < 3) fail('invalid', 'What was it for?');
  var dup = (await pool.query("SELECT 1 FROM overtime_requests WHERE employee_id = $1 AND day = $2 AND status IN ('pending', 'approved', 'paid')", [empId, day])).rows[0];
  if (dup) fail('conflict', 'There is overtime on ' + day + ' for them already: change that one.');
  var kind = await kindOf(pool, emp, day);
  var approveNow = forOther && p.approve === true;
  var rules = await rulesOf();
  var id = await withTransaction(async function (db) {
    var row = (await db.query(
      'INSERT INTO overtime_requests (employee_id, day, hours, reason, day_kind, asked_by, status, multiple, decided_by, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [empId, day, hours, reason, kind, ctx.employee.id, approveNow ? 'approved' : 'pending', approveNow ? multipleOf(rules, kind) : null, approveNow ? ctx.employee.id : null, approveNow ? new Date() : null])).rows[0];
    await db.query(
      "INSERT INTO approvals (subject_type, subject_id, title, requested_by, assignee_permission, department_id, status, decided_by, decided_at) VALUES ('overtime', $1, $2, $3, 'leave.approve', $4, $5, $6, $7)",
      [row.id, SYSTEM_TITLE, empId, emp.department_id, approveNow ? 'approved' : 'pending', approveNow ? ctx.employee.id : null, approveNow ? new Date() : null]);
    await audit(db, ctx, 'overtime.request', 'overtime', row.id, hours + ' h of overtime on ' + day + ' for ' + nameOf(emp.first_name, emp.last_name) + (approveNow ? ', approved' : '') + ': ' + reason);
    if (!forOther && emp.manager_id) await notify(db, emp.manager_id, 'Overtime to approve', nameOf(emp.first_name, emp.last_name) + ': ' + hours + ' h on ' + day + ' — ' + reason, 'approvals');
    if (forOther) await notify(db, empId, approveNow ? 'Overtime approved' : 'Overtime put in for you', hours + ' h on ' + day + ' — ' + reason + (approveNow ? '. It will be paid with the next pay run.' : ''), 'overtime');
    return row.id;
  });
  return get(ctx, id);
}

// POST /api/overtime/:id/decision { decision: approved|rejected, note } —
// also what the Approval centre calls.
async function decide(ctx, id, decision, note) {
  if (!canDecide(ctx)) fail('forbidden', 'Your role does not allow this action (leave.approve).');
  if (['approved', 'rejected'].indexOf(decision) < 0) fail('invalid', 'Approve or reject it.');
  var r = await requestOf(pool, id);
  if (r.status !== 'pending') fail('conflict', 'That overtime has been decided already.');
  if (r.employee_id === ctx.employee.id) fail('forbidden', 'You cannot approve your own overtime.');
  if (!(await visibleEmployee(ctx, await fetchEmployeeById(r.employee_id)))) fail('forbidden', 'That person is outside the people you are responsible for.');
  var words = text(note, 400);
  if (decision === 'rejected' && words.length < 3) fail('invalid', 'Say why, for them to read.');
  var rules = await rulesOf();
  var emp = (await pool.query(EMP, [r.employee_id])).rows[0];
  // The day may have become a holiday since it was asked for.
  var kind = await kindOf(pool, emp, dayText(r.day));
  await withTransaction(async function (db) {
    await db.query('UPDATE overtime_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, day_kind = $5, multiple = $6, updated_at = now() WHERE id = $1',
      [r.id, decision, ctx.employee.id, words, kind, decision === 'approved' ? multipleOf(rules, kind) : null]);
    await db.query("UPDATE approvals SET status = $2, decided_by = $3, decided_at = now(), comment = $4 WHERE subject_type = 'overtime' AND subject_id = $1 AND status = 'pending'", [r.id, decision, ctx.employee.id, words]);
    await audit(db, ctx, 'overtime.' + decision, 'overtime', r.id, Number(r.hours) + ' h on ' + dayText(r.day) + ' for ' + nameOf(r.first_name, r.last_name) + ' ' + decision + (words ? ': ' + words : '') + '.');
    await notify(db, r.employee_id, decision === 'approved' ? 'Overtime approved' : 'Overtime not approved',
      Number(r.hours) + ' h on ' + dayText(r.day) + (decision === 'approved' ? '. It will be paid with the next pay run.' : ' — ' + words), 'overtime');
  });
  return get(ctx, r.id);
}

// POST /api/overtime/:id/cancel — the person, before it is decided; or an
// approver, before it is paid.
async function cancel(ctx, id) {
  var r = await requestOf(pool, id);
  var own = r.employee_id === ctx.employee.id || r.asked_by === ctx.employee.id;
  if (r.status === 'pending' && !own && !canDecide(ctx)) fail('forbidden', 'Only they or an approver can take it back.');
  if (r.status === 'approved' && !(canDecide(ctx) && r.employee_id !== ctx.employee.id)) fail('forbidden', 'It is approved: an approver can take it back before it is paid.');
  if (['pending', 'approved'].indexOf(r.status) < 0) fail('conflict', r.status === 'paid' ? 'It has been paid.' : 'It is closed already.');
  if (r.pay_run_id) fail('conflict', 'It is on pay run ' + r.run_no + ': delete or redo that draft first.');
  await withTransaction(async function (db) {
    await db.query("UPDATE overtime_requests SET status = 'cancelled', updated_at = now() WHERE id = $1", [r.id]);
    await db.query("UPDATE approvals SET status = 'cancelled' WHERE subject_type = 'overtime' AND subject_id = $1 AND status = 'pending'", [r.id]);
    await audit(db, ctx, 'overtime.cancel', 'overtime', r.id, Number(r.hours) + ' h on ' + dayText(r.day) + ' for ' + nameOf(r.first_name, r.last_name) + ' taken back.');
  });
  return { ok: true };
}

// PUT /api/overtime/rules { weekday, restDay, holiday, hoursPerDay }
async function saveRules(ctx, p) {
  if (!canPay(ctx)) fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  p = p || {};
  var r = {};
  [['weekday', 1, 5], ['restDay', 1, 5], ['holiday', 1, 5], ['hoursPerDay', 4, 12]].forEach(function (k) {
    var v = Math.round(Number(p[k[0]]) * 100) / 100;
    if (!(v >= k[1] && v <= k[2])) fail('invalid', 'Between ' + k[1] + ' and ' + k[2] + ', please.');
    r[k[0]] = v;
  });
  await pool.query("UPDATE settings SET payroll = jsonb_set(coalesce(payroll, '{}'::jsonb), '{overtime}', $1::jsonb) WHERE id = 1", [JSON.stringify(r)]);
  await audit(pool, ctx, 'overtime.rules', 'settings', null, 'Overtime paid at ' + r.weekday + '× on weekdays, ' + r.restDay + '× on rest days, ' + r.holiday + '× on holidays; ' + r.hoursPerDay + ' h a day.');
  return rulesOf();
}

// For a pay run (payroll.service.js): the approved overtime not yet paid,
// worked on or before the end of the period, priced and put on this run.
// { hours, pay }.
async function forSlip(db, emp, runId, periodEnd) {
  var rules = await rulesOf(db);
  var rows = (await db.query("SELECT * FROM overtime_requests WHERE employee_id = $1 AND status = 'approved' AND pay_run_id IS NULL AND day <= $2 ORDER BY day", [emp.id, periodEnd])).rows;
  var hours = 0, pay = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i], multiple = r.multiple != null ? Number(r.multiple) : multipleOf(rules, r.day_kind);
    var amount = round2(Number(r.hours) * hourlyOf(emp, dayText(r.day), rules) * multiple);
    await db.query('UPDATE overtime_requests SET pay_run_id = $2, amount = $3, updated_at = now() WHERE id = $1', [r.id, runId, amount]);
    hours += Number(r.hours); pay += amount;
  }
  return { hours: round2(hours), pay: round2(pay) };
}
// A draft run thrown away: its overtime waits for the next one.
async function releaseRun(db, runId) {
  await db.query('UPDATE overtime_requests SET pay_run_id = NULL, amount = NULL, updated_at = now() WHERE pay_run_id = $1', [runId]);
}
// The run is paid: so is its overtime.
async function onRunPaid(db, runId) {
  return (await db.query("UPDATE overtime_requests SET status = 'paid', updated_at = now() WHERE pay_run_id = $1 AND status = 'approved'", [runId])).rowCount;
}

// For the Approval centre: the facts of one request.
async function facts(id) {
  var r = (await pool.query(SEL + 'WHERE o.id = $1', [id])).rows[0];
  if (!r) return null;
  var rules = await rulesOf();
  var emp = (await pool.query(EMP, [r.employee_id])).rows[0];
  var rate = hourlyOf(emp, dayText(r.day), rules);
  var multiple = multipleOf(rules, r.day_kind);
  return { day: dayText(r.day), hours: Number(r.hours), kind: r.day_kind, multiple: multiple, rate: rate, amount: round2(Number(r.hours) * rate * multiple), reason: r.reason, clock: await clockOf(pool, emp, dayText(r.day)) };
}

module.exports = { overview: overview, get: get, create: create, decide: decide, cancel: cancel, saveRules: saveRules, rulesOf: rulesOf, forSlip: forSlip, releaseRun: releaseRun, onRunPaid: onRunPaid, facts: facts, hourlyOf: hourlyOf, KINDS: KINDS, DEFAULTS: DEFAULTS };
