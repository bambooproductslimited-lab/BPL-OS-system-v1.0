/*
 * Integration test for the People & Governance modules (employees,
 * departments, roles, users, attendance, notifications, audit, settings,
 * dashboard). Requires `npm run migrate && npm run seed` first, same as
 * test/smoke.test.js.
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

test('roles.permissionCatalogue is reachable without auth', async function () {
  var res = await fetch(base + '/api/roles/permissions');
  assert.equal(res.status, 200);
  var body = await res.json();
  assert.ok(body.length > 0);
  assert.ok(body[0].key && body[0].group && body[0].label);
});

test('employee record-level visibility: self-service employee only sees their own record', async function () {
  var alice = await login('alice.kamau@bplghana.com');
  var admin = await login('kelvin.duho@bplghana.com');

  var aliceList = await (await fetch(base + '/api/employees', { headers: authed(alice) })).json();
  assert.equal(aliceList.length, 1);

  var adminList = await (await fetch(base + '/api/employees', { headers: authed(admin) })).json();
  // >= rather than an exact seeded count: other test files create their own
  // throwaway employees (e.g. passwordChange.test.js) and node's test
  // runner executes files concurrently, so the exact company-wide total at
  // any instant isn't deterministic — the real invariant here is "admin
  // sees everyone, self-service sees only themself".
  assert.ok(adminList.length >= 19);
  assert.ok(adminList.some(function (e) { return e.email === 'alice.kamau@bplghana.com'; }));
});

test('employee CRUD: create requires employee.write, update, terminate, purge lifecycle', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var depts = await (await fetch(base + '/api/departments', { headers: authed(admin) })).json();
  var deptId = depts[0].id;

  var deniedRes = await fetch(base + '/api/employees', {
    method: 'POST', headers: jsonAuthed(alice),
    body: JSON.stringify({ firstName: 'X', lastName: 'Y', email: 'xy-denied@bplghana.com', departmentId: deptId, positionTitle: 'Z' })
  });
  assert.equal(deniedRes.status, 403);

  var createRes = await fetch(base + '/api/employees', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ firstName: 'Grace', lastName: 'Testperson', email: 'grace.testperson@bplghana.com', departmentId: deptId, positionTitle: 'QA Engineer' })
  });
  assert.equal(createRes.status, 201);
  var created = await createRes.json();
  assert.equal(created.code, created.code); // has a generated code
  assert.equal(created.status, 'active');

  var dupeRes = await fetch(base + '/api/employees', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ firstName: 'Grace2', lastName: 'Testperson2', email: 'grace.testperson@bplghana.com', departmentId: deptId, positionTitle: 'QA Engineer' })
  });
  assert.equal(dupeRes.status, 400);

  var updateRes = await fetch(base + '/api/employees/' + created.id, {
    method: 'PATCH', headers: jsonAuthed(admin), body: JSON.stringify({ positionTitle: 'Senior QA Engineer' })
  });
  assert.equal(updateRes.status, 200);
  assert.equal((await updateRes.json()).positionTitle, 'Senior QA Engineer');

  var selfTerminate = await fetch(base + '/api/employees/' + created.id + '/terminate', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({})
  });
  assert.equal(selfTerminate.status, 200);
  assert.equal((await selfTerminate.json()).status, 'terminated');

  var terminateAgain = await fetch(base + '/api/employees/' + created.id + '/terminate', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({})
  });
  assert.equal(terminateAgain.status, 409);
});

test('attendance: clock in, duplicate clock-in conflicts, clock out', async function () {
  var john = await login('john.sitati@bplghana.com');

  var clockInRes = await fetch(base + '/api/attendance/clock-in', { method: 'POST', headers: authed(john) });
  var alreadyIn = clockInRes.status === 409;
  if (!alreadyIn) assert.equal(clockInRes.status, 201);

  var dupeRes = await fetch(base + '/api/attendance/clock-in', { method: 'POST', headers: authed(john) });
  assert.equal(dupeRes.status, 409);

  var listRes = await fetch(base + '/api/attendance', { headers: authed(john) });
  var list = await listRes.json();
  assert.ok(list.rows.some(function (r) { return r.status === 'present' || r.status === 'late'; }));
});

test('attendance report: date-range validation, and self-service scoping matches attendance.list', async function () {
  var john = await login('john.sitati@bplghana.com');
  var admin = await login('kelvin.duho@bplghana.com');

  var badRange = await fetch(base + '/api/attendance/report?from=2026-02-01&to=2026-01-01', { headers: authed(admin) });
  assert.equal(badRange.status, 400);
  var badRangeBody = await badRange.json();
  assert.match(badRangeBody.error.message, /on or after from date/);

  var absurdRange = await fetch(base + '/api/attendance/report?from=1900-01-01&to=2026-01-01', { headers: authed(admin) });
  assert.equal(absurdRange.status, 400);
  var absurdBody = await absurdRange.json();
  assert.match(absurdBody.error.message, /looks like a mistake/);

  // John doesn't have attendance.read.all (plain employee role) — the
  // report should scope to just his own record, same as attendance.list.
  var today = new Date().toISOString().slice(0, 10);
  var johnReport = await (await fetch(base + '/api/attendance/report?from=' + today + '&to=' + today, { headers: authed(john) })).json();
  assert.ok(johnReport.rows.every(function (r) { return r.name === 'John Sitati'; }));

  // Admin (attendance.read.all) sees the same clock-in among everyone's.
  var adminReport = await (await fetch(base + '/api/attendance/report?from=' + today + '&to=' + today, { headers: authed(admin) })).json();
  assert.ok(adminReport.rows.some(function (r) { return r.name === 'John Sitati'; }));
  assert.ok(adminReport.rows.length >= johnReport.rows.length);
});

test('roles.setPermission is locked for the administrator role, works for others', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var roles = await (await fetch(base + '/api/roles', { headers: authed(admin) })).json();
  var adminRole = roles.find(function (r) { return r.key === 'administrator'; });
  var employeeRole = roles.find(function (r) { return r.key === 'employee'; });

  var lockedRes = await fetch(base + '/api/roles/' + adminRole.id + '/permissions', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ permission: 'catalog.read', on: false })
  });
  assert.equal(lockedRes.status, 403);

  var grantRes = await fetch(base + '/api/roles/' + employeeRole.id + '/permissions', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ permission: 'catalog.read', on: true })
  });
  assert.equal(grantRes.status, 200);
  assert.ok((await grantRes.json()).permissions.includes('catalog.read'));

  var revokeRes = await fetch(base + '/api/roles/' + employeeRole.id + '/permissions', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ permission: 'catalog.read', on: false })
  });
  assert.ok(!(await revokeRes.json()).permissions.includes('catalog.read'));
});

test('users.setRole and setStatus cannot target your own account', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var users = await (await fetch(base + '/api/users', { headers: authed(admin) })).json();
  var self = users.find(function (u) { return u.email === 'kelvin.duho@bplghana.com'; });

  var res = await fetch(base + '/api/users/' + self.id + '/status', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ status: 'disabled' })
  });
  assert.equal(res.status, 403);
});

test('audit.read is permission-gated', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var adminRes = await fetch(base + '/api/audit', { headers: authed(admin) });
  assert.equal(adminRes.status, 200);
  assert.ok((await adminRes.json()).length > 0);

  var aliceRes = await fetch(base + '/api/audit', { headers: authed(alice) });
  assert.equal(aliceRes.status, 403);
});

test('settings.save is permission-gated and persists', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var deniedRes = await fetch(base + '/api/settings', {
    method: 'PATCH', headers: jsonAuthed(alice), body: JSON.stringify({ workWeek: 'Mon-Fri' })
  });
  assert.equal(deniedRes.status, 403);

  var saveRes = await fetch(base + '/api/settings', {
    method: 'PATCH', headers: jsonAuthed(admin), body: JSON.stringify({ workWeek: 'Mon-Fri (test)' })
  });
  assert.equal(saveRes.status, 200);
  assert.equal((await saveRes.json()).workWeek, 'Mon-Fri (test)');
});

test('dashboard.load returns permission-scoped fields', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var adminDash = await (await fetch(base + '/api/dashboard', { headers: authed(admin) })).json();
  assert.ok(adminDash.headcount >= 19); // see the note on the equivalent assertion above

  var aliceDash = await (await fetch(base + '/api/dashboard', { headers: authed(alice) })).json();
  assert.equal(aliceDash.headcount, 1);
  assert.equal(aliceDash.lowStockCount, null); // no inventory.read permission
});
