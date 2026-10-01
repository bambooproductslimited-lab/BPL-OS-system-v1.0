/*
 * An invoice's balance and status follow its money (migration 0119's
 * trigger), and credit notes take part of an invoice back and refund what
 * the customer then overpaid (creditNotes.service.js). Customers use the
 * ZCN prefix and are removed afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var invoices = require('../src/services/invoices.service');
var creditNotes = require('../src/services/creditNotes.service');

var admin, cust;

async function cleanup() {
  var inv = "(SELECT id FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'ZCN%'))";
  await pool.query('DELETE FROM credit_notes WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM receipts WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM payments WHERE invoice_id IN ' + inv);
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN " + inv);
  await pool.query('DELETE FROM invoices WHERE id IN ' + inv);
  await pool.query("DELETE FROM customers WHERE name LIKE 'ZCN%'");
}

test.before(async function () {
  await cleanup();
  var u = (await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0];
  admin = await buildContext(u.id);
  cust = (await pool.query("INSERT INTO customers (name, email) VALUES ('ZCN Builders', 'zcn@example.com') RETURNING id")).rows[0].id;
});
test.after(async function () { await cleanup(); await pool.end(); });

function invoiceOf(total) {
  return invoices.createManual(admin, { customerId: cust, items: [{ description: 'ZCN goods', qty: 1, unitPrice: total }] });
}
async function row(id) { return (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0]; }

test('an invoice that owes nothing is paid, and the balance always matches the money', async function () {
  var zero = (await pool.query(
    "INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date) " +
    "VALUES ('ZCN-0', $1, 0, 0, 0, 0, 0, 0, 'unpaid', CURRENT_DATE - 30, CURRENT_DATE - 30) RETURNING *", [cust])).rows[0];
  assert.equal(zero.status, 'paid', 'GHS 0.00 is not owed');
  assert.ok(zero.paid_at);

  var odd = (await pool.query(
    "INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date) " +
    "VALUES ('ZCN-1', $1, 100, 0, 0, 100, 0, 0, 'unpaid', CURRENT_DATE, CURRENT_DATE) RETURNING *", [cust])).rows[0];
  assert.equal(Number(odd.balance_due), 100, 'unpaid with nothing paid owes its total');

  var voided = (await pool.query("UPDATE invoices SET status = 'void' WHERE id = $1 RETURNING *", [odd.id])).rows[0];
  assert.equal(voided.status, 'void', 'void stays void');
});

test('a credit note reduces what is owed; there is nothing to refund on an unpaid invoice', async function () {
  var inv = await invoiceOf(1000);
  var r = await creditNotes.create(admin, inv.id, { amount: 300, reason: 'ZCN two panels returned' });
  assert.match(r.creditNote.creditNo, /^CN-\d{4}-\d{4}$/);
  assert.equal(r.invoice.balanceDue, 700);
  assert.equal(r.invoice.status, 'unpaid');
  assert.equal(r.invoice.grandTotal, 1000, 'the original total stays');
  assert.equal(r.invoice.creditTotal, 300);

  await assert.rejects(creditNotes.create(admin, inv.id, { amount: 701, reason: 'x' }), /more than is left on the invoice to credit \(GHS 700\.00\)/);
  await assert.rejects(creditNotes.create(admin, inv.id, { refundAmount: 10, reason: 'x' }), /nothing to refund/);
  await assert.rejects(creditNotes.create(admin, inv.id, { amount: 0, reason: 'x' }), /how much to credit/);
  await assert.rejects(creditNotes.create(admin, inv.id, { amount: 10 }), /Reason/);
  var noRights = Object.assign({}, admin, { can: function (p) { return p === 'invoice.read'; } });
  await assert.rejects(creditNotes.create(noRights, inv.id, { amount: 10, reason: 'x' }), /invoice\.manage/);
  assert.equal((await creditNotes.list(noRights, inv.id)).length, 1);

  // A payment after the credit: its receipt shows the balance net of it.
  var paid = await invoices.recordPayment(admin, inv.id, { amount: 200, method: 'cash' });
  assert.equal(paid.receipt.balanceAfter, 500);
  assert.equal(paid.invoice.balanceDue, 500);
});

test('crediting a paid invoice and refunding the overpayment', async function () {
  var inv = await invoiceOf(1000);
  await invoices.recordPayment(admin, inv.id, { amount: 1000, method: 'bank_transfer' });

  await assert.rejects(creditNotes.create(admin, inv.id, { amount: 400, refundAmount: 401, refundMethod: 'cash', reason: 'x' }), /refund at most GHS 400\.00/);
  var r = await creditNotes.create(admin, inv.id, { amount: 400, refundAmount: 300, refundMethod: 'mobile_money', refundReference: 'ZCN-MOMO-9', reason: 'ZCN price agreed down' });
  assert.equal(r.overpaidLeft, 100, 'GHS 100 still with us, as credit for them');
  assert.equal(r.invoice.amountPaid, 700);
  assert.equal(r.invoice.balanceDue, 0);
  assert.equal(r.invoice.status, 'paid');
  assert.equal(r.creditNote.refundAmount, 300);
  assert.equal(r.creditNote.refundMethod, 'mobile_money');

  var pays = (await pool.query("SELECT amount, source FROM payments WHERE invoice_id = $1 ORDER BY amount", [inv.id])).rows;
  assert.deepEqual(pays.map(function (p) { return [Number(p.amount), p.source]; }), [[-300, 'refund'], [1000, 'manual']]);

  // The rest of the overpayment can be refunded later — with no new credit.
  var later = await creditNotes.create(admin, inv.id, { refundAmount: 100, refundMethod: 'cash', reason: 'ZCN rest refunded' });
  assert.equal(later.overpaidLeft, 0);
  assert.equal(later.invoice.amountPaid, 600);
  assert.equal(later.creditNotes.length, 2);

  // The invoice as the screens get it: credit and the refund line.
  var full = (await invoices.list(admin)).find(function (i) { return i.id === inv.id; });
  assert.equal(full.creditTotal, 400);
  assert.equal(full.payments.filter(function (p) { return p.refund; }).length, 2);
});

test('part-paid: the credit clears what is owed first, only the excess is refundable', async function () {
  var inv = await invoiceOf(1000);
  await invoices.recordPayment(admin, inv.id, { amount: 600, method: 'cash' });
  await assert.rejects(creditNotes.create(admin, inv.id, { amount: 300, refundAmount: 1, refundMethod: 'cash', reason: 'x' }), /nothing to refund/);
  var r = await creditNotes.create(admin, inv.id, { amount: 500, refundAmount: 100, refundMethod: 'cash', reason: 'ZCN half returned' });
  assert.equal(r.invoice.amountPaid, 500);
  assert.equal(r.invoice.status, 'paid');
  assert.equal((await row(inv.id)).balance_due, '0.00');
});
