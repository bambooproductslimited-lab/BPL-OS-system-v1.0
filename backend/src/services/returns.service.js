var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var fileStore = require('../lib/fileStore');

// Statutory returns (Finance → Statutory returns; migration 0199): each
// company's month of PAYE, SSNIT, VAT and withholding tax, with what is due
// worked out from the OS — PAYE and SSNIT from the approved pay runs, VAT and
// its levies (NHIL, GETFund) from the invoices and the tills' sales, less
// the input VAT on what was bought — and when it falls due: SSNIT by the
// 14th of the month after, PAYE and withholding by the 15th, VAT by the last
// working day of the month after (a weekend due date moves to the working
// day). Each is marked filed and paid, with its reference and receipt; the
// PAYE and SSNIT schedules download for the GRA and SSNIT portals. Reminders
// a week and a day before, and once late (jobs/dailyAlerts.js). Public
// holidays are not known to it.

var KINDS = ['paye', 'ssnit', 'vat', 'wht'];
var NAMES = { paye: 'PAYE', ssnit: 'SSNIT', vat: 'VAT and levies', wht: 'Withholding tax' };
var MONTH = /^\d{4}-\d{2}$/;
var DAY = /^\d{4}-\d{2}-\d{2}$/;
var MAX_RECEIPT = 6 * 1024 * 1024;

function r2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function shift(month, n) { var d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : ''; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function need(ctx) { if (!ctx.can('returns.manage')) fail('forbidden', 'Your role does not allow this action (returns.manage).'); }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function money(n) { return 'GHS ' + r2(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// When a month's return is due.
function dueOn(kind, period) {
  var next = shift(period, 1);
  var d;
  if (kind === 'vat') {
    d = new Date(Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)), 0));
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  } else {
    d = new Date(next + '-' + (kind === 'ssnit' ? '14' : '15') + 'T00:00:00Z');
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

async function companyOf(id) {
  var c = (await pool.query('SELECT id, name, code FROM companies WHERE id = $1', [uuidOr(id)])).rows[0];
  if (!c) fail('invalid', 'Which company?');
  return c;
}

// What the OS holds for a company over some months: payroll, VAT.
async function figures(company, from, to) {
  var a = from + '-01', b = shift(to, 1) + '-01';
  var out = {};
  var at = function (m) { out[m] = out[m] || { paye: 0, ssnit: 0, staff: 0, outputVat: 0, sales: 0 }; return out[m]; };
  (await pool.query(
    "SELECT to_char(pr.period_end, 'YYYY-MM') AS m, sum(s.paye_tax) AS paye, sum(s.ssnit_employee + s.ssnit_employer) AS ssnit, count(DISTINCT s.employee_id)::int AS staff " +
    'FROM payslips s JOIN pay_runs pr ON pr.id = s.pay_run_id JOIN employees e ON e.id = s.employee_id LEFT JOIN departments d ON d.id = e.department_id ' +
    "WHERE pr.status IN ('approved', 'paid') AND coalesce(pr.company_id, d.company_id) = $1 AND pr.period_end >= $2 AND pr.period_end < $3 GROUP BY 1", [company.id, a, b])).rows.forEach(function (r) {
    var x = at(r.m); x.paye = r2(r.paye); x.ssnit = r2(r.ssnit); x.staff = r.staff;
  });
  // Invoices with no company are Bamboo Products' (the shop, the OS before companies).
  (await pool.query(
    "SELECT to_char(issued_at, 'YYYY-MM') AS m, sum(tax_total) AS tax, count(*)::int AS n FROM invoices WHERE status <> 'void' AND issued_at >= $2 AND issued_at < $3 AND (company_id = $1 OR ($4 AND company_id IS NULL)) GROUP BY 1",
    [company.id, a, b, company.code === 'BPL'])).rows.forEach(function (r) { var x = at(r.m); x.outputVat = r2(x.outputVat + Number(r.tax)); x.sales += r.n; });
  (await pool.query(
    "SELECT to_char(created_at, 'YYYY-MM') AS m, sum(tax_total) AS tax, count(*)::int AS n FROM restaurant_orders WHERE status = 'completed' AND company_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1",
    [company.id, a, b])).rows.forEach(function (r) { var x = at(r.m); x.outputVat = r2(x.outputVat + Number(r.tax)); x.sales += r.n; });
  return out;
}
function computed(kind, f, row) {
  f = f || { paye: 0, ssnit: 0, outputVat: 0 };
  if (kind === 'paye') return f.paye;
  if (kind === 'ssnit') return f.ssnit;
  if (kind === 'vat') return r2(f.outputVat - Number(row && row.input_vat || 0));
  return null;
}

// Where a return stands.
function stateOf(kind, period, row, amount) {
  var due = dueOn(kind, period);
  if (row && row.filed_on && !(Number(row.amount != null ? row.amount : amount) > 0) && !(Number(row.paid_amount) > 0)) return 'done';
  if (row && row.paid_on) return 'paid';
  if (row && row.filed_on) return 'filed';
  if (period >= today().slice(0, 7)) return 'upcoming';
  // Nothing to pay and nothing to file — VAT is filed even when nil.
  if (kind !== 'vat' && amount !== null && !(amount > 0)) return 'nothing';
  var left = Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000);
  return left < 0 ? 'overdue' : left <= 14 ? 'due' : 'upcoming';
}

function rowOut(kind, period, row, f) {
  var calc = computed(kind, f, row);
  var amount = row && row.amount != null ? r2(row.amount) : calc;
  return {
    kind: kind, period: period, due: dueOn(kind, period), computed: calc, amount: amount, state: stateOf(kind, period, row, amount),
    filedOn: row ? dayText(row.filed_on) : null, filedRef: row ? row.filed_ref : '', paidOn: row ? dayText(row.paid_on) : null,
    paidAmount: row && row.paid_amount != null ? r2(row.paid_amount) : null, paidRef: row ? row.paid_ref : '', inputVat: row && row.input_vat != null ? r2(row.input_vat) : null,
    receipt: !!(row && row.receipt), note: row ? row.note : ''
  };
}

// GET /api/returns?company= — a year of returns, by kind and month.
async function view(ctx, q) {
  need(ctx);
  q = q || {};
  var companies = (await pool.query('SELECT id, name, code FROM companies ORDER BY name')).rows;
  if (!companies.length) return { companies: [], company: null, months: [], cells: {}, upcoming: [], tiles: {} };
  var company = companies.find(function (c) { return c.id === q.company; }) || companies.find(function (c) { return c.code === 'BPL'; }) || companies[0];
  var thisMonth = today().slice(0, 7);
  var months = [];
  for (var i = 11; i >= 0; i--) months.push(shift(thisMonth, -i));
  var f = await figures(company, months[0], thisMonth);
  // From the first month the OS has anything for this company.
  var firstData = months.find(function (m) { return f[m] && (f[m].paye > 0 || f[m].ssnit > 0 || f[m].sales > 0); }) || thisMonth;
  var rows = (await pool.query("SELECT *, to_char(period, 'YYYY-MM') AS m FROM tax_returns WHERE company_id = $1 AND period >= $2", [company.id, months[0] + '-01'])).rows;
  var firstRow = rows.map(function (r) { return r.m; }).sort()[0];
  var from = firstRow && firstRow < firstData ? firstRow : firstData;
  var cells = {};
  KINDS.forEach(function (k) {
    cells[k] = months.map(function (m) {
      if (m < from) return { kind: k, period: m, due: dueOn(k, m), state: 'before', amount: null };
      return rowOut(k, m, rows.find(function (r) { return r.kind === k && r.m === m; }), f[m]);
    });
  });
  var all = [].concat(cells.paye, cells.ssnit, cells.vat, cells.wht);
  var in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  var upcoming = all.filter(function (c) { return c.state === 'overdue' || c.state === 'due' || (c.state === 'upcoming' && c.period < thisMonth); })
    .concat(KINDS.map(function (k) { return rowOut(k, thisMonth, null, f[thisMonth]); }).filter(function (c) { return c.amount === null || c.amount > 0 || c.kind === 'vat'; }))
    .sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
  var yearStart = thisMonth.slice(0, 4) + '-01-01';
  var paidYear = (await pool.query('SELECT coalesce(sum(coalesce(paid_amount, greatest(amount, 0))), 0) AS s, count(*)::int AS n FROM tax_returns WHERE company_id = $1 AND paid_on >= $2', [company.id, yearStart])).rows[0];
  var soon = upcoming.filter(function (c) { return c.state !== 'overdue' && c.due <= in30; });
  return {
    companies: companies, company: company.id, months: months, kinds: KINDS, cells: cells, upcoming: upcoming.slice(0, 10), today: today(),
    tiles: {
      overdue: all.filter(function (c) { return c.state === 'overdue'; }).length,
      overdueAmount: r2(all.filter(function (c) { return c.state === 'overdue'; }).reduce(function (a, c) { return a + Math.max(0, c.amount || 0); }, 0)),
      dueSoon: soon.length, dueSoonAmount: r2(soon.reduce(function (a, c) { return a + Math.max(0, c.amount || 0); }, 0)),
      paidYear: r2(paidYear.s), paidYearCount: paidYear.n,
      next: soon[0] || null
    }
  };
}

// GET /api/returns/one?company=&kind=&period= — what makes up one return.
async function detail(ctx, q) {
  need(ctx);
  q = q || {};
  var company = await companyOf(q.company);
  var kind = KINDS.indexOf(q.kind) >= 0 ? q.kind : fail('invalid', 'Which return?');
  var period = MONTH.test(String(q.period || '')) ? q.period : fail('invalid', 'Which month?');
  var f = (await figures(company, period, period))[period];
  var row = (await pool.query('SELECT * FROM tax_returns WHERE company_id = $1 AND kind = $2 AND period = $3', [company.id, kind, period + '-01'])).rows[0];
  var out = rowOut(kind, period, row, f);
  out.company = { id: company.id, name: company.name };
  out.name = NAMES[kind];
  if (kind === 'paye' || kind === 'ssnit') {
    var people = await payrollRows(company, period);
    out.people = people;
    out.totals = {
      gross: r2(people.reduce(function (a, p) { return a + p.gross; }, 0)), paye: r2(people.reduce(function (a, p) { return a + p.paye; }, 0)),
      employee: r2(people.reduce(function (a, p) { return a + p.employee; }, 0)), employer: r2(people.reduce(function (a, p) { return a + p.employer; }, 0))
    };
    // The 18.5%: 13.5% to SSNIT (tier 1), 5% to the trustee (tier 2).
    if (kind === 'ssnit') { var t = out.totals.employee + out.totals.employer; out.tiers = { tier1: r2(t * 13.5 / 18.5), tier2: r2(t * 5 / 18.5) }; }
    out.missing = people.filter(function (p) { return kind === 'ssnit' ? !p.ssnitNumber : !p.tin && !p.ghanaCard; }).length;
  }
  if (kind === 'vat') {
    var a = period + '-01', b = shift(period, 1) + '-01';
    var inv = (await pool.query("SELECT count(*)::int AS n, coalesce(sum(subtotal - discount_total), 0) AS net, coalesce(sum(tax_total), 0) AS tax FROM invoices WHERE status <> 'void' AND issued_at >= $2 AND issued_at < $3 AND (company_id = $1 OR ($4 AND company_id IS NULL))", [company.id, a, b, company.code === 'BPL'])).rows[0];
    var till = (await pool.query("SELECT count(*)::int AS n, coalesce(sum(total - tax_total), 0) AS net, coalesce(sum(tax_total), 0) AS tax FROM restaurant_orders WHERE status = 'completed' AND company_id = $1 AND created_at >= $2 AND created_at < $3", [company.id, a, b])).rows[0];
    out.sources = [];
    if (inv.n) out.sources.push({ key: 'invoices', count: inv.n, net: r2(inv.net), tax: r2(inv.tax) });
    if (till.n) out.sources.push({ key: 'till', count: till.n, net: r2(till.net), tax: r2(till.tax) });
    out.output = r2(Number(inv.tax) + Number(till.tax));
  }
  return out;
}

async function payrollRows(company, period) {
  var a = period + '-01', b = shift(period, 1) + '-01';
  return (await pool.query(
    'SELECT e.code, e.first_name, e.last_name, e.ssnit_number, e.tin, e.ghana_card, sum(s.gross_pay) AS gross, sum(s.taxable_income) AS taxable, sum(s.paye_tax) AS paye, ' +
    'sum(coalesce(s.ssnit_salary, s.basic_pay, 0)) AS basic, sum(s.ssnit_employee) AS ee, sum(s.ssnit_employer) AS er ' +
    'FROM payslips s JOIN pay_runs pr ON pr.id = s.pay_run_id JOIN employees e ON e.id = s.employee_id LEFT JOIN departments d ON d.id = e.department_id ' +
    "WHERE pr.status IN ('approved', 'paid') AND coalesce(pr.company_id, d.company_id) = $1 AND pr.period_end >= $2 AND pr.period_end < $3 GROUP BY e.id ORDER BY e.first_name, e.last_name", [company.id, a, b])).rows.map(function (r) {
    return { code: r.code, name: nameOf(r.first_name, r.last_name), ssnitNumber: r.ssnit_number || '', tin: r.tin || '', ghanaCard: r.ghana_card || '',
      gross: r2(r.gross), taxable: r2(r.taxable), paye: r2(r.paye), basic: r2(r.basic), employee: r2(r.ee), employer: r2(r.er) };
  });
}

// A receipt: a photo or a PDF.
async function keepReceipt(dataUrl) {
  var m = /^data:([a-z]+\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) fail('invalid', 'That receipt did not come through: add it again.');
  var buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_RECEIPT) fail('invalid', 'That receipt is too big (6 MB at most).');
  var isPdf = buf.slice(0, 5).toString('latin1') === '%PDF-';
  var img = require('./shopQuotes.service').photoType(buf);
  if (!isPdf && !img) fail('invalid', 'A photo or a PDF of the receipt.');
  var type = isPdf ? 'application/pdf' : img.type;
  return { key: await fileStore.put('return-receipt.' + (isPdf ? 'pdf' : img.ext), buf, type), type: type };
}

// PUT /api/returns { companyId, kind, period, amount, inputVat, filedOn,
// filedRef, paidOn, paidAmount, paidRef, receipt, note }
async function save(ctx, p) {
  need(ctx);
  p = p || {};
  var company = await companyOf(p.companyId);
  var kind = KINDS.indexOf(p.kind) >= 0 ? p.kind : fail('invalid', 'Which return?');
  var period = MONTH.test(String(p.period || '')) ? p.period : fail('invalid', 'Which month?');
  if (period > today().slice(0, 7)) fail('invalid', 'That month has not come yet.');
  var cur = (await pool.query('SELECT * FROM tax_returns WHERE company_id = $1 AND kind = $2 AND period = $3', [company.id, kind, period + '-01'])).rows[0] || {};
  var num = function (k, curVal) {
    if (p[k] === undefined) return curVal == null ? null : Number(curVal);
    if (p[k] === null || p[k] === '') return null;
    var n = r2(p[k]);
    if (!(n >= 0 && n < 1e10)) fail('invalid', 'An amount of 0 or more.');
    return n;
  };
  var date = function (k, curVal) {
    if (p[k] === undefined) return curVal ? dayText(curVal) : null;
    if (!p[k]) return null;
    if (!DAY.test(String(p[k])) || p[k] > today()) fail('invalid', 'Pick a day, today or before.');
    return p[k];
  };
  var f = {
    amount: num('amount', cur.amount), inputVat: kind === 'vat' ? num('inputVat', cur.input_vat) : null,
    filedOn: date('filedOn', cur.filed_on), filedRef: p.filedRef === undefined ? cur.filed_ref || '' : String(p.filedRef).trim().slice(0, 80),
    paidOn: date('paidOn', cur.paid_on), paidAmount: num('paidAmount', cur.paid_amount), paidRef: p.paidRef === undefined ? cur.paid_ref || '' : String(p.paidRef).trim().slice(0, 80),
    note: p.note === undefined ? cur.note || '' : String(p.note).trim().slice(0, 500), receipt: cur.receipt || null
  };
  if (kind === 'wht' && f.filedOn && f.amount == null) fail('invalid', 'How much withholding tax was filed?');
  // Filed: what the return said stays, even if payroll or sales change later.
  if (f.filedOn && f.amount == null) f.amount = computed(kind, (await figures(company, period, period))[period], { input_vat: f.inputVat });
  if (f.paidOn && !f.filedOn) f.filedOn = f.paidOn;
  if (p.receipt) f.receipt = await keepReceipt(p.receipt);
  if (p.receipt === null) f.receipt = null;
  await pool.query(
    'INSERT INTO tax_returns (company_id, kind, period, amount, input_vat, filed_on, filed_ref, paid_on, paid_amount, paid_ref, receipt, note, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ' +
    'ON CONFLICT (company_id, kind, period) DO UPDATE SET amount = EXCLUDED.amount, input_vat = EXCLUDED.input_vat, filed_on = EXCLUDED.filed_on, filed_ref = EXCLUDED.filed_ref, paid_on = EXCLUDED.paid_on, ' +
    'paid_amount = EXCLUDED.paid_amount, paid_ref = EXCLUDED.paid_ref, receipt = EXCLUDED.receipt, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()',
    [company.id, kind, period + '-01', f.amount, f.inputVat, f.filedOn, f.filedRef, f.paidOn, f.paidAmount, f.paidRef, f.receipt, f.note, me(ctx)]);
  await audit(pool, ctx, 'returns.save', 'company', company.id, NAMES[kind] + ' ' + period + ', ' + company.name + ': ' + (f.paidOn ? 'paid ' + f.paidOn + (f.paidAmount != null ? ' (' + money(f.paidAmount) + ')' : '') : f.filedOn ? 'filed ' + f.filedOn : 'details saved') + '.');
  return detail(ctx, { company: company.id, kind: kind, period: period });
}

// POST /api/returns/settle { companyId, before } — returns from before the
// OS: marked as filed outside it, so they stop showing as late.
async function settleBefore(ctx, p) {
  need(ctx);
  p = p || {};
  var company = await companyOf(p.companyId);
  var before = MONTH.test(String(p.before || '')) ? p.before : fail('invalid', 'Up to which month?');
  var v = await view(ctx, { company: company.id });
  var n = 0;
  for (var k = 0; k < KINDS.length; k++) {
    var list = v.cells[KINDS[k]].filter(function (c) { return c.period < before && (c.state === 'overdue' || c.state === 'due'); });
    for (var i = 0; i < list.length; i++) {
      await pool.query("INSERT INTO tax_returns (company_id, kind, period, filed_on, paid_on, note, updated_by) VALUES ($1,$2,$3,$4,$4,'Filed and paid outside the OS',$5) ON CONFLICT (company_id, kind, period) DO UPDATE SET filed_on = coalesce(tax_returns.filed_on, EXCLUDED.filed_on), paid_on = coalesce(tax_returns.paid_on, EXCLUDED.paid_on), note = EXCLUDED.note, updated_at = now()",
        [company.id, KINDS[k], list[i].period + '-01', list[i].due, me(ctx)]);
      n++;
    }
  }
  await audit(pool, ctx, 'returns.settle', 'company', company.id, n + ' returns before ' + before + ' marked as dealt with outside the OS.');
  var out = await view(ctx, { company: company.id });
  out.settled = n;
  return out;
}

// GET /api/returns/schedule?company=&kind=&period= — the CSV for the portal.
async function schedule(ctx, q) {
  var d = await detail(ctx, q);
  var cell = function (v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  var lines = [];
  if (d.kind === 'paye') {
    lines.push(['Staff code', 'Name', 'TIN', 'Ghana Card', 'Gross pay', 'Taxable income', 'PAYE'].join(','));
    d.people.forEach(function (p) { lines.push([p.code, p.name, p.tin, p.ghanaCard, p.gross.toFixed(2), p.taxable.toFixed(2), p.paye.toFixed(2)].map(cell).join(',')); });
    lines.push(['', 'Total', '', '', d.totals.gross.toFixed(2), '', d.totals.paye.toFixed(2)].map(cell).join(','));
  } else if (d.kind === 'ssnit') {
    lines.push(['Staff code', 'Name', 'SSNIT number', 'Ghana Card', 'Basic salary', 'Employee 5.5%', 'Employer 13%', 'Total 18.5%'].join(','));
    d.people.forEach(function (p) { lines.push([p.code, p.name, p.ssnitNumber, p.ghanaCard, p.basic.toFixed(2), p.employee.toFixed(2), p.employer.toFixed(2), r2(p.employee + p.employer).toFixed(2)].map(cell).join(',')); });
    lines.push(['', 'Total', '', '', '', d.totals.employee.toFixed(2), d.totals.employer.toFixed(2), r2(d.totals.employee + d.totals.employer).toFixed(2)].map(cell).join(','));
    lines.push(['', 'Tier 1 (13.5%)', '', '', '', '', '', d.tiers.tier1.toFixed(2)].map(cell).join(','));
    lines.push(['', 'Tier 2 (5%)', '', '', '', '', '', d.tiers.tier2.toFixed(2)].map(cell).join(','));
  } else fail('invalid', 'Schedules are for PAYE and SSNIT.');
  return { filename: d.company.name.replace(/[^A-Za-z0-9]+/g, '-') + '-' + d.kind + '-' + d.period + '.csv', csv: lines.join('\r\n') + '\r\n' };
}

async function receiptOf(ctx, q) {
  need(ctx);
  var row = (await pool.query('SELECT receipt FROM tax_returns WHERE company_id = $1 AND kind = $2 AND period = $3', [uuidOr(q.company), q.kind, (MONTH.test(String(q.period || '')) ? q.period : '1900-01') + '-01'])).rows[0];
  if (!row || !row.receipt) fail('notfound', 'No receipt.');
  return row.receipt;
}

// For the daily round: last months' returns not yet filed, every company.
async function dueSoon() {
  var companies = (await pool.query('SELECT id, name, code FROM companies')).rows;
  var thisMonth = today().slice(0, 7);
  var out = [];
  for (var c = 0; c < companies.length; c++) {
    var f = await figures(companies[c], shift(thisMonth, -3), shift(thisMonth, -1));
    var rows = (await pool.query("SELECT *, to_char(period, 'YYYY-MM') AS m FROM tax_returns WHERE company_id = $1 AND period >= $2", [companies[c].id, shift(thisMonth, -3) + '-01'])).rows;
    for (var m = -3; m <= -1; m++) {
      var period = shift(thisMonth, m);
      if (!f[period]) continue;
      KINDS.forEach(function (k) {
        var x = rowOut(k, period, rows.find(function (r) { return r.kind === k && r.m === period; }), f[period]);
        if (x.state === 'due' || x.state === 'overdue') out.push(Object.assign(x, { companyId: companies[c].id, company: companies[c].name, name: NAMES[k] }));
      });
    }
  }
  return out;
}

module.exports = { view: view, detail: detail, save: save, settleBefore: settleBefore, schedule: schedule, receiptOf: receiptOf, dueSoon: dueSoon, dueOn: dueOn, KINDS: KINDS, NAMES: NAMES };
