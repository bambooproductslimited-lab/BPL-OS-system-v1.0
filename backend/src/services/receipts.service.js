var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');

// kernel.js: handlers['receipts.list']
async function list(ctx) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  var res = await pool.query(
    'SELECT r.*, i.invoice_no, c.name AS customer_name, c.billing_address, c.address, e.first_name, e.last_name FROM receipts r ' +
    'JOIN invoices i ON i.id = r.invoice_id JOIN customers c ON c.id = r.customer_id JOIN employees e ON e.id = r.received_by ' +
    'ORDER BY r.date DESC'
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, receiptNo: r.receipt_no, paymentId: r.payment_id, invoiceId: r.invoice_id, customerId: r.customer_id,
      date: r.date, amount: Number(r.amount), method: r.method, reference: r.reference, balanceAfter: Number(r.balance_after), receivedBy: r.received_by,
      invoiceNo: r.invoice_no, customerName: r.customer_name, customerAddress: r.billing_address || r.address || '',
      receivedByName: r.first_name + ' ' + r.last_name
    };
  });
}

module.exports = { list: list };
