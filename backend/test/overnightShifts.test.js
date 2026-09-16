/*
 * Attendance across midnight — the security team works 18:00 to 06:00.
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

function hm(t) { return t ? String(t).slice(0, 5) : null; }
function iso(d) { return d ? String(d).slice(0, 10) : null; }

// ---------------------------------------------------------------------------

test('a night shift is one row, filed under the day it started', async function () {
  var id = await guard(nightShift, '8101');

  var inTap = await tap('8101', '2026-09-08T18:00:00Z');
  assert.equal(inTap.action, 'in');
  assert.equal(inTap.time, '18:00');

  var outTap = await tap('8101', '2026-09-09T06:00:00Z');
  assert.equal(outTap.action, 'out', 'the 06:00 tap must close the night, not open a new shift');
  assert.equal(outTap.time, '06:00');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 1, 'one night worked is one attendance row, not two');
  assert.equal(iso(rows[0].date), '2026-09-08', 'filed under the night it started');
  assert.equal(hm(rows[0].clock_in), '18:00');
  assert.equal(hm(rows[0].clock_out), '06:00');
  assert.equal(iso(rows[0].clock_out_date), '2026-09-09', 'the clock-out landed on the next day');
});

test('three consecutive nights produce three rows, none of them inverted', async function () {
  var id = await guard(nightShift, '8102');

  for (var n of [8, 9, 10]) {
    var d = function (x) { return '2026-09-' + String(x).padStart(2, '0'); };
    await tap('8102', d(n) + 'T18:00:00Z');
    await tap('8102', d(n + 1) + 'T06:00:00Z');
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

  var a = await tap('8103', '2026-09-08T08:02:00Z');
  assert.equal(a.action, 'in');
  var b = await tap('8103', '2026-09-08T17:10:00Z');
  assert.equal(b.action, 'out');
  await assert.rejects(function () { return tap('8103', '2026-09-08T17:30:00Z'); },
    /already clocked in and out today/i, 'a third tap on a finished day is still refused');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].clock_out_date, null,
    'a day shift records no clock-out date — it is the same day, as it always was');
});

test('a forgotten clock-out does not swallow the next night', async function () {
  // The risk in pairing on an open shift: with a 24-hour window, a guard on
  // a nightly 18:00 shift who misses one tap-out would have every later
  // tap-in eaten as the previous shift's tap-out — one missed tap inverting
  // the record from then on. A tap nearer the shift's start than its end is
  // treated as a start instead.
  var id = await guard(nightShift, '8104');

  await tap('8104', '2026-09-08T18:00:00Z');          // Tuesday night starts
  var next = await tap('8104', '2026-09-09T18:00:00Z'); // forgot to tap out; back for Wednesday
  assert.equal(next.action, 'in', 'an 18:00 tap is the start of a night, not the end of one');
  var close = await tap('8104', '2026-09-10T06:00:00Z');
  assert.equal(close.action, 'out');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].clock_out, null, "Tuesday's shift stays open for a supervisor to correct");
  assert.equal(hm(rows[1].clock_in), '18:00', 'Wednesday night is recorded at its real start time');
  assert.equal(hm(rows[1].clock_out), '06:00');
});

test('an implausibly long shift is recorded but flagged', async function () {
  // Refusing would leave the row open forever, so it is closed — but a
  // 20-hour shift is almost certainly a missed tap-out and should not pass
  // silently.
  //
  // Uses an employee with NO shift template, because for anyone who has one
  // the shift-start rule gets there first: a tap 20 hours later is nearer
  // the next shift's start than the current one's end, so it opens a new
  // shift rather than closing a 20-hour one. Which is the better outcome —
  // this flag is the fallback for when there is no shift to reason about.
  var id = await guard(null, '8105');

  await tap('8105', '2026-09-08T08:00:00Z');
  var out = await tap('8105', '2026-09-09T04:00:00Z'); // 20 hours later
  assert.equal(out.action, 'out');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 1);
  assert.match(rows[0].note, /check whether a clock-out was missed/i);
  assert.equal(iso(rows[0].clock_out_date), '2026-09-09');
});

test('a tap beyond the open-shift window starts a fresh shift', async function () {
  var id = await guard(dayShift, '8106');

  await tap('8106', '2026-09-08T08:00:00Z');
  // More than 24 hours later: the old shift is too stale to close.
  var later = await tap('8106', '2026-09-10T08:00:00Z');
  assert.equal(later.action, 'in');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].clock_out, null, 'the stale shift is left open, not closed two days late');
});

test('a night guard clocking in on time is not marked late', async function () {
  // Lateness is judged against the employee's own shift start plus grace, so
  // an 18:00 guard tapping at 18:00 is present. Worth pinning: judged
  // against a company-wide morning threshold instead, every night shift in
  // the company would read as ten hours late.
  var id = await guard(nightShift, '8107');
  var t = await tap('8107', '2026-09-08T18:00:00Z');
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

  await tap('8108', '2026-09-08T' + start + ':00Z');
  var out = await tap('8108', '2026-09-08T' + half + ':00Z');
  assert.equal(out.action, 'out', 'a tap-out 30 minutes into a 9-hour shift closes it');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 1);
  assert.equal(hm(rows[0].clock_out), half);
});

test('a shift past its scheduled end is not closed a day late by the next tap-in', async function () {
  // The other side of the same rule: once the shift HAS run its scheduled
  // length, a tap back at its start time is the next shift beginning, not
  // this one ending. Pinned separately from the forgotten-clock-out case
  // above so that loosening the elapsed-time gate cannot quietly restore
  // the inverted-record bug.
  var id = await guard(dayShift, '8109');
  var start = hm(dayShift.start_time);

  await tap('8109', '2026-09-08T' + start + ':00Z');
  var next = await tap('8109', '2026-09-09T' + start + ':00Z'); // 24h later
  assert.equal(next.action, 'in', 'a full day later at the same clock time is a new shift');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].clock_out, null);
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

test('protection does not depend on how someone\'s hours are recorded', async function () {
  // Shift times live in two places: the shifts table, and the older
  // per-employee shift_start/shift_end columns that predate templates. The
  // forgotten-clock-out rule read the start from either but the end only
  // from a template, so an employee configured the older way had a start
  // time, no end time, and silently got no protection at all — one missed
  // tap-out would invert their record from then on, exactly the failure the
  // rule exists to prevent.
  var res = await pool.query(
    'INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, shift_start, shift_end) ' +
    "VALUES ($1, 'Legacy', 'Guard', $2, $3, current_date, 'active', 'permanent', '18:00', '06:00') RETURNING id",
    [MARK + '-legacy', 'legacyguard@bplghana.com', nightShift.department_id]);
  var id = res.rows[0].id;
  await kiosk.setPin(Object.assign({}, adminCtx, { employee: { id: id } }), id, '8110');

  await tap('8110', '2026-09-08T18:00:00Z');           // Tuesday night starts
  var next = await tap('8110', '2026-09-09T18:00:00Z'); // forgot to tap out
  assert.equal(next.action, 'in', 'an 18:00 tap is the start of a night, not the end of one');

  var rows = await rowsFor(id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].clock_out, null, "Tuesday's shift stays open for a supervisor to correct");
  assert.equal(hm(rows[1].clock_in), '18:00');
});
