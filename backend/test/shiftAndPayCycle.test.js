/*
 * Tests for per-employee shift hours (driving attendance lateness instead
 * of one company-wide cutoff) and the new 'daily' pay cycle. Requires
 * `npm run migrate && npm run seed` first, same as the other test files.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var app = require('../src/app');

var server;
var base;

test.before(function (t, done) {
  server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); });
});
test.after(function () { server.close(); });

async function login(email, password) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password || 'bamboo123' })
  });
  return res;
}
function authed(token) { return { Authorization: 'Bearer ' + token }; }
function jsonAuthed(token) { return Object.assign({ 'Content-Type': 'application/json' }, authed(token)); }

async function makeThrowawayEmployee(adminToken, label) {
  var depts = await (await fetch(base + '/api/departments', { headers: authed(adminToken) })).json();
  var unique = label + '-' + crypto.randomUUID().slice(0, 8);
  var res = await fetch(base + '/api/employees', {
    method: 'POST', headers: jsonAuthed(adminToken),
    body: JSON.stringify({
      firstName: unique, lastName: 'Test', email: unique.toLowerCase() + '@bplghana.com',
      departmentId: depts[0].id, positionTitle: 'Test role', hireDate: '2026-01-01', employmentType: 'permanent'
    })
  });
  var body = await res.json();
  assert.equal(res.status, 201, 'failed to create throwaway employee: ' + JSON.stringify(body));
  return body;
}

function hmMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toTimeString().slice(0, 5);
}

test('employee shift hours: settable, clearable, rejects a bad format', async function () {
  var adminToken = (await (await login('kelvin.duho@bplghana.com')).json()).token;
  var emp = await makeThrowawayEmployee(adminToken, 'shift1');

  var bad = await fetch(base + '/api/employees/' + emp.id, {
    method: 'PATCH', headers: jsonAuthed(adminToken), body: JSON.stringify({ shiftStart: '25:99' })
  });
  assert.equal(bad.status, 400);

  var set = await fetch(base + '/api/employees/' + emp.id, {
    method: 'PATCH', headers: jsonAuthed(adminToken), body: JSON.stringify({ shiftStart: '18:00', shiftEnd: '23:00' })
  });
  assert.equal(set.status, 200);
  var updated = await set.json();
  assert.equal(updated.shiftStart, '18:00');
  assert.equal(updated.shiftEnd, '23:00');
  assert.equal(updated.shift, '18:00–23:00', 'the display label should be derived from the structured times');

  var cleared = await (await fetch(base + '/api/employees/' + emp.id, {
    method: 'PATCH', headers: jsonAuthed(adminToken), body: JSON.stringify({ shiftStart: '', shiftEnd: '' })
  })).json();
  assert.equal(cleared.shiftStart, null);
  assert.equal(cleared.shiftEnd, null);
});

test('attendance lateness: an employee with a personal shift is judged against their own hours, not the company default', async function () {
  var adminToken = (await (await login('kelvin.duho@bplghana.com')).json()).token;

  // Company default late_after (07:20) would call almost any evening
  // clock-in "late" if it were still being applied — this is exactly the
  // bug being fixed: a security guard on an 18:00 shift needs their own
  // cutoff, not one inherited from a factory day shift.
  var onTime = await makeThrowawayEmployee(adminToken, 'shiftlate-ontime');
  await fetch(base + '/api/employees/' + onTime.id, {
    method: 'PATCH', headers: jsonAuthed(adminToken), body: JSON.stringify({ shiftStart: hmMinutesAgo(5) })
  });
  await fetch(base + '/api/employees/' + onTime.id + '/kiosk-pin', {
    method: 'POST', headers: jsonAuthed(adminToken), body: JSON.stringify({ pin: '6601' })
  });
  var onTimeClock = await (await fetch(base + '/api/kiosk/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '6601' })
  })).json();
  assert.equal(onTimeClock.status, 'present', 'clocking in 5 minutes after a personal shift start is within the grace window');

  var late = await makeThrowawayEmployee(adminToken, 'shiftlate-late');
  await fetch(base + '/api/employees/' + late.id, {
    method: 'PATCH', headers: jsonAuthed(adminToken), body: JSON.stringify({ shiftStart: hmMinutesAgo(25) })
  });
  await fetch(base + '/api/employees/' + late.id + '/kiosk-pin', {
    method: 'POST', headers: jsonAuthed(adminToken), body: JSON.stringify({ pin: '6602' })
  });
  var lateClock = await (await fetch(base + '/api/kiosk/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '6602' })
  })).json();
  assert.equal(lateClock.status, 'late', 'clocking in 25 minutes after a personal shift start is past the 20-minute grace window');
});

test('pay cycle: daily is accepted on employee update and usable in a pay run', async function () {
  var adminToken = (await (await login('kelvin.duho@bplghana.com')).json()).token;
  var emp = await makeThrowawayEmployee(adminToken, 'daily1');

  var set = await fetch(base + '/api/employees/' + emp.id, {
    method: 'PATCH', headers: jsonAuthed(adminToken), body: JSON.stringify({ payCycle: 'daily', dailyRate: 50 })
  });
  assert.equal(set.status, 200);
  var updated = await set.json();
  assert.equal(updated.payCycle, 'daily');

  var run = await fetch(base + '/api/payroll/runs', {
    method: 'POST', headers: jsonAuthed(adminToken),
    body: JSON.stringify({ cycle: 'daily', periodStart: '2026-01-01', periodEnd: '2026-01-01' })
  });
  assert.equal(run.status, 201, 'a daily pay run should be creatable once at least one employee is on the daily cycle');
  var runBody = await run.json();
  assert.equal(runBody.cycle, 'daily');
  assert.ok(runBody.payslips.some(function (s) { return s.employeeId === emp.id; }));
});
