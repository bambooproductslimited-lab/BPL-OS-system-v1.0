var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// The kiln and treatment log (migration 0201): the kilns, the treatment
// tanks (the borate soak against borers) and the air-drying sheds, each
// taking one charge at a time — culms from a raw batch, or boards — read for
// moisture until they reach the target (a kiln, a shed) or until the soak
// has had its days (a tank). Finished with how many came out good and how
// many split. How busy each one is, how long a charge takes, how much is
// lost. Those running production are told when a charge is dry or soaked,
// late, or not read for two days (the daily alerts).

var KINDS = ['kiln', 'tank', 'shed'];
var DAY = 86400000;

function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function round1(n) { return Math.round(Number(n) * 10) / 10; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function num(v) { return v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v); }
function canRead(ctx) { return ctx.can('production.read') || ctx.can('production.manage'); }
function needRead(ctx) { if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (production.read).'); }
function need(ctx) { if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).'); }
function refOf(n) { return 'K-' + String(n).padStart(4, '0'); }
function inRange(v, lo, hi, what) { var n = num(v); if (n === null) return null; if (n < lo || n > hi) fail('invalid', what + ' between ' + lo + ' and ' + hi + '.'); return round1(n); }

function kilnOut(k) {
  return { id: k.id, name: k.name, kind: k.kind, capacity: Number(k.capacity), unit: k.unit, targetMoisture: num(k.target_moisture), days: num(k.days), active: k.active, seq: k.seq };
}

var CSEL = 'SELECT c.*, k.name AS kiln_name, k.kind AS kiln_kind, k.target_moisture AS kiln_target, k.capacity AS kiln_capacity, ' +
  'b.batch_no, b.species, p.name AS product_name, s.first_name AS s_first, s.last_name AS s_last, x.first_name AS x_first, x.last_name AS x_last ' +
  'FROM kiln_charges c JOIN kilns k ON k.id = c.kiln_id LEFT JOIN raw_batches b ON b.id = c.raw_batch_id LEFT JOIN products p ON p.id = c.product_id ' +
  'LEFT JOIN employees s ON s.id = c.started_by LEFT JOIN employees x ON x.id = c.ended_by ';

// A charge, with where it stands now.
function chargeOut(c, readings) {
  var end = c.ended_at ? new Date(c.ended_at).getTime() : Date.now();
  var days = round1((end - new Date(c.started_at).getTime()) / DAY);
  var target = num(c.target_moisture) != null ? num(c.target_moisture) : num(c.kiln_target);
  var rs = (readings || []).map(function (r) { return { id: r.id, at: r.at, moisture: num(r.moisture), temperature: num(r.temperature), humidity: num(r.humidity), note: r.note, by: nameOf(r.first_name, r.last_name) }; });
  var wet = rs.filter(function (r) { return r.moisture != null; });
  var latest = wet.length ? wet[wet.length - 1].moisture : num(c.start_moisture);
  var planned = num(c.planned_days);
  var running = c.status === 'running';
  var ready = running && (c.kiln_kind === 'tank' ? planned != null && days >= planned : latest != null && target != null && latest <= target);
  var lastAt = rs.length ? new Date(rs[rs.length - 1].at).getTime() : new Date(c.started_at).getTime();
  return {
    id: c.id, ref: refOf(c.number), number: c.number, kiln: { id: c.kiln_id, name: c.kiln_name, kind: c.kiln_kind },
    rawBatch: c.raw_batch_id ? { id: c.raw_batch_id, batchNo: c.batch_no, species: c.species } : null,
    product: c.product_id ? { id: c.product_id, name: c.product_name } : null,
    description: c.description, qty: Number(c.qty), unit: c.unit, solution: c.solution,
    plannedDays: planned, targetMoisture: target, startMoisture: num(c.start_moisture), latestMoisture: latest,
    status: c.status, startedAt: c.started_at, startedBy: nameOf(c.s_first, c.s_last), endedAt: c.ended_at, endedBy: nameOf(c.x_first, c.x_last),
    endMoisture: num(c.end_moisture), outQty: num(c.out_qty), rejectQty: Number(c.reject_qty), note: c.note, endNote: c.end_note,
    days: days, ready: ready, late: running && !ready && planned != null && days > planned + 1,
    quiet: running && c.kiln_kind !== 'tank' && Date.now() - lastAt > 2 * DAY,
    progress: c.kiln_kind === 'tank' ? (planned ? Math.min(100, Math.round(days / planned * 100)) : null)
      : (num(c.start_moisture) != null && target != null && latest != null && num(c.start_moisture) > target ? Math.max(0, Math.min(100, Math.round((num(c.start_moisture) - latest) / (num(c.start_moisture) - target) * 100))) : null),
    readings: rs
  };
}

async function readingsOf(ids) {
  if (!ids.length) return {};
  var rows = (await pool.query('SELECT r.*, e.first_name, e.last_name FROM kiln_readings r LEFT JOIN employees e ON e.id = r.by_id WHERE r.charge_id = ANY($1) ORDER BY r.at', [ids])).rows;
  var by = {};
  rows.forEach(function (r) { (by[r.charge_id] = by[r.charge_id] || []).push(r); });
  return by;
}

// GET /api/kilns
async function overview(ctx) {
  needRead(ctx);
  var kilns = (await pool.query('SELECT * FROM kilns ORDER BY active DESC, seq, name')).rows;
  var charges = (await pool.query(CSEL + "WHERE c.status = 'running' OR c.started_at > now() - interval '75 days' OR c.ended_at > now() - interval '75 days' ORDER BY c.started_at DESC")).rows;
  var readings = await readingsOf(charges.map(function (c) { return c.id; }));
  var out = charges.map(function (c) { return chargeOut(c, readings[c.id]); });
  var now = Date.now(), from = now - 30 * DAY;
  var cards = kilns.map(function (k) {
    var mine = out.filter(function (c) { return c.kiln.id === k.id; });
    var busy = mine.reduce(function (a, c) {
      var s = Math.max(from, new Date(c.startedAt).getTime()), e = c.endedAt ? new Date(c.endedAt).getTime() : now;
      return a + Math.max(0, e - s);
    }, 0);
    return Object.assign(kilnOut(k), {
      running: mine.find(function (c) { return c.status === 'running'; }) || null,
      last: mine.find(function (c) { return c.status === 'done'; }) || null,
      use30: Math.min(100, Math.round(busy / (30 * DAY) * 100)),
      charges30: mine.filter(function (c) { return new Date(c.startedAt).getTime() > from; }).length
    });
  });
  var done90 = out.filter(function (c) { return c.status === 'done' && new Date(c.endedAt).getTime() > now - 90 * DAY; });
  var avgDays = function (kind) { var x = done90.filter(function (c) { return c.kiln.kind === kind; }); return x.length ? round1(x.reduce(function (a, c) { return a + c.days; }, 0) / x.length) : null; };
  var good = done90.reduce(function (a, c) { return a + (c.outQty || 0); }, 0), bad = done90.reduce(function (a, c) { return a + c.rejectQty; }, 0);
  var running = out.filter(function (c) { return c.status === 'running'; });
  var rawBatches = (await pool.query("SELECT id, batch_no, species, quantity, unit, date_received FROM raw_batches WHERE status = 'in_stock' ORDER BY date_received DESC LIMIT 80")).rows.map(function (b) {
    return { id: b.id, batchNo: b.batch_no, species: b.species, quantity: Number(b.quantity), unit: b.unit, receivedOn: b.date_received };
  });
  var products = (await pool.query('SELECT id, name, unit FROM products ORDER BY name LIMIT 400')).rows;
  return {
    kilns: cards, charges: out, rawBatches: rawBatches, products: products, kinds: KINDS, canManage: ctx.can('production.manage'),
    summary: {
      running: running.length, ready: running.filter(function (c) { return c.ready; }).length, late: running.filter(function (c) { return c.late || c.quiet; }).length,
      idle: cards.filter(function (k) { return k.active && !k.running; }).length,
      kilnDays: avgDays('kiln'), tankDays: avgDays('tank'), shedDays: avgDays('shed'),
      rejectRate: good + bad > 0 ? round1(bad / (good + bad) * 100) : null,
      dried30: round2(out.filter(function (c) { return c.status === 'done' && c.kiln.kind !== 'tank' && new Date(c.endedAt).getTime() > from; }).reduce(function (a, c) { return a + (c.outQty || 0); }, 0)),
      soaked30: round2(out.filter(function (c) { return c.status === 'done' && c.kiln.kind === 'tank' && new Date(c.endedAt).getTime() > from; }).reduce(function (a, c) { return a + (c.outQty || 0); }, 0))
    }
  };
}

async function chargeOf(id) {
  var c = (await pool.query(CSEL + 'WHERE c.id = $1', [uuidOr(id)])).rows[0];
  if (!c) fail('notfound', 'That charge is gone.');
  return c;
}

// GET /api/kilns/charges/:id
async function get(ctx, id) {
  needRead(ctx);
  var c = await chargeOf(id);
  var r = await readingsOf([c.id]);
  var out = chargeOut(c, r[c.id]);
  out.capacity = Number(c.kiln_capacity);
  out.canManage = ctx.can('production.manage');
  return out;
}

// POST /api/kilns, PUT /api/kilns/:id { name, kind, capacity, unit, targetMoisture, days, active, seq }
async function saveKiln(ctx, id, p) {
  need(ctx);
  p = p || {};
  var name = text(p.name, 80);
  if (name.length < 2) fail('invalid', 'What is it called? e.g. Kiln 1.');
  var kind = KINDS.indexOf(p.kind) >= 0 ? p.kind : 'kiln';
  var cap = Math.max(0, Number(p.capacity) || 0);
  var target = kind === 'tank' ? null : inRange(p.targetMoisture, 0, 60, 'The target moisture is');
  var days = inRange(p.days, 0, 120, 'A usual charge takes');
  var row;
  if (id) {
    var cur = (await pool.query('SELECT id FROM kilns WHERE id = $1', [uuidOr(id)])).rows[0];
    if (!cur) fail('notfound', 'That kiln is gone.');
    row = (await pool.query('UPDATE kilns SET name = $2, kind = $3, capacity = $4, unit = $5, target_moisture = $6, days = $7, active = $8, seq = $9 WHERE id = $1 RETURNING id',
      [cur.id, name, kind, cap, text(p.unit, 20) || 'pieces', target, days, p.active !== false, Math.round(Number(p.seq) || 0)])).rows[0];
  } else {
    row = (await pool.query('INSERT INTO kilns (name, kind, capacity, unit, target_moisture, days, seq) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [name, kind, cap, text(p.unit, 20) || 'pieces', target, days, Math.round(Number(p.seq) || 0)])).rows[0];
  }
  await audit(pool, ctx, 'kiln.save', 'kiln', row.id, '"' + name + '" saved.');
  return overview(ctx);
}

// POST /api/kilns/charges { kilnId, rawBatchId, productId, description, qty,
// unit, solution, plannedDays, targetMoisture, startMoisture, note }
async function start(ctx, p) {
  need(ctx);
  p = p || {};
  var k = (await pool.query('SELECT * FROM kilns WHERE id = $1', [uuidOr(p.kilnId)])).rows[0];
  if (!k || !k.active) fail('invalid', 'Which kiln or tank?');
  if ((await pool.query("SELECT 1 FROM kiln_charges WHERE kiln_id = $1 AND status = 'running'", [k.id])).rows[0]) fail('conflict', k.name + ' is in use: finish its charge first.');
  var batch = uuidOr(p.rawBatchId) ? (await pool.query('SELECT * FROM raw_batches WHERE id = $1', [p.rawBatchId])).rows[0] : null;
  if (p.rawBatchId && !batch) fail('invalid', 'That raw batch is gone.');
  var product = uuidOr(p.productId) ? (await pool.query('SELECT id, name, unit FROM products WHERE id = $1', [p.productId])).rows[0] : null;
  var qty = Number(p.qty);
  if (!(qty > 0)) fail('invalid', 'How many go in?');
  if (Number(k.capacity) > 0 && qty > Number(k.capacity)) fail('invalid', 'More than it holds: ' + Number(k.capacity) + ' ' + k.unit + '.');
  var description = text(p.description, 160) || (batch ? 'Batch ' + batch.batch_no + ' · ' + batch.species : product ? product.name : '');
  if (description.length < 2) fail('invalid', 'What goes in?');
  var planned = inRange(p.plannedDays, 0.5, 120, 'The days planned are') || num(k.days);
  if (k.kind === 'tank' && !planned) fail('invalid', 'How many days does it soak?');
  var target = k.kind === 'tank' ? null : (inRange(p.targetMoisture, 0, 60, 'The target moisture is') || num(k.target_moisture));
  var startMoisture = inRange(p.startMoisture, 0, 100, 'Moisture is');
  var row = await withTransaction(async function (db) {
    await db.query('LOCK TABLE kiln_charges IN SHARE ROW EXCLUSIVE MODE');
    var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM kiln_charges')).rows[0].n;
    return (await db.query(
      'INSERT INTO kiln_charges (number, kiln_id, raw_batch_id, product_id, description, qty, unit, solution, planned_days, target_moisture, start_moisture, note, started_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, number',
      [n, k.id, batch ? batch.id : null, product ? product.id : null, description, qty, text(p.unit, 20) || (batch ? batch.unit : product ? product.unit : k.unit), text(p.solution, 160), planned, target, startMoisture, text(p.note, 1000), me(ctx)])).rows[0];
  });
  if (startMoisture != null) await pool.query('INSERT INTO kiln_readings (charge_id, moisture, note, by_id) VALUES ($1,$2,$3,$4)', [row.id, startMoisture, 'In', me(ctx)]);
  await audit(pool, ctx, 'kiln.start', 'kiln_charge', row.id, refOf(row.number) + ': ' + description + ' into ' + k.name + '.');
  return get(ctx, row.id);
}

async function tellReady(c, latest) {
  var holders = await require('./staffAlerts.service').holdersOf(['production.manage']);
  var ids = holders.map(function (h) { return h.employee_id; });
  if (c.started_by && ids.indexOf(c.started_by) < 0) ids.push(c.started_by);
  for (var i = 0; i < ids.length; i++) await notify(pool, ids[i], '✅ ' + c.kiln_name + ' is dry — ' + refOf(c.number), c.description + ': ' + latest + '% moisture, the target ' + Number(c.target_moisture != null ? c.target_moisture : c.kiln_target) + '%.', '/kilns?charge=' + c.id);
  return ids.length;
}

// POST /api/kilns/charges/:id/readings { moisture, temperature, humidity, note, at }
async function read(ctx, id, p) {
  need(ctx);
  p = p || {};
  var c = await chargeOf(id);
  if (c.status !== 'running') fail('conflict', 'That charge is finished.');
  var moisture = inRange(p.moisture, 0, 100, 'Moisture is');
  var temp = inRange(p.temperature, -10, 150, 'The temperature is');
  var hum = inRange(p.humidity, 0, 100, 'Humidity is');
  if (moisture == null && temp == null && hum == null) fail('invalid', 'What did it read?');
  var at = p.at ? new Date(p.at) : new Date();
  if (isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60000) fail('invalid', 'When was it read? Now or before.');
  if (at < new Date(c.started_at)) fail('invalid', 'That is before the charge went in.');
  var before = chargeOut(c, (await readingsOf([c.id]))[c.id]);
  await pool.query('INSERT INTO kiln_readings (charge_id, at, moisture, temperature, humidity, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [c.id, at, moisture, temp, hum, text(p.note, 300), me(ctx)]);
  var after = chargeOut(c, (await readingsOf([c.id]))[c.id]);
  if (after.ready && !before.ready && c.kiln_kind !== 'tank') await tellReady(c, after.latestMoisture);
  return get(ctx, c.id);
}

// POST /api/kilns/charges/:id/finish { endMoisture, outQty, rejectQty, note }
async function finish(ctx, id, p) {
  need(ctx);
  p = p || {};
  var c = await chargeOf(id);
  if (c.status !== 'running') fail('conflict', 'That charge is finished.');
  var outQty = Number(p.outQty), reject = Math.max(0, Number(p.rejectQty) || 0);
  if (!(outQty >= 0) || p.outQty === '' || p.outQty == null) fail('invalid', 'How many came out good?');
  if (outQty + reject > Number(c.qty)) fail('invalid', 'More than went in (' + Number(c.qty) + ').');
  var endMoisture = inRange(p.endMoisture, 0, 100, 'Moisture is');
  await pool.query("UPDATE kiln_charges SET status = 'done', ended_at = now(), ended_by = $2, end_moisture = $3, out_qty = $4, reject_qty = $5, end_note = $6 WHERE id = $1",
    [c.id, me(ctx), endMoisture, outQty, reject, text(p.note, 1000)]);
  if (endMoisture != null) await pool.query('INSERT INTO kiln_readings (charge_id, moisture, note, by_id) VALUES ($1,$2,$3,$4)', [c.id, endMoisture, 'Out', me(ctx)]);
  await audit(pool, ctx, 'kiln.finish', 'kiln_charge', c.id, refOf(c.number) + ' out of ' + c.kiln_name + ': ' + outQty + ' good, ' + reject + ' rejected.');
  return get(ctx, c.id);
}

// POST /api/kilns/charges/:id/abort { note }
async function abort(ctx, id, p) {
  need(ctx);
  var c = await chargeOf(id);
  if (c.status !== 'running') fail('conflict', 'That charge is finished.');
  var note = text(p && p.note, 1000);
  if (note.length < 3) fail('invalid', 'Why is it stopped?');
  await pool.query("UPDATE kiln_charges SET status = 'aborted', ended_at = now(), ended_by = $2, end_note = $3 WHERE id = $1", [c.id, me(ctx), note]);
  await audit(pool, ctx, 'kiln.abort', 'kiln_charge', c.id, refOf(c.number) + ' stopped: ' + note);
  return get(ctx, c.id);
}

// For the daily alerts: the charges running, as they stand.
async function runningCharges() {
  var rows = (await pool.query(CSEL + "WHERE c.status = 'running'")).rows;
  var r = await readingsOf(rows.map(function (c) { return c.id; }));
  return rows.map(function (c) { return Object.assign(chargeOut(c, r[c.id]), { startedById: c.started_by }); });
}

module.exports = { overview: overview, get: get, saveKiln: saveKiln, start: start, read: read, finish: finish, abort: abort, runningCharges: runningCharges, refOf: refOf, KINDS: KINDS };
