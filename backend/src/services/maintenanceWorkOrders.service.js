var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Maintenance and IT work orders (migration 0214), kept the way the team
// kept its Google Sheet, the IT work order tracker: who asked and when,
// where, what kind of job, how urgent, who does it, the day it is planned
// and the day it was done, what it cost, notes, and a tick once a done job
// has been checked for billing. The sheet's own sums are worked out here:
// days open (asked → done, or → today while open), days taken (planned →
// done), late (still open after its planned day).
//
// Routines are the jobs that come round again every so many days: marking
// one done moves its next day on; a work order made from a routine marks
// the routine done when the work order is completed.
//
// Who may do what: task.manage (the work order managers) record, plan,
// assign, edit and import; task.read sees every job. Anyone signed in may
// ask for a job and sees the jobs they asked for or were given. Whoever a
// job is given to moves it along (started, on hold, done).

var CATEGORIES = ['electrical', 'plumbing', 'hvac', 'facilities', 'it', 'mason', 'other'];
var PRIORITIES = ['low', 'medium', 'high', 'urgent'];
var STATUSES = ['new', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'];
var OPEN = ['new', 'scheduled', 'in_progress', 'on_hold'];
var CURRENCIES = /^[A-Z]{3}$/;
var LINK = '/tasks?side=maint&job=';

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
function iso(v) { if (!v) return null; return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10); }
function text(v, max) { return String(v == null ? '' : v).replace(/[ \t]+/g, ' ').trim().slice(0, max); }
function longText(v, max) { return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max); }
function isUuid(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')); }
function isDay(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T00:00:00Z')); }
function dayOr(v, label) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!isDay(v)) fail('invalid', label + ' must be a date.');
  return v;
}
function money(v, label) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  if (!isFinite(n) || n < 0 || n > 9999999999) fail('invalid', label + ' must be an amount of 0 or more.');
  return Math.round(n * 100) / 100;
}
function pick(v, list, label, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  v = String(v).toLowerCase();
  if (list.indexOf(v) < 0) fail('invalid', label + ' is not one of the choices.');
  return v;
}
function orNull(v) { return v === undefined ? null : v; }
function nameOf(first, last) { return first ? (first + ' ' + (last || '')).trim() : ''; }

function canManage(ctx) { return ctx.can('task.manage'); }
function seesAll(ctx) { return ctx.can('task.manage') || ctx.can('task.read'); }
function needManage(ctx) { if (!canManage(ctx)) fail('forbidden', 'Your role does not allow this action (task.manage).'); }

// ── the places (whose company a place belongs to) ──────────────────────

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
// "BPL", "Star Bar", "Poki", "BG" or "Bamboo Garden 2" are our own
// companies' places; "Old Office" or a house stays a place of its own.
async function companyMatcher(db) {
  var companies = (await (db || pool).query('SELECT id, code, name FROM companies')).rows;
  var initialsOf = function (cn) { return cn.split(' ').map(function (w) { return w.charAt(0); }).join(''); };
  return function (place) {
    var n = norm(place);
    if (!n) return null;
    for (var i = 0; i < companies.length; i++) {
      var co = companies[i], cn = norm(co.name), cc = norm(co.code);
      if (n === cc || n === cn || n.indexOf(cn + ' ') === 0 || (cn.split(' ').length >= 2 && (n === initialsOf(cn) || cn.indexOf(n + ' ') === 0))) return co.id;
    }
    // Short for one company only: "SB" for Star Bar Restaurant.
    if (/^[a-z]{2,3}$/.test(n)) {
      var short = companies.filter(function (co) { var cn = norm(co.name); return cn.split(' ').length >= 2 && initialsOf(cn).indexOf(n) === 0; });
      if (short.length === 1) return short[0].id;
    }
    return null;
  };
}

// ── reading ─────────────────────────────────────────────────────────────

var SELECT_WO =
  'SELECT w.*, w.requested_on::text AS req_day, w.scheduled_on::text AS sched_day, w.completed_on::text AS done_day, ' +
  'c.name AS company_name, c.code AS company_code, r.name AS routine_name, ' +
  're.first_name AS req_first, re.last_name AS req_last, ae.first_name AS as_first, ae.last_name AS as_last, ' +
  'ae.photo_key AS as_photo_key, ae.photo_updated_at AS as_photo_at, ab.first_name AS au_first, ab.last_name AS au_last ' +
  'FROM maint_work_orders w LEFT JOIN companies c ON c.id = w.company_id LEFT JOIN maint_routines r ON r.id = w.routine_id ' +
  'LEFT JOIN employees re ON re.id = w.requested_by_id LEFT JOIN employees ae ON ae.id = w.assigned_to_id ' +
  'LEFT JOIN employees ab ON ab.id = w.audited_by ';

function shapeOrder(r, ctx) {
  var today = todayISO();
  var open = OPEN.indexOf(r.status) >= 0;
  var asked = r.req_day, done = r.done_day, planned = r.sched_day;
  var me = ctx && ctx.employee ? ctx.employee.id : null;
  return {
    id: r.id, ref: r.ref, requestedOn: asked,
    requestedBy: { id: r.requested_by_id || null, name: nameOf(r.req_first, r.req_last) || r.requested_by_name || '' },
    location: r.location, companyId: r.company_id || null, companyName: r.company_name || null, companyCode: r.company_code || null,
    category: r.category, description: r.description, priority: r.priority, status: r.status,
    assignedTo: r.assigned_to_id || r.assigned_to_name
      ? { id: r.assigned_to_id || null, name: nameOf(r.as_first, r.as_last) || r.assigned_to_name, photo: r.as_photo_key && r.as_photo_at ? new Date(r.as_photo_at).getTime() : null }
      : null,
    scheduledOn: planned, completedOn: done,
    currency: r.currency, estimatedCost: r.estimated_cost === null ? null : Number(r.estimated_cost), actualCost: r.actual_cost === null ? null : Number(r.actual_cost),
    notes: r.notes, audited: !!r.audited_at, auditedAt: r.audited_at || null, auditedBy: r.audited_at ? nameOf(r.au_first, r.au_last) : null,
    routineId: r.routine_id || null, routineName: r.routine_name || null, fromSheet: !!r.sheet_key,
    open: open,
    // The sheet's columns: Days Open, Days (planned → done), and late.
    daysOpen: r.status === 'cancelled' ? null : daysBetween(asked, done || today),
    daysTaken: done && planned && daysBetween(planned, done) >= 0 ? daysBetween(planned, done) : null,
    overdue: !!(open && planned && planned < today),
    mine: { asked: !!(me && r.requested_by_id === me), given: !!(me && r.assigned_to_id === me) },
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}

var SELECT_RT =
  'SELECT r.*, r.last_done_on::text AS last_day, r.next_on::text AS next_day, c.name AS company_name, ' +
  'ae.first_name AS as_first, ae.last_name AS as_last, ' +
  '(SELECT w.id FROM maint_work_orders w WHERE w.routine_id = r.id AND w.status IN (\'new\', \'scheduled\', \'in_progress\', \'on_hold\') ORDER BY w.created_at DESC LIMIT 1) AS open_order_id, ' +
  '(SELECT count(*)::int FROM maint_routine_log l WHERE l.routine_id = r.id) AS times_done ' +
  'FROM maint_routines r LEFT JOIN companies c ON c.id = r.company_id LEFT JOIN employees ae ON ae.id = r.assigned_to_id ';

function shapeRoutine(r) {
  var today = todayISO();
  var next = r.next_day;
  return {
    id: r.id, ref: r.ref, name: r.name, description: r.description, location: r.location,
    companyId: r.company_id || null, companyName: r.company_name || null, category: r.category, scheduleNote: r.schedule_note,
    assignedTo: r.assigned_to_id || r.assigned_to_name ? { id: r.assigned_to_id || null, name: nameOf(r.as_first, r.as_last) || r.assigned_to_name } : null,
    everyDays: r.every_days, lastDoneOn: r.last_day, nextOn: next, notes: r.notes, link: r.link,
    archived: !!r.archived_at, openOrderId: r.open_order_id || null, timesDone: r.times_done || 0,
    dueIn: next ? daysBetween(today, next) : null,
    late: !!(next && next < today && !r.archived_at),
    fromSheet: !!r.sheet_key
  };
}

function visibleWhere(ctx, args) {
  if (seesAll(ctx)) return '';
  args.push(ctx.employee.id);
  return '(w.requested_by_id = $' + args.length + ' OR w.assigned_to_id = $' + args.length + ')';
}

async function loadOrder(ctx, id, db) {
  if (!isUuid(id)) fail('not_found', 'That work order no longer exists.');
  var row = (await (db || pool).query(SELECT_WO + 'WHERE w.id = $1', [id])).rows[0];
  if (!row) fail('not_found', 'That work order no longer exists.');
  var o = shapeOrder(row, ctx);
  if (!seesAll(ctx) && !o.mine.asked && !o.mine.given) fail('not_found', 'That work order no longer exists.');
  return { row: row, order: o };
}
async function loadRoutine(id, db) {
  if (!isUuid(id)) fail('not_found', 'That routine no longer exists.');
  var row = (await (db || pool).query(SELECT_RT + 'WHERE r.id = $1', [id])).rows[0];
  if (!row) fail('not_found', 'That routine no longer exists.');
  return row;
}

// The dashboard the sheet kept by hand: totals, the jobs by status, open
// ones by priority, by kind of job, by place and by who does them, how long
// jobs take, what they cost, and the week just gone.
function summarize(orders, routines) {
  var today = todayISO(), weekAgo = addDays(today, -7), quarter = addDays(today, -90);
  var s = {
    total: orders.length, open: 0, overdue: 0, completed: 0, cancelled: 0, unassigned: 0,
    byStatus: {}, openByPriority: {}, actual: {}, estimated: {}, toAudit: 0,
    byCategory: [], byLocation: [], byPerson: [],
    doneLast7: 0, askedLast7: 0, avgDaysToClose: null, oldestOpenDays: null,
    routinesLate: 0, routinesDueWeek: 0
  };
  STATUSES.forEach(function (k) { s.byStatus[k] = 0; });
  PRIORITIES.forEach(function (k) { s.openByPriority[k] = 0; });
  var cats = {}, places = {}, people = {}, closeDays = [];
  orders.forEach(function (o) {
    s.byStatus[o.status] = (s.byStatus[o.status] || 0) + 1;
    if (o.open) {
      s.open++;
      s.openByPriority[o.priority]++;
      if (o.overdue) s.overdue++;
      if (!o.assignedTo) s.unassigned++;
      if (s.oldestOpenDays === null || o.daysOpen > s.oldestOpenDays) s.oldestOpenDays = o.daysOpen;
    }
    if (o.status === 'completed') {
      s.completed++;
      if (o.completedOn >= weekAgo) s.doneLast7++;
      if (o.completedOn >= quarter && o.daysOpen !== null) closeDays.push(o.daysOpen);
      if (!o.audited) s.toAudit++;
    }
    if (o.status === 'cancelled') s.cancelled++;
    if (o.requestedOn >= weekAgo) s.askedLast7++;
    if (o.actualCost !== null) s.actual[o.currency] = Math.round(((s.actual[o.currency] || 0) + o.actualCost) * 100) / 100;
    if (o.estimatedCost !== null) s.estimated[o.currency] = Math.round(((s.estimated[o.currency] || 0) + o.estimatedCost) * 100) / 100;
    var c = cats[o.category] = cats[o.category] || { key: o.category, total: 0, open: 0 };
    c.total++; if (o.open) c.open++;
    var placeName = o.location || '—';
    var p = places[placeName] = places[placeName] || { location: placeName, total: 0, open: 0 };
    p.total++; if (o.open) p.open++;
    if (o.assignedTo) {
      var who = o.assignedTo.id || 'name:' + o.assignedTo.name;
      var pp = people[who] = people[who] || { id: o.assignedTo.id, name: o.assignedTo.name, photo: o.assignedTo.photo, open: 0, late: 0, doneLast30: 0, total: 0 };
      pp.total++;
      if (o.open) pp.open++;
      if (o.overdue) pp.late++;
      if (o.status === 'completed' && o.completedOn >= addDays(today, -30)) pp.doneLast30++;
    }
  });
  if (closeDays.length) s.avgDaysToClose = Math.round(closeDays.reduce(function (a, b) { return a + b; }, 0) / closeDays.length * 10) / 10;
  s.byCategory = Object.keys(cats).map(function (k) { return cats[k]; }).sort(function (a, b) { return b.total - a.total; });
  s.byLocation = Object.keys(places).map(function (k) { return places[k]; }).sort(function (a, b) { return b.open - a.open || b.total - a.total; });
  s.byPerson = Object.keys(people).map(function (k) { return people[k]; }).sort(function (a, b) { return b.open - a.open || b.total - a.total; });
  (routines || []).forEach(function (r) {
    if (r.archived) return;
    if (r.late) s.routinesLate++;
    else if (r.nextOn && r.dueIn <= 7) s.routinesDueWeek++;
  });
  return s;
}

// GET /api/maint-work-orders — the whole tracker in one go: the work
// orders this person can see (newest first), the routines, the dashboard,
// what the forms offer, and what this person may do.
async function list(ctx, q) {
  q = q || {};
  var args = [], where = [];
  var vis = visibleWhere(ctx, args);
  if (vis) where.push(vis);
  if (q.companyId && isUuid(q.companyId)) { args.push(q.companyId); where.push('w.company_id = $' + args.length); }
  var rows = (await pool.query(SELECT_WO + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY w.requested_on DESC, w.ref DESC, w.created_at DESC LIMIT 5000', args)).rows;
  var orders = rows.map(function (r) { return shapeOrder(r, ctx); });

  var rargs = [], rwhere = [];
  if (!seesAll(ctx)) { rargs.push(ctx.employee.id); rwhere.push('r.assigned_to_id = $1'); }
  if (q.companyId && isUuid(q.companyId)) { rargs.push(q.companyId); rwhere.push('r.company_id = $' + rargs.length); }
  var routines = (await pool.query(SELECT_RT + (rwhere.length ? 'WHERE ' + rwhere.join(' AND ') + ' ' : '') +
    'ORDER BY r.archived_at IS NOT NULL, r.next_on NULLS LAST, r.name', rargs)).rows.map(shapeRoutine);

  var places = (await pool.query(
    "SELECT location, count(*)::int AS n FROM (SELECT location FROM maint_work_orders UNION ALL SELECT location FROM maint_routines) x WHERE location <> '' GROUP BY location ORDER BY n DESC, location LIMIT 200")).rows;
  return {
    orders: orders, routines: routines, summary: summarize(orders, routines),
    options: {
      categories: CATEGORIES, priorities: PRIORITIES, statuses: STATUSES,
      places: places.map(function (p) { return p.location; }),
      currencies: ['GHS', 'USD', 'EUR', 'GBP', 'CNY']
    },
    can: { manage: canManage(ctx), seeAll: seesAll(ctx) },
    today: todayISO()
  };
}

async function get(ctx, id) {
  var o = (await loadOrder(ctx, id)).order;
  var log = o.routineId ? (await pool.query(
    'SELECT l.done_on::text AS day, l.note, e.first_name, e.last_name FROM maint_routine_log l LEFT JOIN employees e ON e.id = l.done_by_id ' +
    'WHERE l.routine_id = $1 ORDER BY l.done_on DESC, l.created_at DESC LIMIT 12', [o.routineId])).rows : [];
  o.routineLog = log.map(function (l) { return { day: l.day, note: l.note, by: nameOf(l.first_name, l.last_name) }; });
  return o;
}

// ── numbers ─────────────────────────────────────────────────────────────

// The next WO-#### after the highest on record (the sheet's WO-1001 on),
// and the next RT-###. One at a time, so two people never get the same.
async function nextRef(client, table, prefix, floor, pad) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [table + '.ref']);
  var top = (await client.query(
    "SELECT max(substring(ref FROM '^" + prefix + "-(\\d+)$')::int) AS n FROM " + table)).rows[0].n;
  return prefix + '-' + String(Math.max(top || 0, floor) + 1).padStart(pad, '0');
}

// ── who does it ─────────────────────────────────────────────────────────

async function personOr(client, id, name) {
  if (id) {
    if (!isUuid(id)) fail('invalid', 'Choose someone from the list.');
    var e = (await client.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [id])).rows[0];
    if (!e) fail('invalid', 'That person is not in the directory.');
    return { id: e.id, name: '' };
  }
  return { id: null, name: text(name, 80) };
}

async function tellAssigned(client, ctx, row, verb) {
  if (!row.assigned_to_id || row.assigned_to_id === ctx.employee.id) return;
  await notify(client, row.assigned_to_id, (verb || '🔧 New job') + ' ' + row.ref + (row.location ? ' · ' + row.location : ''),
    text(row.description, 140) + (row.scheduled_on ? ' — ' + iso(row.scheduled_on) : ''), LINK + row.id);
}

// ── work orders ─────────────────────────────────────────────────────────

// A job asked for by anyone (new, waiting to be planned), or recorded in
// full by a work order manager.
async function create(ctx, body) {
  body = body || {};
  var manage = canManage(ctx);
  var description = longText(body.description, 2000);
  if (!description) fail('invalid', 'Say what needs doing.');
  return withTransaction(async function (client) {
    var match = await companyMatcher(client);
    var location = text(body.location, 80);
    var who = manage ? await personOr(client, body.assignedToId, body.assignedToName) : { id: null, name: '' };
    var asker = manage && (body.requestedById || body.requestedByName)
      ? await personOr(client, body.requestedById, body.requestedByName) : { id: ctx.employee.id, name: '' };
    var scheduled = manage ? dayOr(body.scheduledOn, 'Scheduled date') : null;
    var status = manage ? pick(body.status, STATUSES, 'Status', scheduled ? 'scheduled' : 'new') : 'new';
    var completed = status === 'completed' ? (dayOr(body.completedOn, 'Completed date') || todayISO()) : null;
    var requestedOn = (manage && dayOr(body.requestedOn, 'Request date')) || todayISO();
    var currency = text(body.currency || 'GHS', 3).toUpperCase();
    if (!CURRENCIES.test(currency)) fail('invalid', 'Currency must be a three-letter code such as GHS.');
    var ref = await nextRef(client, 'maint_work_orders', 'WO', 1000, 4);
    var row = (await client.query(
      'INSERT INTO maint_work_orders (ref, requested_on, requested_by_id, requested_by_name, location, company_id, category, description, priority, status, ' +
      'assigned_to_id, assigned_to_name, scheduled_on, completed_on, currency, estimated_cost, actual_cost, notes, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *',
      [ref, requestedOn, asker.id, asker.name, location, (manage && isUuid(body.companyId) ? body.companyId : null) || match(location),
        pick(body.category, CATEGORIES, 'Category', 'other'), description, pick(body.priority, PRIORITIES, 'Priority', 'medium'), status,
        who.id, who.name, scheduled, completed, currency,
        manage ? orNull(money(body.estimatedCost, 'Estimated cost')) : null, manage ? orNull(money(body.actualCost, 'Actual cost')) : null,
        longText(body.notes, 2000), ctx.employee.id])).rows[0];
    await audit(client, ctx, 'maintwo.create', 'maint_work_order', row.id, (manage ? 'Recorded ' : 'Asked for ') + ref + ': ' + text(description, 120));
    await tellAssigned(client, ctx, row);
    // A job asked for by someone who does not plan the jobs: those who do hear.
    if (!manage) {
      var holders = await require('./staffAlerts.service').holdersOf(['task.manage']);
      for (var i = 0; i < holders.length; i++) {
        if (holders[i].employee_id === ctx.employee.id) continue;
        await notify(client, holders[i].employee_id, '🛠️ Job asked for: ' + ref + (location ? ' · ' + location : ''), text(description, 140), LINK + row.id);
      }
    }
    return (await loadOrder(ctx, row.id, client)).order;
  });
}

// Everything on a job, by a work order manager.
async function update(ctx, id, body) {
  needManage(ctx);
  body = body || {};
  return withTransaction(async function (client) {
    var was = (await loadOrder(ctx, id, client)).row;
    var f = {};
    if (body.description !== undefined) { f.description = longText(body.description, 2000); if (!f.description) fail('invalid', 'Say what needs doing.'); }
    if (body.location !== undefined) {
      f.location = text(body.location, 80);
      if (body.companyId === undefined) f.company_id = (await companyMatcher(client))(f.location);
    }
    if (body.companyId !== undefined) f.company_id = isUuid(body.companyId) ? body.companyId : null;
    if (body.category !== undefined) f.category = pick(body.category, CATEGORIES, 'Category', 'other');
    if (body.priority !== undefined) f.priority = pick(body.priority, PRIORITIES, 'Priority', 'medium');
    if (body.requestedOn !== undefined) f.requested_on = dayOr(body.requestedOn, 'Request date') || was.req_day;
    if (body.requestedById !== undefined || body.requestedByName !== undefined) {
      var asker = await personOr(client, body.requestedById, body.requestedByName);
      f.requested_by_id = asker.id; f.requested_by_name = asker.name;
    }
    if (body.assignedToId !== undefined || body.assignedToName !== undefined) {
      var who = await personOr(client, body.assignedToId, body.assignedToName);
      f.assigned_to_id = who.id; f.assigned_to_name = who.name;
    }
    if (body.scheduledOn !== undefined) f.scheduled_on = dayOr(body.scheduledOn, 'Scheduled date');
    if (body.currency !== undefined) {
      f.currency = text(body.currency, 3).toUpperCase();
      if (!CURRENCIES.test(f.currency)) fail('invalid', 'Currency must be a three-letter code such as GHS.');
    }
    if (body.estimatedCost !== undefined) f.estimated_cost = money(body.estimatedCost, 'Estimated cost');
    if (body.actualCost !== undefined) f.actual_cost = money(body.actualCost, 'Actual cost');
    if (body.notes !== undefined) f.notes = longText(body.notes, 2000);
    if (body.status !== undefined) f.status = pick(body.status, STATUSES, 'Status', was.status);
    var status = f.status || was.status;
    if (body.completedOn !== undefined) f.completed_on = dayOr(body.completedOn, 'Completed date');
    if (status === 'completed' && !(f.completed_on || (f.completed_on === undefined && was.done_day))) f.completed_on = todayISO();
    if (status !== 'completed') f.completed_on = null;
    // Planned for a day while still new: it reads as scheduled.
    if (status === 'new' && (f.scheduled_on || (f.scheduled_on === undefined && was.sched_day)) && body.status === undefined) f.status = 'scheduled';

    var keys = Object.keys(f);
    if (!keys.length) return (await loadOrder(ctx, id, client)).order;
    var sets = keys.map(function (k, i) { return k + ' = $' + (i + 2); });
    var row = (await client.query('UPDATE maint_work_orders SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $1 RETURNING *',
      [id].concat(keys.map(function (k) { return f[k]; })))).rows[0];
    await audit(client, ctx, 'maintwo.update', 'maint_work_order', id, 'Updated ' + row.ref + '.');
    if (row.assigned_to_id && row.assigned_to_id !== was.assigned_to_id) await tellAssigned(client, ctx, row);
    await afterStatus(client, ctx, was, row);
    return (await loadOrder(ctx, id, client)).order;
  });
}

// What a change of status sets off: whoever asked hears it is done, and a
// work order made from a routine marks the routine done that day.
async function afterStatus(client, ctx, was, row) {
  if (was.status === row.status) return;
  if (row.status === 'completed') {
    if (row.requested_by_id && row.requested_by_id !== ctx.employee.id) {
      await notify(client, row.requested_by_id, '✅ Done: ' + row.ref + (row.location ? ' · ' + row.location : ''), text(row.description, 140), LINK + row.id);
    }
    if (row.routine_id) await markRoutineDone(client, ctx, row.routine_id, iso(row.completed_on), '', row.id);
  }
}

// POST /:id/status { status, completedOn?, actualCost?, note? } — a work
// order manager, or whoever the job is given to; whoever asked may call off
// a job not yet planned.
async function setStatus(ctx, id, body) {
  body = body || {};
  var status = pick(body.status, STATUSES, 'Status', null);
  if (!status) fail('invalid', 'Choose a status.');
  return withTransaction(async function (client) {
    var loaded = await loadOrder(ctx, id, client);
    var was = loaded.row, o = loaded.order;
    var manage = canManage(ctx);
    var asker = o.mine.asked && was.status === 'new' && status === 'cancelled';
    if (!manage && !asker) {
      if (!o.mine.given) fail('forbidden', 'Only the work order managers, or whoever the job is given to, can move it along.');
      if (status === 'cancelled' || status === 'new') fail('forbidden', 'Only the work order managers can call off a job.');
    }
    var f = { status: status };
    if (status === 'completed') {
      // Still done (a note added): the day it was done stays.
      f.completed_on = dayOr(body.completedOn, 'Completed date') || (was.status === 'completed' ? was.done_day : todayISO());
      if (f.completed_on > todayISO()) fail('invalid', 'The day it was done cannot be in the future.');
      if (body.actualCost !== undefined && body.actualCost !== '') f.actual_cost = money(body.actualCost, 'Actual cost');
    } else f.completed_on = null;
    if (status === 'scheduled' && body.scheduledOn !== undefined) f.scheduled_on = dayOr(body.scheduledOn, 'Scheduled date');
    var note = text(body.note, 300);
    if (note) {
      var who = (ctx.employee.first_name || '').trim() || 'Note';
      f.notes = (was.notes ? was.notes + '\n' : '') + todayISO() + ' ' + who + ': ' + note;
    }
    var keys = Object.keys(f);
    var row = (await client.query('UPDATE maint_work_orders SET ' + keys.map(function (k, i) { return k + ' = $' + (i + 2); }).join(', ') +
      ', updated_at = now() WHERE id = $1 RETURNING *', [id].concat(keys.map(function (k) { return f[k]; })))).rows[0];
    await audit(client, ctx, 'maintwo.status', 'maint_work_order', id, row.ref + ' is now ' + status.replace('_', ' ') + '.');
    await afterStatus(client, ctx, was, row);
    return (await loadOrder(ctx, id, client)).order;
  });
}

// POST /:id/audit { audited } — the Billing tab's Audit tick.
async function setAudited(ctx, id, audited) {
  needManage(ctx);
  return withTransaction(async function (client) {
    var was = (await loadOrder(ctx, id, client)).row;
    if (audited && was.status !== 'completed') fail('invalid', 'Only a job that is done can be checked for billing.');
    await client.query('UPDATE maint_work_orders SET audited_at = $2, audited_by = $3, updated_at = now() WHERE id = $1',
      [id, audited ? new Date() : null, audited ? ctx.employee.id : null]);
    await audit(client, ctx, 'maintwo.audit', 'maint_work_order', id, (audited ? 'Checked ' : 'Unchecked ') + was.ref + ' for billing.');
    return (await loadOrder(ctx, id, client)).order;
  });
}

async function remove(ctx, id) {
  needManage(ctx);
  return withTransaction(async function (client) {
    var was = (await loadOrder(ctx, id, client)).row;
    await client.query('DELETE FROM maint_work_orders WHERE id = $1', [id]);
    await audit(client, ctx, 'maintwo.delete', 'maint_work_order', id, 'Deleted ' + was.ref + ': ' + text(was.description, 120));
    return { ok: true };
  });
}

// ── routines ────────────────────────────────────────────────────────────

async function saveRoutine(ctx, id, body) {
  needManage(ctx);
  body = body || {};
  return withTransaction(async function (client) {
    var was = id ? await loadRoutine(id, client) : null;
    var f = {};
    var has = function (k) { return !was || body[k] !== undefined; };
    if (has('name')) { f.name = text(body.name, 120); if (!f.name) fail('invalid', 'Give the routine a name.'); }
    if (has('description')) f.description = longText(body.description, 1000);
    if (has('location')) {
      f.location = text(body.location, 80);
      f.company_id = (await companyMatcher(client))(f.location);
    }
    if (has('category')) f.category = pick(body.category, CATEGORIES, 'Category', 'other');
    if (has('scheduleNote')) f.schedule_note = text(body.scheduleNote, 80);
    if (!was || body.assignedToId !== undefined || body.assignedToName !== undefined) {
      var who = await personOr(client, body.assignedToId, body.assignedToName);
      f.assigned_to_id = who.id; f.assigned_to_name = who.name;
    }
    if (has('everyDays')) {
      var n = body.everyDays === null || body.everyDays === '' || body.everyDays === undefined ? null : Number(body.everyDays);
      if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 3660)) fail('invalid', 'Every how many days must be a whole number from 1 to 3660.');
      f.every_days = n;
    }
    if (has('lastDoneOn')) f.last_done_on = dayOr(body.lastDoneOn, 'Last done') || null;
    if (has('notes')) f.notes = longText(body.notes, 1000);
    if (has('link')) f.link = text(body.link, 500);
    // The next day: as given, or the last time it was done + every so many days.
    var every = f.every_days !== undefined ? f.every_days : was && was.every_days;
    var last = f.last_done_on !== undefined ? f.last_done_on : was && was.last_day;
    var cleared = body.nextOn === '' || body.nextOn === null;
    if (body.nextOn !== undefined && !cleared) f.next_on = dayOr(body.nextOn, 'Next date');
    else if (!was || cleared || body.everyDays !== undefined || body.lastDoneOn !== undefined) f.next_on = every && last ? addDays(last, every) : null;
    var row;
    if (!was) {
      f.ref = text(body.ref, 20) || await nextRef(client, 'maint_routines', 'RT', 0, 3);
      f.created_by = ctx.employee.id;
      var keys = Object.keys(f);
      row = (await client.query('INSERT INTO maint_routines (' + keys.join(', ') + ') VALUES (' + keys.map(function (k, i) { return '$' + (i + 1); }).join(', ') + ') RETURNING id',
        keys.map(function (k) { return f[k]; }))).rows[0];
      await audit(client, ctx, 'maintwo.routine.create', 'maint_routine', row.id, 'Added routine ' + f.ref + ' "' + f.name + '".');
    } else {
      var ks = Object.keys(f);
      if (ks.length) await client.query('UPDATE maint_routines SET ' + ks.map(function (k, i) { return k + ' = $' + (i + 2); }).join(', ') + ', updated_at = now() WHERE id = $1',
        [id].concat(ks.map(function (k) { return f[k]; })));
      row = { id: id };
      await audit(client, ctx, 'maintwo.routine.update', 'maint_routine', id, 'Updated routine ' + was.ref + ' "' + (f.name || was.name) + '".');
    }
    return shapeRoutine(await loadRoutine(row.id, client));
  });
}

async function markRoutineDone(client, ctx, id, on, note, workOrderId) {
  var r = await loadRoutine(id, client);
  await client.query('INSERT INTO maint_routine_log (routine_id, done_on, done_by_id, note, work_order_id) VALUES ($1, $2, $3, $4, $5)',
    [id, on, ctx.employee.id, text(note, 300), workOrderId || null]);
  // A late record of an earlier time does not move the dates back.
  if (!r.last_day || on >= r.last_day) {
    await client.query('UPDATE maint_routines SET last_done_on = $2, next_on = $3, updated_at = now() WHERE id = $1',
      [id, on, r.every_days ? addDays(on, r.every_days) : null]);
  }
}

// POST /routines/:id/done { on?, note? } — a manager, or whoever does it.
async function routineDone(ctx, id, body) {
  body = body || {};
  return withTransaction(async function (client) {
    var r = await loadRoutine(id, client);
    if (!canManage(ctx) && r.assigned_to_id !== ctx.employee.id) fail('forbidden', 'Only the work order managers, or whoever does this routine, can mark it done.');
    var on = dayOr(body.on, 'Done on') || todayISO();
    if (on > todayISO()) fail('invalid', 'The day it was done cannot be in the future.');
    await markRoutineDone(client, ctx, id, on, body.note, null);
    await audit(client, ctx, 'maintwo.routine.done', 'maint_routine', id, 'Routine ' + r.ref + ' "' + r.name + '" done on ' + on + '.');
    return shapeRoutine(await loadRoutine(id, client));
  });
}

// POST /routines/:id/order { scheduledOn? } — the routine's next time as a
// work order, planned for its next day; completing it marks the routine done.
async function routineOrder(ctx, id, body) {
  needManage(ctx);
  body = body || {};
  return withTransaction(async function (client) {
    var r = await loadRoutine(id, client);
    if (r.open_order_id) fail('conflict', 'This routine already has a work order open.');
    var on = dayOr(body.scheduledOn, 'Scheduled date') || (r.next_day && r.next_day > todayISO() ? r.next_day : todayISO());
    var ref = await nextRef(client, 'maint_work_orders', 'WO', 1000, 4);
    var row = (await client.query(
      'INSERT INTO maint_work_orders (ref, requested_on, requested_by_id, location, company_id, category, description, priority, status, ' +
      "assigned_to_id, assigned_to_name, scheduled_on, notes, routine_id, created_by) VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, 'medium', 'scheduled', $7, $8, $9, $10, $11, $2) RETURNING *",
      [ref, ctx.employee.id, r.location, r.company_id, r.category, (r.name + (r.description ? ' — ' + r.description : '')).slice(0, 2000),
        r.assigned_to_id, r.assigned_to_name, on, r.schedule_note ? 'When: ' + r.schedule_note : '', r.id])).rows[0];
    await audit(client, ctx, 'maintwo.create', 'maint_work_order', row.id, 'Made ' + ref + ' from routine ' + r.ref + ' "' + r.name + '".');
    await tellAssigned(client, ctx, row, '🔁 Routine job');
    return (await loadOrder(ctx, row.id, client)).order;
  });
}

async function archiveRoutine(ctx, id, archived) {
  needManage(ctx);
  return withTransaction(async function (client) {
    var r = await loadRoutine(id, client);
    await client.query('UPDATE maint_routines SET archived_at = $2, updated_at = now() WHERE id = $1', [id, archived ? new Date() : null]);
    await audit(client, ctx, 'maintwo.routine.archive', 'maint_routine', id, (archived ? 'Put away' : 'Brought back') + ' routine ' + r.ref + ' "' + r.name + '".');
    return shapeRoutine(await loadRoutine(id, client));
  });
}

async function removeRoutine(ctx, id) {
  needManage(ctx);
  return withTransaction(async function (client) {
    var r = await loadRoutine(id, client);
    await client.query('DELETE FROM maint_routines WHERE id = $1', [id]);
    await audit(client, ctx, 'maintwo.routine.delete', 'maint_routine', id, 'Deleted routine ' + r.ref + ' "' + r.name + '".');
    return { ok: true };
  });
}

module.exports = {
  list: list, get: get, create: create, update: update, setStatus: setStatus, setAudited: setAudited, remove: remove,
  saveRoutine: saveRoutine, routineDone: routineDone, routineOrder: routineOrder, archiveRoutine: archiveRoutine, removeRoutine: removeRoutine,
  companyMatcher: companyMatcher, summarize: summarize,
  CATEGORIES: CATEGORIES, PRIORITIES: PRIORITIES, STATUSES: STATUSES
};
