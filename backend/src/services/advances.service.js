var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Salary advances (migration 0197). Anyone asks for one in My space — how
// much, over how many months, why — within the company's rules
// (settings.advances: on or off, at most a share of a month's pay, at most
// so many months, one at a time). Finance (advance.manage) approves it,
// perhaps for less or over more months, or declines it with a reason; then
// pays it out. It is repaid by an instalment taken off each payslip
// (payroll.service.js: worked out when the run is made, recorded when the
// run is paid), or in cash.

var METHODS = ['bank', 'mobile_money', 'cash'];
var DEFAULTS = { open: true, maxPercent: 50, maxMonths: 3 };
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function money(n) { return 'GHS ' + round2(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function ref(n) { return 'SA-' + String(n).padStart(4, '0'); }
function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }

async function settingsOf() {
  var s = ((await pool.query('SELECT advances FROM settings WHERE id = 1')).rows[0] || {}).advances || {};
  return {
    open: s.open === undefined ? DEFAULTS.open : !!s.open,
    maxPercent: Number(s.maxPercent) > 0 && Number(s.maxPercent) <= 100 ? Number(s.maxPercent) : DEFAULTS.maxPercent,
    maxMonths: Number(s.maxMonths) >= 1 && Number(s.maxMonths) <= 12 ? Math.round(Number(s.maxMonths)) : DEFAULTS.maxMonths
  };
}

// A month's pay, about: basic and allowance, or 22 days at the daily rate.
function monthlyPay(e) {
  if (e.basic_salary != null) return round2(Number(e.basic_salary) + Number(e.allowance || 0));
  return round2(Number(e.daily_rate || 0) * 22);
}

var SELECT = 'SELECT a.*, e.first_name, e.last_name, e.code AS emp_code, e.position_title, e.basic_salary, e.allowance, e.daily_rate, c.name AS company_name, ' +
  'db.first_name AS db_first, db.last_name AS db_last, pb.first_name AS pb_first, pb.last_name AS pb_last FROM salary_advances a JOIN employees e ON e.id = a.employee_id ' +
  'LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id LEFT JOIN employees db ON db.id = a.decided_by LEFT JOIN employees pb ON pb.id = a.paid_by ';

async function repaymentsOf(ids) {
  var out = new Map();
  if (!ids.length) return out;
  (await pool.query(
    'SELECT r.*, pr.run_no FROM salary_advance_repayments r LEFT JOIN pay_runs pr ON pr.id = r.pay_run_id WHERE r.advance_id = ANY($1::uuid[]) ORDER BY r.created_at', [ids])).rows.forEach(function (r) {
    var l = out.get(r.advance_id) || [];
    l.push({ amount: round2(r.amount), kind: r.kind, runNo: r.run_no || null, note: r.note, at: r.created_at });
    out.set(r.advance_id, l);
  });
  return out;
}
function advanceOut(r, reps) {
  var left = r.status === 'paid' ? round2(Number(r.amount) - Number(r.repaid)) : r.status === 'repaid' ? 0 : round2(r.amount);
  return {
    id: r.id, ref: ref(r.number), employee: { id: r.employee_id, name: nameOf(r.first_name, r.last_name), code: r.emp_code, position: r.position_title || '', company: r.company_name || '', monthlyPay: monthlyPay(r) },
    amount: round2(r.amount), months: r.months, instalment: round2(r.instalment), reason: r.reason, status: r.status, repaid: round2(r.repaid), left: left,
    decidedBy: nameOf(r.db_first, r.db_last), decidedAt: r.decided_at, declineReason: r.decline_reason || '',
    paidAt: dayText(r.paid_at), paidMethod: r.paid_method, paidReference: r.paid_reference || '', paidBy: nameOf(r.pb_first, r.pb_last), createdAt: r.created_at, repayments: reps || []
  };
}
async function many(rows) {
  var reps = await repaymentsOf(rows.map(function (r) { return r.id; }));
  return rows.map(function (r) { return advanceOut(r, reps.get(r.id)); });
}
async function one(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('notfound', 'That advance is gone.');
  var r = (await pool.query(SELECT + 'WHERE a.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'That advance is gone.');
  return (await many([r]))[0];
}

// What the person may still ask for.
async function allowanceOf(employeeId) {
  var e = (await pool.query('SELECT id, basic_salary, allowance, daily_rate, status FROM employees WHERE id = $1', [employeeId])).rows[0];
  var s = await settingsOf();
  var owing = (await pool.query("SELECT coalesce(sum(CASE WHEN status = 'paid' THEN amount - repaid ELSE amount END), 0) AS n, count(*) FILTER (WHERE status IN ('requested', 'approved'))::int AS waiting FROM salary_advances WHERE employee_id = $1 AND status IN ('requested', 'approved', 'paid')", [employeeId])).rows[0];
  var pay = e ? monthlyPay(e) : 0;
  var max = Math.max(0, round2(pay * s.maxPercent / 100 - Number(owing.n)));
  return { monthlyPay: pay, max: max, owing: round2(owing.n), waiting: owing.waiting, settings: s };
}

// GET /api/advances/mine
async function mine(ctx) {
  if (!ctx.employee) fail('forbidden', 'Sign in as a member of staff.');
  var rows = (await pool.query(SELECT + 'WHERE a.employee_id = $1 ORDER BY a.created_at DESC LIMIT 20', [ctx.employee.id])).rows;
  return { advances: await many(rows), allowance: await allowanceOf(ctx.employee.id) };
}

// POST /api/advances { amount, months, reason }
async function request(ctx, p) {
  if (!ctx.employee) fail('forbidden', 'Sign in as a member of staff.');
  p = p || {};
  var a = await allowanceOf(ctx.employee.id);
  if (!a.settings.open) fail('conflict', 'Salary advances are not open at the moment.');
  if (a.waiting) fail('conflict', 'You have an advance waiting already.');
  if (!(a.monthlyPay > 0)) fail('conflict', 'Your pay is not on record yet: ask HR before asking for an advance.');
  var amount = round2(p.amount);
  if (!(amount > 0)) fail('invalid', 'How much? More than 0.');
  if (amount > a.max) fail('invalid', 'At most ' + money(a.max) + ' (' + a.settings.maxPercent + '% of a month\'s pay' + (a.owing ? ', less what you still owe' : '') + ').');
  var months = Math.round(Number(p.months) || 1);
  if (months < 1 || months > a.settings.maxMonths) fail('invalid', 'Repaid over 1 to ' + a.settings.maxMonths + ' months.');
  var reason = text(p.reason, 300);
  if (reason.length < 3) fail('invalid', 'What is it for? A few words.');
  var row = await withTransaction(async function (db) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('salary_advances'))");
    var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM salary_advances')).rows[0].n;
    return (await db.query('INSERT INTO salary_advances (number, employee_id, amount, months, instalment, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$2) RETURNING *',
      [n, ctx.employee.id, amount, months, Math.ceil(amount / months * 100) / 100, reason])).rows[0];
  });
  await audit(pool, ctx, 'advance.request', 'salary_advance', row.id, 'Asked for salary advance ' + ref(row.number) + ': ' + money(amount) + ' over ' + months + ' month(s).');
  var holders = await require('./staffAlerts.service').holdersOf(['advance.manage']);
  var who = nameOf(ctx.employee.first_name, ctx.employee.last_name);
  for (var i = 0; i < holders.length; i++) {
    if (holders[i].employee_id === ctx.employee.id) continue;
    await notify(pool, holders[i].employee_id, '💵 ' + who + ' asks for a salary advance · ' + money(amount), reason + ' — over ' + months + (months === 1 ? ' month' : ' months'), '/advances?open=' + row.id);
  }
  return one(row.id);
}

// POST /api/advances/:id/cancel — the person's own, while still waiting.
async function cancel(ctx, id) {
  var a = await one(id);
  var own = ctx.employee && a.employee.id === ctx.employee.id;
  if (!own && !ctx.can('advance.manage')) fail('forbidden', 'That is not your advance.');
  if (['requested', 'approved'].indexOf(a.status) < 0) fail('conflict', 'It was ' + a.status + ' already.');
  await pool.query("UPDATE salary_advances SET status = 'cancelled', updated_at = now() WHERE id = $1", [a.id]);
  await audit(pool, ctx, 'advance.cancel', 'salary_advance', a.id, 'Salary advance ' + a.ref + ' cancelled.');
  return one(a.id);
}

// GET /api/advances?status=
async function list(ctx, q) {
  need(ctx, 'advance.manage');
  q = q || {};
  var status = ['waiting', 'repaying', 'done', 'all'].indexOf(q.status) >= 0 ? q.status : 'waiting';
  var where = { waiting: "a.status IN ('requested', 'approved')", repaying: "a.status = 'paid'", done: "a.status IN ('repaid', 'declined', 'cancelled')", all: 'true' }[status];
  var rows = (await pool.query(SELECT + 'WHERE ' + where + " ORDER BY (a.status = 'requested') DESC, a.created_at DESC LIMIT 300")).rows;
  var sum = (await pool.query(
    "SELECT count(*) FILTER (WHERE status = 'requested')::int AS asked_n, coalesce(sum(amount) FILTER (WHERE status = 'requested'), 0) AS asked, " +
    "count(*) FILTER (WHERE status = 'approved')::int AS topay_n, coalesce(sum(amount) FILTER (WHERE status = 'approved'), 0) AS topay, " +
    "count(*) FILTER (WHERE status = 'paid')::int AS out_n, coalesce(sum(amount - repaid) FILTER (WHERE status = 'paid'), 0) AS out FROM salary_advances")).rows[0];
  var back = (await pool.query("SELECT coalesce(sum(amount), 0) AS n FROM salary_advance_repayments WHERE created_at >= date_trunc('month', now())")).rows[0].n;
  return {
    advances: await many(rows), status: status, settings: await settingsOf(), methods: METHODS,
    summary: { asked: { n: sum.asked_n, amount: round2(sum.asked) }, toPay: { n: sum.topay_n, amount: round2(sum.topay) }, outstanding: { n: sum.out_n, amount: round2(sum.out) }, repaidThisMonth: round2(back) }
  };
}
async function get(ctx, id) {
  var a = await one(id);
  if (!ctx.can('advance.manage') && !(ctx.employee && a.employee.id === ctx.employee.id)) fail('forbidden', 'That is not your advance.');
  return a;
}

// POST /api/advances/:id/decide { approve, amount, months, reason }
async function decide(ctx, id, p) {
  need(ctx, 'advance.manage');
  p = p || {};
  var a = await one(id);
  if (a.status !== 'requested') fail('conflict', 'It was ' + a.status + ' already.');
  if (ctx.employee && a.employee.id === ctx.employee.id) fail('forbidden', 'Someone else decides on your own advance.');
  var by = ctx.employee ? ctx.employee.id : null;
  if (p.approve) {
    var amount = p.amount === undefined || p.amount === '' ? a.amount : round2(p.amount);
    if (!(amount > 0 && amount <= a.amount)) fail('invalid', 'Approve between GHS 0.01 and what was asked (' + money(a.amount) + ').');
    var months = p.months === undefined || p.months === '' ? a.months : Math.round(Number(p.months));
    if (!(months >= 1 && months <= 12)) fail('invalid', 'Repaid over 1 to 12 months.');
    await pool.query("UPDATE salary_advances SET status = 'approved', amount = $2, months = $3, instalment = $4, decided_by = $5, decided_at = now(), updated_at = now() WHERE id = $1",
      [a.id, amount, months, Math.ceil(amount / months * 100) / 100, by]);
    await audit(pool, ctx, 'advance.approve', 'salary_advance', a.id, 'Approved salary advance ' + a.ref + ' for ' + a.employee.name + ': ' + money(amount) + ' over ' + months + ' month(s)' + (amount < a.amount ? ' (asked ' + money(a.amount) + ')' : '') + '.');
    await notify(pool, a.employee.id, '✅ Your salary advance is approved · ' + money(amount), 'Repaid ' + money(Math.ceil(amount / months * 100) / 100) + ' a month over ' + months + (months === 1 ? ' month' : ' months') + '. Finance pays it out next.', '/myspace');
  } else {
    var reason = text(p.reason, 300);
    if (reason.length < 3) fail('invalid', 'Why is it declined? A few words for ' + a.employee.name + '.');
    await pool.query("UPDATE salary_advances SET status = 'declined', decline_reason = $2, decided_by = $3, decided_at = now(), updated_at = now() WHERE id = $1", [a.id, reason, by]);
    await audit(pool, ctx, 'advance.decline', 'salary_advance', a.id, 'Declined salary advance ' + a.ref + ' for ' + a.employee.name + ': ' + reason);
    await notify(pool, a.employee.id, 'Your salary advance was declined', reason, '/myspace');
  }
  return one(a.id);
}

// POST /api/advances/:id/pay { method, reference, paidOn }
async function pay(ctx, id, p) {
  need(ctx, 'advance.manage');
  p = p || {};
  var a = await one(id);
  if (a.status !== 'approved') fail('conflict', a.status === 'requested' ? 'Approve it first.' : 'It was ' + a.status + ' already.');
  var method = METHODS.indexOf(p.method) >= 0 ? p.method : fail('invalid', 'How was it paid out?');
  var paidOn = /^\d{4}-\d{2}-\d{2}$/.test(String(p.paidOn || '')) ? p.paidOn : today();
  if (paidOn > today()) fail('invalid', 'Paid out on a day to come?');
  await pool.query("UPDATE salary_advances SET status = 'paid', paid_at = $2, paid_method = $3, paid_reference = $4, paid_by = $5, updated_at = now() WHERE id = $1",
    [a.id, paidOn, method, text(p.reference, 60), ctx.employee ? ctx.employee.id : null]);
  await audit(pool, ctx, 'advance.pay', 'salary_advance', a.id, 'Paid out salary advance ' + a.ref + ' to ' + a.employee.name + ': ' + money(a.amount) + ' (' + method + ').');
  await notify(pool, a.employee.id, '💵 Your salary advance is paid out · ' + money(a.amount), money(a.instalment) + ' comes off each payslip until it is repaid.', '/myspace');
  return one(a.id);
}

// POST /api/advances/:id/repay { amount, note } — repaid in cash.
async function repayCash(ctx, id, p) {
  need(ctx, 'advance.manage');
  p = p || {};
  var a = await one(id);
  if (a.status !== 'paid') fail('conflict', 'Only an advance paid out and not yet repaid.');
  var amount = round2(p.amount);
  if (!(amount > 0)) fail('invalid', 'How much was repaid?');
  if (amount > a.left) fail('invalid', 'At most what is left: ' + money(a.left) + '.');
  await withTransaction(async function (db) {
    await db.query("INSERT INTO salary_advance_repayments (advance_id, amount, kind, note, by_id) VALUES ($1, $2, 'cash', $3, $4)", [a.id, amount, text(p.note, 200), ctx.employee ? ctx.employee.id : null]);
    await db.query("UPDATE salary_advances SET repaid = repaid + $2, status = CASE WHEN repaid + $2 >= amount - 0.005 THEN 'repaid' ELSE status END, updated_at = now() WHERE id = $1", [a.id, amount]);
  });
  await audit(pool, ctx, 'advance.repay', 'salary_advance', a.id, money(amount) + ' of salary advance ' + a.ref + ' repaid in cash by ' + a.employee.name + '.');
  return one(a.id);
}

// PUT /api/advances/settings { open, maxPercent, maxMonths }
async function saveSettings(ctx, p) {
  need(ctx, 'advance.manage');
  p = p || {};
  var s = { open: !!p.open, maxPercent: Math.round(Number(p.maxPercent)), maxMonths: Math.round(Number(p.maxMonths)) };
  if (!(s.maxPercent >= 1 && s.maxPercent <= 100)) fail('invalid', 'At most what share of a month\'s pay? 1 to 100%.');
  if (!(s.maxMonths >= 1 && s.maxMonths <= 12)) fail('invalid', 'Repaid over at most 1 to 12 months.');
  await pool.query('UPDATE settings SET advances = $1 WHERE id = 1', [s]);
  await audit(pool, ctx, 'advance.settings', 'settings', null, 'Salary advances ' + (s.open ? 'open' : 'closed') + ': at most ' + s.maxPercent + '% of a month\'s pay, over at most ' + s.maxMonths + ' month(s).');
  return settingsOf();
}

// ── Payroll ──

// What comes off a payslip when the run is made: each advance's
// instalment (or what is left of it), never more than the take-home pay.
async function forSlip(db, employeeId, net) {
  var rows = (await db.query("SELECT id, instalment, amount - repaid AS left FROM salary_advances WHERE employee_id = $1 AND status = 'paid' AND amount - repaid > 0 ORDER BY paid_at, number", [employeeId])).rows;
  var room = Math.max(0, round2(net)), total = 0;
  rows.forEach(function (r) { var take = Math.min(Number(r.instalment), Number(r.left), room - total); if (take > 0) total = round2(total + take); });
  return round2(total);
}

// When a run is paid: what each payslip took is shared out over the
// person's advances, oldest first, and they are repaid.
async function onRunPaid(db, runId) {
  var slips = (await db.query('SELECT employee_id, advance_deduction FROM payslips WHERE pay_run_id = $1 AND advance_deduction > 0', [runId])).rows;
  var n = 0;
  for (var i = 0; i < slips.length; i++) {
    var left = Number(slips[i].advance_deduction);
    var rows = (await db.query("SELECT id, instalment, amount - repaid AS left FROM salary_advances WHERE employee_id = $1 AND status = 'paid' AND amount - repaid > 0 ORDER BY paid_at, number FOR UPDATE", [slips[i].employee_id])).rows;
    for (var k = 0; k < rows.length && left > 0.005; k++) {
      var take = round2(Math.min(Number(rows[k].instalment), Number(rows[k].left), left));
      if (!(take > 0)) continue;
      var ins = await db.query("INSERT INTO salary_advance_repayments (advance_id, amount, kind, pay_run_id) VALUES ($1, $2, 'payroll', $3) ON CONFLICT DO NOTHING RETURNING id", [rows[k].id, take, runId]);
      if (!ins.rows[0]) continue;
      await db.query("UPDATE salary_advances SET repaid = repaid + $2, status = CASE WHEN repaid + $2 >= amount - 0.005 THEN 'repaid' ELSE status END, updated_at = now() WHERE id = $1", [rows[k].id, take]);
      left = round2(left - take); n++;
    }
  }
  return n;
}

module.exports = { mine: mine, request: request, cancel: cancel, list: list, get: get, decide: decide, pay: pay, repayCash: repayCash, saveSettings: saveSettings, settingsOf: settingsOf,
  forSlip: forSlip, onRunPaid: onRunPaid, allowanceOf: allowanceOf, METHODS: METHODS };
