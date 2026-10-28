var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// The generator and power log (migration 0203), for the factory and each
// restaurant (a company each): its generators and prepaid meters; the power
// cuts, from when the grid went off to when it came back; the hours each
// generator ran (from the clock, or its hour meter); the fuel bought for it;
// the prepaid top-ups. From these: the hours without power, what a
// generator hour costs, and the litres an hour each generator burns — a
// quarter over what it should is flagged (a leak, a fault, or fuel going
// somewhere else), and whoever keeps the log is told once a week.

var WINDOW = 30;
var OVER = 1.25;
var MIN_HOURS = 10;
var STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
var DAY = /^\d{4}-\d{2}-\d{2}$/;
var FUELS = ['diesel', 'petrol', 'gas'];

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function round1(n) { return Math.round(Number(n || 0) * 10) / 10; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function nameOf(first, last) { return first ? (first + ' ' + (last || '')).trim() : null; }
function money(n) { return 'GHS ' + round2(n).toFixed(2); }
function canManage(ctx) { return ctx.can('power.manage'); }
function canRead(ctx) { return canManage(ctx) || ctx.can('report.read') || ctx.can('restaurant.manage'); }
function needRead(ctx) { if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (power.manage).'); }
function need(ctx) { if (!canManage(ctx)) fail('forbidden', 'Your role does not allow this action (power.manage).'); }
// Ghana keeps GMT all year: a time typed without a zone is GMT.
function stampOf(v, label, fallbackNow) {
  if (v == null || v === '') { if (fallbackNow) return new Date(); fail('invalid', label); }
  var s = String(v);
  var d = new Date(STAMP.test(s) ? s + 'Z' : s);
  if (isNaN(d.getTime())) fail('invalid', label);
  if (d.getTime() > Date.now() + 5 * 60000) fail('invalid', 'That time is in the future.');
  return d;
}
function numOf(v, label, opts) {
  if ((v === '' || v == null) && opts && opts.optional) return null;
  var n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || n < 0 || n > ((opts && opts.max) || 1e8) || (opts && opts.positive && !(n > 0))) fail('invalid', label);
  return n;
}
function hoursBetween(a, b) { return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 3600000); }
// The hours of [a, b) that fall between from and to.
function overlap(a, b, from, to) { return hoursBetween(Math.max(new Date(a).getTime(), from), Math.min(new Date(b).getTime(), to)); }

async function companies() {
  return (await pool.query("SELECT id, code, name FROM companies WHERE coalesce(status, 'active') = 'active' ORDER BY (code = 'BPL') DESC, name")).rows;
}

function runHours(r, now) { return r.hours != null ? Number(r.hours) : hoursBetween(r.started_at, r.ended_at || now); }

// One generator's last 30 days: hours, litres, the rate it burns, the cost of an hour.
function generatorStats(s, runs, fuel, from, now) {
  var hours = runs.filter(function (r) { return new Date(r.started_at).getTime() >= from; }).reduce(function (a, r) { return a + runHours(r, now); }, 0);
  var bought = fuel.filter(function (f) { return dayText(f.on_day) >= dayText(new Date(from)); });
  var litres = bought.reduce(function (a, f) { return a + Number(f.litres); }, 0);
  var cost = bought.reduce(function (a, f) { return a + Number(f.cost); }, 0);
  var lph = hours > 0 && litres > 0 ? litres / hours : null;
  var expected = s.expected_lph == null ? null : Number(s.expected_lph);
  var warn = null;
  if (hours >= MIN_HOURS && lph != null && expected && lph > expected * OVER) warn = 'high';
  else if (hours === 0 && litres >= 40) warn = 'no_hours';
  return {
    hours: round1(hours), litres: round1(litres), fuelCost: round2(cost), lph: lph == null ? null : round2(lph), expectedLph: expected,
    costPerHour: hours > 0 && cost > 0 ? round2(cost / hours) : null, overPct: lph != null && expected ? Math.round((lph / expected - 1) * 100) : null, warn: warn,
    pricePerLitre: litres > 0 && cost > 0 ? round2(cost / litres) : null
  };
}
function meterStats(topups, from) {
  var recent = topups.filter(function (t) { return dayText(t.on_day) >= dayText(new Date(from)); });
  var amount = recent.reduce(function (a, t) { return a + Number(t.amount); }, 0);
  var units = recent.reduce(function (a, t) { return a + Number(t.units || 0); }, 0);
  var last = topups[0] || null;
  return {
    spent: round2(amount), units: round1(units), perUnit: units > 0 ? round2(amount / units) : null, topups: recent.length,
    lastDay: last ? dayText(last.on_day) : null, lastAmount: last ? round2(last.amount) : null
  };
}

function sourceOut(s) {
  return {
    id: s.id, companyId: s.company_id, kind: s.kind, name: s.name, kva: s.kva == null ? null : Number(s.kva), fuel: s.fuel,
    tankLitres: s.tank_litres == null ? null : Number(s.tank_litres), expectedLph: s.expected_lph == null ? null : Number(s.expected_lph),
    meterNo: s.meter_no, hourMeter: s.hour_meter == null ? null : Number(s.hour_meter), active: s.active
  };
}

// Everything since a day, for every company.
async function load(since) {
  var sources = (await pool.query('SELECT * FROM power_sources ORDER BY active DESC, kind, name')).rows;
  var ids = sources.map(function (s) { return s.id; });
  var q = function (sql) { return ids.length ? pool.query(sql, [ids, since]).then(function (r) { return r.rows; }) : Promise.resolve([]); };
  var runs = await q('SELECT r.*, e.first_name, e.last_name FROM power_runs r LEFT JOIN employees e ON e.id = r.by_id WHERE r.source_id = ANY($1) AND (r.started_at >= $2::date OR r.ended_at IS NULL) ORDER BY r.started_at DESC');
  var fuel = await q('SELECT f.*, e.first_name, e.last_name FROM power_fuel f LEFT JOIN employees e ON e.id = f.by_id WHERE f.source_id = ANY($1) AND f.on_day >= $2::date ORDER BY f.on_day DESC, f.created_at DESC');
  var topups = await q('SELECT t.*, e.first_name, e.last_name FROM power_topups t LEFT JOIN employees e ON e.id = t.by_id WHERE t.source_id = ANY($1) AND t.on_day >= $2::date ORDER BY t.on_day DESC, t.created_at DESC');
  var outages = (await pool.query('SELECT o.*, e.first_name, e.last_name FROM power_outages o LEFT JOIN employees e ON e.id = o.by_id WHERE o.started_at >= $1::date OR o.ended_at IS NULL OR o.ended_at >= $1::date ORDER BY o.started_at DESC', [since])).rows;
  return { sources: sources, runs: runs, fuel: fuel, topups: topups, outages: outages };
}

// GET /api/power?company=<code>
async function overview(ctx, q) {
  needRead(ctx);
  q = q || {};
  var now = new Date(), day = today();
  var since = addDays(day, -(WINDOW - 1)), from = Date.parse(since + 'T00:00:00Z');
  var cos = await companies();
  var d = await load(addDays(day, -90));
  var bySource = function (list, id) { return list.filter(function (x) { return x.source_id === id; }); };
  var sites = cos.map(function (c) {
    var srcs = d.sources.filter(function (s) { return s.company_id === c.id; });
    var outs = d.outages.filter(function (o) { return o.company_id === c.id; });
    var open = outs.find(function (o) { return !o.ended_at; }) || null;
    var recent = outs.filter(function (o) { return !o.ended_at || new Date(o.ended_at).getTime() >= from; });
    var offHours = recent.reduce(function (a, o) { return a + overlap(o.started_at, o.ended_at || now, from, now.getTime()); }, 0);
    var longest = recent.reduce(function (a, o) { return Math.max(a, hoursBetween(o.started_at, o.ended_at || now)); }, 0);
    // Hours without power, day by day.
    var days = [];
    for (var i = WINDOW - 1; i >= 0; i--) {
      var dd = addDays(day, -i), a = Date.parse(dd + 'T00:00:00Z'), b = a + 86400000;
      days.push({ day: dd, off: round1(recent.reduce(function (s, o) { return s + overlap(o.started_at, o.ended_at || now, a, Math.min(b, now.getTime())); }, 0)) });
    }
    var gens = srcs.filter(function (s) { return s.kind === 'generator'; }).map(function (s) {
      var runs = bySource(d.runs, s.id);
      var running = runs.find(function (r) { return !r.ended_at; });
      return Object.assign(sourceOut(s), generatorStats(s, runs, bySource(d.fuel, s.id), from, now), { running: running ? { id: running.id, since: running.started_at } : null });
    });
    var meters = srcs.filter(function (s) { return s.kind === 'meter'; }).map(function (s) { return Object.assign(sourceOut(s), meterStats(bySource(d.topups, s.id), from)); });
    var fuelCost = gens.reduce(function (a, g) { return a + g.fuelCost; }, 0);
    var genHours = gens.reduce(function (a, g) { return a + g.hours; }, 0);
    return {
      id: c.id, code: c.code, name: c.name, generators: gens, meters: meters,
      off: open ? { id: open.id, since: open.started_at, note: open.note } : null,
      outages: recent.length, offHours: round1(offHours), longest: round1(longest), days: days,
      fuelCost: round2(fuelCost), prepaid: round2(meters.reduce(function (a, m) { return a + m.spent; }, 0)), genHours: round1(genHours),
      costPerHour: genHours > 0 && fuelCost > 0 ? round2(fuelCost / genHours) : null
    };
  });
  // Sites with nothing recorded and no sources are left out, unless asked for.
  var shown = sites.filter(function (s) { return s.generators.length || s.meters.length || s.outages || s.code === 'BPL'; });
  var log = [];
  var src = {};
  d.sources.forEach(function (s) { src[s.id] = s; });
  var co = {};
  cos.forEach(function (c) { co[c.id] = c; });
  d.outages.slice(0, 30).forEach(function (o) { log.push({ kind: 'outage', id: o.id, at: o.started_at, end: o.ended_at, company: co[o.company_id] ? co[o.company_id].code : '', note: o.note, hours: o.ended_at ? round1(hoursBetween(o.started_at, o.ended_at)) : null, by: nameOf(o.first_name, o.last_name) }); });
  d.runs.slice(0, 30).forEach(function (r) { var s = src[r.source_id]; log.push({ kind: 'run', id: r.id, at: r.started_at, end: r.ended_at, source: s.name, company: co[s.company_id] ? co[s.company_id].code : '', note: r.note, hours: r.ended_at || r.hours != null ? round1(runHours(r, now)) : null, by: nameOf(r.first_name, r.last_name) }); });
  d.fuel.slice(0, 30).forEach(function (f) { var s = src[f.source_id]; log.push({ kind: 'fuel', id: f.id, at: dayText(f.on_day) + 'T12:00:00.000Z', day: dayText(f.on_day), source: s.name, company: co[s.company_id] ? co[s.company_id].code : '', litres: Number(f.litres), cost: round2(f.cost), vendor: f.vendor, note: f.note, by: nameOf(f.first_name, f.last_name) }); });
  d.topups.slice(0, 30).forEach(function (t) { var s = src[t.source_id]; log.push({ kind: 'topup', id: t.id, at: dayText(t.on_day) + 'T12:00:00.000Z', day: dayText(t.on_day), source: s.name, company: co[s.company_id] ? co[s.company_id].code : '', amount: round2(t.amount), units: t.units == null ? null : Number(t.units), reference: t.reference, note: t.note, by: nameOf(t.first_name, t.last_name) }); });
  log.sort(function (a, b) { return new Date(b.at).getTime() - new Date(a.at).getTime(); });
  if (q.company) log = log.filter(function (l) { return l.company === q.company; });
  var warnings = [];
  shown.forEach(function (s) { s.generators.forEach(function (g) { if (g.warn) warnings.push({ site: s.name, code: s.code, id: g.id, name: g.name, warn: g.warn, lph: g.lph, expectedLph: g.expectedLph, overPct: g.overPct, litres: g.litres, hours: g.hours }); }); });
  var allGenHours = shown.reduce(function (a, s) { return a + s.genHours; }, 0);
  var allFuel = shown.reduce(function (a, s) { return a + s.fuelCost; }, 0);
  return {
    sites: shown, log: log.slice(0, 60), warnings: warnings, window: WINDOW, over: OVER, fuels: FUELS,
    companies: cos.map(function (c) { return { id: c.id, code: c.code, name: c.name }; }), canManage: canManage(ctx),
    summary: {
      offNow: shown.filter(function (s) { return s.off; }).length,
      offHours: round1(shown.reduce(function (a, s) { return a + s.offHours; }, 0)),
      outages: shown.reduce(function (a, s) { return a + s.outages; }, 0),
      fuelCost: round2(allFuel), genHours: round1(allGenHours), costPerHour: allGenHours > 0 && allFuel > 0 ? round2(allFuel / allGenHours) : null,
      prepaid: round2(shown.reduce(function (a, s) { return a + s.prepaid; }, 0)), warnings: warnings.length
    }
  };
}

async function sourceRow(db, id, kind) {
  var s = (await db.query('SELECT * FROM power_sources WHERE id = $1', [uuidOr(id)])).rows[0];
  if (!s) fail('notfound', 'That generator or meter is gone.');
  if (kind && s.kind !== kind) fail('invalid', kind === 'generator' ? 'That is a meter, not a generator.' : 'That is a generator, not a meter.');
  return s;
}

// POST /api/power/sources, PATCH /api/power/sources/:id
async function saveSource(ctx, id, p) {
  need(ctx);
  p = p || {};
  var name = text(p.name, 80);
  if (!name) fail('invalid', 'Give it a name, e.g. Generator 1 (60 kVA).');
  var f = {
    kva: numOf(p.kva, 'The kVA must be a number.', { optional: true, max: 100000 }),
    fuel: FUELS.indexOf(p.fuel) >= 0 ? p.fuel : 'diesel',
    tank: numOf(p.tankLitres, 'The tank must be a number of litres.', { optional: true, max: 100000 }),
    lph: numOf(p.expectedLph, 'The litres an hour must be a number over 0.', { optional: true, max: 1000 }),
    meterNo: text(p.meterNo, 40),
    hourMeter: numOf(p.hourMeter, 'The hour meter must be a number.', { optional: true, max: 1e7 })
  };
  if (f.lph === 0) fail('invalid', 'The litres an hour must be a number over 0.');
  var saved;
  if (id) {
    var cur = await sourceRow(pool, id);
    await pool.query('UPDATE power_sources SET name = $2, kva = $3, fuel = $4, tank_litres = $5, expected_lph = $6, meter_no = $7, hour_meter = $8, active = $9 WHERE id = $1',
      [cur.id, name, f.kva, f.fuel, f.tank, f.lph, f.meterNo, f.hourMeter, p.active !== false]);
    saved = cur.id;
  } else {
    var kind = p.kind === 'meter' ? 'meter' : 'generator';
    var company = (await pool.query('SELECT id FROM companies WHERE id = $1', [uuidOr(p.companyId)])).rows[0];
    if (!company) fail('invalid', 'Which site is it at?');
    saved = (await pool.query('INSERT INTO power_sources (company_id, kind, name, kva, fuel, tank_litres, expected_lph, meter_no, hour_meter) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [company.id, kind, name, f.kva, f.fuel, f.tank, f.lph, f.meterNo, f.hourMeter])).rows[0].id;
  }
  await audit(pool, ctx, 'power.source', 'power_source', saved, (id ? 'Changed ' : 'Added ') + name + '.');
  return overview(ctx);
}

// POST /api/power/outages { companyId, at, note, generatorId } — the power went off.
async function outageStart(ctx, p) {
  need(ctx);
  p = p || {};
  var at = stampOf(p.at, 'When did it go off?', true);
  await withTransaction(async function (db) {
    var c = (await db.query('SELECT id, name FROM companies WHERE id = $1', [uuidOr(p.companyId)])).rows[0];
    if (!c) fail('invalid', 'Which site is it at?');
    if ((await db.query('SELECT 1 FROM power_outages WHERE company_id = $1 AND ended_at IS NULL', [c.id])).rows[0]) fail('conflict', 'The power is already off at ' + c.name + '.');
    var o = (await db.query('INSERT INTO power_outages (company_id, started_at, note, by_id) VALUES ($1,$2,$3,$4) RETURNING id', [c.id, at, text(p.note, 200), me(ctx)])).rows[0];
    if (p.generatorId) {
      var g = await sourceRow(db, p.generatorId, 'generator');
      if (g.company_id !== c.id) fail('invalid', 'That generator is at another site.');
      if (!(await db.query('SELECT 1 FROM power_runs WHERE source_id = $1 AND ended_at IS NULL', [g.id])).rows[0]) {
        await db.query('INSERT INTO power_runs (source_id, started_at, by_id) VALUES ($1,$2,$3)', [g.id, at, me(ctx)]);
      }
    }
    await audit(db, ctx, 'power.off', 'power_outage', o.id, 'Power off at ' + c.name + '.');
  });
  return overview(ctx);
}

// POST /api/power/outages/:id/end { at } — it came back; the generators there go off.
async function outageEnd(ctx, id, p) {
  need(ctx);
  p = p || {};
  var at = stampOf(p.at, 'When did it come back?', true);
  await withTransaction(async function (db) {
    var o = (await db.query('SELECT * FROM power_outages WHERE id = $1 FOR UPDATE', [uuidOr(id)])).rows[0];
    if (!o) fail('notfound', 'That power cut is gone.');
    if (o.ended_at) fail('conflict', 'The power is back already.');
    if (at < new Date(o.started_at)) fail('invalid', 'It cannot come back before it went off.');
    await db.query('UPDATE power_outages SET ended_at = $2 WHERE id = $1', [o.id, at]);
    var open = (await db.query("SELECT r.* FROM power_runs r JOIN power_sources s ON s.id = r.source_id WHERE s.company_id = $1 AND r.ended_at IS NULL AND r.started_at <= $2", [o.company_id, at])).rows;
    for (var i = 0; i < open.length; i++) await db.query('UPDATE power_runs SET ended_at = $2 WHERE id = $1', [open[i].id, at]);
    await audit(db, ctx, 'power.on', 'power_outage', o.id, 'Power back after ' + round1(hoursBetween(o.started_at, at)) + ' hours.');
  });
  return overview(ctx);
}

// POST /api/power/runs { sourceId, startedAt, endedAt, meterEnd, note } — a
// run started now, or one already over (with its end, or its hour meter).
async function runStart(ctx, p) {
  need(ctx);
  p = p || {};
  await withTransaction(async function (db) {
    var g = await sourceRow(db, p.sourceId, 'generator');
    var start = stampOf(p.startedAt, 'When did it start?', true);
    var end = p.endedAt ? stampOf(p.endedAt, 'When did it stop?') : null;
    if (end && end < start) fail('invalid', 'It cannot stop before it started.');
    if (!end && (await db.query('SELECT 1 FROM power_runs WHERE source_id = $1 AND ended_at IS NULL', [g.id])).rows[0]) fail('conflict', g.name + ' is running already.');
    var meterEnd = numOf(p.meterEnd, 'The hour meter must be a number.', { optional: true, max: 1e7 });
    var hours = null;
    if (end && meterEnd != null && g.hour_meter != null && meterEnd >= Number(g.hour_meter)) hours = round2(meterEnd - Number(g.hour_meter));
    var r = (await db.query('INSERT INTO power_runs (source_id, started_at, ended_at, hours, meter_end, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [g.id, start, end, hours, meterEnd, text(p.note, 200), me(ctx)])).rows[0];
    if (meterEnd != null) await db.query('UPDATE power_sources SET hour_meter = $2 WHERE id = $1', [g.id, meterEnd]);
    await audit(db, ctx, 'power.run', 'power_run', r.id, g.name + (end ? ' ran ' + round1(hours != null ? hours : hoursBetween(start, end)) + ' hours.' : ' started.'));
  });
  return overview(ctx);
}

// POST /api/power/runs/:id/end { at, meterEnd }
async function runEnd(ctx, id, p) {
  need(ctx);
  p = p || {};
  var at = stampOf(p.at, 'When did it stop?', true);
  await withTransaction(async function (db) {
    var r = (await db.query('SELECT * FROM power_runs WHERE id = $1 FOR UPDATE', [uuidOr(id)])).rows[0];
    if (!r) fail('notfound', 'That run is gone.');
    if (r.ended_at) fail('conflict', 'It has stopped already.');
    if (at < new Date(r.started_at)) fail('invalid', 'It cannot stop before it started.');
    var g = await sourceRow(db, r.source_id, 'generator');
    var meterEnd = numOf(p.meterEnd, 'The hour meter must be a number.', { optional: true, max: 1e7 });
    if (meterEnd != null && g.hour_meter != null && meterEnd < Number(g.hour_meter)) fail('invalid', 'The hour meter read ' + Number(g.hour_meter) + ' last time: it cannot go back.');
    var hours = meterEnd != null && g.hour_meter != null ? round2(meterEnd - Number(g.hour_meter)) : null;
    await db.query('UPDATE power_runs SET ended_at = $2, hours = $3, meter_end = $4 WHERE id = $1', [r.id, at, hours, meterEnd]);
    if (meterEnd != null) await db.query('UPDATE power_sources SET hour_meter = $2 WHERE id = $1', [g.id, meterEnd]);
    await audit(db, ctx, 'power.run', 'power_run', r.id, g.name + ' stopped after ' + round1(hours != null ? hours : hoursBetween(r.started_at, at)) + ' hours.');
  });
  return overview(ctx);
}

function dayOf(v) {
  if (!v) return today();
  if (!DAY.test(String(v))) fail('invalid', 'That day is not a date.');
  if (String(v) > today()) fail('invalid', 'That day is in the future.');
  return String(v);
}

// POST /api/power/fuel { sourceId, day, litres, cost, vendor, note }
async function addFuel(ctx, p) {
  need(ctx);
  p = p || {};
  var g = await sourceRow(pool, p.sourceId, 'generator');
  var litres = numOf(p.litres, 'How many litres? A number over 0.', { positive: true, max: 100000 });
  var cost = numOf(p.cost == null || p.cost === '' ? 0 : p.cost, 'What it cost must be a number, 0 or more.', { max: 1e8 });
  var r = (await pool.query('INSERT INTO power_fuel (source_id, on_day, litres, cost, vendor, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [g.id, dayOf(p.day), round1(litres), round2(cost), text(p.vendor, 80), text(p.note, 200), me(ctx)])).rows[0];
  await audit(pool, ctx, 'power.fuel', 'power_fuel', r.id, round1(litres) + ' litres for ' + g.name + ', ' + money(cost) + '.');
  return overview(ctx);
}

// POST /api/power/topups { sourceId, day, amount, units, reference, note }
async function addTopup(ctx, p) {
  need(ctx);
  p = p || {};
  var m = await sourceRow(pool, p.sourceId, 'meter');
  var amount = numOf(p.amount, 'How much was bought? A number over 0.', { positive: true, max: 1e8 });
  var units = numOf(p.units, 'The units must be a number.', { optional: true, max: 1e7 });
  var r = (await pool.query('INSERT INTO power_topups (source_id, on_day, amount, units, reference, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [m.id, dayOf(p.day), round2(amount), units == null ? null : round1(units), text(p.reference, 60), text(p.note, 200), me(ctx)])).rows[0];
  await audit(pool, ctx, 'power.topup', 'power_topup', r.id, money(amount) + ' on ' + m.name + '.');
  return overview(ctx);
}

var TABLES = { outage: 'power_outages', run: 'power_runs', fuel: 'power_fuel', topup: 'power_topups' };
// DELETE /api/power/:kind/:id — an entry made by mistake.
async function remove(ctx, kind, id) {
  need(ctx);
  var table = TABLES[kind];
  if (!table) fail('notfound', 'Nothing like that to take off.');
  var r = (await pool.query('DELETE FROM ' + table + ' WHERE id = $1 RETURNING id', [uuidOr(id)])).rows[0];
  if (!r) fail('notfound', 'That entry is gone already.');
  await audit(pool, ctx, 'power.remove', table, r.id, 'Took off a ' + kind + ' entered by mistake.');
  return overview(ctx);
}

// For the weekly alert: generators burning a quarter more than they should.
async function fuelWarnings() {
  var day = today(), since = addDays(day, -(WINDOW - 1)), from = Date.parse(since + 'T00:00:00Z'), now = new Date();
  var d = await load(since);
  var co = {};
  (await companies()).forEach(function (c) { co[c.id] = c; });
  return d.sources.filter(function (s) { return s.kind === 'generator' && s.active; }).map(function (s) {
    var st = generatorStats(s, d.runs.filter(function (r) { return r.source_id === s.id; }), d.fuel.filter(function (f) { return f.source_id === s.id; }), from, now);
    return Object.assign({ id: s.id, name: s.name, site: co[s.company_id] ? co[s.company_id].name : '' }, st);
  }).filter(function (s) { return s.warn; });
}

// For the monthly report: each site's month.
async function monthFigures(from, to) {
  var a = Date.parse(from + 'T00:00:00Z'), b = Math.min(Date.parse(to + 'T00:00:00Z') + 86400000, Date.now()), now = new Date();
  var outages = (await pool.query('SELECT o.*, c.name FROM power_outages o JOIN companies c ON c.id = o.company_id WHERE o.started_at < $2::date + 1 AND (o.ended_at IS NULL OR o.ended_at >= $1::date)', [from, to])).rows;
  var runs = (await pool.query('SELECT r.*, s.company_id FROM power_runs r JOIN power_sources s ON s.id = r.source_id WHERE r.started_at >= $1::date AND r.started_at < $2::date + 1', [from, to])).rows;
  var fuel = (await pool.query('SELECT coalesce(sum(f.litres), 0) AS litres, coalesce(sum(f.cost), 0) AS cost FROM power_fuel f WHERE f.on_day >= $1 AND f.on_day <= $2', [from, to])).rows[0];
  var topups = (await pool.query('SELECT coalesce(sum(t.amount), 0) AS amount FROM power_topups t WHERE t.on_day >= $1 AND t.on_day <= $2', [from, to])).rows[0];
  var off = outages.reduce(function (s, o) { return s + overlap(o.started_at, o.ended_at || now, a, b); }, 0);
  var hours = runs.reduce(function (s, r) { return s + runHours(r, now); }, 0);
  return {
    outages: outages.length, offHours: round1(off), genHours: round1(hours), litres: round1(fuel.litres), fuelCost: round2(fuel.cost), prepaid: round2(topups.amount),
    costPerHour: hours > 0 && Number(fuel.cost) > 0 ? round2(Number(fuel.cost) / hours) : null
  };
}

module.exports = {
  overview: overview, saveSource: saveSource, outageStart: outageStart, outageEnd: outageEnd, runStart: runStart, runEnd: runEnd,
  addFuel: addFuel, addTopup: addTopup, remove: remove, fuelWarnings: fuelWarnings, monthFigures: monthFigures, generatorStats: generatorStats
};
