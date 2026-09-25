var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');
var fileStore = require('../lib/fileStore');

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
    decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note || '',
    paidAt: r.paid_at || null, paidBy: r.paid_by || null,
    receipt: r.receipt_key ? { name: r.receipt_name || 'receipt', type: r.receipt_type || '' } : null
  }, extra || {});
}

// kernel.js: handlers['expenses.list']
async function list(ctx) {
  var all = ctx.can('expense.read.all');
  // With each claim: the requester's department and company, and who
  // decided and who paid it.
  var res = await pool.query(
    'SELECT e.*, emp.first_name, emp.last_name, emp.photo_key AS r_photo, emp.photo_updated_at AS r_photo_at, d.name AS dept_name, c.name AS company_name, ' +
    '  dec.first_name AS d_first, dec.last_name AS d_last, pay.first_name AS p_first, pay.last_name AS p_last FROM expenses e ' +
    'JOIN employees emp ON emp.id = e.requester_id JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id ' +
    'LEFT JOIN employees dec ON dec.id = e.decided_by LEFT JOIN employees pay ON pay.id = e.paid_by ORDER BY e.date DESC, e.created_at DESC'
  );
  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    var ok = all ? await expenseVisible(ctx, r) : r.requester_id === ctx.employee.id;
    if (ok) out.push(rowToExpense(r, {
      requesterName: r.first_name + ' ' + r.last_name, departmentName: r.dept_name, companyName: r.company_name || '',
      requesterPhoto: r.r_photo ? (r.r_photo_at ? new Date(r.r_photo_at).getTime() : 1) : null,
      decidedByName: r.d_first ? r.d_first + ' ' + r.d_last : null, paidByName: r.p_first ? r.p_first + ' ' + r.p_last : null
    }));
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
// Nobody decides their own claim — someone else with expense.approve must.
// A reason can go with the decision; the requester is told it.
async function decide(ctx, id, decision, note) {
  if (!ctx.can('expense.approve')) fail('forbidden', 'Your role does not allow this action (expense.approve).');
  decision = V.oneOf(decision, ['approved', 'rejected'], 'Decision');
  note = String(note || '').trim().slice(0, 300);

  return withTransaction(async function (client) {
    var res = await client.query('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [id]);
    var e = res.rows[0];
    if (!e) fail('notfound', 'Expense not found.');
    if (e.status !== 'pending') fail('conflict', 'That claim has already been decided.');
    if (!(await expenseVisible(ctx, e))) fail('forbidden', 'Outside your scope.');
    if (e.requester_id === ctx.employee.id) fail('forbidden', 'You can\'t decide your own claim. Someone else who approves claims must.');

    var decidedAt = new Date();
    var updated = await client.query('UPDATE expenses SET status = $1, decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $5 RETURNING *', [decision, ctx.employee.id, decidedAt, note, id]);
    await client.query(
      "UPDATE approvals SET status = $1, decided_by = $2, decided_at = $3, comment = $5 WHERE subject_type = 'expense' AND subject_id = $4 AND status = 'pending'",
      [decision, ctx.employee.id, decidedAt, id, note]
    );
    await notify(client, e.requester_id, 'Expense claim ' + decision, e.category + ' claim of GHS ' + Number(e.amount).toLocaleString() + ' was ' + decision + '.' + (note ? ' ' + note : ''), 'expenses');
    await audit(client, ctx, 'expense.decide', 'expense', id, decision.charAt(0).toUpperCase() + decision.slice(1) + ' expense claim (GHS ' + Number(e.amount).toLocaleString() + ').');
    return rowToExpense(updated.rows[0]);
  });
}

// kernel.js: handlers['expenses.update']
//
// The expense.approve branch below doesn't call expenseVisible() (unlike
// list()/decide(), which do) — a security review confirmed this is
// intentional, not an oversight: every role holding expense.approve
// (department_manager, finance_manager, finance_hr_manager,
// general_manager — see referenceData.js's ROLE_DEFS) also holds
// expense.read.all, so there's no employee whose claim an approver
// couldn't already see via list() anyway. If expense.approve is ever
// granted without expense.read.all to some future role, add an
// expenseVisible(ctx, e) check back in here — without it, that would
// silently become the same class of IDOR already fixed elsewhere (see
// documents.service.js/tasks.service.js).
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
// Same "no expenseVisible() check on the approver branch — confirmed
// intentional" note as update() above.
async function remove(ctx, id) {
  var res = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
  var e = res.rows[0];
  if (!e) fail('notfound', 'Expense not found.');
  if (e.requester_id !== ctx.employee.id && !ctx.can('expense.approve')) fail('forbidden', 'You can only delete your own claims.');
  if (e.status !== 'pending') fail('conflict', 'Only a pending claim can be deleted.');

  await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
  await pool.query("DELETE FROM approvals WHERE subject_type = 'expense' AND subject_id = $1", [id]);
  if (e.receipt_key) await fileStore.del(e.receipt_key);
  await audit(pool, ctx, 'expense.delete', 'expense', id, 'Deleted expense claim (GHS ' + Number(e.amount).toLocaleString() + ').');
  return true;
}

// kernel.js: handlers['expenses.markPaid']
// Same "no expenseVisible() check — confirmed intentional" note as
// update()/remove() above (no per-employee scoping check on this
// permission at all, unlike them, but the same role-grant reasoning
// applies: expense.approve always implies expense.read.all today).
async function markPaid(ctx, id) {
  if (!ctx.can('expense.approve')) fail('forbidden', 'Your role does not allow this action (expense.approve).');
  var res = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
  var e = res.rows[0];
  if (!e) fail('notfound', 'Expense not found.');
  if (e.status !== 'approved') fail('conflict', 'Only an approved claim can be marked paid.');

  var updated = await pool.query("UPDATE expenses SET status = 'paid', paid_at = now(), paid_by = $2 WHERE id = $1 RETURNING *", [id, ctx.employee.id]);
  await notify(pool, e.requester_id, 'Expense claim paid', e.category + ' claim of GHS ' + Number(e.amount).toLocaleString() + ' has been paid out.', 'expenses');
  await audit(pool, ctx, 'expense.paid', 'expense', id, 'Marked expense claim paid (GHS ' + Number(e.amount).toLocaleString() + ').');
  return rowToExpense(updated.rows[0]);
}

// The receipt for a claim: its requester adds or replaces it while the
// claim is still being decided; an approver can add one at any time before
// it is paid (a receipt handed in on paper, photographed). Anyone who can
// see the claim can open it.
async function attachReceipt(ctx, id, file) {
  var e = (await pool.query('SELECT * FROM expenses WHERE id = $1', [id])).rows[0];
  if (!e) fail('notfound', 'Expense not found.');
  var own = e.requester_id === ctx.employee.id;
  if (!(own && e.status === 'pending') && !(ctx.can('expense.approve') && e.status !== 'paid' && await expenseVisible(ctx, e))) {
    fail('forbidden', own ? 'The receipt can only be changed while the claim is waiting for a decision.' : 'You can only add a receipt to your own claims.');
  }
  if (!file || !file.buffer || !file.buffer.length) fail('invalid', 'Choose a photo or PDF of the receipt.');
  var key = await fileStore.put(file.originalname, file.buffer, file.mimetype);
  await pool.query('UPDATE expenses SET receipt_key = $1, receipt_name = $2, receipt_type = $3 WHERE id = $4', [key, String(file.originalname || 'receipt').slice(0, 120), file.mimetype || '', id]);
  if (e.receipt_key) await fileStore.del(e.receipt_key);
  await audit(pool, ctx, 'expense.receipt', 'expense', id, 'Attached a receipt to an expense claim (GHS ' + Number(e.amount).toLocaleString() + ').');
  var res = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
  return rowToExpense(res.rows[0]);
}

async function receiptFile(ctx, id) {
  var e = (await pool.query('SELECT * FROM expenses WHERE id = $1', [id])).rows[0];
  if (!e) fail('notfound', 'Expense not found.');
  if (!(await expenseVisible(ctx, e))) fail('forbidden', 'Outside your scope.');
  if (!e.receipt_key) fail('notfound', 'This claim has no receipt.');
  return { key: e.receipt_key, name: e.receipt_name || 'receipt' };
}

module.exports = {
  list: list, create: create, decide: decide, update: update, remove: remove, markPaid: markPaid, expenseVisible: expenseVisible,
  attachReceipt: attachReceipt, receiptFile: receiptFile
};
