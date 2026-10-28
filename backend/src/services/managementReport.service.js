var path = require('path');
var fs = require('fs');
var PDFDocument = require('pdfkit');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// The monthly management report (migration 0203): one page-turn of the
// month for the owners — sales by company against the month before, the
// margins (the bills of materials, the restaurants' food cost), what was
// spent by category (budgets.service.js's figures), the cash that came in
// and went out with what is still owed both ways, stock and production,
// power, people, safety, and the licences ending soon. Built as a PDF on the
// server, downloaded or emailed to the owners — by hand, or on its own on
// the 1st for the month just ended (jobs/dailyAlerts.js).

var MONTH = /^\d{4}-\d{2}$/;
var LOGO = path.join(__dirname, '..', '..', 'assets', 'logo.png');
var GREEN = '#2f7d4f', INK = '#1d1d1b', MUTED = '#55524e', FAINT = '#8a867f', LINE = '#dedbd5', PALE = '#f3f6f1', RED = '#b3261e', AMBER = '#a3610a';
var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
var MAX_TO = 10;

function round1(n) { return Math.round(Number(n || 0) * 10) / 10; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function shift(month, n) { var d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); }
function lastDay(month) { return new Date(Date.parse(shift(month, 1) + '-01T00:00:00Z') - 86400000).toISOString().slice(0, 10); }
function monthLabel(month) { return MONTH_NAMES[Number(month.slice(5, 7)) - 1] + ' ' + month.slice(0, 4); }
function change(now, before) { return before > 0 ? Math.round((now - before) / before * 1000) / 10 : null; }
function need(ctx) { if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).'); }
function needSettings(ctx) { if (!ctx.can('report.manage') && !ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (report.manage).'); }
function monthOf(v) {
  if (!v) return shift(today().slice(0, 7), -1);
  if (!MONTH.test(String(v))) fail('invalid', 'Pick a month.');
  if (String(v) > today().slice(0, 7)) fail('invalid', 'That month has not begun.');
  return String(v);
}

async function settingsOf() {
  var s = ((await pool.query('SELECT management_report FROM settings WHERE id = 1')).rows[0] || {}).management_report || {};
  var mail = require('./mail.service');
  return {
    recipients: (Array.isArray(s.recipients) ? s.recipients : []).map(function (e) { return String(e || '').trim().toLowerCase(); }).filter(function (e) { return mail.isEmail(e); }).slice(0, MAX_TO),
    autoSend: !!s.autoSend
  };
}

// ---- the figures --------------------------------------------------------

async function companies() {
  return (await pool.query(
    "SELECT c.id, c.code, c.name, EXISTS (SELECT 1 FROM restaurant_menu_items m WHERE m.company_id = c.id) AS restaurant FROM companies c WHERE coalesce(c.status, 'active') = 'active' ORDER BY (c.code = 'BPL') DESC, c.name")).rows;
}

async function salesOf(c, from, to) {
  if (c.restaurant) {
    var r = (await pool.query(
      "SELECT count(*)::int AS n, coalesce(sum(o.total - o.refunded_total), 0) AS net FROM restaurant_orders o WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at >= $2::date AND o.created_at < $3::date + 1", [c.id, from, to])).rows[0];
    var fc = (await pool.query(
      "SELECT coalesce(sum(i.qty * i.unit_cost) FILTER (WHERE i.unit_cost IS NOT NULL), 0) AS cost, coalesce(sum(i.line_total) FILTER (WHERE i.unit_cost IS NOT NULL), 0) AS revenue " +
      "FROM restaurant_order_items i JOIN restaurant_orders o ON o.id = i.order_id WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at >= $2::date AND o.created_at < $3::date + 1", [c.id, from, to])).rows[0];
    return { sales: round2(r.net), count: r.n, countWord: 'orders', average: r.n ? round2(r.net / r.n) : null, foodCost: Number(fc.revenue) > 0 ? round1(fc.cost / fc.revenue * 100) : null };
  }
  var inv = (await pool.query(
    "SELECT count(*)::int AS n, coalesce(sum(grand_total), 0) AS total FROM invoices WHERE status <> 'void' AND coalesce(doc_kind, 'sale') = 'sale' AND issued_at >= $2::date AND issued_at < $3::date + 1 AND " +
    (c.code === 'BPL' ? '(company_id = $1 OR company_id IS NULL)' : 'company_id = $1'), [c.id, from, to])).rows[0];
  return { sales: round2(inv.total), count: inv.n, countWord: 'invoices', average: inv.n ? round2(inv.total / inv.n) : null, foodCost: null };
}

async function build(month) {
  var from = month + '-01', to = lastDay(month), prev = shift(month, -1), pfrom = prev + '-01', pto = lastDay(prev);
  var cos = await companies();
  var budgets = require('./budgets.service');
  var sales = [], spending = [];
  for (var i = 0; i < cos.length; i++) {
    var c = cos[i];
    var now = await salesOf(c, from, to), before = await salesOf(c, pfrom, pto);
    if (now.sales || before.sales || c.code === 'BPL') sales.push({ code: c.code, name: c.name, restaurant: c.restaurant, sales: now.sales, before: before.sales, change: change(now.sales, before.sales), count: now.count, countWord: now.countWord, average: now.average, foodCost: now.foodCost });
    var spent = ((await budgets.actualsOf(c.id, month, month))[month]) || {};
    var spentBefore = ((await budgets.actualsOf(c.id, prev, prev))[prev]) || {};
    var total = Object.keys(spent).reduce(function (a, k) { return a + spent[k]; }, 0);
    var totalBefore = Object.keys(spentBefore).reduce(function (a, k) { return a + spentBefore[k]; }, 0);
    if (total || totalBefore) {
      var cats = Object.keys(spent).map(function (k) { return { category: k, amount: round2(spent[k]) }; }).sort(function (a, b) { return b.amount - a.amount; });
      spending.push({ code: c.code, name: c.name, total: round2(total), before: round2(totalBefore), change: change(total, totalBefore), categories: cats });
    }
  }
  var salesTotal = round2(sales.reduce(function (a, s) { return a + s.sales; }, 0));
  var salesBefore = round2(sales.reduce(function (a, s) { return a + s.before; }, 0));
  var spendTotal = round2(spending.reduce(function (a, s) { return a + s.total; }, 0));

  // Margins: the bills of materials, and the restaurants' food cost.
  var bomView = null;
  try {
    var bom = require('./bom.service');
    var data = await bom.load(), memo = {};
    var rows = Object.keys(data.products).filter(function (id) { return (data.lines[id] || []).length || data.costs[id]; }).map(function (id) {
      var p = data.products[id], r = bom.rollup(data, id, memo, []), price = Number(p.selling_price);
      return { name: p.name, price: price, cost: round2(r.total), marginPct: price > 0 ? round1((price - r.total) / price * 100) : null };
    }).filter(function (r) { return r.marginPct != null; });
    if (rows.length) {
      rows.sort(function (a, b) { return a.marginPct - b.marginPct; });
      bomView = { costed: rows.length, average: round1(rows.reduce(function (a, r) { return a + r.marginPct; }, 0) / rows.length), low: rows.filter(function (r) { return r.marginPct < bom.LOW_MARGIN; }).length, lowest: rows.slice(0, 3) };
    }
  } catch (e) { bomView = null; }

  // Cash: in, out, and what is owed both ways at the end of the month.
  var collected = Number((await pool.query('SELECT coalesce(sum(amount), 0) AS s FROM payments WHERE date >= $1 AND date <= $2', [from, to])).rows[0].s);
  var billsPaid = Number((await pool.query('SELECT coalesce(sum(amount), 0) AS s FROM supplier_bill_payments WHERE paid_on >= $1 AND paid_on <= $2', [from, to])).rows[0].s);
  var payroll = spending.reduce(function (a, s) { var p = s.categories.find(function (x) { return x.category === 'payroll'; }); return a + (p ? p.amount : 0); }, 0);
  var owedToUs = (await pool.query("SELECT count(*)::int AS n, coalesce(sum(balance_due), 0) AS s, coalesce(sum(balance_due) FILTER (WHERE due_date < $1), 0) AS late FROM invoices WHERE status <> 'void' AND balance_due > 0 AND issued_at < $1::date + 1", [to])).rows[0];
  var weOwe = (await pool.query("SELECT count(*)::int AS n, coalesce(sum(amount - paid), 0) AS s, coalesce(sum(amount - paid) FILTER (WHERE due_date < $1), 0) AS late FROM supplier_bills WHERE status IN ('to_approve', 'approved') AND bill_date <= $1", [to])).rows[0];
  var banks = (await pool.query(
    "SELECT a.name, a.currency, c.code, (SELECT l.balance FROM bank_lines l WHERE l.account_id = a.id AND l.day <= $1 AND l.balance IS NOT NULL ORDER BY l.day DESC, l.created_at DESC LIMIT 1) AS balance " +
    'FROM bank_accounts a JOIN companies c ON c.id = a.company_id WHERE a.active ORDER BY c.code, a.name', [to])).rows
    .filter(function (b) { return b.balance != null; }).map(function (b) { return { name: b.name, code: b.code, currency: b.currency, balance: round2(b.balance) }; });

  // Stock and production.
  var stock = (await pool.query("SELECT coalesce(sum(greatest(current_stock, 0) * cost_price), 0) AS value, count(*) FILTER (WHERE reorder_level > 0 AND current_stock <= reorder_level)::int AS low FROM products WHERE active")).rows[0];
  var raw = (await pool.query("SELECT unit, coalesce(sum(quantity), 0) AS q FROM raw_batches WHERE status = 'in_stock' AND quantity > 0 GROUP BY unit ORDER BY 2 DESC")).rows.map(function (r) { return { unit: r.unit, qty: round2(r.q) }; });
  var jobs = await require('./productionJobs.service').monthFigures(from, to);
  var outgrowers = await require('./outgrowers.service').monthFigures(from, to);
  var power = await require('./power.service').monthFigures(from, to);
  var rfq = (await pool.query("SELECT count(*)::int AS n FROM rfqs WHERE status = 'awarded' AND awarded_at >= $1::date AND awarded_at < $2::date + 1", [from, to])).rows[0].n;

  // People.
  var headcount = (await pool.query("SELECT count(*)::int AS n FROM employees WHERE status = 'active'")).rows[0].n;
  var joined = (await pool.query('SELECT count(*)::int AS n FROM employees WHERE hire_date >= $1 AND hire_date <= $2', [from, to])).rows[0].n;
  var left = (await pool.query("SELECT count(*)::int AS n FROM onboard_lists WHERE kind = 'leave' AND status <> 'cancelled' AND day >= $1 AND day <= $2", [from, to])).rows[0].n;
  var leave = (await pool.query("SELECT coalesce(sum(days), 0) AS d, count(*)::int AS n FROM leave_requests WHERE status = 'approved' AND start_date >= $1 AND start_date <= $2", [from, to])).rows[0];
  var att = (await pool.query("SELECT count(*) FILTER (WHERE status = 'present')::int AS present, count(*) FILTER (WHERE status = 'late')::int AS late, count(*) FILTER (WHERE status = 'absent')::int AS absent FROM attendance WHERE date >= $1 AND date <= $2", [from, to])).rows[0];
  var came = att.present + att.late;

  // Safety.
  var inc = (await pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE severity IN ('high', 'critical'))::int AS serious, count(*) FILTER (WHERE kind = 'near_miss')::int AS near, coalesce(sum(lost_days), 0)::int AS lost FROM incidents WHERE occurred_at >= $1::date AND occurred_at < $2::date + 1", [from, to])).rows[0];
  var lastLost = (await pool.query('SELECT max(occurred_at) AS at FROM incidents WHERE lost_days > 0 AND occurred_at < $1::date + 1', [to])).rows[0].at;

  // Licences ending in the next 60 days.
  var licences = (await require('./licences.service').dueSoon()).map(function (l) {
    return { title: l.title, company: l.company_code || l.company || '', expires: dayText(l.expires_on), renewing: l.status === 'renewing' };
  }).sort(function (a, b) { return a.expires.localeCompare(b.expires); }).slice(0, 12);

  return {
    month: month, label: monthLabel(month), prevLabel: monthLabel(prev), from: from, to: to, made: new Date().toISOString(),
    sales: { companies: sales, total: salesTotal, before: salesBefore, change: change(salesTotal, salesBefore) },
    margins: { bom: bomView, food: sales.filter(function (s) { return s.restaurant && s.foodCost != null; }).map(function (s) { return { code: s.code, name: s.name, foodCost: s.foodCost }; }) },
    spending: { companies: spending, total: spendTotal },
    cash: {
      collected: round2(collected), billsPaid: round2(billsPaid), payroll: round2(payroll),
      owedToUs: { n: owedToUs.n, amount: round2(owedToUs.s), late: round2(owedToUs.late) }, weOwe: { n: weOwe.n, amount: round2(weOwe.s), late: round2(weOwe.late) }, banks: banks
    },
    stock: { value: round2(stock.value), low: stock.low, raw: raw, jobs: jobs, outgrowers: outgrowers, rfqs: rfq },
    power: power,
    people: { headcount: headcount, joined: joined, left: left, leaveDays: round1(leave.d), leaveRequests: leave.n, late: att.late, absent: att.absent, latePct: came ? round1(att.late / came * 100) : null },
    safety: { incidents: inc.n, serious: inc.serious, nearMisses: inc.near, lostDays: inc.lost, daysSinceLost: lastLost ? Math.floor((Date.parse(to + 'T23:59:59Z') - new Date(lastLost).getTime()) / 86400000) : null },
    licences: licences
  };
}

// ---- the PDF ------------------------------------------------------------

function clean(s) {
  return String(s == null ? '' : s).replace(/[−]/g, '-').replace(/[^\u0009\u000a -~ -ÿ–—‘’“”•…€™]/g, '?');
}
function cedis(n) { return 'GHS ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function pct(n) { return n == null ? '—' : (n > 0 ? '+' : '') + n + '%'; }
function longDate(day) { var d = new Date(day + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MONTH_NAMES[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear(); }

var CATEGORY = { payroll: 'Payroll', stock: 'Stock', utilities: 'Utilities', rent: 'Rent', services: 'Services', equipment: 'Equipment', transport: 'Transport', fuel: 'Fuel', expenses: 'Expenses', staff: 'Staff', other: 'Other' };

function pdfOf(r) {
  return new Promise(function (resolve, reject) {
    var doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true, info: { Title: 'Monthly management report — ' + r.label, Author: 'Bamboo OS' } });
    var chunks = [];
    doc.on('data', function (c) { chunks.push(c); });
    doc.on('end', function () { resolve(Buffer.concat(chunks)); });
    doc.on('error', reject);
    var L = doc.page.margins.left, W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    var bottom = function () { return doc.page.height - doc.page.margins.bottom - 20; };
    var room = function (h) { if (doc.y + h > bottom()) doc.addPage(); };

    // The head: a green band with the month.
    doc.rect(0, 0, doc.page.width, 108).fill(GREEN);
    if (fs.existsSync(LOGO)) { try { doc.save(); doc.roundedRect(L, 26, 56, 56, 10).fill('#ffffff'); doc.image(LOGO, L + 6, 32, { fit: [44, 44] }); doc.restore(); } catch (e) { /* no logo */ } }
    doc.fillColor('#ffffff').font('Helvetica').fontSize(10).text('BAMBOO PRODUCTS LIMITED · THE GROUP', L + 72, 30, { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(22).text('Monthly management report', L + 72, 44);
    doc.font('Helvetica').fontSize(12).text(clean(r.label) + ' · against ' + clean(r.prevLabel), L + 72, 72);
    doc.fillColor(INK);
    doc.y = 126;

    // Four headline tiles.
    var tiles = [
      { label: 'Sales', value: cedis(r.sales.total), note: r.sales.change == null ? 'nothing to set against ' + r.prevLabel.split(' ')[0] : pct(r.sales.change) + ' on ' + r.prevLabel.split(' ')[0], tone: r.sales.change == null ? MUTED : r.sales.change >= 0 ? GREEN : RED },
      { label: 'Spent', value: cedis(r.spending.total), note: 'bills, payroll, expenses, fuel', tone: MUTED },
      { label: 'Cash collected', value: cedis(r.cash.collected), note: cedis(r.cash.owedToUs.late) + ' overdue', tone: r.cash.owedToUs.late > 0 ? AMBER : GREEN },
      { label: 'People', value: String(r.people.headcount), note: '+' + r.people.joined + ' joined · ' + r.people.left + ' left', tone: MUTED }
    ];
    var tw = (W - 3 * 10) / 4, ty = doc.y;
    tiles.forEach(function (t, i) {
      var x = L + i * (tw + 10);
      doc.roundedRect(x, ty, tw, 66, 8).fill(PALE);
      doc.fillColor(FAINT).font('Helvetica').fontSize(8.5).text(t.label.toUpperCase(), x + 10, ty + 9, { width: tw - 20, characterSpacing: 0.6 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(clean(t.value), x + 10, ty + 23, { width: tw - 20 });
      doc.fillColor(t.tone).font('Helvetica').fontSize(8.5).text(clean(t.note), x + 10, ty + 45, { width: tw - 20 });
    });
    doc.y = ty + 82;

    function heading(title, sub) {
      room(60);
      var y = doc.y + 6;
      doc.rect(L, y + 2, 4, 14).fill(GREEN);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(clean(title), L + 12, y);
      if (sub) doc.fillColor(FAINT).font('Helvetica').fontSize(9).text(clean(sub), L + 12, doc.y + 1);
      doc.y += 6;
      doc.fillColor(INK);
    }
    // A table: cols [{ label, width (share), align }], rows of strings; tone per cell optional.
    function table(cols, rows, opts) {
      opts = opts || {};
      var total = cols.reduce(function (a, c) { return a + c.w; }, 0);
      var xs = [], x = L;
      cols.forEach(function (c) { xs.push(x); x += W * c.w / total; });
      var widthOf = function (i) { return W * cols[i].w / total - 8; };
      room(24 + Math.min(rows.length, 3) * 18);
      var y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(FAINT);
      cols.forEach(function (c, i) { doc.text(c.label.toUpperCase(), xs[i] + 4, y, { width: widthOf(i), align: c.align || 'left', characterSpacing: 0.4 }); });
      y += 14;
      doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.6).strokeColor(LINE).stroke();
      rows.forEach(function (row, ri) {
        if (y + 20 > bottom()) { doc.addPage(); y = doc.y; }
        var strong = opts.strongLast && ri === rows.length - 1;
        if (strong) doc.rect(L, y + 1, W, 18).fill(PALE);
        row.forEach(function (cell, i) {
          var v = cell && typeof cell === 'object' ? cell : { t: cell };
          doc.font(strong || (i === 0 && !opts.plainFirst) ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(v.c || INK)
            .text(clean(v.t == null ? '—' : v.t), xs[i] + 4, y + 5, { width: widthOf(i), height: 12, align: cols[i].align || 'left', ellipsis: true });
        });
        y += 19;
        doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.4).strokeColor(LINE).stroke();
      });
      doc.y = y + 10;
      doc.x = L;
    }
    // Facts in two columns: [label, value].
    function facts(list) {
      var half = Math.ceil(list.length / 2), cw = (W - 20) / 2;
      room(Math.min(half, 4) * 18 + 10);
      var y0 = doc.y, y = y0, yMax = y0;
      list.forEach(function (f, i) {
        var col = i < half ? 0 : 1;
        if (i === half) y = y0;
        var x = L + col * (cw + 20);
        doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(clean(f[0]), x, y, { width: cw * 0.6 });
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(f[2] || INK).text(clean(f[1]), x + cw * 0.6, y, { width: cw * 0.4, align: 'right' });
        y += 17;
        doc.moveTo(x, y - 3).lineTo(x + cw, y - 3).lineWidth(0.3).strokeColor(LINE).stroke();
        yMax = Math.max(yMax, y);
      });
      doc.y = yMax + 8;
      doc.x = L;
    }

    // Sales.
    heading('Sales by company', 'Invoiced (Bamboo Products, Poki) or sold at the till (the restaurants), against ' + r.prevLabel + '.');
    var rows = r.sales.companies.map(function (s) {
      return [s.name, cedis(s.sales), cedis(s.before), { t: pct(s.change), c: s.change == null ? FAINT : s.change >= 0 ? GREEN : RED }, s.count + ' ' + s.countWord, s.average == null ? '—' : cedis(s.average), s.foodCost == null ? '' : s.foodCost + '%'];
    });
    rows.push(['All', cedis(r.sales.total), cedis(r.sales.before), { t: pct(r.sales.change), c: r.sales.change == null ? FAINT : r.sales.change >= 0 ? GREEN : RED }, '', '', '']);
    var food = r.sales.companies.some(function (s) { return s.foodCost != null; });
    if (!food) rows.forEach(function (row) { row.pop(); });
    table([{ label: 'Company', w: 2.6 }, { label: r.label.split(' ')[0], w: 1.3, align: 'right' }, { label: r.prevLabel.split(' ')[0], w: 1.3, align: 'right' }, { label: 'Change', w: 0.9, align: 'right' },
      { label: 'How many', w: 1.2, align: 'right' }, { label: 'Average', w: 1.3, align: 'right' }].concat(food ? [{ label: 'Food cost', w: 1.1, align: 'right' }] : []), rows, { strongLast: true });
    // Bars: this month and the one before, by company.
    var maxSale = Math.max.apply(null, [1].concat(r.sales.companies.map(function (s) { return Math.max(s.sales, s.before); })));
    room(r.sales.companies.length * 22 + 20);
    r.sales.companies.forEach(function (s) {
      var y = doc.y, bw = W - 150;
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(clean(s.code), L, y + 2, { width: 40 });
      doc.roundedRect(L + 44, y, Math.max(2, bw * s.sales / maxSale), 8, 2).fill(GREEN);
      doc.roundedRect(L + 44, y + 10, Math.max(2, bw * s.before / maxSale), 5, 2).fill('#b9cfbf');
      doc.fillColor(INK).fontSize(8.5).text(cedis(s.sales), L + 50 + bw, y + 1, { width: 100, align: 'left' });
      doc.y = y + 22;
    });
    doc.font('Helvetica').fontSize(8).fillColor(FAINT).text('Dark: ' + r.label + '. Light: ' + r.prevLabel + '.', L, doc.y);
    doc.y += 8;

    // Margins.
    heading('Margins', 'What each product leaves on its bill of materials, and the restaurants\' food cost.');
    var m = [];
    if (r.margins.bom) {
      m.push(['Products costed', String(r.margins.bom.costed)], ['Average margin', r.margins.bom.average + '%', r.margins.bom.average < 20 ? RED : GREEN], ['Under 20% margin', String(r.margins.bom.low), r.margins.bom.low ? AMBER : INK]);
      r.margins.bom.lowest.forEach(function (x) { m.push(['Lowest: ' + x.name, x.marginPct + '%', x.marginPct < 20 ? RED : INK]); });
    } else m.push(['Products costed', 'none yet']);
    r.margins.food.forEach(function (f) { m.push(['Food cost, ' + f.name, f.foodCost + '%', f.foodCost > 35 ? AMBER : GREEN]); });
    facts(m);

    // Spending.
    heading('What was spent', 'Supplier bills by category, payroll with the employer\'s SSNIT, expense sheets and vehicle fuel.');
    if (!r.spending.companies.length) { doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text('Nothing recorded this month.', L, doc.y); doc.y += 12; }
    else {
      var sRows = r.spending.companies.map(function (s) {
        var top = s.categories.slice(0, 3).map(function (c) { return (CATEGORY[c.category] || c.category) + ' ' + cedis(c.amount); }).join(' · ');
        return [s.name, top, cedis(s.total), { t: pct(s.change), c: s.change == null ? FAINT : s.change <= 0 ? GREEN : AMBER }];
      });
      sRows.push(['All', '', cedis(r.spending.total), '']);
      table([{ label: 'Company', w: 2 }, { label: 'Most of it', w: 4.4, plain: true }, { label: 'Total', w: 1.4, align: 'right' }, { label: 'Change', w: 1, align: 'right' }], sRows, { strongLast: true });
    }

    // Cash.
    heading('Cash', 'What came in and went out in the month, and what is owed at its end.');
    var cash = [
      ['Collected from customers', cedis(r.cash.collected), GREEN], ['Supplier bills paid', cedis(r.cash.billsPaid)], ['Payroll and SSNIT', cedis(r.cash.payroll)],
      ['Owed to us (' + r.cash.owedToUs.n + ' invoices)', cedis(r.cash.owedToUs.amount)], ['of which overdue', cedis(r.cash.owedToUs.late), r.cash.owedToUs.late > 0 ? AMBER : INK],
      ['We owe suppliers (' + r.cash.weOwe.n + ' bills)', cedis(r.cash.weOwe.amount)], ['of which overdue', cedis(r.cash.weOwe.late), r.cash.weOwe.late > 0 ? RED : INK]
    ];
    r.cash.banks.forEach(function (b) { cash.push([b.code + ' · ' + b.name, (b.currency || 'GHS') + ' ' + Number(b.balance).toLocaleString('en-US', { maximumFractionDigits: 0 })]); });
    facts(cash);

    // Stock and production.
    heading('Stock and production', 'Bamboo Products: the stock, the jobs finished, the bamboo bought from outgrowers.');
    var st = [['Stock at cost', cedis(r.stock.value)], ['Products at or under reorder', String(r.stock.low), r.stock.low ? AMBER : INK]];
    r.stock.raw.slice(0, 2).forEach(function (x) { st.push(['Raw bamboo in store', x.qty.toLocaleString('en-US') + ' ' + x.unit]); });
    st.push(['Jobs finished', String(r.stock.jobs.jobs)], ['Made (good)', r.stock.jobs.good.toLocaleString('en-US') + ' · ' + cedis(r.stock.jobs.value)], ['Spoilt', r.stock.jobs.scrapPct == null ? '—' : r.stock.jobs.scrapPct + '%', r.stock.jobs.scrapPct > 5 ? AMBER : INK]);
    st.push(['Outgrowers paid', r.stock.outgrowers.payments + ' · ' + cedis(r.stock.outgrowers.paid)], ['Advanced to outgrowers', cedis(r.stock.outgrowers.advanced)], ['Quotes awarded', String(r.stock.rfqs)]);
    facts(st);

    // Power.
    heading('Power', 'Power cuts, generator hours and fuel, prepaid electricity — every site.');
    facts([
      ['Power cuts', String(r.power.outages)], ['Hours without power', String(r.power.offHours), r.power.offHours > 24 ? AMBER : INK], ['Generator hours', String(r.power.genHours)],
      ['Fuel bought', r.power.litres + ' L · ' + cedis(r.power.fuelCost)], ['A generator hour costs', r.power.costPerHour == null ? '—' : cedis(r.power.costPerHour)], ['Prepaid electricity', cedis(r.power.prepaid)]
    ]);

    // People and safety.
    heading('People and safety');
    facts([
      ['Working here', String(r.people.headcount)], ['Joined', String(r.people.joined)], ['Left', String(r.people.left)],
      ['Leave taken', r.people.leaveDays + ' days (' + r.people.leaveRequests + ')'], ['Late arrivals', r.people.late + (r.people.latePct == null ? '' : ' · ' + r.people.latePct + '%'), r.people.latePct > 10 ? AMBER : INK], ['Absent days', String(r.people.absent)],
      ['Incidents', String(r.safety.incidents)], ['Serious', String(r.safety.serious), r.safety.serious ? RED : INK], ['Near misses', String(r.safety.nearMisses)],
      ['Days lost to injury', String(r.safety.lostDays), r.safety.lostDays ? AMBER : INK], ['Days since a lost-time injury', r.safety.daysSinceLost == null ? 'none recorded' : String(r.safety.daysSinceLost), GREEN]
    ]);

    // Licences.
    heading('Licences and permits ending soon', 'Within 60 days of ' + longDate(today()) + '.');
    if (!r.licences.length) { doc.font('Helvetica').fontSize(9.5).fillColor(GREEN).text('None ending in the next 60 days.', L, doc.y); doc.y += 12; }
    else table([{ label: 'Licence', w: 4 }, { label: 'Company', w: 1.2 }, { label: 'Ends', w: 1.4, align: 'right' }, { label: '', w: 1.6, align: 'right' }],
      r.licences.map(function (l) { return [l.title, l.company, { t: longDate(l.expires), c: l.expires < today() ? RED : INK }, l.renewing ? { t: 'renewal applied for', c: GREEN } : l.expires < today() ? { t: 'expired', c: RED } : { t: 'to renew', c: AMBER }]; }));

    // Page numbers.
    var range = doc.bufferedPageRange();
    for (var p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      var by = doc.page.height - 30;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor(FAINT)
        .text('Bamboo OS · monthly management report · ' + clean(r.label) + ' · made ' + longDate(r.made.slice(0, 10)), L, by, { width: W * 0.75, lineBreak: false })
        .text('Page ' + (p - range.start + 1) + ' of ' + range.count, L + W * 0.75, by, { width: W * 0.25, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

// ---- the endpoints --------------------------------------------------------

// GET /api/management-report?month=YYYY-MM
async function view(ctx, q) {
  need(ctx);
  var month = monthOf((q || {}).month);
  var report = await build(month);
  var sent = (await pool.query('SELECT r.*, e.first_name, e.last_name FROM management_reports r LEFT JOIN employees e ON e.id = r.sent_by ORDER BY r.month DESC LIMIT 12')).rows.map(function (s) {
    return { month: s.month, label: monthLabel(s.month), at: s.sent_at, to: s.sent_to, auto: s.auto, by: s.first_name ? (s.first_name + ' ' + (s.last_name || '')).trim() : null };
  });
  var months = [];
  for (var i = 0; i < 12; i++) months.push(shift(today().slice(0, 7), -i));
  return Object.assign(report, {
    settings: await settingsOf(), sent: sent, months: months.map(function (m) { return { month: m, label: monthLabel(m) }; }),
    canSettings: ctx.can('report.manage') || ctx.can('settings.manage'), emailOn: require('./mail.service').configured()
  });
}

// GET /api/management-report/pdf?month=YYYY-MM
async function pdf(ctx, q) {
  need(ctx);
  var month = monthOf((q || {}).month);
  var buf = await pdfOf(await build(month));
  return { buffer: buf, name: 'Management report ' + month + '.pdf' };
}

async function mailIt(month, to, by, auto) {
  var mail = require('./mail.service');
  var report = await build(month);
  var buf = await pdfOf(report);
  var lines = [
    'The management report for ' + report.label + ' is attached.', '',
    'Sales: ' + cedis(report.sales.total) + (report.sales.change == null ? '' : ' (' + pct(report.sales.change) + ' on ' + report.prevLabel + ')') + '.',
    'Spent: ' + cedis(report.spending.total) + '. Cash collected: ' + cedis(report.cash.collected) + '.',
    'Owed to us: ' + cedis(report.cash.owedToUs.amount) + (report.cash.owedToUs.late ? ', ' + cedis(report.cash.owedToUs.late) + ' overdue' : '') + '.',
    report.licences.length ? report.licences.length + ' licence' + (report.licences.length === 1 ? '' : 's') + ' to renew in the next 60 days.' : 'No licence ends in the next 60 days.',
    '', 'Bamboo OS'
  ];
  for (var i = 0; i < to.length; i++) {
    await mail.send({ to: to[i], subject: 'Management report — ' + report.label, text: lines.join('\n'), fromName: 'Bamboo OS', attachments: [{ filename: 'Management report ' + month + '.pdf', content: buf, contentType: 'application/pdf' }] });
  }
  await pool.query(
    'INSERT INTO management_reports (month, sent_at, sent_to, sent_by, auto) VALUES ($1, now(), $2, $3, $4) ON CONFLICT (month) DO UPDATE SET sent_at = now(), sent_to = $2, sent_by = $3, auto = $4',
    [month, to.join(', '), by, !!auto]);
  return report;
}

// POST /api/management-report/send { month, to: [emails] } — to the owners
// on file when none are given.
async function send(ctx, p) {
  need(ctx);
  p = p || {};
  var month = monthOf(p.month);
  var mail = require('./mail.service');
  if (!mail.configured()) fail('unavailable', 'Email isn\'t set up yet. An administrator adds SMTP_HOST, SMTP_USER and SMTP_PASS on the server (see Company settings → Email).');
  var to = (Array.isArray(p.to) && p.to.length ? p.to : (await settingsOf()).recipients).map(function (e) { return String(e || '').trim().toLowerCase(); });
  to = Array.from(new Set(to));
  if (!to.length) fail('invalid', 'Who is it for? Add the owners\' email addresses.');
  if (to.length > MAX_TO) fail('invalid', 'At most ' + MAX_TO + ' people at a time.');
  to.forEach(function (e) { if (!mail.isEmail(e)) fail('invalid', e + ' is not an email address.'); });
  await mailIt(month, to, ctx.employee ? ctx.employee.id : null, false);
  await audit(pool, ctx, 'report.monthly', 'management_report', null, 'Sent the ' + monthLabel(month) + ' management report to ' + to.length + (to.length === 1 ? ' person.' : ' people.'));
  return view(ctx, { month: month });
}

// PUT /api/management-report/settings { recipients, autoSend }
async function saveSettings(ctx, p) {
  needSettings(ctx);
  p = p || {};
  var mail = require('./mail.service');
  var list = Array.from(new Set((Array.isArray(p.recipients) ? p.recipients : String(p.recipients || '').split(/[\s,;]+/)).map(function (e) { return String(e || '').trim().toLowerCase(); }).filter(Boolean)));
  if (list.length > MAX_TO) fail('invalid', 'At most ' + MAX_TO + ' people.');
  list.forEach(function (e) { if (!mail.isEmail(e)) fail('invalid', e + ' is not an email address.'); });
  if (p.autoSend && !list.length) fail('invalid', 'Add who it goes to before it can go on its own.');
  await pool.query("UPDATE settings SET management_report = $1 WHERE id = 1", [JSON.stringify({ recipients: list, autoSend: !!p.autoSend })]);
  await audit(pool, ctx, 'report.monthly.settings', 'settings', null, 'The management report goes to ' + list.length + (list.length === 1 ? ' person' : ' people') + (p.autoSend ? ', on its own on the 1st.' : '.'));
  return view(ctx, { month: p.month });
}

// On the 1st to the 3rd, the month just ended — once (jobs/dailyAlerts.js).
async function autoSend(day) {
  day = day || today();
  if (Number(day.slice(8, 10)) > 3) return 0;
  var s = await settingsOf();
  if (!s.autoSend || !s.recipients.length || !require('./mail.service').configured()) return 0;
  var month = shift(day.slice(0, 7), -1);
  if ((await pool.query('SELECT 1 FROM management_reports WHERE month = $1', [month])).rows[0]) return 0;
  // Claimed first so two servers do not both send it.
  var won = await pool.query("INSERT INTO management_reports (month, sent_to, auto) VALUES ($1, '', true) ON CONFLICT DO NOTHING RETURNING month", [month]);
  if (!won.rowCount) return 0;
  try { await mailIt(month, s.recipients, null, true); } catch (e) { await pool.query("DELETE FROM management_reports WHERE month = $1 AND sent_to = ''", [month]); throw e; }
  return s.recipients.length;
}

module.exports = { view: view, pdf: pdf, send: send, saveSettings: saveSettings, autoSend: autoSend, build: build, pdfOf: pdfOf };
