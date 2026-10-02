/*
 * Attendance feeds (attendanceFeeds.service.js): one company's attendance
 * sent to an outside system, signed, as it changes — and read by it with a
 * read-only key. Uses two test departments (ZAF, in Star Bar Restaurant and
 * in Bamboo Products Limited) with one employee each, dates in May 2030,
 * and a local web server standing in for their site.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');
var crypto = require('crypto');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var feeds = require('../src/services/attendanceFeeds.service');

var server, base, site, siteUrl, admin, alice;
var got = [];          // what "their site" received
var answer = 200;      // what it answers
var reply = { type: 'application/json', body: '{"received":true}' };
var sbr, bpl, depSbr, depBpl, empSbr, empBpl, feed;

async function cleanup() {
  await pool.query("DELETE FROM attendance_feeds WHERE name LIKE 'ZAF%'");
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZAF-%')");
  await pool.query("DELETE FROM attendance_changes WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZAF-%')");
  await pool.query("DELETE FROM leave_requests WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZAF-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZAF-%'");
  await pool.query("DELETE FROM departments WHERE code LIKE 'ZAF-%'");
}

test.before(async function () {
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
  await new Promise(function (r) {
    site = http.createServer(function (req, res) {
      var chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () { got.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }); res.statusCode = answer; res.setHeader('Content-Type', reply.type); res.end(reply.body); });
    }).listen(0, function () { siteUrl = 'http://127.0.0.1:' + site.address().port + '/bamboo-attendance'; r(); });
  });
  feeds.setAllowLocalForTests(true);
  feeds.setSettleMsForTests(0);
  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  alice = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'alice.kamau@bplghana.com'")).rows[0].id);
  sbr = (await pool.query("SELECT id FROM companies WHERE code = 'SBR'")).rows[0].id;
  bpl = (await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0].id;
  depSbr = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZAF-SBR', 'ZAF Bar floor', $1) RETURNING id", [sbr])).rows[0].id;
  depBpl = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZAF-BPL', 'ZAF Factory', $1) RETURNING id", [bpl])).rows[0].id;
  empSbr = (await pool.query("INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, hire_date) VALUES ('ZAF-1', 'Zq', 'Barkeep', 'zaf1@example.com', $1, 'Bartender', '2025-01-01') RETURNING id", [depSbr])).rows[0].id;
  empBpl = (await pool.query("INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date) VALUES ('ZAF-2', 'Zq', 'Factory', 'zaf2@example.com', $1, '2025-01-01') RETURNING id", [depBpl])).rows[0].id;
});
test.after(async function () {
  await cleanup();
  feeds.setAllowLocalForTests(false);
  server.close(); site.close();
  await pool.end();
});

function eventsOf(req) { return JSON.parse(req.body).events; }
function verify(req, secret) {
  var m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers['x-bamboo-signature']);
  if (!m) return false;
  var want = crypto.createHmac('sha256', secret).update(m[1] + '.' + req.body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]));
}
async function pull(path, key) {
  var r = await fetch(base + '/api/feeds/attendance' + path, { headers: key ? { Authorization: 'Bearer ' + key } : {} });
  return { status: r.status, body: await r.json() };
}

test('only settings.manage sets one up; the secret and key are shown once, only hashes and sealed values kept', async function () {
  await assert.rejects(feeds.list(alice), /settings\.manage/);
  await assert.rejects(feeds.create(admin, { name: 'ZAF x', companyId: sbr, departmentIds: [depBpl], pushUrl: siteUrl }), /not all in Star Bar/);
  await assert.rejects(feeds.create(admin, { name: 'ZAF x', companyId: sbr, readKey: false }), /address/);
  feed = await feeds.create(admin, { name: 'ZAF Star Bar tracker', companyId: sbr, departmentIds: [depSbr], pushUrl: siteUrl });
  assert.match(feed.signingSecret, /^bfs_/);
  assert.match(feed.readKeyValue, /^bfk_/);
  var row = (await pool.query('SELECT * FROM attendance_feeds WHERE id = $1', [feed.id])).rows[0];
  assert.ok(!row.signing_secret.includes(feed.signingSecret), 'secret kept sealed');
  assert.equal(row.read_key_hash, crypto.createHash('sha256').update(feed.readKeyValue).digest('hex'));
  var listed = (await feeds.list(admin)).feeds.find(function (f) { return f.id === feed.id; });
  assert.equal(listed.signingSecret, undefined);
  assert.equal(listed.readKeyValue, undefined);
  assert.equal(listed.staff, 1);
});

test('a clock-in and its clock-out arrive as one signed event; other companies\' staff never do', async function () {
  got = [];
  var a = (await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status, source) VALUES ($1, '2030-05-06', '08:01', 'late', 'kiosk') RETURNING id", [empSbr])).rows[0].id;
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status, source) VALUES ($1, '2030-05-06', '07:55', 'present', 'kiosk')", [empBpl]);
  await pool.query("UPDATE attendance SET clock_out = '17:05', clock_out_date = '2030-05-06' WHERE id = $1", [a]);
  await feeds.deliverDue();
  assert.equal(got.length, 1);
  assert.ok(verify(got[0], feed.signingSecret), 'signed with the feed secret');
  assert.equal(got[0].headers['x-bamboo-feed'], feed.id);
  var ev = eventsOf(got[0]);
  assert.equal(ev.length, 1, 'the two changes to one row become one event');
  assert.equal(ev[0].type, 'attendance.recorded');
  var r = ev[0].attendance;
  assert.deepEqual([r.date, r.clockIn, r.clockOut, r.clockInAt, r.hoursWorked, r.status, r.shift, r.employee.code, r.employee.position],
    ['2030-05-06', '08:01', '17:05', '2030-05-06T08:01:00Z', 9.07, 'late', 1, 'ZAF-1', 'Bartender']);
  assert.equal(r.clockInLocation, undefined, 'no GPS');
  got = [];
  await feeds.deliverDue();
  assert.equal(got.length, 0, 'nothing sent twice');
  // A bookkeeping-only update is not a change.
  await pool.query('UPDATE attendance SET auto_clock_out_seen_at = now() WHERE id = $1', [a]);
  assert.equal((await pool.query('SELECT count(*) FROM attendance_changes WHERE attendance_id = $1', [a])).rows[0].count, '2');
});

test('their site down: tried again later, nothing skipped; a removal is sent too', async function () {
  got = []; answer = 500;
  var b = (await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status, source) VALUES ($1, '2030-05-07', '09:00', 'present', 'timestation') RETURNING id", [empSbr])).rows[0].id;
  var r1 = await feeds.deliverDue();
  assert.equal(r1.find(function (x) { return x.feedId === feed.id; }).failed, true);
  var row = (await pool.query('SELECT failures, next_attempt_at, failing_since, last_error FROM attendance_feeds WHERE id = $1', [feed.id])).rows[0];
  assert.equal(row.failures, 1);
  assert.ok(row.next_attempt_at && row.failing_since);
  assert.match(row.last_error, /500/);
  got = [];
  await feeds.deliverDue();
  assert.equal(got.length, 0, 'waits before trying again');
  answer = 200;
  await pool.query('UPDATE attendance_feeds SET next_attempt_at = now() WHERE id = $1', [feed.id]);
  await feeds.deliverDue();
  assert.equal(got.length, 1);
  assert.equal(eventsOf(got[0])[0].attendance.id, b);
  assert.equal((await pool.query('SELECT failures FROM attendance_feeds WHERE id = $1', [feed.id])).rows[0].failures, 0);

  got = [];
  await pool.query('DELETE FROM attendance WHERE id = $1', [b]);
  await feeds.deliverDue();
  var ev = eventsOf(got[0])[0];
  assert.deepEqual([ev.type, ev.attendance.id, ev.attendance.date, ev.attendance.employee.code], ['attendance.removed', b, '2030-05-07', 'ZAF-1']);
  assert.equal(feeds.backoffSeconds(1), 30);
  assert.equal(feeds.backoffSeconds(20), 3600);
});

test('the log keeps the start of their answer, flags a web page, and counts what was sent again', async function () {
  reply = { type: 'text/html; charset=utf-8', body: '<!DOCTYPE html>\n<html><head><title>Public Figah</title></head><body>' + 'x'.repeat(5000) + '</body></html>' };
  var t = await feeds.sendTest(admin, feed.id);
  assert.equal(t.ok, true);
  assert.equal(t.page, true, 'a whole web page is flagged');
  assert.match(t.answer, /^<!DOCTYPE html> <html><head><title>Public Figah/);
  assert.ok(t.answer.length <= 300, 'only the start is kept');
  reply = { type: 'application/json', body: '{"received":true}' };
  await feeds.resend(admin, feed.id, { from: '2030-05-01', to: '2030-05-31' });
  var listed = (await feeds.list(admin)).feeds.find(function (f) { return f.id === feed.id; });
  assert.equal(listed.resentLast24h, 1);
  var d = listed.deliveries;
  assert.deepEqual([d[0].kind, d[0].answer, d[0].page], ['resend', '{"received":true}', false]);
  assert.deepEqual([d[1].kind, d[1].page, d[1].answerType], ['test', true, 'text/html; charset=utf-8']);
});

test('a real kiosk clock-in reaches the feed, once it has settled', async function () {
  var attendance = require('../src/services/attendance.service');
  feeds.setSettleMsForTests(60000);
  got = [];
  await attendance.clockInEmployee(empSbr, 'kiosk', null, null);
  await feeds.deliverDue();
  assert.equal(got.length, 0, 'not sent while it may still be settling');
  feeds.setSettleMsForTests(0);
  await feeds.deliverDue();
  assert.equal(got.length, 1);
  var r = eventsOf(got[0])[0].attendance;
  assert.deepEqual([r.employee.code, r.source, r.clockOut], ['ZAF-1', 'kiosk', null]);
  await pool.query("DELETE FROM attendance WHERE employee_id = $1 AND date NOT BETWEEN '2030-01-01' AND '2030-12-31'", [empSbr]);
  await feeds.deliverDue();
});

test('reading with the key: changes since, days, staff — this feed\'s only', async function () {
  assert.equal((await pull('/changes')).status, 401);
  assert.equal((await pull('/changes', 'bfk_' + 'x'.repeat(40))).status, 401);
  var first = await pull('/changes?after=0&limit=500', feed.readKeyValue);
  assert.equal(first.status, 200);
  var codes = new Set(first.body.events.map(function (e) { return e.attendance.employee.code; }));
  assert.ok(codes.has('ZAF-1') && !codes.has('ZAF-2'));
  var again = await pull('/changes?after=' + first.body.next, feed.readKeyValue);
  assert.equal(again.body.events.length, 0, 'asking with next gives nothing twice');
  var days = await pull('/records?from=2030-05-01&to=2030-05-31', feed.readKeyValue);
  assert.deepEqual(days.body.records.map(function (r) { return r.employee.code + ' ' + r.date; }), ['ZAF-1 2030-05-06']);
  assert.equal((await pull('/records?from=2030-01-01&to=2030-12-31', feed.readKeyValue)).status, 400, 'at most 93 days');
  var staff = await pull('/staff', feed.readKeyValue);
  assert.deepEqual(staff.body.staff.map(function (s) { return s.code; }), ['ZAF-1']);

  await feeds.update(admin, feed.id, { active: false });
  assert.equal((await pull('/staff', feed.readKeyValue)).status, 403, 'paused');
  await feeds.update(admin, feed.id, { active: true });
  var old = feed.readKeyValue;
  var fresh = (await feeds.rotateReadKey(admin, feed.id)).readKeyValue;
  assert.equal((await pull('/staff', old)).status, 401, 'the old key stopped working');
  assert.equal((await pull('/staff', fresh)).status, 200);
  feed.readKeyValue = fresh;
});

test('days: present, late, absent, leave and off for any range, a month a page; nothing before hiring or after today', async function () {
  // Mon 2 – Sun 8 March 2026; ZAF-1 works Monday to Friday.
  await pool.query("UPDATE employees SET work_days = 'mon_fri' WHERE id = $1", [empSbr]);
  await pool.query("INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date) VALUES ('ZAF-3', 'Zq', 'Newcomer', 'zaf3@example.com', $1, '2026-03-05')", [depSbr]);
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, status, source) VALUES ($1, '2026-03-02', '08:00', '16:00', 'present', 'kiosk'), ($1, '2026-03-03', '09:10', NULL, 'late', 'kiosk')", [empSbr]);
  var lt = (await pool.query('SELECT id FROM leave_types WHERE active ORDER BY name LIMIT 1')).rows[0].id;
  await pool.query("INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) VALUES ($1, $2, '2026-03-05', '2026-03-05', 1, 'ZAF', 'approved')", [empSbr, lt]);

  var week = await pull('/days?from=2026-03-02&to=2026-03-08', feed.readKeyValue);
  assert.equal(week.status, 200);
  var mine = week.body.days.filter(function (d) { return d.employee.code === 'ZAF-1'; }).map(function (d) { return d.date.slice(8) + ' ' + d.status + (d.clockIn ? ' ' + d.clockIn + '-' + (d.clockOut || '') : ''); });
  assert.deepEqual(mine, ['02 present 08:00-16:00', '03 late 09:10-', '04 absent', '05 leave', '06 absent', '07 off', '08 off']);
  var newcomer = week.body.days.filter(function (d) { return d.employee.code === 'ZAF-3'; }).map(function (d) { return d.date.slice(8); });
  assert.deepEqual(newcomer, ['05', '06', '07', '08'], 'nothing before they were hired');
  assert.ok(!week.body.days.some(function (d) { return d.employee.code === 'ZAF-2'; }), 'another company\'s staff never');
  assert.equal(week.body.next, null);

  // A long range comes a month at a time; asking with next until it is null gets every day once.
  var seen = [], next = '2026-01-01', pages = 0;
  while (next) {
    var page = (await pull('/days?from=' + next + '&to=2026-03-08', feed.readKeyValue)).body;
    page.days.filter(function (d) { return d.employee.code === 'ZAF-1'; }).forEach(function (d) { seen.push(d.date); });
    next = page.next; pages++;
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, 67);
  assert.equal(new Set(seen).size, 67);

  // Nothing after today.
  var today = new Date().toISOString().slice(0, 10);
  var future = (await pull('/days?from=' + today + '&to=2030-12-31', feed.readKeyValue)).body;
  assert.ok(future.days.every(function (d) { return d.date <= today; }));
  assert.equal(future.next, null);
  assert.equal((await pull('/days?from=2026-03-08&to=2026-03-02', feed.readKeyValue)).status, 400);
  await pool.query("UPDATE employees SET work_days = NULL WHERE id = $1", [empSbr]);
});

test('from a browser: only the feed\'s own website may read it, and it can be given as publicfigah.com/#board', async function () {
  var saved = await feeds.update(admin, feed.id, { allowedOrigin: 'publicfigah.example/#board' });
  assert.equal(saved.allowedOrigin, 'https://publicfigah.example');
  async function ask(method, path, origin, key) {
    var h = { Origin: origin };
    if (key) h.Authorization = 'Bearer ' + key;
    if (method === 'OPTIONS') { h['Access-Control-Request-Method'] = 'GET'; h['Access-Control-Request-Headers'] = 'authorization'; }
    var r = await fetch(base + '/api/feeds/attendance' + path, { method: method, headers: h });
    return { status: r.status, allow: r.headers.get('access-control-allow-origin') };
  }
  var pre = await ask('OPTIONS', '/days', 'https://publicfigah.example');
  assert.deepEqual([pre.status, pre.allow], [204, 'https://publicfigah.example']);
  var preOther = await ask('OPTIONS', '/days', 'https://elsewhere.example');
  assert.equal(preOther.allow, null, 'another website gets no permission');
  var ok = await ask('GET', '/days?from=2026-03-02&to=2026-03-02', 'https://publicfigah.example', feed.readKeyValue);
  assert.deepEqual([ok.status, ok.allow], [200, 'https://publicfigah.example']);
  var other = await ask('GET', '/staff', 'https://elsewhere.example', feed.readKeyValue);
  assert.equal(other.status, 403, 'the key from another website is refused');
  assert.equal((await pull('/staff', feed.readKeyValue)).status, 200, 'a server (no Origin) still reads');
  // The OS's own screens keep their own rule.
  var app = await fetch(base + '/api/health', { headers: { Origin: 'https://publicfigah.example' } });
  assert.equal(app.headers.get('access-control-allow-origin'), null);
  feeds.setAllowLocalForTests(false);
  try {
    await assert.rejects(feeds.update(admin, feed.id, { allowedOrigin: 'http://publicfigah.example' }), /https/);
  } finally {
    feeds.setAllowLocalForTests(true);
  }
});

test('send again, the test button, and the address rules', async function () {
  got = [];
  var r = await feeds.resend(admin, feed.id, { from: '2030-05-01', to: '2030-05-31' });
  assert.deepEqual([r.ok, r.sent], [true, 1]);
  assert.equal(eventsOf(got[0])[0].resent, true);
  got = [];
  var t = await feeds.sendTest(admin, feed.id);
  assert.equal(t.ok, true);
  assert.equal(eventsOf(got[0])[0].type, 'feed.test');
  var log = await feeds.deliveries(admin, feed.id);
  assert.deepEqual(log.slice(0, 2).map(function (d) { return d.kind; }), ['test', 'resend']);

  var secret2 = (await feeds.rotateSecret(admin, feed.id)).signingSecret;
  got = [];
  await feeds.sendTest(admin, feed.id);
  assert.ok(verify(got[0], secret2) && !verify(got[0], feed.signingSecret), 'signed with the new secret');

  feeds.setAllowLocalForTests(false);
  try {
    assert.throws(function () { feeds.checkUrl('http://publicfigah.com/x'); }, /https/);
    assert.throws(function () { feeds.checkUrl('https://localhost/x'); }, /not a number or localhost/);
    assert.throws(function () { feeds.checkUrl('https://10.0.0.5/x'); }, /not a number or localhost/);
    assert.throws(function () { feeds.checkUrl('https://user:pw@publicfigah.com/x'); }, /password/);
    assert.throws(function () { feeds.checkUrl('https://publicfigah.com/#board'); }, /part after #/);
    assert.equal(feeds.checkUrl('https://publicfigah.com/api/attendance').hostname, 'publicfigah.com');
    ['10.1.2.3', '127.0.0.1', '192.168.0.4', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '100.64.0.1'].forEach(function (ip) { assert.equal(feeds.privateAddress(ip), true, ip); });
    ['8.8.8.8', '41.66.1.1', '2606:4700::1111'].forEach(function (ip) { assert.equal(feeds.privateAddress(ip), false, ip); });
  } finally {
    feeds.setAllowLocalForTests(true);
  }
  await feeds.remove(admin, feed.id);
  assert.equal((await pull('/staff', feed.readKeyValue)).status, 401, 'a deleted feed\'s key is gone');
});
