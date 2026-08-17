/*
 * Integration test for the Commercial modules (customers, catalog,
 * quotations, estimates, sales orders, invoices, payments, receipts,
 * expenses, commercial settings, reports). Requires `npm run migrate &&
 * npm run seed` first.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');

var server;
var base;

test.before(function (t, done) {
  server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); });
});
test.after(function () { server.close(); });

async function login(email) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: 'bamboo123' })
  });
  return (await res.json()).token;
}
function authed(token) { return { Authorization: 'Bearer ' + token }; }
function jsonAuthed(token) { return Object.assign({ 'Content-Type': 'application/json' }, authed(token)); }

async function createCustomer(marketingToken, name) {
  var res = await fetch(base + '/api/customers', {
    method: 'POST', headers: jsonAuthed(marketingToken),
    body: JSON.stringify({ name: name, contactPerson: 'Test Contact', email: 'contact@example.com', category: 'prospect' })
  });
  return res.json();
}

test('quote-to-cash: quotation -> accept -> sales order -> invoice -> partial + full payment -> receipts', async function () {
  var daniel = await login('daniel.omondi@bplghana.com'); // marketing_manager
  var peter = await login('peter.njoroge@bplghana.com'); // finance_manager

  var customer = await createCustomer(daniel, 'Quote-to-Cash Test Ltd');

  var quoteRes = await fetch(base + '/api/quotations', {
    method: 'POST', headers: jsonAuthed(daniel),
    body: JSON.stringify({ customerId: customer.id, items: [{ description: 'Bamboo Chair', qty: 10, unitPrice: 3500, taxRate: 15 }] })
  });
  assert.equal(quoteRes.status, 201);
  var quote = await quoteRes.json();
  assert.equal(quote.subtotal, 35000);
  assert.equal(quote.taxTotal, 5250);
  assert.equal(quote.grandTotal, 40250);

  await fetch(base + '/api/quotations/' + quote.id + '/status', { method: 'POST', headers: jsonAuthed(daniel), body: JSON.stringify({ status: 'sent' }) });
  var acceptRes = await fetch(base + '/api/quotations/' + quote.id + '/status', { method: 'POST', headers: jsonAuthed(daniel), body: JSON.stringify({ status: 'accepted' }) });
  assert.equal((await acceptRes.json()).status, 'accepted');

  var soRes = await fetch(base + '/api/sales-orders', { method: 'POST', headers: jsonAuthed(daniel), body: JSON.stringify({ quotationId: quote.id }) });
  assert.equal(soRes.status, 201);
  var order = await soRes.json();
  assert.equal(order.total, 40250);

  var dupeSoRes = await fetch(base + '/api/sales-orders', { method: 'POST', headers: jsonAuthed(daniel), body: JSON.stringify({ quotationId: quote.id }) });
  assert.equal(dupeSoRes.status, 409);

  var invRes = await fetch(base + '/api/invoices/from-order', { method: 'POST', headers: jsonAuthed(peter), body: JSON.stringify({ salesOrderId: order.id }) });
  assert.equal(invRes.status, 201);
  var invoice = await invRes.json();
  assert.equal(invoice.balanceDue, 40250);
  assert.equal(invoice.status, 'unpaid');

  var pay1 = await fetch(base + '/api/invoices/' + invoice.id + '/payments', {
    method: 'POST', headers: jsonAuthed(peter), body: JSON.stringify({ amount: 10000, method: 'bank_transfer', reference: 'TRX-1' })
  });
  assert.equal(pay1.status, 201);
  var pay1Body = await pay1.json();
  assert.equal(pay1Body.invoice.status, 'partially_paid');
  assert.equal(pay1Body.invoice.balanceDue, 30250);
  assert.ok(pay1Body.receipt.receiptNo);

  var overpay = await fetch(base + '/api/invoices/' + invoice.id + '/payments', {
    method: 'POST', headers: jsonAuthed(peter), body: JSON.stringify({ amount: 999999 })
  });
  assert.equal(overpay.status, 400);

  var markPaidRes = await fetch(base + '/api/invoices/' + invoice.id + '/mark-paid', { method: 'POST', headers: authed(peter) });
  assert.equal(markPaidRes.status, 200);
  var paidInvoice = await markPaidRes.json();
  assert.equal(paidInvoice.status, 'paid');
  assert.equal(paidInvoice.balanceDue, 0);

  var deleteRes = await fetch(base + '/api/invoices/' + invoice.id, { method: 'DELETE', headers: authed(peter) });
  assert.equal(deleteRes.status, 409); // has payments recorded
});

test('expense claim lifecycle appears in the shared approvals queue with the right detail string', async function () {
  var alice = await login('alice.kamau@bplghana.com');
  var isreal = await login('isreal.omozuafo@bplghana.com'); // alice's manager

  var createRes = await fetch(base + '/api/expenses', {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ category: 'Travel', amount: 250, description: 'Client visit fuel' })
  });
  assert.equal(createRes.status, 201);
  var expense = await createRes.json();

  var queue = await (await fetch(base + '/api/approvals/queue', { headers: authed(isreal) })).json();
  var entry = queue.find(function (q) { return q.subjectId === expense.id; });
  assert.ok(entry);
  assert.equal(entry.subjectType, 'expense');
  assert.equal(entry.detail, 'Travel · GHS 250 · ' + expense.date);

  var decideRes = await fetch(base + '/api/expenses/' + expense.id + '/decision', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal((await decideRes.json()).status, 'approved');

  var markPaidRes = await fetch(base + '/api/expenses/' + expense.id + '/mark-paid', { method: 'POST', headers: authed(isreal) });
  assert.equal((await markPaidRes.json()).status, 'paid');
});

test('estimates.convertToQuotation carries totals and items across, marks estimate converted', async function () {
  var daniel = await login('daniel.omondi@bplghana.com');
  var customer = await createCustomer(daniel, 'Estimate Conversion Test Ltd');

  var estRes = await fetch(base + '/api/estimates', {
    method: 'POST', headers: jsonAuthed(daniel),
    body: JSON.stringify({ customerId: customer.id, items: [{ description: 'Pilot units', qty: 5, unitPrice: 2200 }] })
  });
  var estimate = await estRes.json();
  assert.equal(estimate.grandTotal, 11000);

  var convertRes = await fetch(base + '/api/estimates/' + estimate.id + '/convert', { method: 'POST', headers: authed(daniel) });
  assert.equal(convertRes.status, 201);
  var quote = await convertRes.json();
  assert.equal(quote.grandTotal, 11000);
  assert.equal(quote.fromEstimateId, estimate.id);

  var deleteConverted = await fetch(base + '/api/estimates/' + estimate.id, { method: 'DELETE', headers: authed(daniel) });
  assert.equal(deleteConverted.status, 409);
});

test('reports are permission-gated behind report.read / customer.read', async function () {
  var peter = await login('peter.njoroge@bplghana.com'); // finance_manager: report.read
  var alice = await login('alice.kamau@bplghana.com'); // employee: neither

  var summaryRes = await fetch(base + '/api/reports/summary', { headers: authed(peter) });
  assert.equal(summaryRes.status, 200);
  var deniedRes = await fetch(base + '/api/reports/summary', { headers: authed(alice) });
  assert.equal(deniedRes.status, 403);

  var commercialRes = await fetch(base + '/api/reports/commercial', { headers: authed(peter) });
  assert.equal(commercialRes.status, 200);
  var body = await commercialRes.json();
  assert.ok(typeof body.totalQuotations === 'number');
});

test('commercialSettings: get/save permission-gated, addTaxRate persists', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var deniedRes = await fetch(base + '/api/commercial-settings', { headers: authed(alice) });
  assert.equal(deniedRes.status, 403);

  var addRes = await fetch(base + '/api/commercial-settings/tax-rates', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ name: 'Test Levy', rate: 3 })
  });
  assert.equal(addRes.status, 201);

  var settings = await (await fetch(base + '/api/commercial-settings', { headers: authed(admin) })).json();
  assert.ok(settings.taxRates.some(function (t) { return t.name === 'Test Levy'; }));
});
