var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { buildLineItems, computeDocTotals, nextDocNumber, addDays, todayISO, insertLineItems, loadLineItems, resolveCurrency, buildPaymentSchedule, bplScopeClause } = require('../utils/documents');

// kernel.js: autoExpireQuotations()
async function autoExpireQuotations() {
  await pool.query(
    "UPDATE quotations SET status = 'expired' WHERE status IN ('draft','sent','viewed') AND valid_until < $1",
    [todayISO()]
  );
}

async function rowToQuotation(db, r, extra) {
  var items = await loadLineItems(db, 'quotation', r.id);
  return Object.assign({
    id: r.id, quoteNo: r.quote_no, customerId: r.customer_id, title: r.title, items: items, currency: r.currency,
    subtotal: Number(r.subtotal), discountTotal: Number(r.discount_total), taxTotal: Number(r.tax_total),
    grandTotal: Number(r.grand_total), total: Number(r.grand_total), status: r.status, createdBy: r.created_by,
    createdAt: r.created_at, validUntil: r.valid_until, notes: r.notes, terms: r.terms, fromEstimateId: r.from_estimate_id,
    sentAt: r.sent_at || null, answeredAt: r.answered_at || null,
    discount: { value: Number(r.discount_value), type: r.discount_type }, taxRate: Number(r.tax_rate), paymentSchedule: r.payment_schedule || []
  }, extra || {});
}

// kernel.js: handlers['quotations.list']
async function list(ctx) {
  if (!ctx.can('quotation.read')) fail('forbidden', 'Your role does not allow this action (quotation.read).');
  await autoExpireQuotations();
  // Alongside each quotation: how to reach the client, who made it, the
  // estimate it came from and the invoice made from it (a voided one only
  // when there is nothing newer).
  var res = await pool.query(
    'SELECT q.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.category AS customer_category, ' +
    "  e.first_name || ' ' || e.last_name AS created_by_name, es.estimate_no, " +
    '  i.id AS invoice_id, i.invoice_no, i.status AS invoice_status, i.balance_due AS invoice_balance ' +
    'FROM quotations q JOIN customers c ON c.id = q.customer_id ' +
    'LEFT JOIN employees e ON e.id = q.created_by ' +
    'LEFT JOIN estimates es ON es.id = q.from_estimate_id ' +
    "LEFT JOIN LATERAL (SELECT id, invoice_no, status, balance_due FROM invoices WHERE quotation_id = q.id ORDER BY (status = 'void'), issued_at DESC LIMIT 1) i ON true " +
    'WHERE ' + bplScopeClause('q') + ' ORDER BY q.created_at DESC');
  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    out.push(await rowToQuotation(pool, r, {
      customerName: r.customer_name, customerPhone: r.customer_phone || '', customerEmail: r.customer_email || '', customerCategory: r.customer_category,
      createdByName: r.created_by_name || '',
      estimateNo: r.estimate_no || null,
      invoice: r.invoice_id ? { id: r.invoice_id, invoiceNo: r.invoice_no, status: r.invoice_status, balanceDue: Number(r.invoice_balance) } : null
    }));
  }
  return out;
}

// kernel.js: handlers['quotations.create']
async function create(ctx, p) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  var custRes = await pool.query('SELECT * FROM customers WHERE id = $1', [p.customerId]);
  var cust = custRes.rows[0];
  if (!cust) fail('invalid', 'Choose a customer.');

  var rawItems = (p.items && p.items.length) ? p.items : (p.description ? [{ description: p.description, qty: p.qty, unitPrice: p.unitPrice }] : []);
  var items = buildLineItems(rawItems);
  var totals = computeDocTotals(items, p.discount, p.taxRate);
  var title = V.text(p.title || 'Quotation for ' + cust.name, 'Title', 120);

  var settingsRes = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var commercial = settingsRes.rows[0].commercial;
  var validUntil = V.date(p.validUntil || addDays(todayISO(), commercial.templates.validityDays), 'Valid until');
  var currency = resolveCurrency(commercial, p.currency, cust.preferred_currency);

  var docDiscountValue = Number((p.discount && p.discount.value) || 0);
  var docDiscountType = (p.discount && p.discount.type === 'percent') ? 'percent' : 'fixed';
  var docTaxRate = Number(p.taxRate) || 0;
  var paymentSchedule = buildPaymentSchedule(p.paymentSchedule, totals.grandTotal);

  var newId = await withTransaction(async function (client) {
    var quoteNo = await nextDocNumber(client, 'quotation');
    var res = await client.query(
      "INSERT INTO quotations (quote_no, customer_id, title, subtotal, discount_total, tax_total, grand_total, status, created_by, valid_until, notes, terms, currency, discount_value, discount_type, tax_rate, payment_schedule) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *",
      [quoteNo, cust.id, title, totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal, ctx.employee.id, validUntil, (p.notes || '').trim(), p.terms || commercial.templates.termsAndConditions, currency, docDiscountValue, docDiscountType, docTaxRate, JSON.stringify(paymentSchedule)]
    );
    var q = res.rows[0];
    await insertLineItems(client, 'quotation', q.id, items);
    await audit(client, ctx, 'quotation.create', 'quotation', q.id, 'Created ' + q.quote_no + ' for ' + cust.name + ' (' + currency + ' ' + totals.grandTotal.toLocaleString() + ').');
    return q.id;
  });

  var final = await pool.query('SELECT * FROM quotations WHERE id = $1', [newId]);
  return rowToQuotation(pool, final.rows[0]);
}

// kernel.js: handlers['quotations.setStatus']
// Going out stamps sent_at (the first time), an answer stamps answered_at;
// once an invoice stands on a quotation its status no longer moves.
async function setStatus(ctx, id, status) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  status = V.oneOf(status, ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'cancelled'], 'Status');
  var cur = await pool.query('SELECT id FROM quotations WHERE id = $1', [id]);
  if (!cur.rows[0]) fail('notfound', 'Quotation not found.');
  var inv = await pool.query("SELECT invoice_no FROM invoices WHERE quotation_id = $1 AND status <> 'void' LIMIT 1", [id]);
  if (inv.rows[0]) fail('conflict', 'Invoice ' + inv.rows[0].invoice_no + ' was made from this quotation, so it stays accepted. Void the invoice first.');
  var res = await pool.query(
    'UPDATE quotations SET status = $1, ' +
    "  sent_at = CASE WHEN $1 IN ('sent', 'viewed', 'accepted', 'rejected') THEN coalesce(sent_at, now()) WHEN $1 = 'draft' THEN NULL ELSE sent_at END, " +
    "  answered_at = CASE WHEN $1 IN ('accepted', 'rejected') THEN now() WHEN $1 IN ('draft', 'sent', 'viewed') THEN NULL ELSE answered_at END " +
    'WHERE id = $2 RETURNING *', [status, id]);
  var q = res.rows[0];
  await audit(pool, ctx, 'quotation.status', 'quotation', q.id, 'Set ' + q.quote_no + ' to ' + status + '.');
  return rowToQuotation(pool, q);
}

// Only a draft can be changed; once it has gone out, the client has seen
// those prices.
async function update(ctx, id, p) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  var existing = (await pool.query('SELECT * FROM quotations WHERE id = $1', [id])).rows[0];
  if (!existing) fail('notfound', 'Quotation not found.');
  if (existing.status !== 'draft') fail('conflict', 'Only a draft quotation can be changed.');
  var cust = (await pool.query('SELECT * FROM customers WHERE id = $1', [p.customerId || existing.customer_id])).rows[0];
  if (!cust) fail('invalid', 'Choose a customer.');
  var items = buildLineItems(p.items);
  var totals = computeDocTotals(items, p.discount, p.taxRate);
  var title = V.text(p.title || 'Quotation for ' + cust.name, 'Title', 120);
  var commercial = (await pool.query('SELECT commercial FROM settings WHERE id = 1')).rows[0].commercial;
  var validUntil = p.validUntil ? V.date(p.validUntil, 'Valid until') : existing.valid_until;
  var currency = p.currency !== undefined ? resolveCurrency(commercial, p.currency, cust.preferred_currency) : existing.currency;
  var docDiscountValue = Number((p.discount && p.discount.value) || 0);
  var docDiscountType = (p.discount && p.discount.type === 'percent') ? 'percent' : 'fixed';
  var docTaxRate = Number(p.taxRate) || 0;
  var paymentSchedule = buildPaymentSchedule(p.paymentSchedule, totals.grandTotal);

  await withTransaction(async function (client) {
    await client.query(
      'UPDATE quotations SET customer_id = $1, title = $2, subtotal = $3, discount_total = $4, tax_total = $5, grand_total = $6, valid_until = $7, notes = $8, currency = $9, discount_value = $10, discount_type = $11, tax_rate = $12, payment_schedule = $13 WHERE id = $14',
      [cust.id, title, totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal, validUntil, (p.notes || '').trim(), currency, docDiscountValue, docDiscountType, docTaxRate, JSON.stringify(paymentSchedule), id]
    );
    await client.query('DELETE FROM document_line_items WHERE document_type = $1 AND document_id = $2', ['quotation', id]);
    await insertLineItems(client, 'quotation', id, items);
    await audit(client, ctx, 'quotation.update', 'quotation', id, 'Updated ' + existing.quote_no + '.');
  });
  var final = await pool.query('SELECT * FROM quotations WHERE id = $1', [id]);
  return rowToQuotation(pool, final.rows[0]);
}

module.exports = { list: list, create: create, update: update, setStatus: setStatus, rowToQuotation: rowToQuotation };
