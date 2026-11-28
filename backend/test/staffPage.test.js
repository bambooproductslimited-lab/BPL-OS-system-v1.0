// The staff page (staffPage.service.js): an employee signs in with the
// phone number on their record and a code texted to it, and sees their own
// attendance, leave and work — nobody else's — and can ask for leave.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var sms = require('../src/services/sms.service');
var staff = require('../src/services/staffPage.service');
var { buildContext } = require('../src/services/context.service');

var server, base, hr, reader, dept, ama, kojo, efua, sent = [], real = { configured: sms.configured, send: sms.send };
var PHONE = '0207770101', SHARED = '0207770202';

async function call(method, path, body, token) {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  var res = await fetch(base + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data: data };
}
async function rejects(p, code) { await assert.rejects(p, function (e) { return e.code === code; }); }
function lastCode() { var m = /\b(\d{6})\b/.exec(sent[sent.length - 1].message); return m[1]; }
async function emp(code, first, phone) {
  return (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, phone, department_id, hire_date, status, employment_type, shift_start, position_title) " +
    "VALUES ($1, $2, 'Zqs', lower($1) || '@example.com', $3, $4, '2020-01-01', 'active', 'permanent', '07:00', 'Zq Machine operator') RETURNING id", [code, first, phone, dept])).rows[0].id;
}
async function cleanUp() {
  await pool.query("DELETE FROM staff_codes WHERE right(phone, 9) IN ('207770101', '207770202', '207770303')");
  await pool.query("DELETE FROM approvals WHERE subject_id IN (SELECT id FROM leave_requests WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQS-%'))");
  await pool.query("DELETE FROM leave_requests WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQS-%')");
  await pool.query("DELETE FROM leave_balances WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQS-%')");
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQS-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQS-%'");
}
function lastMonth() {
  var d = new Date(); var m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return m.toISOString().slice(0, 7);
}

test.before(async function () {
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
  hr = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  reader = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'alice.kamau@bplghana.com'")).rows[0].id);
  dept = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.name = 'Bamboo Products Limited' ORDER BY d.name LIMIT 1")).rows[0].id;
  await cleanUp();
  ama = await emp('ZQS-001', 'Zq Ama', '+233 20 777 0101');
  kojo = await emp('ZQS-002', 'Zq Kojo', SHARED + ' / 0550000000');
  efua = await emp('ZQS-003', 'Zq Efua', SHARED);
  sms.configured = function () { return true; };
  sms.send = async function (o) { sent.push(o); return { id: null, to: o.to }; };
});
test.after(async function () {
  sms.configured = real.configured; sms.send = real.send;
  await cleanUp();
  server.close();
  await pool.end();
});

test('a code goes only to a number on a staff record; the answer is the same either way', async function () {
  var r = await call('POST', '/api/staff/code', { phone: PHONE });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.sent, r.data.minutes], [true, 10]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+233207770101');
  assert.equal(sent[0].purpose, 'staff_code', 'sent even to someone who gets no texts from the OS');
  assert.match(sent[0].message, /staff page code is \d{6}/);
  assert.doesNotMatch(sent[0].logMessage, /\d{6}/, 'the log never keeps the code');

  r = await call('POST', '/api/staff/code', { phone: '020 777 0303' });
  assert.equal(r.status, 200, 'a number nobody has: the same answer');
  assert.equal(sent.length, 1, 'and nothing sent');
  assert.equal((await call('POST', '/api/staff/code', { phone: PHONE })).status, 429, 'not again within the minute');
  assert.equal((await call('POST', '/api/staff/code', { phone: 'abc' })).status, 400);
});

test('signing in: a wrong code counts, the right one works once; the page is theirs alone', async function () {
  var code = lastCode();
  var wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await call('POST', '/api/staff/sign-in', { phone: PHONE, code: wrong })).status, 400);
  var r = await call('POST', '/api/staff/sign-in', { phone: '+233207770101', code: code });
  assert.equal(r.status, 200);
  assert.match(r.data.token, /^[0-9a-f]{64}$/);
  assert.equal(r.data.choose, null);
  assert.equal(r.data.days, 90);
  var token = r.data.token;
  assert.equal((await call('POST', '/api/staff/sign-in', { phone: PHONE, code: code })).status, 400, 'a code works once');

  r = await call('GET', '/api/staff/me', undefined, token);
  assert.equal(r.status, 200);
  assert.equal(r.data.me.name, 'Zq Ama Zqs');
  assert.equal(r.data.me.position, 'Zq Machine operator');
  assert.match(r.data.me.phone, /0101$/);
  assert.ok(r.data.attendance && Array.isArray(r.data.attendance.days));
  assert.ok(r.data.leave.types.length > 0);
  assert.equal(r.data.pay, undefined, 'no pay on the staff page');
  assert.equal((await call('GET', '/api/staff/me')).status, 401);
  assert.equal((await call('GET', '/api/staff/me', undefined, 'f'.repeat(64))).status, 401);
});

test('attendance month by month: the days as HR reads them, with hours and minutes late', async function () {
  var m = lastMonth();
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, status) VALUES ($1, $2, '06:55', '15:55', 'present'), ($1, $3, '08:10', '16:40', 'late')",
    [ama, m + '-03', m + '-04']);
  var token = (await staff.signIn({ phone: PHONE, code: await freshCode(PHONE) })).token;
  var a = await staff.attendance(token, m);
  assert.equal(a.month, m);
  var d3 = a.days.find(function (d) { return d.date === m + '-03'; });
  var d4 = a.days.find(function (d) { return d.date === m + '-04'; });
  assert.deepEqual([d3.status, d3.clockIn, d3.clockOut, d3.hours], ['present', '06:55', '15:55', 9]);
  assert.equal(d4.status, 'late');
  assert.ok(d4.minutesLate > 0, 'how late, against their 07:00 shift');
  assert.ok(a.days.every(function (d) { return ['present', 'late', 'half_day', 'absent', 'off', 'leave', 'holiday'].indexOf(d.status) >= 0; }));
  assert.ok(a.days.some(function (d) { return d.status === 'absent'; }), 'days with no clock-in read as absent');
  assert.equal(a.totals.daysWorked, 2);
  assert.equal(a.totals.late, 1);
  assert.equal(a.totals.hours, 17.5);
  await rejects(staff.attendance(token, '2019-01'), 'invalid');
});

async function freshCode(phone) {
  await pool.query("UPDATE staff_codes SET created_at = created_at - interval '1 hour' WHERE right(phone, 9) = right($1, 9)", [phone.replace(/\D/g, '')]);
  await staff.sendCode({ phone: phone }, '10.0.0.' + Math.floor(Math.random() * 200));
  return lastCode();
}

test('two people on one number pick who they are; a number taken off a record ends its sign-ins', async function () {
  var r = await staff.signIn({ phone: SHARED, code: await freshCode(SHARED) });
  assert.deepEqual(r.choose.map(function (p) { return p.name; }).sort(), ['Zq Efua Zqs', 'Zq Kojo Zqs']);
  assert.deepEqual(Object.keys(await staff.me(r.token)), ['choose']);
  await rejects(staff.attendance(r.token, lastMonth()), 'conflict');
  await rejects(staff.choose(r.token, { employeeId: ama }), 'invalid');
  await staff.choose(r.token, { employeeId: kojo });
  var me = await staff.me(r.token);
  assert.equal(me.me.name, 'Zq Kojo Zqs');
  assert.deepEqual(me.others.map(function (p) { return p.name; }), ['Zq Efua Zqs']);

  await pool.query("UPDATE employees SET phone = '0550000000' WHERE id = $1", [kojo]);
  await rejects(staff.me(r.token), 'auth');
});

test('asking for leave from the staff page, and calling it off', async function () {
  var token = (await staff.signIn({ phone: PHONE, code: await freshCode(PHONE) })).token;
  var unpaid = (await pool.query("SELECT id FROM leave_types WHERE name = 'Unpaid leave'")).rows[0].id;
  var start = new Date(Date.now() + 40 * 86400000), end = new Date(Date.now() + 44 * 86400000);
  var body = { leaveTypeId: unpaid, startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), reason: 'Zqs family visit' };
  var pre = await staff.leavePreview(token, body);
  assert.ok(pre.days > 0);
  var req = await staff.askLeave(token, body);
  assert.equal(req.status, 'pending');
  assert.equal(req.employeeId, ama);
  var appr = (await pool.query("SELECT status, assignee_permission FROM approvals WHERE subject_id = $1", [req.id])).rows[0];
  assert.deepEqual([appr.status, appr.assignee_permission], ['pending', 'leave.approve'], 'it goes for approval as any request does');
  var me = await staff.me(token);
  assert.ok(me.leave.requests.some(function (x) { return x.id === req.id && x.status === 'pending'; }));
  var done = await staff.cancelLeave(token, req.id);
  assert.equal(done.status, 'cancelled');
});

test('HR sees who can sign in and who is signed in, and can sign someone out', async function () {
  await rejects(staff.hrOverview(reader), 'forbidden');
  var o = await staff.hrOverview(hr);
  var ids = o.signedIn.map(function (p) { return p.id; });
  assert.ok(ids.indexOf(ama) >= 0);
  assert.ok(o.counts.active >= 3);
  assert.ok(o.counts.withPhone + o.counts.noPhone === o.counts.active);
  var r = await call('GET', '/api/staff-page');
  assert.equal(r.status, 401, 'HR\'s side needs the OS sign-in');
  var out = await staff.hrSignOut(hr, ama);
  assert.ok(out.signedOut >= 1);
  assert.equal((await staff.hrOverview(hr)).signedIn.some(function (p) { return p.id === ama; }), false);
});
