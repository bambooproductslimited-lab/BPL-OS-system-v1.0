/*
 * Cancelling an invoice that is not needed any more, paid or not
 * (invoices.service.js voidInvoice): it stays on the list as voided and owes
 * nothing. What was paid on it is either refunded to the customer (a
 * negative payment, so collections net to nothing) or taken off as never
 * received (its payments and receipts go) — never money that came in
 * online. A shop order waiting on it is cancelled with it. Customers use the
 * ZIC prefix and are removed afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var invoices = require('../src/services/invoices.service');
var creditNotes = require('../src/services/creditNotes.service');

var admin, cust;

async function cleanup() {
  var inv = "(SELECT id FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'ZIC%'))";
  await pool.query("DELETE FROM shop_orders WHERE order_no LIKE 'ZIC%'");
  await pool.query('DELETE FROM invoice_online_payments WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM credit_notes WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM receipts WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM payments WHERE invoice_id IN ' + inv);
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN " + inv);
  await pool.query('DELETE FROM invoices WHERE id IN ' + inv);
  await pool.query("DELETE FROM customers WHERE name LIKE 'ZIC%'");
}

test.before(async function () {
  await cleanup();
  var u = (await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0];
  admin = await buildContext(u.id);
  cust = (await pool.query("INSERT INTO customers (name, email) VALUES ('ZIC Builders', 'zic@example.com') RETURNING id")).rows[0].id;
});
test.after(async function () { await cleanup(); await pool.end(); });

function invoiceOf(total) {
  return invoices.createManual(admin, { customerId: cust, items: [{ description: 'ZIC goods', qty: 1, unitPrice: total }] });
}
async function row(id) { return (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0]; }
async function moneyOn(id) {
  var p = (await pool.query("SELECT count(*)::int AS n, coalesce(sum(amount), 0)::float AS net, count(*) FILTER (WHERE source = 'refund')::int AS refunds FROM payments WHERE invoice_id = $1", [id])).rows[0];
  var r = (await pool.query('SELECT count(*)::int AS n FROM receipts WHERE invoice_id = $1', [id])).rows[0];
  return { payments: p.n, net: p.net, refunds: p.refunds, receipts: r.n };
}
async function lastAudit(id) {
  return (await pool.query("SELECT summary FROM audit_logs WHERE entity = 'invoice' AND entity_id = $1 AND action = 'invoice.void' ORDER BY at DESC LIMIT 1", [id])).rows[0].summary;
}

test('an unpaid invoice is cancelled as before, a reason optional', async function () {
  var inv = await invoiceOf(400);
  var out = await invoices.voidInvoice(admin, inv.id);
  assert.equal(out.status, 'void');
  await assert.rejects(invoices.voidInvoice(admin, inv.id, 'again'), /already been voided/);
});

test('a paid invoice needs a reason and a word on the money', async function () {
  var inv = await invoiceOf(1000);
  await invoices.recordPayment(admin, inv.id, { amount: 1000, method: 'cash' });
  await assert.rejects(invoices.voidInvoice(admin, inv.id, 'ZIC not needed'), /GHS 1000\.00 was paid on .* Say what happens to that money/);
  await assert.rejects(invoices.voidInvoice(admin, inv.id, '', { way: 'refund', method: 'cash' }), /Say why this paid invoice is cancelled/);
  await assert.rejects(invoices.voidInvoice(admin, inv.id, 'x', { way: 'keep' }), /What happens to the money/);
  await assert.rejects(invoices.voidInvoice(admin, inv.id, 'x', { way: 'refund', method: 'gold' }), /Refund method/);
  var noRights = Object.assign({}, admin, { can: function (p) { return p === 'invoice.read'; } });
  await assert.rejects(invoices.voidInvoice(noRights, inv.id, 'x', { way: 'refund', method: 'cash' }), /invoice\.manage/);
  assert.equal((await row(inv.id)).status, 'paid', 'nothing changed');
});

test('paid in full and refunded: voided, the money in and the money back both on record', async function () {
  var inv = await invoiceOf(1000);
  await invoices.recordPayment(admin, inv.id, { amount: 1000, method: 'bank_transfer', reference: 'ZIC-TRF-1' });
  var out = await invoices.voidInvoice(admin, inv.id, 'ZIC duplicate of another invoice', { way: 'refund', method: 'mobile_money', reference: 'ZIC-MOMO-9' });
  assert.equal(out.status, 'void');
  assert.equal(out.amountPaid, 0);
  var r = await row(inv.id);
  assert.equal(r.status, 'void');
  assert.equal(Number(r.amount_paid), 0);
  var m = await moneyOn(inv.id);
  assert.deepEqual(m, { payments: 2, net: 0, refunds: 1, receipts: 1 }, 'the payment and its receipt stay; a refund nets it off');
  var refund = (await pool.query("SELECT * FROM payments WHERE invoice_id = $1 AND source = 'refund'", [inv.id])).rows[0];
  assert.equal(Number(refund.amount), -1000);
  assert.equal(refund.method, 'mobile_money');
  assert.equal(refund.reference, 'ZIC-MOMO-9');
  assert.match(refund.notes, /cancelled: ZIC duplicate/);
  assert.match(await lastAudit(inv.id), /voided — GHS 1000\.00 refunded by mobile money — ZIC duplicate of another invoice\./);
  // Nothing more can be done on it.
  await assert.rejects(invoices.recordPayment(admin, inv.id, { amount: 10, method: 'cash' }), /voided/);
  await assert.rejects(creditNotes.create(admin, inv.id, { amount: 10, reason: 'x' }), /voided/);
});

test('part paid, the payment recorded by mistake: its payments and receipts are taken off', async function () {
  var inv = await invoiceOf(1000);
  await invoices.recordPayment(admin, inv.id, { amount: 200, method: 'cash' });
  await invoices.recordPayment(admin, inv.id, { amount: 100, method: 'cash' });
  assert.equal((await row(inv.id)).status, 'partially_paid');
  var out = await invoices.voidInvoice(admin, inv.id, 'ZIC entered for the wrong customer', { way: 'remove' });
  assert.equal(out.status, 'void');
  assert.deepEqual(await moneyOn(inv.id), { payments: 0, net: 0, refunds: 0, receipts: 0 });
  assert.equal(Number((await row(inv.id)).amount_paid), 0);
  assert.match(await lastAudit(inv.id), /2 payment\(s\) of GHS 300\.00 taken off \(never received\)/);
});

test('money that came in online, or a refund already made, cannot be called never received', async function () {
  var inv = await invoiceOf(500);
  var paid = await invoices.recordPayment(admin, inv.id, { amount: 500, method: 'card', reference: 'ZIC-PSK-1' });
  await pool.query("INSERT INTO invoice_online_payments (invoice_id, reference, amount, currency, status, payment_id) VALUES ($1, 'ZIC-PSK-1', 500, 'GHS', 'success', $2)", [inv.id, paid.payment.id]);
  await assert.rejects(invoices.voidInvoice(admin, inv.id, 'ZIC not needed', { way: 'remove' }), /came in online .* refund it instead/);
  assert.equal((await moneyOn(inv.id)).payments, 1, 'nothing taken off');
  var out = await invoices.voidInvoice(admin, inv.id, 'ZIC not needed', { way: 'refund', method: 'card' });
  assert.equal(out.status, 'void');
  assert.equal((await moneyOn(inv.id)).net, 0);

  // Paid 1000, then 200 credited and refunded: 800 is left to refund.
  var two = await invoiceOf(1000);
  await invoices.recordPayment(admin, two.id, { amount: 1000, method: 'cash' });
  await creditNotes.create(admin, two.id, { amount: 200, refundAmount: 200, refundMethod: 'cash', reason: 'ZIC one panel returned' });
  await assert.rejects(invoices.voidInvoice(admin, two.id, 'ZIC order called off', { way: 'remove' }), /refund was already recorded/);
  await invoices.voidInvoice(admin, two.id, 'ZIC order called off', { way: 'refund', method: 'cash' });
  var m = await moneyOn(two.id);
  assert.equal(m.net, 0, '1000 in, 200 and 800 back');
  assert.equal(m.refunds, 2);
  assert.match(await lastAudit(two.id), /GHS 800\.00 refunded by cash/);
});

test('a shop order being made from the invoice is cancelled with it; a finished one is left', async function () {
  var inv = await invoiceOf(750);
  await invoices.recordPayment(admin, inv.id, { amount: 750, method: 'mobile_money' });
  var making = (await pool.query("INSERT INTO shop_orders (order_no, customer_id, invoice_id, name, fulfilment, total, status) VALUES ('ZIC-SO-1', $1, $2, 'ZIC Buyer', 'pickup', 750, 'making') RETURNING id", [cust, inv.id])).rows[0];
  var inv2 = await invoiceOf(90);
  await invoices.recordPayment(admin, inv2.id, { amount: 90, method: 'cash' });
  var done = (await pool.query("INSERT INTO shop_orders (order_no, customer_id, invoice_id, name, fulfilment, total, status) VALUES ('ZIC-SO-2', $1, $2, 'ZIC Buyer', 'pickup', 90, 'done') RETURNING id", [cust, inv2.id])).rows[0];

  var out = await invoices.voidInvoice(admin, inv.id, 'ZIC customer changed their mind', { way: 'refund', method: 'mobile_money' });
  assert.deepEqual(out.shopOrdersCancelled, ['ZIC-SO-1']);
  var so = (await pool.query('SELECT status, steps FROM shop_orders WHERE id = $1', [making.id])).rows[0];
  assert.equal(so.status, 'cancelled');
  assert.ok(so.steps.cancelled);

  var out2 = await invoices.voidInvoice(admin, inv2.id, 'ZIC billed twice', { way: 'remove' });
  assert.deepEqual(out2.shopOrdersCancelled, []);
  assert.equal((await pool.query('SELECT status FROM shop_orders WHERE id = $1', [done.id])).rows[0].status, 'done');
});

test('the invoice says which payments came in online, so the screen offers only a refund for them', async function () {
  var inv = await invoiceOf(300);
  var p = await invoices.recordPayment(admin, inv.id, { amount: 300, method: 'card', reference: 'ZIC-PSK-2' });
  await pool.query("INSERT INTO invoice_online_payments (invoice_id, reference, amount, currency, status, payment_id) VALUES ($1, 'ZIC-PSK-2', 300, 'GHS', 'success', $2)", [inv.id, p.payment.id]);
  var listed = (await invoices.list(admin)).find(function (x) { return x.id === inv.id; });
  assert.deepEqual(listed.payments.map(function (x) { return x.online; }), [true]);
  var cash = await invoiceOf(50);
  await invoices.recordPayment(admin, cash.id, { amount: 50, method: 'cash' });
  assert.deepEqual((await invoices.list(admin)).find(function (x) { return x.id === cash.id; }).payments.map(function (x) { return x.online; }), [false]);
});
