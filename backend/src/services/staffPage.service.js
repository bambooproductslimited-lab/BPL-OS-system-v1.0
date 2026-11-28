var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { internationalNumber, maskedNumber } = require('../utils/phone');

// The staff page (frontend /staff, staff.html, migration 0224): every
// employee's own page, on their own phone, without an OS account.
//
// Signing in: the phone number on their employee record, then the six-digit
// code texted to it (sms.service, through mNotify). The answer to "send me a
// code" is the same whether or not the number is on the staff list, so the
// page can't be used to find out who works here; codes go out only to a
// number on a record. A sign-in lasts 90 days on that phone, and ends as
// soon as the number leaves their record, they stop being active, or HR
// signs them out (People → Staff page). Two people sharing one phone pick
// who they are after the code.
//
// What they see is theirs alone: who they are on the record (department,
// manager, shift), today's clock, their attendance month by month (each
// day: in, out, hours, late by how much, or absent / day off / leave /
// public holiday — attendance.report's own rules), their leave (what is
// left, what they asked for; they can ask for leave and call off a request
// still waiting, as in My Space), and the work orders they are on. No pay.

var CODE_MINUTES = 10;
var MAX_TRIES = 5;
var SESSION_DAYS = 90;
var PER_NUMBER = 3;       // codes in 15 minutes
var RESEND_SECONDS = 45;
var PER_IP_HOUR = 12;
var MONTHS_BACK = 24;
var SIGN_IN_AGAIN = 'Sign in again with your phone number.';
var CODE_WRONG = 'That code is not right, or it has expired. Ask for a new one.';

function sha(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function nameOf(e) { return ((e.first_name || '') + ' ' + (e.last_name || '')).trim(); }
function dayText(d) { return d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null; }
function hm(t) { return t ? String(t).slice(0, 5) : null; }
function phoneOf(raw) {
  var n = internationalNumber(raw);
  if (!n) fail('invalid', 'Type the phone number on your staff record, e.g. 024 412 3456.');
  return n;
}
function shownNumber(n) { return '+' + n.slice(0, 3) + ' ' + maskedNumber(n); }

// Active staff with that number among the ones on their record ("024 … /
// 020 …" holds two), matched on the last nine digits however it is written.
var ON_NUMBER =
  "EXISTS (SELECT 1 FROM regexp_split_to_table(coalesce(e.phone, ''), '[/,;]') p " +
  "WHERE length(regexp_replace(p, '\\D', '', 'g')) >= 9 AND right(regexp_replace(p, '\\D', '', 'g'), 9) = right($1, 9))";
async function staffOn(phone, db) {
  return (await (db || pool).query(
    'SELECT e.id, e.first_name, e.last_name, e.position_title, (SELECT u.id FROM users u WHERE u.employee_id = e.id ORDER BY u.created_at LIMIT 1) AS user_id ' +
    "FROM employees e WHERE e.status = 'active' AND " + ON_NUMBER + ' ORDER BY e.first_name, e.last_name', [phone])).rows;
}

var asked = new Map(); // address of the request -> times, this last hour
function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (asked.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Too many codes asked for from here. Try again in an hour.');
  list.push(now); asked.set(key, list);
  if (asked.size > 5000) asked.clear();
}

// ── signing in ─────────────────────────────────────────────────────────

// POST /api/staff/code { phone } — a code by text to that number when it is
// on a staff record; the same answer either way.
async function sendCode(body, ip) {
  var phone = phoneOf((body || {}).phone);
  var sms = require('./sms.service');
  if (!sms.configured()) fail('unavailable', 'Codes by text can\'t be sent just now. Ask HR.');
  throttle(ip);
  var recent = (await pool.query(
    "SELECT count(*)::int AS n, max(created_at) AS last FROM staff_codes WHERE phone = $1 AND created_at > now() - interval '15 minutes'", [phone])).rows[0];
  if (recent.last && Date.now() - new Date(recent.last).getTime() < RESEND_SECONDS * 1000) fail('ratelimited', 'A code was just sent. Wait a minute before asking for another.');
  if (recent.n >= PER_NUMBER) fail('ratelimited', 'A few codes were sent already. Use the last one, or try again in 15 minutes.');
  var out = { sent: true, to: shownNumber(phone), minutes: CODE_MINUTES };
  var people = await staffOn(phone);
  if (!people.length) return out;
  var code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  var row = (await pool.query(
    "INSERT INTO staff_codes (phone, code_hash, ip, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval) RETURNING id",
    [phone, sha(phone + ':' + code), String(ip || '').slice(0, 60), String(CODE_MINUTES)])).rows[0];
  var words = 'Your Bamboo staff page code is {code}. It works for ' + CODE_MINUTES + ' minutes. Never share it: nobody at Bamboo will ask you for it.';
  try {
    await sms.send({ to: '+' + phone, message: words.replace('{code}', code), logMessage: words.replace('{code}', '••••••'),
      purpose: 'staff_code', refId: people[0].id, sentBy: people[0].id });
  } catch (e) {
    await pool.query('DELETE FROM staff_codes WHERE id = $1', [row.id]);
    fail('unavailable', 'The code could not be sent just now. Try again in a minute.');
  }
  return out;
}

// POST /api/staff/sign-in { phone, code } — this phone, signed in for 90
// days; with the people to pick from when two share the number.
async function signIn(body, ip, userAgent) {
  body = body || {};
  var phone = phoneOf(body.phone);
  var code = String(body.code || '').replace(/\D/g, '');
  var row = (await pool.query('SELECT * FROM staff_codes WHERE phone = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1', [phone])).rows[0];
  if (!row || row.tries >= MAX_TRIES) fail('invalid', CODE_WRONG);
  if (code.length !== 6 || sha(phone + ':' + code) !== row.code_hash) {
    await pool.query('UPDATE staff_codes SET tries = tries + 1 WHERE id = $1', [row.id]);
    fail('invalid', CODE_WRONG);
  }
  if (!(await pool.query('UPDATE staff_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [row.id])).rowCount) fail('invalid', 'That code was used already. Ask for a new one.');
  var people = await staffOn(phone);
  if (!people.length) fail('invalid', 'That number is no longer on a staff record. Ask HR.');
  var token = crypto.randomBytes(32).toString('hex');
  var one = people.length === 1 ? people[0] : null;
  await pool.query(
    "INSERT INTO staff_sessions (token_hash, phone, employee_id, ip, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)",
    [sha(token), phone, one ? one.id : null, String(ip || '').slice(0, 60), String(userAgent || '').slice(0, 300), String(SESSION_DAYS)]);
  if (one) await audit(pool, { user: { id: one.user_id || null }, employee: one }, 'staff.sign_in', 'employee', one.id, nameOf(one) + ' signed in to the staff page.');
  return { token: token, days: SESSION_DAYS, choose: one ? null : people.map(function (p) { return { id: p.id, name: nameOf(p), position: p.position_title || '' }; }) };
}

// The sign-in behind a token, still good: the number still on the person's
// record, the person still active.
async function sessionOf(token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) fail('auth', SIGN_IN_AGAIN);
  var s = (await pool.query('SELECT * FROM staff_sessions WHERE token_hash = $1 AND expires_at > now()', [sha(token)])).rows[0];
  if (!s) fail('auth', SIGN_IN_AGAIN);
  var people = await staffOn(s.phone);
  if (!people.length || (s.employee_id && !people.some(function (p) { return p.id === s.employee_id; }))) {
    await pool.query('DELETE FROM staff_sessions WHERE id = $1', [s.id]);
    fail('auth', SIGN_IN_AGAIN);
  }
  if (Date.now() - new Date(s.last_seen_at).getTime() > 5 * 60 * 1000) await pool.query('UPDATE staff_sessions SET last_seen_at = now() WHERE id = $1', [s.id]);
  s.people = people;
  return s;
}

// The person signed in, with their whole record row (the leave service
// takes it), as a context that may do one thing: ask for their own leave.
async function personOf(token) {
  var s = await sessionOf(token);
  if (!s.employee_id) fail('conflict', 'Choose who you are first.');
  var e = (await pool.query('SELECT * FROM employees WHERE id = $1', [s.employee_id])).rows[0];
  var userId = (s.people.find(function (p) { return p.id === e.id; }) || {}).user_id || null;
  return {
    session: s,
    ctx: { user: { id: userId }, employee: e, can: function (p) { return p === 'leave.request'; }, staffPage: true }
  };
}

// POST /api/staff/choose { employeeId } — who is signed in, when two share the number.
async function choose(token, body) {
  var s = await sessionOf(token);
  var p = s.people.find(function (x) { return x.id === (body || {}).employeeId; });
  if (!p) fail('invalid', 'Choose one of the names shown.');
  await pool.query('UPDATE staff_sessions SET employee_id = $2 WHERE id = $1', [s.id, p.id]);
  await audit(pool, { user: { id: p.user_id || null }, employee: p }, 'staff.sign_in', 'employee', p.id, nameOf(p) + ' signed in to the staff page.');
  return { ok: true };
}

// POST /api/staff/sign-out — this phone's sign-in ends.
async function signOut(token) {
  if (token && /^[0-9a-f]{64}$/.test(token)) await pool.query('DELETE FROM staff_sessions WHERE token_hash = $1', [sha(token)]);
  return { ok: true };
}

// ── what they see ──────────────────────────────────────────────────────

function hoursOf(r) {
  if (!r.clock_in || !r.clock_out) return null;
  var start = new Date(dayText(r.date) + 'T' + String(r.clock_in).slice(0, 8) + 'Z');
  var end = new Date(dayText(r.clock_out_date || r.date) + 'T' + String(r.clock_out).slice(0, 8) + 'Z');
  var h = (end - start) / 3600000;
  return h >= 0 && h < 36 ? Math.round(h * 100) / 100 : null;
}

// Their attendance in one month ("2026-11"): each day to today, as the HR
// report reads it, with the hours and the minutes late; the month's totals.
async function attendanceMonth(e, month) {
  var att = require('./attendance.service');
  var today = todayISO();
  var m = /^(\d{4})-(\d{2})$/.exec(String(month || '')) ? String(month) : today.slice(0, 7);
  var first = m + '-01';
  var lastDay = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
  var oldest = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - MONTHS_BACK, 1)).toISOString().slice(0, 10);
  if (first > today || first < oldest) fail('invalid', 'Choose a month from the last two years.');
  var hired = dayText(e.hire_date);
  var from = hired && hired > first ? hired : first;
  var to = lastDay < today ? lastDay : today;
  var days = [];
  if (from <= to) {
    var self = { user: { id: null }, employee: { id: e.id }, can: function () { return false; } };
    var rep = await att.report(self, from, to);
    var raw = (await pool.query('SELECT * FROM attendance WHERE employee_id = $1 AND date BETWEEN $2 AND $3', [e.id, from, to])).rows;
    var byKey = {};
    raw.forEach(function (r) { byKey[dayText(r.date) + '|' + Number(r.shift_no || 1)] = r; });
    for (var i = 0; i < rep.rows.length; i++) {
      var row = rep.rows[i];
      var r = byKey[row.date + '|' + row.shiftNo];
      var late = 0;
      if (r && r.status === 'late' && r.clock_in) late = att.judgeLateness(await att.resolveLateRule(e.id, row.date, row.shiftNo), hm(r.clock_in)).minutesLate;
      days.push({
        date: row.date, shift: row.shiftNo, status: row.date === today && !r ? 'today' : row.status,
        clockIn: row.clockIn, clockOut: row.clockOut, hours: r ? hoursOf(r) : null, minutesLate: late,
        autoClockedOut: row.autoClockedOut, holiday: row.holiday || null, note: row.note || ''
      });
    }
  }
  var worked = {};
  var totals = { daysWorked: 0, late: 0, minutesLate: 0, absent: 0, leave: 0, holidays: 0, off: 0, hours: 0, autoClockedOut: 0 };
  days.forEach(function (d) {
    if (d.status === 'present' || d.status === 'late' || d.status === 'half_day') worked[d.date] = true;
    if (d.status === 'late') { totals.late++; totals.minutesLate += d.minutesLate; }
    if (d.status === 'absent') totals.absent++;
    if (d.status === 'leave') totals.leave++;
    if (d.status === 'holiday') totals.holidays++;
    if (d.status === 'off') totals.off++;
    if (d.hours) totals.hours += d.hours;
    if (d.autoClockedOut) totals.autoClockedOut++;
  });
  totals.daysWorked = Object.keys(worked).length;
  totals.hours = Math.round(totals.hours * 10) / 10;
  return { month: m, from: first, to: lastDay, upTo: to, hiredOn: hired, oldest: oldest.slice(0, 7), days: days, totals: totals };
}

// GET /api/staff/me — everything on their page.
async function me(token) {
  var s = await sessionOf(token);
  if (!s.employee_id) {
    return { choose: s.people.map(function (p) { return { id: p.id, name: nameOf(p), position: p.position_title || '' }; }) };
  }
  var e = (await pool.query(
    "SELECT e.*, d.name AS department_name, c.name AS company_name, c.code AS company_code, m.first_name || ' ' || m.last_name AS manager_name, " +
    's.name AS shift_name, s.start_time AS tpl_start, s.end_time AS tpl_end ' +
    'FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id ' +
    'LEFT JOIN employees m ON m.id = e.manager_id LEFT JOIN shifts s ON s.id = e.shift_id WHERE e.id = $1', [s.employee_id])).rows[0];
  var today = todayISO(), year = Number(today.slice(0, 4));
  var leaveSvc = require('./leave.service');
  var todayRows = (await pool.query('SELECT * FROM attendance WHERE employee_id = $1 AND date = $2 ORDER BY shift_no', [e.id, today])).rows;
  var balances = (await pool.query(
    'SELECT lb.entitled, lb.used, lt.id, lt.name, lt.paid, ' +
    "  COALESCE((SELECT sum(days) FROM leave_requests r WHERE r.employee_id = $1 AND r.leave_type_id = lt.id AND r.status = 'pending' AND extract(year from r.start_date) = $2), 0)::int AS pending " +
    'FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id WHERE lb.employee_id = $1 AND lb.year = $2 AND lt.active ORDER BY lt.name', [e.id, year])).rows;
  var requests = (await pool.query(
    'SELECT lr.*, lt.name AS type_name FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.employee_id = $1 ORDER BY lr.start_date DESC LIMIT 20', [e.id])).rows;
  var types = (await pool.query('SELECT id, name, paid FROM leave_types WHERE active ORDER BY name')).rows;
  var wos = (await pool.query(
    "SELECT t.id, t.wo_no, t.title, t.status, t.due_date, t.project_manager_id = $1 AS manages FROM tasks t " +
    'WHERE (t.project_manager_id = $1 OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.employee_id = $1)) ' +
    "AND t.status NOT IN ('done', 'completed', 'cancelled') ORDER BY t.due_date NULLS LAST, t.wo_no LIMIT 20", [e.id])).rows;
  var jobs = (await pool.query(
    "SELECT count(*)::int AS n FROM maint_work_orders WHERE assigned_to_id = $1 AND status IN ('new', 'scheduled', 'in_progress', 'on_hold')", [e.id])).rows[0].n;
  return {
    me: {
      id: e.id, name: nameOf(e), firstName: e.first_name, code: e.code, position: e.position_title || '', department: e.department_name || '',
      company: e.company_name || '', companyCode: e.company_code || '', manager: e.manager_name || '', hiredOn: dayText(e.hire_date),
      shift: { name: e.shift_name || '', start: hm(e.tpl_start || e.shift_start), end: hm(e.tpl_end || e.shift_end), second: hm(e.second_shift_start) },
      workDays: e.work_days || null, phone: shownNumber(s.phone)
    },
    today: { date: today, shifts: todayRows.map(function (r) { return { shift: Number(r.shift_no || 1), clockIn: hm(r.clock_in), clockOut: hm(r.clock_out), status: r.status, hours: hoursOf(r) }; }) },
    attendance: await attendanceMonth(e, today.slice(0, 7)),
    leave: {
      year: year,
      balances: balances.map(function (b) { return { typeId: b.id, name: b.name, paid: b.paid, entitled: Number(b.entitled), used: Number(b.used), pending: Number(b.pending), left: Number(b.entitled) - Number(b.used) }; }),
      requests: requests.map(leaveSvc.rowToLeaveRequest).map(function (r) { r.startDate = dayText(r.startDate); r.endDate = dayText(r.endDate); return r; }),
      types: types.map(function (t) { return { id: t.id, name: t.name, paid: t.paid }; })
    },
    work: {
      orders: wos.map(function (t) { return { id: t.id, number: 'WO-' + String(t.wo_no).padStart(4, '0'), title: t.title, status: t.status, due: dayText(t.due_date), manages: !!t.manages }; }),
      maintenanceJobs: jobs
    },
    others: s.people.length > 1 ? s.people.filter(function (p) { return p.id !== e.id; }).map(function (p) { return { id: p.id, name: nameOf(p) }; }) : []
  };
}

// GET /api/staff/attendance?month=2026-10 — another month.
async function attendance(token, month) {
  var p = await personOf(token);
  return attendanceMonth(p.ctx.employee, month);
}

// POST /api/staff/leave/preview { leaveTypeId, startDate, endDate } — how many days that is.
async function leavePreview(token, body) {
  var p = await personOf(token);
  return require('./leavePool.service').previewRequest(p.ctx, Object.assign({}, body, { employeeId: p.ctx.employee.id }));
}
// POST /api/staff/leave { leaveTypeId, startDate, endDate, reason } — asking for leave, as in My Space.
async function askLeave(token, body) {
  var p = await personOf(token);
  return require('./leave.service').requestLeave(p.ctx, body || {});
}
// POST /api/staff/leave/:id/cancel — a request still waiting, called off.
async function cancelLeave(token, id) {
  var p = await personOf(token);
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) fail('notfound', 'Request not found.');
  return require('./leave.service').cancel(p.ctx, id);
}

// ── HR's side: People → Staff page ─────────────────────────────────────

function needHr(ctx) { if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).'); }

// GET /api/staff-page — who can sign in (a phone number on their record),
// who can't yet, numbers two people share, and who is signed in.
async function hrOverview(ctx) {
  needHr(ctx);
  var staff = (await pool.query(
    "SELECT e.id, e.code, e.first_name, e.last_name, e.position_title, e.phone, d.name AS department_name " +
    "FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'active' ORDER BY e.first_name, e.last_name")).rows;
  var signedIn = (await pool.query(
    'SELECT s.employee_id, count(*)::int AS phones, max(s.last_seen_at) AS last_seen, min(s.created_at) AS since FROM staff_sessions s ' +
    'WHERE s.expires_at > now() AND s.employee_id IS NOT NULL GROUP BY s.employee_id')).rows;
  var seen = {};
  signedIn.forEach(function (r) { seen[r.employee_id] = r; });
  var byNumber = {}, noPhone = [];
  staff.forEach(function (e) {
    var nums = String(e.phone || '').split(/[\/,;]/).map(function (p) { return internationalNumber(p); }).filter(Boolean);
    if (!nums.length) { noPhone.push(e); return; }
    nums.forEach(function (n) { var k = n.slice(-9); (byNumber[k] = byNumber[k] || []).push(e); });
  });
  var shared = Object.keys(byNumber).filter(function (k) { return byNumber[k].length > 1; }).map(function (k) {
    return { phone: '•••• ' + k.slice(-4), people: byNumber[k].map(function (e) { return nameOf(e); }) };
  });
  var person = function (e) { return { id: e.id, code: e.code, name: nameOf(e), position: e.position_title || '', department: e.department_name || '' }; };
  return {
    smsReady: require('./sms.service').configured(),
    counts: { active: staff.length, withPhone: staff.length - noPhone.length, noPhone: noPhone.length, signedIn: signedIn.length },
    noPhone: noPhone.map(person),
    shared: shared,
    signedIn: staff.filter(function (e) { return seen[e.id]; }).map(function (e) {
      return Object.assign(person(e), { phones: seen[e.id].phones, lastSeen: seen[e.id].last_seen, since: seen[e.id].since });
    }).sort(function (a, b) { return new Date(b.lastSeen) - new Date(a.lastSeen); })
  };
}

// POST /api/staff-page/:employeeId/sign-out — every phone of theirs signed out.
async function hrSignOut(ctx, employeeId) {
  needHr(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(String(employeeId))) fail('notfound', 'That person is not in the directory.');
  var e = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [employeeId])).rows[0];
  if (!e) fail('notfound', 'That person is not in the directory.');
  var n = (await pool.query('DELETE FROM staff_sessions WHERE employee_id = $1', [e.id])).rowCount;
  await audit(pool, ctx, 'staff.sign_out', 'employee', e.id, 'Signed ' + nameOf(e) + ' out of the staff page (' + n + ' phone(s)).');
  return { signedOut: n };
}

module.exports = {
  sendCode: sendCode, signIn: signIn, choose: choose, signOut: signOut, me: me, attendance: attendance,
  leavePreview: leavePreview, askLeave: askLeave, cancelLeave: cancelLeave, hrOverview: hrOverview, hrSignOut: hrSignOut,
  CODE_MINUTES: CODE_MINUTES, SESSION_DAYS: SESSION_DAYS
};
