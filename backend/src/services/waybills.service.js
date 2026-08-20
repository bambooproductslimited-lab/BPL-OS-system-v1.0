var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { buildLineItems, nextDocNumber, insertLineItems, loadLineItems } = require('../utils/documents');

// Waybills document goods leaving the factory or showroom — a delivery
// note, not a sales document, so (unlike quotations/invoices/estimates)
// there's no pricing or tax on the line items, just description/qty/unit.
// Reuses the same document_line_items table and doc-numbering machinery
// those share (backend/src/utils/documents.js).

async function rowToWaybill(db, r, extra) {
  var items = await loadLineItems(db, 'waybill', r.id);
  return Object.assign({
    id: r.id, waybillNo: r.waybill_no, origin: r.origin, destination: r.destination, customerId: r.customer_id,
    driverName: r.driver_name, vehicleNo: r.vehicle_no, dispatchedBy: r.dispatched_by, receivedBy: r.received_by,
    status: r.status, notes: r.notes, createdAt: r.created_at, deliveredAt: r.delivered_at, items: items.map(function (it) {
      return { description: it.description, qty: it.qty, unit: it.unit };
    })
  }, extra || {});
}

// kernel.js-style handler: waybills.list
async function list(ctx) {
  if (!ctx.can('waybill.read')) fail('forbidden', 'Your role does not allow this action (waybill.read).');
  var res = await pool.query(
    'SELECT w.*, e.first_name, e.last_name, c.name AS customer_name FROM waybills w ' +
    'JOIN employees e ON e.id = w.dispatched_by LEFT JOIN customers c ON c.id = w.customer_id ' +
    'ORDER BY w.created_at DESC'
  );
  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    out.push(await rowToWaybill(pool, r, { dispatchedByName: r.first_name + ' ' + r.last_name, customerName: r.customer_name || '' }));
  }
  return out;
}

// waybills.create
async function create(ctx, p) {
  if (!ctx.can('waybill.manage')) fail('forbidden', 'Your role does not allow this action (waybill.manage).');
  var origin = V.oneOf(p.origin, ['factory', 'showroom'], 'Origin');
  var destination = V.text(p.destination, 'Destination', 160);
  var items = buildLineItems(p.items);

  if (p.customerId) {
    var custRes = await pool.query('SELECT id FROM customers WHERE id = $1', [p.customerId]);
    if (!custRes.rows[0]) fail('invalid', 'Unknown customer.');
  }

  var newId = await withTransaction(async function (client) {
    var waybillNo = await nextDocNumber(client, 'waybill');
    var res = await client.query(
      "INSERT INTO waybills (waybill_no, origin, destination, customer_id, driver_name, vehicle_no, dispatched_by, received_by, status, notes) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dispatched',$9) RETURNING *",
      [waybillNo, origin, destination, p.customerId || null, (p.driverName || '').trim(), (p.vehicleNo || '').trim(), ctx.employee.id, (p.receivedBy || '').trim(), (p.notes || '').trim()]
    );
    var w = res.rows[0];
    await insertLineItems(client, 'waybill', w.id, items);
    await audit(client, ctx, 'waybill.create', 'waybill', w.id, 'Dispatched ' + w.waybill_no + ' from ' + origin + ' to ' + destination + '.');
    return w.id;
  });

  var final = await pool.query('SELECT * FROM waybills WHERE id = $1', [newId]);
  return rowToWaybill(pool, final.rows[0]);
}

// waybills.setStatus
async function setStatus(ctx, id, status) {
  if (!ctx.can('waybill.manage')) fail('forbidden', 'Your role does not allow this action (waybill.manage).');
  status = V.oneOf(status, ['dispatched', 'delivered', 'cancelled'], 'Status');
  var deliveredAt = status === 'delivered' ? new Date() : null;
  var res = await pool.query('UPDATE waybills SET status = $1, delivered_at = $2 WHERE id = $3 RETURNING *', [status, deliveredAt, id]);
  if (!res.rows[0]) fail('notfound', 'Waybill not found.');
  var w = res.rows[0];
  await audit(pool, ctx, 'waybill.status', 'waybill', w.id, 'Set ' + w.waybill_no + ' to ' + status + '.');
  return rowToWaybill(pool, w);
}

module.exports = { list: list, create: create, setStatus: setStatus };
