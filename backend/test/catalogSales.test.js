// Products & Services: each variation carries what it sold over the last
// twelve months on Bamboo Products' invoices — matched by the catalogue
// code kept on the line, or by name for older lines — leaving out voided
// invoices; document lines now keep the code of the product picked.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var catalog = require('../src/services/catalog.service');
var invoices = require('../src/services/invoices.service');
var { buildContext } = require('../src/services/context.service');

var boss, cust, item;
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = await customers.create(boss, { name: 'Zqk Tray Shop', category: 'active' });
  item = await catalog.create(boss, { name: 'Zqk Serving Tray', code: 'ZQK-TRAY', unit: 'each', unitPrice: 40, costPrice: 25 });
});
test.after(async function () {
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = $1)", [cust.id]);
  await pool.query('DELETE FROM invoices WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust.id]);
  await pool.query('DELETE FROM catalog_items WHERE id = $1', [item.id]);
  await pool.end();
});

test('sales per variation by code or name, voided invoices left out', async function () {
  var a = await invoices.createManual(boss, { customerId: cust.id, items: [{ itemNo: 'zqk-tray', description: 'Tray, custom wording', qty: 5, unitPrice: 40, discount: 10, discountType: 'percent' }] });
  assert.equal((await pool.query("SELECT item_no FROM document_line_items WHERE document_id = $1", [a.id])).rows[0].item_no, 'zqk-tray');
  await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqk Serving Tray', qty: 2, unitPrice: 50 }] });
  var v = await invoices.createManual(boss, { customerId: cust.id, items: [{ itemNo: 'ZQK-TRAY', description: 'Zqk Serving Tray', qty: 100, unitPrice: 40 }] });
  await invoices.voidInvoice(boss, v.id);
  var old = await invoices.createManual(boss, { customerId: cust.id, items: [{ itemNo: 'ZQK-TRAY', description: 'Zqk Serving Tray', qty: 7, unitPrice: 40 }] });
  await pool.query("UPDATE invoices SET issued_at = CURRENT_DATE - 400 WHERE id = $1", [old.id]);

  var row = (await catalog.listItems(boss)).find(function (x) { return x.id === item.id; });
  var sold = row.variations[0].sold;
  assert.equal(sold.qty, 7);
  assert.deepEqual(sold.amounts, [{ currency: 'GHS', amount: 280 }]);
  assert.equal(sold.invoices, 2);
  assert.ok(sold.lastSoldOn);
});
