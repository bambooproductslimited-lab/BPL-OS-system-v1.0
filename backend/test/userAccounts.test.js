// User accounts: each account shows the person behind it and how it signs
// in; an account can hold several roles; the last active System
// Administrator can't lose the role or be switched off; switching an
// account off disconnects Claude apps; a lock-out can be cleared; the
// account's activity comes from the audit log.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var users = require('../src/services/users.service');
var { buildContext } = require('../src/services/context.service');

var kelvin, albert, alice, aliceRoles;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function roleId(key) { return (await pool.query('SELECT id FROM roles WHERE key = $1', [key])).rows[0].id; }
test.before(async function () {
  kelvin = await ctxFor('kelvin.duho@bplghana.com');
  albert = await ctxFor('albert.awini@bplghana.com');
  alice = await ctxFor('alice.kamau@bplghana.com');
  aliceRoles = (await pool.query('SELECT role_id FROM user_roles WHERE user_id = $1', [alice.user.id])).rows.map(function (r) { return r.role_id; });
  await pool.query("INSERT INTO mcp_oauth_clients (client_id, info) VALUES ('z9ua-app', '{\"client_name\":\"Z9UA\"}') ON CONFLICT DO NOTHING");
});
test.after(async function () {
  await pool.query('DELETE FROM user_roles WHERE user_id = $1', [alice.user.id]);
  for (var i = 0; i < aliceRoles.length; i++) await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [alice.user.id, aliceRoles[i]]);
  await pool.query("UPDATE users SET status = 'active', failed_login_attempts = 0, locked_until = NULL WHERE id = $1", [alice.user.id]);
  await pool.query("DELETE FROM mcp_oauth_clients WHERE client_id = 'z9ua-app'");
  await pool.end();
});

test('the list shows the person, roles and how the account signs in', async function () {
  await pool.query("INSERT INTO mcp_oauth_tokens (token_hash, kind, client_id, user_id, expires_at) VALUES ('z9ua-t', 'access', 'z9ua-app', $1, now() + interval '1 hour')", [alice.user.id]);
  var a = (await users.list(kelvin)).find(function (u) { return u.id === alice.user.id; });
  assert.equal(a.employeeId, alice.employee.id);
  assert.ok(a.department);
  assert.equal(a.isAdmin, false);
  assert.deepEqual(a.twoStep, { app: false, sms: false, email: false });
  assert.equal(a.claudeConnected, true);
  assert.equal(a.lockedUntil, null);
  assert.equal((await users.list(kelvin)).find(function (u) { return u.id === kelvin.user.id; }).isAdmin, true);
});

test('several roles; the last administrator stays; switching off disconnects Claude', async function () {
  var r = await users.setRoles(kelvin, alice.user.id, [await roleId('employee'), await roleId('supervisor')]);
  assert.equal(r.roleNames.length, 2);
  await assert.rejects(users.setRoles(kelvin, alice.user.id, []), /at least one role/);
  await assert.rejects(users.setRoles(kelvin, kelvin.user.id, [await roleId('employee')]), /your own role/);

  // Albert may manage users but can't take the role from, or switch off, the only active administrator.
  var admins = (await pool.query("SELECT count(*)::int AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE r.key = 'administrator' AND u.status = 'active'")).rows[0].n;
  if (admins === 1) {
    await assert.rejects(users.setRoles(albert, kelvin.user.id, [await roleId('employee')]), /last active System Administrator/);
    await assert.rejects(users.setStatus(albert, kelvin.user.id, 'disabled'), /last active System Administrator/);
  }

  var off = await users.setStatus(kelvin, alice.user.id, 'disabled');
  assert.equal(off.status, 'disabled');
  assert.equal(off.claudeConnected, false);
  await users.setStatus(kelvin, alice.user.id, 'active');
});

test('a lock-out can be cleared, and the activity is listed', async function () {
  await pool.query("UPDATE users SET failed_login_attempts = 5, locked_until = now() + interval '10 minutes' WHERE id = $1", [alice.user.id]);
  var locked = (await users.list(kelvin)).find(function (u) { return u.id === alice.user.id; });
  assert.ok(locked.lockedUntil);
  assert.equal(locked.failedAttempts, 5);
  var open = await users.unlock(kelvin, alice.user.id);
  assert.equal(open.lockedUntil, null);
  assert.equal(open.failedAttempts, 0);
  var act = await users.activity(kelvin, alice.user.id);
  assert.match(act[0].summary, /Unlocked/);
  assert.ok(act.some(function (x) { return /account disabled/.test(x.summary); }));
  await assert.rejects(users.activity(alice, alice.user.id), /user.manage/);
});
