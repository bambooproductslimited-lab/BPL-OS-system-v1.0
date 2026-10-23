var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');
var insights = require('./restaurantTillInsights.service');

// Tips shared out (migration 0178; Square's tip pooling). The till takes a
// tip with a sale (restaurantPos tipOf) and from guests paying at the table
// (restaurantTablePay). Each one goes, as the till's settings say
// (tips.pool):
//   direct — to whoever served the table (its waiter, else the cashier);
//   sale   — shared equally by the tip-sharing staff clocked in when it was
//            paid (attendance), else to whoever served;
//   hours  — each day's tips shared by the hours each of them worked that
//            day, else to whoever served.
// Who shares them: the till roles picked in the settings (waiters,
// cashiers, the kitchen, managers). Ghana keeps GMT, so days are UTC days.
// What is handed over is kept (restaurant_tip_payouts): what each person
// is still owed for the days looked at.

var METHODS = ['direct', 'sale', 'hours'];
var PAY_METHODS = ['cash', 'mobile_money', 'payroll', 'other'];
var MAX_SHIFT_HOURS = 16;
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function cents(n) { return Math.round(Number(n) * 100); }
function dayOf(d) { return new Date(d).toISOString().slice(0, 10); }

// `amount` shared out by weight, to the cent, adding up.
function share(amount, weights) {
  var keys = Object.keys(weights).filter(function (k) { return weights[k] > 0; });
  var out = {};
  if (!keys.length) return out;
  var sum = keys.reduce(function (a, k) { return a + weights[k]; }, 0);
  var total = cents(amount), given = 0;
  keys.forEach(function (k) { out[k] = Math.floor(total * weights[k] / sum); given += out[k]; });
  // The cents left over, one each, to the biggest shares first.
  keys.sort(function (a, b) { return weights[b] - weights[a] || (a < b ? -1 : 1); });
  for (var i = 0; given < total; i = (i + 1) % keys.length) { out[keys[i]] += 1; given += 1; }
  keys.forEach(function (k) { out[k] = out[k] / 100; });
  return out;
}

// Shifts clocked in the days, with the hours worked (a shift still open
// counts up to now, at most 16 hours).
async function shiftsOf(companyId, from, to, ids) {
  if (!ids.length) return [];
  return (await pool.query(
    "SELECT a.employee_id, to_char(a.date, 'YYYY-MM-DD') AS day, to_char(a.date + a.clock_in, 'YYYY-MM-DD\"T\"HH24:MI:SS') AS start_at, " +
    "  CASE WHEN a.clock_out IS NULL THEN NULL ELSE to_char(coalesce(a.clock_out_date, a.date) + a.clock_out, 'YYYY-MM-DD\"T\"HH24:MI:SS') END AS end_at " +
    'FROM attendance a WHERE a.employee_id = ANY($1::uuid[]) AND a.date BETWEEN $2::date - 1 AND $3 AND a.clock_in IS NOT NULL', [ids, from, to])).rows.map(function (r) {
    var start = new Date(r.start_at + 'Z');
    var end = r.end_at ? new Date(r.end_at + 'Z') : new Date(Math.min(Date.now(), start.getTime() + MAX_SHIFT_HOURS * 3600000));
    var hours = Math.max(0, Math.min(MAX_SHIFT_HOURS, (end - start) / 3600000));
    return { employeeId: r.employee_id, day: r.day, start: start, end: end, hours: hours };
  });
}

// POST /api/pos/settings/tips { managerPin, action: 'list', from, to, method }
async function report(companyId, q, settings) {
  q = q || {};
  var p = insights.periodOf(q);
  var poolCfg = settings.tips.pool || { method: 'direct', roles: [] };
  var method = METHODS.indexOf(q.method) >= 0 ? q.method : poolCfg.method;
  var staff = await access.staffOf(companyId);
  var byId = {};
  staff.forEach(function (s) { byId[s.id] = s; });
  // Without a role of their own on the till: the role everyone else has.
  function roleOf(s) { return s.role || settings.defaultRole || 'cashier'; }
  var sharing = staff.filter(function (s) { return poolCfg.roles.indexOf(roleOf(s)) >= 0; }).map(function (s) { return s.id; });

  var orders = (await pool.query(
    "SELECT o.id, o.order_no, o.tip, o.created_at, coalesce(o.waiter_id, o.cashier_id) AS server_id, " +
    "  w.first_name || ' ' || w.last_name AS server_name FROM restaurant_orders o LEFT JOIN employees w ON w.id = coalesce(o.waiter_id, o.cashier_id) " +
    "WHERE o.company_id = $1 AND o.status = 'completed' AND o.tip > 0 AND o.created_at >= $2::date AND o.created_at < $3::date + interval '1 day' ORDER BY o.created_at", [companyId, p.from, p.to])).rows;
  var shifts = method === 'direct' ? [] : await shiftsOf(companyId, p.from, p.to, sharing);

  var people = {};
  function person(id, name) {
    if (!people[id]) {
      var s = byId[id];
      people[id] = { id: id, name: s ? s.name : (name || '—'), role: s ? roleOf(s) : null, tips: 0, served: 0, servedTips: 0, hours: 0, paid: 0, owed: 0 };
    }
    return people[id];
  }
  function give(map) { Object.keys(map).forEach(function (id) { person(id).tips += map[id]; }); }
  var days = {}, fallback = 0;

  orders.forEach(function (o) {
    var tip = round2(o.tip), day = dayOf(o.created_at), server = person(o.server_id, o.server_name);
    server.served += 1; server.servedTips += tip;
    days[day] = days[day] || { day: day, tips: 0, orders: 0, list: [] };
    days[day].tips += tip; days[day].orders += 1; days[day].list.push(o);
    if (method === 'sale') {
      var at = new Date(o.created_at).getTime(), w = {};
      shifts.forEach(function (s) { if (s.start.getTime() <= at && s.end.getTime() >= at) w[s.employeeId] = 1; });
      if (Object.keys(w).length) give(share(tip, w));
      else { server.tips += tip; fallback += tip; }
    } else if (method === 'direct') server.tips += tip;
  });
  if (method === 'hours') {
    Object.keys(days).forEach(function (d) {
      var w = {};
      shifts.forEach(function (s) { if (s.day === d) w[s.employeeId] = (w[s.employeeId] || 0) + s.hours; });
      if (Object.keys(w).some(function (k) { return w[k] > 0; })) give(share(days[d].tips, w));
      else days[d].list.forEach(function (o) { person(o.server_id).tips += round2(o.tip); fallback += round2(o.tip); });
    });
  }
  // Hours on shift in the days, for whoever shares (and to show the split).
  if (method !== 'direct') shifts.forEach(function (s) { if (s.day >= p.from && s.day <= p.to) person(s.employeeId).hours += s.hours; });

  var payouts = (await pool.query(
    "SELECT tp.*, e.first_name || ' ' || e.last_name AS name, b.first_name || ' ' || b.last_name AS by_name FROM restaurant_tip_payouts tp JOIN employees e ON e.id = tp.employee_id " +
    'LEFT JOIN employees b ON b.id = tp.paid_by WHERE tp.company_id = $1 AND tp.through BETWEEN $2 AND $3 ORDER BY tp.created_at DESC', [companyId, p.from, p.to])).rows;
  payouts.forEach(function (r) { person(r.employee_id, r.name).paid += Number(r.amount); });

  var list = Object.keys(people).map(function (id) {
    var x = people[id];
    x.tips = round2(x.tips); x.servedTips = round2(x.servedTips); x.hours = round2(x.hours); x.paid = round2(x.paid);
    x.owed = round2(Math.max(0, x.tips - x.paid));
    return x;
  }).filter(function (x) { return x.tips > 0 || x.paid > 0 || x.hours > 0; }).sort(function (a, b) { return b.tips - a.tips || (a.name < b.name ? -1 : 1); });
  var total = round2(orders.reduce(function (a, o) { return a + Number(o.tip); }, 0));
  var dayList = [];
  for (var i = 0; i < p.days && i < 400; i++) {
    var d = new Date(Date.parse(p.from + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10);
    dayList.push({ day: d, tips: round2(days[d] ? days[d].tips : 0), orders: days[d] ? days[d].orders : 0 });
  }
  return {
    period: p, method: method, setMethod: poolCfg.method, roles: poolCfg.roles, on: !!settings.tips.on,
    total: total, orders: orders.length, average: orders.length ? round2(total / orders.length) : 0, fallback: round2(fallback),
    paid: round2(payouts.reduce(function (a, r) { return a + Number(r.amount); }, 0)), owed: round2(list.reduce(function (a, x) { return a + x.owed; }, 0)),
    people: list, days: dayList,
    payouts: payouts.map(function (r) { return { id: r.id, employeeId: r.employee_id, name: r.name, amount: round2(r.amount), method: r.method, note: r.note || '', through: dayOf(r.through), by: r.by_name || null, at: r.created_at }; })
  };
}

// { action: 'payout', employeeId, amount, method, note, through } — tips handed to someone.
async function payout(companyId, managerId, p) {
  p = p || {};
  var staff = await access.staffOf(companyId);
  var who = staff.find(function (s) { return s.id === p.employeeId; });
  if (!who) fail('invalid', 'Pick who the tips are paid to.');
  var amount = round2(p.amount);
  if (!(amount > 0 && amount <= 100000)) fail('invalid', 'Pay out from GHS 0.01 up.');
  var method = PAY_METHODS.indexOf(p.method) >= 0 ? p.method : 'cash';
  var through = /^\d{4}-\d{2}-\d{2}$/.test(p.through || '') ? p.through : new Date().toISOString().slice(0, 10);
  var row = (await pool.query('INSERT INTO restaurant_tip_payouts (company_id, employee_id, through, amount, method, note, paid_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [companyId, who.id, through, amount, method, String(p.note || '').replace(/\s+/g, ' ').trim().slice(0, 200), managerId])).rows[0];
  await activity.log(pool, { companyId: companyId, employeeId: managerId, app: 'till', action: 'tips.payout',
    summary: 'Tips paid out to ' + who.name + ': ' + amount.toFixed(2) + ' (' + method.replace('_', ' ') + ', up to ' + through + ').', amount: amount, refType: 'tip_payout', refId: row.id });
  return { id: row.id };
}
// { action: 'remove', id } — a payout put in by mistake.
async function remove(companyId, managerId, id) {
  var row = (await pool.query('DELETE FROM restaurant_tip_payouts WHERE id = $1 AND company_id = $2 RETURNING *', [String(id || ''), companyId])).rows[0];
  if (!row) fail('notfound', 'That payout is not there.');
  await activity.log(pool, { companyId: companyId, employeeId: managerId, app: 'till', action: 'tips.payout_removed',
    summary: 'A tips payout of ' + round2(row.amount).toFixed(2) + ' (up to ' + dayOf(row.through) + ') was taken off.', amount: round2(row.amount), refType: 'tip_payout', refId: row.id });
  return { ok: true };
}

// POST /api/pos/settings/tips { managerPin, action }
async function tab(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var companyId = m.session.posCompanyId;
  if (p.action === 'payout') await payout(companyId, m.manager.id, p);
  else if (p.action === 'remove') await remove(companyId, m.manager.id, p.id);
  return report(companyId, p, await access.settingsOf(companyId));
}

module.exports = { METHODS: METHODS, share: share, report: report, payout: payout, remove: remove, tab: tab };
