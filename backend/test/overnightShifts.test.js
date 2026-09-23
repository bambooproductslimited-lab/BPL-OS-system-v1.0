/*
 * Attendance across midnight — the security team works 18:00 to 06:00.
 *
 * The rule the business wants: a tap closes whatever shift is open and
 * starts one if none is. A shift nobody clocks out of is clocked out
 * automatically 11 hours after it started — or, for someone whose own shift
 * is longer than that, an hour after it should have ended — and the next tap
 * starts the next shift, with the employee told what happened.
 *
 * attendance carries one `date` and two bare times, and the clock used to
 * find the row to close by today's date. That works for a day shift, whose
 * two taps fall on one date, and silently misrepresented a night one: the
 * 06:00 tap found no row for that morning's date and opened a second shift
 * instead of closing the previous evening's. Three nights produced four
 * rows, and the ones in the middle read "in 06:00, out 18:05" — the guard's
 * rest period between two shifts, recorded as the shift.
 *
 * A tap now closes whatever shift is open, whichever side of midnight it
 * falls, and the night is filed under the date it started.
 *
 * Requires `npm run migrate && npm run seed` first — the pretest hook does
 * both against the test database.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var kiosk = require('../src/services/kiosk.service');
var attendance = require('../src/services/attendance.service');

var MARK = 'NIGHTTEST';
var adminCtx = { can: function () { return true; }, employee: { id: null }, user: { id: null } };

var nightShift, dayShift;

test.before(async function () {
  nightShift = (await pool.query(
    "SELECT id, department_id FROM shifts WHERE end_time < start_time AND name ILIKE '%night%' LIMIT 1")).rows[0];
  dayShift = (await pool.query(
    'SELECT id, department_id, start_time, end_time FROM shifts WHERE end_time > start_time LIMIT 1')).rows[0];
  assert.ok(nightShift, 'the seed must contain a shift that crosses midnight');
  assert.ok(dayShift, 'the seed must contain an ordinary day shift');
});

test.after(async function () {
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE '" + MARK + "%')");
  await pool.query("DELETE FROM users WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE '" + MARK + "%')");
  await pool.query("DELETE FROM employees WHERE code LIKE '" + MARK + "%'");
  await pool.end();
});

// A guard of this test's own, on a given shift, with a known PIN — so no
// case depends on the seed's people or on what another case did to them.
var seq = 0;
async function guard(shift, pin) {
  seq += 1;
  // shift may be null: an employee with no shift template at all, where
  // there is no start or end time to measure a tap against.
  var res = await pool.query(
    'INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, shift_id) ' +
    "VALUES ($1, 'Night', 'Guard', $2, $3, current_date, 'active', 'permanent', $4) RETURNING id",
    [MARK + '-' + seq, 'nightguard' + seq + '@bplghana.com',
     (shift || dayShift).department_id, shift ? shift.id : null]);
  var id = res.rows[0].id;
  await kiosk.setPin(Object.assign({}, adminCtx, { employee: { id: id } }), id, pin);
  return id;
}

async function tap(pin, atISO) {
  return kiosk.clock(pin, '10.0.0.' + seq, atISO, null, null);
}

async function rowsFor(employeeId) {
  return (await pool.query(
    'SELECT date, clock_in, clock_out, clock_out_date, status, note FROM attendance WHERE employee_id = $1 ORDER BY date',
    [employeeId])).rows;
}

// Dates are anchored to a Monday in the recent past rather than written
// out, because the kiosk refuses to backdate a tap by more than fourteen
// days (attendance.service.js's MAX_BACKDATE_MS). Fixed dates worked when
// these cases were written and then quietly aged past that limit, failing
// the suite on a day nobody had touched attendance. The anchor is the most
// recent Monday strictly before today, so the earliest date used here
// (day(-6)) is at most thirteen days old however this is run, and the
// weekday-dependent cases below — Friday to Monday, a Sunday night running
// into Monday — still land on the weekdays they describe.
var ANCHOR_MONDAY = (function () {
  var d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  var back = ((d.getUTCDay() + 6) % 7) || 7; // 1..7 days back to the previous Monday
  d.setUTCDate(d.getUTCDate() - back);
  return d;
})();

// day(0) is that Monday; day(-3) the Friday before it, and so on.
function day(offset) {
  var d = new Date(ANCHOR_MONDAY);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function at(offset, hhmm) { return day(offset) + 'T' + hhmm + ':00Z'; }

function hm(t) { return t ? String(t).slice(0, 5) : null; }
function iso(d) { return d ? String(d).slice(0, 10) : null; }

// ---------------------------------------------------------------------------

test('a night shift is one row, filed under the day it started', async function () {
  var id = await guard(nightShift, '8101');

  var inTap = await tap('8101', at(-6, '18:00'));
  assert.equal(inTap.action, 'in');
  assert.equal(inTap.time, '18:00');

  var outTap = await tap('8101', at(-5, '06:00'));
  assert.equal(outTap.action, 'out', 'the 06:00 tap must close the night, not open a new shift');
  assert.equal(outTap.time, '06:00');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 1, 'one night worked is one attendance row, not two');
  assert.equal(iso(rows[0].date), day(-6), 'filed under the night it started');
  assert.equal(hm(rows[0].clock_in), '18:00');
  assert.equal(hm(rows[0].clock_out), '06:00');
  assert.equal(iso(rows[0].clock_out_date), day(-5), 'the clock-out landed on the next day');
});

test('three consecutive nights produce three rows, none of them inverted', async function () {
  var id = await guard(nightShift, '8102');

  for (var n of [-6, -5, -4]) {
    await tap('8102', at(n, '18:00'));
    await tap('8102', at(n + 1, '06:00'));
  }

  var rows = await rowsFor(id);
  assert.equal(rows.length, 3, 'three nights, three rows — this was four before');
  rows.forEach(function (r) {
    assert.equal(hm(r.clock_in), '18:00', 'every row starts in the evening');
    assert.equal(hm(r.clock_out), '06:00', 'every row ends in the morning');
    assert.ok(r.clock_out_date, 'every row records the clock-out on the following day');
  });
  // The failure this replaces: rows reading in 06:00 -> out 18:00, which is
  // the time between two shifts rather than a shift.
  assert.equal(rows.filter(function (r) { return hm(r.clock_in) === '06:00'; }).length, 0,
    'no row may record the rest period between two nights as the shift');
});

test('an ordinary day shift is unchanged, including the third-tap refusal', async function () {
  var id = await guard(dayShift, '8103');

  var a = await tap('8103', at(-6, '08:02'));
  assert.equal(a.action, 'in');
  var b = await tap('8103', at(-6, '17:10'));
  assert.equal(b.action, 'out');
  await assert.rejects(function () { return tap('8103', at(-6, '17:30')); },
    /already clocked in and out today/i, 'a third tap on a finished day is still refused');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].clock_out_date, null,
    'a day shift records no clock-out date — it is the same day, as it always was');
});

test('a shift nobody clocks out of is closed after 11 hours, and the next tap starts a new one', async function () {
  // Uses an employee with no shift template: the plain 11-hour rule.
  var id = await guard(null, '8105');

  await tap('8105', at(-6, '08:00'));
  var next = await tap('8105', at(-5, '04:00')); // 20 hours later
  assert.equal(next.action, 'in', 'the forgotten shift was already closed, so this starts the next one');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 2);
  assert.equal(hm(rows[0].clock_out), '19:00', 'clocked out at clock-in + 11 hours, not when anyone noticed');
  assert.equal(rows[0].clock_out_date, null, 'the same day it started');
  assert.match(rows[0].note, /clocked out automatically after 11 hours/i);
  assert.equal(hm(rows[1].clock_in), '04:00');
});

test('a night guard clocking in on time is not marked late', async function () {
  // Lateness is judged against the employee's own shift start plus grace, so
  // an 18:00 guard tapping at 18:00 is present. Worth pinning: judged
  // against a company-wide morning threshold instead, every night shift in
  // the company would read as ten hours late.
  var id = await guard(nightShift, '8107');
  var t = await tap('8107', at(-6, '18:00'));
  assert.equal(t.status, 'present');
  assert.equal(t.minutesLate, 0);

  var rows = await rowsFor(id);
  assert.equal(rows[0].status, 'present');
});

test('clocking out shortly after clocking in still works', async function () {
  // The regression the first version of this fix caused, caught by the
  // existing kiosk test rather than by anything here. An employee who taps
  // in at the start of their shift and out again half an hour later —
  // arrived, then sent home — is close to the shift's start and a long way
  // from its end, so the "this tap looks like a new shift" rule fired and
  // the tap-out was refused. They could not clock out at all.
  //
  // The shift has run half an hour of a nine-hour day, so it is nowhere near
  // due to close, and the tap is the end of it whatever the clock says.
  var id = await guard(dayShift, '8108');

  var start = hm(dayShift.start_time);
  var half = String(Number(start.slice(0, 2))).padStart(2, '0') + ':30';

  await tap('8108', at(-6, start));
  var out = await tap('8108', at(-6, half));
  assert.equal(out.action, 'out', 'a tap-out 30 minutes into a 9-hour shift closes it');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 1);
  assert.equal(hm(rows[0].clock_out), half);
});

test('lateness is judged around the shift, not by comparing clock strings', async function () {
  // A guard due at 18:00 has a late cutoff of 18:20. Comparing the two
  // times as strings, an arrival at 01:00 gives '01:00' > '18:20' — false —
  // so a guard seven hours late was recorded present. Every evening and
  // night shift in the company under-reported lateness the moment the clock
  // passed midnight.
  var rule = { cutoff: '18:20', shiftStart: '18:00' };

  assert.deepEqual(attendance.judgeLateness(rule, '18:00'), { status: 'present', minutesLate: 0 });
  assert.deepEqual(attendance.judgeLateness(rule, '17:55'), { status: 'present', minutesLate: 0 },
    'early is never late, and 17:55 must not read as nearly a full day late');
  assert.deepEqual(attendance.judgeLateness(rule, '18:20'), { status: 'present', minutesLate: 0 },
    'the grace period itself is not late');
  assert.deepEqual(attendance.judgeLateness(rule, '18:25'), { status: 'late', minutesLate: 5 });

  // The cases that were wrong: all of these land after midnight.
  assert.deepEqual(attendance.judgeLateness(rule, '00:30'), { status: 'late', minutesLate: 370 });
  assert.deepEqual(attendance.judgeLateness(rule, '01:00'), { status: 'late', minutesLate: 400 });
});

test('lateness on a day shift and with no shift at all is unchanged', async function () {
  var day = { cutoff: '08:20', shiftStart: '08:00' };
  assert.deepEqual(attendance.judgeLateness(day, '07:55'), { status: 'present', minutesLate: 0 });
  assert.deepEqual(attendance.judgeLateness(day, '09:00'), { status: 'late', minutesLate: 40 });

  // No shift template: settings.late_after is an absolute time of day, not a
  // point relative to anything, so it does not wrap and is compared exactly
  // as it always was.
  var none = { cutoff: '07:20', shiftStart: null };
  assert.deepEqual(attendance.judgeLateness(none, '07:00'), { status: 'present', minutesLate: 0 });
  assert.deepEqual(attendance.judgeLateness(none, '07:30'), { status: 'late', minutesLate: 10 });
});

test('a forgotten clock-out is closed at 11 hours, not when the employee next appears', async function () {
  // The rule this file used to assert the opposite of: the shift used to
  // keep running until the next tap closed it — Friday to Monday read as a
  // 74-hour shift.
  var id = await guard(dayShift, '8111');

  await tap('8111', at(-3, '07:00'));                 // Friday, arrives, never taps out
  var monday = await tap('8111', at(0, '09:30'));    // Monday
  assert.equal(monday.action, 'in', 'Monday is a clock-in, not the end of Friday');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 2);
  assert.equal(hm(rows[0].clock_in), '07:00');
  assert.equal(hm(rows[0].clock_out), '18:00');
  assert.equal(iso(rows[0].date), day(-3));
  var flagged = await pool.query('SELECT auto_clocked_out FROM attendance WHERE employee_id = $1 AND date = $2', [id, day(-3)]);
  assert.equal(flagged.rows[0].auto_clocked_out, true);
});

test('one tap on arrival after a forgotten clock-out, not two', async function () {
  // Before, an employee who forgot yesterday tapped twice: once to close
  // yesterday, once to start today.
  var id = await guard(dayShift, '8112');

  var a = await tap('8112', at(-1, '07:00'));
  assert.equal(a.action, 'in');
  var b = await tap('8112', at(0, '07:00'));
  assert.equal(b.action, 'in', 'yesterday was closed at 18:00; this starts today');
  var c = await tap('8112', at(0, '16:00'));
  assert.equal(c.action, 'out');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 2);
  assert.equal(hm(rows[0].clock_out), '18:00');
  assert.equal(hm(rows[1].clock_in), '07:00');
  assert.equal(hm(rows[1].clock_out), '16:00');
});

test('a guard on a 12-hour night shift gets their shift plus an hour, not 11 hours', async function () {
  // 18:00 to 06:00 is 12 hours. Cut at 11, every night would close at 05:00
  // and the guard's real 06:00 tap would read as the start of a new shift.
  var id = await guard(nightShift, '8114');
  await tap('8114', at(-6, '18:00'));

  var early = await attendance.closeOverdueShifts({ date: day(-5), time: '06:59' }, id);
  assert.equal(early.length, 0, 'still open at 06:59 — within 12 hours + 1');
  var due = await attendance.closeOverdueShifts({ date: day(-5), time: '07:00' }, id);
  assert.equal(due.length, 1, 'closed at 07:00');

  var rows = await rowsFor(id);
  assert.equal(hm(rows[0].clock_out), '07:00');
  assert.equal(iso(rows[0].clock_out_date), day(-5), 'the next morning');
  assert.match(rows[0].note, /after 13 hours/);
});

test('a delayed tap from the offline queue replaces the automatic clock-out', async function () {
  // The kiosk queues taps while it has no connection and replays them later
  // with their real time. If the background check closed the shift in the
  // meantime, the replayed tap-out is still the real one.
  var id = await guard(null, '8115');
  await tap('8115', at(-6, '08:00'));
  await attendance.closeOverdueShifts({ date: day(-5), time: '00:00' }, id); // closed at 19:00

  var replayed = await tap('8115', at(-6, '17:05'));
  assert.equal(replayed.action, 'out');
  assert.equal(replayed.time, '17:05');

  var row = (await pool.query('SELECT clock_out, auto_clocked_out, note FROM attendance WHERE employee_id = $1', [id])).rows[0];
  assert.equal(hm(row.clock_out), '17:05');
  assert.equal(row.auto_clocked_out, false);
  assert.doesNotMatch(row.note, /automatically/);
});

test('tapping again after an automatic clock-out the same day says what happened', async function () {
  var id = await guard(null, '8116');
  await tap('8116', at(-6, '06:00'));
  await assert.rejects(function () { return tap('8116', at(-6, '17:30')); },
    /clocked out automatically at 17:00/);
  assert.equal((await rowsFor(id)).length, 1);
});

test('the employee is told at their next clock-in, once, and only about recent shifts', async function () {
  var id = await guard(null, '8117');
  var today = new Date().toISOString().slice(0, 10);
  var yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  var longAgo = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status, source) VALUES ($1, $2, '07:00', 'present', 'kiosk')", [id, yesterday]);
  // Closed automatically weeks ago and never shown — the backlog from the
  // first time the check runs. Marked seen, but not worth a popup.
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, auto_clocked_out, status, source) VALUES ($1, $2, '07:00', '18:00', true, 'present', 'kiosk')", [id, longAgo]);

  // A live tap: no occurredAt.
  var live = await kiosk.clock('8117', '10.0.1.17', null, null, null);
  assert.equal(live.action, 'in');
  assert.deepEqual(live.autoClosedShifts, [{ date: yesterday, clockIn: '07:00', clockOut: '18:00', clockOutDate: yesterday }]);

  assert.deepEqual(await attendance.takeAutoClockOutNotices(id), [], 'told once');
  var unseen = await pool.query('SELECT count(*)::int AS n FROM attendance WHERE employee_id = $1 AND auto_clocked_out AND auto_clock_out_seen_at IS NULL', [id]);
  assert.equal(unseen.rows[0].n, 0, 'the old one is marked seen too');
  await pool.query('DELETE FROM attendance WHERE employee_id = $1 AND date = $2', [id, today]);
});

test('a replayed offline clock-in does not use up the notice', async function () {
  // Nobody is standing at the kiosk to read the result of a replayed tap.
  var id = await guard(null, '8118');
  await tap('8118', at(-6, '07:00'));
  var replay = await tap('8118', at(-5, '07:00'));
  assert.equal(replay.action, 'in');
  assert.deepEqual(replay.autoClosedShifts, []);
  var unseen = await pool.query('SELECT count(*)::int AS n FROM attendance WHERE employee_id = $1 AND auto_clocked_out AND auto_clock_out_seen_at IS NULL', [id]);
  assert.equal(unseen.rows[0].n, 1, 'still waiting for a live tap to show it');
});

test('a supervisor correcting the clock-out makes it a real time', async function () {
  var id = await guard(null, '8119');
  await tap('8119', at(-6, '08:00'));
  await attendance.closeOverdueShifts({ date: day(-5), time: '00:00' }, id);
  var row = (await pool.query('SELECT id FROM attendance WHERE employee_id = $1', [id])).rows[0];

  var fixed = await attendance.adjust(adminCtx, { id: row.id, clockOut: '17:15', note: 'Left at 17:15 — confirmed by supervisor.' });
  assert.equal(fixed.clockOut, '17:15');
  assert.equal(fixed.autoClockedOut, false);

  var noteOnly = await attendance.adjust(adminCtx, { id: row.id, note: 'Status only.' });
  assert.equal(noteOnly.autoClockedOut, false, 'stays a real time');
});

test('a second shift on the same calendar day is refused, and says so', async function () {
  // Not a rule, a schema limit: attendance is UNIQUE (employee_id, date), so
  // one employee has at most one row per day. Someone who finishes at noon
  // and comes back at 14:00 cannot be recorded. Pinned so that if the
  // constraint is ever lifted to allow split shifts, this test fails and
  // says where to look rather than the behaviour changing unnoticed.
  var id = await guard(dayShift, '8113');

  await tap('8113', at(0, '07:00'));
  await tap('8113', at(0, '12:00'));
  await assert.rejects(function () { return tap('8113', at(0, '14:00')); },
    /already clocked in and out today/i);

  var rows = await rowsFor(id);
  assert.equal(rows.length, 1);
  assert.equal(hm(rows[0].clock_out), '12:00');
});
