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

module.exports = { list: list, setRole: setRole, setStatus: setStatus };
