/*
 * Text messages through mNotify (sms.service.js) and two-step sign-in codes
 * by text (twoStep.service.js), against a stand-in for mNotify's API on
 * localhost — nothing leaves the machine and no credit is spent.
 *
 * Checks what goes to mNotify (endpoint, key, sender, number format), that
 * every text is logged and sign-in codes are logged masked, that mNotify's
 * refusals come back in plain words without the API key, the Company
 * settings screen's permissions, and the sign-in flow with a texted code.
 *
 * Uses the seeded account christine.adhiambo (Employee; no other test signs
 * in as her, since test files run side by side) and leaves two-step off for
 * her. kelvin.duho (System Administrator) only signs in.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');
var crypto = require('crypto');
var app = require('../src/app');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var totp = require('../src/lib/totp');

var server, base, fake, fakeBase;
var EMAIL = 'christine.adhiambo@bplghana.com';
var ADMIN = 'kelvin.duho@bplghana.com';
var saved = {};

// What the stand-in mNotify received, and what it should answer next.
var received = [];
var nextAnswer = null;
var balanceAnswer = { status: 'success', balance: 1486, bonus: 12 };

async function call(method, path, body, token) {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  var res = await fetch(base + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
  var text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
function login(email) { return call('POST', '/api/auth/login', { email: email, password: 'bamboo123' }); }
async function tokenOf(email) { return (await login(email)).body.token; }
function lastText() { return received.filter(function (r) { return r.path === '/api/sms/quick'; }).slice(-1)[0]; }
function codeIn(message) { return (/(\d{6})/.exec(message) || [])[1]; }

async function reset() {
  await pool.query(
    'UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, ' +
    'two_step_phone = NULL, sms_two_step_at = NULL, failed_login_attempts = 0, locked_until = NULL WHERE email = $1', [EMAIL]);
  await pool.query('DELETE FROM user_backup_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)', [EMAIL]);
  await pool.query('DELETE FROM two_step_sms_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)', [EMAIL]);
  await pool.query("DELETE FROM sms_messages WHERE purpose IN ('test', 'two_step')");
}
// The per-account limits count texts in the last half hour; tests that send
// several age the earlier ones instead of waiting.
async function ageCodes() {
  await pool.query("UPDATE two_step_sms_codes SET created_at = created_at - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE email = $1)", [EMAIL]);
}

test.before(async function () {
  saved = { apiKey: config.sms.apiKey, senderId: config.sms.senderId, baseUrl: config.sms.baseUrl };
  fake = http.createServer(function (req, res) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var url = new URL(req.url, 'http://x');
      var body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      received.push({ method: req.method, path: url.pathname, key: url.searchParams.get('key'), body: body });
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/balance/sms') return res.end(JSON.stringify(balanceAnswer));
      var answer = nextAnswer || {
        status: 'success', code: '2000', message: 'messages sent successfully',
        summary: { _id: 'camp-' + received.length, type: 'API QUICK SMS', total_sent: 1, contacts: 1, total_rejected: 0, numbers_sent: body.recipient, credit_used: 1, credit_left: 1485 }
      };
      nextAnswer = null;
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise(function (done) { fake.listen(0, done); });
  fakeBase = 'http://127.0.0.1:' + fake.address().port;
  config.sms.apiKey = 'test-key-123';
  config.sms.senderId = 'BambooOS';
  config.sms.baseUrl = fakeBase;
  await reset();
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
});
test.after(async function () {
  await reset();
  Object.assign(config.sms, saved);
  server.close();
  fake.close();
  await pool.end();
});

test('Company settings → Text messages: only settings.manage; shows the credit balance', async function () {
  var staff = await tokenOf(EMAIL);
  assert.equal((await call('GET', '/api/sms', null, staff)).status, 403);
  assert.equal((await call('POST', '/api/sms/test', { phone: '0244123456' }, staff)).status, 403);
  assert.equal((await call('PATCH', '/api/sms/settings', { autoPaymentReminders: true }, staff)).status, 403);

  var admin = await tokenOf(ADMIN);
  var s = (await call('GET', '/api/sms', null, admin)).body;
  assert.equal(s.configured, true);
  assert.equal(s.senderId, 'BambooOS');
  assert.deepEqual(s.balance, { balance: 1486, bonus: 12 });
  assert.deepEqual(s.settings, { autoPaymentReminders: false, autoBookingNotices: false, staffAlertsBySms: false }, 'automatic texts start off');
  var bal = received.filter(function (r) { return r.path === '/api/balance/sms'; }).pop();
  assert.equal(bal.key, 'test-key-123');

  var saved2 = (await call('PATCH', '/api/sms/settings', { autoPaymentReminders: true, junk: true }, admin)).body;
  assert.deepEqual(saved2.settings, { autoPaymentReminders: true, autoBookingNotices: false, staffAlertsBySms: false });
  await call('PATCH', '/api/sms/settings', { autoPaymentReminders: false }, admin);
});

test('a test text: right endpoint, key, sender and number; logged', async function () {
  var admin = await tokenOf(ADMIN);
  var r = await call('POST', '/api/sms/test', { phone: '+233 24 412 3456' }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.to, '0244123456');
  assert.equal(r.body.creditLeft, 1485);
  var sent = lastText();
  assert.equal(sent.method, 'POST');
  assert.equal(sent.key, 'test-key-123');
  assert.deepEqual(sent.body.recipient, ['0244123456'], 'Ghana numbers in the local form mNotify uses');
  assert.equal(sent.body.sender, 'BambooOS');
  assert.equal(sent.body.is_schedule, false);
  assert.match(sent.body.message, /Bamboo OS/);

  var log = (await pool.query("SELECT * FROM sms_messages WHERE purpose = 'test'")).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'sent');
  assert.equal(log[0].provider_ref, 'camp-' + received.length);
  assert.equal(Number(log[0].credits_used), 1);

  var status = (await call('GET', '/api/sms', null, admin)).body;
  assert.ok(status.thisMonth.sent >= 1);
  assert.ok(status.recent.some(function (m) { return m.purpose === 'test' && m.to === '0244123456'; }));

  assert.equal((await call('POST', '/api/sms/test', { phone: '12' }, admin)).status, 400, 'not a phone number');
});

test('mNotify refusing: plain words, logged as failed, and the API key never in the message', async function () {
  var admin = await tokenOf(ADMIN);
  nextAnswer = { status: 'error', code: '1003', message: 'Insufficient balance' };
  var r = await call('POST', '/api/sms/test', { phone: '0244123456' }, admin);
  assert.equal(r.status, 502);
  assert.match(r.body.error.message, /Not enough SMS credit/);
  assert.ok(JSON.stringify(r.body).indexOf('test-key-123') < 0);

  nextAnswer = { status: 'error', code: '1006', message: 'Invalid Sender ID' };
  r = await call('POST', '/api/sms/test', { phone: '0244123456' }, admin);
  assert.match(r.body.error.message, /sender ID "BambooOS"/);

  var failed = (await pool.query("SELECT count(*)::int AS n FROM sms_messages WHERE status = 'failed' AND purpose = 'test'")).rows[0].n;
  assert.equal(failed, 2);
});

test('not set up: nothing is sent, and the screen says what to do', async function () {
  var admin = await tokenOf(ADMIN);
  var key = config.sms.apiKey;
  config.sms.apiKey = '';
  try {
    var s = (await call('GET', '/api/sms', null, admin)).body;
    assert.equal(s.configured, false);
    assert.equal(s.balance, null);
    var r = await call('POST', '/api/sms/test', { phone: '0244123456' }, admin);
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /MNOTIFY_API_KEY/);
    var t = await tokenOf(EMAIL);
    assert.equal((await call('GET', '/api/me/two-step', null, t)).body.smsAvailable, false);
    assert.equal((await call('POST', '/api/me/two-step/sms/setup', { phone: '0244123456' }, t)).status, 502);
  } finally {
    config.sms.apiKey = key;
  }
});

test('two-step by text: confirm the phone with a texted code, then signing in texts a code', async function () {
  var t = await tokenOf(EMAIL);
  var st = (await call('GET', '/api/me/two-step', null, t)).body;
  assert.equal(st.smsAvailable, true);

  var setup = await call('POST', '/api/me/two-step/sms/setup', { phone: '024 412 3456' }, t);
  assert.equal(setup.status, 200);
  assert.equal(setup.body.sentTo, '•••• 3456');
  var code = codeIn(lastText().body.message);
  assert.ok(code, 'the text has the code');
  var logged = (await pool.query("SELECT message FROM sms_messages WHERE purpose = 'two_step' AND to_phone = '0244123456' ORDER BY created_at DESC LIMIT 1")).rows[0].message;
  assert.ok(logged.indexOf(code) < 0 && /••••••/.test(logged), 'the log keeps the code masked');

  assert.equal((await call('POST', '/api/me/two-step/sms/setup', { phone: '0244123456' }, t)).status, 429, 'one a minute');
  assert.equal((await call('POST', '/api/me/two-step/sms/enable', { code: code === '000000' ? '111111' : '000000' }, t)).status, 400);
  var on = await call('POST', '/api/me/two-step/sms/enable', { code: code }, t);
  assert.equal(on.status, 200);
  assert.equal(on.body.backupCodes.length, 10, 'backup codes come with the first way turned on');
  st = (await call('GET', '/api/me/two-step', null, t)).body;
  assert.equal(st.sms.on, true);
  assert.equal(st.sms.phone, '•••• 3456');
  assert.equal(st.app.on, false);

  // Signing in: the password alone doesn't; the code is texted straight away.
  await ageCodes();
  var first = await login(EMAIL);
  assert.equal(first.body.token, undefined);
  assert.equal(first.body.twoStepRequired, true);
  assert.deepEqual(first.body.methods, ['sms']);
  assert.equal(first.body.smsTo, '•••• 3456');
  assert.equal(first.body.codeSent, true);
  var loginCode = codeIn(lastText().body.message);
  assert.deepEqual(lastText().body.recipient, ['0244123456']);
  var ok = await call('POST', '/api/auth/login/verify', { challenge: first.body.challenge, code: loginCode });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);

  // The same code doesn't sign in twice.
  await ageCodes();
  var again = await login(EMAIL);
  assert.equal((await call('POST', '/api/auth/login/verify', { challenge: again.body.challenge, code: loginCode })).status, 401);
  var fresh = codeIn(lastText().body.message);
  assert.equal((await call('POST', '/api/auth/login/verify', { challenge: again.body.challenge, code: fresh })).status, 200);
  await pool.query('UPDATE users SET failed_login_attempts = 0 WHERE email = $1', [EMAIL]);
});

test('a texted code stops working after five wrong guesses', async function () {
  await ageCodes();
  var first = await login(EMAIL);
  var code = codeIn(lastText().body.message);
  var wrong = code === '999999' ? '888888' : '999999';
  for (var i = 0; i < 5; i++) {
    await call('POST', '/api/auth/login/verify', { challenge: first.body.challenge, code: wrong });
    await pool.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE email = $1', [EMAIL]);
  }
  assert.equal((await call('POST', '/api/auth/login/verify', { challenge: first.body.challenge, code: code })).status, 401);
  await pool.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE email = $1', [EMAIL]);
});

test('both ways: add the app too; either code signs in; "text me a code" on request; backup codes kept', async function () {
  var t = (await (async function () {
    await ageCodes();
    var f = await login(EMAIL);
    return (await call('POST', '/api/auth/login/verify', { challenge: f.body.challenge, code: codeIn(lastText().body.message) })).body.token;
  }()));
  var setup = (await call('POST', '/api/me/two-step/setup', {}, t)).body;
  var on = await call('POST', '/api/me/two-step/enable', { code: totp.codeAt(setup.secret, totp.currentStep()) }, t);
  assert.equal(on.status, 200);
  assert.equal(on.body.backupCodes, null, 'the backup codes they already have still work');
  var st = (await call('GET', '/api/me/two-step', null, t)).body;
  assert.equal(st.app.on && st.sms.on, true);

  // With the app available, nothing is texted until asked for.
  await ageCodes();
  var textsBefore = received.length;
  var first = await login(EMAIL);
  assert.deepEqual(first.body.methods, ['app', 'sms']);
  assert.equal(first.body.codeSent, false);
  assert.equal(received.length, textsBefore);
  var sent = await call('POST', '/api/auth/login/send-code', { challenge: first.body.challenge });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.sentTo, '•••• 3456');
  assert.equal((await call('POST', '/api/auth/login/send-code', { challenge: first.body.challenge })).status, 429, 'one a minute');
  assert.equal((await call('POST', '/api/auth/login/verify', { challenge: first.body.challenge, code: codeIn(lastText().body.message) })).status, 200);
  assert.equal((await call('POST', '/api/auth/login/send-code', { challenge: 'forged' })).status, 401);

  // Turning off only the text keeps two-step on with the app.
  assert.equal((await call('POST', '/api/me/two-step/disable', { password: 'bamboo123', method: 'sms' }, t)).body.enabled, true);
  st = (await call('GET', '/api/me/two-step', null, t)).body;
  assert.equal(st.sms.on, false);
  assert.equal(st.app.on, true);
  assert.equal(st.backupCodesLeft, 10);
  assert.equal((await call('POST', '/api/auth/login/send-code', { challenge: (await login(EMAIL)).body.challenge })).status, 400);

  // …and turning off the last way turns it all off.
  assert.equal((await call('POST', '/api/me/two-step/disable', { password: 'bamboo123', method: 'app' }, t)).body.enabled, false);
  assert.ok((await login(EMAIL)).body.token, 'password alone again');
});

test('the Claude connector sign-in page texts the code and offers a new one', async function () {
  await reset();
  var t = await tokenOf(EMAIL);
  await call('POST', '/api/me/two-step/sms/setup', { phone: '0244123456' }, t);
  await call('POST', '/api/me/two-step/sms/enable', { code: codeIn(lastText().body.message) }, t);
  await ageCodes();

  var CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
  var client = await (await fetch(base + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Z9MCP SMS', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }) })).json();
  var verifier = crypto.randomBytes(32).toString('base64url');
  var page = await (await fetch(base + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's' }))).text();
  var request = /name="request" value="([^"]+)"/.exec(page)[1];
  var form = function (fields) {
    return fetch(base + '/oauth/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  };
  var html = await (await form({ request: request, email: EMAIL, password: 'bamboo123', decision: 'allow' })).text();
  assert.match(html, /texted to|text message sent to/);
  assert.match(html, /Code sent to •••• 3456/);
  assert.match(html, /Send a new code/);
  var challenge = /name="challenge" value="([^"]+)"/.exec(html)[1];
  var first = codeIn(lastText().body.message);

  var resend = await (await form({ request: request, challenge: challenge, methods: 'sms', smsTo: '•••• 3456', decision: 'sms' })).text();
  assert.match(resend, /Wait a minute/, 'the one-a-minute limit applies here too');
  var done = await form({ request: request, challenge: challenge, code: first, decision: 'allow' });
  assert.equal(done.status, 302);
  assert.ok(new URL(done.headers.get('location')).searchParams.get('code'));
  await pool.query("DELETE FROM mcp_oauth_clients WHERE info->>'client_name' = 'Z9MCP SMS'");
  await reset();
});
