// The kiosk explains each tap: the shift the person is meant to work, how
// long this shift ran on a clock-out, the days and hours worked so far this
// week, and how many times they were late this month. Test data uses the
// ZQK company code.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var kiosk = require('../src/services/kiosk.service');
var pinAuth = require('../src/lib/pinAuth');

var PIN = '6184';
var emp;
function iso(d) { return d.toISOString().slice(0, 10); }

async function cleanup() {
  var co = (await pool.query("SELECT id FROM companies WHERE code = 'ZQK'")).rows[0];
  if (!co) return;
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code = 'ZQK-1')");
  await pool.query("DELETE FROM employees WHERE code = 'ZQK-1'");
  await pool.query('DELETE FROM departments WHERE company_id = $1', [co.id]);
  await pool.query('DELETE FROM companies WHERE id = $1', [co.id]);
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = $1', [pinAuth.hashPin(PIN)]);
  var co = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQK', 'Zqk Works') RETURNING id")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQKF', 'Zqk Floor', $1) RETURNING id", [co.id])).rows[0];
  emp = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash, shift_start, shift_end) " +
    "VALUES ('ZQK-1', 'Zq Yaw', 'Boateng', 'zqk1@example.com', $1, current_date - 90, 'active', 'permanent', $2, '08:00', '17:00') RETURNING id",
    [dept.id, pinAuth.hashPin(PIN)])).rows[0].id;
});
test.after(async function () { await cleanup(); await pool.end(); });

test('a clock-in says the shift, the week so far and the lates this month; the clock-out says how long the shift ran', async function () {
  var now = new Date();
  var today = iso(now);
  var monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  var firstOfMonth = today.slice(0, 8) + '01';
  // an earlier full day this week (8 hours), and an earlier late day this month
  var earlierThisWeek = iso(monday) < today;
  if (earlierThisWeek) {
    await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, status, source) VALUES ($1, $2, '08:00', '16:00', 'present', 'kiosk')", [emp, iso(monday)]);
  }
  var earlierLate = firstOfMonth < today && firstOfMonth !== iso(monday);
  if (earlierLate) {
    await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, status, source) VALUES ($1, $2, '08:30', '17:00', 'late', 'kiosk')", [emp, firstOfMonth]);
  }

  var tapIn = await kiosk.clock(PIN, '10.8.8.1');
  assert.equal(tapIn.action, 'in');
  assert.equal(tapIn.firstName, 'Zq Yaw');
  assert.deepEqual(tapIn.shift, { start: '08:00', end: '17:00' });
  assert.equal(tapIn.workedMinutes, null);
  assert.equal(tapIn.week.days, (earlierThisWeek ? 1 : 0) + 1);
  assert.equal(tapIn.week.hours, earlierThisWeek ? 8 : 0);           // today's shift is still open
  var lateBefore = earlierLate ? 1 : 0;
  assert.equal(tapIn.lateThisMonth, lateBefore + (tapIn.status === 'late' ? 1 : 0));

  var tapOut = await kiosk.clock(PIN, '10.8.8.1');
  assert.equal(tapOut.action, 'out');
  assert.equal(typeof tapOut.workedMinutes, 'number');
  assert.ok(tapOut.workedMinutes >= 0 && tapOut.workedMinutes < 5);
  assert.equal(tapOut.week.days, tapIn.week.days);
  assert.ok(tapOut.week.hours >= tapIn.week.hours);
});

test('someone with no shift set gets no shift line', async function () {
  await pool.query('UPDATE employees SET shift_start = NULL, shift_end = NULL WHERE id = $1', [emp]);
  await pool.query('DELETE FROM attendance WHERE employee_id = $1 AND date = current_date', [emp]);
  var tap = await kiosk.clock(PIN, '10.8.8.2');
  assert.equal(tap.shift, null);
});
