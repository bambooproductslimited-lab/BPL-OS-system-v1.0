var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var config = require('../config');
var roads = require('./restaurantRoutes.service');

// A rep's day of site visits on the map (the sales app's "Today's route";
// frontend CrmRoutePage.jsx): the visits still to do in the quickest
// order by car, from where the rep is now, with the roads, today's traffic
// and the time and distance of each leg — Google's Routes API with the
// server's key (restaurantRoutes.service.js tour()). Google reads the
// location of a visit nobody has placed yet, and where it put it is kept
// (placed_by 'address') so the pin shows from then on; a rep moves a pin,
// or presses "I'm here" at the site, to put it right (place()).
//
// Without the key, or if Google does not answer: the placed visits
// nearest first, joined by straight lines, the distance as the crow flies
// and a time guessed at town speed — marked estimate.

var TOWN_KMH = 25; // Accra by car, roughly, when Google is not asked
var MAX_STOPS = 25; // as many as Google orders in one go

function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function pointOf(lat, lng) {
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null;
  var a = Number(lat), b = Number(lng);
  if (!isFinite(a) || !isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: Math.round(a * 1e6) / 1e6, lng: Math.round(b * 1e6) / 1e6 };
}
function metersBetween(a, b) {
  var R = 6371000, rad = Math.PI / 180;
  var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
function guessLeg(from, to) {
  var m = metersBetween(from, to);
  var s = Math.round(m / (TOWN_KMH * 1000 / 3600));
  return { points: [[from.lat, from.lng], [to.lat, to.lng]], traffic: [], seconds: s, freeSeconds: s, meters: m, estimate: true };
}
// Where Google should look for a visit nobody has placed: its location, in Ghana.
function addressOf(stop) {
  var a = String(stop.location || '').trim();
  if (!a) return null;
  return /ghana/i.test(a) ? a : a + ', Ghana';
}

async function visitsOn(date, employeeId) {
  var res = await pool.query(
    'SELECT v.id, v.client, v.location, v.lat, v.lng, v.placed_by, v.status, v.lead_id, l.ref AS lead_ref, l.phone AS lead_phone, l.location AS lead_location, ' +
    "(SELECT coalesce(json_agg(e.first_name || ' ' || e.last_name ORDER BY e.first_name), '[]') FROM employees e WHERE e.id = ANY(v.assessor_ids)) AS people " +
    'FROM crm_site_visits v LEFT JOIN crm_leads l ON l.id = v.lead_id ' +
    "WHERE v.scheduled_on = $1 AND v.status <> 'cancelled' AND ($2::uuid IS NULL OR $2 = ANY(v.assessor_ids) OR v.created_by = $2) " +
    'ORDER BY v.created_at, v.id', [date, employeeId]);
  return res.rows.map(function (r) {
    return {
      id: r.id, client: r.client, location: r.location || r.lead_location || '', place: pointOf(r.lat, r.lng), placedBy: r.placed_by || null,
      status: r.status, leadId: r.lead_id, leadRef: r.lead_ref || null, phone: r.lead_phone || '', people: r.people || []
    };
  });
}

// Google's reading of a visit's location, kept unless someone has placed it since.
async function keepFound(stop, place) {
  if (!place || stop.place) return;
  stop.place = pointOf(place.lat, place.lng);
  stop.placedBy = 'address';
  await pool.query("UPDATE crm_site_visits SET lat = $2, lng = $3, placed_by = 'address' WHERE id = $1 AND lat IS NULL", [stop.id, stop.place.lat, stop.place.lng]);
}

// The order, the legs and the totals, by road or by guess.
async function plan(start, todo) {
  var out = { road: false, order: [], legs: [], back: null };
  if (roads.enabled()) {
    var routable = todo.filter(function (s) { return s.place || addressOf(s); }).slice(0, start ? MAX_STOPS : MAX_STOPS + 1);
    if (routable.length && (start || routable.length > 1)) {
      var origin = start || routable[0];
      var through = start ? routable : routable.slice(1);
      var wp = function (s) { return s.place ? s.place : { address: addressOf(s) }; };
      var t = await roads.tour(start || wp(origin), through.map(wp), null);
      if (t) {
        if (!start) await keepFound(origin, t.legs[0].from);
        var ordered = t.order.map(function (i) { return through[i]; });
        for (var k = 0; k < ordered.length; k++) await keepFound(ordered[k], t.legs[k].to);
        out.road = true;
        out.order = (start ? [] : [origin]).concat(ordered);
        out.legs = (start ? [] : [null]).concat(ordered.map(function (s, k) { return t.legs[k]; }));
        var home = t.legs[t.legs.length - 1];
        out.back = { seconds: home.seconds, freeSeconds: home.freeSeconds, meters: home.meters, points: home.points, traffic: home.traffic };
        return out;
      }
    }
  }
  // Nearest first, from where the rep is (or the first visit placed).
  var left = todo.filter(function (s) { return s.place; });
  var at = start;
  if (!at && left.length) { var first = left.shift(); out.order.push(first); out.legs.push(null); at = first.place; }
  while (left.length) {
    var best = 0;
    for (var i = 1; i < left.length; i++) if (metersBetween(at, left[i].place) < metersBetween(at, left[best].place)) best = i;
    var next = left.splice(best, 1)[0];
    out.order.push(next);
    out.legs.push(guessLeg(at, next.place));
    at = next.place;
  }
  if (start && out.order.length) out.back = guessLeg(at, start);
  return out;
}

// GET /api/crm/visits/day?date=&who=mine|all&lat=&lng=
// The day's visits (mine: the ones I am going on or booked; all: everyone's),
// the ones still to do in order with their legs, the rest after.
async function day(ctx, q) {
  need(ctx, 'crm.read');
  q = q || {};
  var date = q.date ? V.date(q.date, 'Date') : todayISO();
  var all = q.who === 'all';
  var start = pointOf(q.lat, q.lng);
  var stops = await visitsOn(date, all ? null : me(ctx));
  var todo = stops.filter(function (s) { return s.status === 'scheduled'; });
  var p = await plan(start, todo);
  var route = p.order.map(function (s, i) { return Object.assign({}, s, { n: i + 1, leg: p.legs[i] }); });
  var inRoute = new Set(p.order.map(function (s) { return s.id; }));
  var sum = function (key) { return route.reduce(function (a, s) { return a + (s.leg ? s.leg[key] || 0 : 0); }, 0); };
  return {
    date: date, who: all ? 'all' : 'mine', start: start, road: p.road, google: roads.enabled(),
    route: route,
    totals: { stops: route.length, seconds: sum('seconds'), freeSeconds: sum('freeSeconds'), meters: sum('meters'), estimate: !p.road },
    back: p.back,
    unplaced: todo.filter(function (s) { return !inRoute.has(s.id); }),
    done: stops.filter(function (s) { return s.status === 'visited'; }),
    map: { google: config.googleMapsKey ? { key: config.googleMapsKey } : null, region: 'GH' }
  };
}

// POST /api/crm/visits/:id/place { lat, lng, by: 'pin' | 'here' } or { clear: true }
// Where the visit is: a pin moved on the map, or the phone's place at the site.
async function place(ctx, id, p) {
  need(ctx, 'crm.manage');
  p = p || {};
  var cur = (await pool.query('SELECT id, client FROM crm_site_visits WHERE id = $1', [id])).rows[0];
  if (!cur) fail('notfound', 'Site visit not found.');
  if (p.clear) {
    await pool.query('UPDATE crm_site_visits SET lat = NULL, lng = NULL, placed_by = NULL, updated_at = now() WHERE id = $1', [id]);
    await audit(pool, ctx, 'crm.visit.place', 'crm_site_visit', id, 'Took ' + cur.client + '\'s site visit off the map.');
    return { id: id, place: null, placedBy: null };
  }
  var pt = pointOf(p.lat, p.lng);
  if (!pt) fail('invalid', 'Where is it? Place the pin on the map, or press "I\'m here" at the site.');
  var by = p.by === 'here' ? 'here' : 'pin';
  await pool.query('UPDATE crm_site_visits SET lat = $2, lng = $3, placed_by = $4, updated_at = now() WHERE id = $1', [id, pt.lat, pt.lng, by]);
  await audit(pool, ctx, 'crm.visit.place', 'crm_site_visit', id, 'Placed ' + cur.client + '\'s site visit on the map (' + (by === 'here' ? 'at the site' : 'a pin') + ').');
  return { id: id, place: pt, placedBy: by };
}

module.exports = { day: day, place: place, _plan: plan, _metersBetween: metersBetween };
