// Invoices: part-paid invoices past their due date count as overdue (with
// how many days), the list carries contact details, the quotation it came
// from and when the client was last reminded; a voided invoice can't be
// changed or voided twice.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var quotations = require('../src/services/quotations.service');
var invoices = require('../src/services/invoices.service');
var { buildContext } = require('../src/services/context.service');

var boss, cust;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = await customers.create(boss, { name: 'Zqi Lamp Works', phone: '0240000601', email: 'zqi@example.com', category: 'active' });
});
test.after(async function () {
  await pool.query('DELETE FROM payment_reminders WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM payments WHERE customer_id = $1', [cust.id]);
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = $1) OR document_id IN (SELECT id FROM quotations WHERE customer_id = $1)", [cust.id]);
  await pool.query('DELETE FROM invoices WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM quotations WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust.id]);
  await pool.end();
});
function find(list, id) { return list.find(function (x) { return x.id === id; }); }

test('part-paid and past due is overdue; list carries contact, quotation and reminders', async function () {
  var q = await quotations.create(boss, { customerId: cust.id, items: [{ description: 'Zqi lamp', qty: 10, unitPrice: 50 }] });
  await quotations.setStatus(boss, q.id, 'accepted');
  var inv = await invoices.createFromQuotation(boss, q.id);
  await pool.query('UPDATE invoices SET issued_at = $1, due_date = $2 WHERE id = $3', [day(-30), day(-12), inv.id]);
  await invoices.recordPayment(boss, inv.id, { amount: 100, method: 'cash', date: day(-3) });
  await pool.query("INSERT INTO payment_reminders (invoice_id, customer_id, phone, message, sent_at) VALUES ($1, $2, '0240000601', 'Zqi reminder', now() - interval '2 days'), ($1, $2, '0240000601', 'Zqi reminder', now() - interval '1 day')", [inv.id, cust.id]);

  var row = find(await invoices.list(boss), inv.id);
  assert.equal(row.status, 'partially_paid');
  assert.equal(row.overdue, true);
  assert.equal(row.daysOverdue, 12);
  assert.equal(row.quoteNo, q.quoteNo);
  assert.equal(row.customerPhone, '0240000601');
  assert.equal(row.reminders, 2);
  assert.ok(row.lastRemindedAt);

  var fresh = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqi shade', qty: 1, unitPrice: 80 }], dueDate: day(5) });
  row = find(await invoices.list(boss), fresh.id);
  assert.equal(row.overdue, false);
  assert.equal(row.daysOverdue, 0);
  assert.equal(row.reminders, 0);
});

test('a voided invoice is not changed or voided again', async function () {
  var inv = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqi base', qty: 2, unitPrice: 30 }] });
  await invoices.voidInvoice(boss, inv.id);
  await assert.rejects(invoices.voidInvoice(boss, inv.id), /already been voided/);
  await assert.rejects(invoices.update(boss, inv.id, { dueDate: day(30) }), /voided/);
  var row = find(await invoices.list(boss), inv.id);
  assert.equal(row.overdue, false);
});
