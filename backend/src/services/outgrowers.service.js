var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var scorecards = require('./scorecards.service');
var rawBatches = require('./rawBatches.service');

// Bamboo outgrowers (migration 0203): the farmers who grow bamboo for
// Bamboo Products. Each is a supplier (migration 0067) marked as an
// outgrower, with their Mobile Money number and their plots — where, how
// big, the next harvest and what it should give, cut again every so many
// months. From the plots, the harvests expected month by month. Money
// advanced to a farmer is taken back from what their deliveries are worth;
// each delivery (a raw batch) is paid once, usually by Mobile Money, and
// the farmer can be texted what was paid. Their grade is the supplier
// scorecard's.

var METHODS = ['mobile_money', 'cash', 'bank'];
var NETWORKS = ['MTN', 'Telecel', 'AirtelTigo'];
var DAY = /^\d{4}-\d{2}-\d{2}$/;
var MONTHS_AHEAD = 6;

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function addMonths(day, n) { var d = new Date(day + 'T12:00:00Z'); var want = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(want, last)); return d.toISOString().slice(0, 10); }
function money(n) { return 'GHS ' + round2(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function nameOf(first, last) { return first ? (first + ' ' + (last || '')).trim() : null; }
function canRead(ctx) { return ctx.can('supplier.read') || ctx.can('supplier.manage') || ctx.can('procurement.approve') || ctx.can('bill.read'); }
function canEdit(ctx) { return ctx.can('supplier.manage') || ctx.can('procurement.approve'); }
function canPay(ctx) { return ctx.can('procurement.approve') || ctx.can('bill.manage'); }
function needRead(ctx) { if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (supplier.read).'); }
function needEdit(ctx) { if (!canEdit(ctx)) fail('forbidden', 'Your role does not allow this action (supplier.manage).'); }
function needPay(ctx) { if (!canPay(ctx)) fail('forbidden', 'Your role does not allow this action (procurement.approve).'); }
function amountOf(v, label, opts) {
  var n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || n < 0 || n > 1e8 || (opts && opts.positive && !(n > 0))) fail('invalid', label);
  return round2(n);
}
function optNum(v, label, max) {
  if (v === '' || v == null) return null;
  var n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > (max || 1e8)) fail('invalid', label);
  return n;
}
function coord(v, limit, label) {
  if (v === '' || v == null) return null;
  var n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > limit) fail('invalid', label);
  return Math.round(n * 1e6) / 1e6;
}
function optDay(v, label) {
  if (!v) return null;
  if (!DAY.test(String(v))) fail('invalid', label);
  return String(v);
}

// The harvests a plot should give from this month on: its next one, then
// one every cycle.
function harvestsOf(plot, from, until) {
  var out = [];
  if (!plot.active || !plot.next_harvest) return out;
  var d = dayText(plot.next_harvest), guard = 0;
  // Not cut yet: still to come this month, then a cycle on.
  if (d < from) { out.push({ day: from, late: true, qty: Number(plot.expected_qty || 0) }); d = addMonths(from, plot.cycle_months); }
  while (d < until && guard++ < 80) {
    out.push({ day: d, late: false, qty: Number(plot.expected_qty || 0) });
    d = addMonths(d, plot.cycle_months);
  }
  return out;
}

function plotOut(p, day) {
  var next = dayText(p.next_harvest);
  return {
    id: p.id, supplierId: p.supplier_id, name: p.name, place: p.place, lat: p.lat == null ? null : Number(p.lat), lng: p.lng == null ? null : Number(p.lng),
    hectares: p.hectares == null ? null : Number(p.hectares), species: p.species, clumps: p.clumps, plantedYear: p.planted_year,
    cycleMonths: p.cycle_months, nextHarvest: next, expectedQty: p.expected_qty == null ? null : Number(p.expected_qty), unit: p.unit,
    note: p.note, active: p.active, overdue: !!(next && p.active && next < addDays(day || today(), -14))
  };
}

// Everything about the outgrowers, from a handful of queries.
async function load() {
  var farmers = (await pool.query("SELECT * FROM suppliers WHERE outgrower ORDER BY name")).rows;
  var ids = farmers.map(function (f) { return f.id; });
  var plots = ids.length ? (await pool.query('SELECT * FROM outgrower_plots WHERE supplier_id = ANY($1) ORDER BY active DESC, next_harvest NULLS LAST, name', [ids])).rows : [];
  var advances = ids.length ? (await pool.query('SELECT a.*, e.first_name, e.last_name FROM outgrower_advances a LEFT JOIN employees e ON e.id = a.by_id WHERE a.supplier_id = ANY($1) ORDER BY a.given_on DESC, a.created_at DESC', [ids])).rows : [];
  var payments = ids.length ? (await pool.query('SELECT p.*, rb.batch_no, e.first_name, e.last_name FROM outgrower_payments p LEFT JOIN raw_batches rb ON rb.id = p.raw_batch_id LEFT JOIN employees e ON e.id = p.by_id WHERE p.supplier_id = ANY($1) ORDER BY p.paid_on DESC, p.created_at DESC', [ids])).rows : [];
  var batches = ids.length ? (await pool.query(
    "SELECT rb.*, (SELECT id FROM outgrower_payments op WHERE op.raw_batch_id = rb.id) AS payment_id FROM raw_batches rb WHERE rb.supplier_id = ANY($1) AND rb.date_received >= current_date - 730 ORDER BY rb.date_received DESC, rb.batch_no DESC", [ids])).rows : [];
  return { farmers: farmers, plots: plots, advances: advances, payments: payments, batches: batches };
}

function batchOut(b) {
  return {
    id: b.id, batchNo: b.batch_no, day: dayText(b.date_received), species: b.species, qty: Number(b.received_qty == null ? b.quantity : b.received_qty), unit: b.unit,
    grade: b.quality_grade || null, value: round2(b.cost), paid: !!b.payment_id
  };
}
function paymentOut(p) {
  return {
    id: p.id, batchId: p.raw_batch_id, batchNo: p.batch_no || null, amount: round2(p.amount), advanceTaken: round2(p.advance_taken), paid: round2(p.paid),
    method: p.method, momoNumber: p.momo_number, reference: p.reference, day: dayText(p.paid_on), note: p.note, texted: p.texted, by: nameOf(p.first_name, p.last_name)
  };
}
function advanceOut(a) {
  return { id: a.id, amount: round2(a.amount), day: dayText(a.given_on), method: a.method, reference: a.reference, note: a.note, by: nameOf(a.first_name, a.last_name) };
}

function farmerOut(f, d, grades, day) {
  var plots = d.plots.filter(function (p) { return p.supplier_id === f.id; });
  var active = plots.filter(function (p) { return p.active; });
  var advanced = d.advances.filter(function (a) { return a.supplier_id === f.id; }).reduce(function (s, a) { return s + Number(a.amount); }, 0);
  var pays = d.payments.filter(function (p) { return p.supplier_id === f.id; });
  var recovered = pays.reduce(function (s, p) { return s + Number(p.advance_taken); }, 0);
  var batches = d.batches.filter(function (b) { return b.supplier_id === f.id; });
  var unpaid = batches.filter(function (b) { return !b.payment_id && Number(b.cost) > 0; });
  var yearAgo = addDays(day, -365);
  var next = active.map(function (p) { return dayText(p.next_harvest); }).filter(Boolean).sort()[0] || null;
  var soon = active.reduce(function (s, p) { var n = dayText(p.next_harvest); return s + (n && n <= addDays(day, 90) ? Number(p.expected_qty || 0) : 0); }, 0);
  var g = grades['bpl:' + f.id] || {};
  return {
    id: f.id, name: f.name, phone: f.phone, phone2: f.phone2, town: f.town, district: f.district, region: f.region, contact: f.contact_person,
    momoNumber: f.momo_number, momoNetwork: f.momo_network, joinedOn: dayText(f.joined_on), notes: f.notes, active: f.status === 'active',
    quotedPrice: f.quoted_price == null ? null : Number(f.quoted_price), priceUnit: f.price_unit,
    plots: active.length, hectares: round2(active.reduce(function (s, p) { return s + Number(p.hectares || 0); }, 0)),
    nextHarvest: next, soonQty: round2(soon), overdue: active.some(function (p) { return plotOut(p, day).overdue; }),
    advanced: round2(advanced), recovered: round2(recovered), advanceLeft: round2(advanced - recovered),
    owed: round2(unpaid.reduce(function (s, b) { return s + Number(b.cost); }, 0)), unpaid: unpaid.length,
    deliveredYear: round2(batches.filter(function (b) { return dayText(b.date_received) >= yearAgo; }).reduce(function (s, b) { return s + Number(b.received_qty == null ? b.quantity : b.received_qty); }, 0)),
    paidYear: round2(pays.filter(function (p) { return dayText(p.paid_on) >= yearAgo; }).reduce(function (s, p) { return s + Number(p.amount); }, 0)),
    lastDelivery: batches[0] ? dayText(batches[0].date_received) : null,
    score: g.score == null ? null : g.score, grade: g.grade || null
  };
}

// The harvests expected month by month, this month and the next five.
function forecastOf(d, day) {
  var first = day.slice(0, 8) + '01';
  var until = addMonths(first, MONTHS_AHEAD);
  var months = [];
  for (var i = 0; i < MONTHS_AHEAD; i++) months.push({ month: addMonths(first, i).slice(0, 7), qty: 0, plots: 0, late: 0 });
  var units = {};
  d.plots.forEach(function (p) {
    harvestsOf(p, first, until).forEach(function (h) {
      var m = months.find(function (x) { return x.month === h.day.slice(0, 7); });
      if (!m) return;
      m.qty += h.qty; m.plots++; if (h.late) m.late++;
      units[p.unit] = (units[p.unit] || 0) + 1;
    });
  });
  var unit = Object.keys(units).sort(function (a, b) { return units[b] - units[a]; })[0] || 'poles';
  return { unit: unit, months: months.map(function (m) { return { month: m.month, qty: round2(m.qty), plots: m.plots, late: m.late }; }) };
}

// GET /api/outgrowers
async function overview(ctx) {
  needRead(ctx);
  var day = today();
  var d = await load();
  var grades = await scorecards.grades(ctx, 365);
  var farmers = d.farmers.map(function (f) { return farmerOut(f, d, grades, day); });
  var names = {};
  d.farmers.forEach(function (f) { names[f.id] = f.name; });
  var toPay = d.batches.filter(function (b) { return !b.payment_id && Number(b.cost) > 0; }).map(function (b) {
    var f = farmers.find(function (x) { return x.id === b.supplier_id; });
    return Object.assign(batchOut(b), { farmer: { id: b.supplier_id, name: names[b.supplier_id], momoNumber: f ? f.momoNumber : '', advanceLeft: f ? f.advanceLeft : 0 } });
  }).sort(function (a, b) { return a.day.localeCompare(b.day); });
  var monthStart = day.slice(0, 8) + '01';
  var paidMonth = d.payments.filter(function (p) { return dayText(p.paid_on) >= monthStart; });
  var overdue = d.plots.filter(function (p) { return plotOut(p, day).overdue; }).map(function (p) { return Object.assign(plotOut(p, day), { farmer: names[p.supplier_id] }); });
  var candidates = canEdit(ctx) ? (await pool.query("SELECT id, name, town FROM suppliers WHERE NOT outgrower AND status = 'active' ORDER BY name LIMIT 300")).rows : [];
  var active = d.plots.filter(function (p) { return p.active; });
  return {
    farmers: farmers, toPay: toPay, overdue: overdue,
    payments: d.payments.slice(0, 15).map(function (p) { return Object.assign(paymentOut(p), { farmer: names[p.supplier_id] }); }),
    forecast: forecastOf(d, day), candidates: candidates, networks: NETWORKS, methods: METHODS, units: rawBatches.UNITS,
    canEdit: canEdit(ctx), canPay: canPay(ctx), canTakeIn: ctx.can('production.manage'),
    summary: {
      farmers: farmers.filter(function (f) { return f.active; }).length,
      plots: active.length, hectares: round2(active.reduce(function (s, p) { return s + Number(p.hectares || 0); }, 0)),
      soonQty: round2(farmers.reduce(function (s, f) { return s + f.soonQty; }, 0)),
      advanceLeft: round2(farmers.reduce(function (s, f) { return s + Math.max(0, f.advanceLeft); }, 0)),
      owed: round2(toPay.reduce(function (s, b) { return s + b.value; }, 0)), toPay: toPay.length,
      paidMonth: round2(paidMonth.reduce(function (s, p) { return s + Number(p.amount); }, 0)),
      momoShare: paidMonth.length ? Math.round(paidMonth.filter(function (p) { return p.method === 'mobile_money'; }).length / paidMonth.length * 100) : null,
      overdue: overdue.length
    }
  };
}

// GET /api/outgrowers/:id — one farmer: plots, deliveries, advances, payments.
async function get(ctx, id) {
  needRead(ctx);
  var day = today();
  var d = await load();
  var f = d.farmers.find(function (x) { return x.id === uuidOr(id); });
  if (!f) fail('notfound', 'That farmer is not an outgrower, or is gone.');
  var grades = await scorecards.grades(ctx, 365);
  var out = farmerOut(f, d, grades, day);
  out.plotList = d.plots.filter(function (p) { return p.supplier_id === f.id; }).map(function (p) { return plotOut(p, day); });
  out.deliveries = d.batches.filter(function (b) { return b.supplier_id === f.id; }).map(batchOut);
  out.advances = d.advances.filter(function (a) { return a.supplier_id === f.id; }).map(advanceOut);
  out.payments = d.payments.filter(function (p) { return p.supplier_id === f.id; }).map(paymentOut);
  out.forecast = forecastOf({ plots: d.plots.filter(function (p) { return p.supplier_id === f.id; }) }, day);
  out.canEdit = canEdit(ctx); out.canPay = canPay(ctx); out.canTakeIn = ctx.can('production.manage');
  return out;
}

function farmerFields(p) {
  var network = text(p.momoNetwork, 20);
  if (network && NETWORKS.indexOf(network) < 0) fail('invalid', 'Pick the Mobile Money network from the list.');
  var momo = text(p.momoNumber, 20);
  if (momo && !/^\+?[0-9 ]{9,16}$/.test(momo)) fail('invalid', 'The Mobile Money number is not a phone number.');
  return {
    phone: text(p.phone, 30), town: text(p.town, 80), district: text(p.district, 80), region: text(p.region, 60),
    momoNumber: momo, momoNetwork: network, joinedOn: optDay(p.joinedOn, 'The day they joined is not a date.'), notes: text(p.notes, 2000)
  };
}

// POST /api/outgrowers { supplierId } marks a supplier as an outgrower;
// { name, phone, town, district, region, momoNumber, momoNetwork, joinedOn, notes } adds a new one.
// PATCH /api/outgrowers/:id changes one.
async function save(ctx, id, p) {
  needEdit(ctx);
  p = p || {};
  var f = farmerFields(p);
  var saved = await withTransaction(async function (db) {
    if (id) {
      var cur = (await db.query('SELECT * FROM suppliers WHERE id = $1 AND outgrower FOR UPDATE', [uuidOr(id)])).rows[0];
      if (!cur) fail('notfound', 'That farmer is not an outgrower, or is gone.');
      var name = p.name === undefined ? cur.name : text(p.name, 120);
      if (!name) fail('invalid', 'The farmer\'s name, please.');
      await db.query('UPDATE suppliers SET name = $2, phone = $3, town = $4, district = $5, region = $6, momo_number = $7, momo_network = $8, joined_on = $9, notes = $10, status = $11 WHERE id = $1',
        [cur.id, name, f.phone, f.town, f.district, f.region, f.momoNumber, f.momoNetwork, f.joinedOn, f.notes, p.active === false ? 'inactive' : 'active']);
      await audit(db, ctx, 'outgrower.update', 'supplier', cur.id, 'Changed outgrower ' + name + '.');
      return cur.id;
    }
    if (p.supplierId) {
      var s = (await db.query('SELECT * FROM suppliers WHERE id = $1 FOR UPDATE', [uuidOr(p.supplierId)])).rows[0];
      if (!s) fail('notfound', 'That supplier is gone.');
      if (s.outgrower) fail('conflict', s.name + ' is an outgrower already.');
      await db.query('UPDATE suppliers SET outgrower = true, joined_on = coalesce(joined_on, $2), momo_number = CASE WHEN momo_number = \'\' THEN $3 ELSE momo_number END, momo_network = CASE WHEN momo_network = \'\' THEN $4 ELSE momo_network END WHERE id = $1',
        [s.id, f.joinedOn || today(), f.momoNumber, f.momoNetwork]);
      await audit(db, ctx, 'outgrower.add', 'supplier', s.id, s.name + ' is now an outgrower.');
      return s.id;
    }
    var newName = text(p.name, 120);
    if (!newName) fail('invalid', 'The farmer\'s name, please.');
    var row = (await db.query(
      "INSERT INTO suppliers (name, contact_person, phone, materials_supplied, status, town, district, region, momo_number, momo_network, joined_on, notes, outgrower, sourcing_status) " +
      "VALUES ($1,$1,$2,'Bamboo','active',$3,$4,$5,$6,$7,$8,$9,true,'Outgrower') RETURNING id",
      [newName, f.phone, f.town, f.district, f.region, f.momoNumber, f.momoNetwork, f.joinedOn || today(), f.notes])).rows[0];
    await audit(db, ctx, 'outgrower.add', 'supplier', row.id, 'Added outgrower ' + newName + '.');
    return row.id;
  });
  return get(ctx, saved);
}

function plotFields(p) {
  var name = text(p.name, 80);
  if (!name) fail('invalid', 'Give the plot a name, e.g. the river plot.');
  var lat = coord(p.lat, 90, 'The latitude must be between -90 and 90.');
  var lng = coord(p.lng, 180, 'The longitude must be between -180 and 180.');
  var cycle = p.cycleMonths === '' || p.cycleMonths == null ? 12 : Math.round(Number(p.cycleMonths));
  if (!(cycle >= 1 && cycle <= 60)) fail('invalid', 'It is cut every 1 to 60 months.');
  var year = p.plantedYear === '' || p.plantedYear == null ? null : Math.round(Number(p.plantedYear));
  if (year != null && !(year >= 1950 && year <= Number(today().slice(0, 4)))) fail('invalid', 'The year it was planted is not right.');
  var clumps = optNum(p.clumps, 'The clumps must be a number.', 1e6);
  return {
    name: name, place: text(p.place, 120), lat: lat, lng: lng,
    hectares: optNum(p.hectares, 'The hectares must be a number, 0 or more.', 1e5), species: text(p.species, 60), clumps: clumps == null ? null : Math.round(clumps),
    plantedYear: year, cycleMonths: cycle, nextHarvest: optDay(p.nextHarvest, 'The next harvest is not a date.'),
    expectedQty: optNum(p.expectedQty, 'What it should give must be a number, 0 or more.'), unit: rawBatches.UNITS.indexOf(p.unit) >= 0 ? p.unit : 'poles', note: text(p.note, 500)
  };
}

// POST /api/outgrowers/:id/plots, PATCH /api/outgrowers/plots/:plotId
async function savePlot(ctx, farmerId, plotId, p) {
  needEdit(ctx);
  p = p || {};
  var f = plotFields(p);
  var owner = await withTransaction(async function (db) {
    if (plotId) {
      var cur = (await db.query('SELECT * FROM outgrower_plots WHERE id = $1 FOR UPDATE', [uuidOr(plotId)])).rows[0];
      if (!cur) fail('notfound', 'That plot is gone.');
      await db.query('UPDATE outgrower_plots SET name = $2, place = $3, lat = $4, lng = $5, hectares = $6, species = $7, clumps = $8, planted_year = $9, cycle_months = $10, next_harvest = $11, expected_qty = $12, unit = $13, note = $14, active = $15 WHERE id = $1',
        [cur.id, f.name, f.place, f.lat, f.lng, f.hectares, f.species, f.clumps, f.plantedYear, f.cycleMonths, f.nextHarvest, f.expectedQty, f.unit, f.note, p.active !== false]);
      await audit(db, ctx, 'outgrower.plot', 'supplier', cur.supplier_id, 'Changed plot ' + f.name + '.');
      return cur.supplier_id;
    }
    var s = (await db.query('SELECT id, name FROM suppliers WHERE id = $1 AND outgrower', [uuidOr(farmerId)])).rows[0];
    if (!s) fail('notfound', 'That farmer is not an outgrower, or is gone.');
    await db.query('INSERT INTO outgrower_plots (supplier_id, name, place, lat, lng, hectares, species, clumps, planted_year, cycle_months, next_harvest, expected_qty, unit, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [s.id, f.name, f.place, f.lat, f.lng, f.hectares, f.species, f.clumps, f.plantedYear, f.cycleMonths, f.nextHarvest, f.expectedQty, f.unit, f.note]);
    await audit(db, ctx, 'outgrower.plot', 'supplier', s.id, 'Added plot ' + f.name + ' for ' + s.name + '.');
    return s.id;
  });
  return get(ctx, owner);
}

// POST /api/outgrowers/plots/:plotId/harvested { on } — cut: the next one is a cycle on.
async function harvested(ctx, plotId, p) {
  needEdit(ctx);
  var on = optDay((p || {}).on, 'The day it was cut is not a date.') || today();
  if (on > today()) fail('invalid', 'The day it was cut cannot be in the future.');
  var cur = (await pool.query('SELECT * FROM outgrower_plots WHERE id = $1', [uuidOr(plotId)])).rows[0];
  if (!cur) fail('notfound', 'That plot is gone.');
  var next = addMonths(on, cur.cycle_months);
  await pool.query('UPDATE outgrower_plots SET next_harvest = $2 WHERE id = $1', [cur.id, next]);
  await audit(pool, ctx, 'outgrower.harvest', 'supplier', cur.supplier_id, 'Plot ' + cur.name + ' cut on ' + on + '; next ' + next + '.');
  return get(ctx, cur.supplier_id);
}

// POST /api/outgrowers/:id/advances { amount, givenOn, method, reference, note }
async function advance(ctx, farmerId, p) {
  needPay(ctx);
  p = p || {};
  var s = (await pool.query('SELECT id, name FROM suppliers WHERE id = $1 AND outgrower', [uuidOr(farmerId)])).rows[0];
  if (!s) fail('notfound', 'That farmer is not an outgrower, or is gone.');
  var amount = amountOf(p.amount, 'How much was advanced? A number over 0.', { positive: true });
  var method = METHODS.indexOf(p.method) >= 0 ? p.method : 'mobile_money';
  var on = optDay(p.givenOn, 'The day it was given is not a date.') || today();
  await pool.query('INSERT INTO outgrower_advances (supplier_id, amount, given_on, method, reference, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [s.id, amount, on, method, text(p.reference, 60), text(p.note, 300), me(ctx)]);
  await audit(pool, ctx, 'outgrower.advance', 'supplier', s.id, 'Advanced ' + money(amount) + ' to ' + s.name + '.');
  return get(ctx, s.id);
}

// POST /api/outgrowers/deliveries { farmerId, species, qty, unit, grade, value, dateReceived, notes }
// — a delivery taken in: a raw batch from the farmer, into the raw materials store.
async function takeIn(ctx, p) {
  if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).');
  p = p || {};
  var s = (await pool.query('SELECT id, name FROM suppliers WHERE id = $1 AND outgrower', [uuidOr(p.farmerId)])).rows[0];
  if (!s) fail('notfound', 'That farmer is not an outgrower, or is gone.');
  var wh = (await pool.query("SELECT id FROM warehouses WHERE code = 'WH-RAW' LIMIT 1")).rows[0] || (await pool.query('SELECT id FROM warehouses ORDER BY code LIMIT 1')).rows[0];
  if (!wh) fail('invalid', 'There is no store to take it into: add a warehouse first.');
  var b = await rawBatches.create(ctx, {
    species: text(p.species, 60) || 'Bamboo', supplierId: s.id, quantity: p.qty, unit: p.unit || 'poles', qualityGrade: p.grade || 'B',
    cost: amountOf(p.value == null || p.value === '' ? 0 : p.value, 'What it is worth must be a number, 0 or more.'), warehouseId: wh.id, dateReceived: p.dateReceived, notes: text(p.notes, 500)
  });
  if (uuidOr(p.plotId)) {
    var plot = (await pool.query('SELECT * FROM outgrower_plots WHERE id = $1 AND supplier_id = $2', [p.plotId, s.id])).rows[0];
    if (plot) await pool.query('UPDATE outgrower_plots SET next_harvest = $2 WHERE id = $1', [plot.id, addMonths(dayText(b.dateReceived) || today(), plot.cycle_months)]);
  }
  var out = await get(ctx, s.id);
  out.batch = { id: b.id, batchNo: b.batchNo };
  return out;
}

// POST /api/outgrowers/pay { batchId, advanceTaken, method, momoNumber, reference, paidOn, note, text }
async function pay(ctx, p) {
  needPay(ctx);
  p = p || {};
  var done = await withTransaction(async function (db) {
    var b = (await db.query('SELECT rb.*, s.name AS farmer, s.outgrower, s.momo_number, s.phone FROM raw_batches rb JOIN suppliers s ON s.id = rb.supplier_id WHERE rb.id = $1 FOR UPDATE OF rb', [uuidOr(p.batchId)])).rows[0];
    if (!b || !b.outgrower) fail('notfound', 'That delivery is not from an outgrower.');
    if ((await db.query('SELECT 1 FROM outgrower_payments WHERE raw_batch_id = $1', [b.id])).rows[0]) fail('conflict', b.batch_no + ' is paid already.');
    var amount = round2(b.cost);
    if (!(amount > 0)) fail('invalid', b.batch_no + ' has no value yet: put what it is worth on the batch first.');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('outgrower:' || $1))", [b.supplier_id]);
    var left = Number((await db.query(
      'SELECT coalesce((SELECT sum(amount) FROM outgrower_advances WHERE supplier_id = $1), 0) - coalesce((SELECT sum(advance_taken) FROM outgrower_payments WHERE supplier_id = $1), 0) AS left', [b.supplier_id])).rows[0].left);
    var taken = p.advanceTaken === '' || p.advanceTaken == null ? Math.min(Math.max(0, left), amount) : amountOf(p.advanceTaken, 'What comes off the advance must be a number, 0 or more.');
    taken = round2(taken);
    if (taken > Math.max(0, round2(left)) + 0.001) fail('invalid', 'Only ' + money(Math.max(0, left)) + ' of advances is still to come back.');
    if (taken > amount) fail('invalid', 'More cannot come off the advance than the delivery is worth.');
    var method = METHODS.indexOf(p.method) >= 0 ? p.method : 'mobile_money';
    var paid = round2(amount - taken);
    var momo = method === 'mobile_money' ? text(p.momoNumber || b.momo_number, 20) : '';
    if (method === 'mobile_money' && paid > 0 && !momo) fail('invalid', 'Which Mobile Money number was it sent to?');
    var reference = text(p.reference, 60);
    if (method !== 'cash' && paid > 0 && !reference) fail('invalid', 'The transaction reference, please: it is on the Mobile Money or bank message.');
    var on = optDay(p.paidOn, 'The day it was paid is not a date.') || today();
    var row = (await db.query(
      'INSERT INTO outgrower_payments (supplier_id, raw_batch_id, amount, advance_taken, paid, method, momo_number, reference, paid_on, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
      [b.supplier_id, b.id, amount, taken, paid, method, momo, reference, on, text(p.note, 300), me(ctx)])).rows[0];
    await audit(db, ctx, 'outgrower.pay', 'supplier', b.supplier_id, 'Paid ' + b.farmer + ' ' + money(paid) + ' for ' + b.batch_no + (taken > 0 ? ' (' + money(taken) + ' off the advance)' : '') + '.');
    return { id: row.id, supplierId: b.supplier_id, batchNo: b.batch_no, qty: Number(b.received_qty), unit: b.unit, amount: amount, taken: taken, paid: paid, left: round2(left - taken), method: method, reference: reference, phone: momo || b.phone };
  });
  var texted = false;
  if (p.text) {
    var sms = require('./sms.service');
    if (sms.configured() && done.phone) {
      var words = 'Bamboo Products: ' + money(done.paid) + ' paid for your delivery ' + done.batchNo + ' (' + done.qty + ' ' + done.unit + ')' +
        (done.method === 'mobile_money' ? ' by Mobile Money' : done.method === 'bank' ? ' to your bank' : ' in cash') + (done.reference ? ', ref ' + done.reference : '') + '.' +
        (done.taken > 0 ? ' ' + money(done.taken) + ' came off your advance' + (done.left > 0 ? '; ' + money(done.left) + ' still to come back.' : '.') : '') + ' Thank you.';
      try { await sms.send({ to: done.phone, message: words, purpose: 'outgrower_payment', refId: done.id, sentBy: me(ctx) }); texted = true; } catch (e) { /* paid all the same */ }
      if (texted) await pool.query('UPDATE outgrower_payments SET texted = true WHERE id = $1', [done.id]);
    }
  }
  var out = await get(ctx, done.supplierId);
  out.texted = texted;
  return out;
}

// For the monthly report.
async function monthFigures(from, to) {
  var r = (await pool.query(
    'SELECT count(*)::int AS payments, coalesce(sum(amount), 0) AS amount, coalesce(sum(paid), 0) AS paid FROM outgrower_payments WHERE paid_on >= $1 AND paid_on <= $2', [from, to])).rows[0];
  var a = (await pool.query('SELECT coalesce(sum(amount), 0) AS amount FROM outgrower_advances WHERE given_on >= $1 AND given_on <= $2', [from, to])).rows[0];
  var farmers = (await pool.query("SELECT count(*)::int AS n FROM suppliers WHERE outgrower AND status = 'active'")).rows[0].n;
  return { farmers: farmers, payments: r.payments, value: round2(r.amount), paid: round2(r.paid), advanced: round2(a.amount) };
}

module.exports = { overview: overview, get: get, save: save, savePlot: savePlot, harvested: harvested, advance: advance, takeIn: takeIn, pay: pay, monthFigures: monthFigures, harvestsOf: harvestsOf, addMonths: addMonths };
