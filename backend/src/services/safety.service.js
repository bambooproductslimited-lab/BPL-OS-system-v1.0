var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Health and safety (People → Health and safety; migration 0199): anyone
// reports an incident or a near miss from My space, with photos; whoever
// looks after safety investigates — the cause, what was done at once — and
// sets actions with an owner and a day; it closes when they are done. Each
// company's days since its last lost-time injury, the year by kind and by
// month, the actions running late. A new report reaches safety at once; late
// actions are chased each day (jobs/dailyAlerts.js).

var KINDS = ['injury', 'near_miss', 'property_damage', 'fire', 'food_safety', 'vehicle', 'environment', 'security', 'other'];
var SEVERITIES = ['low', 'medium', 'high', 'critical'];
var TREATMENTS = ['none', 'first_aid', 'clinic', 'hospital'];
var KIND_WORDS = { injury: 'Injury', near_miss: 'Near miss', property_damage: 'Damage', fire: 'Fire', food_safety: 'Food safety', vehicle: 'Vehicle', environment: 'Environment', security: 'Security', other: 'Incident' };
var MAX_PHOTOS = 4;

function text(v, max) { return String(v == null ? '' : v).replace(/[ \t]+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function need(ctx) { if (!ctx.can('safety.manage')) fail('forbidden', 'Your role does not allow this action (safety.manage).'); }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
// Lost time: someone off work afterwards, or taken to hospital.
function lostTime(i) { return i.kind === 'injury' && (Number(i.lost_days) > 0 || i.treatment === 'hospital'); }

var SEL = 'SELECT i.*, c.name AS company, j.first_name AS j_first, j.last_name AS j_last, r.first_name AS r_first, r.last_name AS r_last, v.first_name AS v_first, v.last_name AS v_last, ' +
  "(SELECT count(*)::int FROM incident_actions a WHERE a.incident_id = i.id) AS actions, (SELECT count(*)::int FROM incident_actions a WHERE a.incident_id = i.id AND a.done_at IS NULL) AS open_actions, " +
  "(SELECT count(*)::int FROM incident_actions a WHERE a.incident_id = i.id AND a.done_at IS NULL AND a.due_on < current_date) AS late_actions " +
  'FROM incidents i LEFT JOIN companies c ON c.id = i.company_id LEFT JOIN employees j ON j.id = i.injured_id LEFT JOIN employees r ON r.id = i.reported_by LEFT JOIN employees v ON v.id = i.investigator_id ';
function incidentOut(i) {
  return {
    id: i.id, number: i.number, ref: 'HS-' + String(i.number).padStart(4, '0'), kind: i.kind, severity: i.severity, status: i.status,
    occurredAt: i.occurred_at, location: i.location, description: i.description, company: i.company || '', companyId: i.company_id,
    injured: i.injured_id ? { id: i.injured_id, name: nameOf(i.j_first, i.j_last) } : i.injured_name ? { id: null, name: i.injured_name } : null,
    injury: i.injury, treatment: i.treatment, lostDays: i.lost_days, lostTime: lostTime(i),
    photos: (i.photos || []).length, immediateAction: i.immediate_action, rootCause: i.root_cause,
    reportedBy: i.reported_by ? { id: i.reported_by, name: nameOf(i.r_first, i.r_last) } : null,
    investigator: i.investigator_id ? { id: i.investigator_id, name: nameOf(i.v_first, i.v_last) } : null,
    actions: i.actions, openActions: i.open_actions, lateActions: i.late_actions, closedAt: i.closed_at, createdAt: i.created_at
  };
}

// GET /api/safety?company=&status= — the counters, the year, the list.
async function overview(ctx, q) {
  need(ctx);
  q = q || {};
  var company = uuidOr(q.company);
  var status = ['open', 'closed', 'all'].indexOf(q.status) >= 0 ? q.status : 'all';
  var where = [], args = [];
  if (company) { args.push(company); where.push('i.company_id = $' + args.length); }
  if (status === 'open') where.push("i.status <> 'closed'");
  if (status === 'closed') where.push("i.status = 'closed'");
  var list = (await pool.query(SEL + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY i.occurred_at DESC LIMIT 200', args)).rows.map(incidentOut);
  var companies = (await pool.query('SELECT id, name, code FROM companies ORDER BY name')).rows;
  // Days since the last lost-time injury, each company.
  var lti = (await pool.query("SELECT company_id, max(occurred_at) AS at FROM incidents WHERE kind = 'injury' AND (lost_days > 0 OR treatment = 'hospital') GROUP BY 1")).rows;
  var firstDay = (await pool.query('SELECT company_id, min(occurred_at) AS at FROM incidents GROUP BY 1')).rows;
  var counters = companies.map(function (c) {
    var last = lti.find(function (r) { return r.company_id === c.id; });
    var first = firstDay.find(function (r) { return r.company_id === c.id; });
    return { companyId: c.id, company: c.name, lastLostTime: last ? dayText(last.at) : null, clean: !last, days: last ? daysBetween(dayText(last.at), today()) : first ? daysBetween(dayText(first.at), today()) : null, since: first ? dayText(first.at) : null };
  }).filter(function (c) { return c.since; });
  // The last twelve months by kind: injuries, near misses, the rest.
  var start = new Date(); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 11);
  var from = start.toISOString().slice(0, 10);
  var mArgs = [from].concat(company ? [company] : []);
  var byMonth = (await pool.query("SELECT to_char(occurred_at, 'YYYY-MM') AS m, kind, count(*)::int AS n FROM incidents WHERE occurred_at >= $1" + (company ? ' AND company_id = $2' : '') + ' GROUP BY 1, 2', mArgs)).rows;
  var months = [];
  for (var k = 0; k < 12; k++) {
    var d = new Date(start); d.setUTCMonth(start.getUTCMonth() + k);
    var key = d.toISOString().slice(0, 7);
    var rows = byMonth.filter(function (r) { return r.m === key; });
    var sum = function (f) { return rows.filter(f).reduce(function (a, r) { return a + r.n; }, 0); };
    months.push({ month: key, injury: sum(function (r) { return r.kind === 'injury'; }), nearMiss: sum(function (r) { return r.kind === 'near_miss'; }), other: sum(function (r) { return r.kind !== 'injury' && r.kind !== 'near_miss'; }) });
  }
  var yArgs = company ? [company] : [];
  var year = (await pool.query("SELECT kind, count(*)::int AS n, coalesce(sum(lost_days), 0)::int AS lost FROM incidents WHERE occurred_at >= date_trunc('year', now())" + (company ? ' AND company_id = $1' : '') + ' GROUP BY 1', yArgs)).rows;
  var actions = (await pool.query(
    'SELECT a.*, i.number, i.kind, i.id AS incident, o.first_name, o.last_name FROM incident_actions a JOIN incidents i ON i.id = a.incident_id LEFT JOIN employees o ON o.id = a.owner_id ' +
    'WHERE a.done_at IS NULL' + (company ? ' AND i.company_id = $1' : '') + ' ORDER BY a.due_on LIMIT 30', yArgs)).rows.map(function (a) {
    return { id: a.id, title: a.title, dueOn: dayText(a.due_on), late: dayText(a.due_on) < today(), owner: nameOf(a.first_name, a.last_name), incidentId: a.incident, ref: 'HS-' + String(a.number).padStart(4, '0'), kind: a.kind };
  });
  var people = (await pool.query("SELECT e.id, e.first_name, e.last_name, c.name AS company FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id WHERE e.status = 'active' ORDER BY e.first_name, e.last_name")).rows.map(function (p) {
    return { id: p.id, name: nameOf(p.first_name, p.last_name), company: p.company || '' };
  });
  var yearTotal = year.reduce(function (a, r) { return a + r.n; }, 0);
  var injuries = year.filter(function (r) { return r.kind === 'injury'; }).reduce(function (a, r) { return a + r.n; }, 0);
  var near = year.filter(function (r) { return r.kind === 'near_miss'; }).reduce(function (a, r) { return a + r.n; }, 0);
  return {
    companies: companies, company: company || '', status: status, incidents: list, counters: counters, months: months, actions: actions, people: people,
    kinds: KINDS, severities: SEVERITIES, treatments: TREATMENTS,
    summary: {
      year: yearTotal, injuries: injuries, nearMisses: near, lostDays: year.reduce(function (a, r) { return a + r.lost; }, 0),
      open: list.filter(function (i) { return i.status !== 'closed'; }).length, fresh: list.filter(function (i) { return i.status === 'new'; }).length,
      openActions: actions.length, lateActions: actions.filter(function (a) { return a.late; }).length,
      // Near misses reported for each injury: the more, the better people look out.
      nearPerInjury: injuries ? Math.round(near / injuries * 10) / 10 : null
    }
  };
}

async function incidentOf(id) {
  var i = (await pool.query(SEL + 'WHERE i.id = $1', [uuidOr(id)])).rows[0];
  if (!i) fail('notfound', 'That report is gone.');
  return i;
}
function canSee(ctx, i) { return ctx.can('safety.manage') || i.reported_by === me(ctx) || i.injured_id === me(ctx); }

// GET /api/safety/:id
async function get(ctx, id) {
  var i = await incidentOf(id);
  if (!canSee(ctx, i)) fail('forbidden', 'That report is not yours to see.');
  var out = incidentOut(i);
  out.actionList = (await pool.query('SELECT a.*, o.first_name, o.last_name, d.first_name AS d_first, d.last_name AS d_last FROM incident_actions a LEFT JOIN employees o ON o.id = a.owner_id LEFT JOIN employees d ON d.id = a.done_by WHERE a.incident_id = $1 ORDER BY a.due_on, a.created_at', [i.id])).rows.map(function (a) {
    return { id: a.id, title: a.title, owner: a.owner_id ? { id: a.owner_id, name: nameOf(a.first_name, a.last_name) } : null, dueOn: dayText(a.due_on), done: !!a.done_at, doneAt: a.done_at, doneBy: nameOf(a.d_first, a.d_last), note: a.note, late: !a.done_at && dayText(a.due_on) < today(), mine: a.owner_id === me(ctx) };
  });
  out.canManage = ctx.can('safety.manage');
  return out;
}

// POST /api/safety { kind, severity, occurredAt, location, description,
// companyId, injuredId | injuredName, injury, treatment, lostDays,
// immediateAction, photos: [dataUrl] } — anyone reports.
async function report(ctx, p) {
  p = p || {};
  if (!me(ctx)) fail('forbidden', 'Only staff report from here.');
  var kind = KINDS.indexOf(p.kind) >= 0 ? p.kind : fail('invalid', 'What happened: an injury, a near miss, damage…?');
  var description = String(p.description == null ? '' : p.description).trim().slice(0, 3000);
  if (description.length < 10) fail('invalid', 'Say what happened, in a few words.');
  var at = p.occurredAt ? new Date(p.occurredAt) : new Date();
  if (isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60000) fail('invalid', 'When did it happen?');
  var company = uuidOr(p.companyId);
  if (!company) company = ((await pool.query('SELECT d.company_id FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.id = $1', [me(ctx)])).rows[0] || {}).company_id || null;
  var injuredId = uuidOr(p.injuredId);
  var photos = (Array.isArray(p.photos) ? p.photos : []).filter(Boolean).slice(0, MAX_PHOTOS);
  var keep = [];
  for (var k = 0; k < photos.length; k++) keep.push(await require('./restaurantCashOffice.service').photoFrom(photos[k], 'incident'));
  var lost = Math.max(0, Math.min(365, Math.round(Number(p.lostDays) || 0)));
  var row = await withTransaction(async function (db) {
    await db.query('LOCK TABLE incidents IN SHARE ROW EXCLUSIVE MODE');
    var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM incidents')).rows[0].n;
    return (await db.query(
      'INSERT INTO incidents (number, company_id, kind, severity, occurred_at, location, description, injured_id, injured_name, injury, treatment, lost_days, photos, immediate_action, reported_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
      [n, company, kind, SEVERITIES.indexOf(p.severity) >= 0 ? p.severity : kind === 'near_miss' ? 'low' : 'medium', at, text(p.location, 120), description,
        injuredId, injuredId ? '' : text(p.injuredName, 80), text(p.injury, 300), TREATMENTS.indexOf(p.treatment) >= 0 ? p.treatment : 'none', lost,
        JSON.stringify(keep.map(function (x) { return { key: x.key, type: x.type }; })), text(p.immediateAction, 1000), me(ctx)])).rows[0];
  });
  var ref = 'HS-' + String(row.number).padStart(4, '0');
  var serious = row.severity === 'high' || row.severity === 'critical' || lostTime(row);
  var who = nameOf(ctx.employee.first_name, ctx.employee.last_name) || 'Someone';
  var holders = await require('./staffAlerts.service').holdersOf(['safety.manage']);
  for (var i = 0; i < holders.length; i++) {
    if (holders[i].employee_id === me(ctx)) continue;
    await notify(pool, holders[i].employee_id, (serious ? '🚨 ' : kind === 'near_miss' ? '🟡 ' : '⚠️ ') + KIND_WORDS[kind] + ' reported — ' + ref, who + ': ' + description.slice(0, 140), '/safety?incident=' + row.id);
  }
  await audit(pool, ctx, 'safety.report', 'incident', row.id, ref + ' ' + KIND_WORDS[kind].toLowerCase() + ' reported.');
  return get(ctx, row.id);
}

// PUT /api/safety/:id { severity, investigatorId, rootCause, immediateAction,
// lostDays, treatment, injury, location } — the investigation.
async function update(ctx, id, p) {
  need(ctx);
  p = p || {};
  var i = await incidentOf(id);
  if (i.status === 'closed') fail('conflict', 'It is closed: reopen it first.');
  var f = {
    severity: SEVERITIES.indexOf(p.severity) >= 0 ? p.severity : i.severity,
    investigator: p.investigatorId === undefined ? i.investigator_id : uuidOr(p.investigatorId),
    rootCause: p.rootCause === undefined ? i.root_cause : String(p.rootCause).trim().slice(0, 3000),
    immediate: p.immediateAction === undefined ? i.immediate_action : String(p.immediateAction).trim().slice(0, 1000),
    lost: p.lostDays === undefined ? i.lost_days : Math.max(0, Math.min(365, Math.round(Number(p.lostDays) || 0))),
    treatment: TREATMENTS.indexOf(p.treatment) >= 0 ? p.treatment : i.treatment,
    kind: KINDS.indexOf(p.kind) >= 0 ? p.kind : i.kind,
    location: p.location === undefined ? i.location : text(p.location, 120)
  };
  await pool.query("UPDATE incidents SET severity = $2, investigator_id = $3, root_cause = $4, immediate_action = $5, lost_days = $6, treatment = $7, kind = $8, location = $9, status = 'investigating', updated_at = now() WHERE id = $1",
    [i.id, f.severity, f.investigator, f.rootCause, f.immediate, f.lost, f.treatment, f.kind, f.location]);
  if (f.investigator && f.investigator !== i.investigator_id && f.investigator !== me(ctx)) await notify(pool, f.investigator, '🔍 Investigate HS-' + String(i.number).padStart(4, '0'), KIND_WORDS[f.kind] + ': ' + i.description.slice(0, 140), '/safety?incident=' + i.id);
  await audit(pool, ctx, 'safety.update', 'incident', i.id, 'Investigation of HS-' + String(i.number).padStart(4, '0') + ' updated.');
  return get(ctx, i.id);
}

// POST /api/safety/:id/actions { title, ownerId, dueOn }
async function addAction(ctx, id, p) {
  need(ctx);
  p = p || {};
  var i = await incidentOf(id);
  if (i.status === 'closed') fail('conflict', 'It is closed: reopen it first.');
  var title = text(p.title, 200);
  if (title.length < 4) fail('invalid', 'What is to be done?');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.dueOn || ''))) fail('invalid', 'By when?');
  var owner = uuidOr(p.ownerId);
  if (!owner) fail('invalid', 'Who does it?');
  await pool.query('INSERT INTO incident_actions (incident_id, title, owner_id, due_on, created_by) VALUES ($1,$2,$3,$4,$5)', [i.id, title, owner, p.dueOn, me(ctx)]);
  await pool.query("UPDATE incidents SET status = 'investigating', updated_at = now() WHERE id = $1", [i.id]);
  if (owner !== me(ctx)) await notify(pool, owner, '🛠️ Safety action for you: ' + title, 'From HS-' + String(i.number).padStart(4, '0') + ', by ' + p.dueOn + '.', '/myspace');
  await audit(pool, ctx, 'safety.action', 'incident', i.id, 'Action: ' + title + ' by ' + p.dueOn + '.');
  return get(ctx, i.id);
}

// POST /api/safety/actions/:id { done, note } — its owner or safety ticks it.
async function doneAction(ctx, id, p) {
  p = p || {};
  var a = (await pool.query('SELECT a.*, i.status AS incident_status FROM incident_actions a JOIN incidents i ON i.id = a.incident_id WHERE a.id = $1', [uuidOr(id)])).rows[0];
  if (!a) fail('notfound', 'That action is gone.');
  if (!ctx.can('safety.manage') && a.owner_id !== me(ctx)) fail('forbidden', 'That action is not yours.');
  if (a.incident_status === 'closed') fail('conflict', 'It is closed.');
  var done = p.done !== false;
  await pool.query('UPDATE incident_actions SET done_at = $2, done_by = $3, note = $4 WHERE id = $1', [a.id, done ? new Date() : null, done ? me(ctx) : null, p.note === undefined ? a.note : text(p.note, 500)]);
  await audit(pool, ctx, 'safety.action', 'incident', a.incident_id, (done ? 'Done: ' : 'Not done: ') + a.title + '.');
  return ctx.can('safety.manage') ? get(ctx, a.incident_id) : { ok: true };
}

// POST /api/safety/:id/close (and /reopen)
async function close(ctx, id, reopen) {
  need(ctx);
  var i = await incidentOf(id);
  if (reopen) {
    await pool.query("UPDATE incidents SET status = 'investigating', closed_at = NULL, closed_by = NULL, updated_at = now() WHERE id = $1", [i.id]);
  } else {
    if (i.open_actions > 0) fail('conflict', i.open_actions === 1 ? '1 action is still open.' : i.open_actions + ' actions are still open.');
    if (i.kind !== 'near_miss' && i.severity !== 'low' && i.root_cause.trim().length < 5) fail('invalid', 'Write down the cause first: what let it happen?');
    await pool.query("UPDATE incidents SET status = 'closed', closed_at = now(), closed_by = $2, updated_at = now() WHERE id = $1", [i.id, me(ctx)]);
    if (i.reported_by && i.reported_by !== me(ctx)) await notify(pool, i.reported_by, '✅ HS-' + String(i.number).padStart(4, '0') + ' is closed', 'Thank you for reporting it.', '/myspace');
  }
  await audit(pool, ctx, 'safety.close', 'incident', i.id, (reopen ? 'Reopened ' : 'Closed ') + 'HS-' + String(i.number).padStart(4, '0') + '.');
  return get(ctx, i.id);
}

// GET /api/safety/:id/photos/:n
async function photoKey(ctx, id, n) {
  var i = await incidentOf(id);
  if (!canSee(ctx, i)) fail('forbidden', 'That report is not yours to see.');
  var ph = (i.photos || [])[Math.round(Number(n))];
  if (!ph) fail('notfound', 'No such photo.');
  return ph;
}

// GET /api/safety/mine — My space: what I reported, the actions that are mine.
async function mine(ctx) {
  var id = me(ctx);
  if (!id) return { reports: [], actions: [] };
  var reports = (await pool.query(SEL + 'WHERE i.reported_by = $1 ORDER BY i.occurred_at DESC LIMIT 5', [id])).rows.map(incidentOut);
  var actions = (await pool.query('SELECT a.*, i.number FROM incident_actions a JOIN incidents i ON i.id = a.incident_id WHERE a.owner_id = $1 AND a.done_at IS NULL ORDER BY a.due_on LIMIT 10', [id])).rows.map(function (a) {
    return { id: a.id, title: a.title, dueOn: dayText(a.due_on), late: dayText(a.due_on) < today(), ref: 'HS-' + String(a.number).padStart(4, '0') };
  });
  var companies = (await pool.query('SELECT id, name FROM companies ORDER BY name')).rows;
  var own = ((await pool.query('SELECT d.company_id FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.id = $1', [id])).rows[0] || {}).company_id || null;
  return { reports: reports, actions: actions, companies: companies, company: own, kinds: KINDS, treatments: TREATMENTS };
}

// For the daily round: actions due today or late.
async function dueActions() {
  return (await pool.query("SELECT a.id, a.title, a.owner_id, a.due_on, i.number, i.id AS incident_id FROM incident_actions a JOIN incidents i ON i.id = a.incident_id WHERE a.done_at IS NULL AND i.status <> 'closed' AND a.due_on <= current_date")).rows;
}

module.exports = { overview: overview, get: get, report: report, update: update, addAction: addAction, doneAction: doneAction, close: close, photoKey: photoKey, mine: mine, dueActions: dueActions, KINDS: KINDS };
