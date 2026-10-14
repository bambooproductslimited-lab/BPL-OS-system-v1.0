// Marketing request routines (mkRoutines.service.js, migration 0148): the
// schedule maths; a routine makes an ordinary request on each day it comes
// round — with its lead, team and campaign — once only, catching up a week
// at most; paused it makes nothing; stopped, its requests stay. Anyone may
// set one up; only marketing sets the lead and team. On throwaway ZMR data.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var routines = require('../src/services/mkRoutines.service');
var requests = require('../src/services/mkRequests.service');
var S = require('../src/services/mkShared');

var boss, staff, helper;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function wd(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
async function cleanup() {
  await pool.query("DELETE FROM notifications WHERE link IN (SELECT '/mkrequests?open=' || id FROM marketing_requests WHERE title LIKE 'ZMR%')");
  await pool.query("DELETE FROM marketing_requests WHERE title LIKE 'ZMR%'");
  await pool.query("DELETE FROM marketing_request_routines WHERE title LIKE 'ZMR%'");
}
async function made(id) {
  return (await pool.query('SELECT id, routine_on, due_on, assigned_to, status FROM marketing_requests WHERE routine_id = $1 ORDER BY routine_on', [id])).rows;
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  staff = await ctxFor('alice.kamau@bplghana.com');
  helper = await ctxFor('john.sitati@bplghana.com');
  await cleanup();
});
test.after(async function () { await cleanup(); await pool.end(); });

test('the schedule: weekdays every N weeks, a day every N months, the 31st as the month\'s end, an end date', function () {
  var monThu = { every: 'week', every_n: 1, weekdays: [1, 4], starts_on: '2030-01-02', ends_on: null }; // a Wednesday
  assert.equal(routines._nextOn(monThu, '2030-01-02'), '2030-01-03');
  assert.equal(routines._nextOn(monThu, '2030-01-04'), '2030-01-07');
  var fortnight = { every: 'week', every_n: 2, weekdays: [1], starts_on: '2030-01-07', ends_on: null };
  assert.equal(routines._nextOn(fortnight, '2030-01-08'), '2030-01-21');
  var monthEnd = { every: 'month', every_n: 1, month_day: 31, starts_on: '2030-01-01', ends_on: null };
  assert.equal(routines._nextOn(monthEnd, '2030-02-01'), '2030-02-28');
  assert.equal(routines._nextOn(monthEnd, '2030-03-01'), '2030-03-31');
  var quarterly = { every: 'month', every_n: 3, month_day: 15, starts_on: '2030-01-10', ends_on: '2030-06-30' };
  assert.equal(routines._nextOn(quarterly, '2030-01-10'), '2030-01-15');
  assert.equal(routines._nextOn(quarterly, '2030-01-16'), '2030-04-15');
  assert.equal(routines._nextOn(quarterly, '2030-04-16'), null, 'ended');
});

test('a routine makes its request on the day, with the lead and team, once; then on its next day', async function () {
  var today = S.todayIso();
  await assert.rejects(routines.create(boss, { company: 'BPL', title: 'ZMR Post', every: 'week', weekdays: [] }), /day or days of the week/);
  await assert.rejects(routines.create(boss, { company: 'BPL', title: 'ZMR Post', every: 'week', weekdays: [1], startsOn: addDays(today, -3) }), /already passed/);
  await assert.rejects(routines.create(boss, { company: 'BPL', title: 'ZMR Post', every: 'month', monthDay: 5, startsOn: today, endsOn: addDays(today, -1) }), /ends before/);

  var rt = await routines.create(boss, {
    company: 'BPL', title: 'ZMR Instagram post', kind: 'social_post', brief: 'This week\'s offer', every: 'week', weekdays: [wd(today)], dueAfterDays: 2,
    assignedTo: boss.employee.id, teamIds: [helper.employee.id, boss.employee.id]
  });
  assert.equal(rt.madeNow, 1, 'it comes round today, so the first is made straight away');
  assert.deepEqual(rt.team.map(function (m) { return m.id; }), [helper.employee.id], 'the lead is not also on the team');
  assert.equal(rt.nextOn, addDays(today, 7));
  assert.equal(rt.made, 1);

  var list = await made(rt.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].routine_on, today);
  assert.equal(list[0].due_on, addDays(today, 2));
  assert.equal(list[0].assigned_to, boss.employee.id);
  var req = await requests.get(helper, list[0].id);
  assert.equal(req.title, 'ZMR Instagram post');
  assert.deepEqual(req.routine, { id: rt.id, on: today });
  assert.deepEqual(req.team.map(function (m) { return m.id; }), [helper.employee.id]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND link = $2', [helper.employee.id, '/mkrequests?open=' + list[0].id])).rows[0].n, 1, 'the team is told');

  // Run again the same day: nothing more. A week on: the next one.
  assert.equal(await routines.runDue(today), 0);
  assert.equal(await routines.runDue(addDays(today, 6)), 0);
  assert.ok(await routines.runDue(addDays(today, 7)) >= 1);
  list = await made(rt.id);
  assert.deepEqual(list.map(function (r) { return r.routine_on; }), [today, addDays(today, 7)]);

  // After weeks off, only the last week's day is made.
  await pool.query('UPDATE marketing_request_routines SET next_on = $2 WHERE id = $1', [rt.id, addDays(today, 14)]);
  await routines.runDue(addDays(today, 35));
  list = await made(rt.id);
  assert.deepEqual(list.map(function (r) { return r.routine_on; }), [today, addDays(today, 7), addDays(today, 35)]);
  assert.equal((await routines.get(boss, rt.id)).nextOn, addDays(today, 42));
});

test('paused it makes nothing and resumes from today; stopped, its requests stay', async function () {
  var today = S.todayIso();
  var rt = await routines.create(boss, { company: 'BPL', title: 'ZMR Price list', every: 'month', monthDay: 28, startsOn: addDays(today, 1), assignedTo: boss.employee.id });
  assert.equal(rt.madeNow, 0);
  rt = await routines.setPaused(boss, rt.id, { paused: true });
  assert.equal(rt.paused, true);
  assert.equal(rt.nextOn, null);
  await routines.runDue(addDays(today, 70));
  assert.equal((await made(rt.id)).length, 0);
  rt = await routines.setPaused(boss, rt.id, { paused: false });
  assert.ok(rt.nextOn >= today);

  await pool.query('UPDATE marketing_request_routines SET next_on = $2 WHERE id = $1', [rt.id, today]);
  await routines.runDue(today);
  var one = (await made(rt.id))[0];
  assert.ok(one);
  await routines.remove(boss, rt.id);
  var kept = (await pool.query('SELECT routine_id FROM marketing_requests WHERE id = $1', [one.id])).rows[0];
  assert.equal(kept.routine_id, null, 'the request stays, no longer tied to a routine');
});

test('anyone may set one up; only marketing picks the lead and team; it is theirs to change', async function () {
  var today = S.todayIso();
  var rt = await routines.create(staff, { company: 'BPL', title: 'ZMR Monthly flyer', kind: 'flyer', every: 'month', monthDay: 1, startsOn: addDays(today, 1), assignedTo: helper.employee.id, teamIds: [helper.employee.id] });
  assert.equal(rt.lead, null, 'not marketing: no lead');
  assert.deepEqual(rt.team, []);
  assert.equal(rt.mine, true);
  assert.ok((await routines.list(staff, {})).some(function (x) { return x.id === rt.id; }));
  await assert.rejects(routines.get(helper, rt.id), /not yours/);
  assert.ok((await routines.list(boss, { scope: 'all' })).some(function (x) { return x.id === rt.id; }), 'marketing sees them all');

  // Made with no lead: marketing is told.
  await pool.query('UPDATE marketing_request_routines SET next_on = $2 WHERE id = $1', [rt.id, today]);
  await routines.runDue(today);
  var req = (await made(rt.id))[0];
  assert.equal(req.assigned_to, null);
  assert.ok((await pool.query('SELECT 1 FROM notifications WHERE employee_id = $1 AND link = $2', [boss.employee.id, '/mkrequests?open=' + req.id])).rows[0]);

  // Marketing gives it a lead; the owner changes the schedule but can't touch the lead.
  rt = await routines.update(boss, rt.id, { title: 'ZMR Monthly flyer', kind: 'flyer', every: 'month', monthDay: 1, startsOn: rt.startsOn, assignedTo: helper.employee.id });
  assert.equal(rt.lead.id, helper.employee.id);
  rt = await routines.update(staff, rt.id, { title: 'ZMR Monthly flyer', kind: 'flyer', every: 'month', monthDay: 15, startsOn: rt.startsOn, assignedTo: null });
  assert.equal(rt.monthDay, 15);
  assert.equal(rt.lead.id, helper.employee.id, 'only marketing changes the lead');
  assert.ok(rt.nextOn > today, 'what was made today is not made again');
  await assert.rejects(routines.update(helper, rt.id, { title: 'ZMR x', every: 'month', monthDay: 2, startsOn: rt.startsOn }), /set it up, or marketing/);
  assert.equal((await routines.get(helper, rt.id)).lead.id, helper.employee.id, 'the lead sees it');
});
