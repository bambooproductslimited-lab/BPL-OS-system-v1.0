var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

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

// Name and photo version of every person given, in one query.
async function peopleById(ids) {
  var out = {};
  var uniq = Array.from(new Set((ids || []).filter(Boolean)));
  if (!uniq.length) return out;
  var res = await pool.query('SELECT id, first_name, last_name, photo_key, photo_updated_at FROM employees WHERE id = ANY($1)', [uniq]);
  res.rows.forEach(function (e) {
    out[e.id] = { id: e.id, name: e.first_name + ' ' + e.last_name, photo: e.photo_key && e.photo_updated_at ? new Date(e.photo_updated_at).getTime() : null };
  });
  return out;
}
function person(people, id) { return people[id] || { id: id, name: '—', photo: null }; }

// kernel.js: handlers['projects.list'] — params.companyId/departmentId
// filter on the project's own department (each project has exactly one,
// unlike Tasks' multi-assignee shape), same pattern as Attendance/Leave.
async function list(ctx, params) {
  if (!ctx.can('project.read')) fail('forbidden', 'Your role does not allow this action (project.read).');
  var res = await pool.query(
    'SELECT p.*, o.first_name AS owner_first, o.last_name AS owner_last, d.name AS dept_name, d.company_id, c.name AS company_name, ' +
    "(SELECT array_agg(employee_id) FROM project_members pm WHERE pm.project_id = p.id) AS member_ids, " +
    '(SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id) AS task_count, ' +
    "(SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed') AS done_count, " +
    "(SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'cancelled') AS cancelled_count, " +
    "(SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('completed','cancelled') AND t.due_date < CURRENT_DATE) AS overdue_task_count, " +
    "(SELECT to_char(min(t.due_date), 'YYYY-MM-DD') FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('completed','cancelled')) AS next_task_due, " +
    'c.code AS company_code ' +
    'FROM projects p JOIN employees o ON o.id = p.owner_id JOIN departments d ON d.id = p.department_id ' +
    'JOIN companies c ON c.id = d.company_id ' +
    'ORDER BY p.code'
  );
  var rows = res.rows
    .filter(function (r) { return projectVisible(ctx, r); })
    .filter(function (r) { return !(params && params.companyId) || r.company_id === params.companyId; })
    .filter(function (r) { return !(params && params.departmentId) || r.department_id === params.departmentId; });
  var people = await peopleById(rows.reduce(function (ids, r) { return ids.concat([r.owner_id], r.member_ids || []); }, []));
  return rows.map(function (r) {
    return rowToProject(r, {
      ownerName: r.owner_first + ' ' + r.owner_last, ownerPhoto: person(people, r.owner_id).photo,
      members: (r.member_ids || []).map(function (id) { return person(people, id); }),
      departmentName: r.dept_name, companyId: r.company_id, companyName: r.company_name, companyCode: r.company_code,
      taskCount: r.task_count, doneCount: r.done_count, cancelledCount: r.cancelled_count,
      overdueTaskCount: r.overdue_task_count, nextTaskDue: r.next_task_due
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
    if (memberIds[i] !== ctx.employee.id) await notify(pool, memberIds[i], 'Added to a project', proj.code + ' — ' + proj.name, 'projects');
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

// kernel.js: handlers['projects.get'] — one project with its people and
// its tasks (the ones the viewer may see), for the project window.
async function get(ctx, id) {
  if (!ctx.can('project.read')) fail('forbidden', 'Your role does not allow this action (project.read).');
  var res = await pool.query(
    'SELECT p.*, d.name AS dept_name, c.id AS company_id, c.name AS company_name, c.code AS company_code, ' +
    '(SELECT array_agg(employee_id) FROM project_members pm WHERE pm.project_id = p.id) AS member_ids ' +
    'FROM projects p JOIN departments d ON d.id = p.department_id JOIN companies c ON c.id = d.company_id WHERE p.id = $1',
    [id]
  );
  var r = res.rows[0];
  if (!r) fail('notfound', 'Project not found.');
  if (!projectVisible(ctx, r)) fail('forbidden', 'Outside your scope.');

  var tasksRes = await pool.query(
    'SELECT t.id, t.title, t.status, t.priority, t.due_date, t.created_by, t.completed_at, ' +
    '(SELECT array_agg(employee_id) FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_ids ' +
    'FROM tasks t WHERE t.project_id = $1 ORDER BY t.due_date NULLS LAST, t.created_at',
    [id]
  );
  // Only the tasks this person could open anyway (tasks.service.js).
  var tasksService = require('./tasks.service');
  var visibleTasks = [];
  for (var i = 0; i < tasksRes.rows.length; i++) {
    var t = tasksRes.rows[i];
    if (await tasksService.taskVisible(ctx, { id: t.id, projectId: id, createdBy: t.created_by, assigneeIds: t.assignee_ids || [] })) visibleTasks.push(t);
  }
  var people = await peopleById([r.owner_id].concat(r.member_ids || [], visibleTasks.reduce(function (ids, t) { return ids.concat(t.assignee_ids || []); }, [])));
  var today = todayISO();
  var owner = person(people, r.owner_id);
  return rowToProject(r, {
    ownerName: owner.name, ownerPhoto: owner.photo,
    members: (r.member_ids || []).map(function (mid) { return person(people, mid); }),
    departmentName: r.dept_name, companyId: r.company_id, companyName: r.company_name, companyCode: r.company_code,
    tasks: visibleTasks.map(function (t) {
      return {
        id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.due_date, completedAt: t.completed_at,
        overdue: !!(t.due_date && t.due_date < today && ['completed', 'cancelled'].indexOf(t.status) < 0),
        assignees: (t.assignee_ids || []).map(function (aid) { return person(people, aid); })
      };
    })
  });
}

// kernel.js: handlers['projects.update'] — name, department, owner,
// members, dates, budget and description. People newly added to the
// project are told.
async function update(ctx, id, p) {
  if (!ctx.can('project.manage')) fail('forbidden', 'Your role does not allow this action (project.manage).');
  var res = await pool.query(
    'SELECT p.*, (SELECT array_agg(employee_id) FROM project_members pm WHERE pm.project_id = p.id) AS member_ids FROM projects p WHERE p.id = $1',
    [id]
  );
  var proj = res.rows[0];
  if (!proj) fail('notfound', 'Project not found.');
  if (!projectVisible(ctx, proj)) fail('forbidden', 'Outside your scope.');

  var name = V.text(p.name, 'Project name', 80);
  var departmentId = p.departmentId || proj.department_id;
  var deptRes = await pool.query('SELECT id FROM departments WHERE id = $1', [departmentId]);
  if (!deptRes.rows[0]) fail('invalid', 'Department is not a valid option.');
  var startDate = V.date(p.startDate || proj.start_date, 'Start date');
  var deadline = V.date(p.deadline || proj.deadline, 'Deadline');
  if (deadline < startDate) fail('invalid', 'The deadline cannot be before the start date.');
  var ownerId = p.ownerId || proj.owner_id;
  var budget = p.budget === undefined || p.budget === '' || p.budget === null ? Number(proj.budget) || 0 : Number(p.budget);
  if (!Number.isFinite(budget) || budget < 0) fail('invalid', 'Budget must be a number, 0 or more.');
  var memberIds = Array.isArray(p.memberIds) ? Array.from(new Set(p.memberIds.filter(Boolean))) : (proj.member_ids || []);
  var before = proj.member_ids || [];

  await withTransaction(async function (client) {
    await client.query(
      'UPDATE projects SET name = $1, department_id = $2, owner_id = $3, start_date = $4, deadline = $5, budget = $6, description = $7, updated_at = now() WHERE id = $8',
      [name, departmentId, ownerId, startDate, deadline, budget, p.description === undefined ? proj.description : String(p.description || '').trim(), id]
    );
    await client.query('DELETE FROM project_members WHERE project_id = $1', [id]);
    for (var i = 0; i < memberIds.length; i++) {
      await client.query('INSERT INTO project_members (project_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, memberIds[i]]);
      if (before.indexOf(memberIds[i]) < 0 && memberIds[i] !== ctx.employee.id) {
        await notify(client, memberIds[i], 'Added to a project', proj.code + ' — ' + name, 'projects');
      }
    }
    await audit(client, ctx, 'project.update', 'project', id, 'Updated project ' + proj.code + ' — ' + name + '.');
  });
  return get(ctx, id);
}

module.exports = { list: list, get: get, create: create, update: update, setStatus: setStatus, projectVisible: projectVisible };
