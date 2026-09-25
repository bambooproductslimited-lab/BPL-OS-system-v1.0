// Tool room: check-out with a due-back day, check-in with the condition it
// came back in, materials issued and restocked, counts corrected, items
// retired — and every one of those in the item's history.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var toolRoom = require('../src/services/toolRoom.service');
var { buildContext } = require('../src/services/context.service');

var boss, viewer, alice, ids = [];
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}
function plus(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
async function listed(id) { return (await toolRoom.list(viewer)).find(function (x) { return x.id === id; }); }

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  viewer = limited(boss, ['toolroom.manage']);
  alice = (await ctxFor('alice.kamau@bplghana.com')).employee;
});
test.after(async function () {
  await pool.query('DELETE FROM tool_room_items WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
});

test('a tool goes out with a due-back day, is overdue once that passes, and comes back in the condition recorded', async function () {
  var t = await toolRoom.create(boss, { code: 'ZQT-1', name: 'Zqt drill', kind: 'tool', category: 'Power tools' });
  ids.push(t.id);
  await assert.rejects(function () { return toolRoom.checkout(boss, t.id, {}); }, /who is taking/);
  await assert.rejects(function () { return toolRoom.checkout(boss, t.id, { employeeId: alice.id, dueBack: plus(-1) }); }, /past/);
  await assert.rejects(function () { return toolRoom.checkout(viewer, t.id, { employeeId: alice.id }); }, /toolroom.manage/);
  await assert.rejects(function () { return toolRoom.checkin(boss, t.id, {}); }, /not checked out/);

  var out = await toolRoom.checkout(boss, t.id, { employeeId: alice.id, dueBack: plus(2), note: 'Zqt fence job' });
  assert.deepEqual([out.status, out.checkedOutTo, out.dueBack, !!out.checkedOutAt], ['checked_out', alice.id, plus(2), true]);
  await assert.rejects(function () { return toolRoom.checkout(boss, t.id, { employeeId: alice.id }); }, /already checked out/);
  await assert.rejects(function () { return toolRoom.setRetired(boss, t.id, true); }, /back in before/);
  var l = await listed(t.id);
  assert.deepEqual([l.overdue, l.daysOut, l.timesOut, l.checkedOutToName.length > 0], [false, 0, 1, true]);

  await pool.query('UPDATE tool_room_items SET due_back = $1 WHERE id = $2', [plus(-3), t.id]);
  assert.equal((await listed(t.id)).overdue, true);

  var back = await toolRoom.checkin(boss, t.id, { condition: 'poor', note: 'Zqt chuck loose' });
  assert.deepEqual([back.status, back.checkedOutTo, back.dueBack, back.checkedOutAt, back.condition], ['available', null, null, null, 'poor']);

  // the old single endpoint still works both ways
  assert.equal((await toolRoom.setCheckout(boss, t.id, alice.id)).status, 'checked_out');
  assert.equal((await toolRoom.setCheckout(boss, t.id, null)).status, 'available');

  var h = await toolRoom.history(viewer, t.id);
  assert.deepEqual(h.map(function (m) { return m.kind; }), ['checkin', 'checkout', 'checkin', 'checkout']);
  var firstOut = h[3];
  assert.deepEqual([firstOut.employeeId, firstOut.dueBack, firstOut.note, !!firstOut.byName], [alice.id, plus(2), 'Zqt fence job', true]);
  assert.deepEqual([h[2].condition, h[2].employeeId, h[2].note], ['poor', alice.id, 'Zqt chuck loose']);

  await toolRoom.update(boss, t.id, { condition: 'under_repair' });
  await assert.rejects(function () { return toolRoom.checkout(boss, t.id, { employeeId: alice.id }); }, /under repair/);
});

test('materials are issued and restocked, never below zero; a new count is logged; usage over 30 days adds up', async function () {
  var m = await toolRoom.create(boss, { code: 'ZQM-1', name: 'Zqm wood glue', kind: 'material', unit: 'litre', quantityOnHand: 10, reorderLevel: 4 });
  ids.push(m.id);
  await assert.rejects(function () { return toolRoom.checkout(boss, m.id, { employeeId: alice.id }); }, /Issue them/);
  await assert.rejects(function () { return toolRoom.issue(boss, m.id, { quantity: 0 }); }, /more than 0/);
  await assert.rejects(function () { return toolRoom.issue(boss, m.id, { quantity: 11 }); }, /Only 10 litre/);

  assert.equal((await toolRoom.issue(boss, m.id, { quantity: 4, employeeId: alice.id, note: 'Zqm chairs' })).quantityOnHand, 6);
  assert.equal((await toolRoom.issue(boss, m.id, { quantity: 2.5 })).quantityOnHand, 3.5);
  var l = await listed(m.id);
  assert.deepEqual([l.used30, l.lowStock], [6.5, true]);
  assert.equal((await toolRoom.restock(boss, m.id, { quantity: 20, note: 'Zqm delivery' })).quantityOnHand, 23.5);
  assert.equal((await listed(m.id)).lowStock, false);

  // an edit that leaves the count alone logs nothing; a new count is logged
  await toolRoom.update(boss, m.id, { location: 'Zqm shelf B' });
  var u = await toolRoom.update(boss, m.id, { quantityOnHand: 22 });
  assert.deepEqual([u.quantityOnHand, u.location, u.name], [22, 'Zqm shelf B', 'Zqm wood glue']);
  var h = await toolRoom.history(viewer, m.id);
  assert.deepEqual(h.map(function (x) { return [x.kind, x.quantity]; }), [['count', 22], ['restock', 20], ['issue', 2.5], ['issue', 4], ['count', 10]]);
  assert.equal(h[3].employeeId, alice.id);

  var tool = await toolRoom.create(boss, { code: 'ZQT-2', name: 'Zqt saw', kind: 'tool' });
  ids.push(tool.id);
  await assert.rejects(function () { return toolRoom.issue(boss, tool.id, { quantity: 1 }); }, /Only materials/);
});

test('a retired item cannot go out or be issued; bringing it back makes it available; retiring is logged', async function () {
  var m = await toolRoom.create(boss, { code: 'ZQM-2', name: 'Zqm sandpaper', kind: 'material', quantityOnHand: 5, reorderLevel: 10 });
  var t = await toolRoom.create(boss, { code: 'ZQT-3', name: 'Zqt clamp', kind: 'equipment' });
  ids.push(m.id, t.id);
  await toolRoom.setRetired(boss, m.id, true, { note: 'Zqm no longer used' });
  await toolRoom.setRetired(boss, t.id, true);
  await assert.rejects(function () { return toolRoom.issue(boss, m.id, { quantity: 1 }); }, /retired/);
  await assert.rejects(function () { return toolRoom.checkout(boss, t.id, { employeeId: alice.id }); }, /retired/);
  assert.equal((await listed(m.id)).lowStock, false); // a retired material is not "low"
  var r = await toolRoom.setRetired(boss, t.id, false);
  assert.equal(r.status, 'available');
  assert.deepEqual((await toolRoom.history(viewer, t.id)).map(function (x) { return x.kind; }), ['restore', 'retire']);
  assert.equal((await toolRoom.history(viewer, m.id))[0].note, 'Zqm no longer used');
  await assert.rejects(function () { return toolRoom.setRetired(viewer, t.id, true); }, /toolroom.manage/);
});
