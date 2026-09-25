var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

// The Approval centre: what is waiting for this person's decision, and what
// was decided lately.
//
// An approval row stands for one request (leave, a purchase, an expense
// claim) and names the permission needed to decide it. A person sees the
// pending ones they hold that permission for, about people inside their
// scope (visibleEmployee), never their own. params.companyId/departmentId
// narrow by the requester's department and its company.
//
// Each entry carries the facts needed to decide without opening another
// screen, as data rather than an English sentence: for leave, the dates,
// the balance left after it and who else in the department is away then;
// for a purchase, the item, quantity, cost, priority and date needed; for
// an expense claim, the category, amount, date and whether a receipt is
// attached.

async function requesterOf(ctx, a, params) {
  var requester = await fetchEmployeeById(a.requested_by);
  if (!(await visibleEmployee(ctx, requester))) return null;
  var e = (await pool.query(
    'SELECT e.id, e.first_name, e.last_name, e.position_title, e.department_id, e.photo_key, e.photo_updated_at, d.name AS department_name, d.company_id, c.name AS company_name ' +
    'FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id WHERE e.id = $1',
    [a.requested_by]
  )).rows[0];
  if (params && params.companyId && (!e || e.company_id !== params.companyId)) return null;
  if (params && params.departmentId && (!e || e.department_id !== params.departmentId)) return null;
  return e || null;
}

function baseEntry(a, e) {
  return {
    id: a.id, subjectId: a.subject_id, subjectType: a.subject_type, title: a.title, createdAt: a.created_at, status: a.status,
    requesterId: e ? e.id : null, requesterName: e ? e.first_name + ' ' + e.last_name : '—', requesterRole: e ? e.position_title || '' : '',
    requesterPhoto: e && e.photo_key ? (e.photo_updated_at ? new Date(e.photo_updated_at).getTime() : 1) : null,
    department: e ? e.department_name || '—' : '—', company: e ? e.company_name || '—' : '—',
    reason: '', detail: '', facts: null, amount: null, currency: null
  };
}

async function leaveFacts(entry, e, id) {
  var lr = (await pool.query(
    'SELECT lr.*, lt.name AS type_name, lt.paid FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.id = $1', [id])).rows[0];
  if (!lr) return;
  var year = Number(String(lr.start_date).slice(0, 4));
  var bal = (await pool.query('SELECT entitled, used FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3', [lr.employee_id, lr.leave_type_id, year])).rows[0];
  // Others in the same department off (approved) or asking (pending) on any of these days.
  var clash = e && e.department_id ? (await pool.query(
    "SELECT e.first_name || ' ' || e.last_name AS name, lr.status, lr.start_date, lr.end_date FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id " +
    "WHERE e.department_id = $1 AND lr.employee_id <> $2 AND lr.status IN ('approved', 'pending') AND lr.start_date <= $4 AND lr.end_date >= $3 ORDER BY lr.start_date",
    [e.department_id, lr.employee_id, lr.start_date, lr.end_date])).rows : [];
  entry.reason = lr.reason || '';
  entry.detail = lr.days + ' day(s) · ' + lr.type_name + ' · ' + lr.start_date + ' → ' + lr.end_date;
  entry.facts = {
    days: lr.days, leaveType: lr.type_name, paid: lr.paid, startDate: lr.start_date, endDate: lr.end_date,
    balance: bal ? { entitled: Number(bal.entitled), used: Number(bal.used), leftAfter: Number(bal.entitled) - Number(bal.used) - lr.days } : null,
    awayThen: clash.map(function (c) { return { name: c.name, status: c.status, startDate: c.start_date, endDate: c.end_date }; })
  };
}

async function procurementFacts(entry, id) {
  var pr = (await pool.query('SELECT * FROM procurement_requests WHERE id = $1', [id])).rows[0];
  if (!pr) return;
  entry.reason = pr.reason || '';
  entry.detail = pr.item + ' × ' + Number(pr.quantity) + ' · est. GHS ' + Number(pr.estimated_price).toLocaleString();
  entry.amount = Number(pr.estimated_price);
  entry.currency = 'GHS';
  entry.facts = { item: pr.item, quantity: Number(pr.quantity), estimatedPrice: Number(pr.estimated_price), priority: pr.priority, requiredDate: pr.required_date || null };
}

async function expenseFacts(entry, id) {
  var ex = (await pool.query('SELECT * FROM expenses WHERE id = $1', [id])).rows[0];
  if (!ex) return;
  entry.reason = ex.description || '';
  entry.detail = ex.category + ' · GHS ' + Number(ex.amount).toLocaleString() + ' · ' + ex.date;
  entry.amount = Number(ex.amount);
  entry.currency = 'GHS';
  entry.facts = { category: ex.category, amount: Number(ex.amount), date: ex.date, receipt: ex.receipt_key ? { name: ex.receipt_name || 'receipt', type: ex.receipt_type || '' } : null };
}

async function withFacts(entry, e, a) {
  if (a.subject_type === 'leave_request') await leaveFacts(entry, e, a.subject_id);
  else if (a.subject_type === 'procurement_request') await procurementFacts(entry, a.subject_id);
  else if (a.subject_type === 'expense') await expenseFacts(entry, a.subject_id);
  return entry;
}

// kernel.js: handlers['approvals.queue']
async function queue(ctx, params) {
  if (!ctx.can('approval.act')) fail('forbidden', 'Your role does not allow this action (approval.act).');
  var res = await pool.query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at");
  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    var a = res.rows[i];
    if (!ctx.can(a.assignee_permission)) continue;
    if (a.requested_by === ctx.employee.id) continue;
    var e = await requesterOf(ctx, a, params);
    if (!e) continue;
    out.push(await withFacts(baseEntry(a, e), e, a));
  }
  return out;
}

// What was decided in the last 90 days among the requests this person could
// decide (same permission and scope as the queue), newest first: who
// decided, how, the note given and how long it waited.
async function history(ctx, params) {
  if (!ctx.can('approval.act')) fail('forbidden', 'Your role does not allow this action (approval.act).');
  var res = await pool.query(
    "SELECT a.*, d.first_name || ' ' || d.last_name AS decided_by_name FROM approvals a LEFT JOIN employees d ON d.id = a.decided_by " +
    "WHERE a.status IN ('approved', 'rejected') AND a.decided_at >= now() - interval '90 days' ORDER BY a.decided_at DESC");
  var out = [];
  for (var i = 0; i < res.rows.length && out.length < 60; i++) {
    var a = res.rows[i];
    if (!ctx.can(a.assignee_permission)) continue;
    if (a.requested_by === ctx.employee.id) continue;
    var e = await requesterOf(ctx, a, params);
    if (!e) continue;
    var entry = await withFacts(baseEntry(a, e), e, a);
    entry.decidedAt = a.decided_at;
    entry.decidedById = a.decided_by;
    entry.decidedByName = a.decided_by_name || '—';
    entry.byMe = a.decided_by === ctx.employee.id;
    entry.note = a.comment || '';
    entry.hoursToDecide = Math.max(0, Math.round((new Date(a.decided_at) - new Date(a.created_at)) / 36e5));
    out.push(entry);
  }
  return out;
}

module.exports = { queue: queue, history: history };
