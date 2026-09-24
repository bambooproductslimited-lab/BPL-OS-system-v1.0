/*
 * Two-step sign-in with an authenticator app (twoStep.service.js): set-up,
 * signing in with a code or a backup code, "don't ask again on this
 * device", turning it off, an administrator's reset, and the Claude
 * connector's sign-in page asking for the code too.
 *
 * Uses the seeded account lydia.auma and leaves two-step off for it.
 * Requires `npm run migrate && npm run seed` first (the pretest hook).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var totp = require('../src/lib/totp');

var server, base;
var EMAIL = 'lydia.auma@bplghana.com';
var ADMIN = 'kelvin.duho@bplghana.com';
var secret, backupCodes, step;

async function call(method, path, body, token) {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  var res = await fetch(base + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
  var text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
function login(email, extra) { return call('POST', '/api/auth/login', Object.assign({ email: email, password: 'bamboo123' }, extra || {})); }
async function tokenOf(email) { return (await login(email)).body.token; }
// A code for the next unused step, so each sign-in in the test is a new code.

async function reset() {
  await pool.query('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, two_step_phone = NULL, sms_two_step_at = NULL, failed_login_attempts = 0, locked_until = NULL WHERE email = $1', [EMAIL]);
  await pool.query('DELETE FROM user_backup_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)', [EMAIL]);
}
test.before(async function () {
  await reset();
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
});
test.after(async function () { await reset(); server.close(); await pool.end(); });

test('codes match the RFC 6238 test values, so any authenticator app agrees with the OS', function () {
  var s = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(s, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp.codeAt(s, Math.floor(59 / 30)), '287082');
  assert.equal(totp.codeAt(s, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totp.codeAt(s, Math.floor(1234567890 / 30)), '005924');
  assert.equal(totp.verify(s, '005924', 1234567890 * 1000), Math.floor(1234567890 / 30));
  assert.equal(totp.verify(s, '005924', (1234567890 + 30) * 1000), Math.floor(1234567890 / 30), 'one step late still works');
  assert.equal(totp.verify(s, '005924', (1234567890 + 90) * 1000), null, 'three steps late does not');
  assert.equal(totp.verify(s, 'abcdef'), null);
});

test('turning it on: a code from the app proves it was scanned, then backup codes are shown once', async function () {
  var t = await tokenOf(EMAIL);
  var before = (await call('GET', '/api/me/two-step', null, t)).body;
  assert.equal(before.enabled, false);
  assert.equal(before.backupCodesLeft, 0);
  assert.equal(before.app.on, false);
  assert.equal(before.sms.on, false);
  var setup = (await call('POST', '/api/me/two-step/setup', {}, t)).body;
  secret = setup.secret;
  assert.match(setup.otpauthUri, /^otpauth:\/\/totp\/Bamboo%20OS:lydia\.auma%40bplghana\.com\?secret=[A-Z2-7]+&issuer=Bamboo%20OS/);
  var stored = (await pool.query('SELECT totp_pending_enc FROM users WHERE email = $1', [EMAIL])).rows[0].totp_pending_enc;
  assert.ok(stored && stored.indexOf(secret) < 0, 'the secret is stored encrypted');

  assert.equal((await call('POST', '/api/me/two-step/enable', { code: '000000' }, t)).status, 400);
  var on = await call('POST', '/api/me/two-step/enable', { code: totp.codeAt(secret, totp.currentStep()) }, t);
  assert.equal(on.status, 200);
  backupCodes = on.body.backupCodes;
  assert.equal(backupCodes.length, 10);
  assert.match(backupCodes[0], /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  step = totp.currentStep();
  assert.equal((await call('GET', '/api/me/two-step', null, t)).body.backupCodesLeft, 10);
});

test('signing in: the password alone is not enough; a wrong code counts towards the lockout; a code works once', async function () {
  var first = await login(EMAIL);
  assert.equal(first.status, 200);
  assert.equal(first.body.token, undefined, 'no session from the password alone');
  assert.equal(first.body.twoStepRequired, true);

  var wrong = await call('POST', '/api/auth/login/verify', { challenge: first.body.challenge, code: '123456' });
  assert.equal(wrong.status, 401);
  assert.equal((await pool.query('SELECT failed_login_attempts FROM users WHERE email = $1', [EMAIL])).rows[0].failed_login_attempts, 1);

  var code = totp.codeAt(secret, totp.currentStep() + 1);
  var ok = await call('POST', '/api/auth/login/verify', { challenge: first.body.challenge, code: code });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal(ok.body.deviceToken, null);
  assert.equal((await pool.query('SELECT failed_login_attempts FROM users WHERE email = $1', [EMAIL])).rows[0].failed_login_attempts, 0);

  var again = await login(EMAIL);
  var replay = await call('POST', '/api/auth/login/verify', { challenge: again.body.challenge, code: code });
  assert.equal(replay.status, 401, 'the same code cannot sign in twice');

  var forged = await call('POST', '/api/auth/login/verify', { challenge: 'x.y.z', code: code });
  assert.equal(forged.status, 401);
});

test('a backup code works once; "don\'t ask again" skips the code on that device only', async function () {
  var a = await login(EMAIL);
  var withBackup = await call('POST', '/api/auth/login/verify', { challenge: a.body.challenge, code: backupCodes[0].toLowerCase(), rememberDevice: true });
  assert.equal(withBackup.status, 200);
  var device = withBackup.body.deviceToken;
  assert.ok(device);

  var b = await login(EMAIL);
  assert.equal((await call('POST', '/api/auth/login/verify', { challenge: b.body.challenge, code: backupCodes[0] })).status, 401, 'used');

  var remembered = await login(EMAIL, { deviceToken: device });
  assert.ok(remembered.body.token, 'this device is not asked again');
  var other = await login('kelvin.duho@bplghana.com', { deviceToken: device });
  assert.ok(other.body.token, 'someone else\'s device token means nothing (their account has no two-step)');
  await pool.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE email = $1', [EMAIL]);
});

test('turning it off needs the password; an administrator can reset it; either ends remembered devices', async function () {
  var a = await login(EMAIL);
  var t = (await call('POST', '/api/auth/login/verify', { challenge: a.body.challenge, code: backupCodes[1], rememberDevice: true })).body;

  assert.equal((await call('POST', '/api/me/two-step/disable', { password: 'wrong' }, t.token)).status, 401);
  var fresh = await call('POST', '/api/me/two-step/backup-codes', { password: 'bamboo123' }, t.token);
  assert.equal(fresh.body.backupCodes.length, 10);
  var b = await login(EMAIL);
  assert.equal((await call('POST', '/api/auth/login/verify', { challenge: b.body.challenge, code: backupCodes[2] })).status, 401, 'old backup codes stop working');

  var employee = await tokenOf('john.sitati@bplghana.com');
  var userId = (await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])).rows[0].id;
  assert.equal((await call('POST', '/api/users/' + userId + '/two-step/reset', {}, employee)).status, 403);
  var admin = await tokenOf(ADMIN);
  assert.equal((await call('POST', '/api/users/' + userId + '/two-step/reset', {}, admin)).status, 200);
  var list = (await call('GET', '/api/users', null, admin)).body;
  assert.equal(list.filter(function (u) { return u.email === EMAIL; })[0].twoStepOn, false);
  assert.ok((await login(EMAIL)).body.token, 'password alone again');
  await pool.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE email = $1', [EMAIL]);
});

test('the Claude connector\'s sign-in page asks for the code too', async function () {
  var t = await tokenOf(EMAIL);
  var setup = await call('POST', '/api/me/two-step/setup', {}, t);
  secret = setup.body.secret;
  var on = await call('POST', '/api/me/two-step/enable', { code: totp.codeAt(secret, totp.currentStep()) }, t);
  assert.equal(on.status, 200, JSON.stringify([setup, on]));

  var CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
  var client = await (await fetch(base + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Z9MCP 2FA', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }) })).json();
  var verifier = crypto.randomBytes(32).toString('base64url');
  var page = await (await fetch(base + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's' }))).text();
  var request = /name="request" value="([^"]+)"/.exec(page)[1];
  var form = function (fields) {
    return fetch(base + '/oauth/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  };
  var afterPassword = await form({ request: request, email: EMAIL, password: 'bamboo123', decision: 'allow' });
  assert.equal(afterPassword.status, 200, 'no redirect with a code yet');
  var html = await afterPassword.text();
  assert.match(html, /Enter your code/);
  var challenge = /name="challenge" value="([^"]+)"/.exec(html)[1];

  var wrong = await form({ request: request, challenge: challenge, code: '000000', decision: 'allow' });
  assert.match(await wrong.text(), /code is not right/);
  var done = await form({ request: request, challenge: challenge, code: totp.codeAt(secret, totp.currentStep() + 1), decision: 'allow' });
  assert.equal(done.status, 302);
  assert.ok(new URL(done.headers.get('location')).searchParams.get('code'));
  await pool.query("DELETE FROM mcp_oauth_clients WHERE info->>'client_name' = 'Z9MCP 2FA'");
});
