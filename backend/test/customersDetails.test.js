// Clients: what each owes and how overdue, open and won quotations, what
// they paid in the last twelve months, when they were last active, and one
// timeline of everything done with them. Voided invoices don't count.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var quotations = require('../src/services/quotations.service');
var invoices = require('../src/services/invoices.service');
var { buildContext } = require('../src/services/context.service');

var boss, viewer, cust;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  viewer = limited(boss, ['customer.manage', 'invoice.manage', 'quotation.manage']);
  cust = await customers.create(boss, { name: 'Zqc Furniture Hub', phone: '0240000301', category: 'active' });
});
test.after(async function () {
  await pool.query('DELETE FROM payments WHERE customer_id = $1', [cust.id]);
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = $1) OR document_id IN (SELECT id FROM quotations WHERE customer_id = $1)", [cust.id]).catch(function () {});
  await pool.query('DELETE FROM invoices WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM quotations WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust.id]);
  await pool.end();
});

test('a client carries what they owe, how late, quotations open and won, what they paid, and a timeline', async function () {
  var q1 = await quotations.create(boss, { customerId: cust.id, items: [{ description: 'Zqc chairs', qty: 10, unitPrice: 100 }] });
  await quotations.setStatus(boss, q1.id, 'sent');
  var q2 = await quotations.create(boss, { customerId: cust.id, items: [{ description: 'Zqc tables', qty: 2, unitPrice: 500 }] });
  await quotations.setStatus(boss, q2.id, 'accepted');

  var late = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqc stools', qty: 5, unitPrice: 200 }], dueDate: day(10) });
  await pool.query('UPDATE invoices SET issued_at = $1, due_date = $2 WHERE id = $3', [day(-40), day(-20), late.id]);
  await invoices.recordPayment(boss, late.id, { amount: 300, method: 'mobile_money', date: day(-5) });
  var voided = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqc mistake', qty: 1, unitPrice: 9999 }] });
  await invoices.voidInvoice(boss, voided.id);

  var c = (await customers.list(viewer)).find(function (x) { return x.id === cust.id; });
  assert.deepEqual(c.outstanding, [{ currency: 'GHS', amount: 700 }]);
  assert.deepEqual(c.overdue, [{ currency: 'GHS', amount: 700 }]);
  assert.deepEqual(c.invoicedTotals.map(function (x) { return [x.invoiced, x.paid]; }), [[1000, 300]]); // the void one isn't business done
  assert.deepEqual([c.daysOverdue, c.openQuotes, c.quotesWon, c.quotesLost, c.invoiceCount, c.lastPaidOn], [20, 1, 1, 0, 1, day(-5)]);
  assert.deepEqual(c.paid12, [{ currency: 'GHS', amount: 300 }]);
  assert.equal(c.lastActivity, day(0));

  var a = await customers.activity(viewer, cust.id);
  var kinds = a.map(function (x) { return x.kind; });
  assert.equal(kinds.filter(function (k) { return k === 'quotation'; }).length, 2);
  assert.equal(kinds.filter(function (k) { return k === 'invoice'; }).length, 2);
  var pay = a.find(function (x) { return x.kind === 'payment'; });
  assert.deepEqual([pay.amount, pay.day, pay.status], [300, day(-5), 'mobile_money']);

  var u = await customers.update(boss, cust.id, { name: cust.name, taxId: 'C0012345', paymentTerms: 'Net 14' });
  assert.deepEqual([u.taxId, u.paymentTerms], ['C0012345', 'Net 14']);
  await assert.rejects(function () { return customers.activity(viewer, '00000000-0000-0000-0000-000000000000'); }, /not found/);
});
