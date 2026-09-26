/*
 * "Forgot your password?" on the sign-in screen: a code sent to the
 * person's email lets them choose a new password; the answer is the same
 * for an address with no account; a wrong code counts towards the lockout;
 * a reset clears must-change-password and a lockout, and never skips
 * two-step sign-in. Mail goes to an in-memory outbox. Test data: a ZQR
 * employee with the address zq.reset@example.com.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var bcrypt = require('bcrypt');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var mail = require('../src/services/mail.service');

var EMAIL = 'zq.reset@example.com';
var server, base, outbox = [];

async function call(method, path, body) {
  var res = await fetch(base + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  var text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
function codeIn(m) { return (/(\d{6})/.exec(m.subject) || [])[1]; }
async function cleanup() {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email = $1)", [EMAIL]).catch(function () {});
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  await pool.query("DELETE FROM employees WHERE code = 'ZQR-RESET'");
}

test.before(async function () {
  mail.setTransportForTests({ sendMail: async function (m) { outbox.push(m); return { messageId: 'm' + outbox.length }; } });
  await cleanup();
  var dept = (await pool.query('SELECT id FROM departments LIMIT 1')).rows[0].id;
  var emp = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type) VALUES ('ZQR-RESET', 'Zq Ama', 'Reset', $1, $2, current_date, 'active', 'permanent') RETURNING id",
    [EMAIL, dept])).rows[0].id;
  await pool.query("INSERT INTO users (employee_id, email, password_hash, status, must_change_password) VALUES ($1, $2, $3, 'active', true)",
    [emp, EMAIL, await bcrypt.hash('old-password-1', 4)]);
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
});
test.after(async function () { await cleanup(); mail.setTransportForTests(null); server.close(); await pool.end(); });

test('a code goes to the address; the same answer comes back for an address with no account', async function () {
  var r = await call('POST', '/api/auth/password/forgot', { email: EMAIL.toUpperCase() });
  assert.equal(r.status, 200);
  assert.equal(r.body.channel, 'email');
  assert.equal(r.body.sentTo, 'zq•••@example.com');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, EMAIL);
  assert.match(outbox[0].subject, /password reset code/);
  var nobody = await call('POST', '/api/auth/password/forgot', { email: 'zq.nobody@example.com' });
  assert.equal(nobody.status, 200);
  assert.deepEqual(Object.keys(nobody.body).sort(), Object.keys(r.body).sort());
  assert.equal(outbox.length, 1);                       // nothing sent for it
  assert.equal((await call('POST', '/api/auth/password/forgot', { email: 'not an email' })).status, 400);
  // a second code straight away is refused (one a minute)
  assert.equal((await call('POST', '/api/auth/password/forgot', { email: EMAIL })).status, 429);
});

test('a wrong code is refused and counts; the right one sets the new password once, clearing the forced change and the lockout', async function () {
  var code = codeIn(outbox[0]);
  var wrong = await call('POST', '/api/auth/password/reset', { email: EMAIL, code: code === '000000' ? '111111' : '000000', newPassword: 'new-password-1' });
  assert.equal(wrong.status, 401);
  assert.equal((await pool.query('SELECT failed_login_attempts FROM users WHERE email = $1', [EMAIL])).rows[0].failed_login_attempts, 1);
  assert.equal((await call('POST', '/api/auth/password/reset', { email: EMAIL, code: code, newPassword: 'short' })).status, 400);

  var ok = await call('POST', '/api/auth/password/reset', { email: EMAIL, code: code, newPassword: 'new-password-1' });
  assert.equal(ok.status, 200);
  var u = (await pool.query('SELECT failed_login_attempts, must_change_password FROM users WHERE email = $1', [EMAIL])).rows[0];
  assert.equal(u.failed_login_attempts, 0);
  assert.equal(u.must_change_password, false);
  assert.equal((await call('POST', '/api/auth/login', { email: EMAIL, password: 'old-password-1' })).status, 401);
  var signIn = await call('POST', '/api/auth/login', { email: EMAIL, password: 'new-password-1' });
  assert.equal(signIn.status, 200);
  assert.ok(signIn.body.token);
  // the code only works once
  assert.equal((await call('POST', '/api/auth/password/reset', { email: EMAIL, code: code, newPassword: 'another-password' })).status, 401);
  assert.ok((await pool.query("SELECT 1 FROM audit_logs WHERE action = 'auth.password_reset'")).rows[0]);
});

test('with two-step sign-in on, a reset still asks for the second step', async function () {
  await pool.query("UPDATE users SET email_two_step_at = now() WHERE email = $1", [EMAIL]);
  await pool.query("UPDATE two_step_codes SET created_at = created_at - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE email = $1)", [EMAIL]);
  await call('POST', '/api/auth/password/forgot', { email: EMAIL });
  var code = codeIn(outbox[outbox.length - 1]);
  assert.equal((await call('POST', '/api/auth/password/reset', { email: EMAIL, code: code, newPassword: 'new-password-2' })).status, 200);
  var signIn = await call('POST', '/api/auth/login', { email: EMAIL, password: 'new-password-2' });
  assert.equal(signIn.status, 200);
  assert.equal(signIn.body.twoStepRequired, true);
  assert.equal(signIn.body.token, undefined);
});
