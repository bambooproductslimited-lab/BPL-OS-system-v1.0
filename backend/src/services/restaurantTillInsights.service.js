var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');

// The reports Square has that the sales report did not (till back office →
// Reports → Insights): sales by category; by area (the floor's areas, the
// counter, takeaway, deliveries, the website, the kiosk and each delivery
// app — Square's "revenue centers"); by time of day (breakfast, lunch,
// afternoon, dinner, late) and by hour of each weekday; what was voided
// (sales voided, open orders removed unpaid, dishes taken off after they
// went to the kitchen); the staff's hours and their cost against the sales
// (attendance and pay in the OS); and each of these against the period
// before, or the same days a year ago. Ghana keeps UTC all year, so the
// hours are the database's.

var DAY = /^\d{4}-\d{2}-\d{2}$/;
var DAYPARTS = [['breakfast', 6, 11], ['lunch', 11, 15], ['afternoon', 15, 18], ['dinner', 18, 22], ['late', 22, 30]];
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }

function periodOf(q) {
  var today = new Date().toISOString().slice(0, 10);
  var from = DAY.test(q.from || '') ? q.from : addDays(today, -6);
  var to = DAY.test(q.to || '') ? q.to : today;
  if (to < from) { var x = from; from = to; to = x; }
  if (daysBetween(from, to) > 366) fail('invalid', 'Look at a year at most.');
  return { from: from, to: to, days: daysBetween(from, to) + 1 };
}
function compareOf(p, kind) {
  if (kind === 'year') return { from: addDays(p.from, -364), to: addDays(p.to, -364), days: p.days, kind: 'year' };
  if (kind === 'none') return null;
  return { from: addDays(p.from, -p.days), to: addDays(p.from, -1), days: p.days, kind: 'previous' };
}

var SALE = "FROM restaurant_orders o WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at >= $2::date AND o.created_at < $3::date + interval '1 day'";

async function totals(companyId, p) {
  var r = (await pool.query(
    'SELECT count(*)::int AS orders, coalesce(sum(o.total - o.refunded_total), 0) AS net, coalesce(sum(o.total), 0) AS gross, coalesce(sum(o.refunded_total), 0) AS refunded, ' +
    'coalesce(sum(o.tip), 0) AS tips, coalesce(sum(o.discount_total), 0) AS discounts, coalesce(sum(o.guests), 0)::int AS guests ' + SALE, [companyId, p.from, p.to])).rows[0];
  return { orders: r.orders, net: round2(r.net), gross: round2(r.gross), refunded: round2(r.refunded), tips: round2(r.tips), discounts: round2(r.discounts), guests: r.guests,
    average: r.orders ? round2(r.net / r.orders) : 0 };
}
async function byCategory(companyId, p) {
  return (await pool.query(
    "SELECT coalesce(nullif(m.category, ''), CASE WHEN i.custom THEN 'Not on the menu' ELSE 'Other' END) AS name, sum(i.qty) AS qty, coalesce(sum(i.line_total), 0) AS amount, count(DISTINCT o.id)::int AS orders " +
    'FROM restaurant_order_items i JOIN restaurant_orders o ON o.id = i.order_id LEFT JOIN restaurant_menu_items m ON m.id = i.menu_item_id ' +
    "WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at >= $2::date AND o.created_at < $3::date + interval '1 day' GROUP BY 1 ORDER BY 3 DESC", [companyId, p.from, p.to])).rows
    .map(function (r) { return { name: r.name, qty: Number(r.qty), amount: round2(r.amount), orders: r.orders }; });
}
// Square's "revenue centers": where in the restaurant (or from which app) the money came.
async function byArea(companyId, p, settings) {
  var rows = (await pool.query(
    "SELECT o.channel, o.app, o.fulfillment, o.table_id IS NOT NULL AS at_table, coalesce(nullif(t.area, ''), '') AS area, count(*)::int AS orders, coalesce(sum(o.total - o.refunded_total), 0) AS amount " +
    'FROM restaurant_orders o LEFT JOIN restaurant_tables t ON t.id = o.table_id ' +
    "WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at >= $2::date AND o.created_at < $3::date + interval '1 day' GROUP BY 1, 2, 3, 4, 5", [companyId, p.from, p.to])).rows;
  var apps = (settings.apps && settings.apps.list) || [];
  var out = {};
  rows.forEach(function (r) {
    var key, kind;
    if (r.channel === 'app') { var a = apps.find(function (x) { return x.key === r.app; }); key = a ? a.name : (r.app || 'Delivery app'); kind = 'app'; }
    else if (r.channel === 'website') { key = 'Website'; kind = 'website'; }
    else if (r.channel === 'kiosk') { key = 'Kiosk'; kind = 'kiosk'; }
    else if (r.fulfillment === 'delivery') { key = 'Delivery'; kind = 'delivery'; }
    else if (r.fulfillment === 'pickup' || r.fulfillment === 'togo') { key = 'Takeaway'; kind = 'takeaway'; }
    else if (r.at_table) { key = r.area || 'Tables'; kind = 'floor'; }
    else { key = r.channel === 'square' ? 'Square' : 'Counter'; kind = r.channel === 'square' ? 'square' : 'counter'; }
    if (!out[key]) out[key] = { name: key, kind: kind, orders: 0, amount: 0 };
    out[key].orders += r.orders;
    out[key].amount = round2(out[key].amount + Number(r.amount));
  });
  return Object.keys(out).map(function (k) { return out[k]; }).sort(function (a, b) { return b.amount - a.amount; });
}
// Breakfast, lunch, afternoon, dinner, late; and every hour of every weekday (0 Sunday).
async function byTime(companyId, p) {
  var rows = (await pool.query(
    'SELECT extract(dow FROM o.created_at)::int AS dow, extract(hour FROM o.created_at)::int AS hour, count(*)::int AS orders, coalesce(sum(o.total - o.refunded_total), 0) AS amount ' +
    SALE + ' GROUP BY 1, 2', [companyId, p.from, p.to])).rows;
  var parts = DAYPARTS.map(function (d) { return { key: d[0], from: d[1], to: d[2] % 24, orders: 0, amount: 0 }; });
  var grid = [];
  for (var dw = 0; dw < 7; dw++) { grid.push([]); for (var h = 0; h < 24; h++) grid[dw].push({ orders: 0, amount: 0 }); }
  rows.forEach(function (r) {
    grid[r.dow][r.hour] = { orders: r.orders, amount: round2(r.amount) };
    var hh = r.hour < 6 ? r.hour + 24 : r.hour;
    var part = parts.find(function (x, i) { return hh >= DAYPARTS[i][1] && hh < DAYPARTS[i][2]; });
    if (part) { part.orders += r.orders; part.amount = round2(part.amount + Number(r.amount)); }
  });
  return { dayparts: parts, grid: grid };
}
// What was voided: sales voided, open orders removed before they were paid,
// dishes taken off after they went to the kitchen (at the menu's price).
async function voids(companyId, p) {
  var args = [companyId, p.from, p.to];
  var sales = (await pool.query(
    "SELECT o.order_no, o.total, o.created_at, e.first_name || ' ' || e.last_name AS cashier FROM restaurant_orders o LEFT JOIN employees e ON e.id = o.cashier_id " +
    "WHERE o.company_id = $1 AND o.status = 'voided' AND o.created_at >= $2::date AND o.created_at < $3::date + interval '1 day' ORDER BY o.created_at DESC LIMIT 50", args)).rows;
  var removed = (await pool.query(
    "SELECT a.summary, a.at, e.first_name || ' ' || e.last_name AS who FROM restaurant_activity a LEFT JOIN employees e ON e.id = a.employee_id " +
    "WHERE a.company_id = $1 AND a.action = 'till.removed' AND a.at >= $2::date AND a.at < $3::date + interval '1 day' ORDER BY a.at DESC LIMIT 50", args)).rows;
  var dishes = (await pool.query(
    "SELECT i.name, sum(i.qty) AS qty, coalesce(sum(i.qty * coalesce(v.price, m.price, 0)), 0) AS value, count(*)::int AS times, max(i.created_at) AS last_at " +
    'FROM restaurant_kitchen_items i JOIN restaurant_kitchen_tickets k ON k.id = i.ticket_id LEFT JOIN restaurant_menu_items m ON m.id = i.menu_item_id ' +
    'LEFT JOIN restaurant_menu_item_variations v ON v.id = i.variation_id ' +
    "WHERE k.company_id = $1 AND i.status = 'cancelled' AND i.created_at >= $2::date AND i.created_at < $3::date + interval '1 day' GROUP BY i.name ORDER BY 3 DESC LIMIT 30", args)).rows;
  return {
    sales: { count: sales.length, amount: round2(sales.reduce(function (a, r) { return a + Number(r.total); }, 0)),
      list: sales.map(function (r) { return { orderNo: r.order_no, amount: round2(r.total), at: r.created_at, cashier: r.cashier || null }; }) },
    removed: { count: removed.length, list: removed.map(function (r) { return { summary: r.summary, at: r.at, by: r.who || null }; }) },
    dishes: { qty: dishes.reduce(function (a, r) { return a + Number(r.qty); }, 0), value: round2(dishes.reduce(function (a, r) { return a + Number(r.value); }, 0)),
      list: dishes.map(function (r) { return { name: r.name, qty: Number(r.qty), value: round2(r.value), times: r.times, lastAt: r.last_at }; }) }
  };
}
// The hours the restaurant's staff clocked (attendance) and what they cost:
// their hourly rate, else their daily rate, else their monthly salary over
// 26 working days — against the sales of each day.
async function labour(companyId, p) {
  var rows = (await pool.query(
    "SELECT a.date, e.id AS employee_id, e.hourly_rate, e.daily_rate, e.basic_salary, " +
    "  extract(epoch FROM ((coalesce(a.clock_out_date, a.date) + a.clock_out) - (a.date + a.clock_in))) / 3600.0 AS hours " +
    'FROM attendance a JOIN employees e ON e.id = a.employee_id JOIN departments d ON d.id = e.department_id ' +
    'WHERE d.company_id = $1 AND a.date BETWEEN $2 AND $3 AND a.clock_in IS NOT NULL AND a.clock_out IS NOT NULL', [companyId, p.from, p.to])).rows;
  var byDay = {}, people = new Set(), hours = 0, cost = 0, unknown = 0;
  rows.forEach(function (r) {
    var h = Math.max(0, Math.min(16, Number(r.hours) || 0));
    var c = Number(r.hourly_rate) > 0 ? h * Number(r.hourly_rate) : Number(r.daily_rate) > 0 ? Number(r.daily_rate) : Number(r.basic_salary) > 0 ? Number(r.basic_salary) / 26 : null;
    if (c === null) unknown += 1;
    var day = new Date(r.date).toISOString().slice(0, 10);
    if (!byDay[day]) byDay[day] = { hours: 0, cost: 0 };
    byDay[day].hours += h; byDay[day].cost += c || 0;
    hours += h; cost += c || 0; people.add(r.employee_id);
  });
  var sales = (await pool.query('SELECT o.created_at::date AS day, coalesce(sum(o.total - o.refunded_total), 0) AS net ' + SALE + ' GROUP BY 1', [companyId, p.from, p.to])).rows;
  var net = {};
  sales.forEach(function (r) { net[new Date(r.day).toISOString().slice(0, 10)] = round2(r.net); });
  var days = [];
  for (var i = 0; i < p.days && i < 400; i++) {
    var d = addDays(p.from, i);
    var x = byDay[d] || { hours: 0, cost: 0 };
    days.push({ day: d, hours: round2(x.hours), cost: round2(x.cost), sales: net[d] || 0 });
  }
  var totalSales = round2(days.reduce(function (a, d) { return a + d.sales; }, 0));
  return { people: people.size, hours: round2(hours), cost: round2(cost), sales: totalSales, share: totalSales > 0 ? round2(cost / totalSales * 100) : null,
    salesPerHour: hours > 0 ? round2(totalSales / hours) : null, noRate: unknown, days: days };
}

// POST /api/pos/settings/insights { managerPin, from, to, compare: 'previous' | 'year' | 'none' }
async function report(companyId, q, settings) {
  q = q || {};
  var p = periodOf(q);
  var c = compareOf(p, q.compare === 'year' || q.compare === 'none' ? q.compare : 'previous');
  var out = {
    period: p, compare: c,
    totals: await totals(companyId, p), categories: await byCategory(companyId, p), areas: await byArea(companyId, p, settings),
    time: await byTime(companyId, p), voids: await voids(companyId, p), labour: await labour(companyId, p)
  };
  if (c) {
    out.before = { totals: await totals(companyId, c), categories: await byCategory(companyId, c), areas: await byArea(companyId, c, settings), dayparts: (await byTime(companyId, c)).dayparts };
  }
  return out;
}

// The owner's phone (OS /owner): every restaurant today so far, against
// the same weekday last week up to the same time; what is open now; the
// last 7 days. opts.all keeps a restaurant with nothing sold or open yet.
async function owner(companyIds, opts) {
  var out = [];
  for (var i = 0; i < companyIds.length; i++) {
    var id = companyIds[i];
    var co = (await pool.query('SELECT id, code, name FROM companies WHERE id = $1', [id])).rows[0];
    if (!co) continue;
    var today = (await pool.query(
      "SELECT count(*)::int AS orders, coalesce(sum(total - refunded_total), 0) AS net, coalesce(sum(guests), 0)::int AS guests FROM restaurant_orders WHERE company_id = $1 AND status = 'completed' AND created_at >= date_trunc('day', now())", [id])).rows[0];
    var lastWeek = (await pool.query(
      "SELECT count(*)::int AS orders, coalesce(sum(total - refunded_total), 0) AS net FROM restaurant_orders WHERE company_id = $1 AND status = 'completed' " +
      "AND created_at >= date_trunc('day', now()) - interval '7 days' AND created_at < now() - interval '7 days'", [id])).rows[0];
    var open = (await pool.query('SELECT count(*)::int AS n FROM restaurant_open_tabs WHERE company_id = $1', [id])).rows[0];
    var cooking = (await pool.query("SELECT count(*)::int AS n FROM restaurant_kitchen_tickets WHERE company_id = $1 AND status IN ('cooking', 'held')", [id])).rows[0];
    var drawers = (await pool.query("SELECT count(*)::int AS n FROM restaurant_drawer_sessions WHERE company_id = $1 AND status = 'open'", [id])).rows[0];
    var top = (await pool.query(
      "SELECT i.name, sum(i.qty) AS qty FROM restaurant_order_items i JOIN restaurant_orders o ON o.id = i.order_id WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at >= date_trunc('day', now()) " +
      'GROUP BY 1 ORDER BY 2 DESC LIMIT 3', [id])).rows;
    var week = (await pool.query(
      "SELECT d::date AS day, coalesce((SELECT sum(total - refunded_total) FROM restaurant_orders o WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at >= d AND o.created_at < d + interval '1 day'), 0) AS net " +
      "FROM generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') d ORDER BY d", [id])).rows;
    var hours = (await pool.query(
      "SELECT extract(hour FROM created_at)::int AS hour, coalesce(sum(total - refunded_total), 0) AS net FROM restaurant_orders WHERE company_id = $1 AND status = 'completed' AND created_at >= date_trunc('day', now()) GROUP BY 1", [id])).rows;
    var anySales = Number(today.orders) + Number(lastWeek.orders) + week.reduce(function (a, w) { return a + Number(w.net); }, 0) > 0;
    if (!anySales && !open.n && !drawers.n && !(opts && opts.all)) continue;
    out.push({
      id: co.id, code: co.code, name: co.name,
      today: { orders: today.orders, net: round2(today.net), guests: today.guests, average: today.orders ? round2(today.net / today.orders) : 0 },
      lastWeek: { orders: lastWeek.orders, net: round2(lastWeek.net) },
      change: Number(lastWeek.net) > 0 ? round2((today.net - lastWeek.net) / lastWeek.net * 100) : null,
      now: { openOrders: open.n, cooking: cooking.n, drawers: drawers.n },
      top: top.map(function (t) { return { name: t.name, qty: Number(t.qty) }; }),
      week: week.map(function (w) { return { day: new Date(w.day).toISOString().slice(0, 10), net: round2(w.net) }; }),
      hours: hours.map(function (h) { return { hour: h.hour, net: round2(h.net) }; })
    });
  }
  return { at: new Date().toISOString(), restaurants: out, total: { net: round2(out.reduce(function (a, r) { return a + r.today.net; }, 0)), orders: out.reduce(function (a, r) { return a + r.today.orders; }, 0),
    lastWeek: round2(out.reduce(function (a, r) { return a + r.lastWeek.net; }, 0)) } };
}

module.exports = { report: report, owner: owner, periodOf: periodOf, compareOf: compareOf, DAYPARTS: DAYPARTS };
