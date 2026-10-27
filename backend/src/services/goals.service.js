var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Goals (Overview → Goals; migration 0200): what the company means to get
// done this quarter, and each team's part in it. An objective says what and
// why; its key results say how we will know — a number from where it
// started to its target (more sales, fewer rejects, a share, a sum of money,
// or simply done). Each key result has an owner who checks in every week:
// where it is now and how confident they are. Everyone sees the goals;
// goals.manage sets them. Key results without a check-in for a week are
// chased (jobs/dailyAlerts.js).

var KINDS = ['number', 'percent', 'money', 'done'];
var CONFIDENCE = ['on_track', 'at_risk', 'off_track'];

function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function round2(n) { return Math.round(n * 100) / 100; }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function can(ctx) { return ctx.can('goals.manage'); }
function need(ctx) { if (!can(ctx)) fail('forbidden', 'Your role does not allow this action (goals.manage).'); }

function periodOf(d) { d = d || new Date(); return d.getUTCFullYear() + '-Q' + (Math.floor(d.getUTCMonth() / 3) + 1); }
function periodBounds(period) {
  var y = Number(period.slice(0, 4)), q = Number(period.slice(-1));
  var start = new Date(Date.UTC(y, (q - 1) * 3, 1)), end = new Date(Date.UTC(y, q * 3, 1));
  return { start: start, end: end };
}
function shiftPeriod(period, n) {
  var y = Number(period.slice(0, 4)), q = Number(period.slice(-1)) - 1 + n;
  y += Math.floor(q / 4); q = ((q % 4) + 4) % 4;
  return y + '-Q' + (q + 1);
}
// How far into the quarter we are, 0 to 1.
function elapsed(period) {
  var b = periodBounds(period), now = Date.now();
  if (now <= b.start.getTime()) return 0;
  if (now >= b.end.getTime()) return 1;
  return (now - b.start.getTime()) / (b.end.getTime() - b.start.getTime());
}
// A key result's progress, 0 to 1: from its start towards its target (which
// may be lower than the start: fewer rejects).
function progressOf(k) {
  var start = Number(k.start_value), target = Number(k.target_value), cur = Number(k.current_value);
  if (k.kind === 'done') return cur >= 1 ? 1 : 0;
  if (target === start) return cur === target ? 1 : 0;
  return Math.max(0, Math.min(1, (cur - start) / (target - start)));
}

function krOut(k, myId) {
  var stale = !k.checked_at || Date.now() - new Date(k.checked_at).getTime() > 7 * 86400000;
  return {
    id: k.id, objectiveId: k.objective_id, title: k.title, kind: k.kind, unit: k.unit, start: Number(k.start_value), target: Number(k.target_value), current: Number(k.current_value),
    progress: Math.round(progressOf(k) * 100), confidence: k.confidence, owner: k.owner_id ? { id: k.owner_id, name: nameOf(k.first_name, k.last_name) } : null,
    checkedAt: k.checked_at, stale: stale, mine: !!myId && k.owner_id === myId, seq: k.seq
  };
}
var OSEL = 'SELECT o.*, e.first_name, e.last_name, d.name AS department, c.name AS company FROM goal_objectives o LEFT JOIN employees e ON e.id = o.owner_id LEFT JOIN departments d ON d.id = o.department_id LEFT JOIN companies c ON c.id = o.company_id ';
var KSEL = 'SELECT k.*, e.first_name, e.last_name FROM goal_key_results k LEFT JOIN employees e ON e.id = k.owner_id ';
function objectiveOut(o, krs, period) {
  var mineKrs = krs.filter(function (k) { return k.objectiveId === o.id; }).sort(function (a, b) { return a.seq - b.seq; });
  var progress = mineKrs.length ? Math.round(mineKrs.reduce(function (a, k) { return a + k.progress; }, 0) / mineKrs.length) : 0;
  var worst = mineKrs.some(function (k) { return k.confidence === 'off_track'; }) ? 'off_track' : mineKrs.some(function (k) { return k.confidence === 'at_risk'; }) ? 'at_risk' : 'on_track';
  var expected = Math.round(elapsed(period || o.period) * 100);
  return {
    id: o.id, period: o.period, level: o.level, title: o.title, why: o.why, status: o.status, parentId: o.parent_id,
    department: o.department_id ? { id: o.department_id, name: o.department } : null, company: o.company || null, companyId: o.company_id,
    owner: o.owner_id ? { id: o.owner_id, name: nameOf(o.first_name, o.last_name) } : null,
    keyResults: mineKrs, progress: o.status === 'done' ? 100 : progress, expected: expected, confidence: worst,
    pace: o.status !== 'active' ? o.status : progress >= expected - 10 ? 'ahead' : progress >= expected - 25 ? 'behind' : 'far_behind', seq: o.seq
  };
}

// GET /api/goals?period=2026-Q4
async function overview(ctx, q) {
  q = q || {};
  if (!me(ctx) && !can(ctx)) fail('forbidden', 'Only staff see the goals.');
  var current = periodOf();
  var period = /^\d{4}-Q[1-4]$/.test(String(q.period || '')) ? q.period : current;
  var objs = (await pool.query(OSEL + 'WHERE o.period = $1 ORDER BY o.level, o.seq, o.created_at', [period])).rows;
  var krs = objs.length ? (await pool.query(KSEL + 'WHERE k.objective_id = ANY($1) ORDER BY k.seq', [objs.map(function (o) { return o.id; })])).rows.map(function (k) { return krOut(k, me(ctx)); }) : [];
  var all = objs.map(function (o) { return objectiveOut(o, krs, period); });
  var company = all.filter(function (o) { return o.level === 'company'; });
  var teams = all.filter(function (o) { return o.level === 'team'; });
  company.forEach(function (o) { o.aligned = teams.filter(function (t) { return t.parentId === o.id; }).length; });
  var periods = (await pool.query('SELECT DISTINCT period FROM goal_objectives ORDER BY period')).rows.map(function (r) { return r.period; });
  [shiftPeriod(current, -1), current, shiftPeriod(current, 1)].forEach(function (x) { if (periods.indexOf(x) < 0) periods.push(x); });
  periods.sort();
  var live = krs.filter(function (k) { return all.find(function (o) { return o.id === k.objectiveId && o.status === 'active'; }); });
  var departments = (await pool.query('SELECT d.id, d.name, c.name AS company FROM departments d LEFT JOIN companies c ON c.id = d.company_id ORDER BY c.name, d.name')).rows;
  var people = (await pool.query("SELECT id, first_name, last_name FROM employees WHERE status = 'active' ORDER BY first_name, last_name")).rows.map(function (p) { return { id: p.id, name: nameOf(p.first_name, p.last_name) }; });
  return {
    period: period, current: current, periods: periods, elapsed: Math.round(elapsed(period) * 100),
    company: company, teams: teams, departments: departments, people: people, companies: (await pool.query('SELECT id, name FROM companies ORDER BY name')).rows,
    mine: krs.filter(function (k) { return k.mine; }), canManage: can(ctx), kinds: KINDS,
    summary: {
      objectives: all.filter(function (o) { return o.status !== 'dropped'; }).length,
      progress: company.length ? Math.round(company.reduce(function (a, o) { return a + o.progress; }, 0) / company.length) : null,
      keyResults: live.length, onTrack: live.filter(function (k) { return k.confidence === 'on_track'; }).length,
      atRisk: live.filter(function (k) { return k.confidence === 'at_risk'; }).length, offTrack: live.filter(function (k) { return k.confidence === 'off_track'; }).length,
      stale: live.filter(function (k) { return k.stale; }).length
    }
  };
}

async function objectiveOf(id) {
  var o = (await pool.query(OSEL + 'WHERE o.id = $1', [uuidOr(id)])).rows[0];
  if (!o) fail('notfound', 'That objective is gone.');
  return o;
}

// GET /api/goals/:id — an objective, its key results and their check-ins.
async function get(ctx, id) {
  if (!me(ctx) && !can(ctx)) fail('forbidden', 'Only staff see the goals.');
  var o = await objectiveOf(id);
  var krs = (await pool.query(KSEL + 'WHERE k.objective_id = $1 ORDER BY k.seq', [o.id])).rows.map(function (k) { return krOut(k, me(ctx)); });
  var out = objectiveOut(o, krs);
  var checkins = krs.length ? (await pool.query('SELECT c.*, e.first_name, e.last_name FROM goal_checkins c LEFT JOIN employees e ON e.id = c.by_id WHERE c.key_result_id = ANY($1) ORDER BY c.at', [krs.map(function (k) { return k.id; })])).rows : [];
  out.keyResults.forEach(function (k) {
    k.checkins = checkins.filter(function (c) { return c.key_result_id === k.id; }).map(function (c) { return { value: Number(c.value), confidence: c.confidence, note: c.note, by: nameOf(c.first_name, c.last_name), at: c.at }; });
    k.canCheckIn = k.mine || can(ctx) || (o.owner_id && o.owner_id === me(ctx));
  });
  out.parent = o.parent_id ? (await pool.query('SELECT id, title FROM goal_objectives WHERE id = $1', [o.parent_id])).rows[0] || null : null;
  var kids = (await pool.query(OSEL + 'WHERE o.parent_id = $1 ORDER BY o.seq', [o.id])).rows;
  var kidKrs = kids.length ? (await pool.query(KSEL + 'WHERE k.objective_id = ANY($1)', [kids.map(function (x) { return x.id; })])).rows.map(function (k) { return krOut(k, me(ctx)); }) : [];
  out.children = kids.map(function (x) { return objectiveOut(x, kidKrs); });
  out.canManage = can(ctx);
  return out;
}

function cleanKr(k, n) {
  var kind = KINDS.indexOf(k && k.kind) >= 0 ? k.kind : 'number';
  var title = text(k && k.title, 160);
  if (title.length < 4) fail('invalid', 'Key result ' + (n + 1) + ': what will be measured?');
  var start = kind === 'done' ? 0 : Number(k.start), target = kind === 'done' ? 1 : Number(k.target);
  if (!isFinite(start) || !isFinite(target)) fail('invalid', '"' + title + '": a start and a target.');
  if (kind !== 'done' && start === target) fail('invalid', '"' + title + '": the target is where it starts.');
  if (kind === 'percent' && (target < 0 || target > 100 || start < 0 || start > 100)) fail('invalid', '"' + title + '": a share is between 0 and 100.');
  return { title: title, kind: kind, unit: kind === 'percent' ? '%' : kind === 'money' ? 'GHS' : text(k.unit, 12), start: round2(start), target: round2(target), owner: uuidOr(k.ownerId) };
}

// POST /api/goals { period, level, title, why, companyId, departmentId,
// parentId, ownerId, keyResults: [{ title, kind, unit, start, target, ownerId }] }
async function create(ctx, p) {
  need(ctx);
  p = p || {};
  var period = /^\d{4}-Q[1-4]$/.test(String(p.period || '')) ? p.period : periodOf();
  var level = p.level === 'team' ? 'team' : 'company';
  var title = text(p.title, 160);
  if (title.length < 5) fail('invalid', 'What is the objective?');
  var dept = level === 'team' ? uuidOr(p.departmentId) : null;
  if (level === 'team' && !dept) fail('invalid', 'Which team?');
  var parent = uuidOr(p.parentId);
  if (parent) {
    var par = (await pool.query('SELECT period, level FROM goal_objectives WHERE id = $1', [parent])).rows[0];
    if (!par || par.level !== 'company' || par.period !== period) fail('invalid', 'A team objective lines up under one of the company\'s, the same quarter.');
  }
  var krs = (Array.isArray(p.keyResults) ? p.keyResults : []).slice(0, 6).map(cleanKr);
  if (!krs.length) fail('invalid', 'Add at least one key result: how will you know?');
  var owner = uuidOr(p.ownerId) || me(ctx);
  var company = uuidOr(p.companyId) || (dept ? ((await pool.query('SELECT company_id FROM departments WHERE id = $1', [dept])).rows[0] || {}).company_id : null) || null;
  var row = await withTransaction(async function (db) {
    var seq = (await db.query('SELECT coalesce(max(seq), 0) + 1 AS n FROM goal_objectives WHERE period = $1 AND level = $2', [period, level])).rows[0].n;
    var o = (await db.query('INSERT INTO goal_objectives (period, level, title, why, company_id, department_id, parent_id, owner_id, seq, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [period, level, title, text(p.why, 1000), company, dept, level === 'team' ? parent : null, owner, seq, me(ctx)])).rows[0];
    for (var i = 0; i < krs.length; i++) {
      await db.query('INSERT INTO goal_key_results (objective_id, title, kind, unit, start_value, target_value, current_value, owner_id, seq) VALUES ($1,$2,$3,$4,$5,$6,$5,$7,$8)',
        [o.id, krs[i].title, krs[i].kind, krs[i].unit, krs[i].start, krs[i].target, krs[i].owner || owner, i + 1]);
    }
    return o;
  });
  var told = {};
  var owners = krs.map(function (k) { return k.owner || owner; }).concat([owner]);
  for (var j = 0; j < owners.length; j++) {
    if (!owners[j] || owners[j] === me(ctx) || told[owners[j]]) continue;
    told[owners[j]] = true;
    await notify(pool, owners[j], '🎯 A goal for ' + period + ': ' + title, 'You own a key result. Check in each week: where it is, and how confident you are.', '/goals?objective=' + row.id);
  }
  await audit(pool, ctx, 'goals.create', 'goal_objective', row.id, period + ' objective "' + title + '" with ' + krs.length + ' key results.');
  return get(ctx, row.id);
}

// PUT /api/goals/:id { title, why, ownerId, status, parentId }
async function update(ctx, id, p) {
  need(ctx);
  p = p || {};
  var o = await objectiveOf(id);
  var title = p.title === undefined ? o.title : text(p.title, 160);
  if (title.length < 5) fail('invalid', 'What is the objective?');
  var status = ['active', 'done', 'dropped'].indexOf(p.status) >= 0 ? p.status : o.status;
  await pool.query('UPDATE goal_objectives SET title = $2, why = $3, owner_id = $4, status = $5 WHERE id = $1',
    [o.id, title, p.why === undefined ? o.why : text(p.why, 1000), p.ownerId === undefined ? o.owner_id : uuidOr(p.ownerId), status]);
  await audit(pool, ctx, 'goals.update', 'goal_objective', o.id, 'Objective "' + title + '" ' + (status !== o.status ? status : 'changed') + '.');
  return get(ctx, o.id);
}

// POST /api/goals/:id/key-results { title, kind, unit, start, target, ownerId }
async function addKeyResult(ctx, id, p) {
  need(ctx);
  var o = await objectiveOf(id);
  var count = (await pool.query('SELECT count(*)::int AS n FROM goal_key_results WHERE objective_id = $1', [o.id])).rows[0].n;
  if (count >= 6) fail('invalid', 'Six key results at most: keep it to what matters.');
  var k = cleanKr(p || {}, count);
  await pool.query('INSERT INTO goal_key_results (objective_id, title, kind, unit, start_value, target_value, current_value, owner_id, seq) VALUES ($1,$2,$3,$4,$5,$6,$5,$7,$8)',
    [o.id, k.title, k.kind, k.unit, k.start, k.target, k.owner || o.owner_id, count + 1]);
  await audit(pool, ctx, 'goals.kr', 'goal_objective', o.id, 'Key result "' + k.title + '" added.');
  return get(ctx, o.id);
}

// POST /api/goals/key-results/:id/checkin { value, confidence, note } — its
// owner, the objective's owner, or whoever sets the goals.
async function checkIn(ctx, id, p) {
  p = p || {};
  var k = (await pool.query('SELECT k.*, o.owner_id AS o_owner, o.status AS o_status, o.title AS o_title, o.id AS o_id FROM goal_key_results k JOIN goal_objectives o ON o.id = k.objective_id WHERE k.id = $1', [uuidOr(id)])).rows[0];
  if (!k) fail('notfound', 'That key result is gone.');
  if (!can(ctx) && k.owner_id !== me(ctx) && k.o_owner !== me(ctx)) fail('forbidden', 'That key result is not yours.');
  if (k.o_status !== 'active') fail('conflict', 'That objective is ' + (k.o_status === 'done' ? 'done' : 'dropped') + '.');
  var value = k.kind === 'done' ? (p.value === true || Number(p.value) >= 1 ? 1 : 0) : Number(p.value);
  if (!isFinite(value)) fail('invalid', 'Where is it now?');
  if (k.kind === 'percent' && (value < 0 || value > 100)) fail('invalid', 'A share is between 0 and 100.');
  var confidence = CONFIDENCE.indexOf(p.confidence) >= 0 ? p.confidence : fail('invalid', 'How confident are you: on track, at risk or off track?');
  var note = text(p.note, 1000);
  await pool.query('INSERT INTO goal_checkins (key_result_id, value, confidence, note, by_id) VALUES ($1,$2,$3,$4,$5)', [k.id, round2(value), confidence, note, me(ctx)]);
  await pool.query('UPDATE goal_key_results SET current_value = $2, confidence = $3, checked_at = now() WHERE id = $1', [k.id, round2(value), confidence]);
  // Slipping to off track: the objective's owner hears straight away.
  if (confidence === 'off_track' && k.confidence !== 'off_track' && k.o_owner && k.o_owner !== me(ctx)) {
    await notify(pool, k.o_owner, '🔴 Off track: ' + k.title, (note || 'No note.') + ' — ' + k.o_title, '/goals?objective=' + k.o_id);
  }
  await audit(pool, ctx, 'goals.checkin', 'goal_objective', k.o_id, '"' + k.title + '" now ' + round2(value) + ' (' + confidence + ').');
  return get(ctx, k.o_id);
}

// GET /api/goals/mine — My space: the key results I own this quarter.
async function mine(ctx) {
  if (!me(ctx)) return { period: periodOf(), keyResults: [] };
  var period = periodOf();
  var rows = (await pool.query(KSEL.replace('FROM goal_key_results k', ', o.title AS o_title, o.id AS o_id FROM goal_key_results k JOIN goal_objectives o ON o.id = k.objective_id') +
    "WHERE k.owner_id = $1 AND o.period = $2 AND o.status = 'active' ORDER BY o.seq, k.seq", [me(ctx), period])).rows;
  return {
    period: period, elapsed: Math.round(elapsed(period) * 100),
    keyResults: rows.map(function (k) { var o = krOut(k, me(ctx)); o.objective = { id: k.o_id, title: k.o_title }; return o; })
  };
}

// For the daily round: key results this quarter not checked in for a week.
async function staleKeyResults() {
  return (await pool.query("SELECT k.id, k.title, k.owner_id, k.checked_at, o.title AS o_title, o.id AS o_id FROM goal_key_results k JOIN goal_objectives o ON o.id = k.objective_id " +
    "WHERE o.status = 'active' AND o.period = $1 AND k.owner_id IS NOT NULL AND (k.checked_at IS NULL OR k.checked_at < now() - interval '7 days')", [periodOf()])).rows;
}

module.exports = { overview: overview, get: get, create: create, update: update, addKeyResult: addKeyResult, checkIn: checkIn, mine: mine, staleKeyResults: staleKeyResults, periodOf: periodOf, progressOf: progressOf, shiftPeriod: shiftPeriod };
