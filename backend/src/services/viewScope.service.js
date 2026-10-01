var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { loadViewScope } = require('../middleware/rbac');

// Who a manager can see (rbac.visibleEmployee): HR ticks departments and
// people for each manager on their employee record. The people who report
// to a manager are always theirs; roles with employee.read.all see
// everyone and need nothing ticked.

var MANAGER_PERMS = ['attendance.read.all', 'leave.read.all', 'task.manage'];

async function permsOf(employeeId) {
  var rows = (await pool.query(
    'SELECT DISTINCT rp.permission_key AS p, r.name FROM users u JOIN user_roles ur ON ur.user_id = u.id ' +
    'JOIN roles r ON r.id = ur.role_id LEFT JOIN role_permissions rp ON rp.role_id = r.id ' +
    "WHERE u.employee_id = $1 AND u.status = 'active'", [employeeId])).rows;
  var set = {}, roles = {};
  rows.forEach(function (r) { if (r.p) set[r.p] = true; roles[r.name] = true; });
  return { can: function (p) { return !!set[p]; }, roleNames: Object.keys(roles).sort() };
}

function canManage(ctx) { return ctx.can('employee.write'); }

// kernel.js: handlers['employees.viewScope'] — HR for anyone, or yourself.
async function get(ctx, employeeId) {
  var self = employeeId === ctx.employee.id;
  if (!self && !canManage(ctx)) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var e = (await pool.query('SELECT id, first_name, last_name, department_id, status FROM employees WHERE id = $1', [employeeId])).rows[0];
  if (!e) fail('notfound', 'Employee not found.');

  var perms = await permsOf(employeeId);
  var seesAll = perms.can('employee.read.all');
  var managerial = MANAGER_PERMS.some(function (p) { return perms.can(p); });
  var scope = await loadViewScope(employeeId);

  var departments = (await pool.query(
    'SELECT d.id, d.name, c.name AS company_name FROM employee_view_scopes s JOIN departments d ON d.id = s.department_id ' +
    'LEFT JOIN companies c ON c.id = d.company_id WHERE s.viewer_id = $1 ORDER BY c.name, d.name', [employeeId])).rows;
  var people = (await pool.query(
    'SELECT p.id, p.code, p.first_name, p.last_name, p.position_title, d.name AS department_name FROM employee_view_scopes s ' +
    'JOIN employees p ON p.id = s.employee_id LEFT JOIN departments d ON d.id = p.department_id WHERE s.viewer_id = $1 ORDER BY p.first_name, p.last_name',
    [employeeId])).rows;

  // How many active colleagues that adds up to (themselves not counted).
  var all = (await pool.query("SELECT id, department_id FROM employees WHERE status <> 'terminated' AND id <> $1", [employeeId])).rows;
  var team = 0, visible = 0;
  all.forEach(function (r) {
    var inTeam = managerial && scope.team[r.id];
    if (inTeam) team++;
    if (seesAll || inTeam || scope.employees[r.id] || scope.departments[r.department_id]) visible++;
  });

  return {
    employeeId: e.id, name: e.first_name + ' ' + e.last_name,
    hasLogin: perms.roleNames.length > 0, roleNames: perms.roleNames,
    seesAll: seesAll, managerial: managerial,
    departments: departments.map(function (d) { return { id: d.id, name: d.name, companyName: d.company_name || '' }; }),
    people: people.map(function (p) {
      return { id: p.id, code: p.code, name: p.first_name + ' ' + p.last_name, positionTitle: p.position_title || '', departmentName: p.department_name || '' };
    }),
    teamCount: team, visibleCount: visible, totalCount: all.length,
    canEdit: canManage(ctx)
  };
}

function idList(v, what) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail('invalid', what + ' must be a list.');
  var seen = {};
  return v.filter(function (x) {
    if (typeof x !== 'string' || !x) fail('invalid', what + ' must be a list of ids.');
    if (seen[x]) return false;
    seen[x] = true; return true;
  });
}

// kernel.js: handlers['employees.setViewScope'] — replaces the ticks.
async function set(ctx, employeeId, p) {
  if (!canManage(ctx)) fail('forbidden', 'Your role does not allow this action (employee.write).');
  p = p || {};
  var deptIds = idList(p.departmentIds, 'Departments');
  var empIds = idList(p.employeeIds, 'People').filter(function (id) { return id !== employeeId; });
  var e = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [employeeId])).rows[0];
  if (!e) fail('notfound', 'Employee not found.');
  if (deptIds.length) {
    var d = (await pool.query('SELECT count(*)::int AS n FROM departments WHERE id = ANY($1::uuid[])', [deptIds])).rows[0].n;
    if (d !== deptIds.length) fail('invalid', 'One of those departments no longer exists. Reload and try again.');
  }
  if (empIds.length) {
    var n = (await pool.query('SELECT count(*)::int AS n FROM employees WHERE id = ANY($1::uuid[])', [empIds])).rows[0].n;
    if (n !== empIds.length) fail('invalid', 'One of those people no longer exists. Reload and try again.');
  }
  await withTransaction(async function (client) {
    await client.query('DELETE FROM employee_view_scopes WHERE viewer_id = $1', [employeeId]);
    for (var i = 0; i < deptIds.length; i++) {
      await client.query('INSERT INTO employee_view_scopes (viewer_id, department_id, created_by) VALUES ($1,$2,$3)', [employeeId, deptIds[i], ctx.employee.id]);
    }
    for (var j = 0; j < empIds.length; j++) {
      await client.query('INSERT INTO employee_view_scopes (viewer_id, employee_id, created_by) VALUES ($1,$2,$3)', [employeeId, empIds[j], ctx.employee.id]);
    }
    await audit(client, ctx, 'employee.view_scope', 'employee', employeeId,
      'Set who ' + e.first_name + ' ' + e.last_name + ' can see: ' + deptIds.length + ' department(s), ' + empIds.length + ' person/people.');
  });
  return get(ctx, employeeId);
}

module.exports = { get: get, set: set };
