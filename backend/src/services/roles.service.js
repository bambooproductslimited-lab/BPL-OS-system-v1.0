var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// kernel.js: handlers['roles.list']
async function list(ctx) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var res = await pool.query(
    'SELECT r.id, r.key, r.name, r.is_system, r.description, ' +
    '(SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS user_count, ' +
    'array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL) AS permissions ' +
    'FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id ' +
    'GROUP BY r.id ORDER BY r.name'
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, key: r.key, name: r.name, isSystem: r.is_system, description: r.description,
      permissions: r.permissions || [], userCount: r.user_count
    };
  });
}

// kernel.js: handlers['roles.permissionCatalogue'] — the one method the
// kernel exempts from auth (a static catalogue of permission definitions,
// not per-user data), so this route is mounted without requireAuth.
async function permissionCatalogue() {
  var res = await pool.query('SELECT key, "group", label FROM permissions ORDER BY "group", label');
  return res.rows.map(function (p) { return { key: p.key, group: p.group, label: p.label }; });
}

// kernel.js: handlers['roles.setPermission']
async function setPermission(ctx, roleId, permission, on) {
  if (!ctx.can('role.manage')) fail('forbidden', 'Your role does not allow this action (role.manage).');
  var roleRes = await pool.query('SELECT * FROM roles WHERE id = $1', [roleId]);
  var role = roleRes.rows[0];
  if (!role) fail('notfound', 'Role not found.');
  if (role.key === 'administrator') fail('forbidden', 'The System Administrator role is locked — it must always retain full access.');

  var permRes = await pool.query('SELECT key FROM permissions WHERE key = $1', [permission]);
  if (!permRes.rows[0]) fail('invalid', 'Unknown permission.');

  if (on) {
    await pool.query(
      'INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [roleId, permission]
    );
  } else {
    await pool.query('DELETE FROM role_permissions WHERE role_id = $1 AND permission_key = $2', [roleId, permission]);
  }

  await audit(pool, ctx, 'role.permission', 'role', roleId, (on ? 'Granted ' : 'Revoked ') + permission + ' ' + (on ? 'to ' : 'from ') + role.name + '.');
  var updated = await list(ctx);
  return updated.filter(function (r) { return r.id === roleId; })[0];
}

module.exports = { list: list, permissionCatalogue: permissionCatalogue, setPermission: setPermission };
