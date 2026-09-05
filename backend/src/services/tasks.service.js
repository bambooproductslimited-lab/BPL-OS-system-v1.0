var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

function todayISO() { return new Date().toISOString().slice(0, 10); }

// Ported from kernel.js's taskVisible(ctx, t).
async function taskVisible(ctx, task) {
  if (task.assigneeIds.indexOf(ctx.employee.id) >= 0) return true;
  if (task.createdBy === ctx.employee.id) return true;
  if (!ctx.can('task.read')) return false;
  if (ctx.can('employee.read.all')) return true;
  if (task.projectId) {
    var projRes = await pool.query('SELECT department_id FROM projects WHERE id = $1', [task.projectId]);
    if (projRes.rows[0] && projRes.rows[0].department_id === ctx.employee.department_id) return true;
  }
  if (ctx.can('task.manage')) {
    for (var i = 0; i < task.assigneeIds.length; i++) {
      var emp = await fetchEmployeeById(task.assigneeIds[i]);
      if (await visibleEmployee(ctx, emp)) return true;
    }
  }
  return false;
}

async function loadTask(id) {
  var res = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  var t = res.rows[0];
  if (!t) return null;
  var assigneeRes = await pool.query('SELECT employee_id FROM task_assignees WHERE task_id = $1', [id]);
  return {
    id: t.id, title: t.title, projectId: t.project_id, assigneeIds: assigneeRes.rows.map(function (r) { return r.employee_id; }),
    priority: t.priority, dueDate: t.due_date, status: t.status, createdBy: t.created_by, createdAt: t.created_at, description: t.description
  };
}

// kernel.js: handlers['tasks.list'] — params.companyId/departmentId keep a
// task if AT LEAST ONE assignee belongs to that company/department (a task
// has no single department of its own — it can span several assignees
// across companies, unlike Attendance/Leave/Payroll's one-employee-per-row
// shape), resolved via a set of eligible employee ids so the check below
// stays a plain array lookup instead of a query per task.
async function eligibleEmployeeIds(companyId, departmentId) {
  if (!companyId && !departmentId) return null;
  var where = [], args = [];
  if (departmentId) { args.push(departmentId); where.push('e.department_id = $' + args.length); }
  else if (companyId) { args.push(companyId); where.push('d.company_id = $' + args.length); }
  var res = await pool.query(
    'SELECT e.id FROM employees e JOIN departments d ON d.id = e.department_id WHERE ' + where.join(' AND '),
    args
  );
  return new Set(res.rows.map(function (r) { return r.id; }));
}

async function list(ctx, params) {
  var scope = (params && params.scope) || 'mine';
  var eligibleIds = await eligibleEmployeeIds(params && params.companyId, params && params.departmentId);
  var res = await pool.query(
    'SELECT t.*, p.name AS project_name, ' +
    "(SELECT array_agg(employee_id) FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_ids, " +
    '(SELECT count(*)::int FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count ' +
    'FROM tasks t LEFT JOIN projects p ON p.id = t.project_id ORDER BY t.due_date'
  );

  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    var assigneeIds = r.assignee_ids || [];
    var task = { id: r.id, projectId: r.project_id, createdBy: r.created_by, assigneeIds: assigneeIds };
    if (!(await taskVisible(ctx, task))) continue;
    if (scope === 'mine' && assigneeIds.indexOf(ctx.employee.id) < 0) continue;
    if (params && params.status && r.status !== params.status) continue;
    if (params && params.q && r.title.toLowerCase().indexOf(String(params.q).toLowerCase()) < 0) continue;
    if (eligibleIds && !assigneeIds.some(function (id) { return eligibleIds.has(id); })) continue;

    var overdue = r.due_date && r.due_date < todayISO() && ['completed', 'cancelled'].indexOf(r.status) < 0;
    var daysOverdue = overdue ? Math.round((new Date(todayISO()) - new Date(r.due_date)) / 86400000) : 0;
    var assigneeNames = await namesFor(assigneeIds);

    out.push({
      id: r.id, title: r.title, projectId: r.project_id, priority: r.priority, dueDate: r.due_date, status: r.status,
      createdBy: r.created_by, createdAt: r.created_at, description: r.description, assigneeIds: assigneeIds,
      projectName: r.project_name || '—', assigneeNames: assigneeNames, overdue: overdue, daysOverdue: daysOverdue, commentCount: r.comment_count
    });
  }
  return out;
}

async function namesFor(employeeIds) {
  if (!employeeIds.length) return [];
  var res = await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = ANY($1)', [employeeIds]);
  var byId = {}; res.rows.forEach(function (e) { byId[e.id] = e.first_name + ' ' + e.last_name; });
  return employeeIds.map(function (id) { return byId[id] || '—'; });
}

// kernel.js: handlers['tasks.get']
async function get(ctx, id) {
  var task = await loadTask(id);
  if (!task) fail('notfound', 'Task not found.');
  if (!(await taskVisible(ctx, task))) fail('forbidden', 'Outside your scope.');

  var projRes = task.projectId ? await pool.query('SELECT name FROM projects WHERE id = $1', [task.projectId]) : { rows: [] };
  var overdue = task.dueDate && task.dueDate < todayISO() && ['completed', 'cancelled'].indexOf(task.status) < 0;
  var daysOverdue = overdue ? Math.round((new Date(todayISO()) - new Date(task.dueDate)) / 86400000) : 0;
  var assigneeNames = await namesFor(task.assigneeIds);

  var commentsRes = await pool.query(
    'SELECT tc.*, e.first_name, e.last_name FROM task_comments tc JOIN employees e ON e.id = tc.author_id WHERE tc.task_id = $1 ORDER BY tc.at',
    [id]
  );

  return Object.assign({}, task, {
    projectName: (projRes.rows[0] && projRes.rows[0].name) || '—', overdue: overdue, daysOverdue: daysOverdue, assigneeNames: assigneeNames,
    comments: commentsRes.rows.map(function (c) { return { id: c.id, authorId: c.author_id, body: c.text, at: c.at, authorName: c.first_name + ' ' + c.last_name }; })
  });
}

// kernel.js: handlers['tasks.create']
async function create(ctx, p) {
  if (!ctx.can('task.manage')) fail('forbidden', 'Your role does not allow this action (task.manage).');
  var assigneeIds = (p.assigneeIds && p.assigneeIds.length) ? p.assigneeIds : [ctx.employee.id];
  var title = V.text(p.title, 'Title', 100);
  var priority = V.oneOf(p.priority || 'medium', ['low', 'medium', 'high'], 'Priority');
  var dueDate = V.date(p.dueDate || todayISO(), 'Due date');

  var newId = await withTransaction(async function (client) {
    var res = await client.query(
      "INSERT INTO tasks (title, project_id, priority, due_date, status, created_by, description) VALUES ($1,$2,$3,$4,'not_started',$5,$6) RETURNING *",
      [title, p.projectId || null, priority, dueDate, ctx.employee.id, (p.description || '').trim()]
    );
    var t = res.rows[0];
    for (var i = 0; i < assigneeIds.length; i++) {
      await client.query('INSERT INTO task_assignees (task_id, employee_id) VALUES ($1,$2)', [t.id, assigneeIds[i]]);
      if (assigneeIds[i] !== ctx.employee.id) await notify(client, assigneeIds[i], 'New task assigned', t.title, 'tasks');
    }
    await audit(client, ctx, 'task.create', 'task', t.id, 'Created task "' + t.title + '".');
    return t.id;
  });
  // get() reads via the plain pool, so it must run after the transaction
  // above has committed — reading through `client` mid-transaction would see
  // uncommitted state on a *different* connection, hence the two-step return.
  return get(ctx, newId);
}

// kernel.js: handlers['tasks.setStatus']
async function setStatus(ctx, id, status) {
  var task = await loadTask(id);
  if (!task) fail('notfound', 'Task not found.');
  if (!(await taskVisible(ctx, task))) fail('forbidden', 'Outside your scope.');
  status = V.oneOf(status, ['not_started', 'in_progress', 'waiting', 'under_review', 'completed', 'cancelled'], 'Status');

  await pool.query('UPDATE tasks SET status = $1 WHERE id = $2', [status, id]);
  await audit(pool, ctx, 'task.status', 'task', id, 'Set "' + task.title + '" to ' + status + '.');
  return get(ctx, id);
}

// kernel.js: handlers['tasks.update']
async function update(ctx, id, p) {
  if (!ctx.can('task.manage')) fail('forbidden', 'Your role does not allow this action (task.manage).');
  var existing = await loadTask(id);
  if (!existing) fail('notfound', 'Task not found.');
  if (!(await taskVisible(ctx, existing))) fail('forbidden', 'Outside your scope.');

  var title = V.text(p.title, 'Title', 100);
  var priority = V.oneOf(p.priority || existing.priority, ['low', 'medium', 'high'], 'Priority');
  var dueDate = V.date(p.dueDate || existing.dueDate, 'Due date');
  var assigneeIds = (p.assigneeIds && p.assigneeIds.length) ? p.assigneeIds : existing.assigneeIds;

  await withTransaction(async function (client) {
    var values = [title, p.projectId || null, priority, dueDate, (p.description || '').trim(), id];
    if (p.startedDate) {
      V.date(p.startedDate, 'Date started');
      await client.query('UPDATE tasks SET created_at = $1::date + (created_at::time) WHERE id = $2', [p.startedDate, id]);
    }
    await client.query(
      'UPDATE tasks SET title = $1, project_id = $2, priority = $3, due_date = $4, description = $5 WHERE id = $6',
      values
    );
    await client.query('DELETE FROM task_assignees WHERE task_id = $1', [id]);
    for (var i = 0; i < assigneeIds.length; i++) {
      await client.query('INSERT INTO task_assignees (task_id, employee_id) VALUES ($1,$2)', [id, assigneeIds[i]]);
    }
    await audit(client, ctx, 'task.update', 'task', id, 'Updated task "' + title + '".');
  });
  return get(ctx, id);
}

// kernel.js: handlers['tasks.delete']
async function remove(ctx, id) {
  if (!ctx.can('task.manage')) fail('forbidden', 'Your role does not allow this action (task.manage).');
  var existing = await loadTask(id);
  if (!existing) fail('notfound', 'Task not found.');
  if (!(await taskVisible(ctx, existing))) fail('forbidden', 'Outside your scope.');
  await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
  await audit(pool, ctx, 'task.delete', 'task', id, 'Deleted task "' + existing.title + '".');
  return true;
}

// kernel.js: handlers['tasks.addComment']
async function addComment(ctx, id, body) {
  var task = await loadTask(id);
  if (!task) fail('notfound', 'Task not found.');
  if (!(await taskVisible(ctx, task))) fail('forbidden', 'Outside your scope.');
  body = V.text(body, 'Comment', 1000);

  await withTransaction(async function (client) {
    await client.query('INSERT INTO task_comments (task_id, author_id, text) VALUES ($1,$2,$3)', [id, ctx.employee.id, body]);
    for (var i = 0; i < task.assigneeIds.length; i++) {
      if (task.assigneeIds[i] !== ctx.employee.id) await notify(client, task.assigneeIds[i], 'New comment on "' + task.title + '"', body.slice(0, 140), 'tasks');
    }
    await audit(client, ctx, 'task.comment', 'task', id, 'Commented on "' + task.title + '".');
  });
  return get(ctx, id);
}

module.exports = { list: list, get: get, create: create, setStatus: setStatus, update: update, remove: remove, addComment: addComment, taskVisible: taskVisible };
