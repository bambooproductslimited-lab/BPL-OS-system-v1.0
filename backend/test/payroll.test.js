/*
 * Integration test for payroll: pay cycles, daily-rate compensation fields
 * (and their access control), pay run creation from Attendance-derived
 * days worked, SSNIT/PAYE calculation, and the draft -> approved -> paid
 * status flow. Requires `npm run migrate && npm run seed` first.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');

var server;
var base;

test.before(function (t, done) {
  server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); });
});
test.after(function () { server.close(); });

async function login(email) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: 'bamboo123' })
  });
  return (await res.json()).token;
}
function authed(token) { return { Authorization: 'Bearer ' + token }; }
function jsonAuthed(token) { return Object.assign({ 'Content-Type': 'application/json' }, authed(token)); }

test('employee pay fields: hidden and unwritable without payroll.manage, editable with it', async function () {
  var albert = await login('albert.awini@bplghana.com'); // finance_hr_manager — has payroll.manage
  var frank = await login('frank.kampewu@bplghana.com'); // general_manager — employee.write, no payroll.manage
  var alice = await login('alice.kamau@bplghana.com'); // employee — neither

  var asAlice = await (await fetch(base + '/api/employees', { headers: authed(alice) })).json();
  assert.equal('payCycle' in asAlice[0], false);
  assert.equal('dailyRate' in asAlice[0], false);

  var asAlbert = await (await fetch(base + '/api/employees', { headers: authed(albert) })).json();
  assert.ok('payCycle' in asAlbert[0]);
  assert.ok('dailyRate' in asAlbert[0]);
  var target = asAlbert.find(function (e) { return e.email === 'alice.kamau@bplghana.com'; });

  var deniedWrite = await fetch(base + '/api/employees/' + target.id, {
    method: 'PATCH', headers: jsonAuthed(frank), body: JSON.stringify({ dailyRate: 999 })
  });
  assert.equal(deniedWrite.status, 403);

  var okOtherField = await fetch(base + '/api/employees/' + target.id, {
    method: 'PATCH', headers: jsonAuthed(frank), body: JSON.stringify({ location: 'Accra Office' })
  });
  assert.equal(okOtherField.status, 200);

  var setRate = await fetch(base + '/api/employees/' + target.id, {
    method: 'PATCH', headers: jsonAuthed(albert), body: JSON.stringify({ payCycle: 'biweekly', dailyRate: 120 })
  });
  assert.equal(setRate.status, 200);
  var updated = await setRate.json();
  assert.equal(updated.payCycle, 'biweekly');
  assert.equal(updated.dailyRate, 120);
});

test('pay run: computes days worked from attendance, SSNIT/PAYE, draft -> approved -> paid', async function () {
  var albert = await login('albert.awini@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var employees = await (await fetch(base + '/api/employees', { headers: authed(albert) })).json();
  var target = employees.find(function (e) { return e.email === 'alice.kamau@bplghana.com'; });

  // Set a known rate/cycle and seed 6 present/late days + 1 absent (should not count) in the period.
  await fetch(base + '/api/employees/' + target.id, {
    method: 'PATCH', headers: jsonAuthed(albert), body: JSON.stringify({ payCycle: 'biweekly', dailyRate: 100 })
  });
  var dates = [
    ['2026-01-05', 'present'], ['2026-01-06', 'present'], ['2026-01-07', 'late'],
    ['2026-01-08', 'present'], ['2026-01-09', 'present'], ['2026-01-12', 'present'],
    ['2026-01-13', 'absent']
  ];
  for (var i = 0; i < dates.length; i++) {
    var adjRes = await fetch(base + '/api/attendance/adjust', {
      method: 'POST', headers: jsonAuthed(albert),
      body: JSON.stringify({ employeeId: target.id, date: dates[i][0], status: dates[i][1], note: 'payroll test seed' })
    });
    assert.equal(adjRes.status, 200);
  }

  var deniedCreate = await fetch(base + '/api/payroll/runs', {
    method: 'POST', headers: jsonAuthed(alice),
    body: JSON.stringify({ cycle: 'biweekly', periodStart: '2026-01-01', periodEnd: '2026-01-14' })
  });
  assert.equal(deniedCreate.status, 403);

  var createRes = await fetch(base + '/api/payroll/runs', {
    method: 'POST', headers: jsonAuthed(albert),
    body: JSON.stringify({ cycle: 'biweekly', periodStart: '2026-01-01', periodEnd: '2026-01-14', payDate: '2026-01-16' })
  });
  assert.equal(createRes.status, 201);
  var run = await createRes.json();
  assert.match(run.runNo, /^PR-\d{4}-\d{4}$/);
  assert.equal(run.status, 'draft');

  var slip = run.payslips.find(function (s) { return s.employeeId === target.id; });
  assert.equal(slip.daysWorked, 6); // 5 present + 1 late, the absent day excluded
  assert.equal(slip.grossPay, 600); // 100 * 6
  assert.equal(slip.ssnitEmployee, 33); // 5.5% of 600
  assert.equal(slip.ssnitEmployer, 78); // 13% of 600
  assert.equal(slip.taxableIncome, 567); // 600 - 33
  assert.ok(slip.payeTax >= 0);
  assert.equal(slip.netPay, Math.round((600 - 33 - slip.payeTax) * 100) / 100);

  // Editable while draft — correct days worked, everything downstream recalculates.
  var editRes = await fetch(base + '/api/payroll/runs/' + run.id + '/payslips/' + target.id, {
    method: 'PUT', headers: jsonAuthed(albert), body: JSON.stringify({ daysWorked: 7 })
  });
  var editedRun = await editRes.json();
  var editedSlip = editedRun.payslips.find(function (s) { return s.employeeId === target.id; });
  assert.equal(editedSlip.daysWorked, 7);
  assert.equal(editedSlip.grossPay, 700);

  var approveRes = await fetch(base + '/api/payroll/runs/' + run.id + '/approve', { method: 'POST', headers: authed(albert) });
  assert.equal((await approveRes.json()).status, 'approved');

  var editAfterApprove = await fetch(base + '/api/payroll/runs/' + run.id + '/payslips/' + target.id, {
    method: 'PUT', headers: jsonAuthed(albert), body: JSON.stringify({ daysWorked: 1 })
  });
  assert.equal(editAfterApprove.status, 400);

  var paidRes = await fetch(base + '/api/payroll/runs/' + run.id + '/paid', { method: 'POST', headers: authed(albert) });
  assert.equal((await paidRes.json()).status, 'paid');

  var list = await (await fetch(base + '/api/payroll/runs', { headers: authed(albert) })).json();
  assert.ok(list.some(function (r) { return r.id === run.id; }));
});

test('payslip history: permission-gated, requires employeeId, filters by period, spans multiple runs', async function () {
  var albert = await login('albert.awini@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var employees = await (await fetch(base + '/api/employees', { headers: authed(albert) })).json();
  var target = employees.find(function (e) { return e.email === 'alice.kamau@bplghana.com'; });

  var deniedRead = await fetch(base + '/api/payroll/payslips?employeeId=' + target.id, { headers: authed(alice) });
  assert.equal(deniedRead.status, 403);

  var missingId = await fetch(base + '/api/payroll/payslips', { headers: authed(albert) });
  assert.equal(missingId.status, 400);

  // A second run in a later period, on top of the January run from the previous test.
  var febRun = await (await fetch(base + '/api/payroll/runs', {
    method: 'POST', headers: jsonAuthed(albert),
    body: JSON.stringify({ cycle: 'biweekly', periodStart: '2026-02-01', periodEnd: '2026-02-14', payDate: '2026-02-16' })
  })).json();

  var allHistory = await (await fetch(base + '/api/payroll/payslips?employeeId=' + target.id, { headers: authed(albert) })).json();
  assert.equal(allHistory.employeeId, target.id);
  assert.ok(allHistory.payslips.length >= 2);
  assert.ok(allHistory.payslips[0].payDate >= allHistory.payslips[allHistory.payslips.length - 1].payDate); // newest first
  assert.ok(allHistory.payslips.some(function (s) { return s.runNo === febRun.runNo; }));

  var febOnly = await (await fetch(
    base + '/api/payroll/payslips?employeeId=' + target.id + '&from=2026-02-01&to=2026-02-28', { headers: authed(albert) }
  )).json();
  assert.ok(febOnly.payslips.length >= 1);
  assert.ok(febOnly.payslips.every(function (s) { return s.runNo === febRun.runNo; }));

  var janOnly = await (await fetch(
    base + '/api/payroll/payslips?employeeId=' + target.id + '&from=2026-01-01&to=2026-01-31', { headers: authed(albert) }
  )).json();
  assert.ok(janOnly.payslips.every(function (s) { return s.runNo !== febRun.runNo; }));
});
