var bcrypt = require('bcrypt');
var crypto = require('crypto');
var config = require('../config');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// kernel.js: handlers['users.list']
async function list(ctx) {
  if (!ctx.can('user.manage')) fail('forbidden', 'Your role does not allow this action (user.manage).');
  var res = await pool.query(
    'SELECT u.id, u.email, u.status, u.last_login_at, e.first_name, e.last_name, ' +
    "array_agg(r.name) FILTER (WHERE r.name IS NOT NULL) AS role_names, array_agg(r.id) FILTER (WHERE r.id IS NOT NULL) AS role_ids " +
    'FROM users u JOIN employees e ON e.id = u.employee_id ' +
    'LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id ' +
    'GROUP BY u.id, e.first_name, e.last_name ORDER BY e.first_name, e.last_name'
  );
  return res.rows.map(function (u) {
    return {
      id: u.id, email: u.email, status: u.status, lastLoginAt: u.last_login_at,
      name: u.first_name + ' ' + u.last_name, roleNames: u.role_names || [], roleIds: u.role_ids || []
    };
  });
}

// kernel.js: handlers['users.setRole']
async function setRole(ctx, userId, roleId) {
  if (!ctx.can('user.manage')) fail('forbidden', 'Your role does not allow this action (user.manage).');
  if (userId === ctx.user.id) fail('forbidden', 'You cannot change your own role.');

  var userRes = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  if (!userRes.rows[0]) fail('notfound', 'Account not found.');
  var roleRes = await pool.query('SELECT id, name FROM roles WHERE id = $1', [roleId]);
  if (!roleRes.rows[0]) fail('invalid', 'Unknown role.');

  await withTransaction(async function (client) {
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [userId, roleId]);
    await audit(client, ctx, 'user.setRole', 'user', userId, 'Set role of ' + userRes.rows[0].email + ' to ' + roleRes.rows[0].name + '.');
  });

  var updated = await list(ctx);
  return updated.filter(function (u) { return u.id === userId; })[0];
}

// kernel.js: handlers['users.setStatus']
async function setStatus(ctx, userId, status) {
  if (!ctx.can('user.manage')) fail('forbidden', 'Your role does not allow this action (user.manage).');
  if (userId === ctx.user.id) fail('forbidden', 'You cannot disable your own account.');
  status = V.oneOf(status, ['active', 'disabled'], 'Status');

  var res = await pool.query('UPDATE users SET status = $1, updated_at = now() WHERE id = $2 RETURNING email', [status, userId]);
  if (!res.rows[0]) fail('notfound', 'Account not found.');

  await audit(pool, ctx, 'user.setStatus', 'user', userId, res.rows[0].email + ' account ' + status + '.');
  var updated = await list(ctx);
  return updated.filter(function (u) { return u.id === userId; })[0];
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

  var updated = await list(ctx);
  return updated.filter(function (u) { return u.id === userId; })[0];
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
  list: list, setRole: setRole, setStatus: setStatus, setEmail: setEmail,
  create: create, setPassword: setPassword, availableEmployees: availableEmployees
};
