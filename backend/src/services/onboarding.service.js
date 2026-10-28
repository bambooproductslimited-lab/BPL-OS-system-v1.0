var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Joiners and leavers (People → Joiners and leavers; migration 0199): a
// checklist for someone's first days or their last. Each step belongs to HR,
// IT, finance, their manager or the person themselves, with a day relative to
// the first (or last) day. A leaver's list also names each IT device, tool
// and asset they hold, to hand back; ticking one off frees it. The exit
// interview and the final pay (with any salary advance still owed) are steps
// too, and the last one marks them as left in the directory. Someone hired
// from Recruitment gets their first-day list by themselves.

var OWNERS = ['hr', 'it', 'finance', 'manager', 'person'];
// Who else may tick a team's steps: holders of these.
var OWNER_PERMS = { hr: ['onboard.manage'], it: ['itdevice.manage'], finance: ['payroll.manage'] };
var REASONS = ['resigned', 'end_of_contract', 'dismissed', 'retired', 'other'];
var DAY = /^\d{4}-\d{2}-\d{2}$/;

// The built-in steps, used until a company keeps its own.
var DEFAULTS = {
  join: [
    { title: 'Contract signed and filed', owner: 'hr', days: -3 },
    { title: 'Email and OS account set up', owner: 'it', days: -1 },
    { title: 'Ghana Card, SSNIT number and TIN recorded', owner: 'hr', days: 0 },
    { title: 'Bank or MoMo details for pay', owner: 'finance', days: 0 },
    { title: 'Laptop, phone or tools handed over', owner: 'it', days: 0 },
    { title: 'Welcome and a tour of the workplace', owner: 'manager', days: 0 },
    { title: 'A buddy for the first weeks', owner: 'manager', days: 0 },
    { title: 'Add a photo and an emergency contact in My space', owner: 'person', days: 1 },
    { title: 'Fire safety and first aid briefing', owner: 'hr', days: 2 },
    { title: 'Read the staff handbook', owner: 'person', days: 5 },
    { title: 'First-month check-in', owner: 'manager', days: 30 }
  ],
  leave: [
    { title: 'Resignation or notice letter filed', owner: 'hr', days: -14 },
    { title: 'Handover of work and passwords', owner: 'manager', days: -5 },
    { title: 'Exit interview', owner: 'hr', days: -2, kind: 'exit_interview' },
    { title: 'Final pay worked out', owner: 'finance', days: 0, kind: 'final_pay' },
    { title: 'Email and OS account closed', owner: 'it', days: 0 },
    { title: 'Certificate of service', owner: 'hr', days: 3 },
    { title: 'Marked as left in the employee directory', owner: 'hr', days: 0, kind: 'mark_left' }
  ]
};
var STEP_KINDS = ['task', 'final_pay', 'exit_interview', 'mark_left'];

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function need(ctx) { if (!ctx.can('onboard.manage')) fail('forbidden', 'Your role does not allow this action (onboard.manage).'); }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }

function cleanSteps(list) {
  return (Array.isArray(list) ? list : []).map(function (s) {
    var days = Math.round(Number(s && s.days));
    return { title: text(s && s.title, 120), owner: OWNERS.indexOf(s && s.owner) >= 0 ? s.owner : 'hr', days: days >= -90 && days <= 365 ? days : 0, kind: STEP_KINDS.indexOf(s && s.kind) >= 0 ? s.kind : 'task' };
  }).filter(function (s) { return s.title.length >= 3; }).slice(0, 40);
}
// The steps a company uses: its own, else everyone's, else the built-in.
async function stepsFor(kind, companyId) {
  var rows = (await pool.query('SELECT company_id, steps FROM onboard_templates WHERE kind = $1 AND (company_id = $2 OR company_id IS NULL)', [kind, companyId || null])).rows;
  var own = rows.find(function (r) { return companyId && r.company_id === companyId; }) || rows.find(function (r) { return !r.company_id; });
  return own ? cleanSteps(own.steps) : DEFAULTS[kind].map(function (s) { return Object.assign({ kind: 'task' }, s); });
}

async function employeeOf(id) {
  var e = (await pool.query('SELECT e.*, d.company_id, d.manager_id AS dept_manager, d.name AS department, c.name AS company FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id WHERE e.id = $1', [uuidOr(id)])).rows[0];
  if (!e) fail('invalid', 'Pick someone on the staff.');
  return e;
}
function managerOf(e) {
  if (e.manager_id && e.manager_id !== e.id) return e.manager_id;
  if (e.dept_manager && e.dept_manager !== e.id) return e.dept_manager;
  return null;
}

// What a leaver holds: IT devices, tools out of the tool room, assets,
// uniforms and protective kit (ppe.service.js).
async function heldBy(empId) {
  var devices = (await pool.query("SELECT id, device_tag, category, brand, model FROM it_devices WHERE assigned_employee_id = $1 AND status NOT IN ('retired', 'lost') ORDER BY device_tag", [empId])).rows;
  var tools = (await pool.query("SELECT id, code, name FROM tool_room_items WHERE checked_out_to = $1 AND status = 'checked_out' ORDER BY code", [empId])).rows;
  var assets = (await pool.query("SELECT id, asset_no, description FROM assets WHERE assigned_employee_id = $1 AND status <> 'retired' ORDER BY asset_no", [empId])).rows;
  return {
    devices: devices.map(function (d) { return { id: d.id, label: [d.device_tag, [d.brand, d.model].filter(Boolean).join(' ') || d.category].filter(Boolean).join(' · ') }; }),
    tools: tools.map(function (t) { return { id: t.id, label: [t.code, t.name].filter(Boolean).join(' · ') }; }),
    assets: assets.map(function (a) { return { id: a.id, label: a.asset_no + ' · ' + a.description }; }),
    ppe: await require('./ppe.service').heldBy(empId)
  };
}

// Whether this person may tick a step off.
async function canTick(ctx, step, list) {
  if (ctx.can('onboard.manage')) return true;
  if (step.assignee_id && step.assignee_id === me(ctx)) return true;
  if (OWNER_PERMS[step.owner] && OWNER_PERMS[step.owner].some(function (p) { return ctx.can(p); })) return true;
  return false;
}

function stepOut(s, list, ctx, can) {
  var due = dayText(s.due_on);
  return {
    id: s.id, seq: s.seq, title: s.title, owner: s.owner, kind: s.kind, refId: s.ref_id, note: s.note,
    assignee: s.assignee_id ? { id: s.assignee_id, name: nameOf(s.a_first, s.a_last) } : null,
    dueOn: due, done: !!s.done_at, doneAt: s.done_at, doneBy: nameOf(s.d_first, s.d_last),
    late: !s.done_at && list.status === 'open' && due < today(), canTick: !!can
  };
}

var LIST_SEL = 'SELECT l.*, e.first_name, e.last_name, e.code, e.position_title, e.photo_key, e.photo_updated_at, e.hire_date, e.status AS emp_status, e.manager_id, d.name AS department, c.name AS company, c.id AS company_id, ' +
  "(SELECT count(*)::int FROM onboard_steps s WHERE s.list_id = l.id) AS total, (SELECT count(*)::int FROM onboard_steps s WHERE s.list_id = l.id AND s.done_at IS NOT NULL) AS done, " +
  "(SELECT count(*)::int FROM onboard_steps s WHERE s.list_id = l.id AND s.done_at IS NULL AND s.due_on < current_date) AS late, " +
  "(SELECT min(s.due_on) FROM onboard_steps s WHERE s.list_id = l.id AND s.done_at IS NULL) AS next_due " +
  'FROM onboard_lists l JOIN employees e ON e.id = l.employee_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id ';
function listOut(l) {
  return {
    id: l.id, kind: l.kind, day: dayText(l.day), reason: l.reason, status: l.status, createdAt: l.created_at, doneAt: l.done_at,
    employee: { id: l.employee_id, name: nameOf(l.first_name, l.last_name), code: l.code, position: l.position_title || '', department: l.department || '', company: l.company || '', companyId: l.company_id || null, photo: !!l.photo_key, status: l.emp_status },
    total: l.total, done: l.done, late: l.late, nextDue: dayText(l.next_due),
    daysTo: Math.round((Date.parse(dayText(l.day) + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000)
  };
}

// GET /api/onboarding — the open lists (and those done lately), who is
// starting or leaving soon, who was hired without one.
async function overview(ctx) {
  need(ctx);
  var lists = (await pool.query(LIST_SEL + "WHERE l.status = 'open' OR (l.status = 'done' AND l.done_at > now() - interval '45 days') ORDER BY l.status, l.day")).rows.map(listOut);
  var open = lists.filter(function (l) { return l.status === 'open'; });
  var week = addDays(today(), 7);
  // Hired lately or starting soon, with no first-day list.
  var noList = (await pool.query(
    "SELECT e.id, e.first_name, e.last_name, e.position_title, e.hire_date, c.name AS company FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id " +
    "WHERE e.status = 'active' AND e.hire_date >= current_date - 45 AND NOT EXISTS (SELECT 1 FROM onboard_lists l WHERE l.employee_id = e.id AND l.kind = 'join') ORDER BY e.hire_date DESC LIMIT 20")).rows.map(function (e) {
    return { id: e.id, name: nameOf(e.first_name, e.last_name), position: e.position_title || '', company: e.company || '', hireDate: dayText(e.hire_date) };
  });
  var people = (await pool.query("SELECT e.id, e.first_name, e.last_name, e.position_title, e.hire_date, c.name AS company FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id WHERE e.status = 'active' ORDER BY e.first_name, e.last_name")).rows.map(function (e) {
    return { id: e.id, name: nameOf(e.first_name, e.last_name), position: e.position_title || '', company: e.company || '', hireDate: dayText(e.hire_date) };
  });
  var companies = (await pool.query('SELECT id, name FROM companies ORDER BY name')).rows;
  var tpl = {};
  for (var i = 0; i < companies.length; i++) tpl[companies[i].id] = { join: await stepsFor('join', companies[i].id), leave: await stepsFor('leave', companies[i].id) };
  return {
    lists: lists, noList: noList, people: people, companies: companies, owners: OWNERS, reasons: REASONS,
    templates: { all: { join: await stepsFor('join', null), leave: await stepsFor('leave', null) }, byCompany: tpl },
    summary: {
      joining: open.filter(function (l) { return l.kind === 'join'; }).length,
      leaving: open.filter(function (l) { return l.kind === 'leave'; }).length,
      thisWeek: open.filter(function (l) { return l.day >= today() && l.day <= week; }).length,
      late: open.reduce(function (a, l) { return a + l.late; }, 0),
      noList: noList.length
    }
  };
}

// GET /api/onboarding/:id — one person's list: steps by owner, what they
// hold, the final pay, the exit interview.
async function get(ctx, id) {
  var l = (await pool.query(LIST_SEL + 'WHERE l.id = $1', [uuidOr(id)])).rows[0];
  if (!l) fail('notfound', 'That checklist is gone.');
  var steps = (await pool.query(
    'SELECT s.*, a.first_name AS a_first, a.last_name AS a_last, d.first_name AS d_first, d.last_name AS d_last FROM onboard_steps s ' +
    'LEFT JOIN employees a ON a.id = s.assignee_id LEFT JOIN employees d ON d.id = s.done_by WHERE s.list_id = $1 ORDER BY s.due_on, s.seq', [l.id])).rows;
  var mine = steps.some(function (s) { return (s.assignee_id && s.assignee_id === me(ctx)) || (OWNER_PERMS[s.owner] && OWNER_PERMS[s.owner].some(function (k) { return ctx.can(k); })); });
  if (!ctx.can('onboard.manage') && !mine && l.employee_id !== me(ctx) && l.manager_id !== me(ctx)) fail('forbidden', 'That checklist is not yours to see.');
  var out = listOut(l);
  out.steps = [];
  for (var i = 0; i < steps.length; i++) out.steps.push(stepOut(steps[i], l, ctx, l.status === 'open' && await canTick(ctx, steps[i], l)));
  out.exit = l.exit || null;
  out.canManage = ctx.can('onboard.manage');
  if (l.kind === 'leave' && ctx.can('onboard.manage')) {
    var adv = (await pool.query("SELECT coalesce(sum(amount - repaid), 0) AS owed, count(*)::int AS n FROM salary_advances WHERE employee_id = $1 AND status = 'paid' AND amount > repaid", [l.employee_id])).rows[0];
    var last = (await pool.query("SELECT pr.run_no, pr.period_end, s.net_pay FROM payslips s JOIN pay_runs pr ON pr.id = s.pay_run_id WHERE s.employee_id = $1 AND pr.status IN ('approved', 'paid') ORDER BY pr.period_end DESC LIMIT 1", [l.employee_id])).rows[0];
    out.finalPay = { advanceOwed: Math.round(Number(adv.owed) * 100) / 100, advances: adv.n, lastRun: last ? { runNo: last.run_no, periodEnd: dayText(last.period_end), net: Number(last.net_pay) } : null };
  }
  return out;
}

// POST /api/onboarding { employeeId, kind, day, reason } — start a list.
// opts.system: started by the OS itself (a hire from Recruitment).
async function start(ctx, p, opts) {
  opts = opts || {};
  if (!opts.system) need(ctx);
  p = p || {};
  var kind = p.kind === 'leave' ? 'leave' : 'join';
  var e = await employeeOf(p.employeeId);
  if (e.status !== 'active') fail('invalid', 'They are not on the active staff.');
  var day = DAY.test(String(p.day || '')) ? p.day : kind === 'join' ? dayText(e.hire_date) || today() : null;
  if (!day) fail('invalid', 'Which is their last day?');
  var reason = kind === 'leave' ? (REASONS.indexOf(p.reason) >= 0 ? p.reason : 'other') : '';
  if ((await pool.query("SELECT 1 FROM onboard_lists WHERE employee_id = $1 AND kind = $2 AND status = 'open'", [e.id, kind])).rows[0]) fail('conflict', kind === 'join' ? 'Their first-day checklist is open already.' : 'Their leaving checklist is open already.');
  var template = await stepsFor(kind, e.company_id);
  var held = kind === 'leave' ? await heldBy(e.id) : { devices: [], tools: [], assets: [], ppe: [] };
  var manager = managerOf(e);
  var rows = [];
  template.forEach(function (s) { rows.push({ title: s.title, owner: s.owner, due: addDays(day, s.days), kind: s.kind || 'task', ref: null }); });
  held.devices.forEach(function (d) { rows.push({ title: 'Hand back ' + d.label, owner: 'it', due: day, kind: 'device', ref: d.id }); });
  held.tools.forEach(function (t) { rows.push({ title: 'Hand back ' + t.label, owner: 'manager', due: day, kind: 'tool', ref: t.id }); });
  held.assets.forEach(function (a) { rows.push({ title: 'Hand back ' + a.label, owner: 'manager', due: day, kind: 'asset', ref: a.id }); });
  held.ppe.forEach(function (x) { rows.push({ title: 'Hand back ' + x.label, owner: 'hr', due: day, kind: 'ppe', ref: x.id }); });
  // A joiner signs the policies that apply to them (ticked when they do).
  if (kind === 'join') (await require('./policies.service').forJoiner(e.id)).forEach(function (x) { rows.push({ title: 'Read and sign: ' + x.title, owner: 'person', due: addDays(day, Math.min(x.sign_days, 14)), kind: 'policy', ref: x.id }); });
  var listId = await withTransaction(async function (db) {
    var l = (await db.query('INSERT INTO onboard_lists (employee_id, kind, day, reason, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [e.id, kind, day, reason, me(ctx)])).rows[0];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var assignee = r.owner === 'person' ? e.id : r.owner === 'manager' ? manager : null;
      await db.query('INSERT INTO onboard_steps (list_id, seq, title, owner, assignee_id, due_on, kind, ref_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [l.id, i + 1, r.title, r.owner, assignee, r.due, r.kind, r.ref]);
    }
    return l.id;
  });
  // Each person with steps is told how many are theirs.
  var who = nameOf(e.first_name, e.last_name);
  var title = (kind === 'join' ? '🧳 Starting ' + day + ': ' : '👋 Leaving ' + day + ': ') + who;
  var counts = {};
  var bump = function (id) { if (id && id !== me(ctx)) counts[id] = (counts[id] || 0) + 1; };
  rows.forEach(function (r) {
    if (r.owner === 'person') bump(kind === 'join' ? e.id : null);
    else if (r.owner === 'manager') bump(manager);
  });
  var teams = {};
  rows.forEach(function (r) { if (OWNER_PERMS[r.owner]) teams[r.owner] = (teams[r.owner] || 0) + 1; });
  var staffAlerts = require('./staffAlerts.service');
  for (var owner in teams) {
    var holders = await staffAlerts.holdersOf(OWNER_PERMS[owner]);
    holders.forEach(function (h) { if (h.employee_id !== me(ctx) && h.employee_id !== e.id) counts[h.employee_id] = (counts[h.employee_id] || 0) + teams[owner]; });
  }
  for (var id in counts) await notify(pool, id, title, counts[id] === 1 ? '1 step on their checklist is yours.' : counts[id] + ' steps on their checklist are yours.', id === e.id ? '/myspace' : '/onboarding?list=' + listId);
  await audit(pool, ctx, 'onboard.start', 'employee', e.id, (kind === 'join' ? 'First-day checklist for ' : 'Leaving checklist for ') + who + ', ' + day + ' (' + rows.length + ' steps).');
  return opts.system ? { id: listId } : get(ctx, listId);
}

// POST /api/onboarding/steps/:id { done, note } — tick a step off (or back
// on). Handing something back frees it; the last step marks them as left.
async function tick(ctx, id, p) {
  p = p || {};
  var s = (await pool.query('SELECT s.*, l.status AS list_status, l.employee_id, l.kind AS list_kind, l.id AS list FROM onboard_steps s JOIN onboard_lists l ON l.id = s.list_id WHERE s.id = $1', [uuidOr(id)])).rows[0];
  if (!s) fail('notfound', 'That step is gone.');
  if (s.list_status === 'cancelled') fail('conflict', 'That checklist was cancelled.');
  if (!(await canTick(ctx, s, null))) fail('forbidden', 'That step is not yours to tick.');
  var done = p.done !== false;
  if (done && s.kind === 'exit_interview' && !(await pool.query('SELECT exit FROM onboard_lists WHERE id = $1', [s.list])).rows[0].exit) fail('invalid', 'Write the exit interview first.');
  if (done && s.kind === 'mark_left' && !ctx.can('employee.write')) fail('forbidden', 'Marking them as left needs employee.write.');
  if (done && s.kind === 'policy' && s.ref_id && !(await require('./policies.service').hasSigned(s.ref_id, s.employee_id))) fail('invalid', 'They sign it themselves, in My space: it ticks itself when they do.');
  await withTransaction(async function (db) {
    await db.query('UPDATE onboard_steps SET done_at = $2, done_by = $3, note = $4 WHERE id = $1', [s.id, done ? new Date() : null, done ? me(ctx) : null, p.note === undefined ? s.note : text(p.note, 300)]);
    if (done && s.ref_id) {
      if (s.kind === 'device') await db.query("UPDATE it_devices SET assigned_employee_id = NULL, assigned_at = NULL, status = CASE WHEN status = 'in_use' THEN 'in_storage' ELSE status END, updated_at = now() WHERE id = $1 AND assigned_employee_id = $2", [s.ref_id, s.employee_id]);
      if (s.kind === 'tool') await db.query("UPDATE tool_room_items SET checked_out_to = NULL, status = 'available', checked_out_at = NULL, due_back = NULL, updated_at = now() WHERE id = $1 AND checked_out_to = $2", [s.ref_id, s.employee_id]);
      if (s.kind === 'asset') await db.query('UPDATE assets SET assigned_employee_id = NULL, updated_at = now() WHERE id = $1 AND assigned_employee_id = $2', [s.ref_id, s.employee_id]);
      if (s.kind === 'ppe') await db.query("UPDATE ppe_issues SET status = 'returned', ended_on = current_date WHERE id = $1 AND employee_id = $2 AND status = 'out'", [s.ref_id, s.employee_id]);
    }
    if (done && s.kind === 'mark_left') await db.query("UPDATE employees SET status = 'terminated', updated_at = now() WHERE id = $1", [s.employee_id]);
    var left = (await db.query('SELECT count(*)::int AS n FROM onboard_steps WHERE list_id = $1 AND done_at IS NULL', [s.list])).rows[0].n;
    await db.query("UPDATE onboard_lists SET status = CASE WHEN $2 = 0 THEN 'done' ELSE 'open' END, done_at = CASE WHEN $2 = 0 THEN now() ELSE NULL END WHERE id = $1 AND status <> 'cancelled'", [s.list, left]);
  });
  await audit(pool, ctx, 'onboard.step', 'onboard_step', s.id, (done ? 'Done: ' : 'Not done: ') + s.title + '.');
  // Someone ticking a team's step may not see the whole list.
  return get(ctx, s.list).catch(function () { return { id: s.list, ok: true }; });
}

// POST /api/onboarding/:id/exit { reason, rating, rehire, comments }
async function exitInterview(ctx, id, p) {
  need(ctx);
  p = p || {};
  var l = (await pool.query("SELECT * FROM onboard_lists WHERE id = $1 AND kind = 'leave'", [uuidOr(id)])).rows[0];
  if (!l) fail('notfound', 'That leaving checklist is gone.');
  var rating = Math.round(Number(p.rating));
  var exit = { reason: text(p.reason, 200), rating: rating >= 1 && rating <= 5 ? rating : null, rehire: p.rehire === true ? true : p.rehire === false ? false : null, comments: String(p.comments == null ? '' : p.comments).trim().slice(0, 3000), by: me(ctx), at: new Date().toISOString() };
  if (exit.reason.length < 3) fail('invalid', 'Why are they leaving? A few words.');
  await pool.query('UPDATE onboard_lists SET exit = $2 WHERE id = $1', [l.id, exit]);
  var step = (await pool.query("SELECT id FROM onboard_steps WHERE list_id = $1 AND kind = 'exit_interview' AND done_at IS NULL", [l.id])).rows[0];
  if (step) await tick(ctx, step.id, { done: true });
  await audit(pool, ctx, 'onboard.exit', 'onboard_list', l.id, 'Exit interview written.');
  return get(ctx, l.id);
}

// POST /api/onboarding/:id/cancel — they did not start, or are staying.
async function cancel(ctx, id) {
  need(ctx);
  var l = (await pool.query("UPDATE onboard_lists SET status = 'cancelled' WHERE id = $1 AND status = 'open' RETURNING *", [uuidOr(id)])).rows[0];
  if (!l) fail('conflict', 'Only an open checklist can be cancelled.');
  await audit(pool, ctx, 'onboard.cancel', 'onboard_list', l.id, 'Checklist cancelled.');
  return get(ctx, l.id);
}

// PUT /api/onboarding/templates { kind, companyId, steps } — a company's
// own steps (empty: back to the built-in ones).
async function saveTemplate(ctx, p) {
  need(ctx);
  p = p || {};
  var kind = p.kind === 'leave' ? 'leave' : 'join';
  var co = uuidOr(p.companyId);
  var steps = cleanSteps(p.steps);
  await pool.query('DELETE FROM onboard_templates WHERE kind = $1 AND company_id IS NOT DISTINCT FROM $2', [kind, co]);
  if (steps.length) await pool.query('INSERT INTO onboard_templates (kind, company_id, steps, updated_by) VALUES ($1,$2,$3,$4)', [kind, co, JSON.stringify(steps), me(ctx)]);
  await audit(pool, ctx, 'onboard.template', 'company', co, (kind === 'join' ? 'First-day' : 'Leaving') + ' steps: ' + (steps.length ? steps.length + ' of their own.' : 'back to the built-in ones.'));
  return overview(ctx);
}

// GET /api/onboarding/mine — My space: the steps waiting on me, and my own
// first days.
async function mine(ctx) {
  var id = me(ctx);
  if (!id) return { steps: [], own: null };
  var perms = Object.keys(OWNER_PERMS).filter(function (o) { return OWNER_PERMS[o].some(function (p) { return ctx.can(p); }); });
  var rows = (await pool.query(
    'SELECT s.id, s.title, s.owner, s.kind, s.due_on, l.id AS list_id, l.kind AS list_kind, l.day, l.employee_id, e.first_name, e.last_name FROM onboard_steps s JOIN onboard_lists l ON l.id = s.list_id JOIN employees e ON e.id = l.employee_id ' +
    "WHERE l.status = 'open' AND s.done_at IS NULL AND l.employee_id <> $1 AND (s.assignee_id = $1 OR s.owner = ANY($2)) ORDER BY s.due_on, s.seq LIMIT 12", [id, perms])).rows;
  var steps = rows.map(function (s) { return { id: s.id, title: s.title, owner: s.owner, kind: s.kind, dueOn: dayText(s.due_on), late: dayText(s.due_on) < today(), listId: s.list_id, listKind: s.list_kind, day: dayText(s.day), person: nameOf(s.first_name, s.last_name) }; });
  var ownList = (await pool.query("SELECT * FROM onboard_lists WHERE employee_id = $1 AND kind = 'join' AND status = 'open'", [id])).rows[0];
  var own = null;
  if (ownList) {
    var ownSteps = (await pool.query('SELECT id, title, due_on, done_at, owner FROM onboard_steps WHERE list_id = $1 ORDER BY due_on, seq', [ownList.id])).rows;
    own = { listId: ownList.id, day: dayText(ownList.day), total: ownSteps.length, done: ownSteps.filter(function (s) { return s.done_at; }).length,
      steps: ownSteps.filter(function (s) { return s.owner === 'person'; }).map(function (s) { return { id: s.id, title: s.title, dueOn: dayText(s.due_on), done: !!s.done_at }; }) };
  }
  return { steps: steps, own: own };
}

// For the daily round: steps due today or late, on open lists.
async function dueSteps() {
  return (await pool.query(
    "SELECT s.id, s.title, s.owner, s.assignee_id, s.due_on, l.id AS list_id, l.kind, e.first_name, e.last_name FROM onboard_steps s JOIN onboard_lists l ON l.id = s.list_id JOIN employees e ON e.id = l.employee_id " +
    "WHERE l.status = 'open' AND s.done_at IS NULL AND s.due_on <= current_date ORDER BY s.due_on")).rows;
}

module.exports = { overview: overview, get: get, start: start, tick: tick, exitInterview: exitInterview, cancel: cancel, saveTemplate: saveTemplate, mine: mine, dueSteps: dueSteps, DEFAULTS: DEFAULTS, OWNER_PERMS: OWNER_PERMS };
