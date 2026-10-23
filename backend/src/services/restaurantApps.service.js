var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// Orders from delivery apps — Bolt Food, Glovo, any other the restaurant
// adds (migration 0176; till settings apps). The app's tablet rings, the
// cashier rings the order up on the till as an app order: its app, the
// app's order code and the customer's name; the app's prices (a markup on
// the menu's, if the restaurant charges more there); paid on the app, so
// nothing goes in the drawer; to the kitchen with the app's name on the
// ticket, and handed to the app's rider. The app keeps its commission and
// pays the rest later: what each app owes is kept until its payout is
// entered, against the orders up to a day.

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function clean(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

// The app an order is for, turned on in the settings; with its order code.
function appOf(settings, p) {
  p = p || {};
  var a = ((settings.apps && settings.apps.list) || []).find(function (x) { return x.key === p.key; });
  if (!a) fail('invalid', 'Pick the delivery app.');
  if (!a.on) fail('conflict', a.name + ' is turned off in the till settings.');
  var ref = clean(p.ref, 30).replace(/^#/, '');
  if (ref.length < 2) fail('invalid', 'Type the ' + a.name + ' order code, as the app shows it.');
  return { key: a.key, name: a.name, markup: Number(a.markup) || 0, commission: Number(a.commission) || 0, ref: ref, customer: clean(p.customer, 60) };
}
// The app's prices: the menu's with its markup.
function applyMarkup(lines, app) {
  if (!app.markup) return lines;
  var f = 1 + app.markup / 100;
  return lines.map(function (l) {
    var unit = round2(l.unitPrice * f);
    return Object.assign({}, l, { unitPrice: unit, lineTotal: round2(unit * l.qty) });
  });
}
function commissionOf(app, total) { return round2(total * app.commission / 100); }
function labelOf(app) { return app.name + ' #' + app.ref + (app.customer ? ' · ' + app.customer : ''); }

function nameOf(settings, key) {
  var a = ((settings.apps && settings.apps.list) || []).find(function (x) { return x.key === key; });
  return a ? a.name : key;
}

// What each app owes: its orders not paid out yet, and the payouts.
// POST /api/pos/settings/apps { managerPin, action: 'list' | 'payout', … }
async function owed(companyId, settings) {
  var rows = (await pool.query(
    "SELECT app, count(*)::int AS n, coalesce(sum(total - refunded_total), 0) AS sales, coalesce(sum(app_commission), 0) AS commission, min(created_at) AS first_at, max(created_at) AS last_at " +
    "FROM restaurant_orders WHERE company_id = $1 AND app IS NOT NULL AND app_payout_id IS NULL AND status = 'completed' GROUP BY app", [companyId])).rows;
  var month = (await pool.query(
    "SELECT app, count(*)::int AS n, coalesce(sum(total), 0) AS sales FROM restaurant_orders WHERE company_id = $1 AND app IS NOT NULL AND status = 'completed' AND created_at >= date_trunc('month', now()) GROUP BY app",
    [companyId])).rows;
  var keys = Array.from(new Set(((settings.apps && settings.apps.list) || []).map(function (a) { return a.key; }).concat(rows.map(function (r) { return r.app; }))));
  return keys.map(function (k) {
    var r = rows.find(function (x) { return x.app === k; }) || { n: 0, sales: 0, commission: 0 };
    var m = month.find(function (x) { return x.app === k; }) || { n: 0, sales: 0 };
    var a = ((settings.apps && settings.apps.list) || []).find(function (x) { return x.key === k; }) || {};
    return { key: k, name: nameOf(settings, k), on: !!a.on, commission: a.commission || 0, markup: a.markup || 0,
      unpaid: { orders: r.n, sales: round2(r.sales), commission: round2(r.commission), owed: round2(r.sales - r.commission), from: r.first_at || null, to: r.last_at || null },
      month: { orders: m.n, sales: round2(m.sales) } };
  });
}
async function payouts(companyId, settings) {
  return (await pool.query(
    'SELECT p.*, e.first_name, e.last_name FROM restaurant_app_payouts p LEFT JOIN employees e ON e.id = p.created_by WHERE p.company_id = $1 ORDER BY p.received_on DESC, p.created_at DESC LIMIT 60',
    [companyId])).rows.map(function (p) {
    return { id: p.id, app: p.app, name: nameOf(settings, p.app), through: p.through, orders: p.orders, expected: round2(p.expected), amount: round2(p.amount),
      difference: round2(p.amount - p.expected), receivedOn: p.received_on, method: p.method, note: p.note, by: p.first_name ? p.first_name + ' ' + p.last_name : null };
  });
}
async function recent(companyId, settings) {
  return (await pool.query(
    "SELECT o.id, o.order_no, o.app, o.app_ref, o.customer_name, o.total, o.app_commission, o.created_at, o.app_payout_id FROM restaurant_orders o " +
    "WHERE o.company_id = $1 AND o.app IS NOT NULL AND o.status = 'completed' ORDER BY o.created_at DESC LIMIT 40", [companyId])).rows.map(function (o) {
    return { id: o.id, orderNo: o.order_no, app: o.app, name: nameOf(settings, o.app), ref: o.app_ref, customer: o.customer_name, total: round2(o.total),
      commission: round2(o.app_commission), paidOut: !!o.app_payout_id, at: o.created_at };
  });
}

// A payout from an app: the money it sent for its orders up to a day
// (those not paid out before), against what was expected (sales less its
// commission). The difference is shown, not hidden.
async function payout(companyId, managerId, settings, p) {
  p = p || {};
  var key = String(p.app || '');
  if (!((settings.apps && settings.apps.list) || []).some(function (a) { return a.key === key; })) fail('invalid', 'Pick the delivery app.');
  var through = /^\d{4}-\d{2}-\d{2}$/.test(p.through || '') ? p.through : null;
  if (!through) fail('invalid', 'For its orders up to which day?');
  var received = /^\d{4}-\d{2}-\d{2}$/.test(p.receivedOn || '') ? p.receivedOn : new Date().toISOString().slice(0, 10);
  var amount = round2(p.amount);
  if (!(amount >= 0 && amount <= 10000000)) fail('invalid', 'How much did the app pay?');
  var method = ['mobile_money', 'bank_transfer', 'cash', 'other'].indexOf(p.method) >= 0 ? p.method : fail('invalid', 'Paid how: Mobile Money, bank transfer, cash?');
  return withTransaction(async function (client) {
    var orders = (await client.query(
      "SELECT id, total, refunded_total, app_commission FROM restaurant_orders WHERE company_id = $1 AND app = $2 AND app_payout_id IS NULL AND status = 'completed' AND created_at::date <= $3 FOR UPDATE",
      [companyId, key, through])).rows;
    if (!orders.length) fail('conflict', 'No ' + nameOf(settings, key) + ' orders up to that day are waiting to be paid.');
    var expected = round2(orders.reduce(function (s, o) { return s + Number(o.total) - Number(o.refunded_total) - Number(o.app_commission); }, 0));
    var row = (await client.query(
      'INSERT INTO restaurant_app_payouts (company_id, app, through, orders, expected, amount, received_on, method, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [companyId, key, through, orders.length, expected, amount, received, method, clean(p.note, 200), managerId])).rows[0];
    await client.query('UPDATE restaurant_orders SET app_payout_id = $1 WHERE id = ANY($2::uuid[])', [row.id, orders.map(function (o) { return o.id; })]);
    await activity.log(client, { companyId: companyId, employeeId: managerId, app: 'settings', action: 'settings.app_payout',
      summary: nameOf(settings, key) + ' paid ' + amount.toFixed(2) + ' for ' + orders.length + ' orders up to ' + through + ' (expected ' + expected.toFixed(2) + ').', amount: amount, refType: 'app_payout', refId: row.id });
    return row;
  });
}

async function settingsTab(token, p, ip) {
  var m = await access.settingsManager(token, (p || {}).managerPin, ip);
  var company = m.session.posCompanyId;
  var settings = await access.settingsOf(company);
  if (p && p.action === 'payout') await payout(company, m.manager.id, settings, p);
  return { apps: await owed(company, settings), payouts: await payouts(company, settings), recent: await recent(company, settings) };
}

module.exports = { appOf: appOf, applyMarkup: applyMarkup, commissionOf: commissionOf, labelOf: labelOf, nameOf: nameOf, owed: owed, payout: payout, settingsTab: settingsTab };
