var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// kernel.js: handlers['payments.list']
async function list(ctx) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  var res = await pool.query(
    'SELECT pm.*, i.invoice_no, c.name AS customer_name, e.first_name, e.last_name FROM payments pm ' +
    'JOIN invoices i ON i.id = pm.invoice_id JOIN customers c ON c.id = pm.customer_id JOIN employees e ON e.id = pm.received_by ' +
    'ORDER BY pm.date DESC'
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, invoiceId: r.invoice_id, customerId: r.customer_id, date: r.date, amount: Number(r.amount), currency: r.currency,
      method: r.method, reference: r.reference, receivedBy: r.received_by, notes: r.notes,
      invoiceNo: r.invoice_no, customerName: r.customer_name, receivedByName: r.first_name + ' ' + r.last_name
    };
  });
}

// kernel.js: handlers['payments.delete']
async function remove(ctx, id) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var payRes = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
  var pay = payRes.rows[0];
  if (!pay) fail('notfound', 'Payment not found.');
  var invRes = await pool.query('SELECT * FROM invoices WHERE id = $1', [pay.invoice_id]);
  var i = invRes.rows[0];
  if (!i) fail('notfound', 'Related invoice not found.');

  await pool.query('DELETE FROM payments WHERE id = $1', [id]);
  await pool.query('DELETE FROM receipts WHERE payment_id = $1', [id]);

  var amountPaid = Math.round((Number(i.amount_paid) - Number(pay.amount)) * 100) / 100;
  var balanceDue = Math.round((Number(i.grand_total) - amountPaid) * 100) / 100;
  var status = balanceDue <= 0.01 ? 'paid' : (amountPaid > 0 ? 'partially_paid' : 'unpaid');
  var paidAt = status === 'paid' ? i.paid_at : null;
  await pool.query('UPDATE invoices SET amount_paid = $1, balance_due = $2, status = $3, paid_at = $4 WHERE id = $5', [amountPaid, balanceDue, status, paidAt, i.id]);

  await audit(pool, ctx, 'payment.delete', 'invoice', i.id, 'Removed GHS ' + Number(pay.amount).toLocaleString() + ' payment from ' + i.invoice_no + '.');
  return true;
}

module.exports = { list: list, remove: remove };
