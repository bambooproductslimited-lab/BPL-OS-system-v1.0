var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Supplier scorecards (migration 0201): how each supplier has done over the
// last months, from what is already recorded — the restaurants' purchase
// orders (on the day expected? everything that was ordered? dearer than last
// time?), the raw bamboo taken in at Bamboo Products (its grade, its price
// against the delivery before) — and from a quick rating of a delivery by
// whoever took it in. Five parts weighed into a score out of 100 and a grade:
// A from 85, B from 70, C from 55, D below. Too few deliveries: no grade yet.

var WEIGHTS = { delivery: 25, completeness: 15, quality: 30, price: 20, service: 10 };
var PARTS = ['delivery', 'completeness', 'quality', 'price', 'service'];
var GRADE_POINTS = { A: 100, B: 70, C: 40 };
var MIN_POINTS = 3;
var WINDOWS = [90, 180, 365];

function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function round1(n) { return Math.round(Number(n) * 10) / 10; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function avg(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
function addDays(day, n) { var d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function seeBpl(ctx) { return ctx.can('supplier.read') || ctx.can('supplier.manage') || ctx.can('procurement.approve'); }
function seeRest(ctx) { return ctx.can('restaurant.read') || ctx.can('restaurant.manage'); }
function canRate(ctx, kind) { return kind === 'restaurant' ? ctx.can('restaurant.manage') : ctx.can('supplier.manage') || ctx.can('procurement.approve'); }
function needRead(ctx) { if (!seeBpl(ctx) && !seeRest(ctx)) fail('forbidden', 'Your role does not allow this action (supplier.read).'); }
function gradeOf(score) { return score == null ? null : score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D'; }
// A price that went up by p% scores 100 − 5p; one that held or fell, 100.
function priceScore(rise) { return Math.max(0, Math.min(100, 100 - Math.max(0, rise) * 5)); }
function stars(v) { return v == null ? null : (Number(v) - 1) / 4 * 100; }

// Everything recorded between two days, by supplier ('bpl:<id>' or 'restaurant:<id>').
async function gather(from, to, ctx) {
  var acc = {};
  var slot = function (key) { return acc[key] || (acc[key] = { delivery: [], completeness: [], quality: [], price: [], service: [], deliveries: 0, ratings: 0, spend: 0, last: null, events: [] }); };
  var seen = function (a, day) { if (!a.last || day > a.last) a.last = day; };
  if (seeRest(ctx)) {
    var pos = (await pool.query("SELECT id, number, company_id, supplier_id, expected_on, received_at, total FROM restaurant_purchase_orders WHERE status = 'received' AND supplier_id IS NOT NULL AND received_at >= $1::date AND received_at < $2::date + 1", [from, to])).rows;
    var lines = pos.length ? (await pool.query('SELECT po_id, qty, received_qty, unit_cost, previous_cost FROM restaurant_purchase_order_lines WHERE po_id = ANY($1)', [pos.map(function (o) { return o.id; })])).rows : [];
    var byPo = {};
    lines.forEach(function (l) { (byPo[l.po_id] = byPo[l.po_id] || []).push(l); });
    pos.forEach(function (o) {
      var a = slot('restaurant:' + o.supplier_id), day = dayText(o.received_at);
      a.deliveries++; a.spend += Number(o.total); seen(a, day);
      var ev = { kind: 'order', ref: 'PO-' + o.number, day: day, expected: dayText(o.expected_on), total: Number(o.total) };
      if (o.expected_on) { ev.onTime = day <= dayText(o.expected_on); a.delivery.push(ev.onTime ? 100 : 0); }
      var ls = byPo[o.id] || [];
      var asked = ls.filter(function (l) { return l.received_qty != null; });
      var q = asked.reduce(function (s, l) { return s + Number(l.qty); }, 0);
      if (q > 0) { ev.fill = round1(asked.reduce(function (s, l) { return s + Math.min(Number(l.received_qty), Number(l.qty)); }, 0) / q * 100); a.completeness.push(ev.fill); }
      var rises = ls.filter(function (l) { return Number(l.previous_cost) > 0; }).map(function (l) { return (Number(l.unit_cost) - Number(l.previous_cost)) / Number(l.previous_cost) * 100; });
      if (rises.length) { ev.priceChange = round1(avg(rises)); a.price.push(priceScore(ev.priceChange)); }
      a.events.push(ev);
    });
  }
  if (seeBpl(ctx)) {
    var batches = (await pool.query("SELECT id, batch_no, supplier_id, date_received, quantity, unit, quality_grade, cost, species FROM raw_batches WHERE supplier_id IS NOT NULL AND date_received >= $1 AND date_received <= $2 ORDER BY date_received", [from, to])).rows;
    var lastPrice = {};
    batches.forEach(function (b) {
      var a = slot('bpl:' + b.supplier_id), day = dayText(b.date_received);
      a.deliveries++; a.spend += Number(b.cost); seen(a, day);
      var ev = { kind: 'intake', ref: b.batch_no, day: day, qty: Number(b.quantity), unit: b.unit, grade: b.quality_grade || null, total: Number(b.cost), what: b.species };
      if (GRADE_POINTS[b.quality_grade] != null) a.quality.push(GRADE_POINTS[b.quality_grade]);
      var each = Number(b.quantity) > 0 && Number(b.cost) > 0 ? Number(b.cost) / Number(b.quantity) : null;
      var k = b.supplier_id + '|' + b.species + '|' + b.unit;
      if (each != null) {
        if (lastPrice[k]) { ev.priceChange = round1((each - lastPrice[k]) / lastPrice[k] * 100); a.price.push(priceScore(ev.priceChange)); }
        lastPrice[k] = each;
      }
      a.events.push(ev);
    });
  }
  var kinds = [];
  if (seeBpl(ctx)) kinds.push('bpl');
  if (seeRest(ctx)) kinds.push('restaurant');
  var ratings = (await pool.query('SELECT r.*, e.first_name, e.last_name FROM supplier_ratings r LEFT JOIN employees e ON e.id = r.by_id WHERE r.kind = ANY($3) AND r.delivered_on >= $1 AND r.delivered_on <= $2', [from, to, kinds])).rows;
  ratings.forEach(function (r) {
    var a = slot(r.kind + ':' + r.supplier_id), day = dayText(r.delivered_on);
    a.ratings++; seen(a, day);
    if (r.on_time != null) a.delivery.push(r.on_time ? 100 : 0);
    if (r.complete != null) a.completeness.push(r.complete ? 100 : 0);
    if (r.quality != null) a.quality.push(stars(r.quality));
    if (r.price != null) a.price.push(stars(r.price));
    if (r.service != null) a.service.push(stars(r.service));
    a.events.push({ kind: 'rating', ref: r.ref, day: day, onTime: r.on_time, complete: r.complete, quality: r.quality, service: r.service, price: r.price, note: r.note, by: r.first_name ? (r.first_name + ' ' + (r.last_name || '')).trim() : null });
  });
  return acc;
}

// The five parts, the score and the grade.
function scoreOf(a) {
  var parts = {}, wsum = 0, ssum = 0, points = 0;
  PARTS.forEach(function (p) {
    var vals = a ? a[p] : [];
    var v = avg(vals);
    parts[p] = { score: v == null ? null : Math.round(v), n: vals.length };
    if (v != null) { wsum += WEIGHTS[p]; ssum += WEIGHTS[p] * v; points += vals.length; }
  });
  var score = wsum > 0 && points >= MIN_POINTS ? Math.round(ssum / wsum) : null;
  return { parts: parts, score: score, grade: gradeOf(score), points: points };
}

async function suppliersList(ctx) {
  var list = [];
  if (seeBpl(ctx)) (await pool.query("SELECT id, name, contact_person, phone, materials_supplied, status FROM suppliers ORDER BY name")).rows.forEach(function (s) {
    list.push({ key: 'bpl:' + s.id, kind: 'bpl', id: s.id, name: s.name, company: { code: 'BPL', name: 'Bamboo Products' }, contact: s.contact_person, phone: s.phone, supplies: s.materials_supplied, active: s.status === 'active' });
  });
  if (seeRest(ctx)) (await pool.query('SELECT s.id, s.name, s.phone, s.active, s.company_id, c.name AS company, c.code FROM restaurant_suppliers s JOIN companies c ON c.id = s.company_id ORDER BY s.name')).rows.forEach(function (s) {
    list.push({ key: 'restaurant:' + s.id, kind: 'restaurant', id: s.id, name: s.name, company: { id: s.company_id, code: s.code, name: s.company }, contact: '', phone: s.phone, supplies: '', active: s.active });
  });
  return list;
}

function windowOf(q) { var d = Number(q && q.days); return WINDOWS.indexOf(d) >= 0 ? d : 180; }

// GET /api/scorecards?days=180&company=BPL|<code>
async function overview(ctx, q) {
  needRead(ctx);
  q = q || {};
  var days = windowOf(q);
  var to = today(), from = addDays(to, -days + 1);
  var now = await gather(from, to, ctx);
  var before = await gather(addDays(from, -days), addDays(from, -1), ctx);
  var list = await suppliersList(ctx);
  var rows = list.map(function (s) {
    var a = now[s.key], sc = scoreOf(a), prev = scoreOf(before[s.key]);
    return Object.assign(s, sc, {
      deliveries: a ? a.deliveries : 0, ratings: a ? a.ratings : 0, spend: round2(a ? a.spend : 0), last: a ? a.last : null,
      before: prev.score, change: sc.score != null && prev.score != null ? sc.score - prev.score : null
    });
  }).filter(function (s) { return s.active || s.deliveries || s.ratings; });
  var companies = [];
  rows.forEach(function (s) { if (!companies.find(function (c) { return c.code === s.company.code; })) companies.push(s.company); });
  if (q.company) rows = rows.filter(function (s) { return s.company.code === q.company; });
  rows.sort(function (a, b) { return (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score) || b.deliveries - a.deliveries || a.name.localeCompare(b.name); });
  var graded = rows.filter(function (s) { return s.grade; });
  return {
    suppliers: rows, companies: companies, days: days, windows: WINDOWS, weights: WEIGHTS, minPoints: MIN_POINTS,
    canRate: { bpl: canRate(ctx, 'bpl'), restaurant: canRate(ctx, 'restaurant') },
    summary: {
      graded: graded.length, a: graded.filter(function (s) { return s.grade === 'A'; }).length,
      watch: graded.filter(function (s) { return s.grade === 'D' || (s.change != null && s.change <= -10); }).length,
      average: graded.length ? Math.round(avg(graded.map(function (s) { return s.score; }))) : null,
      spend: round2(rows.reduce(function (a, s) { return a + s.spend; }, 0)),
      deliveries: rows.reduce(function (a, s) { return a + s.deliveries; }, 0)
    }
  };
}

async function supplierOf(ctx, kind, id) {
  var list = await suppliersList(ctx);
  var s = list.find(function (x) { return x.kind === kind && x.id === uuidOr(id); });
  if (!s) fail('notfound', 'That supplier is gone, or not yours to see.');
  return s;
}

// GET /api/scorecards/:kind/:id?days= — the parts explained, six months
// month by month, and the deliveries behind it.
async function get(ctx, kind, id, q) {
  needRead(ctx);
  var s = await supplierOf(ctx, kind, id);
  var days = windowOf(q);
  var to = today(), from = addDays(to, -days + 1);
  var a = (await gather(from, to, ctx))[s.key];
  var sc = scoreOf(a);
  var months = [];
  for (var i = 5; i >= 0; i--) {
    var d = new Date(to.slice(0, 7) + '-01T12:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - i);
    var mFrom = d.toISOString().slice(0, 10);
    var next = new Date(d); next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(0);
    var m = scoreOf((await gather(mFrom, next.toISOString().slice(0, 10), ctx))[s.key]);
    var raw = PARTS.reduce(function (acc, p) { return acc + m.parts[p].n; }, 0);
    months.push({ month: mFrom.slice(0, 7), score: m.score, points: raw });
  }
  return Object.assign(s, sc, {
    days: days, weights: WEIGHTS, minPoints: MIN_POINTS, months: months,
    deliveries: a ? a.deliveries : 0, ratings: a ? a.ratings : 0, spend: round2(a ? a.spend : 0), last: a ? a.last : null,
    events: (a ? a.events : []).sort(function (x, y) { return y.day.localeCompare(x.day); }).slice(0, 40),
    canRate: canRate(ctx, kind)
  });
}

// POST /api/scorecards/rate { kind, supplierId, ref, deliveredOn, onTime,
// complete, quality, service, price, note }
async function rate(ctx, p) {
  p = p || {};
  var kind = p.kind === 'restaurant' ? 'restaurant' : 'bpl';
  if (!canRate(ctx, kind)) fail('forbidden', 'Your role does not allow this action (' + (kind === 'restaurant' ? 'restaurant.manage' : 'supplier.manage') + ').');
  var s = await supplierOf(ctx, kind, p.supplierId);
  var star = function (v) { if (v === null || v === undefined || v === '') return null; var n = Math.round(Number(v)); if (!(n >= 1 && n <= 5)) fail('invalid', 'One to five stars.'); return n; };
  var quality = star(p.quality), service = star(p.service), price = star(p.price);
  var onTime = typeof p.onTime === 'boolean' ? p.onTime : null, complete = typeof p.complete === 'boolean' ? p.complete : null;
  if (quality == null && service == null && price == null && onTime == null && complete == null) fail('invalid', 'Rate at least one thing.');
  var day = /^\d{4}-\d{2}-\d{2}$/.test(String(p.deliveredOn || '')) ? p.deliveredOn : today();
  if (day > today()) fail('invalid', 'When did it come? Today or before.');
  var row = (await pool.query('INSERT INTO supplier_ratings (kind, supplier_id, company_id, ref, delivered_on, on_time, complete, quality, service, price, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
    [kind, s.id, s.company.id || null, text(p.ref, 60), day, onTime, complete, quality, service, price, text(p.note, 500), me(ctx)])).rows[0];
  // A poor delivery: those who buy are told.
  if ((quality != null && quality <= 2) || onTime === false && complete === false) {
    var ids = kind === 'restaurant' ? await require('./restaurantPurchasing.service').managersOf(pool, s.company.id)
      : (await require('./staffAlerts.service').holdersOf(['supplier.manage', 'procurement.approve'])).map(function (h) { return h.employee_id; });
    var told = {};
    for (var i = 0; i < ids.length; i++) {
      if (!ids[i] || ids[i] === me(ctx) || told[ids[i]]) continue;
      told[ids[i]] = true;
      await notify(pool, ids[i], '👎 A poor delivery from ' + s.name, (text(p.ref, 60) ? text(p.ref, 60) + ': ' : '') + (text(p.note, 140) || 'Rated low on ' + day + '.'), '/scorecards?supplier=' + kind + ':' + s.id);
    }
  }
  await audit(pool, ctx, 'supplier.rate', 'supplier', s.id, s.name + ' rated for a delivery on ' + day + '.');
  return Object.assign(await get(ctx, kind, s.id, { days: p.days }), { ratingId: row.id });
}

// Each supplier's score and grade over the last days, by key ('bpl:<id>',
// 'restaurant:<id>'): for the outgrowers and the requests for quotes.
async function grades(ctx, days) {
  var to = today(), from = addDays(to, -(days || 180) + 1);
  var acc = await gather(from, to, ctx);
  var out = {};
  Object.keys(acc).forEach(function (k) { var s = scoreOf(acc[k]); out[k] = { score: s.score, grade: s.grade, deliveries: acc[k].deliveries }; });
  return out;
}

module.exports = { grades: grades, overview: overview, get: get, rate: rate, scoreOf: scoreOf, gradeOf: gradeOf, priceScore: priceScore, WEIGHTS: WEIGHTS };
