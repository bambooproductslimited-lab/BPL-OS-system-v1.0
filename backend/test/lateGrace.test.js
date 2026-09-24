/*
 * The late grace: how long after their own shift start an employee is still
 * on time. It was 20 minutes; it is 10 from the day migration 0074 ran, and
 * can be changed in Company settings. Each day is judged by the grace in
 * force on that day, so a change never re-judges the past.
 *
 * Borrows one seeded employee's shift for the test and puts it back.
 * Requires `npm run migrate && npm run seed` first (the pretest hook).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var attendance = require('../src/services/attendance.service');
var settings = require('../src/services/settings.service');
var { buildContext } = require('../src/services/context.service');

var EMAIL = 'alice.kamau@bplghana.com';
var emp, saved, admin;
function iso(daysFromToday) { return new Date(Date.now() + daysFromToday * 86400000).toISOString().slice(0, 10); }

test.before(async function () {
  emp = (await pool.query('SELECT e.id, e.shift_start, e.shift_id FROM employees e WHERE e.email = $1', [EMAIL])).rows[0];
  saved = { shiftStart: emp.shift_start, shiftId: emp.shift_id };
  await pool.query("UPDATE employees SET shift_start = '08:00', shift_id = NULL WHERE id = $1", [emp.id]);
  var kelvin = (await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0];
  admin = await buildContext(kelvin.id);
});
test.after(async function () {
  await pool.query('UPDATE employees SET shift_start = $2, shift_id = $3 WHERE id = $1', [emp.id, saved.shiftStart, saved.shiftId]);
  await pool.query('DELETE FROM late_grace WHERE effective_from = CURRENT_DATE');
  await pool.query('INSERT INTO late_grace (effective_from, minutes) VALUES (CURRENT_DATE, 10)');
  await pool.query('DELETE FROM late_grace WHERE effective_from > CURRENT_DATE');
  await pool.end();
});

test('from today, late means more than 10 minutes past the shift start; before today it was 20', async function () {
  var today = await attendance.resolveLateRule(emp.id, iso(0));
  assert.deepEqual(today, { cutoff: '08:10', shiftStart: '08:00' });
  assert.deepEqual(attendance.judgeLateness(today, '08:10'), { status: 'present', minutesLate: 0 });
  assert.deepEqual(attendance.judgeLateness(today, '08:11'), { status: 'late', minutesLate: 1 });
  assert.deepEqual(attendance.judgeLateness(today, '08:15'), { status: 'late', minutesLate: 5 });

  var before = await attendance.resolveLateRule(emp.id, iso(-1));
  assert.deepEqual(before, { cutoff: '08:20', shiftStart: '08:00' }, 'yesterday is judged by the rule it had');
  assert.deepEqual(attendance.judgeLateness(before, '08:15'), { status: 'present', minutesLate: 0 });

  // A night shift wraps the same way it always did.
  await pool.query("UPDATE employees SET shift_start = '23:55' WHERE id = $1", [emp.id]);
  var night = await attendance.resolveLateRule(emp.id, iso(0));
  assert.deepEqual(night, { cutoff: '00:05', shiftStart: '23:55' });
  assert.deepEqual(attendance.judgeLateness(night, '00:05'), { status: 'present', minutesLate: 0 });
  assert.deepEqual(attendance.judgeLateness(night, '00:20'), { status: 'late', minutesLate: 15 });
  await pool.query("UPDATE employees SET shift_start = '08:00' WHERE id = $1", [emp.id]);
});

test('Company settings changes the grace from today, and only managers can', async function () {
  var s = await settings.get(admin);
  assert.equal(s.lateGraceMinutes, 10);
  assert.equal(s.lateAfter, '07:10', 'the fixed time for staff with no shift moved with it');

  var viewer = Object.assign({}, admin, { can: function (p) { return p === 'employee.read'; } });
  await assert.rejects(settings.save(viewer, { lateGraceMinutes: 30 }), /settings\.manage/);
  await assert.rejects(settings.save(admin, { lateGraceMinutes: 7.5 }), /whole number/);
  await assert.rejects(settings.save(admin, { lateGraceMinutes: 999 }), /whole number/);

  var after = await settings.save(admin, { lateGraceMinutes: 15 });
  assert.equal(after.lateGraceMinutes, 15);
  assert.equal((await attendance.resolveLateRule(emp.id, iso(0))).cutoff, '08:15');
  assert.equal((await attendance.resolveLateRule(emp.id, iso(-1))).cutoff, '08:20', 'the past is untouched');
});
