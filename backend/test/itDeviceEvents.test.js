// IT devices: handing a device over and back, changes of status, IT checks,
// tags that never repeat, devices still with people who have left — and
// every one of those in the device's history.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var it = require('../src/services/itDevices.service');
var { buildContext } = require('../src/services/context.service');

var boss, viewer, alice, moses, leaverId, ids = [];
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}
function today() { return new Date().toISOString().slice(0, 10); }
async function listed(id) { return (await it.list(viewer)).find(function (x) { return x.id === id; }); }
async function kinds(id) { return (await it.history(viewer, id)).map(function (e) { return e.kind + (e.status ? ':' + e.status : ''); }); }

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  viewer = limited(boss, ['itdevice.manage']);
  alice = (await ctxFor('alice.kamau@bplghana.com')).employee;
  moses = (await ctxFor('moses.wekesa@bplghana.com')).employee;
  leaverId = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status) " +
    "SELECT 'ZQI-1', 'Zqi', 'Leaver', 'zqi.leaver@example.com', department_id, 'Tester', 'permanent', '2020-01-01', 'active' FROM employees WHERE id = $1 RETURNING id", [alice.id]
  )).rows[0].id;
});
test.after(async function () {
  await pool.query('DELETE FROM it_devices WHERE id = ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM employees WHERE id = $1', [leaverId]);
  await pool.end();
});

test('a device is handed over, passed on and returned to storage; each step is in its history', async function () {
  var d = await it.create(boss, { category: 'Zqi Laptop', brand: 'Zqi', model: 'Book 14', assignedEmployeeId: alice.id });
  ids.push(d.id);
  assert.match(d.deviceTag, /^IT-\d{3,}$/);
  assert.deepEqual([d.status, d.assignedEmployeeId, !!d.assignedAt], ['in_use', alice.id, true]);
  await assert.rejects(function () { return it.assign(boss, d.id, { employeeId: alice.id }); }, /already with/);
  await assert.rejects(function () { return it.assign(viewer, d.id, { employeeId: moses.id }); }, /itdevice.manage/);

  var passed = await it.assign(boss, d.id, { employeeId: moses.id, note: 'Zqi new role' });
  assert.equal(passed.assignedEmployeeId, moses.id);
  var back = await it.assign(boss, d.id, { employeeId: null, condition: 'fair' });
  assert.deepEqual([back.assignedEmployeeId, back.assignedAt, back.status, back.condition, back.location], [null, null, 'in_storage', 'fair', 'IT store']);
  await assert.rejects(function () { return it.assign(boss, d.id, {}); }, /not with anyone/);
  assert.deepEqual(await kinds(d.id), ['return', 'assign', 'return', 'assign']);
  var h = await it.history(viewer, d.id);
  assert.deepEqual([h[0].employeeId, h[0].condition, h[1].employeeId, h[1].note, !!h[1].byName], [moses.id, 'fair', moses.id, 'Zqi new role', true]);
  assert.equal((await listed(d.id)).handovers, 2);
});

test('retiring or losing a device takes it off the person; it cannot be handed out again until it is back', async function () {
  var d = await it.create(boss, { category: 'Zqi Phone', assignedEmployeeId: alice.id });
  ids.push(d.id);
  var lost = await it.setStatus(boss, d.id, { status: 'lost', note: 'Zqi left in a taxi' });
  assert.deepEqual([lost.status, lost.assignedEmployeeId], ['lost', null]);
  await assert.rejects(function () { return it.assign(boss, d.id, { employeeId: alice.id }); }, /lost/);
  await assert.rejects(function () { return it.setStatus(boss, d.id, { status: 'stolen' }); }, /Status/);
  await it.setStatus(boss, d.id, { status: 'in_storage' });
  assert.equal((await it.assign(boss, d.id, { employeeId: alice.id })).status, 'in_use');
  var repair = await it.setStatus(boss, d.id, { status: 'under_repair' });
  assert.deepEqual([repair.status, repair.assignedEmployeeId], ['under_repair', alice.id]); // repair keeps who it belongs to
  assert.deepEqual(await kinds(d.id), ['status:under_repair', 'assign', 'status:in_storage', 'status:lost', 'return', 'assign']);
  assert.equal((await it.history(viewer, d.id))[3].note, 'Zqi left in a taxi');
});

test('an IT check records the day and condition; edits change only what was sent and log a new person or status', async function () {
  var d = await it.create(boss, { category: 'Zqi Monitor', brand: 'Zqi', serialNumber: 'ZQI-SN', purchasePrice: 900 });
  ids.push(d.id);
  var c = await it.markChecked(boss, d.id, { condition: 'poor', note: 'Zqi dead pixels' });
  assert.deepEqual([c.lastCheckedOn, c.condition], [today(), 'poor']);
  var u = await it.update(boss, d.id, { location: 'Zqi office 2', assignedEmployeeId: alice.id, status: 'in_use' });
  assert.deepEqual([u.location, u.serialNumber, u.purchasePrice, u.brand, u.assignedEmployeeId, !!u.assignedAt], ['Zqi office 2', 'ZQI-SN', 900, 'Zqi', alice.id, true]);
  await it.update(boss, d.id, { notes: 'Zqi note' }); // nothing about the person or status: nothing logged
  assert.deepEqual(await kinds(d.id), ['assign', 'check']);
  await assert.rejects(function () { return it.update(boss, d.id, { condition: 'broken' }); }, /Condition/);
});

test('tags never repeat after a gap; a device still with someone who left is flagged, and nothing new can be handed to them', async function () {
  var a = await it.create(boss, { category: 'Zqi Tablet' });
  ids.push(a.id);
  var n = Number(a.deviceTag.slice(3));
  await pool.query('UPDATE it_devices SET device_tag = $1 WHERE id = $2', ['IT-' + (n + 5), a.id]);
  var b = await it.create(boss, { category: 'Zqi Tablet' });
  ids.push(b.id);
  assert.equal(b.deviceTag, 'IT-' + String(n + 6).padStart(3, '0'));
  await assert.rejects(function () { return it.create(boss, { category: 'Zqi Tablet', deviceTag: b.deviceTag }); }, /already exists/);

  await it.assign(boss, a.id, { employeeId: leaverId });
  assert.equal((await listed(a.id)).assigneeLeft, false);
  await pool.query("UPDATE employees SET status = 'terminated' WHERE id = $1", [leaverId]);
  var l = await listed(a.id);
  assert.deepEqual([l.assigneeLeft, l.assigneeName], [true, 'Zqi Leaver']);
  await assert.rejects(function () { return it.assign(boss, b.id, { employeeId: leaverId }); }, /left the company/);
});
