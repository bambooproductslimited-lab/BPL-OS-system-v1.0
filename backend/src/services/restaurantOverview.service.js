var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var restaurantPos = require('./restaurantPos.service');

// The numbers at the top of the Restaurants page: how the restaurant is
// selling (each of the last 35 days, this month against the same days last
// month, the best sellers, when it is busiest, how people pay, who sells),
// what was voided, the cash drawers, and what the stock is worth, was
// bought and was thrown away. Only completed orders count as sales; a
// voided order is counted apart. Days are UTC days — Ghana's own time.

function iso(d) { return d.toISOString().slice(0, 10); }
function num(v) { return Math.round(Number(v || 0) * 100) / 100; }
function name(first, last) { return first ? first + (last ? ' ' + last : '') : null; }

// The restaurants to pick from: every company, with a little about each so
// the page can put the ones that actually run a restaurant first.
async function companies(ctx) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  var res = await pool.query(
    'SELECT c.id, c.code, c.name, ' +
    '  (SELECT count(*) FROM restaurant_menu_items m WHERE m.company_id = c.id AND m.active) AS menu_items, ' +
    "  (SELECT count(*) FROM restaurant_orders o WHERE o.company_id = c.id AND o.status = 'completed' AND o.created_at > now() - interval '30 days') AS orders30, " +
    "  (SELECT coalesce(sum(total), 0) FROM restaurant_orders o WHERE o.company_id = c.id AND o.status = 'completed' AND (o.created_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date) AS sales_today " +
    'FROM companies c ORDER BY c.name'
  );
  return res.rows.map(function (r) {
    return { id: r.id, code: r.code, name: r.name, menuItems: Number(r.menu_items), orders30: Number(r.orders30), salesToday: num(r.sales_today) };
  });
}

async function overview(ctx, companyId) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  if (!companyId) fail('invalid', 'Choose a restaurant.');
  var co = (await pool.query('SELECT id, name FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!co) fail('notfound', 'Company not found.');

  var now = new Date();
  var today = iso(now);
  var from35 = new Date(now); from35.setUTCDate(from35.getUTCDate() - 34);
  var monthStart = today.slice(0, 8) + '01';
  var prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  var prevStart = iso(prev);
  // the same number of days into last month (capped at its last day)
  var prevDays = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
  var prevEnd = iso(new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), Math.min(now.getUTCDate(), prevDays))));
  var DAY = "(o.created_at AT TIME ZONE 'UTC')::date";

  var q = await Promise.all([
    pool.query(
      'SELECT ' + DAY + " AS day, count(*) AS orders, coalesce(sum(o.total), 0) AS sales FROM restaurant_orders o " +
      "WHERE o.company_id = $1 AND o.status = 'completed' AND " + DAY + ' >= $2 GROUP BY 1 ORDER BY 1', [companyId, iso(from35)]),
    pool.query(
      'SELECT count(*) FILTER (WHERE ' + DAY + ' >= $2) AS m_orders, coalesce(sum(o.total) FILTER (WHERE ' + DAY + ' >= $2), 0) AS m_sales, ' +
      'count(*) FILTER (WHERE ' + DAY + ' BETWEEN $3 AND $4) AS p_orders, coalesce(sum(o.total) FILTER (WHERE ' + DAY + ' BETWEEN $3 AND $4), 0) AS p_sales ' +
      "FROM restaurant_orders o WHERE o.company_id = $1 AND o.status = 'completed' AND " + DAY + ' >= $3', [companyId, monthStart, prevStart, prevEnd]),
    pool.query(
      "SELECT coalesce(i.menu_item_id::text, 'name:' || i.name) AS key, i.menu_item_id, " +
      '  coalesce(m.name, i.name) AS name, sum(i.qty) AS qty, sum(i.line_total) AS revenue, max(o.created_at) AS last_sold ' +
      'FROM restaurant_order_items i JOIN restaurant_orders o ON o.id = i.order_id LEFT JOIN restaurant_menu_items m ON m.id = i.menu_item_id ' +
      "WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at > now() - interval '30 days' GROUP BY 1, 2, 3 ORDER BY revenue DESC", [companyId]),
    pool.query(
      "SELECT o.payment_method AS method, count(*) AS orders, sum(o.total) AS sales FROM restaurant_orders o WHERE o.company_id = $1 AND o.status = 'completed' " +
      "AND o.created_at > now() - interval '30 days' GROUP BY 1 ORDER BY sales DESC", [companyId]),
    pool.query(
      'SELECT e.id, e.first_name, e.last_name, e.photo_key, e.photo_updated_at, count(*) AS orders, sum(o.total) AS sales ' +
      'FROM restaurant_orders o JOIN employees e ON e.id = coalesce(o.waiter_id, o.cashier_id) ' +
      "WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at > now() - interval '30 days' GROUP BY e.id ORDER BY sales DESC LIMIT 8", [companyId]),
    pool.query(
      "SELECT extract(hour FROM o.created_at AT TIME ZONE 'UTC')::int AS hour, count(*) AS orders, sum(o.total) AS sales FROM restaurant_orders o " +
      "WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1", [companyId]),
    pool.query(
      "SELECT count(*) AS n, coalesce(sum(o.total), 0) AS total FROM restaurant_orders o WHERE o.company_id = $1 AND o.status = 'voided' " +
      "AND o.created_at > now() - interval '7 days'", [companyId]),
    pool.query(
      "SELECT (SELECT coalesce(sum(stock_qty * unit_cost), 0) FROM restaurant_supplies WHERE company_id = $1) AS supplies_value, " +
      "(SELECT coalesce(sum(stock_qty * unit_cost), 0) FROM restaurant_ingredients WHERE company_id = $1) AS food_value, " +
      "(SELECT coalesce(sum(-delta * unit_cost), 0) FROM restaurant_stock_moves WHERE company_id = $1 AND kind = 'wasted' AND created_at > now() - interval '30 days') AS wasted30, " +
      "(SELECT coalesce(sum(delta * unit_cost), 0) FROM restaurant_stock_moves WHERE company_id = $1 AND kind = 'received' AND created_at > now() - interval '30 days') AS bought30, " +
      "(SELECT coalesce(sum(-delta * unit_cost), 0) FROM restaurant_stock_moves WHERE company_id = $1 AND kind = 'used' AND created_at > now() - interval '30 days') AS used30",
      [companyId]),
    pool.query(
      "SELECT m.item_type, m.item_id, sum(-m.delta) FILTER (WHERE m.kind = 'used') AS used, sum(-m.delta) FILTER (WHERE m.kind = 'wasted') AS wasted " +
      "FROM restaurant_stock_moves m WHERE m.company_id = $1 AND m.created_at > now() - interval '30 days' AND m.kind IN ('used', 'wasted') GROUP BY 1, 2", [companyId])
  ]);

  var byDay = {};
  q[0].rows.forEach(function (r) { byDay[iso(new Date(r.day))] = { orders: Number(r.orders), sales: num(r.sales) }; });
  var days = [];
  for (var i = 0; i < 35; i++) {
    var d = new Date(from35); d.setUTCDate(d.getUTCDate() + i);
    var k = iso(d);
    days.push({ day: k, orders: (byDay[k] || {}).orders || 0, sales: (byDay[k] || {}).sales || 0 });
  }
  var m = q[1].rows[0];
  var items = q[2].rows.map(function (r) {
    return { key: r.key, menuItemId: r.menu_item_id, name: r.name, qty: num(r.qty), revenue: num(r.revenue), lastSold: r.last_sold };
  });
  var stock = q[7].rows[0];
  var drawers = await restaurantPos.listDrawerSessions(ctx, companyId, { limit: 12 });

  return {
    companyId: co.id, today: today, days: days,
    month: { orders: Number(m.m_orders), sales: num(m.m_sales), from: monthStart },
    previousMonth: { orders: Number(m.p_orders), sales: num(m.p_sales), from: prevStart, to: prevEnd },
    items: items,
    payments: q[3].rows.map(function (r) { return { method: r.method, orders: Number(r.orders), sales: num(r.sales) }; }),
    staff: q[4].rows.map(function (r) {
      return { id: r.id, name: name(r.first_name, r.last_name), photo: r.photo_key && r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : null, orders: Number(r.orders), sales: num(r.sales) };
    }),
    hours: q[5].rows.map(function (r) { return { hour: r.hour, orders: Number(r.orders), sales: num(r.sales) }; }),
    voided7: { orders: Number(q[6].rows[0].n), total: num(q[6].rows[0].total) },
    stock: {
      suppliesValue: num(stock.supplies_value), foodValue: num(stock.food_value),
      wasted30: num(stock.wasted30), bought30: num(stock.bought30), used30: num(stock.used30),
      perItem: q[8].rows.map(function (r) { return { type: r.item_type, id: r.item_id, used30: num(r.used), wasted30: num(r.wasted) }; })
    },
    drawers: drawers.sessions.map(function (s) {
      return {
        id: s.session.id, cashierName: s.cashierName, status: s.session.status, openedAt: s.session.openedAt, closedAt: s.session.closedAt,
        expected: s.expected, actual: s.actual, difference: s.difference, cashSales: s.cashSales
      };
    })
  };
}

module.exports = { companies: companies, overview: overview };
