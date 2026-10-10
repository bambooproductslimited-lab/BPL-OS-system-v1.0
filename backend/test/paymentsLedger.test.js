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
  await pool.query("DELETE FROM audit_logs WHERE action = 'payment.redate' AND summary LIKE '%Zqp Crate Co%'");
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

test('a payment on the wrong day moves to the day the money came in, with its receipt, and the log says why', async function () {
  var inv = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqp pallet', qty: 1, unitPrice: 300 }] });
  var first = await invoices.recordPayment(boss, inv.id, { amount: 100, method: 'cash', date: '2026-01-05' });
  var last = await invoices.recordPayment(boss, inv.id, { amount: 200, method: 'cash' }); // recorded today, by mistake
  var moved = await payments.changeDate(boss, last.payment.id, { date: '2026-01-20', reason: 'Zqp: paid in January, recorded late' });
  assert.deepEqual([moved.date, moved.was.length], ['2026-01-20', 10]);
  var p = (await pool.query('SELECT date FROM payments WHERE id = $1', [last.payment.id])).rows[0];
  var r = (await pool.query('SELECT date FROM receipts WHERE payment_id = $1', [last.payment.id])).rows[0];
  var i = (await pool.query('SELECT paid_at, status FROM invoices WHERE id = $1', [inv.id])).rows[0];
  assert.deepEqual([String(p.date).slice(0, 10), String(r.date).slice(0, 10), i.status, String(i.paid_at).slice(0, 10)], ['2026-01-20', '2026-01-20', 'paid', '2026-01-20'], 'the receipt and the paid date follow');
  var log = (await pool.query("SELECT summary FROM audit_logs WHERE action = 'payment.redate' AND entity_id = $1", [inv.id])).rows[0];
  assert.match(log.summary, /from \d{4}-\d{2}-\d{2} to 2026-01-20: Zqp: paid in January, recorded late/);
  assert.equal((await payments.list(boss)).find(function (x) { return x.id === first.payment.id; }).source, 'manual');

  // What it will not do.
  await assert.rejects(payments.changeDate(boss, last.payment.id, { date: '2099-01-01', reason: 'x' }), /future/);
  await assert.rejects(payments.changeDate(boss, last.payment.id, { date: '2026-01-02' }), /Reason is required/);
  await assert.rejects(payments.changeDate(boss, last.payment.id, { date: '2026-01-20', reason: 'x' }), /already on that date/);
  await pool.query("UPDATE payments SET source = 'square' WHERE id = $1", [first.payment.id]);
  await assert.rejects(payments.changeDate(boss, first.payment.id, { date: '2026-01-02', reason: 'x' }), /Square/);
  await pool.query("UPDATE payments SET source = 'manual' WHERE id = $1", [first.payment.id]);
  var reader = Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function (x) { return x === 'invoice.read'; } });
  await assert.rejects(payments.changeDate(reader, first.payment.id, { date: '2026-01-02', reason: 'x' }), /invoice\.manage/);
  var pokiOnly = Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function (x) { return x === 'poki.manage'; } });
  await assert.rejects(payments.changeDate(pokiOnly, first.payment.id, { date: '2026-01-02', reason: 'x' }), /invoice\.manage/, 'a Poki manager does not move Bamboo Products\' payments');
  await assert.rejects(payments.changeDate(boss, '00000000-0000-0000-0000-000000000000', { date: '2026-01-02', reason: 'x' }), /not found/);
});
