var { pool } = require('../db/pool');

// Everything that happens on a restaurant's till and kitchen screen, for the
// till settings' activity report (migration 0157): who signed in, what was
// sent to the kitchen and charged, refunds, VIP money, IOUs, the cash drawer,
// dishes done and served, tickets printed, and settings changed. Written by
// the services as things happen, in the same transaction when there is one;
// read by a manager (restaurantTillAccess.service.js activityReport).
//
// action is a dotted key the report groups and translates ("till.sale",
// "kds.served"); summary says it in plain words, for anyone reading the row
// as it is; details keeps what the screen shows besides (dishes, method…).

var APPS = ['till', 'kds', 'settings'];

// log(db, { companyId, employeeId, app, action, summary, amount, refType, refId, details })
// Never stops what it records: a failure to write the line is swallowed.
async function log(db, e) {
  try {
    await (db || pool).query(
      'INSERT INTO restaurant_activity (company_id, employee_id, app, action, summary, amount, ref_type, ref_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [e.companyId, e.employeeId || null, APPS.indexOf(e.app) >= 0 ? e.app : 'till', String(e.action).slice(0, 60), String(e.summary || '').slice(0, 400),
        e.amount == null ? null : Math.round(Number(e.amount) * 100) / 100, e.refType || null, e.refId || null, JSON.stringify(e.details || {})]);
  } catch (err) {
    // A transaction that failed already fails on its own; anything else is
    // not worth stopping a sale for.
    if (db && db !== pool) throw err;
  }
}

// The report: newest first, a page at a time (before: the last id seen),
// for a day range, one app, one person, or words in the summary.
async function list(companyId, q) {
  q = q || {};
  var args = [companyId], where = ['a.company_id = $1'];
  function arg(v) { args.push(v); return '$' + args.length; }
  if (q.from) where.push('a.at >= ' + arg(q.from) + '::date');
  if (q.to) where.push('a.at < ' + arg(q.to) + "::date + interval '1 day'");
  if (q.app && APPS.indexOf(q.app) >= 0) where.push('a.app = ' + arg(q.app));
  if (q.employeeId) where.push('a.employee_id = ' + arg(q.employeeId));
  if (q.kind) where.push('a.action LIKE ' + arg(String(q.kind).replace(/[%_]/g, '') + '%'));
  if (q.q && String(q.q).trim()) where.push('a.summary ILIKE ' + arg('%' + String(q.q).trim() + '%'));
  if (q.before) where.push('a.id < ' + arg(Number(q.before) || 0));
  var limit = Math.min(Math.max(Number(q.limit) || 80, 1), 300);
  var rows = (await pool.query(
    "SELECT a.*, e.first_name || ' ' || e.last_name AS who FROM restaurant_activity a LEFT JOIN employees e ON e.id = a.employee_id WHERE " +
    where.join(' AND ') + ' ORDER BY a.id DESC LIMIT ' + (limit + 1), args)).rows;
  var more = rows.length > limit;
  rows = rows.slice(0, limit);
  // The day's totals for the same filters, for the report's head.
  var sum = (await pool.query(
    "SELECT count(*)::int AS n, count(*) FILTER (WHERE a.action = 'till.sale')::int AS sales, coalesce(sum(a.amount) FILTER (WHERE a.action = 'till.sale'), 0) AS sold, " +
    "count(*) FILTER (WHERE a.action = 'till.refund')::int AS refunds, count(*) FILTER (WHERE a.action = 'till.kitchen')::int AS sent, " +
    "count(*) FILTER (WHERE a.app = 'kds')::int AS kitchen, count(DISTINCT a.employee_id)::int AS people " +
    'FROM restaurant_activity a WHERE ' + where.filter(function (w) { return w.indexOf('a.id <') !== 0; }).join(' AND '),
    args.slice(0, q.before ? args.length - 1 : args.length))).rows[0];
  var staff = (await pool.query(
    "SELECT DISTINCT e.id, e.first_name || ' ' || e.last_name AS name FROM restaurant_activity a JOIN employees e ON e.id = a.employee_id WHERE a.company_id = $1 AND a.at > now() - interval '60 days' ORDER BY 2",
    [companyId])).rows;
  return {
    rows: rows.map(function (r) {
      return { id: Number(r.id), at: r.at, app: r.app, action: r.action, summary: r.summary, amount: r.amount == null ? null : Number(r.amount),
        who: r.who || null, employeeId: r.employee_id, refType: r.ref_type, refId: r.ref_id, details: r.details || {} };
    }),
    more: more,
    totals: { events: sum.n, sales: sum.sales, sold: Math.round(Number(sum.sold) * 100) / 100, refunds: sum.refunds, sentToKitchen: sum.sent, kitchen: sum.kitchen, people: sum.people },
    staff: staff
  };
}

module.exports = { APPS: APPS, log: log, list: list };
