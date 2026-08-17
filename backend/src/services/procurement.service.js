var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

function todayISO() { return new Date().toISOString().slice(0, 10); }

// Ported from kernel.js's procurementVisible(ctx, r).
async function procurementVisible(ctx, req) {
  if (req.requester_id === ctx.employee.id) return true;
  if (ctx.can('procurement.read.all')) return true;
  if (ctx.can('procurement.approve')) return visibleEmployee(ctx, await fetchEmployeeById(req.requester_id));
  return false;
}

function rowToRequest(r, extra) {
  return Object.assign({
    id: r.id, requesterId: r.requester_id, departmentId: r.department_id, item: r.item, quantity: Number(r.quantity),
    estimatedPrice: Number(r.estimated_price), reason: r.reason, requiredDate: r.required_date, priority: r.priority,
    status: r.status, createdAt: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at
  }, extra || {});
}

// kernel.js: handlers['procurement.list']
async function list(ctx) {
  var res = await pool.query(
    'SELECT pr.*, e.first_name, e.last_name, d.name AS dept_name FROM procurement_requests pr ' +
    'JOIN employees e ON e.id = pr.requester_id JOIN departments d ON d.id = pr.department_id ' +
    'ORDER BY pr.created_at DESC'
  );
  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    if (await procurementVisible(ctx, r)) {
      out.push(rowToRequest(r, { requesterName: r.first_name + ' ' + r.last_name, departmentName: r.dept_name }));
    }
  }
  return out;
}

// kernel.js: handlers['procurement.request']
async function create(ctx, p) {
  if (!ctx.can('procurement.request')) fail('forbidden', 'Your role does not allow this action (procurement.request).');
  var item = V.text(p.item, 'Item', 100);
  var reason = V.text(p.reason, 'Reason', 300);
  var requiredDate = V.date(p.requiredDate || todayISO(), 'Required date');
  var priority = V.oneOf(p.priority || 'medium', ['low', 'medium', 'high'], 'Priority');
  var quantity = Math.max(1, Number(p.quantity) || 1);
  var estimatedPrice = Math.max(0, Number(p.estimatedPrice) || 0);

  var newId = await withTransaction(async function (client) {
    var res = await client.query(
      "INSERT INTO procurement_requests (requester_id, department_id, item, quantity, estimated_price, reason, required_date, priority, status) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *",
      [ctx.employee.id, ctx.employee.department_id, item, quantity, estimatedPrice, reason, requiredDate, priority]
    );
    var r = res.rows[0];
    await client.query(
      "INSERT INTO approvals (subject_type, subject_id, title, requested_by, assignee_permission, department_id, status, created_at) " +
      "VALUES ('procurement_request', $1, 'Purchase request', $2, 'procurement.approve', $3, 'pending', $4)",
      [r.id, ctx.employee.id, ctx.employee.department_id, r.created_at]
    );
    if (ctx.employee.manager_id) {
      await notify(client, ctx.employee.manager_id, 'Purchase request to approve', ctx.employee.first_name + ' ' + ctx.employee.last_name + ' requested ' + item + '.', 'approvals');
    }
    await audit(client, ctx, 'procurement.request', 'procurement_request', r.id, 'Requested ' + item + ' (qty ' + quantity + ').');
    return r.id;
  });

  var res2 = await pool.query('SELECT * FROM procurement_requests WHERE id = $1', [newId]);
  return rowToRequest(res2.rows[0]);
}

// kernel.js: handlers['procurement.decide']
async function decide(ctx, id, decision) {
  if (!ctx.can('procurement.approve')) fail('forbidden', 'Your role does not allow this action (procurement.approve).');
  decision = V.oneOf(decision, ['approved', 'rejected'], 'Decision');

  return withTransaction(async function (client) {
    var res = await client.query('SELECT * FROM procurement_requests WHERE id = $1 FOR UPDATE', [id]);
    var r = res.rows[0];
    if (!r) fail('notfound', 'Request not found.');
    if (r.status !== 'pending') fail('conflict', 'That request has already been decided.');
    if (!(await procurementVisible(ctx, r))) fail('forbidden', 'Outside your scope.');

    var decidedAt = new Date();
    var updated = await client.query(
      'UPDATE procurement_requests SET status = $1, decided_by = $2, decided_at = $3 WHERE id = $4 RETURNING *',
      [decision, ctx.employee.id, decidedAt, id]
    );
    await client.query(
      "UPDATE approvals SET status = $1, decided_by = $2, decided_at = $3 WHERE subject_type = 'procurement_request' AND subject_id = $4 AND status = 'pending'",
      [decision, ctx.employee.id, decidedAt, id]
    );
    await notify(client, r.requester_id, 'Purchase request ' + decision, r.item + ' was ' + decision + '.', 'procurement');
    await audit(client, ctx, 'procurement.decide', 'procurement_request', id, decision.charAt(0).toUpperCase() + decision.slice(1) + ' request for ' + r.item + '.');
    return rowToRequest(updated.rows[0]);
  });
}

module.exports = { list: list, create: create, decide: decide, procurementVisible: procurementVisible };
