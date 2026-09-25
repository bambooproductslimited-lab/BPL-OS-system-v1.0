// The daily stock sheet at a glance: a strip of days with what was entered,
// counted, received and sold, the last day filled in before a gap, and the
// prices and photo each line carries for the page. Uses Z8D products and
// days in March 2025.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var svc = require('../src/services/stockSheet.service');

var admin = { can: function () { return true; }, employee: { id: null }, user: { id: null } };
var nobody = { can: function () { return false; }, employee: { id: null }, user: { id: null } };
var mats;

test.before(async function () {
  await pool.query("DELETE FROM products WHERE sku LIKE 'Z8D%'");
  mats = (await pool.query("INSERT INTO products (sku, name, category, unit, current_stock, selling_price, cost_price) VALUES ('Z8D-MAT', 'Z8D Mat', 'Z8D', 'pcs', 50, 20, 8) RETURNING id")).rows[0].id;
});
test.after(async function () { await pool.query("DELETE FROM products WHERE sku LIKE 'Z8D%'"); await pool.end(); });

test('the strip of days shows lines, counts that did not match, received and sold', async function () {
  await svc.saveLine(admin, '2025-03-10', mats, { opening: 50, received: 10, sold: 5 });
  await svc.saveLine(admin, '2025-03-12', mats, { opening: 55, sold: 3, physical: 50 });
  var r = await svc.days(admin, '2025-03-12', 3);
  assert.ok(r.products >= 1);
  var byDate = {};
  r.days.forEach(function (d) { byDate[d.date] = d; });
  assert.deepEqual(Object.keys(byDate), ['2025-03-10', '2025-03-11', '2025-03-12']);
  var d10 = byDate['2025-03-10'], d11 = byDate['2025-03-11'], d12 = byDate['2025-03-12'];
  assert.ok(d10.lines >= 1 && d10.received >= 10 && d10.sold >= 5 && d10.soldValue >= 100);
  assert.equal(d11.lines >= 0, true);
  assert.ok(d12.counted >= 1 && d12.variances >= 1, 'counted 50 where 52 was expected');
  await assert.rejects(svc.days(nobody, '2025-03-12', 3), /inventory\.read/);
  await assert.rejects(svc.days(admin, 'soon', 3), /valid date/);
});

test('a day knows the last day filled in before it, and carries prices for its lines', async function () {
  var day = await svc.getDay(admin, '2025-03-12');
  assert.ok(day.lastFilledBefore >= '2025-03-10' && day.lastFilledBefore < '2025-03-12');
  var line = day.lines.find(function (l) { return l.productId === mats; });
  assert.deepEqual([line.sellingPrice, line.costPrice, line.photo, line.closing], [20, 8, null, 50]);
});
