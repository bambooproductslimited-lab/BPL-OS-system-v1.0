// Sales orders: made from an accepted quotation (one live order per
// quotation), numbered SO-<year>-NNNN, with a promised date and notes that
// can change until delivery. Status moves follow a fixed path; an order with
// an invoice (not voided) can't be cancelled, and a cancelled one can't be
// invoiced.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var quotations = require('../src/services/quotations.service');
var salesOrders = require('../src/services/salesOrders.service');
var invoices = require('../src/services/invoices.service');
var { buildContext } = require('../src/services/context.service');

var boss, cust;
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = await customers.create(boss, { name: 'Zqs Shelf Traders', phone: '0240000611', email: 'zqs@example.com', category: 'active' });
});
test.after(async function () {
  var docs = "SELECT id FROM invoices WHERE customer_id = $1 UNION SELECT id FROM quotations WHERE customer_id = $1 UNION SELECT id FROM sales_orders WHERE customer_id = $1";
  await pool.query('DELETE FROM document_line_items WHERE document_id IN (' + docs + ')', [cust.id]);
  await pool.query('DELETE FROM invoices WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM sales_orders WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM quotations WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust.id]);
  await pool.end();
});
function find(list, id) { return list.find(function (x) { return x.id === id; }); }
async function acceptedQuote() {
  var q = await quotations.create(boss, { customerId: cust.id, items: [{ description: 'Zqs shelf', qty: 2, unitPrice: 250 }] });
  await quotations.setStatus(boss, q.id, 'sent');
  await quotations.setStatus(boss, q.id, 'accepted');
  return q;
}

test('order from a quotation: number, dates, notes and one live order per quote', async function () {
  var draft = await quotations.create(boss, { customerId: cust.id, items: [{ description: 'Zqs stool', qty: 1, unitPrice: 90 }] });
  await assert.rejects(salesOrders.createFromQuotation(boss, draft.id, {}), /Only an accepted quotation/);

  var q = await acceptedQuote();
  var o = await salesOrders.createFromQuotation(boss, q.id, { promisedDate: '2031-05-04', notes: '  Deliver to the Zqs back gate  ' });
  assert.match(o.orderNo, new RegExp('^SO-' + new Date().getFullYear() + '-\\d{4}$'));
  assert.equal(o.status, 'pending');
  assert.equal(o.total, 500);
  assert.equal(o.promisedDate, '2031-05-04');
  assert.equal(o.notes, 'Deliver to the Zqs back gate');
  assert.equal(o.quoteNo, q.quoteNo);
  assert.equal(o.customerPhone, '0240000611');
  assert.ok(o.createdByName);
  assert.equal(o.items.length, 1);
  assert.equal(o.invoice, null);
  await assert.rejects(salesOrders.createFromQuotation(boss, q.id, {}), /already exists/);

  var o2 = await salesOrders.createFromQuotation(boss, (await acceptedQuote()).id, {});
  assert.notEqual(o2.orderNo, o.orderNo);
  assert.equal(o2.promisedDate, null);

  // A cancelled order frees the quotation for a new one.
  await salesOrders.setStatus(boss, o2.id, 'cancelled');
  var again = await salesOrders.createFromQuotation(boss, o2.quotationId, {});
  assert.equal(again.status, 'pending');
});

test('status path, delivery date, edits and invoicing rules', async function () {
  var o = await salesOrders.createFromQuotation(boss, (await acceptedQuote()).id, {});
  await assert.rejects(salesOrders.setStatus(boss, o.id, 'delivered'), /pending order can't be marked delivered/);
  await salesOrders.setStatus(boss, o.id, 'processing');
  var d = await salesOrders.setStatus(boss, o.id, 'delivered');
  assert.ok(d.deliveredAt);
  await assert.rejects(salesOrders.update(boss, o.id, { notes: 'late' }), /delivered order can't be changed/);
  var back = await salesOrders.setStatus(boss, o.id, 'processing');
  assert.equal(back.deliveredAt, null);
  var ed = await salesOrders.update(boss, o.id, { promisedDate: '2031-06-01' });
  assert.equal(ed.promisedDate, '2031-06-01');
  ed = await salesOrders.update(boss, o.id, { notes: 'Zqs call first' });
  assert.equal(ed.promisedDate, '2031-06-01');
  assert.equal(ed.notes, 'Zqs call first');
  ed = await salesOrders.update(boss, o.id, { promisedDate: '' });
  assert.equal(ed.promisedDate, null);
  await salesOrders.setStatus(boss, o.id, 'delivered');

  var inv = await invoices.createFromOrder(boss, o.id);
  var row = find(await salesOrders.list(boss), o.id);
  assert.deepEqual(row.invoice, { id: inv.id, invoiceNo: inv.invoiceNo, status: 'unpaid', balanceDue: 500 });
  await assert.rejects(invoices.createFromOrder(boss, o.id), /already exists/);
  await salesOrders.setStatus(boss, o.id, 'processing');
  await assert.rejects(salesOrders.setStatus(boss, o.id, 'cancelled'), /Void it before cancelling/);

  // Voiding the invoice lets the order be cancelled, and a cancelled order can't be invoiced.
  await invoices.voidInvoice(boss, inv.id, 'Zqs wrong price');
  await salesOrders.setStatus(boss, o.id, 'cancelled');
  await assert.rejects(invoices.createFromOrder(boss, o.id), /cancelled order cannot be invoiced/);
  await assert.rejects(salesOrders.setStatus(boss, o.id, 'delivered'), /cancelled order can't be marked delivered/);
  await salesOrders.setStatus(boss, o.id, 'pending');
  await salesOrders.setStatus(boss, o.id, 'processing');
  await salesOrders.setStatus(boss, o.id, 'delivered');
  var inv2 = await invoices.createFromOrder(boss, o.id);
  assert.equal(find(await salesOrders.list(boss), o.id).invoice.id, inv2.id);
});
