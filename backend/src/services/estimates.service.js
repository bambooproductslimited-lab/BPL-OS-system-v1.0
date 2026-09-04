var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { buildLineItems, computeDocTotals, nextDocNumber, addDays, todayISO, insertLineItems, loadLineItems, resolveCurrency } = require('../utils/documents');

async function rowToEstimate(db, r, extra) {
  var items = await loadLineItems(db, 'estimate', r.id);
  return Object.assign({
    id: r.id, estimateNo: r.estimate_no, customerId: r.customer_id, items: items, currency: r.currency,
    subtotal: Number(r.subtotal), discountTotal: Number(r.discount_total), taxTotal: Number(r.tax_total), grandTotal: Number(r.grand_total),
    status: r.status, createdBy: r.created_by, createdAt: r.created_at, validUntil: r.valid_until,
    internalNotes: r.internal_notes, clientNotes: r.client_notes, terms: r.terms
  }, extra || {});
}

// kernel.js: handlers['estimates.list']
async function list(ctx) {
  if (!ctx.can('quotation.read')) fail('forbidden', 'Your role does not allow this action (quotation.read).');
  var res = await pool.query('SELECT es.*, c.name AS customer_name FROM estimates es JOIN customers c ON c.id = es.customer_id ORDER BY es.created_at DESC');
  var out = [];
  for (var i = 0; i < res.rows.length; i++) out.push(await rowToEstimate(pool, res.rows[i], { customerName: res.rows[i].customer_name }));
  return out;
}

// kernel.js: handlers['estimates.create']
async function create(ctx, p) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  var custRes = await pool.query('SELECT * FROM customers WHERE id = $1', [p.customerId]);
  var cust = custRes.rows[0];
  if (!cust) fail('invalid', 'Choose a customer.');
  var items = buildLineItems(p.items);
  var totals = computeDocTotals(items, p.discount, p.taxRate);

  var settingsRes = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var commercial = settingsRes.rows[0].commercial;
  var validUntil = V.date(p.validUntil || addDays(todayISO(), commercial.templates.validityDays), 'Valid until');
  var currency = resolveCurrency(commercial, p.currency, cust.preferred_currency);

  var newId = await withTransaction(async function (client) {
    var estimateNo = await nextDocNumber(client, 'estimate');
    var res = await client.query(
      "INSERT INTO estimates (estimate_no, customer_id, subtotal, discount_total, tax_total, grand_total, status, created_by, valid_until, internal_notes, client_notes, terms, currency) " +
      "VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12) RETURNING *",
      [estimateNo, cust.id, totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal, ctx.employee.id, validUntil, (p.internalNotes || '').trim(), (p.clientNotes || '').trim(), p.terms || commercial.templates.termsAndConditions, currency]
    );
    var es = res.rows[0];
    await insertLineItems(client, 'estimate', es.id, items);
    await audit(client, ctx, 'estimate.create', 'estimate', es.id, 'Created ' + es.estimate_no + ' for ' + cust.name + ' (' + currency + ' ' + totals.grandTotal.toLocaleString() + ').');
    return es.id;
  });

  var final = await pool.query('SELECT * FROM estimates WHERE id = $1', [newId]);
  return rowToEstimate(pool, final.rows[0]);
}

// kernel.js: handlers['estimates.setStatus']
async function setStatus(ctx, id, status) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  status = V.oneOf(status, ['draft', 'finalized', 'converted', 'archived'], 'Status');
  var res = await pool.query('UPDATE estimates SET status = $1 WHERE id = $2 RETURNING *', [status, id]);
  if (!res.rows[0]) fail('notfound', 'Estimate not found.');
  var es = res.rows[0];
  await audit(pool, ctx, 'estimate.status', 'estimate', es.id, 'Set ' + es.estimate_no + ' to ' + status + '.');
  return rowToEstimate(pool, es);
}

// kernel.js: handlers['estimates.update']
async function update(ctx, id, p) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  var existingRes = await pool.query('SELECT * FROM estimates WHERE id = $1', [id]);
  var existing = existingRes.rows[0];
  if (!existing) fail('notfound', 'Estimate not found.');
  if (existing.status !== 'draft') fail('conflict', 'Only a draft estimate can be edited.');

  var custRes = await pool.query('SELECT * FROM customers WHERE id = $1', [p.customerId]);
  if (!custRes.rows[0]) fail('invalid', 'Choose a customer.');
  var items = buildLineItems(p.items);
  var totals = computeDocTotals(items, p.discount, p.taxRate);
  var validUntil = p.validUntil ? V.date(p.validUntil, 'Valid until') : existing.valid_until;
  var settingsRes2 = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var currency = p.currency !== undefined ? resolveCurrency(settingsRes2.rows[0].commercial, p.currency, custRes.rows[0].preferred_currency) : existing.currency;

  await withTransaction(async function (client) {
    await client.query(
      'UPDATE estimates SET customer_id = $1, subtotal = $2, discount_total = $3, tax_total = $4, grand_total = $5, valid_until = $6, internal_notes = $7, client_notes = $8, currency = $9 WHERE id = $10',
      [p.customerId, totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal, validUntil, (p.internalNotes || '').trim(), (p.clientNotes || '').trim(), currency, id]
    );
    await client.query('DELETE FROM document_line_items WHERE document_type = $1 AND document_id = $2', ['estimate', id]);
    await insertLineItems(client, 'estimate', id, items);
    await audit(client, ctx, 'estimate.update', 'estimate', id, 'Updated ' + existing.estimate_no + '.');
  });

  var final = await pool.query('SELECT * FROM estimates WHERE id = $1', [id]);
  return rowToEstimate(pool, final.rows[0]);
}

// kernel.js: handlers['estimates.delete']
async function remove(ctx, id) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  var res = await pool.query('SELECT * FROM estimates WHERE id = $1', [id]);
  var es = res.rows[0];
  if (!es) fail('notfound', 'Estimate not found.');
  if (es.status === 'converted') fail('conflict', 'Cannot delete an estimate that has already been converted to a quotation.');
  await pool.query('DELETE FROM estimates WHERE id = $1', [id]);
  await audit(pool, ctx, 'estimate.delete', 'estimate', id, 'Deleted estimate ' + es.estimate_no + '.');
  return true;
}

// kernel.js: handlers['estimates.convertToQuotation']
async function convertToQuotation(ctx, id) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  var res = await pool.query('SELECT * FROM estimates WHERE id = $1', [id]);
  var es = res.rows[0];
  if (!es) fail('notfound', 'Estimate not found.');
  if (es.status === 'converted') fail('conflict', 'This estimate has already been converted.');

  var custRes = await pool.query('SELECT name FROM customers WHERE id = $1', [es.customer_id]);
  var items = await loadLineItems(pool, 'estimate', es.id);

  var newQuoteId = await withTransaction(async function (client) {
    var quoteNo = await nextDocNumber(client, 'quotation');
    var insertRes = await client.query(
      "INSERT INTO quotations (quote_no, customer_id, title, subtotal, discount_total, tax_total, grand_total, status, created_by, valid_until, notes, terms, from_estimate_id, currency) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13) RETURNING *",
      [quoteNo, es.customer_id, 'Quotation for ' + (custRes.rows[0] ? custRes.rows[0].name : ''), es.subtotal, es.discount_total, es.tax_total, es.grand_total, ctx.employee.id, es.valid_until, es.client_notes, es.terms, es.id, es.currency]
    );
    var q = insertRes.rows[0];
    await insertLineItems(client, 'quotation', q.id, items);
    await client.query("UPDATE estimates SET status = 'converted' WHERE id = $1", [es.id]);
    await audit(client, ctx, 'estimate.convert', 'estimate', es.id, 'Converted ' + es.estimate_no + ' to quotation ' + q.quote_no + '.');
    return q.id;
  });

  var quotationsService = require('./quotations.service');
  var final = await pool.query('SELECT * FROM quotations WHERE id = $1', [newQuoteId]);
  return quotationsService.rowToQuotation(pool, final.rows[0]);
}

module.exports = { list: list, create: create, setStatus: setStatus, update: update, remove: remove, convertToQuotation: convertToQuotation };
