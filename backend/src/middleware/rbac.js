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
// check: can this actor see this employee's record? (self -> department ->
// reporting subtree -> all, gated by whichever "read all"-shaped permission
// is relevant to the caller.) `target` is {id, department_id, manager_id}.
async function visibleEmployee(ctx, target) {
  if (!target) return false;
  if (ctx.can('employee.read.all')) return true;
  if (target.id === ctx.employee.id) return true;
  if (ctx.can('attendance.read.all') || ctx.can('leave.read.all') || ctx.can('task.manage')) {
    if (target.department_id === ctx.employee.department_id) return true;
    if (target.manager_id === ctx.employee.id) return true;
    // Walk the whole reporting subtree: does this actor appear as an
    // ancestor manager of the target employee?
    var cur = target, guard = 0;
    while (cur && cur.manager_id && guard++ < 12) {
      if (cur.manager_id === ctx.employee.id) return true;
      var res = await pool.query('SELECT id, manager_id FROM employees WHERE id = $1', [cur.manager_id]);
      cur = res.rows[0] || null;
    }
  }
  return false;
}

async function fetchEmployeeById(id) {
  var res = await pool.query('SELECT id, department_id, manager_id FROM employees WHERE id = $1', [id]);
  return res.rows[0] || null;
}

module.exports = {
  requirePermission: requirePermission,
  visibleEmployee: visibleEmployee,
  fetchEmployeeById: fetchEmployeeById,
  fail: fail
};
