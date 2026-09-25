// Marketing dashboard: the biggest customers are by what they were invoiced
// over the last twelve months, voided invoices and older ones left out.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var invoices = require('../src/services/invoices.service');
var reports = require('../src/services/reports.service');
var { buildContext } = require('../src/services/context.service');

var boss, cust;
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = await customers.create(boss, { name: 'Zqm Top Buyer', category: 'vip' });
});
test.after(async function () {
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = $1)", [cust.id]);
  await pool.query('DELETE FROM invoices WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust.id]);
  await pool.end();
});

test('biggest customers by invoiced value, last 12 months', async function () {
  await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqm big order', qty: 1, unitPrice: 9000000 }] });
  var v = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqm wrong', qty: 1, unitPrice: 5000000 }] });
  await invoices.voidInvoice(boss, v.id);
  var old = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqm old', qty: 1, unitPrice: 7000000 }] });
  await pool.query("UPDATE invoices SET issued_at = CURRENT_DATE - 400 WHERE id = $1", [old.id]);
  var d = await reports.marketingDashboard(boss, 'BPL');
  var top = d.topCustomers.find(function (c) { return c.name === 'Zqm Top Buyer'; });
  assert.ok(top, 'the customer is among the biggest');
  assert.equal(top.total, 9000000);
  assert.equal(top.invoices, 1);
});
