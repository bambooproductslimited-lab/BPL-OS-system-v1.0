var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// Production batches: raw bamboo from one raw batch turned into a product.
// Recording one takes the input from the raw batch, adds the output to the
// product's stock and writes both stock movements (the daily stock sheet
// reads the output). A record entered by mistake is cancelled (migration
// 0084): the bamboo goes back to its batch and the output comes off stock.

function todayISO() { return new Date().toISOString().slice(0, 10); }
function num(v) { return v === null || v === undefined ? 0 : Number(v); }

var SELECT =
  'SELECT pb.*, rb.batch_no AS raw_batch_no, rb.species AS raw_species, rb.unit AS raw_unit, rb.cost AS raw_cost, rb.received_qty AS raw_received, ' +
  'pr.name AS product_name, pr.sku AS product_sku, pr.unit AS product_unit, pr.cost_price AS product_cost, ' +
  's.first_name, s.last_name, s.photo_key AS s_photo_key, s.photo_updated_at AS s_photo_at, ' +
  'cb.first_name AS cb_first, cb.last_name AS cb_last, ' +
  "(SELECT coalesce(json_agg(json_build_object('id', e.id, 'name', e.first_name || ' ' || e.last_name, " +
  "'photo', CASE WHEN e.photo_key IS NOT NULL AND e.photo_updated_at IS NOT NULL THEN floor(extract(epoch FROM e.photo_updated_at) * 1000) END) ORDER BY e.first_name), '[]') " +
  'FROM production_batch_employees pbe JOIN employees e ON e.id = pbe.employee_id WHERE pbe.production_batch_id = pb.id) AS workers ' +
  'FROM production_batches pb ' +
  'LEFT JOIN raw_batches rb ON rb.id = pb.raw_batch_id LEFT JOIN products pr ON pr.id = pb.output_product_id ' +
  'LEFT JOIN employees s ON s.id = pb.supervisor_id LEFT JOIN employees cb ON cb.id = pb.cancelled_by ';

function rowToBatch(r) {
  var input = num(r.input_qty), output = num(r.output_qty), waste = num(r.waste_qty), rejected = num(r.rejected_qty);
  var rawCost = num(r.raw_received) > 0 ? Math.round((num(r.raw_cost) / num(r.raw_received)) * input * 100) / 100 : null;
  return {
    id: r.id, batchNo: r.batch_no, date: r.date, productionLine: r.production_line, supervisorId: r.supervisor_id,
    workers: (r.workers || []).map(function (w) { return { id: w.id, name: w.name, photo: w.photo === null ? null : Number(w.photo) }; }),
    employeeIds: (r.workers || []).map(function (w) { return w.id; }),
    rawBatchId: r.raw_batch_id, outputProductId: r.output_product_id,
    inputQty: input, outputQty: output, wasteQty: waste, rejectedQty: rejected,
    notes: r.notes, status: r.status,
    rawBatchNo: r.raw_batch_no || '—', rawSpecies: r.raw_species || '', rawUnit: r.raw_unit || 'kg',
    productName: r.product_name || '—', productSku: r.product_sku || '', productUnit: r.product_unit || '',
    supervisorName: r.first_name ? r.first_name + ' ' + r.last_name : '—',
    supervisorPhoto: r.s_photo_key && r.s_photo_at ? new Date(r.s_photo_at).getTime() : null,
    // Output per unit of raw bamboo (e.g. planks per kg), waste as a share of
    // the input, and rejects as a share of everything made.
    yieldPerUnit: input > 0 ? Math.round((output / input) * 1000) / 1000 : 0,
    wastePct: input > 0 ? Math.round((waste / input) * 1000) / 10 : 0,
    rejectPct: output + rejected > 0 ? Math.round((rejected / (output + rejected)) * 1000) / 10 : 0,
    efficiency: input > 0 ? Math.round((output / input) * 100) : 0,
    rawCost: rawCost, outputValue: Math.round(output * num(r.product_cost) * 100) / 100,
    createdAt: r.created_at,
    cancelledAt: r.cancelled_at || null, cancelReason: r.cancel_reason || '',
    cancelledByName: r.cb_first ? r.cb_first + ' ' + r.cb_last : null
  };
}

// kernel.js: handlers['production.list']
async function list(ctx) {
  if (!ctx.can('production.read')) fail('forbidden', 'Your role does not allow this action (production.read).');
  var res = await pool.query(SELECT + 'ORDER BY pb.date DESC, pb.created_at DESC');
  return res.rows.map(rowToBatch);
}

async function get(ctx, id) {
  if (!ctx.can('production.read')) fail('forbidden', 'Your role does not allow this action (production.read).');
  var r = (await pool.query(SELECT + 'WHERE pb.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Production batch not found.');
  return rowToBatch(r);
}

async function checkPeople(ids) {
  if (!ids.length) return;
  var found = await pool.query('SELECT count(*)::int AS n FROM employees WHERE id = ANY($1::uuid[])', [ids]);
  if (found.rows[0].n !== ids.length) fail('invalid', 'One of the people chosen is not on the staff list.');
}

// kernel.js: handlers['production.create']
async function create(ctx, p) {
  if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).');

  var prodRes = await pool.query('SELECT * FROM products WHERE id = $1', [p.outputProductId || null]);
  var prod = prodRes.rows[0];
  if (!prod) fail('invalid', 'Choose an output product.');

  var inputQty = Math.max(0, Number(p.inputQty) || 0), outputQty = Math.max(0, Number(p.outputQty) || 0);
  var wasteQty = Math.max(0, Number(p.wasteQty) || 0), rejectedQty = Math.max(0, Number(p.rejectedQty) || 0);
  if (inputQty <= 0) fail('invalid', 'Input quantity must be greater than zero.');
  if (wasteQty > inputQty) fail('invalid', 'Waste cannot be more than the raw bamboo used.');

  var date = V.date(p.date || todayISO(), 'Date');
  if (date > todayISO()) fail('invalid', 'The production date cannot be in the future.');
  var productionLine = V.text(p.productionLine || 'Weaving Line', 'Production line', 60);
  var supervisorId = p.supervisorId || ctx.employee.id;
  var employeeIds = Array.from(new Set((Array.isArray(p.employeeIds) ? p.employeeIds : []).filter(Boolean)));
  await checkPeople(Array.from(new Set([supervisorId].concat(employeeIds))));
  var notes = String(p.notes || '').trim().slice(0, 1000);

  var year = date.slice(0, 4);

  // kernel.js hardcodes the output inventory tx to warehouse 'wh_2' (the
  // seeded Finished Goods warehouse) — resolved here by code instead of a
  // fixed id, since generated ids differ per environment.
  var fgWhRes = await pool.query("SELECT id FROM warehouses WHERE code = 'WH-FG' LIMIT 1");
  var outputWarehouseId = fgWhRes.rows[0] ? fgWhRes.rows[0].id : null;

  var batchId = await withTransaction(async function (client) {
    // Locked so two people recording from the same batch at once cannot
    // both take the last of it.
    var rb = (await client.query('SELECT * FROM raw_batches WHERE id = $1 FOR UPDATE', [p.rawBatchId || null])).rows[0];
    if (!rb) fail('invalid', 'Choose a raw material batch.');
    if (inputQty > Number(rb.quantity)) fail('invalid', 'Only ' + Number(rb.quantity) + rb.unit + ' remain in batch ' + rb.batch_no + '.');

    var countRes = await client.query(
      "SELECT coalesce(max(substring(batch_no from '^PB-' || $1 || '-(\\d+)$')::int), 117) AS n FROM production_batches", [year]
    );
    var batchNo = 'PB-' + year + '-' + String(countRes.rows[0].n + 1).padStart(3, '0');

    var insertRes = await client.query(
      "INSERT INTO production_batches (batch_no, date, production_line, supervisor_id, raw_batch_id, output_product_id, input_qty, output_qty, waste_qty, rejected_qty, notes, status) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed') RETURNING *",
      [batchNo, date, productionLine, supervisorId, rb.id, prod.id, inputQty, outputQty, wasteQty, rejectedQty, notes]
    );
    var b = insertRes.rows[0];
    for (var i = 0; i < employeeIds.length; i++) {
      await client.query('INSERT INTO production_batch_employees (production_batch_id, employee_id) VALUES ($1,$2)', [b.id, employeeIds[i]]);
    }

    var newQty = Math.round((Number(rb.quantity) - inputQty) * 100) / 100;
    await client.query('UPDATE raw_batches SET quantity = $1, status = $2 WHERE id = $3', [newQty, newQty <= 0 ? 'depleted' : rb.status, rb.id]);
    await client.query('UPDATE products SET current_stock = current_stock + $1 WHERE id = $2', [outputQty, prod.id]);

    await client.query(
      "INSERT INTO inventory_tx (item_type, item_id, warehouse_id, type, qty, date, user_id, reference) VALUES ('raw',$1,$2,'production_consumption',$3,$4,$5,$6)",
      [rb.id, rb.warehouse_id, -inputQty, date, ctx.employee.id, batchNo]
    );
    await client.query(
      "INSERT INTO inventory_tx (item_type, item_id, warehouse_id, type, qty, date, user_id, reference) VALUES ('product',$1,$2,'production_output',$3,$4,$5,$6)",
      [prod.id, outputWarehouseId, outputQty, date, ctx.employee.id, batchNo]
    );

    await audit(client, ctx, 'production.create', 'production_batch', b.id,
      'Recorded batch ' + b.batch_no + ': ' + inputQty + rb.unit + ' → ' + outputQty + ' ' + prod.unit + '(s), ' + wasteQty + rb.unit + ' waste.');
    return b.id;
  });

  return get(ctx, batchId);
}

// Undo a production record entered by mistake. The raw bamboo goes back to
// its batch and the output comes off the product's stock, on the batch's own
// date so the stock sheet for that day is corrected too.
async function cancel(ctx, id, p) {
  if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).');
  var reason = V.text(p && p.reason, 'Reason', 200);
  await withTransaction(async function (client) {
    var b = (await client.query('SELECT * FROM production_batches WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!b) fail('notfound', 'Production batch not found.');
    if (b.status === 'cancelled') fail('conflict', 'Batch ' + b.batch_no + ' is already cancelled.');
    var prod = b.output_product_id ? (await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [b.output_product_id])).rows[0] : null;
    if (prod && Number(prod.current_stock) < Number(b.output_qty)) {
      fail('conflict', 'Only ' + Number(prod.current_stock) + ' ' + prod.unit + '(s) of ' + prod.name + ' are in stock, so the ' + Number(b.output_qty) + ' made in this batch cannot be taken back off.');
    }
    var rb = b.raw_batch_id ? (await client.query('SELECT * FROM raw_batches WHERE id = $1 FOR UPDATE', [b.raw_batch_id])).rows[0] : null;

    await client.query("UPDATE production_batches SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1", [id, ctx.employee.id, reason]);
    if (rb) {
      await client.query("UPDATE raw_batches SET quantity = quantity + $1, status = CASE WHEN status IN ('depleted', 'consumed') THEN 'in_stock' ELSE status END WHERE id = $2", [b.input_qty, rb.id]);
      await client.query(
        "INSERT INTO inventory_tx (item_type, item_id, warehouse_id, type, qty, date, user_id, reference, notes) VALUES ('raw',$1,$2,'production_consumption',$3,$4,$5,$6,$7)",
        [rb.id, rb.warehouse_id, b.input_qty, b.date, ctx.employee.id, b.batch_no, 'Cancelled: ' + reason]
      );
    }
    if (prod) {
      await client.query('UPDATE products SET current_stock = current_stock - $1 WHERE id = $2', [b.output_qty, prod.id]);
      await client.query(
        "INSERT INTO inventory_tx (item_type, item_id, warehouse_id, type, qty, date, user_id, reference, notes) VALUES ('product', $1, " +
        "(SELECT warehouse_id FROM inventory_tx WHERE reference = $5 AND item_type = 'product' AND type = 'production_output' AND qty > 0 LIMIT 1), " +
        "'production_output', $2, $3, $4, $5, $6)",
        [prod.id, -Number(b.output_qty), b.date, ctx.employee.id, b.batch_no, 'Cancelled: ' + reason]
      );
    }
    await audit(client, ctx, 'production.cancel', 'production_batch', id, 'Cancelled batch ' + b.batch_no + ': ' + reason);
  });
  return get(ctx, id);
}

module.exports = { list: list, get: get, create: create, cancel: cancel };
