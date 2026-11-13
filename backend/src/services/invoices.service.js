var inventorySales = require('./inventorySales.service');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { buildLineItems, computeDocTotals, nextDocNumber, addDays, todayISO, insertLineItems, loadLineItems, resolveCurrency, buildPaymentSchedule, bplScopeClause, docTaxOf } = require('../utils/documents');

// Every payment recorded against an invoice, oldest first — the receipt
// history that belongs on the document itself. A customer holding an invoice
// that says "balance GHS 260" needs to see which payments got it there and
// when, not just the arithmetic result.
async function loadPayments(db, invoiceId) {
  var res = await db.query(
    'SELECT p.id, p.date, p.amount, p.method, p.reference, p.source, EXISTS (SELECT 1 FROM invoice_online_payments o WHERE o.payment_id = p.id AND o.status = \'success\') AS online, e.first_name, e.last_name ' +
    'FROM payments p LEFT JOIN employees e ON e.id = p.received_by ' +
    'WHERE p.invoice_id = $1 ORDER BY p.date, p.id',
    [invoiceId]);
  return res.rows.map(function (r) {
    return {
      id: r.id, date: r.date, amount: Number(r.amount), method: r.method, reference: r.reference || '',
      receivedByName: r.first_name ? r.first_name + ' ' + r.last_name : '',
      refund: r.source === 'refund', online: !!r.online
    };
  });
}

async function rowToInvoice(db, r, extra) {
  var items = await loadLineItems(db, 'invoice', r.id);
  // `payments` may be supplied by a caller that already loaded them in bulk
  // (see list(), which would otherwise run one query per invoice on top of
  // the one it already runs per invoice for line items).
  var payments = (extra && extra.payments) || (Number(r.amount_paid) > 0 || Number(r.credit_total) > 0 ? await loadPayments(db, r.id) : []);
  return Object.assign({
    id: r.id, invoiceNo: r.invoice_no, salesOrderId: r.sales_order_id, quotationId: r.quotation_id, customerId: r.customer_id,
    items: items, currency: r.currency, subtotal: Number(r.subtotal), discountTotal: Number(r.discount_total), taxTotal: Number(r.tax_total),
    grandTotal: Number(r.grand_total), amount: Number(r.grand_total), amountPaid: Number(r.amount_paid), balanceDue: Number(r.balance_due),
    creditTotal: Number(r.credit_total || 0),
    poReference: r.po_reference, bankInstructions: r.bank_instructions, status: r.status, issuedAt: r.issued_at, dueDate: r.due_date, paidAt: r.paid_at,
    viewedAt: r.viewed_at || null, seriesId: r.series_id || null, seriesPeriod: r.series_period || null,
    notes: r.notes, terms: r.terms, discount: { value: Number(r.discount_value), type: r.discount_type }, taxRate: Number(r.tax_rate), taxComponents: r.tax_components || [], paymentSchedule: r.payment_schedule || [],
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
    '  q.quote_no, so.order_no, rm.reminders, rm.last_reminded_at, ' +
    // The sale's rep: its sales order's, else the customer's (CRM).
    "  COALESCE(so.rep_id, c.account_manager_id) AS rep_id, rp.first_name || ' ' || rp.last_name AS rep_name " +
    'FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
    'LEFT JOIN quotations q ON q.id = i.quotation_id ' +
    'LEFT JOIN sales_orders so ON so.id = i.sales_order_id ' +
    'LEFT JOIN employees rp ON rp.id = COALESCE(so.rep_id, c.account_manager_id) ' +
    'LEFT JOIN (SELECT invoice_id, count(*)::int AS reminders, max(sent_at) AS last_reminded_at FROM payment_reminders GROUP BY invoice_id) rm ON rm.invoice_id = i.id ' +
    'WHERE ' + bplScopeClause('i') + ' ORDER BY i.issued_at DESC, i.invoice_no DESC');
  // One query for every payment on this page of invoices, grouped in memory,
  // rather than one query per invoice inside the loop below.
  var ids = res.rows.map(function (x) { return x.id; });
  var byInvoice = {};
  if (ids.length) {
    var payRes = await pool.query(
      'SELECT p.invoice_id, p.id, p.date, p.amount, p.method, p.reference, p.source, EXISTS (SELECT 1 FROM invoice_online_payments o WHERE o.payment_id = p.id AND o.status = \'success\') AS online, e.first_name, e.last_name ' +
      'FROM payments p LEFT JOIN employees e ON e.id = p.received_by ' +
      'WHERE p.invoice_id = ANY($1::uuid[]) ORDER BY p.date, p.id', [ids]);
    payRes.rows.forEach(function (x) {
      (byInvoice[x.invoice_id] = byInvoice[x.invoice_id] || []).push({
        id: x.id, date: x.date, amount: Number(x.amount), method: x.method, reference: x.reference || '',
        receivedByName: x.first_name ? x.first_name + ' ' + x.last_name : '',
        refund: x.source === 'refund', online: !!x.online
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
      rep: r.rep_id ? { id: r.rep_id, name: r.rep_name } : null,
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
    // What it sells leaves stock now (inventorySales.service.js).
    await inventorySales.takeForInvoice(client, ctx, i);
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
      "INSERT INTO invoices (invoice_no, quotation_id, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, po_reference, bank_instructions, currency, notes, terms, discount_value, discount_type, tax_rate, payment_schedule, tax_components) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,'unpaid',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *",
      [invoiceNo, q.id, q.customer_id, q.subtotal, q.discount_total, q.tax_total, q.grand_total, todayISO(), addDays(todayISO(), commercial.templates.invoiceDueDays), (poReference || '').trim(), commercial.paymentDetails.instructions, q.currency, q.notes, q.terms, q.discount_value, q.discount_type, q.tax_rate, JSON.stringify(q.payment_schedule || []), JSON.stringify(q.tax_components || [])]
    );
    var i = res.rows[0];
    await insertLineItems(client, 'invoice', i.id, items);
    // What it sells leaves stock now (inventorySales.service.js).
    await inventorySales.takeForInvoice(client, ctx, i);
    await audit(client, ctx, 'invoice.create', 'invoice', i.id, 'Issued ' + i.invoice_no + ' from ' + q.quote_no + ' (' + q.currency + ' ' + Number(q.grand_total).toLocaleString() + ').');
    return i.id;
  });

  var final = await pool.query('SELECT * FROM invoices WHERE id = $1', [newId]);
  return rowToInvoice(pool, final.rows[0]);
}

// kernel.js: handlers['invoices.createManual']
// opts (from the server only): { seriesId, seriesPeriod } for one raised by
// a repeating invoice (invoiceSeries.service.js): issued on its period's
// day, and once only (ux_invoices_series_period).
async function createManual(ctx, p, opts) {
  opts = opts || {};
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var custRes = await pool.query('SELECT * FROM customers WHERE id = $1', [p.customerId]);
  if (!custRes.rows[0]) fail('invalid', 'Choose a customer.');
  var items = buildLineItems(p.items);
  var tax = docTaxOf(p);
  var totals = computeDocTotals(items, p.discount, tax.rate);
  var commercial = await getPaymentDetails();
  var dueDate = V.date(p.dueDate || addDays(todayISO(), commercial.templates.invoiceDueDays), 'Due date');
  var currency = resolveCurrency(commercial, p.currency, custRes.rows[0].preferred_currency);
  var docDiscountValue = Number((p.discount && p.discount.value) || 0);
  var docDiscountType = (p.discount && p.discount.type === 'percent') ? 'percent' : 'fixed';
  var docTaxRate = tax.rate;
  var paymentSchedule = buildPaymentSchedule(p.paymentSchedule, totals.grandTotal);
  // Over the customer's credit limit (migration 0197, statements.service.js):
  // made only when someone says yes a second time, and the audit says so.
  var cust = custRes.rows[0], overLimit = null;
  if (cust.credit_limit != null && currency === (cust.preferred_currency || 'GHS')) {
    var credit = await require('./statements.service').creditOf(cust.id, currency);
    var after = Math.round((credit.owed + totals.grandTotal) * 100) / 100;
    if (after > credit.limit) {
      overLimit = { after: after, limit: credit.limit };
      if (!p.overCreditOk) fail('creditLimit', cust.name + ' would owe ' + currency + ' ' + after.toFixed(2) + ' with this invoice, over their credit limit of ' + currency + ' ' + Number(credit.limit).toFixed(2) + '.');
    }
  }

  var newId = await withTransaction(async function (client) {
    var invoiceNo = await nextDocNumber(client, 'invoice');
    var res = await client.query(
      "INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, po_reference, bank_instructions, currency, notes, terms, discount_value, discount_type, tax_rate, payment_schedule, series_id, series_period, tax_components) " +
      "VALUES ($1,$2,$3,$4,$5,$6,0,$6,'unpaid',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *",
      [invoiceNo, p.customerId, totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal, opts.seriesPeriod || todayISO(), dueDate, (p.poReference || '').trim(), commercial.paymentDetails.instructions, currency, (p.notes || '').trim(), (p.terms || '').trim(), docDiscountValue, docDiscountType, docTaxRate, JSON.stringify(paymentSchedule),
        opts.seriesId || null, opts.seriesPeriod || null, JSON.stringify(tax.components)]
    );
    var i = res.rows[0];
    await insertLineItems(client, 'invoice', i.id, items);
    // What it sells leaves stock now (inventorySales.service.js).
    await inventorySales.takeForInvoice(client, ctx, i);
    await audit(client, ctx, 'invoice.create', 'invoice', i.id, 'Manually created ' + i.invoice_no + ' (' + currency + ' ' + totals.grandTotal.toLocaleString() + ').' +
      (overLimit ? ' Over the credit limit: ' + currency + ' ' + overLimit.after.toFixed(2) + ' owed against a limit of ' + currency + ' ' + Number(overLimit.limit).toFixed(2) + '.' : ''));
    return i.id;
  });

  var final = await pool.query('SELECT * FROM invoices WHERE id = $1', [newId]);
  return rowToInvoice(pool, final.rows[0]);
}

// kernel.js: handlers['invoices.recordPayment']
// opts (from the server only, never a request's body): { source: 'online' }
// for a payment made from the invoice's link (invoicePay.service.js).
async function recordPayment(ctx, invoiceId, p, opts) {
  opts = opts || {};
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
      'INSERT INTO payments (invoice_id, customer_id, date, amount, currency, method, reference, received_by, notes, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [i.id, i.customer_id, date, amount, i.currency, method, (p.reference || '').trim(), ctx.employee.id, (p.notes || '').trim(), opts.source === 'online' ? 'online' : 'manual']
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
      [receiptNo, pay.id, i.id, i.customer_id, date, amount, method, pay.reference, Number(i.balance_due), ctx.employee.id]
    );

    var custRes = await client.query('SELECT name FROM customers WHERE id = $1', [i.customer_id]);
    await audit(client, ctx, 'payment.record', 'invoice', i.id, 'Recorded ' + i.currency + ' ' + amount.toLocaleString() + ' payment on ' + i.invoice_no + ' (' + (custRes.rows[0] ? custRes.rows[0].name : '—') + '); balance ' + i.currency + ' ' + Number(i.balance_due).toLocaleString() + '.');
    if (i.status === 'paid') await audit(client, ctx, 'invoice.paid', 'invoice', i.id, i.invoice_no + ' fully paid.');

    return { paymentId: pay.id, receiptId: receiptRes.rows[0].id, invoiceId: i.id };
  });

  // The customer's receipt by email, on its own when that is switched on
  // (documentEmails.service.js). Not waited for: the payment stands either way.
  // Not when old invoices are settled in bulk (invoiceCleanup.service.js):
  // a customer would get receipts for money paid a year ago.
  if (!p.noReceiptEmail) setImmediate(function () { require('./documentEmails.service').afterPayment(result.receiptId); });

  var invRes = await pool.query('SELECT * FROM invoices WHERE id = $1', [result.invoiceId]);
  // Paid in full: a shop order waiting on it is placed (shop.service.js invoicePaid).
  if (invRes.rows[0].status === 'paid') {
    try { await require('./shop.service').invoicePaid(result.invoiceId); } catch (e) { console.error('Shop order not placed after payment:', e.message); }
  }
  var payRes = await pool.query('SELECT * FROM payments WHERE id = $1', [result.paymentId]);
  var rctRes = await pool.query('SELECT * FROM receipts WHERE id = $1', [result.receiptId]);
  return {
    payment: rowToPayment(payRes.rows[0]),
    receipt: rowToReceipt(rctRes.rows[0], invRes.rows[0].currency),
    invoice: await rowToInvoice(pool, invRes.rows[0])
  };
}

function rowToPayment(r) {
  return { id: r.id, invoiceId: r.invoice_id, customerId: r.customer_id, date: r.date, amount: Number(r.amount), currency: r.currency, method: r.method, reference: r.reference, receivedBy: r.received_by, notes: r.notes, refund: r.source === 'refund' };
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
  await withTransaction(async function (client) {
    // What it took from stock goes back first.
    await inventorySales.giveBack(client, ctx, i, 'deleted');
    await client.query('DELETE FROM invoices WHERE id = $1', [id]);
    await audit(client, ctx, 'invoice.delete', 'invoice', id, 'Deleted invoice ' + i.invoice_no + '.');
  });
  return true;
}

// kernel.js: handlers['invoices.void']
// Cancelling an invoice that is not needed any more, paid or not. It stays
// on the list as voided, for the record, and owes nothing.
// reason: why, kept in the audit log (needed when something was paid).
// money: when something was paid on it, what happens to that money —
//   { way: 'refund', method, reference }: it goes back to the customer — a
//     refund of all that was paid, recorded as a credit note's refund is (a
//     negative payment), so the money in and the money out both stay on
//     record and collections net to nothing;
//   { way: 'remove' }: it never came in (a payment recorded by mistake, or
//     twice) — its payments and their receipts are taken off, as taking a
//     payment off does. Not money paid online (card / Mobile Money): that
//     did come in, so it is refunded.
var REFUND_METHODS = ['cash', 'bank_transfer', 'mobile_money', 'card', 'cheque'];
function money2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
async function voidInvoice(ctx, id, reason, money) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var res = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
  var i = res.rows[0];
  if (!i) fail('notfound', 'Invoice not found.');
  if (i.status === 'void') fail('conflict', 'This invoice has already been voided.');
  reason = String(reason || '').trim().slice(0, 300);
  var way = null, method = null;
  if (money2(i.amount_paid) > 0) {
    if (!money || !money.way) {
      fail('conflict', i.currency + ' ' + money2(i.amount_paid).toFixed(2) + ' was paid on ' + i.invoice_no + '. Say what happens to that money: refunded to the customer, or never received (recorded by mistake).');
    }
    way = V.oneOf(money.way, ['refund', 'remove'], 'What happens to the money');
    if (!reason) fail('invalid', 'Say why this paid invoice is cancelled.');
    if (way === 'refund') method = V.oneOf(money.method || 'bank_transfer', REFUND_METHODS, 'Refund method');
  }
  var released = { readings: 0, periods: 0 }, moneyNote = '', shopOrders = [];
  var updated = await withTransaction(async function (client) {
    var cur = (await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur || cur.status === 'void') fail('conflict', 'This invoice has already been voided.');
    var paid = money2(cur.amount_paid);
    if (paid > 0 && !way) fail('conflict', 'A payment was recorded on ' + cur.invoice_no + ' a moment ago. Open it again and say what happens to the money.');
    if (paid > 0 && way === 'refund') {
      await client.query(
        "INSERT INTO payments (invoice_id, customer_id, date, amount, currency, method, reference, received_by, notes, source) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'refund')",
        [cur.id, cur.customer_id, todayISO(), -paid, cur.currency, method, String(money.reference || '').trim().slice(0, 120),
          ctx.employee ? ctx.employee.id : null, 'Refund \u2014 ' + cur.invoice_no + ' cancelled: ' + reason]);
      moneyNote = cur.currency + ' ' + paid.toFixed(2) + ' refunded by ' + method.replace('_', ' ');
    } else if (paid > 0 && way === 'remove') {
      var online = (await client.query("SELECT 1 FROM invoice_online_payments o JOIN payments p ON p.id = o.payment_id WHERE p.invoice_id = $1 AND o.status = 'success' LIMIT 1", [cur.id])).rows[0];
      if (online) fail('conflict', 'Part of what was paid on ' + cur.invoice_no + ' came in online (card / Mobile Money), so it did come in: refund it instead.');
      var refunds = (await client.query("SELECT 1 FROM payments WHERE invoice_id = $1 AND source = 'refund' LIMIT 1", [cur.id])).rows[0];
      if (refunds) fail('conflict', 'A refund was already recorded on ' + cur.invoice_no + ' (credit note), so its payments did come in: refund what is left instead.');
      var gone = (await client.query("SELECT id, amount FROM payments WHERE invoice_id = $1 AND source <> 'refund'", [cur.id])).rows;
      await client.query("DELETE FROM receipts WHERE payment_id IN (SELECT id FROM payments WHERE invoice_id = $1 AND source <> 'refund')", [cur.id]);
      await client.query("DELETE FROM payments WHERE invoice_id = $1 AND source <> 'refund'", [cur.id]);
      moneyNote = gone.length + ' payment(s) of ' + cur.currency + ' ' + paid.toFixed(2) + ' taken off (never received)';
    }
    // Void: the trigger that keeps an invoice's status with its money leaves a void one as it is (migration 0119).
    var u = await client.query("UPDATE invoices SET status = 'void', amount_paid = CASE WHEN $2 THEN 0 ELSE amount_paid END WHERE id = $1 AND status <> 'void' RETURNING *", [id, paid > 0]);
    if (!u.rows[0]) fail('conflict', 'This invoice has already been voided.');
    // What it took from stock goes back.
    await inventorySales.giveBack(client, ctx, cur, 'voided');
    // A utility bill's meter readings and recurring-charge periods go back
    // to not billed, whichever screen voided it — so a bill raised by
    // mistake can be raised again, or a wrong reading deleted.
    released = {
      readings: (await client.query('UPDATE poki_meter_readings SET invoice_id = NULL WHERE invoice_id = $1', [id])).rowCount,
      periods: await require('./pokiRecurring.service').release(client, id)
    };
    // A shop order waiting on it, or being made from it, is cancelled with it.
    shopOrders = (await client.query("UPDATE shop_orders SET status = 'cancelled', steps = steps || jsonb_build_object('cancelled', to_jsonb(now())) " +
      "WHERE invoice_id = $1 AND status NOT IN ('done', 'cancelled') RETURNING id, order_no", [id])).rows;
    for (var k = 0; k < shopOrders.length; k++) {
      await audit(client, ctx, 'shop.order_cancelled', 'shop_order', shopOrders[k].id, shopOrders[k].order_no + ' cancelled with its invoice ' + cur.invoice_no + '.');
    }
    await audit(client, ctx, 'invoice.void', 'invoice', id, cur.invoice_no + ' voided' +
      (moneyNote ? ' \u2014 ' + moneyNote : '') +
      (released.readings || released.periods ? ' (' + released.readings + ' reading(s), ' + released.periods + ' recurring period(s) back to not billed)' : '') + (reason ? ' \u2014 ' + reason : '') + '.');
    return u;
  });
  var out = await rowToInvoice(pool, updated.rows[0]);
  out.released = released;
  out.shopOrdersCancelled = shopOrders.map(function (o) { return o.order_no; });
  return out;
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
