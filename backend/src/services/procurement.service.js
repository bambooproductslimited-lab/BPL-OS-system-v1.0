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

// A request's life: pending → approved or rejected (or cancelled by the
// requester while pending) → ordered (supplier, actual cost) → received.
// Migration 0086 added everything after the decision.
function rowToRequest(r, extra) {
  return Object.assign({
    id: r.id, requesterId: r.requester_id, departmentId: r.department_id, item: r.item, quantity: Number(r.quantity),
    estimatedPrice: Number(r.estimated_price), reason: r.reason, requiredDate: r.required_date, priority: r.priority,
    status: r.status, createdAt: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at,
    decisionNote: r.decision_note || '', supplierId: r.supplier_id || null, supplierName: r.supplier_name || '',
    actualCost: r.actual_cost === null || r.actual_cost === undefined ? null : Number(r.actual_cost),
    orderedAt: r.ordered_at || null, receivedAt: r.received_at || null
  }, extra || {});
}

function name(first, last) { return first ? first + ' ' + last : null; }

// kernel.js: handlers['procurement.list']
async function list(ctx) {
  var res = await pool.query(
    'SELECT pr.*, e.first_name, e.last_name, e.photo_key, e.photo_updated_at, d.name AS dept_name, c.code AS company_code, ' +
    'dc.first_name AS dc_first, dc.last_name AS dc_last, ob.first_name AS ob_first, ob.last_name AS ob_last, ' +
    'rb.first_name AS rb_first, rb.last_name AS rb_last, s.name AS sup_name, s.phone AS sup_phone ' +
    'FROM procurement_requests pr JOIN employees e ON e.id = pr.requester_id ' +
    'LEFT JOIN departments d ON d.id = pr.department_id LEFT JOIN companies c ON c.id = d.company_id ' +
    'LEFT JOIN employees dc ON dc.id = pr.decided_by LEFT JOIN employees ob ON ob.id = pr.ordered_by ' +
    'LEFT JOIN employees rb ON rb.id = pr.received_by LEFT JOIN suppliers s ON s.id = pr.supplier_id ' +
    'ORDER BY pr.created_at DESC'
  );
  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    if (await procurementVisible(ctx, r)) {
      out.push(rowToRequest(r, {
        requesterName: r.first_name + ' ' + r.last_name, departmentName: r.dept_name || '—', companyCode: r.company_code || null,
        requesterPhoto: r.photo_key && r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : null,
        deciderName: name(r.dc_first, r.dc_last), orderedByName: name(r.ob_first, r.ob_last), receivedByName: name(r.rb_first, r.rb_last),
        supplierName: r.sup_name || r.supplier_name || '', supplierPhone: r.sup_phone || '',
        mine: r.requester_id === ctx.employee.id
      }));
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
async function decide(ctx, id, decision, note) {
  if (!ctx.can('procurement.approve')) fail('forbidden', 'Your role does not allow this action (procurement.approve).');
  decision = V.oneOf(decision, ['approved', 'rejected'], 'Decision');
  note = String(note || '').trim().slice(0, 300);

  return withTransaction(async function (client) {
    var res = await client.query('SELECT * FROM procurement_requests WHERE id = $1 FOR UPDATE', [id]);
    var r = res.rows[0];
    if (!r) fail('notfound', 'Request not found.');
    if (r.status !== 'pending') fail('conflict', 'That request has already been decided.');
    if (!(await procurementVisible(ctx, r))) fail('forbidden', 'Outside your scope.');
    if (r.requester_id === ctx.employee.id) fail('forbidden', 'You cannot decide your own request.');

    var decidedAt = new Date();
    var updated = await client.query(
      'UPDATE procurement_requests SET status = $1, decided_by = $2, decided_at = $3, decision_note = $5 WHERE id = $4 RETURNING *',
      [decision, ctx.employee.id, decidedAt, id, note]
    );
    await client.query(
      "UPDATE approvals SET status = $1, decided_by = $2, decided_at = $3, comment = $5 WHERE subject_type = 'procurement_request' AND subject_id = $4 AND status = 'pending'",
      [decision, ctx.employee.id, decidedAt, id, note]
    );
    await notify(client, r.requester_id, 'Purchase request ' + decision, r.item + ' was ' + decision + '.' + (note ? ' ' + note : ''), 'procurement');
    await audit(client, ctx, 'procurement.decide', 'procurement_request', id, decision.charAt(0).toUpperCase() + decision.slice(1) + ' request for ' + r.item + '.');
    return rowToRequest(updated.rows[0]);
  });
}

// The requester takes back a request nobody has decided yet (or an
// approver withdraws it).
async function cancel(ctx, id) {
  if (!ctx.can('procurement.request') && !ctx.can('procurement.approve')) fail('forbidden', 'Your role does not allow this action (procurement.request).');
  return withTransaction(async function (client) {
    var r = (await client.query('SELECT * FROM procurement_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) fail('notfound', 'Request not found.');
    if (r.requester_id !== ctx.employee.id && !(ctx.can('procurement.approve') && await procurementVisible(ctx, r))) fail('forbidden', 'Only the person who asked can cancel this request.');
    if (r.status !== 'pending') fail('conflict', 'Only a request still waiting for a decision can be cancelled.');
    var updated = (await client.query("UPDATE procurement_requests SET status = 'cancelled' WHERE id = $1 RETURNING *", [id])).rows[0];
    await client.query("UPDATE approvals SET status = 'cancelled', decided_by = $2, decided_at = now() WHERE subject_type = 'procurement_request' AND subject_id = $1 AND status = 'pending'", [id, ctx.employee.id]);
    await audit(client, ctx, 'procurement.cancel', 'procurement_request', id, 'Cancelled the request for ' + r.item + '.');
    return rowToRequest(updated);
  });
}

async function loadForBuyer(client, ctx, id) {
  if (!ctx.can('procurement.approve')) fail('forbidden', 'Your role does not allow this action (procurement.approve).');
  var r = (await client.query('SELECT * FROM procurement_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!r) fail('notfound', 'Request not found.');
  if (!(await procurementVisible(ctx, r))) fail('forbidden', 'Outside your scope.');
  return r;
}

// An approved request has been ordered: who from and what it really cost.
async function markOrdered(ctx, id, p) {
  p = p || {};
  return withTransaction(async function (client) {
    var r = await loadForBuyer(client, ctx, id);
    if (r.status !== 'approved') fail('conflict', 'Only an approved request can be ordered.');
    var supplierId = p.supplierId || null;
    if (supplierId && !(await client.query('SELECT 1 FROM suppliers WHERE id = $1', [supplierId])).rows[0]) fail('invalid', 'Unknown supplier.');
    var supplierName = String(p.supplierName || '').trim().slice(0, 120);
    var cost = p.actualCost === undefined || p.actualCost === null || p.actualCost === '' ? null : Number(p.actualCost);
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) fail('invalid', 'The cost must be a number, 0 or more.');
    var updated = (await client.query(
      "UPDATE procurement_requests SET status = 'ordered', supplier_id = $2, supplier_name = $3, actual_cost = $4, ordered_at = now(), ordered_by = $5 WHERE id = $1 RETURNING *",
      [id, supplierId, supplierName, cost, ctx.employee.id]
    )).rows[0];
    await notify(client, r.requester_id, 'Purchase ordered', r.item + ' has been ordered.', 'procurement');
    await audit(client, ctx, 'procurement.order', 'procurement_request', id, 'Ordered ' + r.item + (cost !== null ? ' for ' + cost : '') + '.');
    return rowToRequest(updated);
  });
}

// It has arrived. The cost can be corrected here if the invoice differed.
async function markReceived(ctx, id, p) {
  p = p || {};
  return withTransaction(async function (client) {
    var r = await loadForBuyer(client, ctx, id);
    if (r.status !== 'ordered' && r.status !== 'approved') fail('conflict', 'Only an approved or ordered request can be received.');
    var cost = p.actualCost === undefined || p.actualCost === null || p.actualCost === '' ? r.actual_cost : Number(p.actualCost);
    if (cost !== null && (!Number.isFinite(Number(cost)) || Number(cost) < 0)) fail('invalid', 'The cost must be a number, 0 or more.');
    var updated = (await client.query(
      "UPDATE procurement_requests SET status = 'received', actual_cost = $2, received_at = now(), received_by = $3, ordered_at = coalesce(ordered_at, now()), ordered_by = coalesce(ordered_by, $3) WHERE id = $1 RETURNING *",
      [id, cost, ctx.employee.id]
    )).rows[0];
    await notify(client, r.requester_id, 'Purchase received', r.item + ' has arrived.', 'procurement');
    await audit(client, ctx, 'procurement.receive', 'procurement_request', id, 'Received ' + r.item + '.');
    return rowToRequest(updated);
  });
}

module.exports = {
  list: list, create: create, decide: decide, cancel: cancel, markOrdered: markOrdered, markReceived: markReceived,
  procurementVisible: procurementVisible
};
