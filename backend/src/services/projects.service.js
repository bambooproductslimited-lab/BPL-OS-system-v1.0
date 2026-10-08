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
    budget: r.budget === null ? 0 : Number(r.budget), description: r.description,
    forCompanyId: r.for_company_id || null, customerId: r.customer_id || null,
    customerName: r.customer_display || r.customer_name || '',
    requestedFor: r.for_company_name || r.customer_display || r.customer_name || '',
    autoClose: !!r.auto_close, closedAt: r.closed_at || null, closedAuto: !!r.closed_auto, closedBy: r.closed_by || null,
    closedByName: r.closer_first ? r.closer_first + ' ' + r.closer_last : null
  }, extra || {});
}

// Who the project is for (migration 0137) — names to show — and how its
// work orders went: how many were completed, how many of those by their
// date due, the days each took from issued to completed, and the labour
// (workers × days) recorded on them.
var FOR_JOIN = 'LEFT JOIN companies fc ON fc.id = p.for_company_id LEFT JOIN customers cu ON cu.id = p.customer_id LEFT JOIN employees cb ON cb.id = p.closed_by ';
var FOR_COLS = 'fc.name AS for_company_name, cu.name AS customer_display, cb.first_name AS closer_first, cb.last_name AS closer_last, ';
var DONE_DAY = "(t.completed_at AT TIME ZONE 'UTC')::date";
var FIGURES_JOIN =
  'LEFT JOIN LATERAL (SELECT ' +
  "count(*) FILTER (WHERE t.status = 'completed')::int AS wo_completed, " +
  "count(*) FILTER (WHERE t.status = 'completed' AND t.completed_at IS NOT NULL AND t.due_date IS NOT NULL)::int AS wo_with_due, " +
  "count(*) FILTER (WHERE t.status = 'completed' AND t.completed_at IS NOT NULL AND t.due_date IS NOT NULL AND " + DONE_DAY + ' <= t.due_date)::int AS wo_on_time, ' +
  'avg(' + DONE_DAY + " - coalesce(t.issued_on, (t.created_at AT TIME ZONE 'UTC')::date)) FILTER (WHERE t.status = 'completed' AND t.completed_at IS NOT NULL) AS wo_avg_days, " +
  'sum(t.workers * t.work_days) FILTER (WHERE t.workers IS NOT NULL AND t.work_days IS NOT NULL) AS wo_person_days, ' +
  'count(*) FILTER (WHERE t.workers IS NOT NULL AND t.work_days IS NOT NULL)::int AS wo_labour ' +
  'FROM tasks t WHERE t.project_id = p.id) wf ON true ';
function figuresOf(r) {
  return {
    completed: r.wo_completed || 0,
    onTimePct: r.wo_with_due ? Math.round((r.wo_on_time / r.wo_with_due) * 100) : null,
    onTime: r.wo_on_time || 0, withDue: r.wo_with_due || 0,
    avgDaysToClose: r.wo_avg_days === null || r.wo_avg_days === undefined ? null : Math.round(Number(r.wo_avg_days) * 10) / 10,
    personDays: r.wo_person_days === null || r.wo_person_days === undefined ? null : Math.round(Number(r.wo_person_days) * 10) / 10,
    labourWos: r.wo_labour || 0
  };
}

// The project's "for" from a create/update body: one of our companies, or a
// customer named exactly as one on file, or just the name. Left out of the
// body, it stays as it was.
async function forOf(p, was) {
  was = was || {};
  var given = p.forCompanyId !== undefined || p.customerName !== undefined;
  if (!given) return { forCompanyId: was.for_company_id || null, customerId: was.customer_id || null, customerName: was.customer_name || '' };
  if (p.forCompanyId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(p.forCompanyId))) fail('invalid', 'That company was not found.');
    var co = (await pool.query('SELECT id FROM companies WHERE id = $1', [p.forCompanyId])).rows[0];
    if (!co) fail('invalid', 'That company was not found.');
    return { forCompanyId: co.id, customerId: null, customerName: '' };
  }
  var name = String(p.customerName || '').trim();
  if (name.length > 120) fail('invalid', 'Customer name must be under 120 characters.');
  if (!name) return { forCompanyId: null, customerId: null, customerName: '' };
  var cu = (await pool.query('SELECT id FROM customers WHERE lower(name) = lower($1) LIMIT 2', [name])).rows;
  return cu.length === 1 ? { forCompanyId: null, customerId: cu[0].id, customerName: '' } : { forCompanyId: null, customerId: null, customerName: name };
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
    'SELECT p.*, o.first_name AS owner_first, o.last_name AS owner_last, d.name AS dept_name, d.company_id, c.name AS company_name, ' + FOR_COLS + 'wf.*, ' +
    "(SELECT array_agg(employee_id) FROM project_members pm WHERE pm.project_id = p.id) AS member_ids, " +
    '(SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id) AS task_count, ' +
    "(SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed') AS done_count, " +
    "(SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'cancelled') AS cancelled_count, " +
    "(SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('completed','cancelled') AND t.due_date < CURRENT_DATE) AS overdue_task_count, " +
    "(SELECT to_char(min(t.due_date), 'YYYY-MM-DD') FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('completed','cancelled')) AS next_task_due, " +
    'c.code AS company_code ' +
    'FROM projects p JOIN employees o ON o.id = p.owner_id JOIN departments d ON d.id = p.department_id ' +
    'JOIN companies c ON c.id = d.company_id ' + FOR_JOIN + FIGURES_JOIN +
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
      overdueTaskCount: r.overdue_task_count, nextTaskDue: r.next_task_due, figures: figuresOf(r)
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
  var forWho = await forOf(p);
  var autoClose = p.autoClose === undefined ? true : !!p.autoClose;

  // The next PRJ- number after the highest one used (a count would repeat a
  // number after a delete); two saved at once, the second takes the next.
  var proj = null;
  for (var attempt = 0; attempt < 5 && !proj; attempt++) {
    var next = (await pool.query("SELECT coalesce(max(substring(code from '^PRJ-([0-9]+)$')::int), 0) + 1 + $1 AS n FROM projects", [attempt])).rows[0].n;
    proj = (await pool.query(
      "INSERT INTO projects (code, name, department_id, owner_id, start_date, deadline, status, budget, description, for_company_id, customer_id, customer_name, auto_close) " +
      "VALUES ($1,$2,$3,$4,$5,$6,'planning',$7,$8,$9,$10,$11,$12) ON CONFLICT (code) DO NOTHING RETURNING *",
      ['PRJ-' + String(next).padStart(3, '0'), name, p.departmentId, ownerId, startDate, deadline, Number(p.budget) || 0, (p.description || '').trim(), forWho.forCompanyId, forWho.customerId, forWho.customerName, autoClose]
    )).rows[0];
  }
  if (!proj) fail('conflict', 'Could not give the project a number. Try again.');
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

  // Completed or cancelled by hand: closed now, by this person. Opened again: not closed.
  var closing = status === 'completed' || status === 'cancelled';
  var updated = await pool.query(
    'UPDATE projects SET status = $1, closed_at = CASE WHEN $3::boolean THEN coalesce(CASE WHEN status IN (\'completed\', \'cancelled\') THEN closed_at END, now()) END, ' +
    'closed_by = CASE WHEN $3::boolean THEN $4::uuid END, closed_auto = false, updated_at = now() WHERE id = $2 RETURNING *',
    [status, id, closing, ctx.employee.id]);
  await audit(pool, ctx, 'project.update', 'project', id, 'Set ' + proj.code + ' to ' + status + '.');
  return rowToProject(updated.rows[0], { memberIds: proj.member_ids || [] });
}

// kernel.js: handlers['projects.get'] — one project with its people and
// its tasks (the ones the viewer may see), for the project window.
async function get(ctx, id) {
  if (!ctx.can('project.read')) fail('forbidden', 'Your role does not allow this action (project.read).');
  var res = await pool.query(
    'SELECT p.*, d.name AS dept_name, c.id AS company_id, c.name AS company_name, c.code AS company_code, ' + FOR_COLS + 'wf.*, ' +
    '(SELECT array_agg(employee_id) FROM project_members pm WHERE pm.project_id = p.id) AS member_ids ' +
    'FROM projects p JOIN departments d ON d.id = p.department_id JOIN companies c ON c.id = d.company_id ' + FOR_JOIN + FIGURES_JOIN + 'WHERE p.id = $1',
    [id]
  );
  var r = res.rows[0];
  if (!r) fail('notfound', 'Project not found.');
  if (!projectVisible(ctx, r)) fail('forbidden', 'Outside your scope.');

  var tasksRes = await pool.query(
    'SELECT t.id, t.wo_no, t.title, t.status, t.priority, t.due_date, t.created_by, t.completed_at, t.project_manager_id, ' +
    '(SELECT array_agg(employee_id) FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_ids ' +
    'FROM tasks t WHERE t.project_id = $1 ORDER BY t.due_date NULLS LAST, t.created_at',
    [id]
  );
  // Only the work orders this person could open anyway (tasks.service.js).
  var tasksService = require('./tasks.service');
  var visibleTasks = [];
  for (var i = 0; i < tasksRes.rows.length; i++) {
    var t = tasksRes.rows[i];
    if (await tasksService.taskVisible(ctx, { id: t.id, projectId: id, createdBy: t.created_by, assigneeIds: t.assignee_ids || [], projectManagerId: t.project_manager_id })) visibleTasks.push(t);
  }
  var people = await peopleById([r.owner_id].concat(r.member_ids || [], visibleTasks.reduce(function (ids, t) { return ids.concat(t.assignee_ids || []); }, [])));
  var today = todayISO();
  var owner = person(people, r.owner_id);
  return rowToProject(r, {
    ownerName: owner.name, ownerPhoto: owner.photo,
    members: (r.member_ids || []).map(function (mid) { return person(people, mid); }),
    departmentName: r.dept_name, companyId: r.company_id, companyName: r.company_name, companyCode: r.company_code,
    figures: figuresOf(r),
    tasks: visibleTasks.map(function (t) {
      return {
        id: t.id, number: tasksService.woNumber(t.wo_no), title: t.title, status: t.status, priority: t.priority, dueDate: t.due_date, completedAt: t.completed_at,
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
  var changes = [];
  var forWho = await forOf(p, proj);
  var autoClose = p.autoClose === undefined ? proj.auto_close : !!p.autoClose;

  await withTransaction(async function (client) {
    await client.query(
      'UPDATE projects SET name = $1, department_id = $2, owner_id = $3, start_date = $4, deadline = $5, budget = $6, description = $7, ' +
      'for_company_id = $9, customer_id = $10, customer_name = $11, auto_close = $12, updated_at = now() WHERE id = $8',
      [name, departmentId, ownerId, startDate, deadline, budget, p.description === undefined ? proj.description : String(p.description || '').trim(), id,
        forWho.forCompanyId, forWho.customerId, forWho.customerName, autoClose]
    );
    await client.query('DELETE FROM project_members WHERE project_id = $1', [id]);
    for (var i = 0; i < memberIds.length; i++) {
      await client.query('INSERT INTO project_members (project_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, memberIds[i]]);
      if (before.indexOf(memberIds[i]) < 0 && memberIds[i] !== ctx.employee.id) {
        await notify(client, memberIds[i], 'Added to a project', proj.code + ' — ' + name, 'projects');
      }
    }
    await audit(client, ctx, 'project.update', 'project', id, 'Updated project ' + proj.code + ' — ' + name + '.');
    // Told to close itself when its work is done, and it is: it closes now.
    changes = await syncClosing(client, ctx, [id]);
  });
  return Object.assign(await get(ctx, id), { projectChanges: changes });
}

// Where each project given stands now that its work orders have changed
// (tasks.service.js calls this inside its own transaction, `db`): one told
// to close itself (auto_close) closes once all its work orders are done —
// none open, at least one completed — and one it closed itself opens again
// when a work order in it is open again. A project closed by hand stays
// closed. The owner hears either way. Returns what changed, for the screen
// to say: [{ id, code, name, change: 'closed' | 'reopened' }].
async function syncClosing(db, ctx, ids) {
  var out = [];
  var uniq = Array.from(new Set((ids || []).filter(Boolean)));
  for (var i = 0; i < uniq.length; i++) {
    var p = (await db.query('SELECT id, code, name, status, auto_close, closed_auto, owner_id FROM projects WHERE id = $1 FOR UPDATE', [uniq[i]])).rows[0];
    if (!p) continue;
    var c = (await db.query(
      "SELECT count(*) FILTER (WHERE status = 'completed')::int AS done, count(*) FILTER (WHERE status NOT IN ('completed', 'cancelled'))::int AS open FROM tasks WHERE project_id = $1",
      [p.id])).rows[0];
    var label = p.code + ' — ' + p.name;
    if (p.auto_close && p.status !== 'completed' && p.status !== 'cancelled' && c.open === 0 && c.done > 0) {
      await db.query("UPDATE projects SET status = 'completed', closed_at = now(), closed_by = NULL, closed_auto = true, updated_at = now() WHERE id = $1", [p.id]);
      await notify(db, p.owner_id, 'Project completed', label + ': all its work orders are done, so it has closed itself.', 'projects');
      await audit(db, ctx, 'project.autoclose', 'project', p.id, 'Closed ' + label + ' by itself: all its work orders are done.');
      out.push({ id: p.id, code: p.code, name: p.name, change: 'closed' });
    } else if (p.status === 'completed' && p.closed_auto && c.open > 0) {
      await db.query("UPDATE projects SET status = 'active', closed_at = NULL, closed_by = NULL, closed_auto = false, updated_at = now() WHERE id = $1", [p.id]);
      await notify(db, p.owner_id, 'Project reopened', label + ': a work order in it is open again, so it has reopened.', 'projects');
      await audit(db, ctx, 'project.reopen', 'project', p.id, 'Reopened ' + label + ': a work order in it is open again.');
      out.push({ id: p.id, code: p.code, name: p.name, change: 'reopened' });
    }
  }
  return out;
}

// Closing a project by hand: it is completed, closed now by this person.
// Work orders still open stay as they are, or are cancelled with it
// (cancelOpen); either way the people on them are not left guessing — the
// project's owner and team see it closed.
async function close(ctx, id, p) {
  if (!ctx.can('project.manage')) fail('forbidden', 'Your role does not allow this action (project.manage).');
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('notfound', 'Project not found.');
  var proj = (await pool.query(
    'SELECT p.*, (SELECT array_agg(employee_id) FROM project_members pm WHERE pm.project_id = p.id) AS member_ids FROM projects p WHERE p.id = $1', [id])).rows[0];
  if (!proj) fail('notfound', 'Project not found.');
  if (!projectVisible(ctx, proj)) fail('forbidden', 'Outside your scope.');
  if (proj.status === 'completed' || proj.status === 'cancelled') fail('conflict', 'This project is already closed.');
  var cancelOpen = !!(p && p.cancelOpen);
  var label = proj.code + ' — ' + proj.name;
  var cancelled = 0;
  await withTransaction(async function (client) {
    if (cancelOpen) {
      cancelled = (await client.query(
        "UPDATE tasks SET status = 'cancelled', cancelled_at = now(), completed_at = NULL WHERE project_id = $1 AND status NOT IN ('completed', 'cancelled')", [id])).rowCount;
    }
    await client.query("UPDATE projects SET status = 'completed', closed_at = now(), closed_by = $2, closed_auto = false, updated_at = now() WHERE id = $1", [id, ctx.employee.id]);
    if (proj.owner_id !== ctx.employee.id) await notify(client, proj.owner_id, 'Project completed', label + ' was closed by ' + ctx.employee.first_name + ' ' + ctx.employee.last_name + '.', 'projects');
    await audit(client, ctx, 'project.close', 'project', id, 'Closed ' + label + (cancelled ? ', cancelling ' + cancelled + ' open work orders' : '') + '.');
  });
  return Object.assign(await get(ctx, id), { cancelledWorkOrders: cancelled });
}

module.exports = { list: list, get: get, create: create, update: update, setStatus: setStatus, close: close, syncClosing: syncClosing, projectVisible: projectVisible };
