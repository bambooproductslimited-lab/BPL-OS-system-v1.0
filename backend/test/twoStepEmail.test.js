/*
 * Two-step sign-in codes by email (twoStep.service.js through
 * mail.service.js), and Company settings → Email. Mail goes to an in-memory
 * outbox instead of an SMTP server, so nothing leaves the machine.
 *
 * Uses the seeded account moses.wekesa (no other test signs in as him, since
 * test files run side by side) and leaves two-step off for him.
 * kelvin.duho (System Administrator) only signs in.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var app = require('../src/app');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var mail = require('../src/services/mail.service');
var totp = require('../src/lib/totp');

var server, base;
var EMAIL = 'moses.wekesa@bplghana.com';
var ADMIN = 'kelvin.duho@bplghana.com';
var outbox = [];
var nextError = null;

async function call(method, path, body, token) {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  var res = await fetch(base + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
  var text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
function login(email) { return call('POST', '/api/auth/login', { email: email, password: 'bamboo123' }); }
async function tokenOf(email) { return (await login(email)).body.token; }
function last() { return outbox[outbox.length - 1]; }
function codeIn(m) { return (/(\d{6})/.exec(m.subject) || [])[1]; }

async function reset() {
  await pool.query(
    'UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, ' +
    'two_step_phone = NULL, sms_two_step_at = NULL, email_two_step_at = NULL, failed_login_attempts = 0, locked_until = NULL WHERE email = $1', [EMAIL]);
  await pool.query('DELETE FROM user_backup_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)', [EMAIL]);
  await pool.query('DELETE FROM two_step_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)', [EMAIL]);
}
async function ageCodes() {
  await pool.query("UPDATE two_step_codes SET created_at = created_at - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE email = $1)", [EMAIL]);
}

test.before(async function () {
  mail.setTransportForTests({
    sendMail: async function (m) {
      if (nextError) { var e = nextError; nextError = null; throw e; }
      outbox.push(m);
      return { messageId: 'm' + outbox.length };
    }
  });
  await reset();
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
});
test.after(async function () {
  await reset();
  mail.setTransportForTests(null);
  server.close();
  await pool.end();
});

test('Company settings → Email: only settings.manage; a test email goes to the person asking', async function () {
  var staff = await tokenOf(EMAIL);
  assert.equal((await call('GET', '/api/mail', null, staff)).status, 403);
  assert.equal((await call('POST', '/api/mail/test', {}, staff)).status, 403);
  var admin = await tokenOf(ADMIN);
  assert.equal((await call('GET', '/api/mail', null, admin)).body.configured, true);
  var r = await call('POST', '/api/mail/test', {}, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.to, ADMIN);
  assert.equal(last().to, ADMIN);
  assert.equal(last().subject, 'Bamboo OS test email');

  var pass = config.mail.pass;
  config.mail.pass = 'secret-pass-99';
  try {
    nextError = Object.assign(new Error('Invalid login: 535 Authentication failed secret-pass-99'), { code: 'EAUTH' });
    r = await call('POST', '/api/mail/test', {}, admin);
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /didn't accept the sign-in/);
    nextError = Object.assign(new Error('boom secret-pass-99'), { code: 'EMESSAGE' });
    r = await call('POST', '/api/mail/test', {}, admin);
    assert.ok(JSON.stringify(r.body).indexOf('secret-pass-99') < 0, 'the password never comes back');
  } finally { config.mail.pass = pass; }
});

test('turning it on: a code emailed to the sign-in address, typed back', async function () {
  var t = await tokenOf(EMAIL);
  var st = (await call('GET', '/api/me/two-step', null, t)).body;
  assert.equal(st.emailAvailable, true);
  assert.equal(st.email.on, false);
  assert.equal(st.email.address, EMAIL);

  var setup = await call('POST', '/api/me/two-step/email/setup', {}, t);
  assert.equal(setup.status, 200);
  assert.equal(setup.body.sentTo, 'mo•••@bplghana.com');
  assert.equal(setup.body.channel, 'email');
  assert.equal(last().to, EMAIL);
  var code = codeIn(last());
  assert.ok(code);
  assert.match(last().text, new RegExp(code));
  assert.match(last().html, new RegExp(code));
  var stored = (await pool.query("SELECT code_hash, channel, sent_to FROM two_step_codes WHERE user_id = (SELECT id FROM users WHERE email = $1) ORDER BY created_at DESC LIMIT 1", [EMAIL])).rows[0];
  assert.ok(stored.code_hash.indexOf(code) < 0, 'stored hashed');
  assert.equal(stored.channel, 'email');

  assert.equal((await call('POST', '/api/me/two-step/email/setup', {}, t)).status, 429, 'one a minute');
  assert.equal((await call('POST', '/api/me/two-step/sms/enable', { code: code }, t)).status, 400, 'an emailed code can\'t turn on texts');
  assert.equal((await call('POST', '/api/me/two-step/email/enable', { code: code === '000000' ? '111111' : '000000' }, t)).status, 400);
  var on = await call('POST', '/api/me/two-step/email/enable', { code: code }, t);
  assert.equal(on.status, 200);
  assert.equal(on.body.backupCodes.length, 10);
  st = (await call('GET', '/api/me/two-step', null, t)).body;
  assert.equal(st.email.on, true);
  assert.equal(st.enabled, true);

  var admin = await tokenOf(ADMIN);
  var list = (await call('GET', '/api/users', null, admin)).body;
  assert.equal(list.filter(function (u) { return u.email === EMAIL; })[0].twoStepOn, true);
});

test('signing in: the code is emailed straight away; it works once', async function () {
  await ageCodes();
  var first = await login(EMAIL);
  assert.equal(first.body.token, undefined);
  assert.deepEqual(first.body.methods, ['email']);
  assert.equal(first.body.emailTo, 'mo•••@bplghana.com');
  assert.equal(first.body.codeSent, true);
  assert.equal(first.body.codeSentVia, 'email');
  assert.match(last().subject, /^\d{6} is your Bamboo OS sign-in code$/);
  var code = codeIn(last());
  var ok = await call('POST', '/api/auth/login/verify', { challenge: first.body.challenge, code: code });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  await ageCodes();
  var again = await login(EMAIL);
  assert.equal((await call('POST', '/api/auth/login/verify', { challenge: again.body.challenge, code: code })).status, 401, 'not twice');
  assert.equal((await call('POST', '/api/auth/login/send-code', { challenge: again.body.challenge, channel: 'sms' })).status, 400, 'texts aren\'t on for him');
  assert.equal((await call('POST', '/api/auth/login/verify', { challenge: again.body.challenge, code: codeIn(last()) })).status, 200);
  await pool.query('UPDATE users SET failed_login_attempts = 0 WHERE email = $1', [EMAIL]);
});

test('with the app too: nothing is emailed until asked for; either code works', async function () {
  await ageCodes();
  var f = await login(EMAIL);
  var t = (await call('POST', '/api/auth/login/verify', { challenge: f.body.challenge, code: codeIn(last()) })).body.token;
  var setup = (await call('POST', '/api/me/two-step/setup', {}, t)).body;
  assert.equal((await call('POST', '/api/me/two-step/enable', { code: totp.codeAt(setup.secret, totp.currentStep()) }, t)).body.backupCodes, null);

  await ageCodes();
  var before = outbox.length;
  var first = await login(EMAIL);
  assert.deepEqual(first.body.methods, ['app', 'email']);
  assert.equal(first.body.codeSent, false);
  assert.equal(outbox.length, before);
  var sent = await call('POST', '/api/auth/login/send-code', { challenge: first.body.challenge, channel: 'email' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.sentTo, 'mo•••@bplghana.com');
  assert.equal((await call('POST', '/api/auth/login/verify', { challenge: first.body.challenge, code: codeIn(last()) })).status, 200);

  // Remove email: the app remains.
  assert.equal((await call('POST', '/api/me/two-step/disable', { password: 'bamboo123', method: 'email' }, t)).body.enabled, true);
  var st = (await call('GET', '/api/me/two-step', null, t)).body;
  assert.equal(st.email.on, false);
  assert.equal(st.app.on, true);
  assert.equal(st.backupCodesLeft, 10);
});

test('the Claude connector page offers "Email me a code"', async function () {
  await reset();
  var t = await tokenOf(EMAIL);
  await call('POST', '/api/me/two-step/email/setup', {}, t);
  await call('POST', '/api/me/two-step/email/enable', { code: codeIn(last()) }, t);
  await ageCodes();

  var CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
  var client = await (await fetch(base + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Z9MCP EMAIL', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }) })).json();
  var verifier = crypto.randomBytes(32).toString('base64url');
  var page = await (await fetch(base + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's' }))).text();
  var request = /name="request" value="([^"]+)"/.exec(page)[1];
  var form = function (fields) {
    return fetch(base + '/oauth/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  };
  var html = await (await form({ request: request, email: EMAIL, password: 'bamboo123', decision: 'allow' })).text();
  assert.match(html, /emailed to mo•••@bplghana\.com/);
  assert.match(html, /Code sent to mo•••@bplghana\.com/);
  assert.match(html, /Send a new code by email/);
  var challenge = /name="challenge" value="([^"]+)"/.exec(html)[1];
  var done = await form({ request: request, challenge: challenge, code: codeIn(last()), decision: 'allow' });
  assert.equal(done.status, 302);
  await pool.query("DELETE FROM mcp_oauth_clients WHERE info->>'client_name' = 'Z9MCP EMAIL'");
  await reset();
});

test('not set up: no email option, and set-up says why', async function () {
  mail.setTransportForTests(null);
  var saved = config.mail.host;
  config.mail.host = '';
  try {
    var t = await tokenOf(EMAIL);
    assert.equal((await call('GET', '/api/me/two-step', null, t)).body.emailAvailable, false);
    var r = await call('POST', '/api/me/two-step/email/setup', {}, t);
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /email isn't set up/);
  } finally {
    config.mail.host = saved;
    mail.setTransportForTests({ sendMail: async function (m) { outbox.push(m); return { messageId: 'x' }; } });
  }
});
