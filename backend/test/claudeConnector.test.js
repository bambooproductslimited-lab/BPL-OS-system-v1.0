/*
 * The Claude connector (src/mcp/): claude.ai signing a person in with OAuth,
 * then calling the OS's tools over MCP as that person.
 *
 * Walks the same steps claude.ai takes — discover, register, send the person
 * to the sign-in page, trade the code for tokens with PKCE — then talks MCP
 * with the official MCP client.
 *
 * Test data uses the Z9MCP prefix and is removed afterwards.
 * Requires `npm run migrate && npm run seed` first (the pretest hook).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var authService = require('../src/services/auth.service');
var { buildContext } = require('../src/services/context.service');
var { Client } = require('@modelcontextprotocol/sdk/client/index.js');
var { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

var server, base;
var CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
var KELVIN = 'kelvin.duho@bplghana.com'; // administrator
var ALICE = 'alice.kamau@bplghana.com';  // employee

async function cleanup() {
  await pool.query("DELETE FROM ai_actions WHERE summary LIKE '%Z9MCP%'");
  await pool.query("DELETE FROM tasks WHERE title LIKE 'Z9MCP%'");
  await pool.query("DELETE FROM mcp_oauth_clients WHERE info->>'client_name' LIKE 'Z9MCP%'");
}

test.before(async function () {
  await cleanup();
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
});
test.after(async function () { server.close(); await cleanup(); await pool.end(); });

function pkce() {
  var verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier: verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function register() {
  var res = await fetch(base + '/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Z9MCP Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })
  });
  assert.equal(res.status, 201);
  return res.json();
}

// Opens the sign-in page as claude.ai would send the person there.
async function openSignIn(client, challenge, state) {
  var url = base + '/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK,
    code_challenge: challenge, code_challenge_method: 'S256', state: state
  });
  var res = await fetch(url, { redirect: 'manual' });
  var html = await res.text();
  var m = /name="request" value="([^"]+)"/.exec(html);
  return { res: res, html: html, request: m && m[1] };
}

async function submit(request, email, password, decision) {
  return fetch(base + '/oauth/login', {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: request, email: email, password: password, decision: decision || 'allow' })
  });
}

async function exchange(client, code, verifier) {
  return fetch(base + '/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: code, code_verifier: verifier, redirect_uri: CALLBACK })
  });
}

// The whole sign-in, start to tokens.
async function connectAs(email) {
  var client = await register();
  var p = pkce();
  var signIn = await openSignIn(client, p.challenge, 'st');
  var back = await submit(signIn.request, email, 'bamboo123');
  var code = new URL(back.headers.get('location')).searchParams.get('code');
  var tokens = await (await exchange(client, code, p.verifier)).json();
  return { client: client, tokens: tokens };
}

async function mcpClient(accessToken) {
  var c = new Client({ name: 'z9mcp-test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + accessToken } } }));
  return c;
}

test('claude.ai can discover how to sign in', async function () {
  var unauth = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);

  var resource = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.match(resource.resource, /\/mcp$/);
  var as = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.match(as.registration_endpoint, /\/register$/);
});

test('sign-in: the page, a wrong password, Cancel, and a tampered request', async function () {
  var client = await register();
  var p = pkce();
  var signIn = await openSignIn(client, p.challenge, 'state-1');
  assert.equal(signIn.res.status, 200);
  assert.match(signIn.html, /<strong>Z9MCP Claude<\/strong> wants to use Bamboo OS as you/);
  var csp = signIn.res.headers.get('content-security-policy');
  assert.match(csp, /form-action 'self' https:\/\/claude\.ai;/, 'the form may only go to the OS and on to Claude');
  assert.match(csp, /frame-ancestors 'none'/);

  var wrong = await submit(signIn.request, ALICE, 'not-her-password');
  assert.equal(wrong.status, 200);
  assert.match(await wrong.text(), /Incorrect email or password/);
  await pool.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE email = $1', [ALICE]);

  var cancelled = await submit(signIn.request, '', '', 'deny');
  assert.equal(cancelled.status, 302);
  var loc = new URL(cancelled.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, CALLBACK);
  assert.equal(loc.searchParams.get('error'), 'access_denied');
  assert.equal(loc.searchParams.get('state'), 'state-1');
  assert.equal(loc.searchParams.get('code'), null);

  // Someone editing the signed request (e.g. to send the code elsewhere).
  var parts = signIn.request.split('.');
  var body = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  body.r = 'https://attacker.example/steal';
  var forged = [parts[0], Buffer.from(JSON.stringify(body)).toString('base64url'), parts[2]].join('.');
  var bad = await submit(forged, ALICE, 'bamboo123');
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /This sign-in has expired/);

  // An address the client never registered is refused before any page.
  var other = await fetch(base + '/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: 'https://attacker.example/cb',
    code_challenge: p.challenge, code_challenge_method: 'S256'
  }), { redirect: 'manual' });
  assert.equal(other.status, 400);
});

test('the code works once, only with the right PKCE verifier', async function () {
  var client = await register();
  var p = pkce();
  var signIn = await openSignIn(client, p.challenge, 'state-2');
  var back = await submit(signIn.request, ALICE, 'bamboo123');
  assert.equal(back.status, 302);
  var loc = new URL(back.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 'state-2');
  var code = loc.searchParams.get('code');
  assert.ok(code);

  var wrongVerifier = await exchange(client, code, pkce().verifier);
  assert.equal(wrongVerifier.status, 400);
  assert.equal((await wrongVerifier.json()).error, 'invalid_grant');

  var ok = await exchange(client, code, p.verifier);
  assert.equal(ok.status, 200);
  var tokens = await ok.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal(tokens.expires_in, 3600);

  var again = await exchange(client, code, p.verifier);
  assert.equal(again.status, 400, 'a code is single-use');

  var stored = await pool.query('SELECT token_hash FROM mcp_oauth_tokens WHERE token_hash = $1 OR token_hash = $2', [tokens.access_token, tokens.refresh_token]);
  assert.equal(stored.rows.length, 0, 'tokens are stored only as hashes');
});

test('over MCP, Claude gets the tools and data of the person who signed in — nothing more', async function () {
  var alice = await connectAs(ALICE);
  var c = await mcpClient(alice.tokens.access_token);
  try {
    var listed = (await c.listTools()).tools;
    var names = listed.map(function (t) { return t.name; });
    assert.ok(names.indexOf('request_leave') >= 0 && names.indexOf('get_attendance') >= 0);
    ['create_task', 'search_products', 'list_invoices', 'update_product_stock'].forEach(function (n) {
      assert.ok(names.indexOf(n) < 0, n + ' listed for an employee without the permission');
    });
    var att = listed.find(function (t) { return t.name === 'get_attendance'; });
    assert.equal(att.annotations.readOnlyHint, true);
    var leave = listed.find(function (t) { return t.name === 'request_leave'; });
    assert.equal(leave.annotations.readOnlyHint, false);

    var res = await c.callTool({ name: 'get_attendance', arguments: {} });
    var data = JSON.parse(res.content[0].text);
    var me = await buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [ALICE])).rows[0].id);
    assert.ok(data.items.every(function (r) { return r.code === me.employee.code; }), 'only her own attendance');

    var refused = await c.callTool({ name: 'search_products', arguments: {} });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /not available/);
  } finally {
    await c.close();
  }
});

test('a change made through the connector happens at once and is recorded', async function () {
  var kelvin = await connectAs(KELVIN);
  var c = await mcpClient(kelvin.tokens.access_token);
  try {
    var res = await c.callTool({ name: 'create_task', arguments: { title: 'Z9MCP restack the slats', due_date: '2026-10-02' } });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /Task created/);
    var tasks = await pool.query("SELECT count(*)::int AS n FROM tasks WHERE title = 'Z9MCP restack the slats'");
    assert.equal(tasks.rows[0].n, 1);
    var rec = (await pool.query("SELECT status, source FROM ai_actions WHERE summary LIKE '%Z9MCP restack%'")).rows;
    assert.deepEqual(rec, [{ status: 'done', source: 'connector' }]);

    var bad = await c.callTool({ name: 'create_task', arguments: { title: 'Z9MCP x', assignees: ['Nobody Z9MCP'] } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /No employee matches/);
  } finally {
    await c.close();
  }
});

test('refresh tokens rotate; a new password or a disabled account ends the connection', async function () {
  var alice = await connectAs(ALICE);
  var refresh = function (token) {
    return fetch(base + '/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: alice.client.client_id, refresh_token: token })
    });
  };
  var first = await refresh(alice.tokens.refresh_token);
  assert.equal(first.status, 200);
  var next = await first.json();
  assert.equal((await refresh(alice.tokens.refresh_token)).status, 400, 'a used refresh token is dead');

  var call = function (token) {
    return fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'z9', version: '1' } } })
    });
  };
  assert.equal((await call(next.access_token)).status, 200);

  var userId = (await pool.query('SELECT id FROM users WHERE email = $1', [ALICE])).rows[0].id;
  try {
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [userId]);
    assert.equal((await call(next.access_token)).status, 401, 'disabled account');
  } finally {
    await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [userId]);
  }
  assert.equal((await call(next.access_token)).status, 200);

  // Changing the password (here to the same one, to leave the seed as it was).
  await authService.changeOwnPassword(await buildContext(userId), 'bamboo123', 'bamboo123');
  assert.equal((await call(next.access_token)).status, 401, 'a new password disconnects Claude');
  assert.equal((await refresh(next.refresh_token)).status, 400);
});
