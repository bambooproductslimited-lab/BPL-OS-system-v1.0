var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var activity = require('./restaurantActivity.service');

// Disputes (migration 0158): a customer's complaint about an order, a
// wrong charge, or a drawer counted short. Staff raise complaints and wrong
// charges on the till against an order (raise); a drawer closed short
// opens one by itself (openForDrawer, from restaurantPos.closeDrawer). A
// manager sees them in the till settings and resolves each — refunded,
// made again, discounted, written off, nothing to do — with a note, or
// opens it again (restaurantTillAccess.disputes).

var KINDS = ['complaint', 'wrong_charge', 'drawer_short', 'other'];
var RAISED_ON_TILL = ['complaint', 'wrong_charge', 'other'];
var RESOLUTIONS = ['refunded', 'remade', 'discounted', 'written_off', 'no_action', 'other'];
var KIND_NAME = { complaint: 'Complaint', wrong_charge: 'Wrong charge', drawer_short: 'Drawer short', other: 'Problem' };

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }

async function insert(db, d) {
  var row = (await db.query(
    'INSERT INTO restaurant_disputes (company_id, kind, order_id, tab_id, drawer_session_id, amount, description, customer_name, opened_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [d.companyId, d.kind, d.orderId || null, d.tabId || null, d.drawerSessionId || null, d.amount == null ? null : round2(d.amount), d.description, d.customerName || '', d.openedBy || null])).rows[0];
  await activity.log(db, { companyId: d.companyId, employeeId: d.openedBy || null, app: 'till', action: 'till.dispute',
    summary: KIND_NAME[d.kind] + ' raised' + (d.orderNo ? ' on ' + d.orderNo : '') + (d.amount != null ? ' (' + round2(d.amount).toFixed(2) + ')' : '') + ': ' + d.description.slice(0, 160),
    amount: d.amount == null ? null : round2(d.amount), refType: 'dispute', refId: row.id, details: { kind: d.kind } });
  return row;
}

// A drawer counted short opens a dispute by itself.
async function openForDrawer(client, drawer, report) {
  if (!(report.difference < 0)) return null;
  var who = (await client.query("SELECT first_name || ' ' || last_name AS n FROM employees WHERE id = $1", [drawer.cashier_id])).rows[0];
  return insert(client, {
    companyId: drawer.company_id, kind: 'drawer_short', drawerSessionId: drawer.id, amount: -report.difference,
    description: (who ? who.n + "'s drawer" : 'The drawer') + ' was counted ' + Number(report.actual).toFixed(2) + ', ' + report.expected.toFixed(2) + ' expected: short by ' + (-report.difference).toFixed(2) + '.'
  });
}

// On the till: a complaint, a wrong charge or another problem with a sale
// (orderId) or an open order (tabId).
async function raise(session, p) {
  p = p || {};
  var kind = RAISED_ON_TILL.indexOf(p.kind) >= 0 ? p.kind : fail('invalid', 'Pick what kind of problem it is.');
  var description = text(p.description, 500);
  if (description.length < 3) fail('invalid', 'Say what happened.');
  var amount = p.amount == null || p.amount === '' ? null : Number(p.amount);
  if (amount != null && !(amount >= 0 && amount < 1e7)) fail('invalid', 'The amount is a number, 0 or more.');
  var order = null, tab = null;
  if (p.orderId) {
    order = (await pool.query('SELECT o.id, o.order_no, o.customer_name, g.name AS guest_name FROM restaurant_orders o LEFT JOIN restaurant_guests g ON g.id = o.guest_id WHERE o.id = $1 AND o.company_id = $2',
      [p.orderId, session.posCompanyId])).rows[0];
    if (!order) fail('notfound', 'That sale is not this restaurant\'s.');
  } else if (p.tabId) {
    tab = (await pool.query('SELECT t.id, t.label, t.customer_name, g.name AS guest_name FROM restaurant_open_tabs t LEFT JOIN restaurant_guests g ON g.id = t.guest_id WHERE t.id = $1 AND t.company_id = $2',
      [p.tabId, session.posCompanyId])).rows[0];
    if (!tab) fail('notfound', 'That open order has been paid or removed.');
  } else if (kind === 'wrong_charge') fail('invalid', 'Pick the sale that was charged wrong.');
  var src = order || tab || {};
  var row = await insert(pool, {
    companyId: session.posCompanyId, kind: kind, orderId: order ? order.id : null, tabId: tab ? tab.id : null, amount: amount, description: description,
    customerName: text(p.customerName, 80) || src.guest_name || src.customer_name || '', openedBy: session.posEmployeeId, orderNo: order ? order.order_no : tab ? tab.label : null
  });
  return { id: row.id };
}

function rowOut(r) {
  return {
    id: r.id, kind: r.kind, status: r.status, amount: r.amount == null ? null : Number(r.amount), description: r.description, customerName: r.customer_name,
    orderId: r.order_id, orderNo: r.order_no || null, orderTotal: r.order_total == null ? null : Number(r.order_total), tabLabel: r.tab_label || null,
    drawerSessionId: r.drawer_session_id, drawerCashier: r.drawer_cashier || null,
    resolution: r.resolution, resolutionNote: r.resolution_note, openedBy: r.opened_name || null, resolvedBy: r.resolved_name || null,
    createdAt: r.created_at, resolvedAt: r.resolved_at
  };
}

// The settings' list: open first, newest first, for some days or all.
async function list(companyId, q) {
  q = q || {};
  var args = [companyId], where = ['d.company_id = $1'];
  function arg(v) { args.push(v); return '$' + args.length; }
  if (q.status === 'open' || q.status === 'resolved') where.push('d.status = ' + arg(q.status));
  if (KINDS.indexOf(q.kind) >= 0) where.push('d.kind = ' + arg(q.kind));
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) where.push('d.created_at >= ' + arg(q.from) + '::date');
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) where.push('d.created_at < ' + arg(q.to) + "::date + interval '1 day'");
  var rows = (await pool.query(
    "SELECT d.*, o.order_no, o.total AS order_total, t.label AS tab_label, ce.first_name || ' ' || ce.last_name AS drawer_cashier, " +
    "oe.first_name || ' ' || oe.last_name AS opened_name, re.first_name || ' ' || re.last_name AS resolved_name " +
    'FROM restaurant_disputes d LEFT JOIN restaurant_orders o ON o.id = d.order_id LEFT JOIN restaurant_open_tabs t ON t.id = d.tab_id ' +
    'LEFT JOIN restaurant_drawer_sessions s ON s.id = d.drawer_session_id LEFT JOIN employees ce ON ce.id = s.cashier_id ' +
    'LEFT JOIN employees oe ON oe.id = d.opened_by LEFT JOIN employees re ON re.id = d.resolved_by ' +
    'WHERE ' + where.join(' AND ') + " ORDER BY (d.status = 'open') DESC, d.created_at DESC LIMIT 300", args)).rows;
  var sum = (await pool.query(
    "SELECT count(*) FILTER (WHERE status = 'open')::int AS open, coalesce(sum(amount) FILTER (WHERE status = 'open'), 0) AS open_amount, " +
    "count(*) FILTER (WHERE status = 'resolved' AND resolved_at > now() - interval '30 days')::int AS resolved30, " +
    "coalesce(sum(amount) FILTER (WHERE kind = 'drawer_short' AND created_at > now() - interval '30 days'), 0) AS short30 FROM restaurant_disputes WHERE company_id = $1", [companyId])).rows[0];
  return {
    rows: rows.map(rowOut),
    totals: { open: sum.open, openAmount: round2(sum.open_amount), resolved30: sum.resolved30, short30: round2(sum.short30) },
    choices: { kinds: KINDS, raised: RAISED_ON_TILL, resolutions: RESOLUTIONS }
  };
}

async function resolve(companyId, manager, id, p) {
  p = p || {};
  if (RESOLUTIONS.indexOf(p.resolution) < 0) fail('invalid', 'Pick how it was resolved.');
  var note = text(p.note, 500);
  var row = (await pool.query(
    "UPDATE restaurant_disputes SET status = 'resolved', resolution = $3, resolution_note = $4, resolved_by = $5, resolved_at = now() WHERE id = $1 AND company_id = $2 RETURNING *",
    [id, companyId, p.resolution, note, manager.id])).rows[0];
  if (!row) fail('notfound', 'That dispute is not this restaurant\'s.');
  await activity.log(pool, { companyId: companyId, employeeId: manager.id, app: 'settings', action: 'settings.dispute',
    summary: KIND_NAME[row.kind] + ' resolved (' + p.resolution.replace('_', ' ') + ')' + (note ? ': ' + note.slice(0, 160) : '.'), refType: 'dispute', refId: row.id });
  return row.id;
}

async function reopen(companyId, manager, id) {
  var row = (await pool.query(
    "UPDATE restaurant_disputes SET status = 'open', resolution = NULL, resolution_note = '', resolved_by = NULL, resolved_at = NULL WHERE id = $1 AND company_id = $2 RETURNING *",
    [id, companyId])).rows[0];
  if (!row) fail('notfound', 'That dispute is not this restaurant\'s.');
  await activity.log(pool, { companyId: companyId, employeeId: manager.id, app: 'settings', action: 'settings.dispute',
    summary: KIND_NAME[row.kind] + ' opened again.', refType: 'dispute', refId: row.id });
  return row.id;
}

module.exports = { KINDS: KINDS, RESOLUTIONS: RESOLUTIONS, insert: insert, openForDrawer: openForDrawer, raise: raise, list: list, resolve: resolve, reopen: reopen };
