var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

// Work orders (WOs) — the tasks table, recorded the way the workshop has
// kept them in its Google Form and sheet (migration 0136): a number
// (WO-0001), who it is for (one of our companies, a customer, or a name),
// the item, quantity, specification, materials and process, a project
// manager over the team, the date issued and the estimated date due, and
// the timing the sheet worked out by hand (days to close, on time or not).

var STATUSES = ['discussing', 'not_started', 'in_progress', 'awaiting_material', 'waiting', 'under_review', 'completed', 'cancelled'];
var CLOSED = ['completed', 'cancelled'];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function dayOf(ts) { return ts ? new Date(ts).toISOString().slice(0, 10) : null; }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
function woNumber(n) { return 'WO-' + String(n).padStart(4, '0'); }
// A project closes itself when its work orders are all done, and reopens
// when one is open again (projects.service.js syncClosing); every change
// to a WO's status or project goes through here, inside its transaction.
function syncProjects(db, ctx, ids) { return require('./projects.service').syncClosing(db, ctx, ids); }

// Ported from kernel.js's taskVisible(ctx, t). The project manager sees
// their WOs too. `cache` (optional) keeps project departments and assignees
// already looked up, for list().
async function taskVisible(ctx, task, cache) {
  if (task.assigneeIds.indexOf(ctx.employee.id) >= 0) return true;
  if (task.createdBy === ctx.employee.id) return true;
  if (task.projectManagerId && task.projectManagerId === ctx.employee.id) return true;
  if (!ctx.can('task.read')) return false;
  if (ctx.can('employee.read.all')) return true;
  cache = cache || {};
  if (task.projectId) {
    cache.projects = cache.projects || {};
    if (!(task.projectId in cache.projects)) {
      var projRes = await pool.query('SELECT department_id FROM projects WHERE id = $1', [task.projectId]);
      cache.projects[task.projectId] = projRes.rows[0] ? projRes.rows[0].department_id : null;
    }
    if (cache.projects[task.projectId] && cache.projects[task.projectId] === ctx.employee.department_id) return true;
  }
  if (ctx.can('task.manage')) {
    cache.people = cache.people || {};
    var people = task.assigneeIds.concat(task.projectManagerId ? [task.projectManagerId] : []);
    for (var i = 0; i < people.length; i++) {
      if (!(people[i] in cache.people)) cache.people[people[i]] = await visibleEmployee(ctx, await fetchEmployeeById(people[i]));
      if (cache.people[people[i]]) return true;
    }
  }
  return false;
}

async function loadTask(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  var res = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  var t = res.rows[0];
  if (!t) return null;
  var assigneeRes = await pool.query('SELECT employee_id FROM task_assignees WHERE task_id = $1', [id]);
  return {
    id: t.id, woNo: t.wo_no, title: t.title, projectId: t.project_id, assigneeIds: assigneeRes.rows.map(function (r) { return r.employee_id; }),
    priority: t.priority, dueDate: t.due_date, status: t.status, createdBy: t.created_by, createdAt: t.created_at, description: t.description,
    completedAt: t.completed_at, projectManagerId: t.project_manager_id, issuedOn: t.issued_on, row: t
  };
}

// Name, photo version, department and company of every person given, in
// one query: { id: { name, photo, departmentId, companyCode } }.
async function peopleById(ids) {
  var out = {};
  var uniq = Array.from(new Set(ids.filter(Boolean)));
  if (!uniq.length) return out;
  var res = await pool.query(
    'SELECT e.id, e.first_name, e.last_name, e.photo_key, e.photo_updated_at, e.department_id, c.code AS company_code ' +
    'FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id WHERE e.id = ANY($1)',
    [uniq]
  );
  res.rows.forEach(function (e) {
    out[e.id] = {
      id: e.id, name: e.first_name + ' ' + e.last_name, departmentId: e.department_id, companyCode: e.company_code,
      photo: e.photo_key && e.photo_updated_at ? new Date(e.photo_updated_at).getTime() : null
    };
  });
  return out;
}
function person(people, id) { return people[id] || { id: id, name: '—', photo: null }; }

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

// Everything a WO row reads, with what it links to: its project, the
// company or customer it is for, the sales order (by number) and the
// catalogue product (by code, when the WO names exactly one).
var SELECT_WO =
  'SELECT t.*, p.name AS project_name, fc.code AS for_company_code, fc.name AS for_company_name, cu.name AS customer_display, ' +
  '(SELECT so.id FROM sales_orders so WHERE t.so_ref <> \'\' AND lower(so.order_no) = lower(t.so_ref) LIMIT 1) AS sales_order_id, ' +
  '(SELECT json_build_object(\'id\', pr.id, \'name\', pr.name) FROM products pr WHERE t.item_code <> \'\' AND lower(pr.sku) = lower(t.item_code) LIMIT 1) AS product, ' +
  '(SELECT array_agg(employee_id) FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_ids, ' +
  '(SELECT count(*)::int FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count ' +
  'FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN companies fc ON fc.id = t.for_company_id ' +
  'LEFT JOIN customers cu ON cu.id = t.customer_id ';

// One WO as the pages read it, with the timing the sheet worked out:
// days to close (issued → completed), the days planned (issued → due), on
// time or late, and how long an open WO has been going.
function shape(r, people) {
  var today = todayISO();
  var assigneeIds = r.assignee_ids || [];
  var assignees = assigneeIds.map(function (id) { return person(people, id); });
  var pm = r.project_manager_id ? person(people, r.project_manager_id) : null;
  var open = CLOSED.indexOf(r.status) < 0;
  var issued = r.issued_on || dayOf(r.created_at);
  var doneDay = r.status === 'completed' ? dayOf(r.completed_at) : null;
  var overdue = !!(r.due_date && r.due_date < today && open);
  var codes = assignees.map(function (a) { return a.companyCode; }).concat([r.for_company_code]).filter(Boolean);
  return {
    id: r.id, woNo: r.wo_no, number: woNumber(r.wo_no), title: r.title, description: r.description,
    projectId: r.project_id, projectName: r.project_name || '—', priority: r.priority, status: r.status,
    forCompanyId: r.for_company_id, forCompanyCode: r.for_company_code || null, forCompanyName: r.for_company_name || null,
    customerId: r.customer_id, customerName: r.customer_display || r.customer_name || '',
    requestedFor: r.for_company_name || r.customer_display || r.customer_name || '',
    contact: r.contact, soRef: r.so_ref, salesOrderId: r.sales_order_id || null,
    itemCode: r.item_code, product: r.product || null, quantity: r.quantity, specification: r.specification,
    materials: r.materials, materialQuantity: r.material_quantity, materialSpec: r.material_spec, process: r.process,
    projectManagerId: r.project_manager_id, projectManager: pm ? { id: pm.id, name: pm.name, photo: pm.photo } : null,
    pmName: pm ? pm.name : r.pm_name || '',
    assigneeIds: assigneeIds, assigneeNames: assignees.map(function (a) { return a.name; }).concat(r.team_names ? [r.team_names] : []),
    assignees: assignees.map(function (a) { return { id: a.id, name: a.name, photo: a.photo }; }), teamNames: r.team_names,
    createdBy: r.created_by, createdByName: r.prepared_by_name || person(people, r.created_by).name, preparedByName: r.prepared_by_name,
    createdAt: r.created_at, issuedOn: issued, dueDate: r.due_date, completedAt: r.completed_at, cancelledAt: r.cancelled_at,
    workers: r.workers, workDays: r.work_days === null || r.work_days === undefined ? null : Number(r.work_days),
    departmentIds: Array.from(new Set(assignees.map(function (a) { return a.departmentId; }).filter(Boolean))),
    companyCodes: Array.from(new Set(codes)),
    overdue: overdue, daysOverdue: overdue ? daysBetween(r.due_date, today) : 0,
    daysOpen: open && issued ? Math.max(0, daysBetween(issued, today)) : null,
    daysToClose: doneDay && issued ? Math.max(0, daysBetween(issued, doneDay)) : null,
    plannedDays: r.due_date && issued ? daysBetween(issued, r.due_date) : null,
    onTime: doneDay && r.due_date ? doneDay <= r.due_date : null,
    imported: !!r.sheet_stamp, commentCount: r.comment_count || 0
  };
}

async function list(ctx, params) {
  params = params || {};
  var scope = params.scope || 'mine';
  var eligibleIds = await eligibleEmployeeIds(params.companyId, params.departmentId);
  var res = await pool.query(SELECT_WO + 'ORDER BY t.due_date, t.wo_no');

  var kept = [], cache = {};
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    var assigneeIds = r.assignee_ids || [];
    var task = { id: r.id, projectId: r.project_id, createdBy: r.created_by, assigneeIds: assigneeIds, projectManagerId: r.project_manager_id };
    if (!(await taskVisible(ctx, task, cache))) continue;
    // "Mine": the WOs I am on the team of, or manage.
    if (scope === 'mine' && assigneeIds.indexOf(ctx.employee.id) < 0 && r.project_manager_id !== ctx.employee.id) continue;
    if (params.status && r.status !== params.status) continue;
    if (params.q) {
      var q = String(params.q).toLowerCase();
      if ((r.title + ' ' + woNumber(r.wo_no) + ' ' + (r.customer_name || '') + ' ' + (r.for_company_name || '')).toLowerCase().indexOf(q) < 0) continue;
    }
    if (eligibleIds && !assigneeIds.some(function (id) { return eligibleIds.has(id); })) continue;
    kept.push(r);
  }

  var people = await peopleById(kept.reduce(function (ids, r) { return ids.concat(r.assignee_ids || [], [r.created_by, r.project_manager_id]); }, []));
  return kept.map(function (r) { return shape(r, people); });
}

// kernel.js: handlers['tasks.get']
async function get(ctx, id) {
  var task = await loadTask(id);
  if (!task) fail('notfound', 'Work order not found.');
  if (!(await taskVisible(ctx, task))) fail('forbidden', 'Outside your scope.');

  var r = (await pool.query(SELECT_WO + 'WHERE t.id = $1', [id])).rows[0];
  var commentsRes = await pool.query('SELECT tc.* FROM task_comments tc WHERE tc.task_id = $1 ORDER BY tc.at', [id]);
  var people = await peopleById((r.assignee_ids || []).concat([r.created_by, r.project_manager_id], commentsRes.rows.map(function (c) { return c.author_id; })));
  return Object.assign(shape(r, people), {
    comments: commentsRes.rows.map(function (c) {
      var a = person(people, c.author_id);
      return { id: c.id, authorId: c.author_id, body: c.text, at: c.at, authorName: a.name, authorPhoto: a.photo };
    })
  });
}

// ── reading what was typed ─────────────────────────────────────────────

function opt(v, label, max) {
  v = v === null || v === undefined ? '' : String(v).trim();
  if (v.length > max) fail('invalid', label + ' must be under ' + max + ' characters.');
  return v;
}
function optNumber(v, label, max, whole) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  var n = Number(v);
  if (!isFinite(n) || n < 0 || n > max || (whole && Math.floor(n) !== n)) fail('invalid', label + ' must be a number from 0 to ' + max + '.');
  return n;
}
async function existing(table, id, label) {
  if (!id) return null;
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) fail('invalid', label + ' was not found.');
  var r = (await pool.query('SELECT id FROM ' + table + ' WHERE id = $1', [id])).rows[0];
  if (!r) fail('invalid', label + ' was not found.');
  return r.id;
}

// The WO's own fields from a create/update body; `was` (on update) fills in
// whatever the body leaves out.
async function fields(p, was) {
  was = was || {};
  function pick(key, fallback) { return p[key] !== undefined ? p[key] : was[key] !== undefined ? was[key] : fallback; }
  // With no date issued, it was issued today, or by the day it is due if that is earlier.
  var dueGiven = pick('dueDate', null);
  var issuedOn = V.date(pick('issuedOn', null) || (dueGiven && /^\d{4}-\d{2}-\d{2}$/.test(dueGiven) && dueGiven < todayISO() ? dueGiven : todayISO()), 'Date issued');
  var dueDate = V.date(dueGiven || issuedOn, 'Estimated date due');
  // An old WO from the sheet may be due before it was issued; only a new
  // WO, or a change to either date, has to put them in order.
  var datesChanged = !was.issuedOn || issuedOn !== was.issuedOn || dueDate !== was.dueDate;
  if (datesChanged && dueDate < issuedOn) fail('invalid', 'The date due can’t be before the date issued.');
  var forCompanyId = await existing('companies', pick('forCompanyId', null), 'That company');
  var customerId = forCompanyId ? null : await existing('customers', pick('customerId', null), 'That customer');
  return {
    title: V.text(pick('title', ''), 'Description of the work', 200),
    description: opt(pick('description', ''), 'Notes', 4000),
    projectId: (await existing('projects', pick('projectId', null), 'That project')) || null,
    priority: V.oneOf(pick('priority', 'medium') || 'medium', ['low', 'medium', 'high'], 'Priority'),
    issuedOn: issuedOn, dueDate: dueDate,
    forCompanyId: forCompanyId, customerId: customerId,
    customerName: forCompanyId || customerId ? '' : opt(pick('customerName', ''), 'Customer name', 120),
    contact: opt(pick('contact', ''), 'Contact', 120),
    soRef: opt(pick('soRef', ''), 'Sales order number', 40),
    itemCode: opt(pick('itemCode', ''), 'Item number', 60),
    quantity: opt(pick('quantity', ''), 'Quantity', 60),
    specification: opt(pick('specification', ''), 'Specification', 1000),
    materials: opt(pick('materials', ''), 'Material needed', 1000),
    materialQuantity: opt(pick('materialQuantity', ''), 'Material quantity', 200),
    materialSpec: opt(pick('materialSpec', ''), 'Material specification', 500),
    process: opt(pick('process', ''), 'Process', 1000),
    projectManagerId: (await existing('employees', pick('projectManagerId', null), 'That project manager')) || null,
    workers: optNumber(pick('workers', null), 'Number of workers', 500, true),
    workDays: optNumber(pick('workDays', null), 'Number of days', 3650, false)
  };
}
var COLUMNS = [
  ['title', 'title'], ['description', 'description'], ['projectId', 'project_id'], ['priority', 'priority'], ['issuedOn', 'issued_on'], ['dueDate', 'due_date'],
  ['forCompanyId', 'for_company_id'], ['customerId', 'customer_id'], ['customerName', 'customer_name'], ['contact', 'contact'], ['soRef', 'so_ref'],
  ['itemCode', 'item_code'], ['quantity', 'quantity'], ['specification', 'specification'], ['materials', 'materials'], ['materialQuantity', 'material_quantity'],
  ['materialSpec', 'material_spec'], ['process', 'process'], ['projectManagerId', 'project_manager_id'], ['workers', 'workers'], ['workDays', 'work_days']
];
// The fields of a stored WO, by the names fields() reads.
function asInput(row) {
  var out = {};
  COLUMNS.forEach(function (c) { out[c[0]] = row[c[1]]; });
  out.workDays = row.work_days === null ? null : Number(row.work_days);
  return out;
}

// A notification's link "tasks:<id>" opens that WO (NotificationsBell, sw.js).
async function tellTeam(client, ctx, ids, f, woNo, taskId) {
  for (var i = 0; i < ids.length; i++) {
    if (ids[i] !== ctx.employee.id) await notify(client, ids[i], 'New work order ' + woNumber(woNo), f.title, 'tasks:' + taskId);
  }
}

// kernel.js: handlers['tasks.create']. A new WO starts as Issued, or as
// Discussing while it is still being talked over.
async function create(ctx, p) {
  if (!ctx.can('task.manage')) fail('forbidden', 'Your role does not allow this action (task.manage).');
  var assigneeIds = (p.assigneeIds && p.assigneeIds.length) ? p.assigneeIds : [ctx.employee.id];
  for (var a = 0; a < assigneeIds.length; a++) await existing('employees', assigneeIds[a], 'A team member');
  var f = await fields(p);
  var status = V.oneOf(p.status || 'not_started', ['discussing', 'not_started'], 'Status');

  var changes = [];
  var newId = await withTransaction(async function (client) {
    var cols = COLUMNS.map(function (c) { return c[1]; }).concat(['status', 'created_by']);
    var vals = COLUMNS.map(function (c) { return f[c[0]]; }).concat([status, ctx.employee.id]);
    var res = await client.query(
      'INSERT INTO tasks (' + cols.join(', ') + ') VALUES (' + vals.map(function (_, i) { return '$' + (i + 1); }).join(',') + ') RETURNING id, wo_no, title',
      vals
    );
    var t = res.rows[0];
    for (var i = 0; i < assigneeIds.length; i++) await client.query('INSERT INTO task_assignees (task_id, employee_id) VALUES ($1,$2)', [t.id, assigneeIds[i]]);
    var told = assigneeIds.concat(f.projectManagerId && assigneeIds.indexOf(f.projectManagerId) < 0 ? [f.projectManagerId] : []);
    await tellTeam(client, ctx, told, f, t.wo_no, t.id);
    await audit(client, ctx, 'task.create', 'task', t.id, 'Issued ' + woNumber(t.wo_no) + ' "' + t.title + '".');
    changes = await syncProjects(client, ctx, [f.projectId]);
    return t.id;
  });
  // get() reads via the plain pool, so it must run after the transaction
  // above has committed — reading through `client` mid-transaction would see
  // uncommitted state on a *different* connection, hence the two-step return.
  return Object.assign(await get(ctx, newId), { projectChanges: changes });
}

// kernel.js: handlers['tasks.setStatus']
async function setStatus(ctx, id, status) {
  var task = await loadTask(id);
  if (!task) fail('notfound', 'Work order not found.');
  if (!(await taskVisible(ctx, task))) fail('forbidden', 'Outside your scope.');
  status = V.oneOf(status, STATUSES, 'Status');

  if (status === task.status) return get(ctx, id);
  var label = woNumber(task.woNo) + ' "' + task.title + '"';
  var changes = [];
  await withTransaction(async function (client) {
    // completed_at / cancelled_at record when it was closed; reopening clears them.
    await client.query(
      "UPDATE tasks SET status = $1, completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE NULL END, " +
      "cancelled_at = CASE WHEN $1 = 'cancelled' THEN now() ELSE NULL END WHERE id = $2",
      [status, id]
    );
    // Whoever issued the WO, and its project manager, hear when it is ready
    // to check or done, unless they moved it themselves.
    if (status === 'under_review' || status === 'completed') {
      var who = ctx.employee.first_name + ' ' + ctx.employee.last_name;
      var told = [task.createdBy, task.projectManagerId].filter(function (x, i, all) { return x && x !== ctx.employee.id && all.indexOf(x) === i; });
      for (var i = 0; i < told.length; i++) {
        await notify(client, told[i],
          status === 'completed' ? 'Work order completed' : 'Work order ready for checking',
          who + (status === 'completed' ? ' completed ' : ' sent ') + label + (status === 'completed' ? '.' : ' for checking.'),
          'tasks:' + id);
      }
    }
    await audit(client, ctx, 'task.status', 'task', id, 'Set ' + label + ' to ' + status + '.');
    changes = await syncProjects(client, ctx, [task.projectId]);
  });
  return Object.assign(await get(ctx, id), { projectChanges: changes });
}

// kernel.js: handlers['tasks.update']
async function update(ctx, id, p) {
  if (!ctx.can('task.manage')) fail('forbidden', 'Your role does not allow this action (task.manage).');
  var was = await loadTask(id);
  if (!was) fail('notfound', 'Work order not found.');
  if (!(await taskVisible(ctx, was))) fail('forbidden', 'Outside your scope.');

  var f = await fields(p, asInput(was.row));
  var assigneeIds = (p.assigneeIds && p.assigneeIds.length) ? p.assigneeIds : was.assigneeIds;
  for (var a = 0; a < assigneeIds.length; a++) await existing('employees', assigneeIds[a], 'A team member');

  var changes = [];
  await withTransaction(async function (client) {
    var sets = COLUMNS.map(function (c, i) { return c[1] + ' = $' + (i + 1); });
    var vals = COLUMNS.map(function (c) { return f[c[0]]; });
    // A name kept from the sheet goes once someone is picked in its place.
    if (f.projectManagerId) sets.push("pm_name = ''");
    if (p.teamNames !== undefined) { vals.push(opt(p.teamNames, 'Other team members', 300)); sets.push('team_names = $' + vals.length); }
    vals.push(id);
    await client.query('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = $' + vals.length, vals);
    await client.query('DELETE FROM task_assignees WHERE task_id = $1', [id]);
    for (var i = 0; i < assigneeIds.length; i++) await client.query('INSERT INTO task_assignees (task_id, employee_id) VALUES ($1,$2)', [id, assigneeIds[i]]);
    // Someone newly put on the WO (or made its project manager) hears about it, as on create().
    var newly = assigneeIds.concat(f.projectManagerId ? [f.projectManagerId] : []).filter(function (x, i2, all) {
      return all.indexOf(x) === i2 && was.assigneeIds.indexOf(x) < 0 && x !== was.projectManagerId;
    });
    await tellTeam(client, ctx, newly, f, was.woNo, id);
    await audit(client, ctx, 'task.update', 'task', id, 'Updated ' + woNumber(was.woNo) + ' "' + f.title + '".');
    changes = await syncProjects(client, ctx, [was.projectId, f.projectId]);
  });
  return Object.assign(await get(ctx, id), { projectChanges: changes });
}

// kernel.js: handlers['tasks.delete']
async function remove(ctx, id) {
  if (!ctx.can('task.manage')) fail('forbidden', 'Your role does not allow this action (task.manage).');
  var was = await loadTask(id);
  if (!was) fail('notfound', 'Work order not found.');
  if (!(await taskVisible(ctx, was))) fail('forbidden', 'Outside your scope.');
  var changes = await withTransaction(async function (client) {
    await client.query('DELETE FROM tasks WHERE id = $1', [id]);
    await audit(client, ctx, 'task.delete', 'task', id, 'Deleted ' + woNumber(was.woNo) + ' "' + was.title + '".');
    return syncProjects(client, ctx, [was.projectId]);
  });
  return { deleted: true, projectChanges: changes };
}

// kernel.js: handlers['tasks.addComment']
async function addComment(ctx, id, body) {
  var task = await loadTask(id);
  if (!task) fail('notfound', 'Work order not found.');
  if (!(await taskVisible(ctx, task))) fail('forbidden', 'Outside your scope.');
  body = V.text(body, 'Comment', 1000);
  var label = woNumber(task.woNo) + ' "' + task.title + '"';

  await withTransaction(async function (client) {
    await client.query('INSERT INTO task_comments (task_id, author_id, text) VALUES ($1,$2,$3)', [id, ctx.employee.id, body]);
    var told = task.assigneeIds.concat([task.projectManagerId, task.createdBy]).filter(function (x, i, all) { return x && x !== ctx.employee.id && all.indexOf(x) === i; });
    for (var i = 0; i < told.length; i++) await notify(client, told[i], 'New comment on ' + label, body.slice(0, 140), 'tasks:' + id);
    await audit(client, ctx, 'task.comment', 'task', id, 'Commented on ' + label + '.');
  });
  return get(ctx, id);
}

// Several WOs into one project at once (projectId), or out of their
// project (projectId null) — for work orders brought in from the sheet,
// which has no project column. Every WO must be one this person can see.
async function setProject(ctx, ids, projectId) {
  if (!ctx.can('task.manage')) fail('forbidden', 'Your role does not allow this action (task.manage).');
  ids = Array.isArray(ids) ? Array.from(new Set(ids.filter(Boolean).map(String))) : [];
  if (!ids.length) fail('invalid', 'Pick the work orders first.');
  if (ids.length > 2000) fail('invalid', 'Pick at most 2000 work orders at a time.');
  if (ids.some(function (id) { return !/^[0-9a-f-]{36}$/i.test(id); })) fail('invalid', 'A work order picked was not found.');
  var project = null;
  if (projectId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(projectId))) fail('invalid', 'That project was not found.');
    project = (await pool.query('SELECT p.*, (SELECT array_agg(employee_id) FROM project_members pm WHERE pm.project_id = p.id) AS member_ids FROM projects p WHERE p.id = $1', [projectId])).rows[0];
    if (!project) fail('invalid', 'That project was not found.');
    if (!require('./projects.service').projectVisible(ctx, project)) fail('forbidden', 'That project is outside your scope.');
  }
  var rows = (await pool.query(
    'SELECT t.id, t.project_id, t.created_by, t.project_manager_id, (SELECT array_agg(employee_id) FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_ids FROM tasks t WHERE t.id = ANY($1)',
    [ids])).rows;
  if (rows.length !== ids.length) fail('invalid', 'A work order picked was not found.');
  var cache = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!(await taskVisible(ctx, { id: r.id, projectId: r.project_id, createdBy: r.created_by, assigneeIds: r.assignee_ids || [], projectManagerId: r.project_manager_id }, cache))) {
      fail('forbidden', 'A work order picked is outside your scope.');
    }
  }
  var changes = [];
  var n = await withTransaction(async function (client) {
    var res = await client.query('UPDATE tasks SET project_id = $1 WHERE id = ANY($2) AND project_id IS DISTINCT FROM $1', [project ? project.id : null, ids]);
    // The projects they left, and the one they joined.
    if (res.rowCount) changes = await syncProjects(client, ctx, rows.map(function (r) { return r.project_id; }).concat(project ? [project.id] : []));
    if (res.rowCount) await audit(client, ctx, 'task.project', 'task', project ? project.id : 'none',
      project ? 'Added ' + res.rowCount + ' work orders to ' + project.code + ' — ' + project.name + '.' : 'Took ' + res.rowCount + ' work orders out of their project.');
    return res.rowCount;
  });
  return { updated: n, project: project ? { id: project.id, code: project.code, name: project.name } : null, projectChanges: changes };
}

// What the WO form offers to pick from: our companies, customers and staff.
async function options(ctx) {
  if (!ctx.can('task.manage')) fail('forbidden', 'Your role does not allow this action (task.manage).');
  var companies = (await pool.query("SELECT id, code, name FROM companies WHERE status = 'active' ORDER BY (code = 'BPL') DESC, name")).rows;
  var customers = (await pool.query("SELECT id, name FROM customers WHERE status = 'active' ORDER BY lower(name) LIMIT 5000")).rows;
  return { companies: companies, customers: customers };
}

module.exports = {
  list: list, get: get, create: create, setStatus: setStatus, update: update, remove: remove, addComment: addComment,
  options: options, setProject: setProject, taskVisible: taskVisible, woNumber: woNumber, STATUSES: STATUSES
};
