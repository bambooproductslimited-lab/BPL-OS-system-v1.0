var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { todayISO, loadLineItems, insertLineItems } = require('../utils/documents');

async function rowToOrder(db, r, extra) {
  var items = await loadLineItems(db, 'sales_order', r.id);
  return Object.assign({
    id: r.id, orderNo: r.order_no, customerId: r.customer_id, quotationId: r.quotation_id, items: items,
    total: Number(r.total), status: r.status, createdAt: r.created_at, createdBy: r.created_by
  }, extra || {});
}

// kernel.js: handlers['salesOrders.list']
async function list(ctx) {
  if (!ctx.can('sales.read')) fail('forbidden', 'Your role does not allow this action (sales.read).');
  var res = await pool.query('SELECT o.*, c.name AS customer_name FROM sales_orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.created_at DESC');
  var out = [];
  for (var i = 0; i < res.rows.length; i++) out.push(await rowToOrder(pool, res.rows[i], { customerName: res.rows[i].customer_name }));
  return out;
}

// kernel.js: handlers['salesOrders.createFromQuotation']
async function createFromQuotation(ctx, quotationId) {
  if (!ctx.can('sales.manage')) fail('forbidden', 'Your role does not allow this action (sales.manage).');
  var qRes = await pool.query('SELECT * FROM quotations WHERE id = $1', [quotationId]);
  var q = qRes.rows[0];
  if (!q) fail('notfound', 'Quotation not found.');
  if (q.status !== 'accepted') fail('conflict', 'Only an accepted quotation can become a sales order.');
  var existing = await pool.query('SELECT id FROM sales_orders WHERE quotation_id = $1', [quotationId]);
  if (existing.rows[0]) fail('conflict', 'A sales order already exists for this quotation.');

  var items = await loadLineItems(pool, 'quotation', q.id);
  var countRes = await pool.query('SELECT count(*)::int AS n FROM sales_orders');
  var orderNo = 'SO-' + String(1400 + countRes.rows[0].n + 1);

  var newId = await withTransaction(async function (client) {
    var res = await client.query(
      "INSERT INTO sales_orders (order_no, customer_id, quotation_id, total, status, created_by) VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *",
      [orderNo, q.customer_id, q.id, q.grand_total, ctx.employee.id]
    );
    var o = res.rows[0];
    await insertLineItems(client, 'sales_order', o.id, items);
    await audit(client, ctx, 'salesorder.create', 'sales_order', o.id, 'Created ' + o.order_no + ' from ' + q.quote_no + ' (GHS ' + Number(q.grand_total).toLocaleString() + ').');
    return o.id;
  });

  var final = await pool.query('SELECT * FROM sales_orders WHERE id = $1', [newId]);
  return rowToOrder(pool, final.rows[0]);
}

// kernel.js: handlers['salesOrders.setStatus']
async function setStatus(ctx, id, status) {
  if (!ctx.can('sales.manage')) fail('forbidden', 'Your role does not allow this action (sales.manage).');
  status = V.oneOf(status, ['pending', 'processing', 'delivered', 'cancelled'], 'Status');
  var res = await pool.query('UPDATE sales_orders SET status = $1 WHERE id = $2 RETURNING *', [status, id]);
  if (!res.rows[0]) fail('notfound', 'Sales order not found.');
  var o = res.rows[0];
  await audit(pool, ctx, 'salesorder.status', 'sales_order', o.id, 'Set ' + o.order_no + ' to ' + status + '.');
  return rowToOrder(pool, o);
}

module.exports = { list: list, createFromQuotation: createFromQuotation, setStatus: setStatus, rowToOrder: rowToOrder };
