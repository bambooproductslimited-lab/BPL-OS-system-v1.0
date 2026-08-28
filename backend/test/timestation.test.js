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
var crypto = require('crypto');
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

test('idFragOf matches EmployeesPage.jsx\'s autoFillMissingEmails() derivation exactly, so a placeholder-email employee can be found again later', function () {
  assert.equal(timestation.idFragOf('emp_abc123456'), '123456');
  assert.equal(timestation.idFragOf('emp_XY'), 'empxy');
  assert.equal(timestation.idFragOf(''), '');
  assert.equal(timestation.idFragOf(null), '');
});

test('GET /api/timestation/attendance/preview is forbidden without attendance.adjust', async function () {
  var alice = await login('alice.kamau@bplghana.com');
  var res = await fetch(base + '/api/timestation/attendance/preview?startDate=2026-01-01&endDate=2026-01-07', { headers: jsonAuthed(alice) });
  assert.equal(res.status, 403);
});

test('GET /api/timestation/attendance/preview rejects an end date before the start date', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var res = await fetch(base + '/api/timestation/attendance/preview?startDate=2026-01-10&endDate=2026-01-01', { headers: jsonAuthed(admin) });
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.match(body.error.message, /on or after start date/);
});

test('GET /api/timestation/attendance/preview allows a wide date range (a full-history pull costs the same one API call per employee as a narrow one)', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var res = await fetch(base + '/api/timestation/attendance/preview?startDate=2010-01-01&endDate=2026-01-07', { headers: jsonAuthed(admin) });
  // Still hits "not configured" (no TIMESTATION_API_KEY in this test env) —
  // the point is it gets there at all, past date-range validation.
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.match(body.error.message, /TimeStation is not configured/);
});

test('GET /api/timestation/attendance/preview rejects a genuinely absurd date range (a mistyped year)', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var res = await fetch(base + '/api/timestation/attendance/preview?startDate=1926-01-01&endDate=2026-01-07', { headers: jsonAuthed(admin) });
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.match(body.error.message, /looks like a mistake/);
});

test('GET /api/timestation/attendance/preview fails clearly when TIMESTATION_API_KEY is not set', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var res = await fetch(base + '/api/timestation/attendance/preview?startDate=2026-01-01&endDate=2026-01-07', { headers: jsonAuthed(admin) });
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.match(body.error.message, /TimeStation is not configured/);
});

test('POST /api/timestation/attendance/commit is forbidden without attendance.adjust', async function () {
  var alice = await login('alice.kamau@bplghana.com');
  var res = await fetch(base + '/api/timestation/attendance/commit', { method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ rows: [] }) });
  assert.equal(res.status, 403);
});

test('POST /api/timestation/attendance/commit rejects an empty row list', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var res = await fetch(base + '/api/timestation/attendance/commit', { method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ rows: [] }) });
  assert.equal(res.status, 400);
});

// commitAttendance() never calls TimeStation itself — it only writes
// whatever rows it's handed (that's previewAttendance()'s job, which does
// need the real API) — so the write/overwrite/upsert logic is fully
// testable here without a live TimeStation connection.
async function makeThrowawayEmployee(adminToken, label) {
  var depts = await (await fetch(base + '/api/departments', { headers: jsonAuthed(adminToken) })).json();
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

test('POST /api/timestation/attendance/commit creates, updates, and overwrites correctly', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var emp = await makeThrowawayEmployee(admin, 'attsync');

  // 'create' on a date with no existing attendance record.
  var commit1 = await (await fetch(base + '/api/timestation/attendance/commit', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ rows: [{ employeeId: emp.id, employeeName: 'Test', date: '2026-02-01', clockIn: '09:00', clockOut: '17:00', status: 'present', action: 'create' }] })
  })).json();
  assert.equal(commit1.created, 1);

  var list1 = await (await fetch(base + '/api/attendance?date=2026-02-01', { headers: jsonAuthed(admin) })).json();
  var row1 = list1.rows.find(function (r) { return r.employeeId === emp.id; });
  assert.equal(row1.clockIn.slice(0, 5), '09:00');
  assert.equal(row1.status, 'present');

  // 'update' — re-syncing a corrected shift for the same date overwrites it.
  var commit2 = await (await fetch(base + '/api/timestation/attendance/commit', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ rows: [{ employeeId: emp.id, employeeName: 'Test', date: '2026-02-01', clockIn: '09:45', clockOut: '17:00', status: 'late', action: 'update' }] })
  })).json();
  assert.equal(commit2.updated, 1);
  var list2 = await (await fetch(base + '/api/attendance?date=2026-02-01', { headers: jsonAuthed(admin) })).json();
  var row2 = list2.rows.find(function (r) { return r.employeeId === emp.id; });
  assert.equal(row2.clockIn.slice(0, 5), '09:45');
  assert.equal(row2.status, 'late');

  // 'overwrite' — a manual attendance.adjust correction on a different date
  // gets replaced once TimeStation reports a shift for that same day, per
  // the "TimeStation wins for anyone it covers" policy.
  await fetch(base + '/api/attendance/adjust', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ employeeId: emp.id, date: '2026-02-02', status: 'present', note: 'Manual note before sync' })
  });
  var commit3 = await (await fetch(base + '/api/timestation/attendance/commit', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ rows: [{ employeeId: emp.id, employeeName: 'Test', date: '2026-02-02', clockIn: '08:10', clockOut: '16:00', status: 'present', action: 'overwrite' }] })
  })).json();
  assert.equal(commit3.updated, 1);
  var list3 = await (await fetch(base + '/api/attendance?date=2026-02-02', { headers: jsonAuthed(admin) })).json();
  var row3 = list3.rows.find(function (r) { return r.employeeId === emp.id; });
  assert.equal(row3.clockIn.slice(0, 5), '08:10', 'the TimeStation shift should have replaced the manual adjustment');

  // 'skip' and 'unchanged' rows are counted but never written.
  var commit4 = await (await fetch(base + '/api/timestation/attendance/commit', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ rows: [{ employeeId: emp.id, employeeName: 'Test', date: null, action: 'skip', warnings: ['no check-in'] }] })
  })).json();
  assert.equal(commit4.unchanged, 1);
  assert.equal(commit4.created, 0);
});

test('POST /api/timestation/attendance/commit handles a large multi-row batch via the bulk upsert path, and salvages good rows when one is bad', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var emp = await makeThrowawayEmployee(admin, 'attbulk');

  // 300 distinct dates for one employee in a single request — exercises
  // the real bulk-insert path (not the tiny single-row cases above),
  // which is what a large TimeStation history sync actually sends.
  var rows = [];
  for (var i = 0; i < 300; i++) {
    var d = new Date('2020-01-01T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    rows.push({ employeeId: emp.id, employeeName: 'Test', date: d.toISOString().slice(0, 10), clockIn: '07:05', clockOut: '16:00', status: 'present', action: 'create' });
  }
  var bulkResult = await (await fetch(base + '/api/timestation/attendance/commit', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ rows: rows })
  })).json();
  assert.equal(bulkResult.created, 300);
  assert.equal(bulkResult.failed.length, 0);

  var checkRes = await (await fetch(base + '/api/attendance?date=2020-06-15', { headers: jsonAuthed(admin) })).json();
  var checkRow = checkRes.rows.find(function (r) { return r.employeeId === emp.id; });
  assert.equal(checkRow.clockIn.slice(0, 5), '07:05');

  // Re-running the same 300 rows should now report them all as updates,
  // not creates (they already exist) — proves the INSERT..RETURNING
  // (xmax = 0) create/update detection works across a real bulk batch,
  // not just the single-row cases.
  var rerunResult = await (await fetch(base + '/api/timestation/attendance/commit', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ rows: rows })
  })).json();
  assert.equal(rerunResult.created, 0);
  assert.equal(rerunResult.updated, 300);

  // One row with an employee_id that doesn't exist (violates the FK) mixed
  // into an otherwise-valid batch should sink the fast bulk INSERT, but
  // the row-by-row fallback should still salvage the good ones.
  var mixedRows = [
    { employeeId: emp.id, employeeName: 'Test', date: '2021-01-01', clockIn: '07:00', clockOut: '16:00', status: 'present', action: 'create' },
    { employeeId: '00000000-0000-0000-0000-000000000000', employeeName: 'Ghost', date: '2021-01-01', clockIn: '07:00', clockOut: '16:00', status: 'present', action: 'create' },
    { employeeId: emp.id, employeeName: 'Test', date: '2021-01-02', clockIn: '07:00', clockOut: '16:00', status: 'present', action: 'create' }
  ];
  var mixedResult = await (await fetch(base + '/api/timestation/attendance/commit', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ rows: mixedRows })
  })).json();
  assert.equal(mixedResult.created, 2, 'the two valid rows should still be written despite the bad one');
  assert.equal(mixedResult.failed.length, 1);
  assert.equal(mixedResult.failed[0].name, 'Ghost');
});
