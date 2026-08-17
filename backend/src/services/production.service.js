var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

function todayISO() { return new Date().toISOString().slice(0, 10); }

// kernel.js: handlers['production.list']
async function list(ctx) {
  if (!ctx.can('production.read')) fail('forbidden', 'Your role does not allow this action (production.read).');
  var res = await pool.query(
    'SELECT pb.*, rb.batch_no AS raw_batch_no, pr.name AS product_name, s.first_name, s.last_name, ' +
    "(SELECT array_agg(employee_id) FROM production_batch_employees pbe WHERE pbe.production_batch_id = pb.id) AS employee_ids " +
    'FROM production_batches pb ' +
    'LEFT JOIN raw_batches rb ON rb.id = pb.raw_batch_id LEFT JOIN products pr ON pr.id = pb.output_product_id ' +
    'LEFT JOIN employees s ON s.id = pb.supervisor_id ORDER BY pb.date DESC'
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, batchNo: r.batch_no, date: r.date, productionLine: r.production_line, supervisorId: r.supervisor_id,
      employeeIds: r.employee_ids || [], rawBatchId: r.raw_batch_id, outputProductId: r.output_product_id,
      inputQty: Number(r.input_qty), outputQty: Number(r.output_qty), wasteQty: Number(r.waste_qty), rejectedQty: Number(r.rejected_qty),
      notes: r.notes, status: r.status,
      rawBatchNo: r.raw_batch_no || '—', productName: r.product_name || '—',
      supervisorName: r.first_name ? r.first_name + ' ' + r.last_name : '—',
      efficiency: r.input_qty > 0 ? Math.round((r.output_qty / r.input_qty) * 100) : 0
    };
  });
}

// kernel.js: handlers['production.create']
async function create(ctx, p) {
  if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).');

  var rbRes = await pool.query('SELECT * FROM raw_batches WHERE id = $1', [p.rawBatchId]);
  var rb = rbRes.rows[0];
  if (!rb) fail('invalid', 'Choose a raw material batch.');
  var prodRes = await pool.query('SELECT * FROM products WHERE id = $1', [p.outputProductId]);
  var prod = prodRes.rows[0];
  if (!prod) fail('invalid', 'Choose an output product.');

  var inputQty = Math.max(0, Number(p.inputQty) || 0), outputQty = Math.max(0, Number(p.outputQty) || 0);
  var wasteQty = Math.max(0, Number(p.wasteQty) || 0), rejectedQty = Math.max(0, Number(p.rejectedQty) || 0);
  if (inputQty <= 0) fail('invalid', 'Input quantity must be greater than zero.');
  if (inputQty > Number(rb.quantity)) fail('invalid', 'Only ' + rb.quantity + rb.unit + ' remain in batch ' + rb.batch_no + '.');

  var date = V.date(p.date || todayISO(), 'Date');
  var productionLine = V.text(p.productionLine, 'Production line', 60);
  var supervisorId = p.supervisorId || ctx.employee.id;
  var employeeIds = p.employeeIds || [];

  var countRes = await pool.query('SELECT count(*)::int AS n FROM production_batches');
  var batchNo = 'PB-' + new Date().getFullYear() + '-' + String(countRes.rows[0].n + 118).padStart(3, '0');

  // kernel.js hardcodes the output inventory tx to warehouse 'wh_2' (the
  // seeded Finished Goods warehouse) — resolved here by code instead of a
  // fixed id, since generated ids differ per environment.
  var fgWhRes = await pool.query("SELECT id FROM warehouses WHERE code = 'WH-FG' LIMIT 1");
  var outputWarehouseId = fgWhRes.rows[0] ? fgWhRes.rows[0].id : null;

  var batchId = await withTransaction(async function (client) {
    var insertRes = await client.query(
      "INSERT INTO production_batches (batch_no, date, production_line, supervisor_id, raw_batch_id, output_product_id, input_qty, output_qty, waste_qty, rejected_qty, notes, status) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed') RETURNING *",
      [batchNo, date, productionLine, supervisorId, rb.id, prod.id, inputQty, outputQty, wasteQty, rejectedQty, (p.notes || '').trim()]
    );
    var b = insertRes.rows[0];
    for (var i = 0; i < employeeIds.length; i++) {
      await client.query('INSERT INTO production_batch_employees (production_batch_id, employee_id) VALUES ($1,$2)', [b.id, employeeIds[i]]);
    }

    var newQty = Number(rb.quantity) - inputQty;
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

  var result = await list(ctx);
  return result.filter(function (b) { return b.id === batchId; })[0];
}

module.exports = { list: list, create: create };
