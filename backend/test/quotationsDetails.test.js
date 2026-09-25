// Quotations: when each went out and was answered, contact details, the
// estimate it came from and the invoice made from it. Only a draft can be
// changed; an invoiced quotation's status is locked until that invoice is
// voided, after which the quotation can be invoiced again.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var estimates = require('../src/services/estimates.service');
var quotations = require('../src/services/quotations.service');
var invoices = require('../src/services/invoices.service');
var { buildContext } = require('../src/services/context.service');

var boss, cust;
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = await customers.create(boss, { name: 'Zqq Desk Makers', phone: '0240000501', email: 'zqq@example.com', category: 'active' });
});
test.after(async function () {
  await pool.query('DELETE FROM payments WHERE customer_id = $1', [cust.id]);
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = $1) OR document_id IN (SELECT id FROM quotations WHERE customer_id = $1) OR document_id IN (SELECT id FROM estimates WHERE customer_id = $1)", [cust.id]);
  await pool.query('DELETE FROM invoices WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM quotations WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM estimates WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust.id]);
  await pool.end();
});
function find(list, id) { return list.find(function (x) { return x.id === id; }); }

test('sent and answered dates, contact, estimate and invoice links', async function () {
  var es = await estimates.create(boss, { customerId: cust.id, items: [{ description: 'Zqq desk', qty: 3, unitPrice: 400 }] });
  var q = await estimates.convertToQuotation(boss, es.id);
  var row = find(await quotations.list(boss), q.id);
  assert.equal(row.sentAt, null);
  assert.equal(row.estimateNo, es.estimateNo);
  assert.equal(row.customerPhone, '0240000501');
  assert.ok(row.createdByName);
  assert.equal(row.invoice, null);

  await quotations.setStatus(boss, q.id, 'sent');
  row = find(await quotations.list(boss), q.id);
  assert.ok(row.sentAt);
  assert.equal(row.answeredAt, null);
  var firstSent = row.sentAt;
  await quotations.setStatus(boss, q.id, 'viewed');
  await quotations.setStatus(boss, q.id, 'accepted');
  row = find(await quotations.list(boss), q.id);
  assert.equal(String(row.sentAt), String(firstSent));
  assert.ok(row.answeredAt);

  var inv = await invoices.createFromQuotation(boss, q.id);
  row = find(await quotations.list(boss), q.id);
  assert.deepEqual(row.invoice, { id: inv.id, invoiceNo: inv.invoiceNo, status: 'unpaid', balanceDue: 1200 });
  await assert.rejects(quotations.setStatus(boss, q.id, 'rejected'), /stays accepted/);

  await invoices.voidInvoice(boss, inv.id, 'Zqq wrong address');
  row = find(await quotations.list(boss), q.id);
  assert.equal(row.invoice.status, 'void');
  var again = await invoices.createFromQuotation(boss, q.id);
  row = find(await quotations.list(boss), q.id);
  assert.equal(row.invoice.id, again.id);
});

test('only a draft quotation can be changed', async function () {
  var q = await quotations.create(boss, { customerId: cust.id, title: 'Zqq chairs', items: [{ description: 'Zqq chair', qty: 4, unitPrice: 100 }] });
  var up = await quotations.update(boss, q.id, { title: 'Zqq chairs, revised', items: [{ description: 'Zqq chair', qty: 6, unitPrice: 90 }] });
  assert.equal(up.title, 'Zqq chairs, revised');
  assert.equal(up.grandTotal, 540);
  assert.equal(up.items.length, 1);
  await quotations.setStatus(boss, q.id, 'sent');
  await assert.rejects(quotations.update(boss, q.id, { items: [{ description: 'Zqq chair', qty: 1, unitPrice: 1 }] }), /Only a draft/);
  var back = await quotations.setStatus(boss, q.id, 'draft');
  assert.equal(back.sentAt, null);
});
