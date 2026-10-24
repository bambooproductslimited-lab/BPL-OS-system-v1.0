var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');

// Kitchen ticket times (the till's back office → Reports → Ticket times) —
// Square's KDS reporting: how long tickets took from reaching the kitchen
// (sent, or fired for a held course) to ready, against the kitchen's own
// targets (warn after, late after: Till settings → Kitchen); the median and
// the slowest tenth, by day, by hour, by station (each dish bumped there)
// and the slowest dishes, beside the period before. A ticket left on the
// screen for over 4 hours was forgotten, not cooked: it is counted apart.

var DAY = /^\d{4}-\d{2}-\d{2}$/;
var FORGOTTEN = 240;
function round1(n) { return Math.round(Number(n || 0) * 10) / 10; }
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
// The value below which a share of the times fall (0.5: the median).
function quantile(sorted, q) {
  if (!sorted.length) return null;
  var i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return round1(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}
function stats(list, k) {
  var mins = list.map(function (x) { return x.minutes; }).sort(function (a, b) { return a - b; });
  var n = mins.length;
  return {
    tickets: n, average: n ? round1(mins.reduce(function (a, b) { return a + b; }, 0) / n) : null, median: quantile(mins, 0.5), p90: quantile(mins, 0.9),
    late: list.filter(function (x) { return x.minutes > k.lateAfter; }).length, slow: list.filter(function (x) { return x.minutes > k.warnAfter && x.minutes <= k.lateAfter; }).length,
    onTime: n ? Math.round(list.filter(function (x) { return x.minutes <= k.warnAfter; }).length / n * 100) : null
  };
}

var TICKETS = "SELECT t.id, t.number, t.label, t.table_name, t.fulfillment, coalesce(t.fired_at, t.created_at) AS sent_at, " +
  "EXTRACT(EPOCH FROM (t.ready_at - coalesce(t.fired_at, t.created_at))) / 60 AS minutes FROM restaurant_kitchen_tickets t " +
  "WHERE t.company_id = $1 AND t.ready_at IS NOT NULL AND t.status IN ('ready', 'served') AND coalesce(t.fired_at, t.created_at) >= $2::date " +
  "AND coalesce(t.fired_at, t.created_at) < $3::date + interval '1 day' AND t.ready_at >= coalesce(t.fired_at, t.created_at)";

async function ticketsOf(companyId, p) {
  return (await pool.query(TICKETS, [companyId, p.from, p.to])).rows.map(function (r) {
    return { id: r.id, number: r.number, label: r.label || r.table_name || '', fulfillment: r.fulfillment || '', sentAt: r.sent_at, minutes: Number(r.minutes) };
  });
}

// report(companyId, { from, to }, till settings)
async function report(companyId, q, settings) {
  q = q || {};
  var k = Object.assign({ warnAfter: 10, lateAfter: 20 }, settings && settings.kitchen);
  var p = periodOf(q);
  var all = await ticketsOf(companyId, p);
  var forgotten = all.filter(function (t) { return t.minutes > FORGOTTEN; }).length;
  var list = all.filter(function (t) { return t.minutes <= FORGOTTEN; });
  var before = { from: addDays(p.from, -p.days), to: addDays(p.from, -1) };
  var prev = (await ticketsOf(companyId, before)).filter(function (t) { return t.minutes <= FORGOTTEN; });

  var byDay = [];
  for (var i = 0; i < p.days; i++) {
    var d = addDays(p.from, i);
    var on = list.filter(function (t) { return new Date(t.sentAt).toISOString().slice(0, 10) === d; });
    byDay.push(Object.assign({ day: d }, stats(on, k)));
  }
  var hours = {};
  list.forEach(function (t) { var h = new Date(t.sentAt).getUTCHours(); (hours[h] = hours[h] || []).push(t); });
  var byHour = Object.keys(hours).map(Number).sort(function (a, b) { return a - b; }).map(function (h) { return Object.assign({ hour: h }, stats(hours[h], k)); });
  var kinds = {};
  list.forEach(function (t) { var f = t.fulfillment || 'dine_in'; (kinds[f] = kinds[f] || []).push(t); });
  var byFulfillment = Object.keys(kinds).map(function (f) { return Object.assign({ fulfillment: f }, stats(kinds[f], k)); });

  // Each dish, from its ticket reaching the kitchen to its bump at its station.
  var items = (await pool.query(
    "SELECT i.name, i.station_id, s.name AS station, EXTRACT(EPOCH FROM (i.done_at - coalesce(t.fired_at, t.created_at))) / 60 AS minutes " +
    "FROM restaurant_kitchen_items i JOIN restaurant_kitchen_tickets t ON t.id = i.ticket_id LEFT JOIN restaurant_kds_stations s ON s.id = i.station_id " +
    "WHERE t.company_id = $1 AND i.status = 'done' AND i.done_at IS NOT NULL AND coalesce(t.fired_at, t.created_at) >= $2::date AND coalesce(t.fired_at, t.created_at) < $3::date + interval '1 day' " +
    'AND i.done_at >= coalesce(t.fired_at, t.created_at)', [companyId, p.from, p.to])).rows
    .map(function (r) { return { name: r.name, station: r.station || 'Kitchen', minutes: Number(r.minutes) }; })
    .filter(function (r) { return r.minutes <= FORGOTTEN; });
  var stations = {}, dishes = {};
  items.forEach(function (r) { (stations[r.station] = stations[r.station] || []).push(r); (dishes[r.name] = dishes[r.name] || []).push(r); });
  var byStation = Object.keys(stations).map(function (n) { return Object.assign({ station: n }, stats(stations[n], k)); }).sort(function (a, b) { return b.average - a.average; });
  var slowestDishes = Object.keys(dishes).filter(function (n) { return dishes[n].length >= 2; })
    .map(function (n) { var s = stats(dishes[n], k); return { name: n, made: s.tickets, average: s.average, p90: s.p90, late: s.late }; })
    .sort(function (a, b) { return b.average - a.average; }).slice(0, 8);
  var slowestTickets = list.slice().sort(function (a, b) { return b.minutes - a.minutes; }).slice(0, 6)
    .map(function (t) { return { number: t.number, label: t.label, fulfillment: t.fulfillment, sentAt: t.sentAt, minutes: round1(t.minutes) }; });

  return {
    from: p.from, to: p.to, days: p.days, targets: { warnAfter: k.warnAfter, lateAfter: k.lateAfter },
    totals: Object.assign(stats(list, k), { forgotten: forgotten }), before: Object.assign({ from: before.from, to: before.to }, stats(prev, k)),
    byDay: byDay, byHour: byHour, byFulfillment: byFulfillment, byStation: byStation, slowestDishes: slowestDishes, slowestTickets: slowestTickets
  };
}

module.exports = { report: report, quantile: quantile };
