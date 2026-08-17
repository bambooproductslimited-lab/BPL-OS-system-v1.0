var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

function todayISO() { return new Date().toISOString().slice(0, 10); }

// Ported from kernel.js's expenseVisible(ctx, e).
async function expenseVisible(ctx, expense) {
  if (expense.requester_id === ctx.employee.id) return true;
  if (ctx.can('expense.read.all')) return true;
  if (ctx.can('expense.approve')) return visibleEmployee(ctx, await fetchEmployeeById(expense.requester_id));
  return false;
}

function rowToExpense(r, extra) {
  return Object.assign({
    id: r.id, requesterId: r.requester_id, departmentId: r.department_id, category: r.category, amount: Number(r.amount),
    date: r.date, description: r.description, projectId: r.project_id, status: r.status, createdAt: r.created_at,
    decidedBy: r.decided_by, decidedAt: r.decided_at
  }, extra || {});
}

// kernel.js: handlers['expenses.list']
async function list(ctx) {
  var all = ctx.can('expense.read.all');
  var res = await pool.query(
    'SELECT e.*, emp.first_name, emp.last_name, d.name AS dept_name FROM expenses e ' +
    'JOIN employees emp ON emp.id = e.requester_id JOIN departments d ON d.id = e.department_id ORDER BY e.created_at DESC'
  );
  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    var ok = all ? await expenseVisible(ctx, r) : r.requester_id === ctx.employee.id;
    if (ok) out.push(rowToExpense(r, { requesterName: r.first_name + ' ' + r.last_name, departmentName: r.dept_name }));
  }
  return out;
}

// kernel.js: handlers['expenses.request']
async function create(ctx, p) {
  if (!ctx.can('expense.request')) fail('forbidden', 'Your role does not allow this action (expense.request).');
  var category = V.text(p.category, 'Category', 40);
  var description = V.text(p.description, 'Description', 300);
  var amount = Math.max(0, Number(p.amount) || 0);
  if (amount <= 0) fail('invalid', 'Amount must be greater than zero.');
  var date = V.date(p.date || todayISO(), 'Date');

  var newId = await withTransaction(async function (client) {
    var res = await client.query(
      "INSERT INTO expenses (requester_id, department_id, category, amount, date, description, project_id, status) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *",
      [ctx.employee.id, ctx.employee.department_id, category, amount, date, description, p.projectId || null]
    );
    var e = res.rows[0];
    await client.query(
      "INSERT INTO approvals (subject_type, subject_id, title, requested_by, assignee_permission, department_id, status, created_at) " +
      "VALUES ('expense', $1, 'Expense claim', $2, 'expense.approve', $3, 'pending', $4)",
      [e.id, ctx.employee.id, ctx.employee.department_id, e.created_at]
    );
    if (ctx.employee.manager_id) {
      await notify(client, ctx.employee.manager_id, 'Expense claim to approve', ctx.employee.first_name + ' ' + ctx.employee.last_name + ' submitted a GHS ' + amount.toLocaleString() + ' claim.', 'approvals');
    }
    await audit(client, ctx, 'expense.request', 'expense', e.id, 'Submitted ' + category + ' expense of GHS ' + amount.toLocaleString() + '.');
    return e.id;
  });

  var res2 = await pool.query('SELECT * FROM expenses WHERE id = $1', [newId]);
  return rowToExpense(res2.rows[0]);
}

// kernel.js: handlers['expenses.decide']
async function decide(ctx, id, decision) {
  if (!ctx.can('expense.approve')) fail('forbidden', 'Your role does not allow this action (expense.approve).');
  decision = V.oneOf(decision, ['approved', 'rejected'], 'Decision');

  return withTransaction(async function (client) {
    var res = await client.query('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [id]);
    var e = res.rows[0];
    if (!e) fail('notfound', 'Expense not found.');
    if (e.status !== 'pending') fail('conflict', 'That claim has already been decided.');
    if (!(await expenseVisible(ctx, e))) fail('forbidden', 'Outside your scope.');

    var decidedAt = new Date();
    var updated = await client.query('UPDATE expenses SET status = $1, decided_by = $2, decided_at = $3 WHERE id = $4 RETURNING *', [decision, ctx.employee.id, decidedAt, id]);
    await client.query(
      "UPDATE approvals SET status = $1, decided_by = $2, decided_at = $3 WHERE subject_type = 'expense' AND subject_id = $4 AND status = 'pending'",
      [decision, ctx.employee.id, decidedAt, id]
    );
    await notify(client, e.requester_id, 'Expense claim ' + decision, e.category + ' claim of GHS ' + Number(e.amount).toLocaleString() + ' was ' + decision + '.', 'expenses');
    await audit(client, ctx, 'expense.decide', 'expense', id, decision.charAt(0).toUpperCase() + decision.slice(1) + ' expense claim (GHS ' + Number(e.amount).toLocaleString() + ').');
    return rowToExpense(updated.rows[0]);
  });
}

// kernel.js: handlers['expenses.update']
async function update(ctx, id, p) {
  var res = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
  var e = res.rows[0];
  if (!e) fail('notfound', 'Expense not found.');
  if (e.requester_id !== ctx.employee.id && !ctx.can('expense.approve')) fail('forbidden', 'You can only edit your own claims.');
  if (e.status !== 'pending') fail('conflict', 'Only a pending claim can be edited.');

  var category = V.text(p.category, 'Category', 40);
  var description = V.text(p.description, 'Description', 300);
  var amount = Math.max(0.01, Number(p.amount) || 0);
  var date = p.date ? V.date(p.date, 'Date') : e.date;

  var updated = await pool.query('UPDATE expenses SET category = $1, amount = $2, date = $3, description = $4 WHERE id = $5 RETURNING *', [category, amount, date, description, id]);
  await audit(pool, ctx, 'expense.update', 'expense', id, 'Updated expense claim (GHS ' + amount.toLocaleString() + ').');
  return rowToExpense(updated.rows[0]);
}

// kernel.js: handlers['expenses.delete']
async function remove(ctx, id) {
  var res = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
  var e = res.rows[0];
  if (!e) fail('notfound', 'Expense not found.');
  if (e.requester_id !== ctx.employee.id && !ctx.can('expense.approve')) fail('forbidden', 'You can only delete your own claims.');
  if (e.status !== 'pending') fail('conflict', 'Only a pending claim can be deleted.');

  await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
  await pool.query("DELETE FROM approvals WHERE subject_type = 'expense' AND subject_id = $1", [id]);
  await audit(pool, ctx, 'expense.delete', 'expense', id, 'Deleted expense claim (GHS ' + Number(e.amount).toLocaleString() + ').');
  return true;
}

// kernel.js: handlers['expenses.markPaid']
async function markPaid(ctx, id) {
  if (!ctx.can('expense.approve')) fail('forbidden', 'Your role does not allow this action (expense.approve).');
  var res = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
  var e = res.rows[0];
  if (!e) fail('notfound', 'Expense not found.');
  if (e.status !== 'approved') fail('conflict', 'Only an approved claim can be marked paid.');

  var updated = await pool.query("UPDATE expenses SET status = 'paid' WHERE id = $1 RETURNING *", [id]);
  await audit(pool, ctx, 'expense.paid', 'expense', id, 'Marked expense claim paid (GHS ' + Number(e.amount).toLocaleString() + ').');
  return rowToExpense(updated.rows[0]);
}

module.exports = { list: list, create: create, decide: decide, update: update, remove: remove, markPaid: markPaid, expenseVisible: expenseVisible };
