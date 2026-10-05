var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { loadLineItems, insertLineItems, nextDocNumber } = require('../utils/documents');

// Sales orders: an accepted quotation turned into work to deliver. Bamboo
// Products' orders only here — a client with no company, or Bamboo
// Products' own — the same clients the Quotations and Invoices pages show.
// An order moves pending → processing → delivered, or is cancelled; once an
// invoice (not voided) stands on it, it can't be cancelled.
//
// Every order has its sales rep (the CRM, migration 0128): the customer's rep
// when the order is made, else whoever makes it; it can be changed until the
// order is delivered. The invoice made from the order is that rep's sale.
var BPL_CLIENT = "(c.company_id IS NULL OR c.company_id = (SELECT id FROM companies WHERE code = 'BPL'))";
var MOVES = {
  pending: ['processing', 'cancelled'],
  processing: ['delivered', 'pending', 'cancelled'],
  delivered: ['processing'],
  cancelled: ['pending']
};

async function rowToOrder(db, r, extra) {
  var items = await loadLineItems(db, 'sales_order', r.id);
  return Object.assign({
    id: r.id, orderNo: r.order_no, customerId: r.customer_id, quotationId: r.quotation_id, items: items, currency: r.currency,
    total: Number(r.total), status: r.status, createdAt: r.created_at, createdBy: r.created_by,
    promisedDate: r.promised_date || null, deliveredAt: r.delivered_at || null, notes: r.notes || '', repId: r.rep_id || null
  }, extra || {});
}

var LIST_SQL =
  'SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, q.quote_no, ' +
  "  e.first_name || ' ' || e.last_name AS created_by_name, rp.first_name || ' ' || rp.last_name AS rep_name, i.id AS invoice_id, i.invoice_no, i.status AS invoice_status, i.balance_due " +
  'FROM sales_orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN quotations q ON q.id = o.quotation_id ' +
  'LEFT JOIN employees e ON e.id = o.created_by LEFT JOIN employees rp ON rp.id = o.rep_id ' +
  "LEFT JOIN LATERAL (SELECT id, invoice_no, status, balance_due FROM invoices WHERE sales_order_id = o.id ORDER BY (status = 'void'), issued_at DESC LIMIT 1) i ON true ";
function extras(r) {
  return {
    customerName: r.customer_name, customerPhone: r.customer_phone || '', customerEmail: r.customer_email || '',
    quoteNo: r.quote_no || null, createdByName: r.created_by_name || '', repName: r.rep_name || '',
    invoice: r.invoice_id ? { id: r.invoice_id, invoiceNo: r.invoice_no, status: r.invoice_status, balanceDue: Number(r.balance_due) } : null
  };
}

// kernel.js: handlers['salesOrders.list']
async function list(ctx) {
  if (!ctx.can('sales.read')) fail('forbidden', 'Your role does not allow this action (sales.read).');
  var res = await pool.query(LIST_SQL + 'WHERE ' + BPL_CLIENT + ' ORDER BY o.created_at DESC');
  var out = [];
  for (var i = 0; i < res.rows.length; i++) out.push(await rowToOrder(pool, res.rows[i], extras(res.rows[i])));
  return out;
}
async function getOne(id) {
  var res = await pool.query(LIST_SQL + 'WHERE o.id = $1', [id]);
  if (!res.rows[0]) fail('notfound', 'Sales order not found.');
  return rowToOrder(pool, res.rows[0], extras(res.rows[0]));
}

// The order's rep: the one chosen, else the customer's rep, else whoever
// makes the order.
async function repFor(repId, customerId, ctx) {
  if (repId) {
    var e = (await pool.query("SELECT id FROM employees WHERE id = $1 AND status = 'active'", [repId])).rows[0];
    if (!e) fail('invalid', 'That sales rep isn\'t an active employee.');
    return e.id;
  }
  var c = (await pool.query('SELECT account_manager_id FROM customers WHERE id = $1', [customerId])).rows[0];
  return (c && c.account_manager_id) || (ctx.employee ? ctx.employee.id : null);
}

// kernel.js: handlers['salesOrders.createFromQuotation']
async function createFromQuotation(ctx, quotationId, p) {
  if (!ctx.can('sales.manage')) fail('forbidden', 'Your role does not allow this action (sales.manage).');
  p = p || {};
  var qRes = await pool.query('SELECT * FROM quotations WHERE id = $1', [quotationId]);
  var q = qRes.rows[0];
  if (!q) fail('notfound', 'Quotation not found.');
  if (q.status !== 'accepted') fail('conflict', 'Only an accepted quotation can become a sales order.');
  var existing = await pool.query("SELECT order_no FROM sales_orders WHERE quotation_id = $1 AND status <> 'cancelled'", [quotationId]);
  if (existing.rows[0]) fail('conflict', 'Sales order ' + existing.rows[0].order_no + ' already exists for this quotation.');
  var promised = p.promisedDate ? V.date(p.promisedDate, 'Promised date') : null;
  var notes = String(p.notes || '').trim().slice(0, 1000);

  var rep = await repFor(p.repId, q.customer_id, ctx);

  var items = await loadLineItems(pool, 'quotation', q.id);
  var newId = await withTransaction(async function (client) {
    var orderNo = await nextDocNumber(client, 'salesOrder');
    var res = await client.query(
      "INSERT INTO sales_orders (order_no, customer_id, quotation_id, total, status, created_by, currency, promised_date, notes, rep_id) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9) RETURNING *",
      [orderNo, q.customer_id, q.id, q.grand_total, ctx.employee.id, q.currency, promised, notes, rep]
    );
    var o = res.rows[0];
    await insertLineItems(client, 'sales_order', o.id, items);
    await audit(client, ctx, 'salesorder.create', 'sales_order', o.id, 'Created ' + o.order_no + ' from ' + q.quote_no + ' (' + q.currency + ' ' + Number(q.grand_total).toLocaleString() + ').');
    return o.id;
  });
  return getOne(newId);
}

// kernel.js: handlers['salesOrders.setStatus']
async function setStatus(ctx, id, status) {
  if (!ctx.can('sales.manage')) fail('forbidden', 'Your role does not allow this action (sales.manage).');
  status = V.oneOf(status, ['pending', 'processing', 'delivered', 'cancelled'], 'Status');
  var o = (await pool.query('SELECT * FROM sales_orders WHERE id = $1', [id])).rows[0];
  if (!o) fail('notfound', 'Sales order not found.');
  if (o.status === status) return getOne(id);
  if ((MOVES[o.status] || []).indexOf(status) < 0) fail('conflict', 'A ' + o.status + ' order can\'t be marked ' + status + '.');
  if (status === 'cancelled') {
    var inv = (await pool.query("SELECT invoice_no FROM invoices WHERE sales_order_id = $1 AND status <> 'void' LIMIT 1", [id])).rows[0];
    if (inv) fail('conflict', 'Invoice ' + inv.invoice_no + ' was made from this order. Void it before cancelling the order.');
  }
  await pool.query(
    "UPDATE sales_orders SET status = $1, delivered_at = CASE WHEN $1 = 'delivered' THEN now() ELSE NULL END WHERE id = $2", [status, id]);
  await audit(pool, ctx, 'salesorder.status', 'sales_order', id, 'Set ' + o.order_no + ' to ' + status + '.');
  return getOne(id);
}

// The promised date and notes can change until the order is delivered.
async function update(ctx, id, p) {
  if (!ctx.can('sales.manage')) fail('forbidden', 'Your role does not allow this action (sales.manage).');
  var o = (await pool.query('SELECT * FROM sales_orders WHERE id = $1', [id])).rows[0];
  if (!o) fail('notfound', 'Sales order not found.');
  if (o.status === 'delivered' || o.status === 'cancelled') fail('conflict', 'A ' + o.status + ' order can\'t be changed.');
  var promised = p.promisedDate === undefined ? o.promised_date : (p.promisedDate ? V.date(p.promisedDate, 'Promised date') : null);
  var notes = p.notes === undefined ? o.notes : String(p.notes || '').trim().slice(0, 1000);
  var repId = p.repId === undefined ? o.rep_id : await repFor(p.repId, o.customer_id, ctx);
  await pool.query('UPDATE sales_orders SET promised_date = $1, notes = $2, rep_id = $4 WHERE id = $3', [promised, notes, id, repId]);
  await audit(pool, ctx, 'salesorder.update', 'sales_order', id, 'Updated ' + o.order_no + (repId !== o.rep_id ? ' (new sales rep)' : '') + '.');
  return getOne(id);
}

module.exports = { list: list, createFromQuotation: createFromQuotation, setStatus: setStatus, update: update, rowToOrder: rowToOrder };
