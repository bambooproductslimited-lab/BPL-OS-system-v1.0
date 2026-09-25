var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { bplScopeClause } = require('../utils/documents');

// kernel.js: handlers['receipts.list']
// Bamboo Products' receipts only, like the Invoices and Payments pages,
// with the client's contact details and the invoice's total.
async function list(ctx) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  var res = await pool.query(
    'SELECT r.*, i.invoice_no, i.currency, i.grand_total, i.status AS invoice_status, c.name AS customer_name, c.billing_address, c.address, c.phone AS customer_phone, c.email AS customer_email, ' +
    '  e.first_name, e.last_name FROM receipts r ' +
    'JOIN invoices i ON i.id = r.invoice_id JOIN customers c ON c.id = r.customer_id JOIN employees e ON e.id = r.received_by ' +
    'WHERE ' + bplScopeClause('i') + ' ORDER BY r.date DESC, r.receipt_no DESC'
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, receiptNo: r.receipt_no, paymentId: r.payment_id, invoiceId: r.invoice_id, customerId: r.customer_id,
      date: r.date, amount: Number(r.amount), currency: r.currency, method: r.method, reference: r.reference, balanceAfter: Number(r.balance_after), receivedBy: r.received_by,
      invoiceNo: r.invoice_no, customerName: r.customer_name, customerAddress: r.billing_address || r.address || '',
      customerPhone: r.customer_phone || '', customerEmail: r.customer_email || '',
      invoiceTotal: Number(r.grand_total), invoiceStatus: r.invoice_status,
      receivedByName: r.first_name + ' ' + r.last_name
    };
  });
}

module.exports = { list: list };
