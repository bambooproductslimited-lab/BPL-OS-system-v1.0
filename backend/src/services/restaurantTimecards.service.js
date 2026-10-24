var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var pinAuth = require('../lib/pinAuth');
var attendance = require('./attendance.service');
var activity = require('./restaurantActivity.service');

// Timecards on the till (migration 0187) — Square's team time clock: the
// staff clock in, take a break, come back and clock out from the till's PIN
// pad (POST /api/pos/timeclock), without signing in to it. A shift is an
// attendance row, as the clock-in iPad's are, so the OS's attendance,
// lateness and payroll see it; its breaks are attendance_breaks. In the back
// office (Setup → Timecards) a manager sees each person's week against the
// rota — late, left early, overtime, not in — and corrects a time, saying
// why.

var LATE_GRACE_MIN = 5;
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function dayOf(d) { return d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null; }
function hm(t) { return t ? String(t).slice(0, 5) : null; }
function addDays(day, n) { var d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function mins(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
function isTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')); }
function isDay(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
function who(m) { return { user: { id: null }, employee: { first_name: m.first_name, last_name: m.last_name } }; }
function when(d) { return new Date(d).toISOString().slice(11, 16); }

// A shift's start and end as moments (the end the next day when it says so).
function spanOf(r) {
  var start = new Date(dayOf(r.date) + 'T' + String(r.clock_in).slice(0, 8) + 'Z');
  var end = r.clock_out ? new Date((r.clock_out_date ? dayOf(r.clock_out_date) : dayOf(r.date)) + 'T' + String(r.clock_out).slice(0, 8) + 'Z') : null;
  return { start: start, end: end };
}
function breakMinutes(list, now) {
  var paid = 0, unpaid = 0;
  (list || []).forEach(function (b) {
    var m = Math.max(0, ((b.ends_at ? new Date(b.ends_at) : now) - new Date(b.starts_at)) / 60000);
    if (b.paid) paid += m; else unpaid += m;
  });
  return { paid: Math.round(paid), unpaid: Math.round(unpaid) };
}

async function isRestaurant(companyId) {
  return !!(await pool.query('SELECT 1 FROM restaurant_menu_items WHERE company_id = $1 UNION ALL SELECT 1 FROM restaurant_till_staff WHERE company_id = $1 LIMIT 1', [companyId])).rows[0];
}
async function openShiftOf(employeeId) {
  return (await pool.query('SELECT * FROM attendance WHERE employee_id = $1 AND clock_in IS NOT NULL AND clock_out IS NULL ORDER BY (date + clock_in) DESC LIMIT 1', [employeeId])).rows[0] || null;
}
async function breaksOf(attendanceIds) {
  if (!attendanceIds.length) return {};
  var out = {};
  (await pool.query('SELECT * FROM attendance_breaks WHERE attendance_id = ANY($1::uuid[]) ORDER BY starts_at', [attendanceIds])).rows
    .forEach(function (b) { (out[b.attendance_id] = out[b.attendance_id] || []).push(b); });
  return out;
}
// Today's shift on the rota, published.
async function planned(companyId, employeeId, day) {
  return (await pool.query('SELECT starts, ends, role FROM restaurant_rota_shifts WHERE company_id = $1 AND employee_id = $2 AND day = $3 AND published ORDER BY starts LIMIT 1', [companyId, employeeId, day])).rows[0] || null;
}

// Where someone stands: out, in, or on a break; since when; today's planned shift.
async function stateOf(emp) {
  var open = await openShiftOf(emp.id);
  var today = new Date().toISOString().slice(0, 10);
  var plan = await planned(emp.company_id, emp.id, today);
  var out = { name: emp.first_name + ' ' + emp.last_name, firstName: emp.first_name, state: 'out', since: null, workedMinutes: 0, breakMinutes: 0,
    planned: plan ? { starts: hm(plan.starts), ends: hm(plan.ends), role: plan.role } : null };
  if (!open) return out;
  var br = (await breaksOf([open.id]))[open.id] || [];
  var onBreak = br.find(function (b) { return !b.ends_at; });
  var span = spanOf(open), now = new Date(), bm = breakMinutes(br, now);
  out.state = onBreak ? 'break' : 'in';
  out.since = onBreak ? onBreak.starts_at : span.start;
  out.workedMinutes = Math.max(0, Math.round((now - span.start) / 60000) - bm.unpaid);
  out.breakMinutes = bm.unpaid + bm.paid;
  return out;
}

// POST /api/pos/timeclock { pin, action: 'status' | 'in' | 'break' | 'back' | 'out' }
async function timeclock(pin, action, ip) {
  pinAuth.checkRateLimit(ip);
  pinAuth.validatePinFormat(pin);
  var emp = (await pool.query(
    "SELECT e.id, e.first_name, e.last_name, d.company_id FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.kiosk_pin_hash = $1 AND e.status = 'active'",
    [pinAuth.hashPin(pin)])).rows[0];
  if (!emp) { pinAuth.recordFailure(ip); fail('invalid', 'Incorrect PIN.'); }
  pinAuth.recordSuccess(ip);
  if (!(await isRestaurant(emp.company_id))) fail('forbidden', 'This till clocks in the restaurant\'s staff only.');
  // A shift left open past its limit is closed first, as at the clock-in iPad.
  try { await attendance.closeOverdueShifts(attendance.resolveOccurredAt(null), emp.id); } catch (e) { /* the clock still works */ }
  var name = emp.first_name + ' ' + emp.last_name;
  var said = null;
  if (action === 'in') {
    if (await openShiftOf(emp.id)) fail('conflict', 'You are clocked in already.');
    var row = await attendance.clockInEmployee(emp.id, 'till', null, null);
    said = name + ' clocked in' + (row.minutesLate > 0 ? ', ' + row.minutesLate + ' min late' : '') + '.';
  } else if (action === 'break' || action === 'back') {
    var open = await openShiftOf(emp.id);
    if (!open) fail('conflict', 'You are not clocked in.');
    if (action === 'break') {
      var started = await pool.query('INSERT INTO attendance_breaks (attendance_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id', [open.id]);
      if (!started.rowCount) fail('conflict', 'You are on a break already.');
      said = name + ' went on a break.';
    } else {
      var ended = await pool.query('UPDATE attendance_breaks SET ends_at = now() WHERE attendance_id = $1 AND ends_at IS NULL RETURNING starts_at', [open.id]);
      if (!ended.rowCount) fail('conflict', 'You are not on a break.');
      said = name + ' came back from a ' + Math.max(1, Math.round((Date.now() - new Date(ended.rows[0].starts_at)) / 60000)) + '-minute break.';
    }
  } else if (action === 'out') {
    var cur = await openShiftOf(emp.id);
    if (!cur) fail('conflict', 'You are not clocked in.');
    await pool.query('UPDATE attendance_breaks SET ends_at = now() WHERE attendance_id = $1 AND ends_at IS NULL', [cur.id]);
    await attendance.clockOutEmployee(emp.id, null, null);
    said = name + ' clocked out.';
  } else if (action !== 'status') fail('invalid', 'Clock in, a break, back, or clock out?');
  if (said) await activity.log(pool, { companyId: emp.company_id, employeeId: emp.id, app: 'till', action: 'till.clock_' + action, summary: said });
  return await stateOf(emp);
}

// The week's timecards, for a manager: each person, each day — in, out,
// breaks, hours — against the rota.
async function week(companyId, weekOf) {
  var rota = require('./restaurantRota.service');
  var from = rota.mondayOf(weekOf), to = addDays(from, 6);
  var people = await require('./restaurantTillAccess.service').staffOf(companyId);
  var ids = people.map(function (p) { return p.id; });
  var rows = ids.length ? (await pool.query(
    'SELECT a.*, e.hourly_rate, e.daily_rate, e.basic_salary FROM attendance a JOIN employees e ON e.id = a.employee_id ' +
    'WHERE a.employee_id = ANY($1::uuid[]) AND a.date BETWEEN $2 AND $3 AND a.clock_in IS NOT NULL ORDER BY a.date, a.clock_in', [ids, from, to])).rows : [];
  var plans = (await pool.query('SELECT employee_id, day, starts, ends FROM restaurant_rota_shifts WHERE company_id = $1 AND day BETWEEN $2 AND $3 AND published', [companyId, from, to])).rows;
  var br = await breaksOf(rows.map(function (r) { return r.id; }));
  var now = new Date(), today = now.toISOString().slice(0, 10);
  var nameOf = {};
  people.forEach(function (p) { nameOf[p.id] = p.name; });
  var rate = {};
  rows.forEach(function (r) { rate[r.employee_id] = Number(r.hourly_rate) > 0 ? Number(r.hourly_rate) : Number(r.daily_rate) > 0 ? Number(r.daily_rate) / 8 : Number(r.basic_salary) > 0 ? Number(r.basic_salary) / 208 : null; });
  var cards = rows.map(function (r) {
    var span = spanOf(r), bm = breakMinutes(br[r.id], now);
    var end = span.end || now;
    var worked = Math.max(0, Math.round((end - span.start) / 60000) - bm.unpaid);
    var plan = plans.find(function (p) { return p.employee_id === r.employee_id && dayOf(p.day) === dayOf(r.date); });
    var flags = [];
    var late = 0, early = 0, over = 0;
    if (plan) {
      var ps = hm(plan.starts), pe = hm(plan.ends);
      late = mins(hm(r.clock_in)) - mins(ps);
      if (late > LATE_GRACE_MIN) flags.push('late'); else late = 0;
      var plannedMin = (mins(pe) > mins(ps) ? mins(pe) : mins(pe) + 1440) - mins(ps);
      if (span.end) {
        var outMin = Math.round((span.end - span.start) / 60000) + mins(hm(r.clock_in));
        early = (mins(ps) + plannedMin) - outMin;
        if (early > LATE_GRACE_MIN) flags.push('early'); else early = 0;
      }
      over = worked - plannedMin;
      if (over > 15) flags.push('overtime'); else over = 0;
    } else flags.push('unplanned');
    if (!span.end) flags.push('open');
    if (r.auto_clocked_out) flags.push('auto');
    return {
      id: r.id, employeeId: r.employee_id, name: nameOf[r.employee_id] || '', day: dayOf(r.date), in: hm(r.clock_in), out: hm(r.clock_out), outDay: r.clock_out_date ? dayOf(r.clock_out_date) : null,
      source: r.source, note: r.note || '', breaks: (br[r.id] || []).map(function (b) { return { id: b.id, from: when(b.starts_at), to: b.ends_at ? when(b.ends_at) : null, paid: b.paid }; }),
      breakMinutes: bm.unpaid + bm.paid, workedMinutes: worked, lateMinutes: late, earlyMinutes: early, overtimeMinutes: over, flags: flags,
      planned: plan ? { starts: hm(plan.starts), ends: hm(plan.ends) } : null, edited: !!r.adjusted_by
    };
  });
  // Planned and past, nobody came.
  var missed = plans.filter(function (p) {
    var d = dayOf(p.day);
    if (d > today || (d === today && mins(hm(p.starts)) + 60 > now.getUTCHours() * 60 + now.getUTCMinutes())) return false;
    return !rows.some(function (r) { return r.employee_id === p.employee_id && dayOf(r.date) === d; });
  }).map(function (p) { return { employeeId: p.employee_id, name: nameOf[p.employee_id] || '', day: dayOf(p.day), starts: hm(p.starts), ends: hm(p.ends) }; });
  var staff = people.map(function (p) {
    var mine = cards.filter(function (c) { return c.employeeId === p.id; });
    var minutes = mine.reduce(function (a, c) { return a + c.workedMinutes; }, 0);
    var plannedMin = plans.filter(function (x) { return x.employee_id === p.id; }).reduce(function (a, x) { var s = mins(hm(x.starts)), e = mins(hm(x.ends)); return a + ((e > s ? e : e + 1440) - s); }, 0);
    return { id: p.id, name: p.name, hours: round2(minutes / 60), plannedHours: round2(plannedMin / 60), late: mine.filter(function (c) { return c.flags.indexOf('late') >= 0; }).length,
      missed: missed.filter(function (m) { return m.employeeId === p.id; }).length, overtimeHours: round2(mine.reduce(function (a, c) { return a + c.overtimeMinutes; }, 0) / 60),
      cost: rate[p.id] != null ? round2(rate[p.id] * minutes / 60) : null, onNow: mine.some(function (c) { return c.flags.indexOf('open') >= 0; }) };
  }).filter(function (p) { return p.hours > 0 || p.plannedHours > 0; });
  return { weekStart: from, weekEnd: to, today: today, cards: cards, missed: missed, staff: staff,
    hours: round2(staff.reduce(function (a, p) { return a + p.hours; }, 0)), plannedHours: round2(staff.reduce(function (a, p) { return a + p.plannedHours; }, 0)),
    cost: round2(staff.reduce(function (a, p) { return a + (p.cost || 0); }, 0)), late: cards.filter(function (c) { return c.flags.indexOf('late') >= 0; }).length };
}

// A manager corrects a timecard: its in and out (out the next day when
// earlier than in), its breaks' minutes, with a reason kept on it.
async function correct(companyId, m, p) {
  var c = p.card || {};
  var reason = String(p.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (reason.length < 3) fail('invalid', 'Say why the time is changed.');
  if (!isTime(c.in) || (c.out && !isTime(c.out))) fail('invalid', 'Give the times like 08:00 and 16:30.');
  return withTransaction(async function (db) {
    var r = (await db.query(
      'SELECT a.* FROM attendance a JOIN employees e ON e.id = a.employee_id JOIN departments d ON d.id = e.department_id WHERE a.id = $1 FOR UPDATE OF a', [c.id])).rows[0];
    if (!r) fail('notfound', 'That timecard is gone.');
    var staff = await require('./restaurantTillAccess.service').staffOf(companyId, db);
    if (!staff.some(function (s) { return s.id === r.employee_id; })) fail('forbidden', 'That person does not work at this restaurant.');
    var day = dayOf(r.date);
    var outDay = c.out ? (mins(c.out) <= mins(c.in) ? addDays(day, 1) : null) : null;
    var was = hm(r.clock_in) + '–' + (r.clock_out ? hm(r.clock_out) : '…');
    var now = c.in + '–' + (c.out || '…');
    var note = ((r.note ? r.note + ' ' : '') + 'Corrected ' + was + ' → ' + now + ' by ' + m.first_name + ' ' + m.last_name + ': ' + reason).slice(0, 1000);
    await db.query('UPDATE attendance SET clock_in = $2, clock_out = $3, clock_out_date = $4, adjusted_by = $5, note = $6, auto_clocked_out = false WHERE id = $1',
      [r.id, c.in, c.out || null, outDay, m.id, note]);
    if (c.breakMinutes != null) {
      var b = Math.max(0, Math.min(600, Math.round(Number(c.breakMinutes) || 0)));
      await db.query('DELETE FROM attendance_breaks WHERE attendance_id = $1', [r.id]);
      if (b > 0) {
        var at = new Date(day + 'T' + c.in + ':00Z');
        await db.query('INSERT INTO attendance_breaks (attendance_id, starts_at, ends_at) VALUES ($1, $2, $3)', [r.id, at, new Date(at.getTime() + b * 60000)]);
      }
    }
    var person = staff.find(function (s) { return s.id === r.employee_id; });
    await audit(db, who(m), 'restaurant.timecard_correct', 'attendance', r.id, person.name + ' on ' + day + ': ' + was + ' → ' + now + '. ' + reason);
    await activity.log(db, { companyId: companyId, employeeId: m.id, app: 'settings', action: 'settings.timecard', summary: 'Corrected ' + person.name + '\'s timecard for ' + day + ': ' + was + ' → ' + now + ' (' + reason + ').' });
  });
}

// POST /api/pos/settings/timecards { managerPin, action: 'week' | 'correct', weekOf, card, reason }
async function tab(companyId, m, p) {
  p = p || {};
  if (p.action === 'correct') await correct(companyId, m, p);
  else if (p.action && p.action !== 'week') fail('invalid', 'Unknown action.');
  return week(companyId, isDay(p.weekOf) ? p.weekOf : new Date().toISOString().slice(0, 10));
}

module.exports = { timeclock: timeclock, tab: tab, week: week, stateOf: stateOf };
