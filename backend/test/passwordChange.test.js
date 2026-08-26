/*
 * Forced password change: must_change_password is set on new-employee
 * logins (users.service.js's create()) and on admin password resets
 * (setPassword()), but until now was never enforced anywhere — this covers
 * the gate added to middleware/auth.js and the self-service change
 * endpoint at POST /api/me/password.
 *
 * Both tests create their own throwaway employee/account rather than
 * touching a seeded account like alice.kamau — node's test runner runs
 * test files concurrently, and several other files log in as the seeded
 * accounts too. Changing a shared account's password here raced a
 * concurrent login attempt against it in an earlier version of this file,
 * tripping the 5-failed-attempts lockout in auth.service.js and breaking
 * unrelated tests later in the same run.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('node:crypto');
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

// Creates a brand-new employee (no login yet) owned entirely by this test
// file, so nothing else in the suite can race against it.
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

test('forced password change: a new account is blocked from everything else until changed', async function () {
  var admin = (await (await login('kelvin.duho@bplghana.com')).json()).token;
  var emp = await makeThrowawayEmployee(admin, 'pwchange1');

  var roles = await (await fetch(base + '/api/roles', { headers: authed(admin) })).json();
  var employeeRole = roles.find(function (r) { return r.key === 'employee'; });
  assert.ok(employeeRole, 'seed data must include the employee role');

  var createRes = await fetch(base + '/api/users', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ employeeId: emp.id, roleId: employeeRole.id, password: 'TempPass123' })
    // mustChangePassword omitted — create() defaults it to true unless explicitly false
  });
  assert.equal(createRes.status, 200);

  var loginRes = await login(emp.email, 'TempPass123');
  assert.equal(loginRes.status, 200);
  var loginBody = await loginRes.json();
  assert.equal(loginBody.session.mustChangePassword, true);
  var token = loginBody.token;

  // Allowlisted while flagged: GET /me, POST /me/password, POST /auth/logout.
  var me = await fetch(base + '/api/me', { headers: authed(token) });
  assert.equal(me.status, 200);

  // Everything else is blocked with a distinct error code the frontend can branch on.
  var blocked = await fetch(base + '/api/me/summary', { headers: authed(token) });
  assert.equal(blocked.status, 403);
  var blockedBody = await blocked.json();
  assert.equal(blockedBody.error.code, 'password_change_required');

  // Wrong current password is rejected and the flag stays set.
  var wrongCurrent = await fetch(base + '/api/me/password', {
    method: 'POST', headers: jsonAuthed(token),
    body: JSON.stringify({ currentPassword: 'not-it', newPassword: 'BrandNewPass123' })
  });
  assert.equal(wrongCurrent.status, 401);
  var stillBlocked = await fetch(base + '/api/me/summary', { headers: authed(token) });
  assert.equal(stillBlocked.status, 403);

  // Too-short new password is rejected too.
  var tooShort = await fetch(base + '/api/me/password', {
    method: 'POST', headers: jsonAuthed(token),
    body: JSON.stringify({ currentPassword: 'TempPass123', newPassword: 'short' })
  });
  assert.equal(tooShort.status, 400);

  // Correct current password + valid new password clears the flag.
  var changed = await fetch(base + '/api/me/password', {
    method: 'POST', headers: jsonAuthed(token),
    body: JSON.stringify({ currentPassword: 'TempPass123', newPassword: 'BrandNewPass123' })
  });
  assert.equal(changed.status, 200);

  var meAfter = await (await fetch(base + '/api/me', { headers: authed(token) })).json();
  assert.equal(meAfter.mustChangePassword, false);

  var worksNow = await fetch(base + '/api/me/summary', { headers: authed(token) });
  assert.equal(worksNow.status, 200);

  // Old (temporary) password no longer works; the new one does.
  var oldPwLogin = await login(emp.email, 'TempPass123');
  assert.equal(oldPwLogin.status, 401);
  var newPwLogin = await login(emp.email, 'BrandNewPass123');
  assert.equal(newPwLogin.status, 200);
  var newPwBody = await newPwLogin.json();
  assert.equal(newPwBody.session.mustChangePassword, false);
});

test('forced password change: an admin reset re-flags an existing, already-changed account', async function () {
  var admin = (await (await login('kelvin.duho@bplghana.com')).json()).token;
  var emp = await makeThrowawayEmployee(admin, 'pwchange2');

  var roles = await (await fetch(base + '/api/roles', { headers: authed(admin) })).json();
  var employeeRole = roles.find(function (r) { return r.key === 'employee'; });

  await fetch(base + '/api/users', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ employeeId: emp.id, roleId: employeeRole.id, password: 'FirstPass123', mustChangePassword: false })
  });

  var firstLogin = await (await login(emp.email, 'FirstPass123')).json();
  assert.equal(firstLogin.session.mustChangePassword, false);

  var users = await (await fetch(base + '/api/users', { headers: authed(admin) })).json();
  var user = users.find(function (u) { return u.email === emp.email; });

  var reset = await fetch(base + '/api/users/' + user.id + '/password', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ password: 'ResetByAdmin123' })
  });
  assert.equal(reset.status, 200);

  var reLogin = await (await login(emp.email, 'ResetByAdmin123')).json();
  assert.equal(reLogin.session.mustChangePassword, true);

  var blocked = await fetch(base + '/api/me/summary', { headers: authed(reLogin.token) });
  assert.equal(blocked.status, 403);
});
