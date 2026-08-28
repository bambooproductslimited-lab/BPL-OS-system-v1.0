/*
 * Tests for the TimeStation employee sync (timestation.service.js +
 * routes/timestation.routes.js). Real TimeStation API calls are never
 * exercised here — TIMESTATION_API_KEY isn't set in this test environment,
 * so the service refuses before any network call, which is itself the
 * behavior under test for the "not configured" case. The pure name-split
 * and department-code helpers are unit-tested directly against
 * representative TimeStation API JSON shapes.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var timestation = require('../src/services/timestation.service');

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
function jsonAuthed(token) { return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }; }

test('GET /api/timestation/preview is forbidden without employee.write', async function () {
  // Isreal (Production Manager) has employee.read but not employee.write —
  // confirmed via people-governance.test.js's existing role fixtures.
  var isreal = await login('isreal.omozuafo@bplghana.com');
  var res = await fetch(base + '/api/timestation/preview', { headers: jsonAuthed(isreal) });
  assert.equal(res.status, 403);
});

test('GET /api/timestation/preview fails clearly when TIMESTATION_API_KEY is not set', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var res = await fetch(base + '/api/timestation/preview', { headers: jsonAuthed(admin) });
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.match(body.error.message, /TimeStation is not configured/);
});

test('POST /api/timestation/commit is forbidden without employee.write', async function () {
  var isreal = await login('isreal.omozuafo@bplghana.com');
  var res = await fetch(base + '/api/timestation/commit', { method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ rows: [] }) });
  assert.equal(res.status, 403);
});

test('POST /api/timestation/commit rejects an empty row list', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var res = await fetch(base + '/api/timestation/commit', { method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ rows: [] }) });
  assert.equal(res.status, 400);
});

test('splitName splits a TimeStation full name into first/last, keeping middle names with the last', function () {
  assert.deepEqual(timestation.splitName('Alex Mahone'), { firstName: 'Alex', lastName: 'Mahone' });
  assert.deepEqual(timestation.splitName('Mary Ann Boateng'), { firstName: 'Mary', lastName: 'Ann Boateng' });
  assert.deepEqual(timestation.splitName('Cher'), { firstName: 'Cher', lastName: '—' });
  assert.deepEqual(timestation.splitName(''), { firstName: '', lastName: '' });
  assert.deepEqual(timestation.splitName('  Kwame   Asante  '), { firstName: 'Kwame', lastName: 'Asante' });
});

test('deriveDeptCode derives a short unique code within the 5-char CHECK constraint', function () {
  var taken = new Set(['FIN', 'HRA']);
  assert.equal(timestation.deriveDeptCode('Bamboo Garden', taken), 'BG');
  assert.equal(timestation.deriveDeptCode('Factory', taken), 'FACTO');
  assert.equal(timestation.deriveDeptCode('Star Bar Restaurant', taken), 'SBR');
  var takenClash = new Set(['BG']);
  assert.equal(timestation.deriveDeptCode('Bamboo Garden', takenClash), 'BG1');
});
