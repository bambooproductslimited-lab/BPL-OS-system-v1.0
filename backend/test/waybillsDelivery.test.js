// Waybills: marking one delivered records who signed for it and a note;
// only a waybill on the road can be delivered or cancelled.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var waybills = require('../src/services/waybills.service');
var { buildContext } = require('../src/services/context.service');

var boss, ids = [];
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }

test.before(async function () { boss = await ctxFor('kelvin.duho@bplghana.com'); });
test.after(async function () {
  await pool.query("DELETE FROM document_line_items WHERE doc_type = 'waybill' AND doc_id = ANY($1::uuid[])", [ids]).catch(function () {});
  await pool.query('DELETE FROM waybills WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
});

test('delivered with who signed and a note; a delivered waybill cannot be cancelled', async function () {
  var w = await waybills.create(boss, { origin: 'factory', destination: 'Zqw Tema', shippedToName: 'Zqw Hotel', items: [{ description: 'Zqw slats', qty: 20, unit: 'piece' }] });
  ids.push(w.id);
  var d = await waybills.setStatus(boss, w.id, 'delivered', { receivedBy: 'Zqw Ama (store keeper)', note: '2 slats cracked' });
  assert.deepEqual([d.status, d.receivedBy, !!d.deliveredAt], ['delivered', 'Zqw Ama (store keeper)', true]);
  assert.match(d.notes, /Delivery: 2 slats cracked/);
  await assert.rejects(function () { return waybills.setStatus(boss, w.id, 'cancelled'); }, /already delivered/);
  var back = await waybills.setStatus(boss, w.id, 'dispatched');
  assert.deepEqual([back.status, back.deliveredAt], ['dispatched', null]);
  var list = await waybills.list(boss);
  assert.ok(list.find(function (x) { return x.id === w.id; }).dispatchedByName);
});
