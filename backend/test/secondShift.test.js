/*
 * Staff who work two shifts in a day (migration 0112): a day shift, a break,
 * then a night shift. Their record carries a second shift; each shift they
 * work is its own attendance row, judged against its own start, clocked out
 * automatically against its own length, and paid as a day.
 *
 * Requires `npm run migrate && npm run seed` first — the pretest hook does
 * both against the test database.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var kiosk = require('../src/services/kiosk.service');
var attendance = require('../src/services/attendance.service');
var employees = require('../src/services/employees.service');
var payroll = require('../src/services/payroll.service');
var { buildContext } = require('../src/services/context.service');

var MARK = 'ZQTWO';
var adminCtx = { can: function () { return true; }, employee: { id: null }, user: { id: null } };
var boss, dept, runId;

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  dept = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0].id;
});
test.after(async function () {
  if (runId) await pool.query('DELETE FROM pay_runs WHERE id = $1', [runId]);
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE '" + MARK + "%')");
  await pool.query("DELETE FROM employees WHERE code LIKE '" + MARK + "%'");
  await pool.end();
});

var seq = 0;
// Day 07:00–16:00, and (when two) night 18:00–06:00 as their second shift.
async function person(pin, two, rate) {
  seq += 1;
  var id = (await pool.query(
    'INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, shift_start, shift_end, second_shift_start, second_shift_end, daily_rate) ' +
    "VALUES ($1, 'Zq', $2, $3, $4, '2018-01-01', 'active', 'permanent', '07:00', '16:00', $5, $6, $7) RETURNING id",
    [MARK + '-' + seq, 'Two ' + seq, 'zq.two' + seq + '@example.com', dept, two ? '18:00' : null, two ? '06:00' : null, rate || 0])).rows[0].id;
  if (pin) await kiosk.setPin(Object.assign({}, adminCtx, { employee: { id: id } }), id, pin);
  return id;
}
async function tap(pin, atISO) { return kiosk.clock(pin, '10.9.0.' + seq, atISO, null, null); }
function day(offset) {
  var d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function at(offset, hhmm) { return day(offset) + 'T' + hhmm + ':00Z'; }
async function rows(id) {
  return (await pool.query(
    "SELECT to_char(date, 'YYYY-MM-DD') AS date, shift_no, to_char(clock_in, 'HH24:MI') AS cin, to_char(clock_out, 'HH24:MI') AS cout, " +
    "to_char(clock_out_date, 'YYYY-MM-DD') AS out_date, status, auto_clocked_out FROM attendance WHERE employee_id = $1 ORDER BY date, shift_no", [id])).rows;
}

test('a day shift and a night shift are two rows, each judged against its own start', async function () {
  var id = await person('8701', true);
  var a = await tap('8701', at(-5, '07:04'));
  assert.equal(a.action, 'in'); assert.equal(a.status, 'present');
  assert.equal((await tap('8701', at(-5, '16:02'))).action, 'out');
  // Back for the night shift: 18:45 is late against 18:00, whatever the grace.
  var grace = attendance.graceOn(await attendance.graceSchedule(), day(-5));
  var n = await tap('8701', at(-5, '18:45'));
  assert.equal(n.action, 'in');
  assert.equal(n.status, 'late');
  assert.equal(n.minutesLate, 45 - grace);
  assert.deepEqual(n.shift, { start: '18:00', end: '06:00', second: true });
  // Out at 06:00 the next morning closes the night shift…
  assert.equal((await tap('8701', at(-4, '06:01'))).action, 'out');
  // …and 07:00 starts the next day's day shift.
  assert.equal((await tap('8701', at(-4, '06:58'))).status, 'present');
  assert.deepEqual(await rows(id), [
    { date: day(-5), shift_no: 1, cin: '07:04', cout: '16:02', out_date: null, status: 'present', auto_clocked_out: false },
    { date: day(-5), shift_no: 2, cin: '18:45', cout: '06:01', out_date: day(-4), status: 'late', auto_clocked_out: false },
    { date: day(-4), shift_no: 1, cin: '06:58', cout: null, out_date: null, status: 'present', auto_clocked_out: false }
  ]);
});

test('a third clock-in the same day is refused, and a one-shift person is refused as before', async function () {
  var two = await person('8702', true);
  await tap('8702', at(-6, '07:00')); await tap('8702', at(-6, '15:59'));
  await tap('8702', at(-6, '17:58')); await tap('8702', at(-6, '23:30'));
  assert.equal(await attendance.alreadyClosedMessage(two, day(-6)), 'You have already worked both of your shifts today.');
  await assert.rejects(tap('8702', at(-6, '23:45')), /already worked both of your shifts/);

  var one = await person('8703', false);
  await tap('8703', at(-6, '07:00')); await tap('8703', at(-6, '16:00'));
  await assert.rejects(tap('8703', at(-6, '18:00')), /already clocked in and out today/);
  assert.equal((await rows(one)).length, 1);
});

test('a night shift on its own is the second shift, and its automatic clock-out follows its length', async function () {
  var id = await person('8704', true);
  var n = await tap('8704', at(-3, '17:57'));
  assert.equal(n.status, 'present');
  assert.equal((await rows(id))[0].shift_no, 2);
  // 18:00–06:00 is 12 hours, so it stays open past the usual 11…
  await attendance.closeOverdueShifts({ date: day(-2), time: '05:30' }, id);
  assert.equal((await rows(id))[0].cout, null);
  // …and is closed an hour after it should have ended.
  await attendance.closeOverdueShifts({ date: day(-2), time: '07:00' }, id);
  var r = (await rows(id))[0];
  assert.equal(r.cout, '06:57');
  assert.equal(r.auto_clocked_out, true);
});

test('the day list and the report show both shifts', async function () {
  var id = await person('8705', true);
  await tap('8705', at(-8, '07:00')); await tap('8705', at(-8, '16:00'));
  await tap('8705', at(-8, '18:00')); await tap('8705', at(-7, '06:00'));
  var list = await attendance.list(boss, { date: day(-8) });
  var me = list.rows.find(function (r) { return r.employeeId === id; });
  assert.equal(me.shiftNo, 1);
  assert.equal(String(me.clockIn).slice(0, 5), '07:00');
  assert.equal(me.secondShiftStart, '18:00');
  assert.equal(String(me.secondShift.clockIn).slice(0, 5), '18:00');
  assert.equal(me.secondShift.status, 'present');

  var rep = await attendance.report(boss, day(-8), day(-8));
  var mine = rep.rows.filter(function (r) { return r.employeeId === id; });
  assert.deepEqual(mine.map(function (r) { return [r.shiftNo, r.clockIn, r.status]; }), [[1, '07:00', 'present'], [2, '18:00', 'present']]);
});

test('each shift worked is a day\'s pay', async function () {
  var id = await person(null, true, 100);
  // Directly on the record, in a month no other test pays: 3 days, one of them double.
  await pool.query(
    "INSERT INTO attendance (employee_id, date, shift_no, clock_in, clock_out, status) VALUES " +
    "($1, '2019-02-04', 1, '07:00', '16:00', 'present'), ($1, '2019-02-04', 2, '18:00', '06:00', 'present'), " +
    "($1, '2019-02-05', 1, '07:00', '16:00', 'late'), ($1, '2019-02-06', 1, '07:00', '16:00', 'present')", [id]);
  var run = await payroll.create(boss, { cycle: 'monthly', periodStart: '2019-02-01', periodEnd: '2019-02-28', payDate: '2019-03-05' });
  runId = run.id;
  var slip = (await pool.query('SELECT days_worked, gross_pay FROM payslips WHERE pay_run_id = $1 AND employee_id = $2', [run.id, id])).rows[0];
  assert.equal(Number(slip.days_worked), 4);
  assert.equal(Number(slip.gross_pay), 400);
});

test('the second shift on the employee record needs a start and an end', async function () {
  var id = await person(null, false);
  var e = await employees.update(boss, id, { secondShiftStart: '18:00', secondShiftEnd: '06:00' });
  assert.equal(e.secondShiftStart, '18:00');
  assert.equal(e.secondShiftEnd, '06:00');
  await assert.rejects(employees.update(boss, id, { secondShiftStart: '18:00', secondShiftEnd: '' }), /start and an end time/);
  var cleared = await employees.update(boss, id, { secondShiftStart: '', secondShiftEnd: '' });
  assert.equal(cleared.secondShiftStart, null);
  // A second-shift record can't be added by hand for someone without one.
  await assert.rejects(attendance.adjust(boss, { employeeId: id, date: day(-9), shiftNo: 2, note: 'Zq check' }), /second shift on their record/);
});
