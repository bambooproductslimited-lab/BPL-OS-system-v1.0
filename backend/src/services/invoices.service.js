var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { buildLineItems, computeDocTotals, nextDocNumber, addDays, todayISO, insertLineItems, loadLineItems, resolveCurrency, buildPaymentSchedule, bplScopeClause } = require('../utils/documents');

// Every payment recorded against an invoice, oldest first — the receipt
// history that belongs on the document itself. A customer holding an invoice
// that says "balance GHS 260" needs to see which payments got it there and
// when, not just the arithmetic result.
async function loadPayments(db, invoiceId) {
  var res = await db.query(
    'SELECT p.id, p.date, p.amount, p.method, p.reference, e.first_name, e.last_name ' +
    'FROM payments p LEFT JOIN employees e ON e.id = p.received_by ' +
    'WHERE p.invoice_id = $1 ORDER BY p.date, p.id',
    [invoiceId]);
  return res.rows.map(function (r) {
    return {
      id: r.id, date: r.date, amount: Number(r.amount), method: r.method, reference: r.reference || '',
      receivedByName: r.first_name ? r.first_name + ' ' + r.last_name : '',
    };
  });
}

async function rowToInvoice(db, r, extra) {
  var items = await loadLineItems(db, 'invoice', r.id);
  // `payments` may be supplied by a caller that already loaded them in bulk
  // (see list(), which would otherwise run one query per invoice on top of
  // the one it already runs per invoice for line items).
  var payments = (extra && extra.payments) || (Number(r.amount_paid) > 0 ? await loadPayments(db, r.id) : []);
  return Object.assign({
    id: r.id, invoiceNo: r.invoice_no, salesOrderId: r.sales_order_id, quotationId: r.quotation_id, customerId: r.customer_id,
    items: items, currency: r.currency, subtotal: Number(r.subtotal), discountTotal: Number(r.discount_total), taxTotal: Number(r.tax_total),
    grandTotal: Number(r.grand_total), amount: Number(r.grand_total), amountPaid: Number(r.amount_paid), balanceDue: Number(r.balance_due),
    poReference: r.po_reference, bankInstructions: r.bank_instructions, status: r.status, issuedAt: r.issued_at, dueDate: r.due_date, paidAt: r.paid_at,
    notes: r.notes, terms: r.terms, discount: { value: Number(r.discount_value), type: r.discount_type }, taxRate: Number(r.tax_rate), paymentSchedule: r.payment_schedule || [],
    payments: payments
  }, extra || {});
}

// kernel.js: handlers['invoices.list']
async function list(ctx) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  var t = todayISO();
  // Alongside each invoice: how to reach the client, the quotation or order
  // it came from, and how often and when the client was last reminded.
  var res = await pool.query(
    'SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.category AS customer_category, ' +
    '  q.quote_no, so.order_no, rm.reminders, rm.last_reminded_at ' +
    'FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
    'LEFT JOIN quotations q ON q.id = i.quotation_id ' +
    'LEFT JOIN sales_orders so ON so.id = i.sales_order_id ' +
    'LEFT JOIN (SELECT invoice_id, count(*)::int AS reminders, max(sent_at) AS last_reminded_at FROM payment_reminders GROUP BY invoice_id) rm ON rm.invoice_id = i.id ' +
    'WHERE ' + bplScopeClause('i') + ' ORDER BY i.issued_at DESC, i.invoice_no DESC');
  // One query for every payment on this page of invoices, grouped in memory,
  // rather than one query per invoice inside the loop below.
  var ids = res.rows.map(function (x) { return x.id; });
  var byInvoice = {};
  if (ids.length) {
    var payRes = await pool.query(
      'SELECT p.invoice_id, p.id, p.date, p.amount, p.method, p.reference, e.first_name, e.last_name ' +
      'FROM payments p LEFT JOIN employees e ON e.id = p.received_by ' +
      'WHERE p.invoice_id = ANY($1::uuid[]) ORDER BY p.date, p.id', [ids]);
    payRes.rows.forEach(function (x) {
      (byInvoice[x.invoice_id] = byInvoice[x.invoice_id] || []).push({
        id: x.id, date: x.date, amount: Number(x.amount), method: x.method, reference: x.reference || '',
        receivedByName: x.first_name ? x.first_name + ' ' + x.last_name : '',
      });
    });
  }
  var out = [];
  for (var idx = 0; idx < res.rows.length; idx++) {
    var r = res.rows[idx];
    // Overdue: anything still owed past its due date, part-paid included.
    var owing = r.status === 'unpaid' || r.status === 'partially_paid';
    var overdue = owing && !!r.due_date && r.due_date < t;
    out.push(await rowToInvoice(pool, r, {
      customerName: r.customer_name, customerPhone: r.customer_phone || '', customerEmail: r.customer_email || '', customerCategory: r.customer_category,
      quoteNo: r.quote_no || null, orderNo: r.order_no || null,
      reminders: r.reminders || 0, lastRemindedAt: r.last_reminded_at || null,
      overdue: overdue, daysOverdue: overdue ? Math.round((new Date(t + 'T00:00:00Z') - new Date(r.due_date + 'T00:00:00Z')) / 86400000) : 0,
      payments: byInvoice[r.id] || [],
    }));
  }
  return out;
}

async function getPaymentDetails() {
  var res = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  return res.rows[0].commercial;
}

// kernel.js: handlers['invoices.createFromOrder']
async function createFromOrder(ctx, salesOrderId) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var oRes = await pool.query('SELECT * FROM sales_orders WHERE id = $1', [salesOrderId]);
  var o = oRes.rows[0];
  if (!o) fail('notfound', 'Sales order not found.');
  if (o.status === 'cancelled') fail('conflict', 'A cancelled order cannot be invoiced.');
  // A voided invoice doesn't count: the order can be invoiced again.
  var existing = await pool.query("SELECT id FROM invoices WHERE sales_order_id = $1 AND status <> 'void'", [salesOrderId]);
  if (existing.rows[0]) fail('conflict', 'An invoice already exists for this order.');

  var rawItems = await loadLineItems(pool, 'sales_order', o.id);
  var items = buildLineItems(rawItems);
  var totals = computeDocTotals(items, null, 0);
  var commercial = await getPaymentDetails();

  var newId = await withTransaction(async function (client) {
    var invoiceNo = await nextDocNumber(client, 'invoice');
    var res = await client.query(
      "INSERT INTO invoices (invoice_no, sales_order_id, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, bank_instructions, currency) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,'unpaid',$8,$9,$10,$11) RETURNING *",
      [invoiceNo, o.id, o.customer_id, totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal, todayISO(), addDays(todayISO(), commercial.templates.invoiceDueDays), commercial.paymentDetails.instructions, o.currency]
    );
    var i = res.rows[0];
    await insertLineItems(client, 'invoice', i.id, items);
    await audit(client, ctx, 'invoice.create', 'invoice', i.id, 'Issued ' + i.invoice_no + ' for ' + o.order_no + ' (' + o.currency + ' ' + totals.grandTotal.toLocaleString() + ').');
    return i.id;
  });

  var final = await pool.query('SELECT * FROM invoices WHERE id = $1', [newId]);
  return rowToInvoice(pool, final.rows[0]);
}

// kernel.js: handlers['invoices.createFromQuotation']
async function createFromQuotation(ctx, quotationId, poReference) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var qRes = await pool.query('SELECT * FROM quotations WHERE id = $1', [quotationId]);
  var q = qRes.rows[0];
  if (!q) fail('notfound', 'Quotation not found.');
  if (q.status !== 'accepted') fail('conflict', 'Only an accepted quotation can be invoiced.');
  // A voided invoice doesn't count: the quotation can be invoiced again.
  var existing = await pool.query("SELECT id FROM invoices WHERE quotation_id = $1 AND status <> 'void'", [quotationId]);
  if (existing.rows[0]) fail('conflict', 'An invoice already exists for this quotation.');

  var items = await loadLineItems(pool, 'quotation', q.id);
  var commercial = await getPaymentDetails();

  var newId = await withTransaction(async function (client) {
    var invoiceNo = await nextDocNumber(client, 'invoice');
    var res = await client.query(
      "INSERT INTO invoices (invoice_no, quotation_id, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, po_reference, bank_instructions, currency, notes, terms, discount_value, discount_type, tax_rate, payment_schedule) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,'unpaid',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *",
      [invoiceNo, q.id, q.customer_id, q.subtotal, q.discount_total, q.tax_total, q.grand_total, todayISO(), addDays(todayISO(), commercial.templates.invoiceDueDays), (poReference || '').trim(), commercial.paymentDetails.instructions, q.currency, q.notes, q.terms, q.discount_value, q.discount_type, q.tax_rate, JSON.stringify(q.payment_schedule || [])]
    );
    var i = res.rows[0];
    await insertLineItems(client, 'invoice', i.id, items);
    await audit(client, ctx, 'invoice.create', 'invoice', i.id, 'Issued ' + i.invoice_no + ' from ' + q.quote_no + ' (' + q.currency + ' ' + Number(q.grand_total).toLocaleString() + ').');
    return i.id;
  });

  var final = await pool.query('SELECT * FROM invoices WHERE id = $1', [newId]);
  return rowToInvoice(pool, final.rows[0]);
}

// kernel.js: handlers['invoices.createManual']
async function createManual(ctx, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var custRes = await pool.query('SELECT * FROM customers WHERE id = $1', [p.customerId]);
  if (!custRes.rows[0]) fail('invalid', 'Choose a customer.');
  var items = buildLineItems(p.items);
  var totals = computeDocTotals(items, p.discount, p.taxRate);
  var commercial = await getPaymentDetails();
  var dueDate = V.date(p.dueDate || addDays(todayISO(), commercial.templates.invoiceDueDays), 'Due date');
  var currency = resolveCurrency(commercial, p.currency, custRes.rows[0].preferred_currency);
  var docDiscountValue = Number((p.discount && p.discount.value) || 0);
  var docDiscountType = (p.discount && p.discount.type === 'percent') ? 'percent' : 'fixed';
  var docTaxRate = Number(p.taxRate) || 0;
  var paymentSchedule = buildPaymentSchedule(p.paymentSchedule, totals.grandTotal);

  var newId = await withTransaction(async function (client) {
    var invoiceNo = await nextDocNumber(client, 'invoice');
    var res = await client.query(
      "INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, po_reference, bank_instructions, currency, notes, terms, discount_value, discount_type, tax_rate, payment_schedule) " +
      "VALUES ($1,$2,$3,$4,$5,$6,0,$6,'unpaid',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *",
      [invoiceNo, p.customerId, totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal, todayISO(), dueDate, (p.poReference || '').trim(), commercial.paymentDetails.instructions, currency, (p.notes || '').trim(), (p.terms || '').trim(), docDiscountValue, docDiscountType, docTaxRate, JSON.stringify(paymentSchedule)]
    );
    var i = res.rows[0];
    await insertLineItems(client, 'invoice', i.id, items);
    await audit(client, ctx, 'invoice.create', 'invoice', i.id, 'Manually created ' + i.invoice_no + ' (' + currency + ' ' + totals.grandTotal.toLocaleString() + ').');
    return i.id;
  });

  var final = await pool.query('SELECT * FROM invoices WHERE id = $1', [newId]);
  return rowToInvoice(pool, final.rows[0]);
}

// kernel.js: handlers['invoices.recordPayment']
async function recordPayment(ctx, invoiceId, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var amount = Math.round((Number(p.amount) || 0) * 100) / 100;
  if (amount <= 0) fail('invalid', 'Enter a payment amount greater than zero.');
  var method = V.oneOf(p.method || 'bank_transfer', ['cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other'], 'Payment method');
  var date = V.date(p.date || todayISO(), 'Payment date');

  var result = await withTransaction(async function (client) {
    var iRes = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    var i = iRes.rows[0];
    if (!i) fail('notfound', 'Invoice not found.');
    if (i.status === 'void') fail('conflict', 'This invoice has been voided.');
    if (i.status === 'paid') fail('conflict', 'This invoice is already fully paid.');
    if (amount > Number(i.balance_due) + 0.01) fail('invalid', 'That exceeds the outstanding balance of ' + i.currency + ' ' + Number(i.balance_due).toLocaleString() + '.');

    var payRes = await client.query(
      'INSERT INTO payments (invoice_id, customer_id, date, amount, currency, method, reference, received_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [i.id, i.customer_id, date, amount, i.currency, method, (p.reference || '').trim(), ctx.employee.id, (p.notes || '').trim()]
    );
    var pay = payRes.rows[0];

    var amountPaid = Math.round((Number(i.amount_paid) + amount) * 100) / 100;
    var balanceDue = Math.round((Number(i.grand_total) - amountPaid) * 100) / 100;
    var status = balanceDue <= 0.01 ? 'paid' : 'partially_paid';
    var paidAt = status === 'paid' ? date : i.paid_at;
    var updated = await client.query(
      'UPDATE invoices SET amount_paid = $1, balance_due = $2, status = $3, paid_at = $4 WHERE id = $5 RETURNING *',
      [amountPaid, balanceDue, status, paidAt, i.id]
    );
    i = updated.rows[0];

    var receiptNo = await nextDocNumber(client, 'receipt');
    var receiptRes = await client.query(
      'INSERT INTO receipts (receipt_no, payment_id, invoice_id, customer_id, date, amount, method, reference, balance_after, received_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [receiptNo, pay.id, i.id, i.customer_id, date, amount, method, pay.reference, balanceDue, ctx.employee.id]
    );

    var custRes = await client.query('SELECT name FROM customers WHERE id = $1', [i.customer_id]);
    await audit(client, ctx, 'payment.record', 'invoice', i.id, 'Recorded ' + i.currency + ' ' + amount.toLocaleString() + ' payment on ' + i.invoice_no + ' (' + (custRes.rows[0] ? custRes.rows[0].name : '—') + '); balance ' + i.currency + ' ' + balanceDue.toLocaleString() + '.');
    if (status === 'paid') await audit(client, ctx, 'invoice.paid', 'invoice', i.id, i.invoice_no + ' fully paid.');

    return { paymentId: pay.id, receiptId: receiptRes.rows[0].id, invoiceId: i.id };
  });

  var invRes = await pool.query('SELECT * FROM invoices WHERE id = $1', [result.invoiceId]);
  var payRes = await pool.query('SELECT * FROM payments WHERE id = $1', [result.paymentId]);
  var rctRes = await pool.query('SELECT * FROM receipts WHERE id = $1', [result.receiptId]);
  return {
    payment: rowToPayment(payRes.rows[0]),
    receipt: rowToReceipt(rctRes.rows[0], invRes.rows[0].currency),
    invoice: await rowToInvoice(pool, invRes.rows[0])
  };
}

function rowToPayment(r) {
  return { id: r.id, invoiceId: r.invoice_id, customerId: r.customer_id, date: r.date, amount: Number(r.amount), currency: r.currency, method: r.method, reference: r.reference, receivedBy: r.received_by, notes: r.notes };
}
function rowToReceipt(r, currency) {
  return { id: r.id, receiptNo: r.receipt_no, paymentId: r.payment_id, invoiceId: r.invoice_id, customerId: r.customer_id, date: r.date, amount: Number(r.amount), currency: currency, method: r.method, reference: r.reference, balanceAfter: Number(r.balance_after), receivedBy: r.received_by };
}

// kernel.js: handlers['invoices.update']
async function update(ctx, id, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var existing = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Invoice not found.');
  if (existing.rows[0].status === 'void') fail('conflict', 'This invoice has been voided.');
  var dueDate = p.dueDate ? V.date(p.dueDate, 'Due date') : existing.rows[0].due_date;
  var poReference = p.poReference !== undefined ? (p.poReference || '').trim() : existing.rows[0].po_reference;
  var notes = p.notes !== undefined ? (p.notes || '').trim() : existing.rows[0].notes;
  var terms = p.terms !== undefined ? (p.terms || '').trim() : existing.rows[0].terms;
  var paymentSchedule = p.paymentSchedule !== undefined ? buildPaymentSchedule(p.paymentSchedule, Number(existing.rows[0].grand_total)) : existing.rows[0].payment_schedule;

  var res = await pool.query('UPDATE invoices SET due_date = $1, po_reference = $2, notes = $3, terms = $4, payment_schedule = $5 WHERE id = $6 RETURNING *', [dueDate, poReference, notes, terms, JSON.stringify(paymentSchedule), id]);
  var i = res.rows[0];
  await audit(pool, ctx, 'invoice.update', 'invoice', i.id, 'Updated ' + i.invoice_no + '.');
  return rowToInvoice(pool, i);
}

// kernel.js: handlers['invoices.delete']
async function remove(ctx, id) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var res = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
  var i = res.rows[0];
  if (!i) fail('notfound', 'Invoice not found.');
  if (Number(i.amount_paid) > 0) fail('conflict', 'Cannot delete an invoice that has payments recorded. Remove the payments first.');
  await pool.query('DELETE FROM invoices WHERE id = $1', [id]);
  await audit(pool, ctx, 'invoice.delete', 'invoice', id, 'Deleted invoice ' + i.invoice_no + '.');
  return true;
}

// kernel.js: handlers['invoices.void']
async function voidInvoice(ctx, id) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var res = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
  var i = res.rows[0];
  if (!i) fail('notfound', 'Invoice not found.');
  if (i.status === 'void') fail('conflict', 'This invoice has already been voided.');
  if (Number(i.amount_paid) > 0) fail('conflict', 'Cannot void an invoice that already has payments recorded against it.');
  var updated = await pool.query("UPDATE invoices SET status = 'void' WHERE id = $1 RETURNING *", [id]);
  await audit(pool, ctx, 'invoice.void', 'invoice', id, i.invoice_no + ' voided.');
  return rowToInvoice(pool, updated.rows[0]);
}

// kernel.js: handlers['invoices.markPaid']
async function markPaid(ctx, id) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var res = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
  var i = res.rows[0];
  if (!i) fail('notfound', 'Invoice not found.');
  if (i.status === 'paid') fail('conflict', 'Already marked paid.');
  var result = await recordPayment(ctx, id, { amount: Number(i.balance_due), method: 'bank_transfer', reference: 'Manual settlement' });
  return result.invoice;
}

module.exports = {
  list: list, createFromOrder: createFromOrder, createFromQuotation: createFromQuotation, createManual: createManual,
  recordPayment: recordPayment, update: update, remove: remove, voidInvoice: voidInvoice, markPaid: markPaid,
  rowToInvoice: rowToInvoice, rowToPayment: rowToPayment, rowToReceipt: rowToReceipt
};
