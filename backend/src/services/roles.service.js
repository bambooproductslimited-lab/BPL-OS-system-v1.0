var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { V } = require('../utils/validate');

// Permissions that hand someone power over other people's access, pay or
// the record of what happened — worth knowing exactly who holds them.
var SENSITIVE = ['role.manage', 'user.create', 'user.manage', 'settings.manage', 'audit.read', 'payroll.manage', 'report.manage', 'employee.write'];

// kernel.js: handlers['roles.list']
// With role.manage, each role also lists the people holding it and when it
// last changed, so the Roles screen can say who is affected by an edit.
async function list(ctx) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var res = await pool.query(
    'SELECT r.id, r.key, r.name, r.is_system, r.description, r.created_at, r.updated_at, ' +
    '(SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS user_count, ' +
    'array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL) AS permissions ' +
    'FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id ' +
    'GROUP BY r.id ORDER BY r.name'
  );
  var members = {};
  if (ctx.can('role.manage')) {
    var m = await pool.query(
      "SELECT ur.role_id, u.id AS user_id, u.email, u.status, u.last_login_at, e.id AS employee_id, e.first_name || ' ' || e.last_name AS name, e.position_title, e.photo_key, e.photo_updated_at " +
      'FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN employees e ON e.id = u.employee_id ORDER BY e.first_name, e.last_name');
    m.rows.forEach(function (r) {
      (members[r.role_id] = members[r.role_id] || []).push({
        userId: r.user_id, employeeId: r.employee_id, name: r.name, title: r.position_title || '', email: r.email, status: r.status, lastLoginAt: r.last_login_at,
        photo: r.photo_key ? (r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : 1) : null
      });
    });
  }
  return res.rows.map(function (r) {
    return {
      id: r.id, key: r.key, name: r.name, isSystem: r.is_system, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at,
      permissions: r.permissions || [], userCount: r.user_count, members: members[r.id] || null
    };
  });
}

// kernel.js: handlers['roles.permissionCatalogue'] — the one method the
// kernel exempts from auth (a static catalogue of permission definitions,
// not per-user data), so this route is mounted without requireAuth.
async function permissionCatalogue() {
  var res = await pool.query('SELECT key, "group", label FROM permissions ORDER BY "group", label');
  return res.rows.map(function (p) { return { key: p.key, group: p.group, label: p.label, sensitive: SENSITIVE.indexOf(p.key) >= 0 }; });
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

  // Optionally start from another role's permissions, so a variation of an
  // existing role doesn't mean ticking seventy boxes again.
  var from = null;
  if (p.copyFrom) {
    from = (await pool.query('SELECT id, name FROM roles WHERE id = $1', [p.copyFrom])).rows[0];
    if (!from) fail('invalid', 'The role to copy from was not found.');
    await pool.query('INSERT INTO role_permissions (role_id, permission_key) SELECT $1, permission_key FROM role_permissions WHERE role_id = $2', [roleId, from.id]);
  }

  await audit(pool, ctx, 'role.create', 'role', roleId, 'Created role "' + name + '"' + (from ? ' from "' + from.name + '"' : '') + '.');
  var updated = await list(ctx);
  return updated.filter(function (r) { return r.id === roleId; })[0];
}

// The name of a custom role, and any role's description, can change. The
// seeded roles keep their names — other parts of the system and people's
// habits refer to them.
async function update(ctx, roleId, p) {
  if (!ctx.can('role.manage')) fail('forbidden', 'Your role does not allow this action (role.manage).');
  var role = (await pool.query('SELECT * FROM roles WHERE id = $1', [roleId])).rows[0];
  if (!role) fail('notfound', 'Role not found.');
  var name = role.name;
  if (p.name !== undefined && String(p.name).trim() !== role.name) {
    if (role.is_system) fail('forbidden', 'The built-in roles keep their names. You can change the description.');
    name = V.text(p.name, 'Role name', 80);
    if ((await pool.query('SELECT 1 FROM roles WHERE lower(name) = lower($1) AND id <> $2', [name, roleId])).rows[0]) fail('invalid', 'A role named "' + name + '" already exists.');
  }
  var description = p.description === undefined ? role.description : (p.description ? V.text(p.description, 'Description', 300) : '');
  await pool.query('UPDATE roles SET name = $2, description = $3, updated_at = now() WHERE id = $1', [roleId, name, description]);
  await audit(pool, ctx, 'role.update', 'role', roleId, name !== role.name ? 'Renamed role "' + role.name + '" to "' + name + '".' : 'Changed the description of "' + name + '".');
  return (await list(ctx)).filter(function (r) { return r.id === roleId; })[0];
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
// One permission, or several at once (a whole group ticked or cleared).
async function setPermission(ctx, roleId, permission, on) {
  if (!ctx.can('role.manage')) fail('forbidden', 'Your role does not allow this action (role.manage).');
  var roleRes = await pool.query('SELECT * FROM roles WHERE id = $1', [roleId]);
  var role = roleRes.rows[0];
  if (!role) fail('notfound', 'Role not found.');
  if (role.key === 'administrator') fail('forbidden', 'The System Administrator role is locked — it must always retain full access.');

  var keys = Array.isArray(permission) ? permission : [permission];
  if (!keys.length) fail('invalid', 'Choose at least one permission.');
  var known = (await pool.query('SELECT key FROM permissions WHERE key = ANY($1::text[])', [keys])).rows.map(function (r) { return r.key; });
  if (known.length !== new Set(keys).size) fail('invalid', 'Unknown permission.');
  var had = (await pool.query('SELECT permission_key FROM role_permissions WHERE role_id = $1 AND permission_key = ANY($2::text[])', [roleId, keys])).rows.map(function (r) { return r.permission_key; });
  var changing = known.filter(function (k) { return on ? had.indexOf(k) < 0 : had.indexOf(k) >= 0; });

  if (changing.length) {
    if (on) await pool.query('INSERT INTO role_permissions (role_id, permission_key) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [roleId, changing]);
    else await pool.query('DELETE FROM role_permissions WHERE role_id = $1 AND permission_key = ANY($2::text[])', [roleId, changing]);
    await pool.query('UPDATE roles SET updated_at = now() WHERE id = $1', [roleId]);
    await audit(pool, ctx, 'role.permission', 'role', roleId, (on ? 'Granted ' : 'Revoked ') + changing.join(', ') + ' ' + (on ? 'to ' : 'from ') + role.name + '.');
  }
  var updated = await list(ctx);
  return updated.filter(function (r) { return r.id === roleId; })[0];
}

// The latest changes to roles, from the audit log: who did what, when.
async function changes(ctx) {
  if (!ctx.can('role.manage')) fail('forbidden', 'Your role does not allow this action (role.manage).');
  var res = await pool.query("SELECT at, actor_name, action, entity_id, summary FROM audit_logs WHERE entity = 'role' ORDER BY at DESC LIMIT 30");
  return res.rows.map(function (r) { return { at: r.at, actorName: r.actor_name, action: r.action, roleId: r.entity_id, summary: r.summary }; });
}

module.exports = { list: list, permissionCatalogue: permissionCatalogue, setPermission: setPermission, create: create, update: update, remove: remove, changes: changes, SENSITIVE: SENSITIVE };
