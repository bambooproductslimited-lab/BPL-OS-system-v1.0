var { pool } = require('../db/pool');
var { fail, AppError } = require('../utils/errors');

// Ported from kernel.js's require_(ctx, perm).
function requirePermission(perm) {
  return function (req, res, next) {
    if (!req.ctx.can(perm)) {
      return next(new AppError('forbidden', 'Your role does not allow this action (' + perm + ').'));
    }
    next();
  };
}

// Ported from kernel.js's visibleEmployee(ctx, emp) — the record-level scope
// check: can this actor see this employee's record? `target` is
// {id, department_id, manager_id}.
//
// - employee.read.all (administrator, executive, HR, Finance & HR, general
//   manager): everyone.
// - Everyone: themselves.
// - A manager (attendance.read.all, leave.read.all or task.manage): the
//   people who report to them, directly or further down.
// - Anyone: the departments and people HR ticked for them
//   (employee_view_scopes, see viewScope.service.js). Their own department
//   is not automatic — it is ticked like any other, so HR can take it away.
async function visibleEmployee(ctx, target) {
  if (!target) return false;
  if (ctx.can('employee.read.all')) return true;
  if (target.id === ctx.employee.id) return true;
  var scope = await viewScopeOf(ctx);
  if (scope.employees[target.id]) return true;
  if (target.department_id && scope.departments[target.department_id]) return true;
  if (managerial(ctx) && scope.team[target.id]) return true;
  return false;
}

function managerial(ctx) {
  return ctx.can('attendance.read.all') || ctx.can('leave.read.all') || ctx.can('task.manage');
}

// Loaded once per request (ctx lives for one request) — list screens ask
// for every employee in turn.
function viewScopeOf(ctx) {
  if (!ctx._viewScope) ctx._viewScope = loadViewScope(ctx.employee.id);
  return ctx._viewScope;
}

async function loadViewScope(employeeId) {
  var out = { departments: {}, employees: {}, team: {} };
  var rows = (await pool.query('SELECT department_id, employee_id FROM employee_view_scopes WHERE viewer_id = $1', [employeeId])).rows;
  rows.forEach(function (r) {
    if (r.department_id) out.departments[r.department_id] = true;
    if (r.employee_id) out.employees[r.employee_id] = true;
  });
  var team = (await pool.query(
    'WITH RECURSIVE t AS (SELECT id, 1 AS depth FROM employees WHERE manager_id = $1 AND id <> $1 ' +
    'UNION SELECT e.id, t.depth + 1 FROM employees e JOIN t ON e.manager_id = t.id WHERE t.depth < 12) ' +
    'SELECT DISTINCT id FROM t', [employeeId])).rows;
  team.forEach(function (r) { out.team[r.id] = true; });
  return out;
}

async function fetchEmployeeById(id) {
  var res = await pool.query('SELECT id, department_id, manager_id FROM employees WHERE id = $1', [id]);
  return res.rows[0] || null;
}

module.exports = {
  requirePermission: requirePermission,
  visibleEmployee: visibleEmployee,
  managerial: managerial,
  loadViewScope: loadViewScope,
  fetchEmployeeById: fetchEmployeeById,
  fail: fail
};
