/*
 * End-to-end smoke test for auth + the leave resource, run against a real
 * Postgres database. Requires `npm run migrate && npm run seed` first (a
 * fresh seed, since this test relies on the seeded demo accounts and the
 * seeded pending leave request for alice.kamau).
 *
 * Run with: npm test
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');

var server;
var base;

test.before(function (t, done) {
  server = app.listen(0, function () {
    base = 'http://127.0.0.1:' + server.address().port;
    done();
  });
});

test.after(function () { server.close(); });

async function login(email, password) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password })
  });
  var body = await res.json();
  return { status: res.status, body: body };
}

function authed(token) {
  return { Authorization: 'Bearer ' + token };
}

test('health check', async function () {
  var res = await fetch(base + '/api/health');
  assert.equal(res.status, 200);
});

test('login with wrong password fails with 401 auth error', async function () {
  var res = await login('alice.kamau@bplghana.com', 'not-the-password');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'auth');
});

test('login with correct password returns a token and session', async function () {
  var res = await login('alice.kamau@bplghana.com', 'bamboo123');
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.session.email, 'alice.kamau@bplghana.com');
  assert.ok(res.body.session.permissions.includes('leave.request'));
  assert.ok(!res.body.session.permissions.includes('leave.approve'));
});

test('protected routes reject requests with no token', async function () {
  var res = await fetch(base + '/api/leave/types');
  assert.equal(res.status, 401);
});

test('leave request lifecycle: request -> visible to manager -> approve -> balance updates', async function () {
  var alice = (await login('alice.kamau@bplghana.com', 'bamboo123')).body;
  var isreal = (await login('isreal.omozuafo@bplghana.com', 'bamboo123')).body;
  var john = (await login('john.sitati@bplghana.com', 'bamboo123')).body;

  var types = await (await fetch(base + '/api/leave/types', { headers: authed(alice.token) })).json();
  var sick = types.find(function (t) { return t.name === 'Sick leave'; });
  assert.ok(sick);

  var createRes = await fetch(base + '/api/leave', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(alice.token)),
    body: JSON.stringify({ leaveTypeId: sick.id, startDate: '2027-02-01', endDate: '2027-02-02', reason: 'Smoke test' })
  });
  assert.equal(createRes.status, 201);
  var created = await createRes.json();
  assert.equal(created.status, 'pending');
  assert.equal(created.days, 2);

  // Someone outside the approval chain (no leave.approve permission) is denied.
  var johnDenied = await fetch(base + '/api/leave/' + created.id + '/decision', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(john.token)),
    body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(johnDenied.status, 403);

  // Alice cannot approve her own request even if she had the permission.
  var selfDenied = await fetch(base + '/api/leave/' + created.id + '/decision', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(alice.token)),
    body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(selfDenied.status, 403);

  // Alice's manager (department_manager, leave.approve) can approve it.
  var approveRes = await fetch(base + '/api/leave/' + created.id + '/decision', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(isreal.token)),
    body: JSON.stringify({ decision: 'approved', note: 'ok' })
  });
  assert.equal(approveRes.status, 200);
  var approved = await approveRes.json();
  assert.equal(approved.status, 'approved');

  // Deciding an already-decided request conflicts.
  var again = await fetch(base + '/api/leave/' + created.id + '/decision', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(isreal.token)),
    body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(again.status, 409);

  var summary = await (await fetch(base + '/api/me/summary', { headers: authed(alice.token) })).json();
  var sickBalance = summary.balances.find(function (b) { return b.name === 'Sick leave'; });
  assert.equal(sickBalance.used, 2);
});

test('leave.cancel: only the requester can cancel, only while pending', async function () {
  var alice = (await login('alice.kamau@bplghana.com', 'bamboo123')).body;
  var john = (await login('john.sitati@bplghana.com', 'bamboo123')).body;

  var types = await (await fetch(base + '/api/leave/types', { headers: authed(alice.token) })).json();
  var annual = types.find(function (t) { return t.name === 'Annual staff leave'; });

  var createRes = await fetch(base + '/api/leave', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(alice.token)),
    body: JSON.stringify({ leaveTypeId: annual.id, startDate: '2027-03-01', endDate: '2027-03-01', reason: 'Smoke test cancel' })
  });
  var created = await createRes.json();

  var johnCancel = await fetch(base + '/api/leave/' + created.id + '/cancel', { method: 'POST', headers: authed(john.token) });
  assert.equal(johnCancel.status, 403);

  var cancelRes = await fetch(base + '/api/leave/' + created.id + '/cancel', { method: 'POST', headers: authed(alice.token) });
  assert.equal(cancelRes.status, 200);
  assert.equal((await cancelRes.json()).status, 'cancelled');

  var cancelAgain = await fetch(base + '/api/leave/' + created.id + '/cancel', { method: 'POST', headers: authed(alice.token) });
  assert.equal(cancelAgain.status, 409);
});

test('leave.request validation: bad date format and end-before-start are rejected', async function () {
  var alice = (await login('alice.kamau@bplghana.com', 'bamboo123')).body;
  var types = await (await fetch(base + '/api/leave/types', { headers: authed(alice.token) })).json();
  var annual = types.find(function (t) { return t.name === 'Annual staff leave'; });

  var badDate = await fetch(base + '/api/leave', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(alice.token)),
    body: JSON.stringify({ leaveTypeId: annual.id, startDate: '03/01/2027', endDate: '2027-03-02', reason: 'x' })
  });
  assert.equal(badDate.status, 400);

  var endBeforeStart = await fetch(base + '/api/leave', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(alice.token)),
    body: JSON.stringify({ leaveTypeId: annual.id, startDate: '2027-04-05', endDate: '2027-04-01', reason: 'x' })
  });
  assert.equal(endBeforeStart.status, 400);
});

test('leave.list scoping: an employee with no read-all permission only sees their own requests', async function () {
  var john = (await login('john.sitati@bplghana.com', 'bamboo123')).body;
  var list = await (await fetch(base + '/api/leave', { headers: authed(john.token) })).json();
  assert.ok(list.every(function (r) { return r.employeeId === john.session.employee.id; }));
});

test('administrator sees every leave request', async function () {
  var admin = (await login('kelvin.duho@bplghana.com', 'bamboo123')).body;
  var all = await (await fetch(base + '/api/leave', { headers: authed(admin.token) })).json();
  assert.ok(all.length >= 4);
});
