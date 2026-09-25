// Announcements: a whole company as an audience; who has read and
// confirmed each one; publishers see the counts and who has not read it;
// editing, pinning and deleting need announcement.publish.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var ann = require('../src/services/announcements.service');
var { buildContext } = require('../src/services/context.service');

var boss, staff, staffId, restaurantId, annIds = [];

async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  staff = limited(await ctxFor('samuel.kiptoo@bplghana.com'), ['announcement.publish', 'employee.read.all']);
  staffId = staff.employee.id;
  restaurantId = (await pool.query("SELECT id FROM companies WHERE code <> 'BPL' ORDER BY code LIMIT 1")).rows[0].id;
});
test.after(async function () {
  await pool.query('DELETE FROM announcements WHERE id = ANY($1)', [annIds]);
  await pool.query("DELETE FROM notifications WHERE body LIKE 'Anq%'");
  await pool.end();
});

test('everyone sees an all-staff announcement; reading and confirming are recorded', async function () {
  var a = await ann.publish(boss, { title: 'Anq safety drill', body: 'Friday 10am at the yard.', category: 'safety', requiresAck: true, pinned: true });
  annIds.push(a.id);
  assert.ok(a.audienceCount >= 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND title = 'Please read and confirm' AND body = 'Anq safety drill'", [staffId])).rows[0].n, 1);

  var mine = (await ann.list(staff)).find(function (x) { return x.id === a.id; });
  assert.deepEqual([mine.read, mine.acknowledged, mine.category, mine.requiresAck, mine.pinned], [false, false, 'safety', true, true]);
  assert.equal(mine.readCount, undefined); // counts are for publishers

  await ann.markRead(staff, [a.id]);
  await ann.acknowledge(staff, a.id);
  mine = (await ann.list(staff)).find(function (x) { return x.id === a.id; });
  assert.deepEqual([mine.read, mine.acknowledged], [true, true]);

  var forBoss = (await ann.list(boss)).find(function (x) { return x.id === a.id; });
  assert.ok(forBoss.readCount >= 1 && forBoss.ackCount >= 1);
  var who = await ann.readers(boss, a.id);
  var me = who.find(function (r) { return r.id === staffId; });
  assert.ok(me.readAt && me.acknowledgedAt);
  assert.equal(who.some(function (r) { return r.id === boss.employee.id; }), false);
});

test('a company audience is only seen by that company', async function () {
  var a = await ann.publish(boss, { title: 'Anq restaurant menu change', body: 'New menu from Monday.', audience: 'company', companyId: restaurantId, expiresOn: '2020-01-01' });
  annIds.push(a.id);
  assert.equal(a.audienceScope, 'company');
  assert.equal((await ann.list(staff)).some(function (x) { return x.id === a.id; }), false);
  var forBoss = (await ann.list(boss)).find(function (x) { return x.id === a.id; });
  assert.equal(forBoss.expired, true);
  await assert.rejects(function () { return ann.acknowledge(staff, a.id); }, /scope/);
  var r = await ann.markRead(staff, [a.id]);
  assert.equal(r.marked, 0);
});

test('publishers edit, pin and delete; others cannot', async function () {
  var id = annIds[0];
  var u = await ann.update(boss, id, { title: 'Anq safety drill moved', body: 'Now Saturday.', category: 'event', audience: 'all' });
  assert.equal(u.title, 'Anq safety drill moved');
  assert.ok(u.updatedAt);
  await ann.setPinned(boss, id, false);
  assert.equal((await pool.query('SELECT pinned FROM announcements WHERE id = $1', [id])).rows[0].pinned, false);
  await assert.rejects(function () { return ann.update(staff, id, { title: 'x', body: 'y' }); }, /announcement\.publish/);
  await assert.rejects(function () { return ann.remove(staff, id); }, /announcement\.publish/);
  await assert.rejects(function () { return ann.readers(staff, id); }, /announcement\.publish/);
  await ann.remove(boss, id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM announcements WHERE id = $1', [id])).rows[0].n, 0);
});
