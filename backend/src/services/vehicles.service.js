var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// Vehicles and fuel (migration 0197): the vans, trucks, pickups, cars and
// motorbikes of every company, who drives each, its papers (insurance,
// roadworthiness — reminded before they run out, jobs/dailyAlerts.js), its
// service every so many km; and every fill-up — litres, what it cost, the
// odometer, a photo of the receipt — from which come the km per litre and
// the cost per km. Whoever looks after vehicles (vehicle.manage) adds and
// changes them; a driver logs fuel for the vehicles given to them.

var KINDS = ['van', 'truck', 'pickup', 'car', 'motorbike', 'tricycle', 'other'];
var FUELS = ['petrol', 'diesel', 'gas', 'electric'];
var PAID = ['cash', 'mobile_money', 'card', 'fuel_card', 'account'];
var DAY = /^\d{4}-\d{2}-\d{2}$/;
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }

// km per litre and cost per km, from full-tank fills: the litres of the
// fills after a full tank, up to the next full tank, over the km between.
function economy(logs) {
  var sorted = logs.filter(function (l) { return l.odometer != null; }).sort(function (a, b) { return a.odometer - b.odometer || (a.day < b.day ? -1 : 1); });
  var km = 0, litres = 0, cost = 0, startAt = null, pendL = 0, pendC = 0;
  var per = {};
  sorted.forEach(function (l) {
    if (startAt == null) { if (l.full_tank) startAt = l.odometer; return; }
    pendL += Number(l.litres); pendC += Number(l.amount);
    if (l.full_tank) {
      var d = l.odometer - startAt;
      if (d > 0) { km += d; litres += pendL; cost += pendC; per[l.id] = { km: d, kmPerLitre: round2(d / pendL) }; }
      startAt = l.odometer; pendL = 0; pendC = 0;
    }
  });
  return { km: km, kmPerLitre: litres > 0 ? round2(km / litres) : null, costPerKm: km > 0 ? round2(cost / km) : null, per: per };
}

function papers(v, t) {
  var out = [];
  [['insurance', v.insurance_until], ['roadworthy', v.roadworthy_until]].forEach(function (p) {
    if (!p[1]) { out.push({ key: p[0], until: null, daysLeft: null, state: 'missing' }); return; }
    var left = daysBetween(t, dayText(p[1]));
    out.push({ key: p[0], until: dayText(p[1]), daysLeft: left, state: left < 0 ? 'expired' : left <= 30 ? 'soon' : 'ok' });
  });
  return out;
}

function vehicleOut(v, logs, t) {
  var mine = logs.filter(function (l) { return l.vehicle_id === v.id; });
  var e = economy(mine);
  var month = t.slice(0, 7);
  var thisMonth = mine.filter(function (l) { return dayText(l.day).slice(0, 7) === month; });
  var last = mine.slice().sort(function (a, b) { return a.day < b.day ? 1 : a.day > b.day ? -1 : (b.created_at - a.created_at); })[0];
  var serviceAt = v.service_every_km ? (Number(v.last_service_km) || 0) + Number(v.service_every_km) : null;
  return {
    id: v.id, companyId: v.company_id, company: v.company_name || '', name: v.name, plate: v.plate, kind: v.kind, fuel: v.fuel, driver: v.driver_id ? { id: v.driver_id, name: nameOf(v.d_first, v.d_last) } : null,
    odometer: v.odometer, insuranceUntil: dayText(v.insurance_until), roadworthyUntil: dayText(v.roadworthy_until), serviceEveryKm: v.service_every_km, lastServiceKm: v.last_service_km,
    serviceAt: serviceAt, serviceIn: serviceAt != null && v.odometer != null ? serviceAt - v.odometer : null, notes: v.notes, active: v.active,
    papers: papers(v, t), kmPerLitre: e.kmPerLitre, costPerKm: e.costPerKm, kmTracked: e.km,
    month: { litres: round2(thisMonth.reduce(function (a, l) { return a + Number(l.litres); }, 0)), amount: round2(thisMonth.reduce(function (a, l) { return a + Number(l.amount); }, 0)), fills: thisMonth.length },
    lastFill: last ? { day: dayText(last.day), litres: round2(last.litres), amount: round2(last.amount), odometer: last.odometer } : null
  };
}

var SELECT = 'SELECT v.*, c.name AS company_name, d.first_name AS d_first, d.last_name AS d_last FROM vehicles v JOIN companies c ON c.id = v.company_id LEFT JOIN employees d ON d.id = v.driver_id ';

async function logsOf(ids, days) {
  if (!ids.length) return [];
  return (await pool.query(
    'SELECT f.*, e.first_name, e.last_name FROM fuel_logs f LEFT JOIN employees e ON e.id = f.by_id WHERE f.vehicle_id = ANY($1::uuid[]) AND f.day >= current_date - $2::int ORDER BY f.day DESC, f.created_at DESC',
    [ids, days || 400])).rows;
}

function canSee(ctx) { return ctx.can('vehicle.read') || ctx.can('vehicle.manage'); }

// GET /api/vehicles — every vehicle for those who may see them; a driver's own otherwise.
async function list(ctx, q) {
  q = q || {};
  var all = canSee(ctx);
  if (!all && !ctx.employee) fail('forbidden', 'Your role does not allow this action (vehicle.read).');
  var rows = (await pool.query(SELECT + (all ? 'WHERE ($1::boolean OR v.active)' : 'WHERE v.driver_id = $1 AND v.active') + ' ORDER BY v.active DESC, c.name, v.name',
    [all ? q.retired === '1' : ctx.employee.id])).rows;
  var t = today();
  var logs = await logsOf(rows.map(function (r) { return r.id; }), 400);
  var vehicles = rows.map(function (v) { return vehicleOut(v, logs, t); });
  var live = vehicles.filter(function (v) { return v.active; });
  var month = t.slice(0, 7);
  var monthLogs = logs.filter(function (l) { return dayText(l.day).slice(0, 7) === month; });
  var withCost = live.filter(function (v) { return v.costPerKm != null; });
  return {
    vehicles: vehicles, mine: ctx.employee ? vehicles.filter(function (v) { return v.driver && v.driver.id === ctx.employee.id && v.active; }).map(function (v) { return v.id; }) : [],
    summary: {
      vehicles: live.length, monthAmount: round2(monthLogs.reduce(function (a, l) { return a + Number(l.amount); }, 0)), monthLitres: round2(monthLogs.reduce(function (a, l) { return a + Number(l.litres); }, 0)),
      papersSoon: live.filter(function (v) { return v.papers.some(function (p) { return p.state === 'soon' || p.state === 'expired'; }); }).length,
      papersExpired: live.filter(function (v) { return v.papers.some(function (p) { return p.state === 'expired'; }); }).length,
      serviceDue: live.filter(function (v) { return v.serviceIn != null && v.serviceIn <= 500; }).length,
      costPerKm: withCost.length ? round2(withCost.reduce(function (a, v) { return a + v.costPerKm; }, 0) / withCost.length) : null
    },
    companies: all ? (await pool.query("SELECT id, code, name FROM companies WHERE coalesce(status, 'active') = 'active' ORDER BY name")).rows : [],
    drivers: ctx.can('vehicle.manage') ? (await pool.query("SELECT id, first_name, last_name FROM employees WHERE status = 'active' ORDER BY first_name, last_name LIMIT 1000")).rows.map(function (e) { return { id: e.id, name: nameOf(e.first_name, e.last_name) }; }) : [],
    kinds: KINDS, fuels: FUELS, paidWith: PAID, canManage: ctx.can('vehicle.manage'), today: t
  };
}

async function vehicleFor(ctx, id) {
  var v = (await pool.query(SELECT + 'WHERE v.id = $1', [uuidOr(id)])).rows[0];
  if (!v) fail('notfound', 'That vehicle is gone.');
  var driver = ctx.employee && v.driver_id === ctx.employee.id;
  if (!canSee(ctx) && !driver) fail('forbidden', 'That is not a vehicle you drive.');
  return { row: v, driver: driver };
}

// GET /api/vehicles/:id — with its fill-ups.
async function get(ctx, id) {
  var v = (await vehicleFor(ctx, id)).row;
  var logs = await logsOf([v.id], 3650);
  var e = economy(logs);
  var out = vehicleOut(v, logs, today());
  var sorted = logs.slice().sort(function (a, b) { return (b.odometer || 0) - (a.odometer || 0) || (a.day < b.day ? 1 : -1); });
  out.fills = logs.slice(0, 80).map(function (l) {
    var idx = sorted.indexOf(l), before = sorted.slice(idx + 1).find(function (x) { return x.odometer != null; });
    return {
      id: l.id, day: dayText(l.day), litres: round2(l.litres), amount: round2(l.amount), perLitre: round2(Number(l.amount) / Number(l.litres)), odometer: l.odometer, fullTank: l.full_tank,
      station: l.station, paidWith: l.paid_with, note: l.note, hasPhoto: !!l.photo, by: nameOf(l.first_name, l.last_name),
      km: l.odometer != null && before ? l.odometer - before.odometer : null, kmPerLitre: e.per[l.id] ? e.per[l.id].kmPerLitre : null
    };
  });
  // By month, the last 6.
  var months = {};
  logs.forEach(function (l) { var m = dayText(l.day).slice(0, 7); months[m] = months[m] || { month: m, litres: 0, amount: 0, fills: 0 }; months[m].litres += Number(l.litres); months[m].amount += Number(l.amount); months[m].fills++; });
  out.months = Object.keys(months).sort().slice(-6).map(function (m) { return { month: m, litres: round2(months[m].litres), amount: round2(months[m].amount), fills: months[m].fills }; });
  out.canManage = ctx.can('vehicle.manage');
  return out;
}

// POST /api/vehicles { id?, companyId, name, plate, kind, fuel, driverId, odometer, insuranceUntil, roadworthyUntil, serviceEveryKm, lastServiceKm, notes, active }
async function save(ctx, p) {
  if (!ctx.can('vehicle.manage')) fail('forbidden', 'Your role does not allow this action (vehicle.manage).');
  p = p || {};
  var co = (await pool.query('SELECT id FROM companies WHERE id = $1', [uuidOr(p.companyId)])).rows[0];
  if (!co) fail('invalid', 'Whose vehicle is it? Pick the company.');
  var name = text(p.name, 80);
  if (name.length < 2) fail('invalid', 'What is it? e.g. the white van.');
  var plate = text(p.plate, 20).toUpperCase();
  var date = function (v, label) { if (v === '' || v == null) return null; if (!DAY.test(String(v))) fail('invalid', label + ': pick a day.'); return v; };
  var num = function (v, label) { if (v === '' || v == null) return null; var n = Math.round(Number(v)); if (!(n >= 0 && n < 1e8)) fail('invalid', label + ': a number of km.'); return n; };
  var f = {
    name: name, plate: plate, kind: KINDS.indexOf(p.kind) >= 0 ? p.kind : 'van', fuel: FUELS.indexOf(p.fuel) >= 0 ? p.fuel : 'diesel', driverId: uuidOr(p.driverId),
    odometer: num(p.odometer, 'Odometer'), insurance: date(p.insuranceUntil, 'Insurance until'), roadworthy: date(p.roadworthyUntil, 'Roadworthy until'),
    every: num(p.serviceEveryKm, 'Service every'), lastService: num(p.lastServiceKm, 'Last service at'), notes: text(p.notes, 500), active: p.active === undefined ? true : !!p.active
  };
  if (f.every === 0) f.every = null;
  if (plate) {
    var dup = (await pool.query('SELECT id FROM vehicles WHERE upper(plate) = $1 AND id IS DISTINCT FROM $2', [plate, uuidOr(p.id)])).rows[0];
    if (dup) fail('conflict', plate + ' is on another vehicle already.');
  }
  var id;
  if (p.id) {
    var cur = (await pool.query('SELECT * FROM vehicles WHERE id = $1', [uuidOr(p.id)])).rows[0];
    if (!cur) fail('notfound', 'That vehicle is gone.');
    await pool.query('UPDATE vehicles SET company_id = $2, name = $3, plate = $4, kind = $5, fuel = $6, driver_id = $7, odometer = $8, insurance_until = $9, roadworthy_until = $10, service_every_km = $11, last_service_km = $12, notes = $13, active = $14, updated_at = now() WHERE id = $1',
      [cur.id, co.id, f.name, f.plate, f.kind, f.fuel, f.driverId, f.odometer, f.insurance, f.roadworthy, f.every, f.lastService, f.notes, f.active]);
    id = cur.id;
    await audit(pool, ctx, 'vehicle.update', 'vehicle', id, 'Vehicle ' + f.name + (f.plate ? ' (' + f.plate + ')' : '') + ' changed' + (cur.active && !f.active ? ', taken out of use' : '') + '.');
  } else {
    id = (await pool.query('INSERT INTO vehicles (company_id, name, plate, kind, fuel, driver_id, odometer, insurance_until, roadworthy_until, service_every_km, last_service_km, notes, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',
      [co.id, f.name, f.plate, f.kind, f.fuel, f.driverId, f.odometer, f.insurance, f.roadworthy, f.every, f.lastService, f.notes, f.active])).rows[0].id;
    await audit(pool, ctx, 'vehicle.create', 'vehicle', id, 'Vehicle ' + f.name + (f.plate ? ' (' + f.plate + ')' : '') + ' added.');
  }
  return get(ctx, id);
}

// POST /api/vehicles/:id/fuel { day, litres, amount, odometer, fullTank, station, paidWith, photo, note }
async function logFuel(ctx, id, p) {
  var who = await vehicleFor(ctx, id);
  var v = who.row;
  if (!ctx.can('vehicle.manage') && !who.driver) fail('forbidden', 'Only its driver, or whoever looks after vehicles, logs its fuel.');
  if (!v.active) fail('conflict', 'That vehicle is out of use.');
  p = p || {};
  var day = DAY.test(String(p.day || '')) ? p.day : today();
  if (day > today()) fail('invalid', 'Filled up on a day to come?');
  var litres = round2(p.litres), amount = round2(p.amount);
  if (!(litres > 0 && litres < 2000)) fail('invalid', 'How many litres?');
  if (!(amount > 0 && amount < 1e6)) fail('invalid', 'What did it cost?');
  var per = amount / litres;
  if (per < 1 || per > 200) fail('invalid', 'GHS ' + per.toFixed(2) + ' a litre? Check the litres and the amount.');
  var odo = p.odometer === '' || p.odometer == null ? null : Math.round(Number(p.odometer));
  if (odo != null && !(odo >= 0 && odo < 1e8)) fail('invalid', 'The odometer: a number of km.');
  if (odo != null && v.odometer != null && odo < Number(v.odometer)) {
    var later = (await pool.query('SELECT max(odometer) AS n FROM fuel_logs WHERE vehicle_id = $1 AND day > $2', [v.id, day])).rows[0].n;
    if (later == null) fail('invalid', 'The odometer read ' + v.odometer + ' km already: check the number.');
  }
  var photo = null;
  if (p.photo) { var ph = await require('./restaurantCashOffice.service').photoFrom(p.photo, 'fuel-receipt'); photo = { key: ph.key, type: ph.type }; }
  var row = (await pool.query(
    'INSERT INTO fuel_logs (vehicle_id, day, litres, amount, odometer, full_tank, station, paid_with, photo, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
    [v.id, day, litres, amount, odo, p.fullTank === undefined ? true : !!p.fullTank, text(p.station, 80), PAID.indexOf(p.paidWith) >= 0 ? p.paidWith : 'cash', photo, text(p.note, 300), ctx.employee ? ctx.employee.id : null])).rows[0];
  if (odo != null) await pool.query('UPDATE vehicles SET odometer = greatest(coalesce(odometer, 0), $2), updated_at = now() WHERE id = $1', [v.id, odo]);
  await audit(pool, ctx, 'vehicle.fuel', 'vehicle', v.id, 'Fuel for ' + v.name + (v.plate ? ' (' + v.plate + ')' : '') + ': ' + litres + ' L, GHS ' + amount.toFixed(2) + (odo != null ? ' at ' + odo + ' km' : '') + '.');
  void row;
  return get(ctx, v.id);
}

// DELETE /api/vehicles/fuel/:id — a wrong entry.
async function removeFuel(ctx, logId) {
  if (!ctx.can('vehicle.manage')) fail('forbidden', 'Your role does not allow this action (vehicle.manage).');
  var r = (await pool.query('DELETE FROM fuel_logs WHERE id = $1 RETURNING vehicle_id, litres, amount, day', [uuidOr(logId)])).rows[0];
  if (!r) fail('notfound', 'That entry is gone.');
  await audit(pool, ctx, 'vehicle.fuel', 'vehicle', r.vehicle_id, 'Fuel entry of ' + dayText(r.day) + ' removed (' + round2(r.litres) + ' L, GHS ' + round2(r.amount).toFixed(2) + ').');
  return get(ctx, r.vehicle_id);
}

// POST /api/vehicles/:id/serviced { odometer }
async function serviced(ctx, id, p) {
  if (!ctx.can('vehicle.manage')) fail('forbidden', 'Your role does not allow this action (vehicle.manage).');
  var v = (await vehicleFor(ctx, id)).row;
  var odo = Math.round(Number((p || {}).odometer));
  if (!(odo >= 0)) fail('invalid', 'At how many km was it serviced?');
  await pool.query('UPDATE vehicles SET last_service_km = $2, odometer = greatest(coalesce(odometer, 0), $2), updated_at = now() WHERE id = $1', [v.id, odo]);
  await audit(pool, ctx, 'vehicle.service', 'vehicle', v.id, v.name + ' serviced at ' + odo + ' km.');
  return get(ctx, v.id);
}

// GET /api/vehicles/fuel/:id/photo
async function photoKey(ctx, logId) {
  var l = (await pool.query('SELECT vehicle_id, photo FROM fuel_logs WHERE id = $1', [uuidOr(logId)])).rows[0];
  if (!l || !l.photo) fail('notfound', 'No photo.');
  await vehicleFor(ctx, l.vehicle_id);
  return { key: l.photo.key, name: 'fuel-receipt' + (l.photo.type === 'image/png' ? '.png' : '.jpg') };
}

// Papers running out, for the daily reminders.
async function papersDue(day) {
  return (await pool.query(
    "SELECT v.id, v.name, v.plate, v.driver_id, v.insurance_until::text AS insurance, v.roadworthy_until::text AS roadworthy, c.name AS company FROM vehicles v JOIN companies c ON c.id = v.company_id " +
    'WHERE v.active AND (v.insurance_until <= $1::date + 30 OR v.roadworthy_until <= $1::date + 30)', [day])).rows;
}

module.exports = { list: list, get: get, save: save, logFuel: logFuel, removeFuel: removeFuel, serviced: serviced, photoKey: photoKey, papersDue: papersDue, economy: economy, KINDS: KINDS };
