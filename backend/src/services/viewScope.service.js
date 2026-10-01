var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { loadViewScope, visibleEmployee, assertVisibleEmployee } = require('../middleware/rbac');

// Who someone can see (rbac.visibleEmployee), set on their employee record:
// whole companies, whole departments and single people. The people who
// report to a manager are always theirs. A role that sees everyone
// (employee.read.all) sees every company until companies are ticked for
// it; then it sees everyone in those companies.
//
// Changed by HR (employee.write) or an administrator (role.manage) — never
// for yourself, and never wider than what the person changing it can see.

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

function canManage(ctx) { return ctx.can('employee.write') || ctx.can('role.manage'); }

// kernel.js: handlers['employees.viewScope'] — HR for anyone, or yourself.
async function get(ctx, employeeId) {
  var self = employeeId === ctx.employee.id;
  if (!self && !canManage(ctx)) fail('forbidden', 'Your role does not allow this action (employee.write).');
  if (!self) await assertVisibleEmployee(ctx, employeeId);
  var e = (await pool.query('SELECT id, first_name, last_name, department_id, status FROM employees WHERE id = $1', [employeeId])).rows[0];
  if (!e) fail('notfound', 'Employee not found.');

  var perms = await permsOf(employeeId);
  var seesAll = perms.can('employee.read.all');
  var managerial = MANAGER_PERMS.some(function (p) { return perms.can(p); });
  var scope = await loadViewScope(employeeId);

  var companies = (await pool.query(
    'SELECT c.id, c.name FROM employee_view_scopes s JOIN companies c ON c.id = s.company_id WHERE s.viewer_id = $1 ORDER BY c.name', [employeeId])).rows;
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
    if ((seesAll && !scope.companiesLimited) || inTeam || scope.employees[r.id] || scope.departments[r.department_id] ||
      scope.companies[scope.companyOfDept[r.department_id]]) visible++;
  });

  return {
    employeeId: e.id, name: e.first_name + ' ' + e.last_name,
    hasLogin: perms.roleNames.length > 0, roleNames: perms.roleNames,
    seesAll: seesAll, managerial: managerial, companiesLimited: scope.companiesLimited,
    companies: companies.map(function (c) { return { id: c.id, name: c.name }; }),
    departments: departments.map(function (d) { return { id: d.id, name: d.name, companyName: d.company_name || '' }; }),
    people: people.map(function (p) {
      return { id: p.id, code: p.code, name: p.first_name + ' ' + p.last_name, positionTitle: p.position_title || '', departmentName: p.department_name || '' };
    }),
    teamCount: team, visibleCount: visible, totalCount: all.length,
    canEdit: canManage(ctx) && !self,
    isSelf: self
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

// Someone limited to some companies can't hand out more than that: no
// company, department or person outside what they see themselves, and no
// "every company" (nothing ticked) for a role that sees everyone.
async function noWiderThanMine(ctx, employeeId, companyIds, deptIds, empIds) {
  var mine = await loadViewScope(ctx.employee.id);
  if (!ctx.can('employee.read.all') || mine.companiesLimited) {
    // Not company-wide: only people they can see.
    for (var i = 0; i < empIds.length; i++) {
      var t = (await pool.query('SELECT id, department_id, manager_id FROM employees WHERE id = $1', [empIds[i]])).rows[0];
      if (t && !(await visibleEmployee(ctx, t))) fail('forbidden', 'You can only give someone people you can see yourself.');
    }
  }
  if (!mine.companiesLimited) return;
  var outside = companyIds.filter(function (id) { return !mine.companies[id]; });
  deptIds.forEach(function (id) { if (!mine.companies[mine.companyOfDept[id]]) outside.push(id); });
  if (outside.length) fail('forbidden', 'You can only give someone companies and departments you can see yourself.');
  var target = await permsOf(employeeId);
  if (target.can('employee.read.all') && !companyIds.length) {
    fail('forbidden', 'Their role sees everyone, so leaving every company unticked would let them see companies you cannot. Tick the companies they should see.');
  }
}

// kernel.js: handlers['employees.setViewScope'] — replaces the ticks.
async function set(ctx, employeeId, p) {
  if (!canManage(ctx)) fail('forbidden', 'Your role does not allow this action (employee.write).');
  if (employeeId === ctx.employee.id) fail('forbidden', 'You cannot change who you can see yourself. Ask HR or another administrator.');
  await assertVisibleEmployee(ctx, employeeId);
  p = p || {};
  var companyIds = idList(p.companyIds, 'Companies');
  var deptIds = idList(p.departmentIds, 'Departments');
  var empIds = idList(p.employeeIds, 'People').filter(function (id) { return id !== employeeId; });
  var e = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [employeeId])).rows[0];
  if (!e) fail('notfound', 'Employee not found.');
  if (companyIds.length) {
    var c = (await pool.query('SELECT count(*)::int AS n FROM companies WHERE id = ANY($1::uuid[])', [companyIds])).rows[0].n;
    if (c !== companyIds.length) fail('invalid', 'One of those companies no longer exists. Reload and try again.');
  }
  await noWiderThanMine(ctx, employeeId, companyIds, deptIds, empIds);
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
    for (var k = 0; k < companyIds.length; k++) {
      await client.query('INSERT INTO employee_view_scopes (viewer_id, company_id, created_by) VALUES ($1,$2,$3)', [employeeId, companyIds[k], ctx.employee.id]);
    }
    for (var i = 0; i < deptIds.length; i++) {
      await client.query('INSERT INTO employee_view_scopes (viewer_id, department_id, created_by) VALUES ($1,$2,$3)', [employeeId, deptIds[i], ctx.employee.id]);
    }
    for (var j = 0; j < empIds.length; j++) {
      await client.query('INSERT INTO employee_view_scopes (viewer_id, employee_id, created_by) VALUES ($1,$2,$3)', [employeeId, empIds[j], ctx.employee.id]);
    }
    await audit(client, ctx, 'employee.view_scope', 'employee', employeeId,
      'Set who ' + e.first_name + ' ' + e.last_name + ' can see: ' + (companyIds.length ? companyIds.length + ' company(ies), ' : '') + deptIds.length + ' department(s), ' + empIds.length + ' person/people.');
  });
  return get(ctx, employeeId);
}

module.exports = { get: get, set: set };
