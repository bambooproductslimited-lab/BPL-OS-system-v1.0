var { pool } = require('../db/pool');

// Ported from kernel.js's ctxFor(user) / permissionsOf(user): resolves a
// user's employee record, roles and the flattened set of permissions those
// roles grant (no direct user -> permission grants, same as the prototype).
async function buildContext(userId) {
  var userRes = await pool.query(
    'SELECT u.id, u.email, u.status, u.employee_id, ' +
    'e.id AS emp_id, e.code, e.first_name, e.last_name, e.department_id, e.manager_id, e.position_title, e.status AS emp_status ' +
    'FROM users u JOIN employees e ON e.id = u.employee_id WHERE u.id = $1',
    [userId]
  );
  var row = userRes.rows[0];
  if (!row || row.status !== 'active') return null;

  var rolesRes = await pool.query(
    'SELECT r.key, r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1',
    [userId]
  );
  var permsRes = await pool.query(
    'SELECT DISTINCT rp.permission_key FROM role_permissions rp JOIN user_roles ur ON ur.role_id = rp.role_id WHERE ur.user_id = $1',
    [userId]
  );
  var permissions = permsRes.rows.map(function (r) { return r.permission_key; });
  var pset = {};
  permissions.forEach(function (p) { pset[p] = true; });

  return {
    user: { id: row.id, email: row.email, status: row.status },
    employee: {
      id: row.emp_id, code: row.code, first_name: row.first_name, last_name: row.last_name,
      department_id: row.department_id, manager_id: row.manager_id, position_title: row.position_title, status: row.emp_status
    },
    permissions: permissions,
    can: function (p) { return !!pset[p]; },
    roleNames: rolesRes.rows.map(function (r) { return r.name; })
  };
}

// ctx.employee is kept snake_case (matching the DB columns) because it's
// used internally throughout every service/RBAC check as ctx.employee.department_id
// etc. — changing its shape would touch every service file. This is the
// client-facing DTO mapper for the one place ctx.employee is actually sent
// over the wire (GET /api/me, POST /api/auth/login, GET /api/me/summary),
// matching the camelCase shape every other endpoint returns.
function serializeEmployee(employee) {
  if (!employee) return null;
  return {
    id: employee.id, code: employee.code, firstName: employee.first_name, lastName: employee.last_name,
    departmentId: employee.department_id, managerId: employee.manager_id,
    positionTitle: employee.position_title, status: employee.status, shift: employee.shift
  };
}

module.exports = { buildContext: buildContext, serializeEmployee: serializeEmployee };
