// Payments and receipts: only Bamboo Products' invoices (as on the Invoices
// page), each payment linked to its receipt and invoice standing; removing
// a payment puts the amount back on the invoice and removes the receipt.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var invoices = require('../src/services/invoices.service');
var payments = require('../src/services/payments.service');
var receipts = require('../src/services/receipts.service');
var { buildContext } = require('../src/services/context.service');

var boss, cust;
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = await customers.create(boss, { name: 'Zqp Crate Co', phone: '0240000701', email: 'zqp@example.com', category: 'active' });
});
test.after(async function () {
  await pool.query('DELETE FROM payments WHERE customer_id = $1', [cust.id]);
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = $1)", [cust.id]);
  await pool.query('DELETE FROM invoices WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust.id]);
  await pool.end();
});

test('payments carry receipt and invoice standing; other companies are left out', async function () {
  var inv = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqp crate', qty: 4, unitPrice: 50 }] });
  var r1 = await invoices.recordPayment(boss, inv.id, { amount: 80, method: 'mobile_money', reference: 'ZQP-1' });
  var p = (await payments.list(boss)).find(function (x) { return x.id === r1.payment.id; });
  assert.equal(p.receiptNo, r1.receipt.receiptNo);
  assert.equal(p.balanceAfter, 120);
  assert.equal(p.invoiceStatus, 'partially_paid');
  assert.equal(p.invoiceBalance, 120);
  assert.equal(p.customerPhone, '0240000701');
  var rc = (await receipts.list(boss)).find(function (x) { return x.id === r1.receipt.id; });
  assert.equal(rc.invoiceTotal, 200);
  assert.equal(rc.customerEmail, 'zqp@example.com');

  var other = (await pool.query("SELECT id FROM companies WHERE code <> 'BPL' LIMIT 1")).rows[0];
  if (other) {
    var inv2 = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqp other', qty: 1, unitPrice: 10 }] });
    var r2 = await invoices.recordPayment(boss, inv2.id, { amount: 10, method: 'cash' });
    await pool.query('UPDATE invoices SET company_id = $1 WHERE id = $2', [other.id, inv2.id]);
    assert.equal((await payments.list(boss)).some(function (x) { return x.id === r2.payment.id; }), false);
    assert.equal((await receipts.list(boss)).some(function (x) { return x.id === r2.receipt.id; }), false);
  }
});

test('removing a payment restores the balance and removes its receipt', async function () {
  var inv = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqp lid', qty: 2, unitPrice: 25 }] });
  var r = await invoices.recordPayment(boss, inv.id, { amount: 50, method: 'cash' });
  assert.equal(r.invoice.status, 'paid');
  await payments.remove(boss, r.payment.id);
  var row = (await pool.query('SELECT status, balance_due, amount_paid, paid_at FROM invoices WHERE id = $1', [inv.id])).rows[0];
  assert.equal(row.status, 'unpaid');
  assert.equal(Number(row.balance_due), 50);
  assert.equal(row.paid_at, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM receipts WHERE payment_id = $1', [r.payment.id])).rows[0].n, 0);
});
