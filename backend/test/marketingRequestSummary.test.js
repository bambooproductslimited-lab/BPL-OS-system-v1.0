// Ask marketing's summary (mkRequestSummary.service.js): a week or a month
// of requests — asked for and done against the same days before, on time
// or late, kinds, who asked and who did the work, every one done, the trend
// — and, as things stand now, what is late, waiting and coming up (with the
// requests routines will make). Marketing sees everyone's, optionally one
// company's; anyone else only their own. On throwaway ZRS requests for
// Bamboo Garden in February 2025, so nothing else lands in the period.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var summary = require('../src/services/mkRequestSummary.service');
var routines = require('../src/services/mkRoutines.service');
var S = require('../src/services/mkShared');

var boss, staff, helper, bgn, ids = {};
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
async function cleanup() {
  await pool.query("DELETE FROM marketing_requests WHERE title LIKE 'ZRS%'");
  await pool.query("DELETE FROM marketing_request_routines WHERE title LIKE 'ZRS%'");
}
async function request(key, f) {
  ids[key] = (await pool.query(
    'INSERT INTO marketing_requests (company_id, title, kind, due_on, priority, status, requested_by, assigned_to, created_at, done_at) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
    [bgn, 'ZRS ' + key, f.kind, f.due || null, f.priority || 'normal', f.status, f.by || boss.employee.id, f.lead || null, f.asked + 'T09:00:00Z', f.done ? f.done + 'T15:00:00Z' : null])).rows[0].id;
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  staff = await ctxFor('alice.kamau@bplghana.com');
  helper = await ctxFor('john.sitati@bplghana.com');
  bgn = (await pool.query("SELECT id FROM companies WHERE code = 'BGN'")).rows[0].id;
  await cleanup();
  var today = S.todayIso();
  await request('Banner', { kind: 'banner', asked: '2025-01-20', due: '2025-01-30', status: 'done', done: '2025-01-25', lead: boss.employee.id });
  await request('Post', { kind: 'social_post', asked: '2025-02-03', due: '2025-02-07', status: 'done', done: '2025-02-06', lead: boss.employee.id });
  await request('Flyer', { kind: 'flyer', asked: '2025-02-04', due: '2025-02-05', status: 'done', done: '2025-02-10', lead: boss.employee.id });
  await request('Reel', { kind: 'social_post', asked: '2025-02-12', due: '2025-02-20', status: 'in_progress', priority: 'urgent', lead: boss.employee.id });
  await request('Photos', { kind: 'photos', asked: '2025-02-26', due: addDays(today, 3), status: 'new' });
  await request('Menu card', { kind: 'other', asked: '2025-02-14', status: 'review', by: staff.employee.id });
  await pool.query('INSERT INTO marketing_request_members (request_id, employee_id, added_by) VALUES ($1, $2, $3)', [ids.Post, helper.employee.id, boss.employee.id]);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('a month: asked for and done against the month before, on time, kinds, who asked and who did the work', async function () {
  var s = await summary.summary(boss, { scope: 'all', company: 'BGN', period: 'month', from: '2025-02-17' });
  assert.equal(s.scope, 'all');
  assert.deepEqual(s.period.from + ' ' + s.period.to + ' ' + s.period.prevFrom + ' ' + s.period.prevUntil, '2025-02-01 2025-02-28 2025-01-01 2025-01-28');
  assert.equal(s.period.current, false);
  assert.deepEqual([s.made, s.madeBefore, s.urgent, s.done, s.doneBefore, s.onTime, s.onTimeBefore], [5, 1, 1, 2, 1, 1, 1]);
  assert.deepEqual([s.open, s.fresh, s.review, s.late], [3, 1, 1, 1], 'as things stand now');
  assert.deepEqual(s.kinds.map(function (k) { return [k.kind, k.made, k.done]; }), [['social_post', 2, 1], ['flyer', 1, 1], ['other', 1, 0], ['photos', 1, 0]]);
  assert.deepEqual(s.companies.map(function (c) { return [c.code, c.made, c.done, c.late]; }), [['BGN', 5, 2, 1]]);
  assert.deepEqual(s.askers.map(function (a) { return [a.id, a.n]; }), [[boss.employee.id, 4], [staff.employee.id, 1]]);
  var b = s.team.find(function (t) { return t.id === boss.employee.id; });
  assert.deepEqual([b.done, b.onTime, b.open, b.late, b.helped], [2, 1, 1, 1, 0]);
  var h = s.team.find(function (t) { return t.id === helper.employee.id; });
  assert.deepEqual([h.done, h.helped], [0, 1], 'the team who helped count too');

  assert.deepEqual(s.doneList.map(function (d) { return [d.title, d.doneOn, d.onTime, d.daysLate]; }), [['ZRS Post', '2025-02-06', true, 0], ['ZRS Flyer', '2025-02-10', false, 5]]);
  assert.equal(s.doneList[0].ref.slice(0, 3), 'MR-');
  assert.deepEqual(s.lateList.map(function (d) { return d.title; }), ['ZRS Reel']);
  assert.ok(s.lateList[0].daysLate > 600);
  assert.deepEqual(s.waiting.map(function (w) { return [w.title, w.status]; }), [['ZRS Photos', 'new'], ['ZRS Menu card', 'review']]);
  assert.equal(s.trend.length, 8);
  assert.deepEqual(s.trend.slice(-2).map(function (t) { return [t.from, t.made, t.done, t.onTime]; }), [['2025-01-01', 1, 1, 1], ['2025-02-01', 5, 2, 1]]);
  assert.deepEqual(s.insights.map(function (i) { return i.kind; }), ['late', 'not_taken', 'to_check', 'top_kind', 'top_doer', 'top_asker']);
});

test('a week, Monday to Sunday', async function () {
  var s = await summary.summary(boss, { scope: 'all', company: 'BGN', period: 'week', from: '2025-02-05' });
  assert.deepEqual([s.period.from, s.period.to, s.period.prevFrom], ['2025-02-03', '2025-02-09', '2025-01-27']);
  assert.deepEqual([s.made, s.madeBefore, s.done], [2, 0, 1], 'the flyer was done the Monday after');
  assert.equal(s.trend.length, 8);
  assert.equal(s.trend[7].from, '2025-02-03');
  await assert.rejects(summary.summary(boss, { period: 'week', from: addDays(S.todayIso(), 14) }), /not started yet/);
});

test('coming up: open requests due and the requests routines will make, in the next days', async function () {
  var today = S.todayIso();
  var wd = new Date(addDays(today, 2) + 'T00:00:00Z').getUTCDay();
  var rt = await routines.create(boss, { company: 'BGN', title: 'ZRS Weekly special', kind: 'social_post', every: 'week', weekdays: [wd], dueAfterDays: 1, startsOn: addDays(today, 1), assignedTo: boss.employee.id });
  var s = await summary.summary(boss, { scope: 'all', company: 'BGN', period: 'week' });
  assert.equal(s.period.current, true);
  assert.deepEqual(s.coming.due.map(function (d) { return d.title; }), ['ZRS Photos']);
  var mine = s.coming.routines.filter(function (u) { return u.routine === rt.id; });
  assert.equal(mine[0].on, addDays(today, 2));
  assert.equal(mine[0].dueOn, addDays(today, 3));
  assert.equal(mine[0].company.code, 'BGN');
  assert.equal(mine[0].lead, rt.lead.name);
  assert.equal(s.coming.to, addDays(today, 7));
  var month = await summary.summary(boss, { scope: 'all', company: 'BGN', period: 'month' });
  assert.equal(month.coming.to, addDays(today, 30));
  assert.ok(month.coming.routines.filter(function (u) { return u.routine === rt.id; }).length >= 4);
});

test('anyone else sees only their own requests, whatever they ask for', async function () {
  var s = await summary.summary(staff, { scope: 'all', company: 'BGN', period: 'month', from: '2025-02-01' });
  assert.equal(s.scope, 'mine');
  assert.equal(s.canSeeAll, false);
  assert.deepEqual([s.made, s.done, s.review], [1, 0, 1]);
  assert.deepEqual(s.waiting.map(function (w) { return w.title; }), ['ZRS Menu card']);
  var h = await summary.summary(helper, { period: 'month', from: '2025-02-01' });
  assert.deepEqual([h.made, h.done], [1, 1], 'on the team of the post');
  assert.deepEqual(h.doneList.map(function (d) { return d.title; }), ['ZRS Post']);
});
