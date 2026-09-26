/*
 * "Forgot your password?" with a choice of email or text message: the
 * screen asks which ways are set up; a texted code goes to the phone on the
 * account (the two-step phone, else the staff record's phone) and never
 * shows the number; the answer is the same for an address with no account
 * or no phone; a way that isn't set up on the server is refused plainly; a
 * text that can't be sent doesn't show the number on file. mNotify is a
 * fake local server and mail an in-memory outbox. Test data: a ZQRS
 * employee with the address zq.resetsms@example.com.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');
var bcrypt = require('bcrypt');
var app = require('../src/app');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var mail = require('../src/services/mail.service');

var EMAIL = 'zq.resetsms@example.com';
var PHONE = '024 555 0199';
var server, base, fake, saved, userId, outbox = [], texts = [], nextAnswer = null;

async function call(method, path, body) {
  var res = await fetch(base + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  var text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
function codeIn(message) { return (/(\d{6})/.exec(message) || [])[1]; }
// Each test asks for a fresh code; the one-a-minute limit is for people.
async function allowAnotherCode() {
  await pool.query("UPDATE two_step_codes SET created_at = created_at - interval '2 minutes' WHERE user_id = $1", [userId]);
}
async function cleanup() {
  await pool.query("DELETE FROM sms_messages WHERE ref_id IN (SELECT id FROM users WHERE email = $1)", [EMAIL]).catch(function () {});
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email = $1)", [EMAIL]).catch(function () {});
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  await pool.query("DELETE FROM employees WHERE code = 'ZQRS-RESET'");
}

test.before(async function () {
  mail.setTransportForTests({ sendMail: async function (m) { outbox.push(m); return { messageId: 'm' + outbox.length }; } });
  saved = { apiKey: config.sms.apiKey, senderId: config.sms.senderId, baseUrl: config.sms.baseUrl };
  fake = http.createServer(function (req, res) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      texts.push(body);
      res.setHeader('Content-Type', 'application/json');
      var answer = nextAnswer || { status: 'success', code: '2000', summary: { _id: 't' + texts.length, credit_used: 1, credit_left: 100 } };
      nextAnswer = null;
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise(function (done) { fake.listen(0, done); });
  Object.assign(config.sms, { apiKey: 'k', senderId: 'BambooOS', baseUrl: 'http://127.0.0.1:' + fake.address().port });

  await cleanup();
  var dept = (await pool.query('SELECT id FROM departments LIMIT 1')).rows[0].id;
  var emp = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, phone, department_id, hire_date, status, employment_type) VALUES ('ZQRS-RESET', 'Zq Kofi', 'Reset', $1, $2, $3, current_date, 'active', 'permanent') RETURNING id",
    [EMAIL, PHONE, dept])).rows[0].id;
  userId = (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, $2, $3, 'active') RETURNING id",
    [emp, EMAIL, await bcrypt.hash('old-password-1', 4)])).rows[0].id;
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
});
test.after(async function () {
  await cleanup(); mail.setTransportForTests(null); Object.assign(config.sms, saved);
  server.close(); fake.close(); await pool.end();
});

test('the screen can ask which ways are set up', async function () {
  var r = await call('GET', '/api/auth/password/options');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { email: true, sms: true, expiresInMinutes: r.body.expiresInMinutes });
  assert.ok(r.body.expiresInMinutes > 0);
});

test('a code by text goes to the phone on the staff record, without showing the number, and resets the password', async function () {
  var r = await call('POST', '/api/auth/password/forgot', { email: EMAIL, channel: 'sms' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { channel: 'sms', sentTo: null, expiresInMinutes: r.body.expiresInMinutes });
  assert.equal(texts.length, 1);
  assert.deepEqual(texts[0].recipient, ['0245550199']);
  assert.match(texts[0].message, /reset your password/);
  assert.equal(outbox.length, 0);
  var logged = (await pool.query('SELECT message FROM sms_messages WHERE ref_id = $1', [userId])).rows[0];
  assert.doesNotMatch(logged.message, /\d{6}/);                  // the log never keeps the code

  var nobody = await call('POST', '/api/auth/password/forgot', { email: 'zq.nobody@example.com', channel: 'sms' });
  assert.equal(nobody.status, 200);
  assert.deepEqual(nobody.body, r.body);
  assert.equal(texts.length, 1);

  var ok = await call('POST', '/api/auth/password/reset', { email: EMAIL, code: codeIn(texts[0].message), newPassword: 'new-password-1' });
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', '/api/auth/login', { email: EMAIL, password: 'new-password-1' })).status, 200);
});

test('the two-step phone comes first; no phone at all gets the same answer and nothing is sent', async function () {
  await allowAnotherCode();
  await pool.query("UPDATE users SET two_step_phone = '+233205550188' WHERE id = $1", [userId]);
  await call('POST', '/api/auth/password/forgot', { email: EMAIL, channel: 'sms' });
  assert.deepEqual(texts[texts.length - 1].recipient, ['0205550188']);

  await allowAnotherCode();
  await pool.query('UPDATE users SET two_step_phone = NULL WHERE id = $1', [userId]);
  await pool.query("UPDATE employees SET phone = '' WHERE code = 'ZQRS-RESET'");
  var before = texts.length;
  var r = await call('POST', '/api/auth/password/forgot', { email: EMAIL, channel: 'sms' });
  assert.equal(r.status, 200);
  assert.equal(r.body.channel, 'sms');
  assert.equal(texts.length, before);
});

test('email still works when chosen; a bad choice or an unset way is refused; a failed text never shows the number', async function () {
  await allowAnotherCode();
  var r = await call('POST', '/api/auth/password/forgot', { email: EMAIL, channel: 'email' });
  assert.equal(r.status, 200);
  assert.equal(r.body.sentTo, 'zq•••@example.com');
  assert.equal(outbox.length, 1);
  assert.equal((await call('POST', '/api/auth/password/forgot', { email: EMAIL, channel: 'fax' })).status, 400);

  await allowAnotherCode();
  await pool.query("UPDATE employees SET phone = '12' WHERE code = 'ZQRS-RESET'");
  var bad = await call('POST', '/api/auth/password/forgot', { email: EMAIL, channel: 'sms' });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error.message, /Try email instead/);
  assert.doesNotMatch(bad.body.error.message, /12/);

  var key = config.sms.apiKey;
  config.sms.apiKey = '';
  try {
    assert.deepEqual((await call('GET', '/api/auth/password/options')).body.sms, false);
    var off = await call('POST', '/api/auth/password/forgot', { email: EMAIL, channel: 'sms' });
    assert.equal(off.status, 502);
    assert.match(off.body.error.message, /Choose email instead/);
  } finally { config.sms.apiKey = key; }
});
