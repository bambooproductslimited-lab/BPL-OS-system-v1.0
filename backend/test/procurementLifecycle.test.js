// Purchase requests after the decision: a note with the decision, the
// order (supplier, actual cost) and the delivery, and the requester
// cancelling a request still waiting for a decision.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var proc = require('../src/services/procurement.service');
var { buildContext } = require('../src/services/context.service');

var boss, staff;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  staff = await ctxFor('samuel.kiptoo@bplghana.com');
});
test.after(async function () {
  var ids = (await pool.query("SELECT id FROM procurement_requests WHERE item LIKE 'Zqp%'")).rows.map(function (r) { return r.id; });
  await pool.query("DELETE FROM approvals WHERE subject_type = 'procurement_request' AND subject_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM notifications WHERE body LIKE 'Zqp%'");
  await pool.query("DELETE FROM procurement_requests WHERE item LIKE 'Zqp%'");
  await pool.end();
});

test('approve with a note, order from a supplier, receive with the real cost', async function () {
  var r = await proc.create(staff, { item: 'Zqp saw blades', quantity: 4, estimatedPrice: 800, reason: 'Blunt blades', priority: 'high' });
  await assert.rejects(function () { return proc.decide(staff, r.id, 'approved'); }, /own request|procurement.approve/);
  var d = await proc.decide(boss, r.id, 'approved', 'Buy the 10-inch ones');
  assert.deepEqual([d.status, d.decisionNote], ['approved', 'Buy the 10-inch ones']);
  var approval = (await pool.query("SELECT status, comment FROM approvals WHERE subject_id = $1", [r.id])).rows[0];
  assert.deepEqual([approval.status, approval.comment], ['approved', 'Buy the 10-inch ones']);

  await assert.rejects(function () { return proc.markReceived(boss, r.id, { actualCost: -1 }); }, /cost/);
  var supplier = (await pool.query('SELECT id, name FROM suppliers ORDER BY name LIMIT 1')).rows[0];
  var o = await proc.markOrdered(boss, r.id, { supplierId: supplier.id, actualCost: 760 });
  assert.deepEqual([o.status, o.actualCost, !!o.orderedAt], ['ordered', 760, true]);
  await assert.rejects(function () { return proc.markOrdered(boss, r.id, {}); }, /approved/);
  var got = await proc.markReceived(boss, r.id, { actualCost: 780 });
  assert.deepEqual([got.status, got.actualCost, !!got.receivedAt], ['received', 780, true]);

  var mine = (await proc.list(staff)).find(function (x) { return x.id === r.id; });
  assert.deepEqual([mine.mine, mine.supplierName, !!mine.deciderName, !!mine.orderedByName, !!mine.receivedByName], [true, supplier.name, true, true, true]);
});

test('the requester cancels a pending request; a decided one cannot be cancelled', async function () {
  var r = await proc.create(staff, { item: 'Zqp gloves', quantity: 10, reason: 'Safety' });
  var c = await proc.cancel(staff, r.id);
  assert.equal(c.status, 'cancelled');
  assert.equal((await pool.query('SELECT status FROM approvals WHERE subject_id = $1', [r.id])).rows[0].status, 'cancelled');
  await assert.rejects(function () { return proc.decide(boss, r.id, 'approved'); }, /already been decided/);
  var r2 = await proc.create(staff, { item: 'Zqp masks', quantity: 10, reason: 'Dust' });
  await proc.decide(boss, r2.id, 'rejected', 'Zqp we have stock');
  await assert.rejects(function () { return proc.cancel(staff, r2.id); }, /waiting for a decision/);
  var noApprove = Object.assign(Object.create(Object.getPrototypeOf(staff)), staff, { can: function (p) { return p !== 'procurement.approve' && staff.can(p); } });
  await assert.rejects(function () { return proc.markOrdered(noApprove, r2.id, {}); }, /procurement.approve/);
});
