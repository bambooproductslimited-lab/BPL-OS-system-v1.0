var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// Budgets against what was spent (Finance → Budgets; migration 0198): what
// each company means to spend in a month, by category, and what it did —
// supplier bills by their category and the month on the bill, payroll and
// the employer's SSNIT by the pay run's month, the expense sheets' spending,
// fuel for its vehicles. Finance is told when a category passes 90% of its
// budget, and again past 100% (jobs/dailyAlerts.js).

var BILL = ['stock', 'utilities', 'rent', 'services', 'equipment', 'transport', 'staff', 'other'];
var CATEGORIES = ['payroll', 'stock', 'utilities', 'rent', 'services', 'equipment', 'transport', 'fuel', 'expenses', 'staff', 'other'];
var MONTH = /^\d{4}-\d{2}$/;

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function money(n) { return 'GHS ' + round2(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function thisMonth() { return new Date().toISOString().slice(0, 7); }
function shift(month, n) { var d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }

async function settingsOf() {
  var s = ((await pool.query('SELECT budgets FROM settings WHERE id = 1')).rows[0] || {}).budgets || {};
  return { warnAt: Number(s.warnAt) >= 50 && Number(s.warnAt) <= 100 ? Number(s.warnAt) : 90 };
}

// What was spent, by category, for each month from `from` to `to` (YYYY-MM).
async function actualsOf(companyId, from, to) {
  var a = from + '-01', b = shift(to, 1) + '-01';
  var out = {};
  var add = function (m, cat, amount) { out[m] = out[m] || {}; out[m][cat] = round2((out[m][cat] || 0) + Number(amount)); };
  (await pool.query("SELECT to_char(bill_date, 'YYYY-MM') AS m, category, sum(amount) AS s FROM supplier_bills WHERE company_id = $1 AND status <> 'cancelled' AND bill_date >= $2 AND bill_date < $3 GROUP BY 1, 2",
    [companyId, a, b])).rows.forEach(function (r) { add(r.m, BILL.indexOf(r.category) >= 0 ? r.category : 'other', r.s); });
  (await pool.query("SELECT to_char(r.period_end, 'YYYY-MM') AS m, sum(p.gross_pay + p.ssnit_employer) AS s FROM pay_runs r JOIN payslips p ON p.pay_run_id = r.id " +
    "WHERE r.company_id = $1 AND r.status IN ('approved', 'paid') AND r.period_end >= $2 AND r.period_end < $3 GROUP BY 1", [companyId, a, b])).rows.forEach(function (r) { add(r.m, 'payroll', r.s); });
  (await pool.query("SELECT to_char(l.date, 'YYYY-MM') AS m, sum(l.amount) AS s FROM expense_sheet_lines l JOIN expense_sheets s ON s.id = l.sheet_id JOIN employees e ON e.id = s.employee_id " +
    "LEFT JOIN departments d ON d.id = e.department_id WHERE l.kind = 'expense' AND coalesce(l.company_id, d.company_id) = $1 AND l.date >= $2 AND l.date < $3 GROUP BY 1", [companyId, a, b])).rows.forEach(function (r) { add(r.m, 'expenses', r.s); });
  (await pool.query("SELECT to_char(f.day, 'YYYY-MM') AS m, sum(f.amount) AS s FROM fuel_logs f JOIN vehicles v ON v.id = f.vehicle_id WHERE v.company_id = $1 AND f.day >= $2 AND f.day < $3 GROUP BY 1",
    [companyId, a, b])).rows.forEach(function (r) { add(r.m, 'fuel', r.s); });
  return out;
}
async function budgetsOf(companyId, from, to) {
  var out = {};
  (await pool.query("SELECT id, to_char(month, 'YYYY-MM') AS m, category, amount FROM budgets WHERE company_id = $1 AND month >= $2 AND month <= $3", [companyId, from + '-01', to + '-01'])).rows.forEach(function (r) {
    out[r.m] = out[r.m] || {};
    out[r.m][r.category] = { id: r.id, amount: round2(r.amount) };
  });
  return out;
}
function stateOf(budget, actual, warnAt) {
  if (!budget) return actual > 0 ? 'none' : 'empty';
  var pct = actual / budget * 100;
  return pct > 100 ? 'over' : pct >= warnAt ? 'near' : 'ok';
}

// GET /api/budgets?company=&month=YYYY-MM
async function view(ctx, q) {
  need(ctx, 'report.read');
  q = q || {};
  var companies = (await pool.query("SELECT id, code, name FROM companies WHERE coalesce(status, 'active') = 'active' ORDER BY (code = 'BPL') DESC, name")).rows;
  if (!companies.length) fail('notfound', 'No company yet.');
  var co = companies.find(function (c) { return c.id === q.company; }) || companies[0];
  var month = MONTH.test(String(q.month || '')) ? q.month : thisMonth();
  var year = month.slice(0, 4);
  var s = await settingsOf();
  var acts = await actualsOf(co.id, year + '-01', year + '-12');
  var last = await actualsOf(co.id, shift(month, -1), shift(month, -1));
  var buds = await budgetsOf(co.id, year + '-01', year + '-12');
  var prevBud = await budgetsOf(co.id, shift(month, -1), shift(month, -1));
  var mA = acts[month] || {}, mB = buds[month] || {};
  // How far into the month we are: the pace a budget should be spent at.
  var now = new Date(), cur = thisMonth();
  var daysIn = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  var elapsed = month < cur ? 1 : month > cur ? 0 : now.getUTCDate() / daysIn;
  var rows = CATEGORIES.map(function (c) {
    var budget = mB[c] ? mB[c].amount : 0, actual = round2(mA[c] || 0);
    return {
      category: c, budget: budget, actual: actual, left: round2(budget - actual), pct: budget ? Math.round(actual / budget * 100) : null,
      state: stateOf(budget, actual, s.warnAt), lastMonth: round2((last[shift(month, -1)] || {})[c] || 0), lastBudget: (prevBud[shift(month, -1)] || {})[c] ? prevBud[shift(month, -1)][c].amount : 0,
      pace: budget && elapsed > 0 && elapsed < 1 ? Math.round(actual / (budget * elapsed) * 100) : null
    };
  });
  var year12 = [];
  for (var m = 1; m <= 12; m++) {
    var key = year + '-' + String(m).padStart(2, '0');
    var bs = buds[key] || {}, as = acts[key] || {};
    year12.push({
      month: key,
      budget: round2(Object.keys(bs).reduce(function (a, k) { return a + bs[k].amount; }, 0)),
      actual: round2(Object.keys(as).reduce(function (a, k) { return a + as[k]; }, 0)),
      future: key > cur
    });
  }
  var tB = round2(rows.reduce(function (a, r) { return a + r.budget; }, 0)), tA = round2(rows.reduce(function (a, r) { return a + r.actual; }, 0));
  var ytd = year12.filter(function (x) { return !x.future; });
  return {
    companies: companies, company: co.id, month: month, categories: CATEGORIES, rows: rows,
    totals: { budget: tB, actual: tA, left: round2(tB - tA), pct: tB ? Math.round(tA / tB * 100) : null, over: rows.filter(function (r) { return r.state === 'over'; }).length, near: rows.filter(function (r) { return r.state === 'near'; }).length, unbudgeted: round2(rows.filter(function (r) { return r.state === 'none'; }).reduce(function (a, r) { return a + r.actual; }, 0)) },
    year: year12, ytd: { budget: round2(ytd.reduce(function (a, x) { return a + x.budget; }, 0)), actual: round2(ytd.reduce(function (a, x) { return a + x.actual; }, 0)) },
    elapsed: Math.round(elapsed * 100), settings: s, canManage: ctx.can('report.manage'), hasBudget: Object.keys(mB).length > 0
  };
}

// GET /api/budgets/spent?company=&month=&category= — what makes up a category's spending.
async function spent(ctx, q) {
  need(ctx, 'report.read');
  q = q || {};
  var co = uuidOr(q.company), month = MONTH.test(String(q.month || '')) ? q.month : thisMonth(), c = String(q.category || '');
  if (!co || CATEGORIES.indexOf(c) < 0) fail('invalid', 'Which company and category?');
  var a = month + '-01', b = shift(month, 1) + '-01';
  var rows = [];
  if (BILL.indexOf(c) >= 0) {
    rows = (await pool.query("SELECT 'bill' AS kind, id, number, supplier_name AS who, reference AS what, bill_date AS day, amount FROM supplier_bills WHERE company_id = $1 AND status <> 'cancelled' AND bill_date >= $2 AND bill_date < $3 AND (category = $4 OR ($4 = 'other' AND category <> ALL($5::text[]))) ORDER BY amount DESC LIMIT 50",
      [co, a, b, c, BILL])).rows.map(function (r) { return { kind: 'bill', id: r.id, ref: 'B-' + String(r.number).padStart(4, '0'), who: r.who, what: r.what, day: r.day, amount: round2(r.amount) }; });
  } else if (c === 'payroll') {
    rows = (await pool.query("SELECT r.id, r.run_no, r.period_end AS day, count(p.*)::int AS n, sum(p.gross_pay + p.ssnit_employer) AS amount FROM pay_runs r JOIN payslips p ON p.pay_run_id = r.id WHERE r.company_id = $1 AND r.status IN ('approved', 'paid') AND r.period_end >= $2 AND r.period_end < $3 GROUP BY 1, 2, 3",
      [co, a, b])).rows.map(function (r) { return { kind: 'pay_run', id: r.id, ref: r.run_no, who: r.n + ' staff', what: 'gross + SSNIT', day: r.day, amount: round2(r.amount) }; });
  } else if (c === 'expenses') {
    rows = (await pool.query("SELECT l.id, l.date AS day, l.amount, l.category, l.payee, l.note, e.first_name, e.last_name FROM expense_sheet_lines l JOIN expense_sheets s ON s.id = l.sheet_id JOIN employees e ON e.id = s.employee_id LEFT JOIN departments d ON d.id = e.department_id " +
      "WHERE l.kind = 'expense' AND coalesce(l.company_id, d.company_id) = $1 AND l.date >= $2 AND l.date < $3 ORDER BY l.amount DESC LIMIT 50", [co, a, b])).rows.map(function (r) {
      return { kind: 'expense', id: r.id, ref: r.category || '', who: (r.first_name + ' ' + (r.last_name || '')).trim(), what: r.payee || r.note || '', day: r.day, amount: round2(r.amount) };
    });
  } else if (c === 'fuel') {
    rows = (await pool.query('SELECT f.id, f.day, f.amount, f.litres, v.name, v.plate FROM fuel_logs f JOIN vehicles v ON v.id = f.vehicle_id WHERE v.company_id = $1 AND f.day >= $2 AND f.day < $3 ORDER BY f.amount DESC LIMIT 50', [co, a, b])).rows.map(function (r) {
      return { kind: 'fuel', id: r.id, ref: r.plate || '', who: r.name, what: Number(r.litres) + ' L', day: r.day, amount: round2(r.amount) };
    });
  }
  rows.forEach(function (r) { r.day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10); });
  return { company: co, month: month, category: c, items: rows, total: round2(rows.reduce(function (s, r) { return s + r.amount; }, 0)) };
}

// PUT /api/budgets { companyId, month, amounts: { category: amount }, through? }
// `through` (YYYY-MM): the same amounts for every month up to it.
async function save(ctx, p) {
  need(ctx, 'report.manage');
  p = p || {};
  var co = (await pool.query('SELECT id, name FROM companies WHERE id = $1', [uuidOr(p.companyId)])).rows[0];
  if (!co) fail('invalid', 'Which company?');
  var month = MONTH.test(String(p.month || '')) ? p.month : fail('invalid', 'Which month?');
  var through = MONTH.test(String(p.through || '')) && p.through >= month ? p.through : month;
  if (through > shift(month, 23)) fail('invalid', 'Two years at most at a time.');
  var amounts = p.amounts && typeof p.amounts === 'object' ? p.amounts : {};
  var clean = {};
  Object.keys(amounts).forEach(function (k) {
    if (CATEGORIES.indexOf(k) < 0) return;
    var v = amounts[k] === '' || amounts[k] == null ? null : round2(amounts[k]);
    if (v != null && !(v >= 0 && v < 1e11)) fail('invalid', k + ': an amount of 0 or more.');
    clean[k] = v;
  });
  var months = [];
  for (var m = month; m <= through; m = shift(m, 1)) months.push(m);
  await withTransaction(async function (db) {
    for (var i = 0; i < months.length; i++) {
      for (var k in clean) {
        if (clean[k] == null) await db.query('DELETE FROM budgets WHERE company_id = $1 AND month = $2 AND category = $3', [co.id, months[i] + '-01', k]);
        else await db.query('INSERT INTO budgets (company_id, month, category, amount, updated_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (company_id, month, category) DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now()',
          [co.id, months[i] + '-01', k, clean[k], ctx.employee ? ctx.employee.id : null]);
      }
    }
  });
  var total = Object.keys(clean).reduce(function (a, k) { return a + (clean[k] || 0); }, 0);
  await audit(pool, ctx, 'budget.save', 'company', co.id, 'Budget for ' + co.name + ', ' + month + (through !== month ? ' to ' + through : '') + ': ' + money(total) + ' a month.');
  return view(ctx, { company: co.id, month: month });
}

// PUT /api/budgets/settings { warnAt }
async function saveSettings(ctx, p) {
  need(ctx, 'report.manage');
  var v = Math.round(Number((p || {}).warnAt));
  if (!(v >= 50 && v <= 100)) fail('invalid', 'Warn at what share of the budget? 50 to 100%.');
  await pool.query('UPDATE settings SET budgets = $1 WHERE id = 1', [{ warnAt: v }]);
  return settingsOf();
}

// For the daily round: this month's categories past the warning or over.
async function overruns() {
  var s = await settingsOf();
  var month = thisMonth();
  var rows = (await pool.query("SELECT b.id, b.company_id, b.category, b.amount, c.name AS company FROM budgets b JOIN companies c ON c.id = b.company_id WHERE b.month = $1 AND b.amount > 0", [month + '-01'])).rows;
  var byCo = {};
  rows.forEach(function (r) { (byCo[r.company_id] = byCo[r.company_id] || []).push(r); });
  var out = [];
  for (var co in byCo) {
    var acts = (await actualsOf(co, month, month))[month] || {};
    byCo[co].forEach(function (r) {
      var actual = round2(acts[r.category] || 0), pct = actual / Number(r.amount) * 100;
      if (pct >= s.warnAt) out.push({ id: r.id, companyId: co, company: r.company, category: r.category, budget: round2(r.amount), actual: actual, pct: Math.round(pct), over: pct > 100, month: month });
    });
  }
  return out;
}

module.exports = { view: view, spent: spent, save: save, saveSettings: saveSettings, overruns: overruns, actualsOf: actualsOf, CATEGORIES: CATEGORIES };
