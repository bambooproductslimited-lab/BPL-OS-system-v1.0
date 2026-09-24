/*
 * Warnings before things run out (jobs/dailyAlerts.js): company documents
 * and staff ID cards and passports with an expiry date; setting those dates
 * (documents.service.js, employeeDocuments.service.js); and staff alerts by
 * text when that is turned on (staffAlerts.service.js), against a stand-in
 * for mNotify on localhost.
 *
 * Documents use the Z8E prefix; the ID document is victor.maina's passport.
 * All are removed afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');
var app = require('../src/app');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var job = require('../src/jobs/dailyAlerts');
var staffAlerts = require('../src/services/staffAlerts.service');

var server, base, fake, saved;
var received = [];
var docs = {}, victor, kelvin;

function iso(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
async function call(method, path, body, token) {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  var res = await fetch(base + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
  var text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function tokenOf(email) {
  return (await call('POST', '/api/auth/login', { email: email, password: 'bamboo123' })).body.token;
}
async function notes(like) {
  return (await pool.query('SELECT employee_id, title, body, link FROM notifications WHERE title LIKE $1 ORDER BY at', [like])).rows;
}

async function cleanup() {
  await pool.query("DELETE FROM notifications WHERE title LIKE '%Z8E%' OR (title LIKE '%passport%' AND at > now() - interval '1 hour')");
  await pool.query("DELETE FROM expiry_alerts WHERE ref_id IN (SELECT id FROM documents WHERE title LIKE 'Z8E%')");
  if (victor) {
    await pool.query("DELETE FROM expiry_alerts WHERE ref_id IN (SELECT id FROM employee_documents WHERE employee_id = $1)", [victor]);
    await pool.query("DELETE FROM employee_documents WHERE employee_id = $1 AND object_key LIKE 'z8e/%'", [victor]);
  }
  await pool.query("DELETE FROM documents WHERE title LIKE 'Z8E%'");
  await pool.query("DELETE FROM sms_messages WHERE purpose = 'staff_alert' AND message LIKE '%Z8E%'");
}

async function doc(key, title, days, visibility) {
  docs[key] = (await pool.query(
    "INSERT INTO documents (title, category, visibility, uploaded_by, file_name, expires_on) VALUES ($1, 'Licence', $2, $3, 'x.pdf', $4) RETURNING id",
    [title, visibility || 'managers', kelvin, days === null ? null : iso(days)]
  )).rows[0].id;
}

test.before(async function () {
  saved = { apiKey: config.sms.apiKey, senderId: config.sms.senderId, baseUrl: config.sms.baseUrl };
  fake = http.createServer(function (req, res) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      received.push(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'success', code: '2000', summary: { _id: 'x', numbers_sent: body && body.recipient, credit_used: 1 } }));
    });
  });
  await new Promise(function (done) { fake.listen(0, done); });
  Object.assign(config.sms, { apiKey: 'k', senderId: 'BambooOS', baseUrl: 'http://127.0.0.1:' + fake.address().port });

  kelvin = (await pool.query("SELECT employee_id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].employee_id;
  victor = (await pool.query("SELECT employee_id FROM users WHERE email = 'victor.maina@bplghana.com'")).rows[0].employee_id;
  await cleanup();
  await doc('soon', 'Z8E Factory licence', 25);
  await doc('gone', 'Z8E Fire permit', -3);
  await doc('far', 'Z8E Land title', 200);
  await pool.query(
    "INSERT INTO employee_documents (employee_id, kind, file_name, object_key, uploaded_by, expires_on) VALUES ($1, 'passport', 'p.jpg', 'z8e/p.jpg', $2, $3)",
    [victor, kelvin, iso(5)]
  );
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
});
test.after(async function () {
  await cleanup();
  Object.assign(config.sms, saved);
  server.close();
  fake.close();
  await pool.end();
});

test('documents: warned once at the most urgent milestone passed; the uploader and document managers', async function () {
  await job.expiryAlerts(iso(0), { staffAlertsBySms: false });
  var soon = await notes('Document expires in 25 days — Z8E Factory licence');
  assert.ok(soon.length >= 1);
  assert.ok(soon.some(function (n) { return n.employee_id === kelvin; }), 'the uploader');
  assert.equal(soon[0].link, 'documents');
  assert.match(soon[0].body, /Z8E Factory licence \(Licence\) expires on/);
  var hr = (await pool.query("SELECT employee_id FROM users WHERE email = 'albert.awini@bplghana.com'")).rows[0].employee_id;
  assert.ok(soon.some(function (n) { return n.employee_id === hr; }), 'Finance & HR manages documents');

  var gone = await notes('Document expired — Z8E Fire permit');
  assert.ok(gone.length >= 1);
  assert.match(gone[0].body, /expired on/);
  assert.equal((await notes('%Z8E Land title%')).length, 0, 'not 200 days out');

  var marks = (await pool.query('SELECT milestone FROM expiry_alerts WHERE ref_id = $1 ORDER BY milestone', [docs.soon])).rows.map(function (r) { return r.milestone; });
  assert.deepEqual(marks, ['30', '60'], 'the 60-day warning is marked with it, not sent separately');

  var before = (await notes('%Z8E%')).length;
  await job.expiryAlerts(iso(0), { staffAlertsBySms: false });
  assert.equal((await notes('%Z8E%')).length, before, 'nothing twice');
});

test('a document for one department warns only managers who can see it', async function () {
  var dept = (await pool.query('SELECT department_id FROM employees WHERE id = $1', [kelvin])).rows[0].department_id;
  await pool.query("UPDATE documents SET visibility = 'department', department_id = $2, expires_on = $3 WHERE id = $1", [docs.far, dept, iso(10)]);
  await job.expiryAlerts(iso(0), { staffAlertsBySms: false });
  var got = await notes('%Z8E Land title%');
  assert.ok(got.length >= 1);
  for (var i = 0; i < got.length; i++) {
    var r = (await pool.query(
      "SELECT e.department_id = $2 OR EXISTS (SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE u.employee_id = e.id AND rp.permission_key = 'employee.read.all') AS ok " +
      'FROM employees e WHERE e.id = $1', [got[i].employee_id, dept])).rows[0];
    assert.equal(r.ok, true, 'everyone warned can see the document');
  }
});

test('a renewed document (new date) is warned about again when the new date comes near', async function () {
  await pool.query('UPDATE documents SET expires_on = $2 WHERE id = $1', [docs.soon, iso(6)]);
  await job.expiryAlerts(iso(0), { staffAlertsBySms: false });
  assert.ok((await notes('Document expires in 6 days — Z8E Factory licence')).length >= 1);
});

test('staff ID documents: HR and the person themselves', async function () {
  await job.expiryAlerts(iso(0), { staffAlertsBySms: false });
  var own = await notes('Your passport expires in 5 days');
  assert.deepEqual(own.map(function (n) { return [n.employee_id, n.link]; }), [[victor, 'myspace']]);
  var hr = await notes('Passport expires in 5 days — Victor Maina');
  assert.ok(hr.length >= 1);
  assert.equal(hr[0].link, 'people');
  assert.ok(!hr.some(function (n) { return n.employee_id === victor; }));
});

test('setting expiry dates: document managers for documents; HR for ID cards and passports', async function () {
  var staff = await tokenOf('john.sitati@bplghana.com');
  var admin = await tokenOf('kelvin.duho@bplghana.com');
  assert.equal((await call('PATCH', '/api/documents/' + docs.gone, { expiresOn: iso(300) }, staff)).status, 403);
  var r = await call('PATCH', '/api/documents/' + docs.gone, { expiresOn: iso(300) }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.expiresOn, iso(300));
  assert.equal((await call('PATCH', '/api/documents/' + docs.gone, { expiresOn: 'soon' }, admin)).status, 400);
  assert.equal((await call('PATCH', '/api/documents/' + docs.gone, { expiresOn: '' }, admin)).body.expiresOn, null, 'blank clears it');
  var list = (await call('GET', '/api/documents', null, admin)).body;
  assert.ok(list.some(function (d) { return d.id === docs.soon && d.expiresOn === iso(6); }));

  assert.equal((await call('PATCH', '/api/employees/' + victor + '/id-documents/passport', { expiresOn: iso(900) }, staff)).status, 403);
  var slots = (await call('PATCH', '/api/employees/' + victor + '/id-documents/passport', { expiresOn: iso(900) }, admin)).body;
  var passport = slots.filter(function (s) { return s.kind === 'passport'; })[0];
  assert.equal(passport.expiresOn, iso(900));
  assert.equal(passport.canExpire, true);
  assert.equal((await call('PATCH', '/api/employees/' + victor + '/id-documents/id_back', { expiresOn: iso(9) }, admin)).status, 400);
  assert.equal((await call('PATCH', '/api/employees/' + victor + '/id-documents/id_front', { expiresOn: iso(9) }, admin)).status, 404, 'nothing uploaded yet');
});

test('"Text staff their alerts": the alert goes by text too, to the phone on their record', async function () {
  var phone = (await pool.query('SELECT phone FROM employees WHERE id = $1', [victor])).rows[0].phone;
  await pool.query("UPDATE employees SET phone = '0244000111' WHERE id = $1", [victor]);
  try {
    var before = received.length;
    var off = await staffAlerts.alert(victor, 'Z8E test', 'Nothing to do.', null, { staffAlertsBySms: false });
    assert.equal(off.texted, false);
    assert.equal(received.length, before);
    var on = await staffAlerts.alert(victor, 'Z8E test', 'Nothing to do.', null, { staffAlertsBySms: true });
    assert.equal(on.texted, true);
    assert.deepEqual(received[before].recipient, ['0244000111']);
    assert.equal(received[before].message, 'Bamboo OS: Z8E test. Nothing to do.');
    assert.equal((await notes('Z8E test')).length, 2, 'the bell either way');
  } finally {
    await pool.query('UPDATE employees SET phone = $2 WHERE id = $1', [victor, phone]);
  }
});

test('the round runs only what is due for the hour', async function () {
  var early = new Date(); early.setUTCHours(5, 0, 0, 0);
  assert.deepEqual(await job.runOnce(early), { expiry: 0, bookings: 0, texts: 0 });
});
