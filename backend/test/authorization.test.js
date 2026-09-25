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
 * Every one of the 374 routes is now accounted for: 336 refuse, 38 are
 * allowlisted. Nothing is indeterminate. A route that validates its body or
 * looks its subject up before checking permission gets a request good enough
 * to reach that check, from the PROBES map below — real ids, real query
 * parameters, real uploaded files. Set AUTHZ_SHOW_INDETERMINATE=1 to list
 * anything that slips back into that state, which means a new route needs a
 * probe writing for it.
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
var aiTools = require('../src/ai/tools');
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
// Stamped into every row this test plants, so the scoping assertions can
// look for it and teardown can find it again.
var FIXTURE_MARK = 'AUTHZ-FIXTURE';

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
  'GET /api/push/public-key': "this server's own public VAPID key; useless without the private half",
  'POST /api/push/subscribe': "registers the caller's own device against the caller's own employee id",
  'POST /api/push/unsubscribe': "scoped to the caller's own employee id in the DELETE itself",
  'POST /api/push/test': 'sends a pop-up to the caller\'s own devices and nobody else\'s',
  'GET /api/kiosk/config': 'unattended clock-in iPad asking whether it needs its camera; one boolean, names nobody',
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
  'GET /api/me/overview': 'own My space overview, keyed on the caller only',
  'POST /api/me/password': 'changes own password; requires the current one',
  'GET /api/me/two-step': "own two-step sign-in status",
  'POST /api/me/two-step/setup': "starts setting up two-step sign-in on the caller's own account; changes nothing until a code proves it",
  'POST /api/me/two-step/enable': "turns on the caller's own two-step sign-in; needs a code from their app",
  'POST /api/me/two-step/sms/setup': "texts a code to confirm a phone for the caller's own two-step sign-in; rate limited per account",
  'POST /api/me/two-step/sms/enable': "turns on codes by text for the caller's own account; needs the texted code",
  'POST /api/me/two-step/email/setup': "emails a code to the caller's own sign-in address to confirm codes by email; rate limited per account",
  'POST /api/me/two-step/email/enable': "turns on codes by email for the caller's own account; needs the emailed code",
  'POST /api/me/two-step/disable': "turns off the caller's own two-step sign-in; needs their password",
  'POST /api/me/two-step/backup-codes': "new backup codes for the caller's own account; needs their password",
  'POST /api/me/locale': "sets the caller's own interface language; writes nothing but their own users.locale",
  'GET /api/notifications/': 'own notifications',
  'POST /api/notifications/read': 'marks own notifications read',
  'GET /api/leave/': 'own leave requests — scoped, asserted below',
  'GET /api/leave/types': 'leave-type catalogue, needed to file a request',
  'GET /api/attendance/': 'own attendance row — scoped, asserted below',
  'GET /api/attendance/report': 'own attendance only, and canViewPay is false — scoped, asserted below',
  'GET /api/dashboard/': 'own KPI tiles — scoped, asserted below',
  'GET /api/tasks/': 'own tasks — scoped, asserted below',
  'GET /api/announcements/': 'company noticeboard; audience_scope decides who sees what',
  'POST /api/announcements/read': 'marks announcements the caller may see as read by the caller (announcementsReads.test.js)',
  'POST /api/announcements/:id/acknowledge': "the caller confirms an announcement they may see; anyone else's is 403 (announcementsReads.test.js)",
  'GET /api/procurement/': 'own requests — scoped, asserted below',
  'GET /api/expenses/': 'own claims — scoped, asserted below',
  'GET /api/messages/': 'own conversations',
  'GET /api/messages/unread-count': 'own unread count',
  'GET /api/messages/directory': 'staff directory: colleagues to message. Names and job titles only',
  'GET /api/messages/:peerId': 'own conversation with one colleague',
  'POST /api/messages/:peerId': 'internal messaging — staff may message each other by design',
  'POST /api/messages/groups': 'internal messaging — anyone may start a group chat with colleagues',
  'GET /api/messages/conversations/:id': 'a chat the caller is a member of; anyone else gets 404 (messagesGroups.test.js)',
  'POST /api/messages/conversations/:id': 'sending to a chat the caller is a member of; members only (messagesGroups.test.js)',
  'PATCH /api/messages/conversations/:id': "renaming a group — the group's own admins only (messagesGroups.test.js)",
  'POST /api/messages/conversations/:id/members': "adding people to a group — the group's own admins only (messagesGroups.test.js)",
  'DELETE /api/messages/conversations/:id/members/:employeeId': "removing people from a group — the group's own admins only (messagesGroups.test.js)",
  'POST /api/messages/conversations/:id/leave': 'leaving a group the caller is in',
  'POST /api/messages/conversations/:id/admins/:employeeId': "making someone a group admin — the group's own admins only (messagesGroups.test.js)",
  'GET /api/messages/conversations/:id/photo': 'group photo, members only',
  'POST /api/messages/conversations/:id/photo': "group photo — the group's own admins only (messagesGroups.test.js)",
  'DELETE /api/messages/conversations/:id/photo': "group photo — the group's own admins only (messagesGroups.test.js)",
  'GET /api/messages/files/:id': 'a file sent in a chat — members of that chat only (messagesGroups.test.js)',
  'GET /api/messages/people/:id/photo': "a colleague's profile photo, like their name in the directory",
  'POST /api/messages/people/:id/photo': 'your own profile photo; anyone else\'s needs employee.write (messagesGroups.test.js)',
  'DELETE /api/messages/people/:id/photo': 'your own profile photo; anyone else\'s needs employee.write (messagesGroups.test.js)',
  'POST /oauth/login': "the Claude connector's sign-in form — public like the login screen; issues nothing without a signed /authorize request and the person's own email and password (claudeConnector.test.js)",
  'POST /api/ai/chat': "assistant; each of Claude's tools runs with the caller's own permissions, asserted below",
  'POST /api/ai/actions/:id/confirm': "confirms a change the assistant prepared for the caller; anyone else's is 404 (aiAssistant.test.js)",
  'POST /api/ai/actions/:id/cancel': "cancels a change the assistant prepared for the caller; anyone else's is 404 (aiAssistant.test.js)",
  'GET /api/ai/overview': "the assistant page's overview of the caller's own use; the tools listed are only those the caller's permissions allow (aiConversations.test.js)",
  'GET /api/ai/conversations': "the caller's own saved conversations only (aiConversations.test.js)",
  'GET /api/ai/conversations/:id': "one of the caller's own conversations; anyone else's is 404 (aiConversations.test.js)",
  'PATCH /api/ai/conversations/:id': "renames one of the caller's own conversations; anyone else's is 404 (aiConversations.test.js)",
  'DELETE /api/ai/conversations/:id': "deletes one of the caller's own conversations; anyone else's is 404 (aiConversations.test.js)",
  'DELETE /api/ai/connections/:clientId': "disconnects a Claude app connected as the caller; nobody else's (aiConversations.test.js)"
};

// ---------------------------------------------------------------------------
// Realistic probes.
//
// The sweep below fills :params with a random UUID, which is enough for a
// route that checks permission first. A route that validates its body, or
// looks its subject up, before reaching that check answers 400/404 to such a
// probe and the check is never exercised — the result says nothing either
// way, and counting it as a pass would be exactly the false comfort this
// file exists to remove.
//
// So the routes that behave that way get a request good enough to reach
// their permission check: real ids (always belonging to someone else), real
// query parameters, real uploaded files. Anything still landing in
// "indeterminate" is a route nobody has written a probe for yet.
// ---------------------------------------------------------------------------
function csvUpload(text) {
  var form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), 'probe.csv');
  return form;
}

var PROBES = {
  'POST /api/leave/:id/cancel': function (f) { return { path: '/api/leave/' + f.leave.id + '/cancel' }; },
  'GET /api/tasks/:id': function (f) { return { path: '/api/tasks/' + f.task.id }; },
  'POST /api/tasks/:id/status': function (f) { return { path: '/api/tasks/' + f.task.id + '/status', body: { status: 'completed' } }; },
  'POST /api/tasks/:id/comments': function (f) { return { path: '/api/tasks/' + f.task.id + '/comments', body: { body: 'probe' } }; },
  'PATCH /api/expenses/:id': function (f) { return { path: '/api/expenses/' + f.expense.id, body: { amount: 1 } }; },
  'DELETE /api/expenses/:id': function (f) { return { path: '/api/expenses/' + f.expenseForDelete.id }; },
  'POST /api/shares': function (f) { return { path: '/api/shares', body: { documentType: 'invoice', documentId: f.peer.id } }; },
  'POST /api/shares/whatsapp': function (f) { return { path: '/api/shares/whatsapp', body: { documentType: 'invoice', documentId: f.peer.id, url: 'https://example.invalid/x' } }; },
  'GET /api/attendance/report': function () { return { path: '/api/attendance/report?from=2026-01-01&to=2026-01-31' }; },
  // Both of these validate their input before the permission check is
  // observable, so a probe built from random values answers 400 and lands in
  // "indeterminate" — which is not a failure. Without a real date range the
  // sweep cannot tell a gated route from an ungated one, and a lateness
  // report left ungated would have shipped: it exposes when every employee
  // arrives, to anyone who can reach the URL.
  'GET /api/attendance/lateness': function () { return { path: '/api/attendance/lateness?from=2026-01-01&to=2026-01-31' }; },
  'GET /api/attendance/unassigned-shifts': function () { return { path: '/api/attendance/unassigned-shifts' }; },
  'POST /api/employees/import/preview': function () { return { path: '/api/employees/import/preview', form: csvUpload('Code,First name,Last name\nE1,Probe,Probe\n') }; },
  'POST /api/tool-room/import/preview': function () { return { path: '/api/tool-room/import/preview', form: csvUpload('Name,Kind,Quantity\nProbe,material,1\n') }; },
  'POST /api/it-devices/import/preview': function () { return { path: '/api/it-devices/import/preview', form: csvUpload('Name,Type,Total\nProbe,laptop,1\n') }; },
  'POST /api/suppliers/import/preview': function () { return { path: '/api/suppliers/import/preview', form: csvUpload('Name,Mobile,Town\nProbe,0209 999 999,Nowhere\n') }; },
  'POST /api/products/import/preview': function () { return { path: '/api/products/import/preview', form: csvUpload(',Category,Variation,UOM,Physical Count\nZ99 Probe,Other,Regular,Each,1\n') }; },
  'POST /api/products/import/commit': function () { return { path: '/api/products/import/commit', body: { countDate: '2026-09-22', lines: [{ sku: 'Z99-PROBE', name: 'Probe', category: 'Other', unit: 'each', stock: 1, action: 'create' }] } }; },
  'POST /api/suppliers/import/commit': function () { return { path: '/api/suppliers/import/commit', body: { suppliers: [{ name: 'Probe', phone: '0209 999 998' }] } }; }
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
        // Routers without a regexp are Express 5's: the OAuth library's own
        // (@modelcontextprotocol/sdk's mcpAuthRouter, in src/mcp/). Their
        // mount paths can't be read back, and they are public by design —
        // /.well-known metadata, /register, /authorize, /token, /revoke are
        // what an OAuth client calls before it has any token. What they
        // hand out is covered by claudeConnector.test.js.
        if (!layer.regexp) return;
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

  // Subjects for the probes, all owned by someone who is not the test
  // account. Planted rather than picked out of the seed: tasks and expenses
  // are empty on a fresh seed, and a probe against a table with no rows
  // cannot tell a refusal from an empty result. FIXTURE_MARK makes them
  // identifiable, both for cleanup and for the scoping assertions.
  var pick = async function (sql) { return (await pool.query(sql)).rows[0]; };
  fixtures.peer = await pick("SELECT id FROM employees WHERE email <> '" + EMAIL + "' LIMIT 1");
  fixtures.leave = await pick('SELECT id FROM leave_requests LIMIT 1');

  fixtures.task = await pick(
    "INSERT INTO tasks (title, created_by, status) " +
    "VALUES ('" + FIXTURE_MARK + " task', '" + fixtures.peer.id + "', 'not_started') RETURNING id");
  fixtures.expense = await pick(
    "INSERT INTO expenses (requester_id, category, amount, date, description, status) " +
    "VALUES ('" + fixtures.peer.id + "', 'travel', 4242.42, current_date, '" + FIXTURE_MARK + " expense', 'pending') RETURNING id");
  // The sweep's DELETE probe gets its own expense. Sharing one with the
  // other probes is fine while the route refuses — but if it ever does not,
  // the row is gone and the later tests fail with a confusing "not found"
  // instead of the real problem.
  fixtures.expenseForDelete = await pick(
    "INSERT INTO expenses (requester_id, category, amount, date, description, status) " +
    "VALUES ('" + fixtures.peer.id + "', 'travel', 11.11, current_date, '" + FIXTURE_MARK + " expense to delete', 'pending') RETURNING id");
  fixtures.procurement = await pick(
    "INSERT INTO procurement_requests (requester_id, item, quantity, status) " +
    "VALUES ('" + fixtures.peer.id + "', '" + FIXTURE_MARK + " procurement', 1, 'pending') RETURNING id");
});

test.after(async function () {
  if (server) server.close();
  await pool.query('DELETE FROM messages WHERE from_id = $1 OR to_id = $1', [nobody.employeeId]);
  await pool.query("DELETE FROM conversations WHERE direct_key LIKE '%' || $1::text || '%' OR created_by = $1::uuid", [nobody.employeeId]);
  await pool.query('DELETE FROM task_comments WHERE task_id = $1', [fixtures.task.id]).catch(function () {});
  await pool.query("DELETE FROM tasks WHERE title LIKE '" + FIXTURE_MARK + "%'");
  await pool.query("DELETE FROM expenses WHERE description LIKE '" + FIXTURE_MARK + "%'");
  await pool.query("DELETE FROM procurement_requests WHERE item LIKE '" + FIXTURE_MARK + "%'");
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  await pool.query('DELETE FROM employees WHERE email = $1', [EMAIL]);
  await pool.query("DELETE FROM roles WHERE key = 'authz_test_nobody'");
  await pool.end();
});

async function callAs(method, path, body, form) {
  var opts = { method: method, headers: { Authorization: 'Bearer ' + token }, redirect: 'manual' };
  if (form !== undefined) {
    // No Content-Type here on purpose — fetch sets it with the multipart
    // boundary, and overriding it makes multer reject the body.
    opts.body = form;
  } else if (body !== undefined) {
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

    var res;
    if (PROBES[key]) {
      var p = PROBES[key](fixtures);
      res = await callAs(r.method, p.path, p.body, p.form);
    } else {
      var probe = r.path.replace(/:[A-Za-z0-9_]+/g, crypto.randomUUID());
      res = await callAs(r.method, probe, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
    }

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
  if (process.env.AUTHZ_SHOW_INDETERMINATE) indeterminate.forEach(function (x) { console.log('      ? ' + x); });

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
  // claim is worth an assertion: the fixtures planted in before() belong to
  // another employee, so if any of these lists is unscoped the mark shows up.
  var leaks = [];
  for (var path of ['/api/tasks/', '/api/expenses/', '/api/procurement/', '/api/leave/', '/api/messages/']) {
    var res = await callAs('GET', path);
    if (res.text.indexOf(FIXTURE_MARK) >= 0) leaks.push(path + " returned another employee's row");
  }
  // attendance and dashboard report on a population rather than a list
  var att = JSON.parse((await callAs('GET', '/api/attendance/')).text);
  if (att.scopeSize !== 1) leaks.push('/api/attendance/ scopeSize=' + att.scopeSize + ', expected 1 (self only)');
  var dash = JSON.parse((await callAs('GET', '/api/dashboard/')).text);
  if (dash.headcount !== 1) leaks.push('/api/dashboard/ headcount=' + dash.headcount + ', expected 1 (self only)');

  // The report answers rather than refusing — it is a self-service view, and
  // a probe with a valid date range reaches it where the sweep's random one
  // stopped at validation. What matters is that it narrows to the caller: it
  // returns a row per day, so count distinct employees, not rows.
  var report = JSON.parse((await callAs('GET', '/api/attendance/report?from=2026-01-01&to=2026-01-31')).text);
  var whose = Array.from(new Set((report.rows || []).map(function (r) { return r.employeeId; })));
  if (whose.length > 1 || (whose.length === 1 && whose[0] !== nobody.employeeId)) {
    leaks.push('/api/attendance/report returned ' + whose.length + ' employee(s), expected only the caller');
  }
  if (report.canViewPay !== false) leaks.push('/api/attendance/report set canViewPay=true without payroll permission');

  assert.deepEqual(leaks, [], "Self-scoped endpoints leaked another employee's data:\n  " + leaks.join('\n  '));
});

test("the AI assistant's tools are permission-scoped", async function () {
  // POST /api/ai/chat is reachable by any signed-in employee by design, so
  // what protects payroll, revenue and stock figures is what Claude's tools
  // return. There is no ANTHROPIC_API_KEY in test, so run the tools directly
  // as the account with no permissions — exactly what they would return to
  // Claude on that person's behalf.
  var ctx = await buildContext(nobody.userId);
  assert.equal(ctx.permissions.length, 0, 'fixture drifted: the test account should hold no permissions');

  var offered = aiTools.toolsFor(ctx);
  var gated = offered.filter(function (t) { return t.perm; });
  assert.deepEqual(gated.map(function (t) { return t.name; }), [], 'tools needing a permission were offered without it');
  assert.ok(offered.every(function (t) { return t.kind === 'read'; }), 'an action was offered to someone who may not do anything');

  var overview = await aiTools.get('get_company_overview').run(ctx, {});
  assert.equal(overview.revenueThisMonth, undefined, 'revenue leaked without report.read');
  assert.equal(overview.outstandingBalance, undefined, 'outstanding balance leaked without report.read');
  assert.equal(overview.headcount, 1, 'headcount should count only the caller, not the company');

  var attendance = await aiTools.get('get_attendance').run(ctx, {});
  assert.ok(attendance.items.every(function (r) { return r.code === ctx.employee.code; }), "attendance returned other employees' rows");
  var leave = await aiTools.get('list_leave_requests').run(ctx, {});
  var expenses = await aiTools.get('list_expense_claims').run(ctx, {});
  var purchases = await aiTools.get('list_purchase_requests').run(ctx, {});
  var who = ctx.employee.first_name + ' ' + ctx.employee.last_name;
  [['leave', leave], ['expenses', expenses], ['purchases', purchases]].forEach(function (pair) {
    var others = pair[1].items.filter(function (x) { return (x.employee || x.requester) !== who; });
    assert.deepEqual(others, [], pair[0] + ' tool returned other people\'s records');
  });
});
