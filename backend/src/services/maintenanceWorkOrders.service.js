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
//
// The team's phone app, My Jobs (frontend /myjobs, migration 0217): each
// person's own jobs (mine), and a job or a routine is marked done only with
// a photo of the finished work. A routine whose next day is close becomes a
// work order by itself (runDue, jobs/maintRoutines.js), and each morning
// whoever has jobs is told how many (morning).

var CATEGORIES = ['electrical', 'plumbing', 'hvac', 'facilities', 'it', 'mason', 'other'];
var PRIORITIES = ['low', 'medium', 'high', 'urgent'];
var STATUSES = ['new', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'];
var OPEN = ['new', 'scheduled', 'in_progress', 'on_hold'];
var CURRENCIES = /^[A-Z]{3}$/;
var LINK = '/tasks?side=maint&job=';
// Whoever does the job opens it in My Jobs, on the phone or the computer.
var MY_LINK = '/myjobs?job=';
// Photos of the finished work, at most this many each time.
var MAX_DONE_PHOTOS = 3;
// Photos of the problem when a job is added, or of what a routine looks
// after (migration 0221): at most this many.
var MAX_REPORT_PHOTOS = 4;
var PHOTO_NEEDED = 'Take a photo of the finished work first: a job is marked done only with a photo of it.';
// A routine becomes a work order this many days before its next day (less
// for one that comes round sooner: a daily routine on the day itself).
var LEAD_DAYS = 2;
// The morning list goes from 06:00 Ghana time (GMT all year).
var MORNING_FROM_HOUR_UTC = 6;

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
    routineId: r.routine_id || null, routineName: r.routine_name || null, fromSheet: !!r.sheet_key, autoMade: !!r.auto_made,
    // Photos of the finished work (GET /:id/photos/:n).
    donePhotos: (r.done_photos || []).map(function (p, n) { return { n: n, at: p.at || null }; }),
    // Photos from when it was added — the problem — or its routine's (GET /:id/report-photos/:n).
    photos: (r.photos || []).map(function (p, n) { return { n: n, at: p.at || null }; }),
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
    fromSheet: !!r.sheet_key,
    // What it looks after and how (GET /routines/:id/photos/:n).
    photos: (r.photos || []).map(function (p, n) { return { n: n, at: p.at || null }; })
  };
}

function visibleWhere(ctx, args) {
  if (seesAll(ctx)) return '';
  args.push(ctx.employee.id);
  return '(w.requested_by_id = $' + args.length + ' OR w.assigned_to_id = $' + args.length + ')';
}

async function loadOrder(ctx, id, db) {
  if (!isUuid(id)) fail('notfound', 'That work order no longer exists.');
  var row = (await (db || pool).query(SELECT_WO + 'WHERE w.id = $1', [id])).rows[0];
  if (!row) fail('notfound', 'That work order no longer exists.');
  var o = shapeOrder(row, ctx);
  if (!seesAll(ctx) && !o.mine.asked && !o.mine.given) fail('notfound', 'That work order no longer exists.');
  return { row: row, order: o };
}
async function loadRoutine(id, db) {
  if (!isUuid(id)) fail('notfound', 'That routine no longer exists.');
  var row = (await (db || pool).query(SELECT_RT + 'WHERE r.id = $1', [id])).rows[0];
  if (!row) fail('notfound', 'That routine no longer exists.');
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
    'SELECT l.id, l.done_on::text AS day, l.note, l.photos, e.first_name, e.last_name FROM maint_routine_log l LEFT JOIN employees e ON e.id = l.done_by_id ' +
    'WHERE l.routine_id = $1 ORDER BY l.done_on DESC, l.created_at DESC LIMIT 12', [o.routineId])).rows : [];
  o.routineLog = log.map(function (l) { return { id: l.id, day: l.day, note: l.note, by: nameOf(l.first_name, l.last_name), photos: (l.photos || []).length }; });
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
    text(row.description, 140) + (row.scheduled_on ? ' — ' + iso(row.scheduled_on) : ''), MY_LINK + row.id);
}

// ── photos of the finished work ─────────────────────────────────────────

// The photos sent with "done" (JPEG data URLs, made small on the phone),
// kept in file storage: [{ key, type, at, by }].
async function photosFrom(ctx, given, name, max) {
  var list = Array.isArray(given) ? given.filter(Boolean).slice(0, max || MAX_DONE_PHOTOS) : [];
  var photoFrom = require('./restaurantCashOffice.service').photoFrom;
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var p = await photoFrom(list[i], name + '-' + (i + 1));
    out.push({ key: p.key, type: p.type, at: new Date().toISOString(), by: ctx.employee.id });
  }
  return out;
}
function photoName(prefix, n, p) { return prefix + '-' + (Number(n) + 1) + (p.type === 'image/png' ? '.png' : p.type === 'image/webp' ? '.webp' : '.jpg'); }

// GET /:id/photos/:n — whoever may see the job.
async function photoOf(ctx, id, n) {
  var row = (await loadOrder(ctx, id)).row;
  var p = (row.done_photos || [])[Number(n)];
  if (!p) fail('notfound', 'No such photo.');
  return { key: p.key, name: photoName(String(row.ref || 'job').toLowerCase() + '-done', n, p) };
}

// GET /:id/report-photos/:n — the photos from when the job was added (or
// its routine's), to whoever may see the job.
async function reportPhotoOf(ctx, id, n) {
  var row = (await loadOrder(ctx, id)).row;
  var p = (row.photos || [])[Number(n)];
  if (!p) fail('notfound', 'No such photo.');
  return { key: p.key, name: photoName(String(row.ref || 'job').toLowerCase(), n, p) };
}

// GET /routines/:id/photos/:n — a routine's photos, to whoever sees every
// job, does the routine or added it.
async function routineRefPhotoOf(ctx, id, n) {
  if (!isUuid(id)) fail('notfound', 'No such photo.');
  var r = (await pool.query('SELECT ref, photos, assigned_to_id, created_by FROM maint_routines WHERE id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'No such photo.');
  if (!seesAll(ctx) && r.assigned_to_id !== ctx.employee.id && r.created_by !== ctx.employee.id) fail('notfound', 'No such photo.');
  var p = (r.photos || [])[Number(n)];
  if (!p) fail('notfound', 'No such photo.');
  return { key: p.key, name: photoName(String(r.ref || 'routine').toLowerCase(), n, p) };
}

// GET /routines/log/:id/photos/:n — whoever sees every job, does the
// routine, or did it that time.
async function routinePhotoOf(ctx, logId, n) {
  if (!isUuid(logId)) fail('notfound', 'No such photo.');
  var l = (await pool.query('SELECT l.photos, l.done_by_id, r.ref, r.assigned_to_id FROM maint_routine_log l JOIN maint_routines r ON r.id = l.routine_id WHERE l.id = $1', [logId])).rows[0];
  if (!l) fail('notfound', 'No such photo.');
  if (!seesAll(ctx) && l.done_by_id !== ctx.employee.id && l.assigned_to_id !== ctx.employee.id) fail('notfound', 'No such photo.');
  var p = (l.photos || [])[Number(n)];
  if (!p) fail('notfound', 'No such photo.');
  return { key: p.key, name: photoName(String(l.ref || 'routine').toLowerCase() + '-done', n, p) };
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
async function afterStatus(client, ctx, was, row, shots) {
  if (was.status === row.status) return;
  if (row.status === 'completed') {
    if (row.requested_by_id && row.requested_by_id !== ctx.employee.id) {
      await notify(client, row.requested_by_id, '✅ Done: ' + row.ref + (row.location ? ' · ' + row.location : ''), text(row.description, 140), LINK + row.id);
    }
    if (row.routine_id) await markRoutineDone(client, ctx, row.routine_id, iso(row.completed_on), '', row.id, shots);
  }
}

// POST /:id/status { status, completedOn?, actualCost?, note?, photos? } —
// a work order manager, or whoever the job is given to; whoever asked may
// call off a job not yet planned. Done takes 1 to 3 photos of the finished
// work (JPEG data URLs): without one it is refused. A note added to a job
// already done needs none.
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
    var shots = [];
    if (status === 'completed') {
      // Still done (a note added): the day it was done stays.
      f.completed_on = dayOr(body.completedOn, 'Completed date') || (was.status === 'completed' ? was.done_day : todayISO());
      if (f.completed_on > todayISO()) fail('invalid', 'The day it was done cannot be in the future.');
      if (body.actualCost !== undefined && body.actualCost !== '') f.actual_cost = money(body.actualCost, 'Actual cost');
      if (was.status !== 'completed') {
        if (!Array.isArray(body.photos) || !body.photos.filter(Boolean).length) fail('invalid', PHOTO_NEEDED);
        shots = await photosFrom(ctx, body.photos, String(was.ref || 'job').toLowerCase() + '-done');
        f.done_photos = JSON.stringify((was.done_photos || []).concat(shots).slice(-9));
      }
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
    await audit(client, ctx, 'maintwo.status', 'maint_work_order', id, row.ref + ' is now ' + status.replace('_', ' ') + '.' + (shots.length ? ' ' + shots.length + ' photo(s) of the finished work.' : ''));
    await afterStatus(client, ctx, was, row, shots);
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

async function markRoutineDone(client, ctx, id, on, note, workOrderId, photos) {
  var r = await loadRoutine(id, client);
  await client.query('INSERT INTO maint_routine_log (routine_id, done_on, done_by_id, note, work_order_id, photos) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, on, ctx.employee.id, text(note, 300), workOrderId || null, JSON.stringify(photos || [])]);
  // A late record of an earlier time does not move the dates back.
  if (!r.last_day || on >= r.last_day) {
    await client.query('UPDATE maint_routines SET last_done_on = $2, next_on = $3, updated_at = now() WHERE id = $1',
      [id, on, r.every_days ? addDays(on, r.every_days) : null]);
  }
}

// POST /routines/:id/done { on?, note?, photos } — a manager, or whoever
// does it, with 1 to 3 photos of the finished work. A routine with a work
// order open is done by marking that work order done.
async function routineDone(ctx, id, body) {
  body = body || {};
  return withTransaction(async function (client) {
    var r = await loadRoutine(id, client);
    if (!canManage(ctx) && r.assigned_to_id !== ctx.employee.id) fail('forbidden', 'Only the work order managers, or whoever does this routine, can mark it done.');
    if (r.open_order_id) {
      var open = (await client.query('SELECT ref FROM maint_work_orders WHERE id = $1', [r.open_order_id])).rows[0];
      fail('conflict', 'This routine is work order ' + (open ? open.ref : '') + ' now: mark that work order done instead.');
    }
    var on = dayOr(body.on, 'Done on') || todayISO();
    if (on > todayISO()) fail('invalid', 'The day it was done cannot be in the future.');
    if (!Array.isArray(body.photos) || !body.photos.filter(Boolean).length) fail('invalid', PHOTO_NEEDED);
    var shots = await photosFrom(ctx, body.photos, String(r.ref || 'routine').toLowerCase() + '-done');
    await markRoutineDone(client, ctx, id, on, body.note, null, shots);
    await audit(client, ctx, 'maintwo.routine.done', 'maint_routine', id, 'Routine ' + r.ref + ' "' + r.name + '" done on ' + on + ', with ' + shots.length + ' photo(s).');
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
      "assigned_to_id, assigned_to_name, scheduled_on, notes, routine_id, created_by, photos) VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, 'medium', 'scheduled', $7, $8, $9, $10, $11, $2, $12) RETURNING *",
      [ref, ctx.employee.id, r.location, r.company_id, r.category, (r.name + (r.description ? ' — ' + r.description : '')).slice(0, 2000),
        r.assigned_to_id, r.assigned_to_name, on, r.schedule_note ? 'When: ' + r.schedule_note : '', r.id, JSON.stringify(r.photos || [])])).rows[0];
    await audit(client, ctx, 'maintwo.create', 'maint_work_order', row.id, 'Made ' + ref + ' from routine ' + r.ref + ' "' + r.name + '".');
    await tellAssigned(client, ctx, row, '🔁 Routine job');
    return (await loadOrder(ctx, row.id, client)).order;
  });
}

// ── My Jobs: one person's own jobs ──────────────────────────────────────

// GET /mine — the phone app's list: the jobs given to me still to do (late
// first, then by their day and how urgent), those I finished this week, and
// my routines with their next day.
var PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
async function mine(ctx) {
  var me = ctx.employee.id, today = todayISO();
  var rows = (await pool.query(SELECT_WO +
    "WHERE w.assigned_to_id = $1 AND (w.status IN ('new', 'scheduled', 'in_progress', 'on_hold') OR (w.status = 'completed' AND w.completed_on >= $2::date)) " +
    'ORDER BY w.created_at', [me, addDays(today, -7)])).rows;
  var orders = rows.map(function (r) { return shapeOrder(r, ctx); });
  var dayOf = function (o) { return o.scheduledOn || o.requestedOn || today; };
  var todo = orders.filter(function (o) { return o.open; }).sort(function (a, b) {
    return (dayOf(a) < dayOf(b) ? -1 : dayOf(a) > dayOf(b) ? 1 : 0) || ((PRIORITY_RANK[a.priority] || 2) - (PRIORITY_RANK[b.priority] || 2)) || (a.ref < b.ref ? -1 : 1);
  });
  var done = orders.filter(function (o) { return o.status === 'completed'; }).sort(function (a, b) { return a.completedOn < b.completedOn ? 1 : a.completedOn > b.completedOn ? -1 : 0; });
  var routines = (await pool.query(SELECT_RT + 'WHERE r.assigned_to_id = $1 AND r.archived_at IS NULL ORDER BY r.next_on NULLS LAST, r.name', [me])).rows
    .map(function (r) { return Object.assign(shapeRoutine(r), { addedByMe: r.created_by === me }); });
  var places = (await pool.query(
    "SELECT location, count(*)::int AS n FROM (SELECT location FROM maint_work_orders UNION ALL SELECT location FROM maint_routines) x WHERE location <> '' GROUP BY location ORDER BY n DESC, location LIMIT 60")).rows;
  var late = todo.filter(function (o) { return o.overdue; }).length;
  var now = todo.filter(function (o) { return !o.overdue && dayOf(o) <= today; }).length;
  return {
    today: today,
    me: { id: me, name: nameOf(ctx.employee.first_name, ctx.employee.last_name) },
    todo: todo, done: done, routines: routines,
    counts: { late: late, today: now, later: todo.length - late - now, doneThisWeek: done.length },
    options: { categories: CATEGORIES, priorities: PRIORITIES, places: places.map(function (p) { return p.location; }) },
    can: { manage: canManage(ctx), seeAll: seesAll(ctx) }
  };
}

// ── My Jobs: adding jobs and routines from the phone ────────────────────

// The work order managers hear what was added from My Jobs.
async function tellManagers(client, ctx, title, body, link) {
  var holders = await require('./staffAlerts.service').holdersOf(['task.manage']);
  for (var i = 0; i < holders.length; i++) {
    if (holders[i].employee_id === ctx.employee.id) continue;
    await notify(client, holders[i].employee_id, title, body, link);
  }
}
function whoName(ctx) { return nameOf(ctx.employee.first_name, ctx.employee.last_name) || 'Someone'; }

// POST /mine/jobs (and /api/myjobs/jobs) { description, location?, category?,
// priority?, scheduledOn?, notes?, forMe?, photos? } — photos: up to 4 of the
// problem (JPEG data URLs, made small on the phone) — a job added from My Jobs by
// whoever is signed in, a kiosk-code sign-in included: given to them and
// planned for its day (today unless said), or, with forMe false, left for
// the managers to give to someone. The managers hear of it either way.
async function addJob(ctx, body) {
  body = body || {};
  var description = longText(body.description, 2000);
  if (!description) fail('invalid', 'Say what needs doing.');
  var forMe = body.forMe !== false;
  return withTransaction(async function (client) {
    var location = text(body.location, 80);
    var day = dayOr(body.scheduledOn, 'The day') || (forMe ? todayISO() : null);
    if (day && day < addDays(todayISO(), -30)) fail('invalid', 'The day is too far back.');
    var ref = await nextRef(client, 'maint_work_orders', 'WO', 1000, 4);
    var shots = await photosFrom(ctx, body.photos, ref.toLowerCase(), MAX_REPORT_PHOTOS);
    var row = (await client.query(
      'INSERT INTO maint_work_orders (ref, requested_on, requested_by_id, location, company_id, category, description, priority, status, ' +
      'assigned_to_id, scheduled_on, notes, created_by, photos) VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $2, $12) RETURNING *',
      [ref, ctx.employee.id, location, (await companyMatcher(client))(location), pick(body.category, CATEGORIES, 'Kind of job', 'other'), description,
        pick(body.priority, PRIORITIES, 'How urgent', 'medium'), forMe ? 'scheduled' : (day ? 'scheduled' : 'new'),
        forMe ? ctx.employee.id : null, day, longText(body.notes, 2000), JSON.stringify(shots)])).rows[0];
    await audit(client, ctx, 'maintwo.create', 'maint_work_order', row.id, 'Added ' + ref + ' from My Jobs' + (forMe ? ', given to themselves' : ', for the managers to give out') +
      (shots.length ? ', with ' + shots.length + ' photo(s)' : '') + ': ' + text(description, 120));
    await tellManagers(client, ctx, (forMe ? '🛠️ ' + whoName(ctx) + ' added a job: ' : '🛠️ Job asked for: ') + ref + (location ? ' · ' + location : '') + (shots.length ? ' 📷' : ''),
      text(description, 140) + (forMe ? ' — they are doing it' + (day ? ' on ' + day : '') + '.' : ' — give it to someone.'), LINK + row.id);
    return (await loadOrder(ctx, row.id, client)).order;
  });
}

// POST /mine/routines (and /api/myjobs/routines) { name, description?,
// location?, category?, everyDays, nextOn?, scheduleNote?, photos? } — photos:
// new ones to add (data URLs); on a change, dropPhotos: [n] takes some out;
// up to 4 in all — a routine of
// one's own, added from My Jobs: given to whoever adds it, its first time on
// nextOn (today unless said). PATCH changes one they added; POST
// …/:id/stop puts it away. Routines given by the managers are theirs to change.
async function saveMyRoutine(ctx, id, body) {
  body = body || {};
  return withTransaction(async function (client) {
    var was = null;
    if (id) {
      was = await loadRoutine(id, client);
      if (was.created_by !== ctx.employee.id || was.assigned_to_id !== ctx.employee.id) fail('forbidden', 'Only a routine you added yourself can be changed here. Ask a work order manager for the others.');
      if (was.archived_at) fail('conflict', 'This routine has been stopped.');
    }
    var has = function (k) { return !was || body[k] !== undefined; };
    var f = {};
    if (has('name')) { f.name = text(body.name, 120); if (!f.name) fail('invalid', 'Say what is done each time.'); }
    if (has('description')) f.description = longText(body.description, 1000);
    if (has('location')) { f.location = text(body.location, 80); f.company_id = (await companyMatcher(client))(f.location); }
    if (has('category')) f.category = pick(body.category, CATEGORIES, 'Kind of job', 'other');
    if (has('scheduleNote')) f.schedule_note = text(body.scheduleNote, 80);
    if (has('everyDays')) {
      var n = Number(body.everyDays);
      if (!(Number.isInteger(n) && n >= 1 && n <= 3660)) fail('invalid', 'Say every how many days it comes round: a whole number from 1 to 3660.');
      f.every_days = n;
    }
    if (has('nextOn')) {
      f.next_on = dayOr(body.nextOn, 'The next time') || todayISO();
      if (f.next_on < todayISO()) fail('invalid', 'The next time must be today or later.');
    }
    // Its photos: the ones kept, then the new ones.
    var drop = Array.isArray(body.dropPhotos) ? body.dropPhotos.map(Number) : [];
    var kept = (was ? was.photos || [] : []).filter(function (p, n) { return drop.indexOf(n) < 0; });
    var room = MAX_REPORT_PHOTOS - kept.length;
    var added = room > 0 && Array.isArray(body.photos) && body.photos.length ? await photosFrom(ctx, body.photos, 'routine', room) : [];
    if (!was || drop.length || added.length) f.photos = JSON.stringify(kept.concat(added));
    var row;
    if (!was) {
      f.ref = await nextRef(client, 'maint_routines', 'RT', 0, 3);
      f.assigned_to_id = ctx.employee.id;
      f.created_by = ctx.employee.id;
      var keys = Object.keys(f);
      row = (await client.query('INSERT INTO maint_routines (' + keys.join(', ') + ') VALUES (' + keys.map(function (k, i) { return '$' + (i + 1); }).join(', ') + ') RETURNING id',
        keys.map(function (k) { return f[k]; }))).rows[0];
      await audit(client, ctx, 'maintwo.routine.create', 'maint_routine', row.id, 'Added routine ' + f.ref + ' "' + f.name + '" from My Jobs, every ' + f.every_days + ' days.');
      await tellManagers(client, ctx, '🔁 ' + whoName(ctx) + ' added a routine: ' + f.ref + (f.location ? ' · ' + f.location : ''),
        f.name + ' — every ' + f.every_days + ' days, next on ' + f.next_on + '.', '/tasks?side=maint');
    } else {
      var ks = Object.keys(f);
      if (ks.length) await client.query('UPDATE maint_routines SET ' + ks.map(function (k, i) { return k + ' = $' + (i + 2); }).join(', ') + ', updated_at = now() WHERE id = $1',
        [id].concat(ks.map(function (k) { return f[k]; })));
      row = { id: id };
      await audit(client, ctx, 'maintwo.routine.update', 'maint_routine', id, 'Changed routine ' + was.ref + ' "' + (f.name || was.name) + '" from My Jobs.');
    }
    return Object.assign(shapeRoutine(await loadRoutine(row.id, client)), { addedByMe: true });
  });
}

async function stopMyRoutine(ctx, id) {
  return withTransaction(async function (client) {
    var r = await loadRoutine(id, client);
    if (r.created_by !== ctx.employee.id || r.assigned_to_id !== ctx.employee.id) fail('forbidden', 'Only a routine you added yourself can be stopped here. Ask a work order manager for the others.');
    await client.query('UPDATE maint_routines SET archived_at = now(), updated_at = now() WHERE id = $1', [id]);
    await audit(client, ctx, 'maintwo.routine.archive', 'maint_routine', id, 'Stopped routine ' + r.ref + ' "' + r.name + '" from My Jobs.');
    await tellManagers(client, ctx, '🔁 ' + whoName(ctx) + ' stopped a routine: ' + r.ref, r.name + '.', '/tasks?side=maint');
    return { ok: true };
  });
}

// ── routines that become work orders by themselves ──────────────────────

function leadOf(every) { return every ? Math.max(0, Math.min(LEAD_DAYS, every - 1)) : LEAD_DAYS; }

// Every routine whose next day is close (LEAD_DAYS, or less for one that
// comes round sooner) and has no work order open becomes one, planned for
// that day and given to whoever does the routine, who hears of it; one with
// nobody on it is told to the work order managers. Run by
// jobs/maintRoutines.js; returns how many were made.
async function runDue(on) {
  var today = on || todayISO();
  var due = (await pool.query(SELECT_RT + 'WHERE r.archived_at IS NULL AND r.next_on IS NOT NULL AND r.next_on <= $1::date ORDER BY r.next_on, r.ref',
    [addDays(today, LEAD_DAYS)])).rows
    .filter(function (r) { return !r.open_order_id && r.next_day <= addDays(today, leadOf(r.every_days)); });
  var made = 0;
  for (var i = 0; i < due.length; i++) {
    var ok = await withTransaction(async function (client) {
      // One at a time per routine, and only if it still has nothing open.
      await client.query('SELECT id FROM maint_routines WHERE id = $1 FOR UPDATE', [due[i].id]);
      var r = await loadRoutine(due[i].id, client);
      if (r.open_order_id || r.archived_at || !r.next_day) return false;
      var ref = await nextRef(client, 'maint_work_orders', 'WO', 1000, 4);
      var row = (await client.query(
        'INSERT INTO maint_work_orders (ref, requested_on, requested_by_name, location, company_id, category, description, priority, status, ' +
        "assigned_to_id, assigned_to_name, scheduled_on, notes, routine_id, auto_made, photos) VALUES ($1, $2::date, 'Routine', $3, $4, $5, $6, 'medium', 'scheduled', $7, $8, $9, $10, $11, true, $12) RETURNING *",
        [ref, today, r.location, r.company_id, r.category, (r.name + (r.description ? ' — ' + r.description : '')).slice(0, 2000),
          r.assigned_to_id, r.assigned_to_name, r.next_day, r.schedule_note ? 'When: ' + r.schedule_note : '', r.id, JSON.stringify(r.photos || [])])).rows[0];
      await audit(client, null, 'maintwo.create', 'maint_work_order', row.id, 'Made ' + ref + ' by itself from routine ' + r.ref + ' "' + r.name + '", due ' + r.next_day + '.');
      if (row.assigned_to_id) {
        await notify(client, row.assigned_to_id, '🔁 Routine job ' + ref + (row.location ? ' · ' + row.location : ''),
          text(row.description, 140) + ' — ' + r.next_day, MY_LINK + row.id);
      } else {
        var holders = await require('./staffAlerts.service').holdersOf(['task.manage']);
        for (var h = 0; h < holders.length; h++) {
          await notify(client, holders[h].employee_id, '🔁 Routine job with nobody on it: ' + ref + (row.location ? ' · ' + row.location : ''),
            text(row.description, 140) + ' — ' + r.next_day + '. Give it to someone.', LINK + row.id);
        }
      }
      return true;
    });
    if (ok) made++;
  }
  return made;
}

// The morning list: from 06:00, once a day, each person with jobs to do
// today or late is told how many, opening My Jobs. Returns how many people
// were told.
async function morning(now) {
  now = now || new Date();
  if (now.getUTCHours() < MORNING_FROM_HOUR_UTC) return 0;
  var today = now.toISOString().slice(0, 10);
  var people = (await pool.query(
    "SELECT w.assigned_to_id AS id, count(*) FILTER (WHERE w.scheduled_on IS NULL OR w.scheduled_on <= $1::date)::int AS now_n, " +
    "count(*) FILTER (WHERE w.scheduled_on < $1::date)::int AS late_n, count(*) FILTER (WHERE w.priority IN ('urgent', 'high'))::int AS urgent_n " +
    "FROM maint_work_orders w JOIN employees e ON e.id = w.assigned_to_id " +
    "WHERE w.status IN ('new', 'scheduled', 'in_progress', 'on_hold') AND e.status = 'active' " +
    'AND NOT EXISTS (SELECT 1 FROM maint_morning_sent s WHERE s.employee_id = w.assigned_to_id AND s.day = $1::date) ' +
    'GROUP BY w.assigned_to_id', [today])).rows
    .filter(function (p) { return p.now_n > 0; });
  var told = 0;
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    var ok = await withTransaction(async function (client) {
      var first = (await client.query('INSERT INTO maint_morning_sent (employee_id, day, jobs) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING employee_id',
        [p.id, today, p.now_n])).rows[0];
      if (!first) return false;
      var extra = [p.late_n ? p.late_n + ' late' : '', p.urgent_n ? p.urgent_n + ' urgent' : ''].filter(Boolean).join(', ');
      await notify(client, p.id, '🔧 ' + (p.now_n === 1 ? '1 job for you today' : p.now_n + ' jobs for you today') + (extra ? ' (' + extra + ')' : ''),
        'Open My Jobs to see them. When one is done, take a photo of the finished work and mark it done.', '/myjobs');
      return true;
    });
    if (ok) told++;
  }
  return told;
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
  mine: mine, addJob: addJob, saveMyRoutine: saveMyRoutine, stopMyRoutine: stopMyRoutine, photoOf: photoOf, routinePhotoOf: routinePhotoOf, reportPhotoOf: reportPhotoOf, routineRefPhotoOf: routineRefPhotoOf, runDue: runDue, morning: morning, leadOf: leadOf,
  companyMatcher: companyMatcher, summarize: summarize,
  CATEGORIES: CATEGORIES, PRIORITIES: PRIORITIES, STATUSES: STATUSES
};
