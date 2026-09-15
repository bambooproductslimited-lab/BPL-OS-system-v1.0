/*
 * Authorization regression test.
 *
 * Every other test in this suite checks that the right people CAN do
 * things. This one checks that everyone else CANNOT, across the whole API
 * surface rather than the handful of endpoints someone thought to cover:
 * before this file there were 57 assertions mentioning 403 spread over 22
 * test files, against 374 routes.
 *
 * It enumerates routes from the live Express router rather than a
 * hand-maintained list, so a route added tomorrow is tested tomorrow
 * without anyone remembering to add it here. A new route that answers a
 * caller holding no permissions at all fails this test until it is either
 * gated or added to ALLOWED below with a reason — which is the point. The
 * allowlist is the artifact worth reviewing: it is the complete, explicit
 * set of things any signed-in employee may reach.
 *
 * Known blind spot: a route registered after a same-prefix parameter route
 * (a new '/summary' added below an existing '/:id') never matches, so this
 * test sees the parameter route's 404 and files it under indeterminate.
 * That is not a security gap — the route is equally unreachable to an
 * attacker — but do not read a pass as proof that such a route is gated.
 *
 * Run with: npm test
 * Needs: npm run migrate && npm run seed  (see smoke.test.js)
 *
 * Verified to fail when it should: adding an ungated route ahead of
 * '/:id' in tasks.routes.js made test 1 fail and name both the route and
 * the rows it returned.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var bcrypt = require('bcrypt');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var aiService = require('../src/services/ai.service');
var { buildContext } = require('../src/services/context.service');

// ---------------------------------------------------------------------------
// Safety. This test sends POST/PATCH/DELETE to all 374 routes. If the RBAC
// is intact none of them do anything — every write is refused, which is the
// assertion. But a genuine hole means a genuine write, so it must never be
// aimed at a database anyone cares about. Refuse anything that isn't
// obviously local.
// ---------------------------------------------------------------------------
function databaseLooksLocal() {
  if (process.env.PGSSLMODE === 'require') return false; // managed/hosted
  var url = process.env.DATABASE_URL;
  if (!url) return (process.env.PGHOST || 'localhost') === 'localhost';
  return /@(localhost|127\.0\.0\.1)[:/]/.test(url);
}

var EMAIL = 'authz.nobody@bplghana.com';
var PASSWORD = 'AuthzNobody!12345';

// ---------------------------------------------------------------------------
// Routes reachable without holding any permission. Every entry needs a
// reason, and the reasons are the review: if one of these ever stops being
// true, this list is where it shows.
// ---------------------------------------------------------------------------
var ALLOWED = {
  // --- genuinely public: no session at all ---
  'GET /api/health': 'liveness probe, no data',
  'POST /api/auth/login': 'the front door; rate-limited + per-account lockout',
  'GET /api/roles/permissions': 'static permission catalogue, not per-user data',
  'GET /api/menu-photos/:id': 'a plain <img src> cannot send a bearer token; POS and app both render it',
  'GET /api/share/:token': 'customer-facing document link; the unguessable token is the credential',
  'POST /api/kiosk/identify': 'unattended clock-in iPad; PIN-gated and IP rate-limited',
  'POST /api/kiosk/clock': 'unattended clock-in iPad; PIN-gated and IP rate-limited',
  'GET /api/kiosk/face-enroll/:token': 'self-enrolment link; token is the credential',
  'POST /api/kiosk/face-enroll/:token': 'self-enrolment link; token is the credential',
  'POST /api/kiosk/face-enroll/:token/verify-pin': 'self-enrolment link; token + PIN',
  'POST /api/pos/login': 'restaurant till; PIN-gated, shares the kiosk rate-limit counter',
  'GET /api/marketing/whatsapp/webhook': 'Meta subscription handshake; verify_token checked',
  'POST /api/marketing/whatsapp/webhook': 'Meta delivery; HMAC-verified, fails closed without the secret',
  'GET /api/marketing/oauth/tiktok/callback': 'provider redirect, cannot carry a bearer token; state-gated',
  'GET /api/marketing/oauth/meta/callback': 'provider redirect, cannot carry a bearer token; state-gated',
  'GET /api/marketing/oauth/youtube/callback': 'provider redirect, cannot carry a bearer token; state-gated',
  'GET /api/marketing/oauth/twitch/callback': 'provider redirect, cannot carry a bearer token; state-gated',

  // --- self-service: any signed-in employee, own data only ---
  'POST /api/auth/logout': 'ends own session',
  'GET /api/me/': 'own profile',
  'GET /api/me/summary': 'own summary',
  'POST /api/me/password': 'changes own password; requires the current one',
  'GET /api/notifications/': 'own notifications',
  'POST /api/notifications/read': 'marks own notifications read',
  'GET /api/leave/': 'own leave requests — scoped, asserted below',
  'GET /api/leave/types': 'leave-type catalogue, needed to file a request',
  'GET /api/attendance/': 'own attendance row — scoped, asserted below',
  'GET /api/dashboard/': 'own KPI tiles — scoped, asserted below',
  'GET /api/tasks/': 'own tasks — scoped, asserted below',
  'GET /api/announcements/': 'company noticeboard; audience_scope decides who sees what',
  'GET /api/procurement/': 'own requests — scoped, asserted below',
  'GET /api/expenses/': 'own claims — scoped, asserted below',
  'GET /api/messages/': 'own conversations',
  'GET /api/messages/unread-count': 'own unread count',
  'GET /api/messages/directory': 'staff directory: colleagues to message. Names and job titles only',
  'GET /api/messages/:peerId': 'own conversation with one colleague',
  'POST /api/messages/:peerId': 'internal messaging — staff may message each other by design',
  'POST /api/ai/chat': 'assistant; its snapshot is permission-scoped, asserted below'
};

// ---------------------------------------------------------------------------
// Route enumeration, straight from the mounted Express router.
// ---------------------------------------------------------------------------
function allRoutes() {
  var found = [];
  function prefixOf(layer) {
    var m = /^\^\\\/(.*?)\\\/\?\(\?=/.exec(layer.regexp.source);
    return m ? '/' + m[1].replace(/\\\//g, '/').replace(/\\\./g, '.') : '';
  }
  (function walk(stack, prefix) {
    stack.forEach(function (layer) {
      if (layer.route) {
        Object.keys(layer.route.methods).forEach(function (m) {
          if (layer.route.methods[m]) found.push({ method: m.toUpperCase(), path: prefix + layer.route.path });
        });
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix + prefixOf(layer));
      }
    });
  })(app._router.stack, '');
  return found;
}

var server, base, token, nobody, fixtures = {};

test.before(async function () {
  assert.ok(databaseLooksLocal(),
    'Refusing to run: this test writes to every route and must only target a local test database. ' +
    'Point DATABASE_URL at localhost (and unset PGSSLMODE) before running it.');

  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  await pool.query('DELETE FROM employees WHERE email = $1', [EMAIL]);
  await pool.query("DELETE FROM roles WHERE key = 'authz_test_nobody'");

  // A role that grants nothing. Not "an employee" — an account with an
  // empty permission set, so any 2xx is the route's own doing.
  var role = await pool.query(
    "INSERT INTO roles (key, name, description) VALUES " +
    "('authz_test_nobody', 'Authorization test', 'Holds no permissions. Created and dropped by authorization.test.js.') " +
    'RETURNING id');
  var dept = await pool.query('SELECT id FROM departments LIMIT 1');
  var emp = await pool.query(
    'INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type) ' +
    "VALUES ('AUTHZ-T', 'Authz', 'Nobody', $1, $2, current_date, 'active', 'permanent') RETURNING id",
    [EMAIL, dept.rows[0].id]);
  var user = await pool.query(
    'INSERT INTO users (employee_id, email, password_hash, status, must_change_password) ' +
    "VALUES ($1, $2, $3, 'active', false) RETURNING id",
    [emp.rows[0].id, EMAIL, await bcrypt.hash(PASSWORD, 10)]);
  await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [user.rows[0].id, role.rows[0].id]);
  nobody = { userId: user.rows[0].id, employeeId: emp.rows[0].id };

  server = app.listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  base = 'http://127.0.0.1:' + server.address().port;

  var login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });
  var body = await login.json();
  assert.ok(body.token, 'the zero-permission account must still be able to sign in');
  token = body.token;

  var pick = async function (sql) { return (await pool.query(sql)).rows[0]; };
  fixtures.peer = await pick("SELECT id FROM employees WHERE email <> '" + EMAIL + "' LIMIT 1");
  fixtures.task = await pick('SELECT id FROM tasks LIMIT 1');
  fixtures.expense = await pick('SELECT id FROM expenses LIMIT 1');
  fixtures.leave = await pick('SELECT id FROM leave_requests LIMIT 1');
});

test.after(async function () {
  if (server) server.close();
  await pool.query('DELETE FROM messages WHERE from_id = $1 OR to_id = $1', [nobody.employeeId]);
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  await pool.query('DELETE FROM employees WHERE email = $1', [EMAIL]);
  await pool.query("DELETE FROM roles WHERE key = 'authz_test_nobody'");
  await pool.end();
});

async function callAs(method, path, body) {
  var opts = { method: method, headers: { Authorization: 'Bearer ' + token }, redirect: 'manual' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  var res = await fetch(base + path, opts);
  // Full body, not a truncated one: some assertions below parse it. Callers
  // building a failure message trim it themselves.
  return { status: res.status, text: await res.text() };
}

function brief(text) { return text.replace(/\s+/g, ' ').slice(0, 120); }

// ---------------------------------------------------------------------------

test('no route answers a caller holding zero permissions, unless allowlisted', async function () {
  var routes = allRoutes();
  assert.ok(routes.length > 300, 'route enumeration returned only ' + routes.length + ' routes — the walker is broken');

  var unguarded = [], indeterminate = [], guarded = 0;

  for (var i = 0; i < routes.length; i++) {
    var r = routes[i];
    var key = r.method + ' ' + r.path;
    if (ALLOWED[key]) continue;

    var probe = r.path.replace(/:[A-Za-z0-9_]+/g, crypto.randomUUID());
    var res = await callAs(r.method, probe, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});

    if (res.status === 401 || res.status === 403) guarded++;
    else if (res.status >= 200 && res.status < 300) unguarded.push(key + '  -> ' + res.status + ' ' + brief(res.text));
    else indeterminate.push(key + '  -> ' + res.status);
  }

  // Not a failure: a route that validates its input, or looks the resource
  // up, before reaching its permission check answers 400/404 to a probe
  // built from a random UUID, and the check is never exercised. The named
  // cases below cover the ones that matter with real ids; this number is
  // here so it stays visible rather than being mistaken for coverage.
  console.log('    ' + guarded + ' guarded, ' + Object.keys(ALLOWED).length + ' allowlisted, ' +
              indeterminate.length + ' indeterminate (validation ran first), of ' + routes.length + ' routes');

  assert.deepEqual(unguarded, [],
    'These routes answered a caller with no permissions at all. Gate them, or add them to ALLOWED with a reason:\n  ' +
    unguarded.join('\n  '));
});

test('the allowlist has no stale entries', function () {
  var live = {};
  allRoutes().forEach(function (r) { live[r.method + ' ' + r.path] = true; });
  var stale = Object.keys(ALLOWED).filter(function (k) { return !live[k]; });
  assert.deepEqual(stale, [],
    'ALLOWED names routes that no longer exist — remove them so the list keeps meaning something:\n  ' + stale.join('\n  '));
});

test('a real id belonging to someone else is still refused', async function () {
  // The sweep above probes with random UUIDs, so a route that looks its
  // subject up before checking permission answers 404 and proves nothing.
  // These use real ids owned by other people — the case that would
  // actually leak.
  var cases = [
    ['GET', '/api/employees/' + fixtures.peer.id],
    ['PATCH', '/api/employees/' + fixtures.peer.id, { firstName: 'Hacked' }],
    ['POST', '/api/shares', { documentType: 'invoice', documentId: fixtures.peer.id }]
  ];
  if (fixtures.task) cases.push(
    ['GET', '/api/tasks/' + fixtures.task.id],
    ['POST', '/api/tasks/' + fixtures.task.id + '/status', { status: 'completed' }],
    ['POST', '/api/tasks/' + fixtures.task.id + '/comments', { body: 'written by a user with no permissions' }]);
  if (fixtures.expense) cases.push(
    ['PATCH', '/api/expenses/' + fixtures.expense.id, { amount: 1 }],
    ['DELETE', '/api/expenses/' + fixtures.expense.id]);
  if (fixtures.leave) cases.push(['POST', '/api/leave/' + fixtures.leave.id + '/cancel']);

  var allowed = [];
  for (var i = 0; i < cases.length; i++) {
    var res = await callAs(cases[i][0], cases[i][1], cases[i][2]);
    if (res.status !== 401 && res.status !== 403) {
      allowed.push(cases[i][0] + ' ' + cases[i][1] + ' -> ' + res.status + ' ' + brief(res.text));
    }
  }
  assert.deepEqual(allowed, [], 'Reached another person\'s record without permission:\n  ' + allowed.join('\n  '));
});

test('list endpoints any employee may call return only their own rows', async function () {
  // These are allowlisted above on the grounds that they self-scope. That
  // claim is worth an assertion: an empty list proves nothing when the
  // table is empty, so plant a row owned by someone else and look for it.
  var owner = fixtures.peer.id;
  var planted = [];
  var mark = 'AUTHZ-SCOPE-' + crypto.randomUUID().slice(0, 8);

  var t = await pool.query(
    "INSERT INTO tasks (title, created_by, status) VALUES ($1, $2, 'not_started') RETURNING id", [mark + ' task', owner]);
  planted.push(['tasks', t.rows[0].id]);
  var e = await pool.query(
    "INSERT INTO expenses (requester_id, category, amount, date, description, status) " +
    "VALUES ($1, 'travel', 4242.42, current_date, $2, 'pending') RETURNING id", [owner, mark + ' expense']);
  planted.push(['expenses', e.rows[0].id]);
  var p = await pool.query(
    "INSERT INTO procurement_requests (requester_id, item, quantity, status) VALUES ($1, $2, 1, 'pending') RETURNING id",
    [owner, mark + ' procurement']);
  planted.push(['procurement_requests', p.rows[0].id]);

  try {
    var leaks = [];
    for (var path of ['/api/tasks/', '/api/expenses/', '/api/procurement/', '/api/leave/', '/api/messages/']) {
      var res = await callAs('GET', path);
      if (res.text.indexOf(mark) >= 0) leaks.push(path + ' returned another employee\'s row');
    }
    // attendance and dashboard report on a population rather than a list
    var att = JSON.parse((await callAs('GET', '/api/attendance/')).text);
    if (att.scopeSize !== 1) leaks.push('/api/attendance/ scopeSize=' + att.scopeSize + ', expected 1 (self only)');
    var dash = JSON.parse((await callAs('GET', '/api/dashboard/')).text);
    if (dash.headcount !== 1) leaks.push('/api/dashboard/ headcount=' + dash.headcount + ', expected 1 (self only)');

    assert.deepEqual(leaks, [], 'Self-scoped endpoints leaked another employee\'s data:\n  ' + leaks.join('\n  '));
  } finally {
    for (var row of planted) await pool.query('DELETE FROM ' + row[0] + ' WHERE id = $1', [row[1]]);
  }
});

test('the AI assistant snapshot is permission-scoped', async function () {
  // POST /api/ai/chat is reachable by any signed-in employee by design, so
  // what protects payroll and revenue figures is the snapshot it builds,
  // not the route. That scoping had never actually been executed — there
  // is no ANTHROPIC_API_KEY in test, so the endpoint returns its
  // "not configured" message and the snapshot was never reached. Call the
  // builder directly instead, which needs no key.
  var ctx = await buildContext(nobody.userId);
  assert.equal(ctx.permissions.length, 0, 'fixture drifted: the test account should hold no permissions');

  var snapshot = await aiService.buildContext(ctx);

  assert.equal(snapshot.lowStockProducts, null, 'inventory detail leaked without inventory.read');
  assert.equal(snapshot.myApprovalQueue, null, 'approval queue leaked without approval.act');
  assert.equal(snapshot.revenueThisMonth, null, 'revenue leaked without report.read');
  assert.equal(snapshot.revenueThisYear, null, 'revenue leaked without report.read');
  assert.equal(snapshot.outstandingBalance, null, 'outstanding balance leaked without report.read');
  assert.equal(snapshot.headcount, 1, 'headcount should count only the caller, not the company');
});
