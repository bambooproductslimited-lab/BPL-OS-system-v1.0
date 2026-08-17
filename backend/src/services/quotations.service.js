var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { buildLineItems, computeDocTotals, nextDocNumber, addDays, todayISO, insertLineItems, loadLineItems } = require('../utils/documents');

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
    id: r.id, quoteNo: r.quote_no, customerId: r.customer_id, title: r.title, items: items,
    subtotal: Number(r.subtotal), discountTotal: Number(r.discount_total), taxTotal: Number(r.tax_total),
    grandTotal: Number(r.grand_total), total: Number(r.grand_total), status: r.status, createdBy: r.created_by,
    createdAt: r.created_at, validUntil: r.valid_until, notes: r.notes, terms: r.terms, fromEstimateId: r.from_estimate_id
  }, extra || {});
}

// kernel.js: handlers['quotations.list']
async function list(ctx) {
  if (!ctx.can('quotation.read')) fail('forbidden', 'Your role does not allow this action (quotation.read).');
  await autoExpireQuotations();
  var res = await pool.query('SELECT q.*, c.name AS customer_name FROM quotations q JOIN customers c ON c.id = q.customer_id ORDER BY q.created_at DESC');
  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    out.push(await rowToQuotation(pool, res.rows[i], { customerName: res.rows[i].customer_name }));
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

  var newId = await withTransaction(async function (client) {
    var quoteNo = await nextDocNumber(client, 'quotation');
    var res = await client.query(
      "INSERT INTO quotations (quote_no, customer_id, title, subtotal, discount_total, tax_total, grand_total, status, created_by, valid_until, notes, terms) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11) RETURNING *",
      [quoteNo, cust.id, title, totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal, ctx.employee.id, validUntil, (p.notes || '').trim(), p.terms || commercial.templates.termsAndConditions]
    );
    var q = res.rows[0];
    await insertLineItems(client, 'quotation', q.id, items);
    await audit(client, ctx, 'quotation.create', 'quotation', q.id, 'Created ' + q.quote_no + ' for ' + cust.name + ' (GHS ' + totals.grandTotal.toLocaleString() + ').');
    return q.id;
  });

  var final = await pool.query('SELECT * FROM quotations WHERE id = $1', [newId]);
  return rowToQuotation(pool, final.rows[0]);
}

// kernel.js: handlers['quotations.setStatus']
async function setStatus(ctx, id, status) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  status = V.oneOf(status, ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'cancelled'], 'Status');
  var res = await pool.query('UPDATE quotations SET status = $1 WHERE id = $2 RETURNING *', [status, id]);
  if (!res.rows[0]) fail('notfound', 'Quotation not found.');
  var q = res.rows[0];
  await audit(pool, ctx, 'quotation.status', 'quotation', q.id, 'Set ' + q.quote_no + ' to ' + status + '.');
  return rowToQuotation(pool, q);
}

module.exports = { list: list, create: create, setStatus: setStatus, rowToQuotation: rowToQuotation };
