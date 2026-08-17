var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

function todayISO() { return new Date().toISOString().slice(0, 10); }

// Ported from kernel.js's projectVisible(ctx, p).
function projectVisible(ctx, project) {
  if (!ctx.can('project.read')) return false;
  if (ctx.can('employee.read.all')) return true;
  if (project.department_id === ctx.employee.department_id) return true;
  if (project.owner_id === ctx.employee.id) return true;
  return (project.member_ids || []).indexOf(ctx.employee.id) >= 0;
}

function rowToProject(r, extra) {
  return Object.assign({
    id: r.id, code: r.code, name: r.name, departmentId: r.department_id, ownerId: r.owner_id,
    memberIds: r.member_ids || [], startDate: r.start_date, deadline: r.deadline, status: r.status,
    budget: r.budget === null ? 0 : Number(r.budget), description: r.description
  }, extra || {});
}

// kernel.js: handlers['projects.list']
async function list(ctx) {
  if (!ctx.can('project.read')) fail('forbidden', 'Your role does not allow this action (project.read).');
  var res = await pool.query(
    'SELECT p.*, o.first_name AS owner_first, o.last_name AS owner_last, d.name AS dept_name, ' +
    "(SELECT array_agg(employee_id) FROM project_members pm WHERE pm.project_id = p.id) AS member_ids, " +
    '(SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id) AS task_count, ' +
    "(SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed') AS done_count " +
    'FROM projects p JOIN employees o ON o.id = p.owner_id JOIN departments d ON d.id = p.department_id ' +
    'ORDER BY p.code'
  );
  return res.rows.filter(function (r) { return projectVisible(ctx, r); }).map(function (r) {
    return rowToProject(r, {
      ownerName: r.owner_first + ' ' + r.owner_last, departmentName: r.dept_name,
      taskCount: r.task_count, doneCount: r.done_count
    });
  });
}

// kernel.js: handlers['projects.create']
async function create(ctx, p) {
  if (!ctx.can('project.manage')) fail('forbidden', 'Your role does not allow this action (project.manage).');
  var name = V.text(p.name, 'Project name', 80);
  var deptRes = await pool.query('SELECT id FROM departments WHERE id = $1', [p.departmentId]);
  if (!deptRes.rows[0]) fail('invalid', 'Department is not a valid option.');
  var startDate = V.date(p.startDate || todayISO(), 'Start date');
  var deadline = V.date(p.deadline || todayISO(), 'Deadline');
  var memberIds = p.memberIds || [];
  var ownerId = p.ownerId || ctx.employee.id;

  var countRes = await pool.query('SELECT count(*)::int AS n FROM projects');
  var code = 'PRJ-' + String(countRes.rows[0].n + 1).padStart(3, '0');

  var insertRes = await pool.query(
    "INSERT INTO projects (code, name, department_id, owner_id, start_date, deadline, status, budget, description) " +
    "VALUES ($1,$2,$3,$4,$5,$6,'planning',$7,$8) RETURNING *",
    [code, name, p.departmentId, ownerId, startDate, deadline, Number(p.budget) || 0, (p.description || '').trim()]
  );
  var proj = insertRes.rows[0];
  for (var i = 0; i < memberIds.length; i++) {
    await pool.query('INSERT INTO project_members (project_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [proj.id, memberIds[i]]);
  }

  await audit(pool, ctx, 'project.create', 'project', proj.id, 'Created project ' + proj.code + ' — ' + proj.name + '.');
  return rowToProject(proj, { memberIds: memberIds });
}

// kernel.js: handlers['projects.setStatus']
async function setStatus(ctx, id, status) {
  if (!ctx.can('project.manage')) fail('forbidden', 'Your role does not allow this action (project.manage).');
  var res = await pool.query(
    'SELECT p.*, (SELECT array_agg(employee_id) FROM project_members pm WHERE pm.project_id = p.id) AS member_ids FROM projects p WHERE p.id = $1',
    [id]
  );
  var proj = res.rows[0];
  if (!proj) fail('notfound', 'Project not found.');
  if (!projectVisible(ctx, proj)) fail('forbidden', 'Outside your scope.');
  status = V.oneOf(status, ['planning', 'active', 'on_hold', 'delayed', 'completed', 'cancelled'], 'Status');

  var updated = await pool.query('UPDATE projects SET status = $1, updated_at = now() WHERE id = $2 RETURNING *', [status, id]);
  await audit(pool, ctx, 'project.update', 'project', id, 'Set ' + proj.code + ' to ' + status + '.');
  return rowToProject(updated.rows[0], { memberIds: proj.member_ids || [] });
}

module.exports = { list: list, create: create, setStatus: setStatus, projectVisible: projectVisible };
