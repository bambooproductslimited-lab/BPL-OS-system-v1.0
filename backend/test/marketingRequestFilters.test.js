// Filtering the board of requests to marketing (mkRequests.service.js
// list): by days, weeks, months or years of when it was asked for, needed
// by or done; by type, a person on it, urgent, late, from a routine, and
// words. The banner's totals stay those of every request in scope. On
// throwaway ZMF requests, dated by hand.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var requests = require('../src/services/mkRequests.service');
var S = require('../src/services/mkShared');

var boss, staff, helper, a, b, c;
async function cleanup() {
  await pool.query("DELETE FROM notifications WHERE link IN (SELECT '/mkrequests?open=' || id FROM marketing_requests WHERE title LIKE 'ZMF%')");
  await pool.query("DELETE FROM marketing_requests WHERE title LIKE 'ZMF%'");
}
// Someone who manages marketing, and two on staff who do not see it all.
async function people() {
  var users = (await pool.query("SELECT id FROM users WHERE status = 'active' AND employee_id IS NOT NULL ORDER BY email")).rows;
  var out = { boss: null, staff: [] };
  for (var i = 0; i < users.length && (!out.boss || out.staff.length < 2); i++) {
    var ctx = await buildContext(users[i].id);
    if (!ctx) continue;
    if (!out.boss && ctx.can('marketing.manage')) out.boss = ctx;
    else if (!ctx.can('marketing.read') && out.staff.length < 2) out.staff.push(ctx);
  }
  return out;
}
function zmf(list) { return list.requests.filter(function (r) { return /^ZMF/.test(r.title); }).map(function (r) { return r.title; }).sort(); }
// The day n days from today.
function days(n) { return new Date(Date.parse(S.todayIso() + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }

test.before(async function () {
  var p = await people();
  boss = p.boss; staff = p.staff[0]; helper = p.staff[1];
  assert.ok(boss && staff && helper, 'the seed has a marketing manager and two others on staff');
  await cleanup();
  a = await requests.create(staff, { company: 'BPL', title: 'ZMF Flyer for the fair', kind: 'flyer', brief: 'ZMF A5, both sides', priority: 'urgent' });
  b = await requests.create(staff, { company: 'BPL', title: 'ZMF Showroom video', kind: 'video', brief: 'ZMF one minute', dueOn: days(10) });
  c = await requests.create(staff, { company: 'BPL', title: 'ZMF Price list', kind: 'other', brief: 'ZMF monthly' });
  // A was asked for in March last year and is late; B in January; C is done today.
  var lastYear = String(Number(S.todayIso().slice(0, 4)) - 1);
  await pool.query("UPDATE marketing_requests SET created_at = $2::date + time '10:00', due_on = $3 WHERE id = $1", [a.id, lastYear + '-03-10', days(-5)]);
  await pool.query("UPDATE marketing_requests SET created_at = $2::date + time '09:00' WHERE id = $1", [b.id, S.todayIso().slice(0, 4) + '-01-15']);
  await pool.query("UPDATE marketing_requests SET status = 'done', done_at = now() WHERE id = $1", [c.id]);
  await requests.update(boss, b.id, { title: b.title, kind: b.kind, brief: b.brief, dueOn: days(10), assignedTo: boss.employee.id });
  await requests.setTeam(boss, b.id, { employeeIds: [helper.employee.id] });
});
test.after(async function () { await cleanup(); await pool.end(); });

test('by when it was asked for: a day, a month, a year', async function () {
  var y = Number(S.todayIso().slice(0, 4));
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', from: (y - 1) + '-01-01', to: (y - 1) + '-12-31' })), ['ZMF Flyer for the fair']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', from: (y - 1) + '-03-10', to: (y - 1) + '-03-10' })), ['ZMF Flyer for the fair']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', from: y + '-01-01', to: y + '-01-31' })), ['ZMF Showroom video']);
  // A day with nothing asked; the dates are whole days, both ends kept.
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', from: (y - 1) + '-03-11', to: (y - 1) + '-03-11' })), []);
  // Not a date: no filter.
  assert.equal(zmf(await requests.list(boss, { scope: 'all', from: 'last year' })).length, 3);
});

test('by the date it is needed by, or when it was done', async function () {
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', dateBy: 'needed', from: days(5), to: days(15) })), ['ZMF Showroom video']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', dateBy: 'needed', from: days(-7), to: days(-1) })), ['ZMF Flyer for the fair']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', dateBy: 'done', from: S.todayIso(), to: S.todayIso() })), ['ZMF Price list']);
});

test('by type, a person on it, urgent, late, from a routine, and words', async function () {
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', kind: 'video' })), ['ZMF Showroom video']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', kind: 'not-a-kind' })).length, 3);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', person: helper.employee.id })), ['ZMF Showroom video']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', person: staff.employee.id })), ['ZMF Flyer for the fair', 'ZMF Price list', 'ZMF Showroom video']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', urgent: '1' })), ['ZMF Flyer for the fair']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', late: '1' })), ['ZMF Flyer for the fair']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', routine: '1' })), []);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', q: 'zmf price' })), ['ZMF Price list']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', q: 'one minute' })), ['ZMF Showroom video']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', q: b.ref })), ['ZMF Showroom video']);
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', q: '100%_' })), []);
  // Together: urgent and asked for this year — none.
  assert.deepEqual(zmf(await requests.list(boss, { scope: 'all', urgent: '1', from: S.todayIso().slice(0, 4) + '-01-01', to: S.todayIso() })), []);
});

test('the counts follow the filters; the banner\'s totals and the people to pick from do not', async function () {
  var whole = await requests.list(boss, { scope: 'all' });
  var some = await requests.list(boss, { scope: 'all', kind: 'video' });
  assert.equal(whole.filtered, false);
  assert.equal(some.filtered, true);
  assert.deepEqual(some.totals, whole.totals);
  assert.equal(whole.totals.counts.done, whole.counts.done);
  assert.ok(some.counts.in_progress + some.counts.new + some.counts.review + some.counts.done < whole.requests.length);
  assert.ok(whole.totals.overdue >= 1 && whole.totals.doneMonth >= 1);
  assert.deepEqual(some.people.map(function (x) { return x.id; }), whole.people.map(function (x) { return x.id; }));
  assert.ok(some.people.some(function (x) { return x.id === helper.employee.id; }));
  // Someone on staff filters only their own.
  var mine = await requests.list(helper, { scope: 'all', from: '2000-01-01' });
  assert.equal(mine.scope, 'mine');
  assert.deepEqual(zmf(mine), ['ZMF Showroom video']);
});
