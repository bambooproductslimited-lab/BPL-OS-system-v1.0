var bcrypt = require('bcrypt');
var crypto = require('crypto');
var config = require('../config');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// kernel.js: handlers['users.list']
// Each account with the person behind it (photo, job, department, whether
// they still work here), its roles, how it signs in (two-step methods,
// locked after failed attempts, must change password) and whether a Claude
// app is connected as them.
async function list(ctx) {
  if (!ctx.can('user.manage')) fail('forbidden', 'Your role does not allow this action (user.manage).');
  var res = await pool.query(
    'SELECT u.id, u.email, u.status, u.last_login_at, u.created_at, u.must_change_password, u.failed_login_attempts, u.locked_until, ' +
    '  u.totp_enabled_at, u.sms_two_step_at, u.email_two_step_at, ' +
    '  e.id AS employee_id, e.first_name, e.last_name, e.position_title, e.status AS employee_status, e.photo_key, e.photo_updated_at, ' +
    '  d.name AS department_name, c.name AS company_name, ' +
    "  array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL) AS role_names, array_agg(r.id ORDER BY r.name) FILTER (WHERE r.id IS NOT NULL) AS role_ids, " +
    "  bool_or(r.key = 'administrator') AS is_admin, " +
    '  EXISTS (SELECT 1 FROM mcp_oauth_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL AND t.expires_at > now()) AS claude_connected ' +
    'FROM users u JOIN employees e ON e.id = u.employee_id ' +
    'LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id ' +
    'LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id ' +
    'GROUP BY u.id, e.id, d.name, c.name ORDER BY e.first_name, e.last_name'
  );
  return res.rows.map(function (u) {
    var locked = u.locked_until && new Date(u.locked_until) > new Date();
    return {
      id: u.id, email: u.email, status: u.status, lastLoginAt: u.last_login_at, createdAt: u.created_at,
      twoStepOn: !!(u.totp_enabled_at || u.sms_two_step_at || u.email_two_step_at),
      twoStep: { app: !!u.totp_enabled_at, sms: !!u.sms_two_step_at, email: !!u.email_two_step_at },
      name: u.first_name + ' ' + u.last_name, roleNames: u.role_names || [], roleIds: u.role_ids || [], isAdmin: !!u.is_admin,
      employeeId: u.employee_id, title: u.position_title || '', department: u.department_name || '', company: u.company_name || '',
      employeeStatus: u.employee_status, photo: u.photo_key ? (u.photo_updated_at ? new Date(u.photo_updated_at).getTime() : 1) : null,
      mustChangePassword: u.must_change_password, failedAttempts: u.failed_login_attempts || 0, lockedUntil: locked ? u.locked_until : null,
      claudeConnected: !!u.claude_connected
    };
  });
}
async function one(ctx, userId) {
  return (await list(ctx)).filter(function (u) { return u.id === userId; })[0];
}

// Someone must always be able to put things right: the last active account
// holding the System Administrator role can't lose it or be switched off.
async function guardLastAdmin(userId, losingAdmin) {
  if (!losingAdmin) return;
  var others = await pool.query(
    "SELECT count(*)::int AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id " +
    "WHERE r.key = 'administrator' AND u.status = 'active' AND u.id <> $1", [userId]);
  if (!others.rows[0].n) fail('conflict', 'This is the last active System Administrator. Give the role to someone else first.');
}
async function holdsAdmin(userId) {
  return !!(await pool.query("SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.key = 'administrator'", [userId])).rows[0];
}

// kernel.js: handlers['users.setRole'] — one role, replacing any others.
async function setRole(ctx, userId, roleId) {
  return setRoles(ctx, userId, [roleId]);
}

// The roles an account holds (at least one). A person with several roles
// can do what any of them allows.
async function setRoles(ctx, userId, roleIds) {
  if (!ctx.can('user.manage')) fail('forbidden', 'Your role does not allow this action (user.manage).');
  if (userId === ctx.user.id) fail('forbidden', 'You cannot change your own role.');
  var ids = Array.from(new Set((Array.isArray(roleIds) ? roleIds : []).map(String)));
  if (!ids.length) fail('invalid', 'Choose at least one role.');

  var userRes = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  if (!userRes.rows[0]) fail('notfound', 'Account not found.');
  var roles = (await pool.query('SELECT id, key, name FROM roles WHERE id::text = ANY($1::text[]) ORDER BY name', [ids])).rows;
  if (roles.length !== ids.length) fail('invalid', 'Unknown role.');
  var keepsAdmin = roles.some(function (r) { return r.key === 'administrator'; });
  await guardLastAdmin(userId, (await holdsAdmin(userId)) && !keepsAdmin);

  await withTransaction(async function (client) {
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    for (var i = 0; i < roles.length; i++) await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [userId, roles[i].id]);
    await audit(client, ctx, 'user.setRole', 'user', userId, 'Set role' + (roles.length > 1 ? 's' : '') + ' of ' + userRes.rows[0].email + ' to ' + roles.map(function (r) { return r.name; }).join(', ') + '.');
  });
  return one(ctx, userId);
}

// kernel.js: handlers['users.setStatus']
// Switching an account off ends its use at once (every request checks the
// status) and also disconnects any Claude app signed in as it.
async function setStatus(ctx, userId, status) {
  if (!ctx.can('user.manage')) fail('forbidden', 'Your role does not allow this action (user.manage).');
  if (userId === ctx.user.id) fail('forbidden', 'You cannot disable your own account.');
  status = V.oneOf(status, ['active', 'disabled'], 'Status');
  if (status === 'disabled') await guardLastAdmin(userId, await holdsAdmin(userId));

  var res = await pool.query('UPDATE users SET status = $1, updated_at = now() WHERE id = $2 RETURNING email', [status, userId]);
  if (!res.rows[0]) fail('notfound', 'Account not found.');
  if (status === 'disabled') await require('../mcp/oauth').revokeAllForUser(pool, userId);

  await audit(pool, ctx, 'user.setStatus', 'user', userId, res.rows[0].email + ' account ' + status + '.');
  return one(ctx, userId);
}

// Lets someone locked out by too many wrong passwords try again now.
async function unlock(ctx, userId) {
  if (!ctx.can('user.manage')) fail('forbidden', 'Your role does not allow this action (user.manage).');
  var res = await pool.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1 RETURNING email', [userId]);
  if (!res.rows[0]) fail('notfound', 'Account not found.');
  await audit(pool, ctx, 'user.unlock', 'user', userId, 'Unlocked ' + res.rows[0].email + ' after failed sign-ins.');
  return one(ctx, userId);
}

// The account's own story from the audit log: sign-ins and changes made to
// it, newest first.
async function activity(ctx, userId) {
  if (!ctx.can('user.manage')) fail('forbidden', 'Your role does not allow this action (user.manage).');
  if (!(await pool.query('SELECT 1 FROM users WHERE id = $1', [userId])).rows[0]) fail('notfound', 'Account not found.');
  var res = await pool.query("SELECT at, actor_name, action, summary FROM audit_logs WHERE entity = 'user' AND entity_id = $1 ORDER BY at DESC LIMIT 20", [String(userId)]);
  return res.rows.map(function (r) { return { at: r.at, actorName: r.actor_name, action: r.action, summary: r.summary }; });
}

// New capability — no kernel.js equivalent. create() below copies the
// employee's email in once at account-creation time, but users.email and
// employees.email are independently UNIQUE columns that are never kept in
// sync afterward — editing the employee's own record elsewhere doesn't
// touch this. This is the only way to fix a login email that was wrong
// (typo, wrong employee's address, etc.) from the moment the account was
// created onward. Gated on user.create, same as setPassword — both are
// sensitive login-credential corrections, not the routine role/status
// admin user.manage covers.
async function setEmail(ctx, userId, email) {
  if (!ctx.can('user.create')) fail('forbidden', 'Your role does not allow this action (user.create).');
  var newEmail = V.email(email);

  var userRes = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  var user = userRes.rows[0];
  if (!user) fail('notfound', 'Account not found.');

  if (newEmail !== user.email) {
    var dupRes = await pool.query('SELECT 1 FROM users WHERE email = $1 AND id != $2', [newEmail, userId]);
    if (dupRes.rows[0]) fail('invalid', 'That email is already in use by another account.');

    await pool.query('UPDATE users SET email = $1, updated_at = now() WHERE id = $2', [newEmail, userId]);
    await audit(pool, ctx, 'user.setEmail', 'user', userId, 'Changed login email from ' + user.email + ' to ' + newEmail + '.');
  }

  return one(ctx, userId);
}

// kernel.js: handlers['users.create'] — new: admin-only account creation,
// so a login account no longer has to come from the one seed/bootstrap admin.
async function create(ctx, p) {
  if (!ctx.can('user.create')) fail('forbidden', 'Your role does not allow this action (user.create).');

  var empRes = await pool.query('SELECT id, email, first_name, last_name FROM employees WHERE id = $1', [p.employeeId]);
  var emp = empRes.rows[0];
  if (!emp) fail('invalid', 'Employee not found.');

  var already = await pool.query('SELECT id FROM users WHERE employee_id = $1', [emp.id]);
  if (already.rows[0]) fail('invalid', 'This employee already has a login account.');

  var roleRes = await pool.query('SELECT id, name FROM roles WHERE id = $1', [p.roleId]);
  var role = roleRes.rows[0];
  if (!role) fail('invalid', 'Unknown role.');

  var password = String(p.password || '');
  if (password.length < 8) fail('invalid', 'Password must be at least 8 characters.');

  var passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  var userId = crypto.randomUUID();
  await withTransaction(async function (client) {
    await client.query(
      'INSERT INTO users (id, employee_id, email, password_hash, status, must_change_password) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, emp.id, emp.email, passwordHash, 'active', p.mustChangePassword !== false]
    );
    await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [userId, role.id]);
    await audit(client, ctx, 'user.create', 'user', userId, 'Created login account for ' + emp.first_name + ' ' + emp.last_name + ' (' + emp.email + '), role ' + role.name + '.');
  });

  var updated = await list(ctx);
  return updated.filter(function (u) { return u.id === userId; })[0];
}

// kernel.js: handlers['users.setPassword'] — new: admin-only password reset
// for an existing account. Forces a change at next sign-in.
async function setPassword(ctx, userId, password) {
  if (!ctx.can('user.create')) fail('forbidden', 'Your role does not allow this action (user.create).');

  var password2 = String(password || '');
  if (password2.length < 8) fail('invalid', 'Password must be at least 8 characters.');

  var userRes = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  if (!userRes.rows[0]) fail('notfound', 'Account not found.');

  var passwordHash = await bcrypt.hash(password2, config.bcryptRounds);
  await pool.query(
    'UPDATE users SET password_hash = $1, must_change_password = true, failed_login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $2',
    [passwordHash, userId]
  );
  await require('../mcp/oauth').revokeAllForUser(pool, userId); // also disconnects Claude (src/mcp/)
  await audit(pool, ctx, 'user.setPassword', 'user', userId, 'Reset password for ' + userRes.rows[0].email + '.');
  var updated = await list(ctx);
  return updated.filter(function (u) { return u.id === userId; })[0];
}

// kernel.js: handlers['users.availableEmployees'] — employees with no login
// account yet, to populate the "New user" form's employee picker.
async function availableEmployees(ctx) {
  if (!ctx.can('user.create')) fail('forbidden', 'Your role does not allow this action (user.create).');
  var res = await pool.query(
    "SELECT e.id, e.first_name, e.last_name, e.email, e.code FROM employees e " +
    'LEFT JOIN users u ON u.employee_id = e.id ' +
    "WHERE u.id IS NULL AND e.status != 'terminated' ORDER BY e.first_name, e.last_name"
  );
  return res.rows.map(function (r) {
    return { id: r.id, name: r.first_name + ' ' + r.last_name, email: r.email, code: r.code };
  });
}

module.exports = {
  list: list, setRole: setRole, setRoles: setRoles, setStatus: setStatus, setEmail: setEmail, unlock: unlock, activity: activity,
  create: create, setPassword: setPassword, availableEmployees: availableEmployees
};
