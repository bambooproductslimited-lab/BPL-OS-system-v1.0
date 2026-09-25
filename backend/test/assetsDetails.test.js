// Assets & maintenance: editing an asset (company, serial, status,
// service interval), planned work marked done later, and the next service
// date moving on by itself.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var assets = require('../src/services/assets.service');
var maint = require('../src/services/maintenance.service');
var { buildContext } = require('../src/services/context.service');

var boss, viewer, ids = [];
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}
function today() { return new Date().toISOString().slice(0, 10); }
function plus(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  viewer = limited(boss, ['asset.manage']);
});
test.after(async function () {
  await pool.query('DELETE FROM assets WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
});

test('an asset gets a company, serial and interval; edits change only what was sent; retiring records the day', async function () {
  var company = (await pool.query('SELECT id FROM companies ORDER BY code LIMIT 1')).rows[0].id;
  var a = await assets.create(boss, { category: 'Zqa Machine', description: 'Zqa planer', companyId: company, serialNo: 'SN-1', serviceIntervalDays: 90 });
  ids.push(a.id);
  assert.match(a.assetNo, /^AST-\d{3,}$/);
  assert.deepEqual([a.companyId, a.serialNo, a.serviceIntervalDays, a.status], [company, 'SN-1', 90, 'in_use']);
  var u = await assets.update(boss, a.id, { location: 'Zqa workshop', condition: 'fair' });
  assert.deepEqual([u.location, u.condition, u.serialNo, u.description], ['Zqa workshop', 'fair', 'SN-1', 'Zqa planer']);
  await assert.rejects(function () { return assets.update(boss, a.id, { status: 'lost' }); }, /Status/);
  await assert.rejects(function () { return assets.update(boss, a.id, { serviceIntervalDays: -3 }); }, /interval/);
  await assert.rejects(function () { return assets.update(viewer, a.id, { location: 'x' }); }, /asset.manage/);
  var r = await assets.update(boss, a.id, { status: 'retired' });
  assert.deepEqual([r.status, r.retiredOn], ['retired', today()]);
  var back = await assets.update(boss, a.id, { status: 'in_use' });
  assert.equal(back.retiredOn, null);
});

test('planned work is marked done later; a completed service moves the next one on; totals show on the asset', async function () {
  var a = await assets.create(boss, { category: 'Zqa Vehicle', description: 'Zqa truck', serviceIntervalDays: 30, status: 'in_repair' });
  ids.push(a.id);
  var plan = await maint.create(boss, { assetId: a.id, status: 'scheduled', date: plus(10), faultReport: 'Zqa oil change' });
  assert.equal(plan.status, 'scheduled');
  var listed = (await assets.list(viewer)).find(function (x) { return x.id === a.id; });
  assert.deepEqual([listed.nextServiceDate, listed.openRecords, listed.maintenanceCount], [plus(10), 1, 0]);

  await assert.rejects(function () { return maint.create(boss, { assetId: a.id, date: plus(3), technician: 'x', faultReport: 'x' }); }, /future/);
  var done = await maint.complete(boss, plan.id, { technician: 'Zqa garage', cost: 450, downtimeHours: 5, partsReplaced: 'Oil filter' });
  assert.deepEqual([done.status, done.cost, !!done.completedAt], ['completed', 450, true]);
  await assert.rejects(function () { return maint.complete(boss, plan.id, {}); }, /already/);
  listed = (await assets.list(viewer)).find(function (x) { return x.id === a.id; });
  assert.deepEqual([listed.nextServiceDate, listed.status, listed.maintenanceCount, listed.maintenanceCost, listed.downtimeHours, listed.lastService, listed.openRecords],
    [plus(30), 'in_use', 1, 450, 5, today(), 0]);

  var plan2 = await maint.create(boss, { assetId: a.id, status: 'scheduled', date: plus(5), faultReport: 'Zqa tyres' });
  await assert.rejects(function () { return maint.remove(viewer, plan2.id); }, /asset.manage/);
  assert.equal(await maint.remove(boss, plan2.id), true);
  await assert.rejects(function () { return maint.remove(boss, done.id); }, /stays on record/);
});
