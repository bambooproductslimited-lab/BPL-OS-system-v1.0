var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// Cash flow forecast (migration 0197): a company's next 13 weeks, week by
// week, from what it has today (settings.cashflow, typed in by Finance)
// plus the money it expects in — invoices by their due date (the overdue
// ones this week, marked late), recurring invoices still to be raised, a
// restaurant's till takings at the pace of its last four weeks — less the
// money it expects out — bills to pay by their due date, payroll on pay day
// (an estimate from the staff's pay, with the employer's SSNIT), salary
// advances approved and not yet paid out — and what Finance adds by hand
// (a loan repayment, rent received, tax). The weeks that end below the
// company's comfortable minimum are flagged.

var WEEKS = 13;
var DAY = /^\d{4}-\d{2}-\d{2}$/;
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function mondayOf(day) { var d = new Date(day + 'T00:00:00Z'); var wd = (d.getUTCDay() + 6) % 7; return addDays(day, -wd); }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }

async function settingsOf() {
  var s = (await pool.query('SELECT cashflow FROM settings WHERE id = 1')).rows[0];
  s = (s && s.cashflow) || {};
  return { balances: s.balances || {}, floors: s.floors || {}, payDay: Number(s.payDay) >= 1 && Number(s.payDay) <= 28 ? Number(s.payDay) : 5 };
}

async function companies() {
  return (await pool.query(
    "SELECT c.id, c.code, c.name, EXISTS (SELECT 1 FROM restaurant_menu_items m WHERE m.company_id = c.id AND m.active) AS restaurant FROM companies c WHERE coalesce(c.status, 'active') = 'active' ORDER BY (c.code = 'BPL') DESC, c.name")).rows;
}

// Monthly payroll, about: salaried staff's basic and allowance, daily-rate
// staff at 22 days, and the employer's SSNIT on the salary for SSNIT.
async function payrollOf(companyId) {
  var r = (await pool.query(
    "SELECT coalesce(sum(CASE WHEN e.basic_salary IS NOT NULL THEN e.basic_salary + coalesce(e.allowance, 0) ELSE e.daily_rate * 22 END), 0) AS gross, " +
    'coalesce(sum(coalesce(e.ssnit_salary, e.basic_salary, e.daily_rate * 22)), 0) AS on_ssnit, count(*)::int AS staff ' +
    "FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.company_id = $1 AND e.status = 'active'", [companyId])).rows[0];
  var rate = Number((await pool.query('SELECT payroll FROM settings WHERE id = 1')).rows[0].payroll.ssnitEmployerRate || 13);
  return { monthly: round2(Number(r.gross) + Number(r.on_ssnit) * rate / 100), staff: r.staff };
}

// What the forecast is made of, each with the day it is expected.
async function itemsOf(company, from, to) {
  var t = today(), out = [];
  var isBpl = company.code === 'BPL';
  // Invoices still owed, by when they are due; overdue ones this week.
  (await pool.query(
    "SELECT i.invoice_no, i.balance_due, coalesce(i.due_date, i.issued_at) AS due, c.name FROM invoices i JOIN customers c ON c.id = i.customer_id " +
    "WHERE i.status IN ('unpaid', 'partially_paid') AND i.balance_due > 0 AND i.currency = 'GHS' AND (i.company_id = $1 OR ($2 AND i.company_id IS NULL)) AND coalesce(i.due_date, i.issued_at) <= $3",
    [company.id, isBpl, to])).rows.forEach(function (r) {
    var due = dayText(r.due), late = due < t;
    out.push({ direction: 'in', source: 'invoice', label: r.invoice_no + ' · ' + r.name, amount: round2(r.balance_due), date: late ? t : due, late: late, dueDate: due });
  });
  // Recurring invoices still to be raised.
  var series = (await pool.query(
    "SELECT s.name, s.every, s.every_n, s.next_on, s.ends_on, s.max_count, s.raised, s.due_days, i.grand_total, c.name AS customer FROM invoice_series s JOIN invoices i ON i.id = s.template_invoice_id JOIN customers c ON c.id = s.customer_id " +
    "WHERE s.status = 'active' AND i.currency = 'GHS' AND (i.company_id = $1 OR ($2 AND i.company_id IS NULL))", [company.id, isBpl])).rows;
  var advance = require('./invoiceSeries.service').advance;
  series.forEach(function (s) {
    var on = dayText(s.next_on), n = Number(s.raised) || 0, guard = 0;
    while (on && guard++ < 60) {
      if (s.ends_on && on > dayText(s.ends_on)) break;
      if (s.max_count && n >= s.max_count) break;
      var paid = addDays(on, Number(s.due_days) || 0);
      if (paid > to) break;
      if (paid >= from) out.push({ direction: 'in', source: 'recurring', label: (s.name || 'Recurring invoice') + ' · ' + s.customer, amount: round2(s.grand_total), date: paid });
      on = advance(on, s.every, Number(s.every_n) || 1); n++;
    }
  });
  // A restaurant's takings, at the pace of its last four weeks.
  if (company.restaurant) {
    var w = (await pool.query(
      "SELECT coalesce(sum(total - refunded_total), 0) AS net FROM restaurant_orders WHERE company_id = $1 AND status = 'completed' AND created_at >= now() - interval '28 days'", [company.id])).rows[0];
    var weekly = round2(Number(w.net) / 4);
    if (weekly > 0) for (var d = mondayOf(from); d <= to; d = addDays(d, 7)) out.push({ direction: 'in', source: 'takings', label: 'Till takings (the last 4 weeks\' pace)', amount: weekly, date: d < t ? t : d, estimate: true });
  }
  // Bills to pay, by when they are due; overdue ones this week.
  (await pool.query(
    "SELECT number, supplier_name, amount - paid AS left, due_date, status FROM supplier_bills WHERE company_id = $1 AND status IN ('to_approve', 'approved') AND amount - paid > 0 AND due_date <= $2",
    [company.id, to])).rows.forEach(function (r) {
    var due = dayText(r.due_date), late = due < t;
    out.push({ direction: 'out', source: 'bill', label: 'B-' + String(r.number).padStart(4, '0') + ' · ' + r.supplier_name + (r.status === 'to_approve' ? ' (to approve)' : ''), ref: 'B-' + String(r.number).padStart(4, '0'), who: r.supplier_name, toApprove: r.status === 'to_approve', amount: round2(r.left), date: late ? t : due, late: late, dueDate: due });
  });
  // Payroll on pay day, each month.
  var pay = await payrollOf(company.id);
  var s = await settingsOf();
  if (pay.monthly > 0) {
    for (var m = 0; m < 5; m++) {
      var base = new Date(from + 'T00:00:00Z'); base.setUTCDate(1); base.setUTCMonth(base.getUTCMonth() + m);
      var payDay = base.toISOString().slice(0, 8) + String(s.payDay).padStart(2, '0');
      if (payDay >= from && payDay <= to) out.push({ direction: 'out', source: 'payroll', label: 'Payroll and SSNIT, about (' + pay.staff + ' staff)', staff: pay.staff, amount: pay.monthly, date: payDay, estimate: true });
    }
  }
  // Salary advances approved, to pay out.
  (await pool.query(
    "SELECT a.number, a.amount, e.first_name, e.last_name FROM salary_advances a JOIN employees e ON e.id = a.employee_id JOIN departments d ON d.id = e.department_id WHERE a.status = 'approved' AND d.company_id = $1",
    [company.id])).rows.forEach(function (r) {
    out.push({ direction: 'out', source: 'advance', label: 'Salary advance SA-' + String(r.number).padStart(4, '0') + ' · ' + r.first_name + ' ' + r.last_name, ref: 'SA-' + String(r.number).padStart(4, '0'), who: r.first_name + ' ' + r.last_name, amount: round2(r.amount), date: t });
  });
  // Added by hand.
  (await pool.query('SELECT * FROM cashflow_items WHERE company_id = $1 AND starts_on <= $2 AND (ends_on IS NULL OR ends_on >= $3)', [company.id, to, from])).rows.forEach(function (r) {
    var on = dayText(r.starts_on), guard = 0, end = r.ends_on ? dayText(r.ends_on) : to;
    while (on <= to && on <= end && guard++ < 120) {
      if (on >= from) out.push({ direction: r.direction, source: 'manual', label: r.label, amount: round2(r.amount), date: on, itemId: r.id });
      if (r.repeat === 'once') break;
      on = r.repeat === 'weekly' ? addDays(on, 7) : advance(on, 'month', 1);
    }
  });
  return out;
}

// GET /api/cashflow?company=<id>|all
async function forecast(ctx, q) {
  need(ctx, 'report.read');
  q = q || {};
  var list = await companies();
  if (!list.length) fail('notfound', 'No company yet.');
  var pick = q.company === 'all' ? list : [list.find(function (c) { return c.id === q.company; }) || list[0]];
  var s = await settingsOf();
  var t = today(), from = mondayOf(t), to = addDays(from, WEEKS * 7 - 1);
  var items = [];
  var opening = 0, set = true, asOf = null, floor = 0;
  for (var i = 0; i < pick.length; i++) {
    var b = s.balances[pick[i].id];
    if (!b) set = false; else { opening += Number(b.amount) || 0; asOf = !asOf || b.asOf < asOf ? b.asOf : asOf; }
    floor += Number(s.floors[pick[i].id]) || 0;
    (await itemsOf(pick[i], from, to)).forEach(function (x) { x.company = pick[i].code; items.push(x); });
  }
  var weeks = [], bal = round2(opening);
  for (var k = 0; k < WEEKS; k++) {
    var ws = addDays(from, k * 7), we = addDays(ws, 6);
    var mine = items.filter(function (x) { return x.date >= ws && x.date <= we; }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount; });
    var inn = round2(mine.filter(function (x) { return x.direction === 'in'; }).reduce(function (a, x) { return a + x.amount; }, 0));
    var out = round2(mine.filter(function (x) { return x.direction === 'out'; }).reduce(function (a, x) { return a + x.amount; }, 0));
    var start = bal;
    bal = round2(bal + inn - out);
    weeks.push({ n: k + 1, start: ws, end: we, opening: start, in: inn, out: out, net: round2(inn - out), closing: bal, short: bal < floor, negative: bal < 0, items: mine });
  }
  var lowest = weeks.reduce(function (m, w) { return !m || w.closing < m.closing ? w : m; }, null);
  var bySource = {};
  items.forEach(function (x) { var k2 = x.direction + ':' + x.source; bySource[k2] = round2((bySource[k2] || 0) + x.amount); });
  return {
    companies: list.map(function (c) { return { id: c.id, code: c.code, name: c.name, restaurant: c.restaurant, balance: s.balances[c.id] || null, floor: Number(s.floors[c.id]) || 0 }; }),
    company: q.company === 'all' ? 'all' : pick[0].id, from: from, to: to, today: t,
    opening: { amount: round2(opening), asOf: asOf, set: set }, floor: round2(floor), payDay: s.payDay,
    weeks: weeks, lowest: lowest ? { n: lowest.n, start: lowest.start, closing: lowest.closing } : null,
    totals: { in: round2(weeks.reduce(function (a, w) { return a + w.in; }, 0)), out: round2(weeks.reduce(function (a, w) { return a + w.out; }, 0)), end: bal, late: round2(items.filter(function (x) { return x.late && x.direction === 'in'; }).reduce(function (a, x) { return a + x.amount; }, 0)) },
    bySource: bySource, shortWeeks: weeks.filter(function (w) { return w.short; }).length,
    manual: (await pool.query('SELECT * FROM cashflow_items WHERE company_id = ANY($1::uuid[]) ORDER BY starts_on', [pick.map(function (c) { return c.id; })])).rows.map(function (r) {
      return { id: r.id, companyId: r.company_id, direction: r.direction, label: r.label, amount: round2(r.amount), startsOn: dayText(r.starts_on), repeat: r.repeat, endsOn: dayText(r.ends_on) };
    }),
    canManage: ctx.can('report.manage')
  };
}

// PUT /api/cashflow/balance { companyId, amount, asOf, floor, payDay }
async function saveBalance(ctx, p) {
  need(ctx, 'report.manage');
  p = p || {};
  var co = (await pool.query('SELECT id, name FROM companies WHERE id = $1', [/^[0-9a-f-]{36}$/i.test(String(p.companyId || '')) ? p.companyId : null])).rows[0];
  if (!co) fail('invalid', 'Which company?');
  var amount = round2(p.amount);
  if (!Number.isFinite(amount) || Math.abs(amount) > 1e10) fail('invalid', 'How much does it have today, in the bank and in hand?');
  var asOf = DAY.test(String(p.asOf || '')) ? p.asOf : today();
  var raw = ((await pool.query('SELECT cashflow FROM settings WHERE id = 1')).rows[0].cashflow) || {};
  raw.balances = raw.balances || {}; raw.floors = raw.floors || {};
  raw.balances[co.id] = { amount: amount, asOf: asOf, by: ctx.employee ? ctx.employee.id : null };
  if (p.floor !== undefined) raw.floors[co.id] = Math.max(0, round2(p.floor));
  if (p.payDay !== undefined) { var pd = Math.round(Number(p.payDay)); if (!(pd >= 1 && pd <= 28)) fail('invalid', 'Pay day is a day of the month, 1 to 28.'); raw.payDay = pd; }
  await pool.query('UPDATE settings SET cashflow = $1 WHERE id = 1', [raw]);
  await audit(pool, ctx, 'cashflow.balance', 'company', co.id, co.name + ': cash today GHS ' + amount.toFixed(2) + ' (as of ' + asOf + ')' + (p.floor !== undefined ? ', minimum GHS ' + Number(raw.floors[co.id]).toFixed(2) : '') + '.');
  return forecast(ctx, { company: co.id });
}

// POST /api/cashflow/items { companyId, direction, label, amount, startsOn, repeat, endsOn }
async function addItem(ctx, p) {
  need(ctx, 'report.manage');
  p = p || {};
  var co = (await pool.query('SELECT id FROM companies WHERE id = $1', [/^[0-9a-f-]{36}$/i.test(String(p.companyId || '')) ? p.companyId : null])).rows[0];
  if (!co) fail('invalid', 'Which company?');
  var direction = p.direction === 'in' || p.direction === 'out' ? p.direction : fail('invalid', 'Money in or money out?');
  var label = text(p.label, 120);
  if (label.length < 2) fail('invalid', 'What is it? e.g. Loan repayment.');
  var amount = round2(p.amount);
  if (!(amount > 0 && amount <= 1e10)) fail('invalid', 'How much? More than 0.');
  var starts = DAY.test(String(p.startsOn || '')) ? p.startsOn : fail('invalid', 'When?');
  var repeat = ['once', 'weekly', 'monthly'].indexOf(p.repeat) >= 0 ? p.repeat : 'once';
  var ends = DAY.test(String(p.endsOn || '')) ? p.endsOn : null;
  if (ends && ends < starts) fail('invalid', 'It cannot end before it starts.');
  await pool.query('INSERT INTO cashflow_items (company_id, direction, label, amount, starts_on, repeat, ends_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [co.id, direction, label, amount, starts, repeat, ends, ctx.employee ? ctx.employee.id : null]);
  await audit(pool, ctx, 'cashflow.item', 'company', co.id, 'Added to the cash flow: ' + label + ', ' + direction + ' GHS ' + amount.toFixed(2) + ' (' + repeat + ' from ' + starts + ').');
  return forecast(ctx, { company: co.id });
}

// DELETE /api/cashflow/items/:id
async function removeItem(ctx, id) {
  need(ctx, 'report.manage');
  var r = (await pool.query('DELETE FROM cashflow_items WHERE id = $1 RETURNING company_id, label', [/^[0-9a-f-]{36}$/i.test(String(id || '')) ? id : null])).rows[0];
  if (!r) fail('notfound', 'That is gone.');
  await audit(pool, ctx, 'cashflow.item', 'company', r.company_id, 'Taken off the cash flow: ' + r.label + '.');
  return forecast(ctx, { company: r.company_id });
}

module.exports = { forecast: forecast, saveBalance: saveBalance, addItem: addItem, removeItem: removeItem, payrollOf: payrollOf };
