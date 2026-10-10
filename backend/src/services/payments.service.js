var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { bplScopeClause, todayISO } = require('../utils/documents');
var { V } = require('../utils/validate');

// kernel.js: handlers['payments.list']
// Bamboo Products' payments only, the same invoices the Invoices page
// lists; alongside each, how to reach the client, where its invoice now
// stands and the receipt it produced.
async function list(ctx) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  var res = await pool.query(
    'SELECT pm.*, i.invoice_no, i.status AS invoice_status, i.balance_due, i.grand_total, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, ' +
    '  e.first_name, e.last_name, r.id AS receipt_id, r.receipt_no, r.balance_after FROM payments pm ' +
    'JOIN invoices i ON i.id = pm.invoice_id JOIN customers c ON c.id = pm.customer_id JOIN employees e ON e.id = pm.received_by ' +
    'LEFT JOIN receipts r ON r.payment_id = pm.id ' +
    'WHERE ' + bplScopeClause('i') + ' ORDER BY pm.date DESC, r.receipt_no DESC NULLS LAST'
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, invoiceId: r.invoice_id, customerId: r.customer_id, date: r.date, amount: Number(r.amount), currency: r.currency,
      method: r.method, reference: r.reference, receivedBy: r.received_by, notes: r.notes, source: r.source,
      invoiceNo: r.invoice_no, customerName: r.customer_name, receivedByName: r.first_name + ' ' + r.last_name,
      customerPhone: r.customer_phone || '', customerEmail: r.customer_email || '',
      invoiceStatus: r.invoice_status, invoiceBalance: Number(r.balance_due), invoiceTotal: Number(r.grand_total),
      receiptId: r.receipt_id || null, receiptNo: r.receipt_no || null, balanceAfter: r.balance_after == null ? null : Number(r.balance_after)
    };
  });
}

// kernel.js: handlers['payments.delete']
// Taking a payment off puts its amount back on the invoice and removes its
// receipt, all at once, with the invoice locked so a payment recorded at
// the same moment can't be lost.
async function remove(ctx, id) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  return withTransaction(async function (client) {
    var pay = (await client.query('SELECT * FROM payments WHERE id = $1', [id])).rows[0];
    if (!pay) fail('notfound', 'Payment not found.');
    var i = (await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [pay.invoice_id])).rows[0];
    if (!i) fail('notfound', 'Related invoice not found.');

    await client.query('DELETE FROM receipts WHERE payment_id = $1', [id]);
    await client.query('DELETE FROM payments WHERE id = $1', [id]);

    var amountPaid = Math.max(0, Math.round((Number(i.amount_paid) - Number(pay.amount)) * 100) / 100);
    var balanceDue = Math.round((Number(i.grand_total) - amountPaid) * 100) / 100;
    var status = balanceDue <= 0.01 ? 'paid' : (amountPaid > 0 ? 'partially_paid' : 'unpaid');
    var paidAt = status === 'paid' ? i.paid_at : null;
    await client.query('UPDATE invoices SET amount_paid = $1, balance_due = $2, status = $3, paid_at = $4 WHERE id = $5', [amountPaid, balanceDue, status, paidAt, i.id]);

    await audit(client, ctx, 'payment.delete', 'invoice', i.id, 'Removed ' + pay.currency + ' ' + Number(pay.amount).toLocaleString() + ' payment from ' + i.invoice_no + '.');
    return true;
  });
}

function dateOnly(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }

// A payment put on the wrong day — recorded late with today's date, or
// settled in a clean-up — moves to the day the money actually came in.
// Its receipt moves with it, a fully paid invoice's paid date follows, and
// the audit log keeps the old date, the new one and why. Square's payments
// keep Square's date (the next import would put it back), and a refund
// keeps its credit note's.
async function changeDate(ctx, id, p) {
  p = p || {};
  var date = V.date(p.date, 'Payment date');
  if (date > todayISO()) fail('invalid', 'The payment date cannot be in the future.');
  var reason = V.text(p.reason, 'Reason', 300);
  return withTransaction(async function (client) {
    var pay = (await client.query(
      'SELECT pm.*, i.invoice_no, i.company_id, i.status AS invoice_status, c.name AS customer_name FROM payments pm ' +
      'JOIN invoices i ON i.id = pm.invoice_id JOIN customers c ON c.id = pm.customer_id WHERE pm.id = $1 FOR UPDATE OF pm', [id])).rows[0];
    if (!pay) fail('notfound', 'Payment not found.');
    if (!ctx.can('invoice.manage')) {
      // Poki's rent side: whoever manages Poki moves Poki's payments.
      var pokiId = ctx.can('poki.manage') ? await require('./poki.service').pokiCompanyId() : null;
      if (!pokiId || pay.company_id !== pokiId) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
    }
    if (pay.source === 'square') fail('conflict', 'This payment came from Square, and the next Square import would put its date back. Change it in Square.');
    if (pay.source === 'refund') fail('conflict', 'This is a refund; its date is its credit note\'s.');
    var was = dateOnly(pay.date);
    if (was === date) fail('invalid', 'The payment is already on that date.');

    await client.query('UPDATE payments SET date = $2 WHERE id = $1', [id, date]);
    await client.query('UPDATE receipts SET date = $2 WHERE payment_id = $1', [id, date]);
    if (pay.invoice_status === 'paid') {
      await client.query('UPDATE invoices SET paid_at = (SELECT max(date) FROM payments WHERE invoice_id = $1 AND amount > 0) WHERE id = $1', [pay.invoice_id]);
    }
    await audit(client, ctx, 'payment.redate', 'invoice', pay.invoice_id,
      'Moved the ' + pay.currency + ' ' + Number(pay.amount).toLocaleString() + ' payment on ' + pay.invoice_no + ' (' + pay.customer_name + ') from ' + was + ' to ' + date + ': ' + reason);
    return { id: id, invoiceId: pay.invoice_id, date: date, was: was };
  });
}

module.exports = { list: list, remove: remove, changeDate: changeDate };
