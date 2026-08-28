/*
 * Integration test for the clock-in/out kiosk (kiosk.service.js +
 * routes/kiosk.routes.js's public /api/kiosk/clock, plus the admin
 * PIN-management routes on employees.routes.js). Requires
 * `npm run migrate && npm run seed` first, same as the other test files.
 *
 * Uses two employees not touched by other test files' attendance tests
 * (people-governance.test.js clocks in john.sitati@bplghana.com) so this
 * file's clock-in/out assertions don't collide with theirs on the shared
 * UNIQUE(employee_id, date) constraint.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');

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

var EXCLUDED_EMAILS = ['john.sitati@bplghana.com', 'kelvin.duho@bplghana.com'];

async function pickTwoEmployees(admin) {
  var list = await (await fetch(base + '/api/employees', { headers: authed(admin) })).json();
  var candidates = list.filter(function (e) { return e.status === 'active' && EXCLUDED_EMAILS.indexOf(e.email) < 0; });
  return [candidates[0], candidates[1]];
}

test('kiosk PIN management: employee.write gated, rejects a bad format, rejects a duplicate PIN', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com'); // plain employee — no employee.write
  var [empA, empB] = await pickTwoEmployees(admin);

  var denied = await fetch(base + '/api/employees/' + empA.id + '/kiosk-pin', {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ pin: '1234' })
  });
  assert.equal(denied.status, 403);

  var badFormat = await fetch(base + '/api/employees/' + empA.id + '/kiosk-pin', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ pin: '12' })
  });
  assert.equal(badFormat.status, 400);

  var setA = await fetch(base + '/api/employees/' + empA.id + '/kiosk-pin', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ pin: '4471' })
  });
  assert.equal(setA.status, 200);

  var dupe = await fetch(base + '/api/employees/' + empB.id + '/kiosk-pin', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ pin: '4471' })
  });
  assert.equal(dupe.status, 409);
});

test('kiosk clock: wrong PIN fails cleanly, correct PIN clocks in then out, a third tap the same day is rejected', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var [empA] = await pickTwoEmployees(admin);

  await fetch(base + '/api/employees/' + empA.id + '/kiosk-pin', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ pin: '9102' })
  });

  var wrong = await fetch(base + '/api/kiosk/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0000' })
  });
  assert.equal(wrong.status, 400);

  var clockIn = await fetch(base + '/api/kiosk/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '9102' })
  });
  assert.equal(clockIn.status, 200);
  var inBody = await clockIn.json();
  assert.equal(inBody.action, 'in');
  assert.equal(inBody.employeeName, empA.firstName + ' ' + empA.lastName);

  var clockOut = await fetch(base + '/api/kiosk/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '9102' })
  });
  assert.equal(clockOut.status, 200);
  var outBody = await clockOut.json();
  assert.equal(outBody.action, 'out');

  var third = await fetch(base + '/api/kiosk/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '9102' })
  });
  assert.equal(third.status, 409);
});

test('kiosk PIN: clearing it makes the PIN stop working', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var [, empB] = await pickTwoEmployees(admin);

  await fetch(base + '/api/employees/' + empB.id + '/kiosk-pin', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ pin: '5588' })
  });
  var cleared = await fetch(base + '/api/employees/' + empB.id + '/kiosk-pin', { method: 'DELETE', headers: authed(admin) });
  assert.equal(cleared.status, 200);

  var attempt = await fetch(base + '/api/kiosk/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '5588' })
  });
  assert.equal(attempt.status, 400);
});

test('kiosk PIN: viewing is employee.write gated, reflects unset/set state, and reveals what was actually set', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');
  var [empA] = await pickTwoEmployees(admin);

  var denied = await fetch(base + '/api/employees/' + empA.id + '/kiosk-pin', { headers: authed(alice) });
  assert.equal(denied.status, 403);

  await fetch(base + '/api/employees/' + empA.id + '/kiosk-pin', { method: 'DELETE', headers: authed(admin) });
  var unset = await (await fetch(base + '/api/employees/' + empA.id + '/kiosk-pin', { headers: authed(admin) })).json();
  assert.deepEqual(unset, { hasPin: false, pin: null });

  await fetch(base + '/api/employees/' + empA.id + '/kiosk-pin', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ pin: '7261' })
  });
  var revealed = await (await fetch(base + '/api/employees/' + empA.id + '/kiosk-pin', { headers: authed(admin) })).json();
  assert.deepEqual(revealed, { hasPin: true, pin: '7261' });

  // A PIN set before this feature existed only ever has the hash — the
  // encrypted column stays null forever for that row until HR resets it.
  await pool.query('UPDATE employees SET kiosk_pin_encrypted = NULL WHERE id = $1', [empA.id]);
  var legacy = await (await fetch(base + '/api/employees/' + empA.id + '/kiosk-pin', { headers: authed(admin) })).json();
  assert.deepEqual(legacy, { hasPin: true, pin: null });

  await fetch(base + '/api/employees/' + empA.id + '/kiosk-pin', { method: 'DELETE', headers: authed(admin) });
});

test('kiosk clock offline sync: occurredAt backdates the attendance record instead of using the sync moment, and is bounded', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var list = await (await fetch(base + '/api/employees', { headers: authed(admin) })).json();
  var candidates = list.filter(function (e) { return e.status === 'active' && EXCLUDED_EMAILS.indexOf(e.email) < 0; });
  var empC = candidates[2];

  await fetch(base + '/api/employees/' + empC.id + '/kiosk-pin', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ pin: '3344' })
  });

  var threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  var expectedHm = threeHoursAgo.toTimeString().slice(0, 5);

  var offlineClockIn = await fetch(base + '/api/kiosk/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '3344', occurredAt: threeHoursAgo.toISOString() })
  });
  assert.equal(offlineClockIn.status, 200);
  var body = await offlineClockIn.json();
  assert.equal(body.action, 'in');
  assert.equal(body.time, expectedHm, 'the recorded clock-in time should be the original tap time, not the sync moment');

  var future = await fetch(base + '/api/kiosk/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '3344', occurredAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
  });
  assert.equal(future.status, 400);

  var tooOld = await fetch(base + '/api/kiosk/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '3344', occurredAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString() })
  });
  assert.equal(tooOld.status, 400);
});

// Runs last in this file — deliberately trips the per-IP lockout, which
// would otherwise block every kiosk test declared after it.
test('kiosk clock: repeated wrong PINs from the same caller are rate-limited', async function () {
  for (var i = 0; i < 5; i++) {
    await fetch(base + '/api/kiosk/clock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1111' })
    });
  }
  var res = await fetch(base + '/api/kiosk/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1111' })
  });
  assert.equal(res.status, 429);
});
