var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { V } = require('../utils/validate');

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

function slugifyRoleName(name) {
  var s = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'role';
}

// New capability — no kernel.js equivalent. Custom, company-specific roles
// alongside the 11 seeded system roles (is_system = true, which stay
// locked to their seeded key/name — only their permissions are editable,
// via setPermission below). A new role starts with zero permissions; the
// admin then checks boxes for it in the same permission matrix used for
// every other role, rather than duplicating a 70+ item picker in this
// dialog.
async function create(ctx, p) {
  if (!ctx.can('role.manage')) fail('forbidden', 'Your role does not allow this action (role.manage).');
  var name = V.text(p.name, 'Role name', 80);
  var description = p.description ? V.text(p.description, 'Description', 300) : '';

  var existsRes = await pool.query('SELECT 1 FROM roles WHERE lower(name) = lower($1)', [name]);
  if (existsRes.rows[0]) fail('invalid', 'A role named "' + name + '" already exists.');

  var base = slugifyRoleName(name);
  var key = base;
  var suffix = 1;
  while ((await pool.query('SELECT 1 FROM roles WHERE key = $1', [key])).rows[0]) {
    suffix++;
    key = base + '_' + suffix;
  }

  var roleRes = await pool.query(
    'INSERT INTO roles (key, name, is_system, description) VALUES ($1,$2,false,$3) RETURNING id',
    [key, name, description]
  );
  var roleId = roleRes.rows[0].id;

  await audit(pool, ctx, 'role.create', 'role', roleId, 'Created role "' + name + '".');
  var updated = await list(ctx);
  return updated.filter(function (r) { return r.id === roleId; })[0];
}

// Only a custom (non-system) role with nobody currently assigned to it can
// be deleted — role_permissions cascades automatically, but user_roles is
// ON DELETE RESTRICT (see 0003_roles_permissions_users.up.sql), so this
// check exists purely to give a clear error instead of a raw FK violation.
async function remove(ctx, roleId) {
  if (!ctx.can('role.manage')) fail('forbidden', 'Your role does not allow this action (role.manage).');
  var roleRes = await pool.query('SELECT * FROM roles WHERE id = $1', [roleId]);
  var role = roleRes.rows[0];
  if (!role) fail('notfound', 'Role not found.');
  if (role.is_system) fail('forbidden', 'System roles can\'t be deleted.');

  var userCountRes = await pool.query('SELECT count(*)::int AS n FROM user_roles WHERE role_id = $1', [roleId]);
  var userCount = userCountRes.rows[0].n;
  if (userCount > 0) fail('invalid', 'This role is still assigned to ' + userCount + ' user(s) — reassign them first.');

  await pool.query('DELETE FROM roles WHERE id = $1', [roleId]);
  await audit(pool, ctx, 'role.delete', 'role', roleId, 'Deleted role "' + role.name + '".');
  return { deleted: true };
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

module.exports = { list: list, permissionCatalogue: permissionCatalogue, setPermission: setPermission, create: create, remove: remove };
