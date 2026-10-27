var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Quality inspections (Operations → Quality; migration 0200). A checklist for
// a product or a stage — points to check, or to measure between a min and a
// max, some of them critical; an inspector goes through it for a production
// batch (or any lot by its reference) on the floor, counts the defects by
// type with photos, and the lot passes, passes with notes, goes on hold or
// fails. A lot on hold is released, reworked, scrapped or sent back. The
// share passing first time, week by week; the defects that come up most;
// batches made lately that nobody has inspected. Holds and fails reach
// production at once; holds left more than two days are chased
// (jobs/dailyAlerts.js).

var STAGES = ['incoming', 'in_process', 'final', 'packing'];
var DEFECTS = ['crack', 'split', 'mould', 'insect', 'colour', 'finish', 'joint', 'glue', 'dimension', 'moisture', 'warp', 'damage', 'other'];
var DEFECT_WORDS = { crack: 'Crack', split: 'Split', mould: 'Mould', insect: 'Insect damage', colour: 'Colour', finish: 'Finish', joint: 'Joint', glue: 'Glue', dimension: 'Size', moisture: 'Moisture', warp: 'Warp', damage: 'Damage', other: 'Other' };
var VERDICTS = ['pass', 'pass_notes', 'hold', 'fail'];
var DISPOSITIONS = ['release', 'rework', 'scrap', 'return'];
var MAX_DEFECTS = 20;

function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function num(v) { return v === null || v === undefined || v === '' ? null : Number(v); }
function round2(n) { return Math.round(n * 100) / 100; }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function canRead(ctx) { return ctx.can('quality.manage') || ctx.can('production.read'); }
function needRead(ctx) { if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (production.read).'); }
function need(ctx) { if (!ctx.can('quality.manage')) fail('forbidden', 'Your role does not allow this action (quality.manage).'); }
function refOf(n) { return 'QC-' + String(n).padStart(4, '0'); }
function mondayOf(d) { var x = new Date(d); x.setUTCHours(0, 0, 0, 0); var wd = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - wd); return x.toISOString().slice(0, 10); }

// A checklist's points, cleaned: { label, kind: check|measure, min, max, unit, critical }.
function cleanPoints(points) {
  return (Array.isArray(points) ? points : []).slice(0, 40).map(function (pt) {
    var kind = pt && pt.kind === 'measure' ? 'measure' : 'check';
    var min = num(pt && pt.min), max = num(pt && pt.max);
    return { label: text(pt && pt.label, 120), kind: kind, min: kind === 'measure' && isFinite(min) ? min : null, max: kind === 'measure' && isFinite(max) ? max : null, unit: kind === 'measure' ? text(pt && pt.unit, 12) : '', critical: !!(pt && pt.critical) };
  }).filter(function (pt) { return pt.label.length >= 2; });
}
function checklistOut(c) {
  return { id: c.id, name: c.name, stage: c.stage, productId: c.product_id, product: c.product_name || null, points: c.points || [], active: c.active, updatedAt: c.updated_at };
}

var SEL = 'SELECT i.*, c.name AS checklist, p.name AS product_name, p.sku, b.batch_no, b.production_line, b.date AS batch_date, b.output_qty, ' +
  'e.first_name, e.last_name, s.first_name AS s_first, s.last_name AS s_last, ' +
  '(SELECT coalesce(sum(qty), 0)::int FROM qc_defects d WHERE d.inspection_id = i.id) AS defects ' +
  'FROM qc_inspections i LEFT JOIN qc_checklists c ON c.id = i.checklist_id LEFT JOIN products p ON p.id = i.product_id LEFT JOIN production_batches b ON b.id = i.batch_id ' +
  'LEFT JOIN employees e ON e.id = i.inspector_id LEFT JOIN employees s ON s.id = i.settled_by ';
function inspectionOut(i) {
  var open = (i.verdict === 'hold' || i.verdict === 'fail') && !i.settled_at;
  return {
    id: i.id, number: i.number, ref: refOf(i.number), stage: i.stage, checklist: i.checklist || null, checklistId: i.checklist_id,
    batch: i.batch_id ? { id: i.batch_id, batchNo: i.batch_no, line: i.production_line || '', date: i.batch_date ? String(i.batch_date instanceof Date ? i.batch_date.toISOString() : i.batch_date).slice(0, 10) : null, outputQty: i.output_qty == null ? null : Number(i.output_qty) } : null,
    product: i.product_id ? { id: i.product_id, name: i.product_name, sku: i.sku } : null,
    lotRef: i.lot_ref, lotQty: Number(i.lot_qty), sampleSize: i.sample_size, verdict: i.verdict, firstPass: i.first_pass,
    disposition: i.disposition, reworkQty: Number(i.rework_qty), scrapQty: Number(i.scrap_qty), note: i.note,
    inspector: nameOf(i.first_name, i.last_name), inspectedAt: i.inspected_at, defects: i.defects,
    open: open, settledAt: i.settled_at, settledBy: nameOf(i.s_first, i.s_last), settleNote: i.settle_note,
    ageDays: open ? Math.floor((Date.now() - new Date(i.inspected_at).getTime()) / 86400000) : null
  };
}

// GET /api/quality?verdict=open|hold|fail|all
async function overview(ctx, q) {
  needRead(ctx);
  q = q || {};
  var filter = ['open', 'fail', 'all'].indexOf(q.verdict) >= 0 ? q.verdict : 'all';
  var where = filter === 'open' ? "WHERE i.verdict IN ('hold', 'fail') AND i.settled_at IS NULL" : filter === 'fail' ? "WHERE i.verdict IN ('hold', 'fail')" : '';
  var list = (await pool.query(SEL + where + ' ORDER BY i.inspected_at DESC LIMIT 150')).rows.map(inspectionOut);
  // Twelve weeks: how many passed, with notes, held, failed — first inspections only.
  var start = mondayOf(new Date(Date.now() - 11 * 7 * 86400000));
  var rows = (await pool.query("SELECT i.inspected_at, i.verdict, i.first_pass FROM qc_inspections i WHERE i.inspected_at >= $1", [start])).rows;
  var weeks = [];
  for (var w = 0; w < 12; w++) {
    var ws = new Date(Date.parse(start + 'T00:00:00Z') + w * 7 * 86400000).toISOString().slice(0, 10);
    var we = new Date(Date.parse(ws + 'T00:00:00Z') + 7 * 86400000);
    var inWeek = rows.filter(function (r) { var t = new Date(r.inspected_at); return r.first_pass && t >= new Date(ws + 'T00:00:00Z') && t < we; });
    var count = function (v) { return inWeek.filter(function (r) { return r.verdict === v; }).length; };
    var total = inWeek.length;
    weeks.push({ week: ws, pass: count('pass'), passNotes: count('pass_notes'), hold: count('hold'), fail: count('fail'), total: total, yield: total ? Math.round((count('pass') + count('pass_notes')) / total * 1000) / 10 : null });
  }
  var month = (await pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE verdict IN ('pass', 'pass_notes'))::int AS ok, count(*) FILTER (WHERE first_pass)::int AS firsts, " +
    "count(*) FILTER (WHERE first_pass AND verdict IN ('pass', 'pass_notes'))::int AS first_ok, coalesce(sum(scrap_qty), 0) AS scrap, coalesce(sum(rework_qty), 0) AS rework FROM qc_inspections WHERE inspected_at >= date_trunc('month', now())")).rows[0];
  var defectsMonth = (await pool.query("SELECT coalesce(sum(d.qty), 0)::int AS n FROM qc_defects d JOIN qc_inspections i ON i.id = d.inspection_id WHERE i.inspected_at >= date_trunc('month', now())")).rows[0].n;
  // The defects that come up most, ninety days.
  var top = (await pool.query("SELECT d.type, sum(d.qty)::int AS qty, count(DISTINCT d.inspection_id)::int AS lots, count(*) FILTER (WHERE d.severity <> 'minor')::int AS serious FROM qc_defects d JOIN qc_inspections i ON i.id = d.inspection_id WHERE i.inspected_at >= now() - interval '90 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 8")).rows;
  var topTotal = top.reduce(function (a, r) { return a + r.qty; }, 0);
  var running = 0;
  var topDefects = top.map(function (r) { running += r.qty; return { type: r.type, qty: r.qty, lots: r.lots, serious: r.serious, share: topTotal ? Math.round(r.qty / topTotal * 1000) / 10 : 0, cumulative: topTotal ? Math.round(running / topTotal * 1000) / 10 : 0 }; });
  // Batches made in the last fourteen days that nobody has inspected.
  var notInspected = (await pool.query("SELECT b.id, b.batch_no, b.date, b.production_line, b.output_qty, p.name AS product, p.id AS product_id FROM production_batches b LEFT JOIN products p ON p.id = b.output_product_id " +
    "WHERE b.status <> 'cancelled' AND b.date >= current_date - 14 AND NOT EXISTS (SELECT 1 FROM qc_inspections i WHERE i.batch_id = b.id) ORDER BY b.date DESC LIMIT 20")).rows.map(function (b) {
    return { id: b.id, batchNo: b.batch_no, date: String(b.date instanceof Date ? b.date.toISOString() : b.date).slice(0, 10), line: b.production_line || '', outputQty: Number(b.output_qty), product: b.product || '', productId: b.product_id };
  });
  var batches = (await pool.query("SELECT b.id, b.batch_no, b.date, b.production_line, b.output_qty, p.name AS product, p.id AS product_id FROM production_batches b LEFT JOIN products p ON p.id = b.output_product_id WHERE b.status <> 'cancelled' AND b.date >= current_date - 45 ORDER BY b.date DESC, b.batch_no DESC LIMIT 60")).rows.map(function (b) {
    return { id: b.id, batchNo: b.batch_no, date: String(b.date instanceof Date ? b.date.toISOString() : b.date).slice(0, 10), line: b.production_line || '', outputQty: Number(b.output_qty), product: b.product || '', productId: b.product_id };
  });
  var checklists = (await pool.query('SELECT c.*, p.name AS product_name FROM qc_checklists c LEFT JOIN products p ON p.id = c.product_id WHERE c.active ORDER BY c.stage, c.name')).rows.map(checklistOut);
  var products = (await pool.query("SELECT id, name, sku FROM products WHERE active ORDER BY name LIMIT 300")).rows.map(function (p) { return { id: p.id, name: p.name, sku: p.sku }; });
  var openList = list.filter(function (i) { return i.open; });
  return {
    filter: filter, inspections: list, weeks: weeks, topDefects: topDefects, notInspected: notInspected, batches: batches, checklists: checklists, products: products,
    stages: STAGES, defectTypes: DEFECTS, canManage: ctx.can('quality.manage'),
    summary: {
      month: month.n, firstPassYield: month.firsts ? Math.round(month.first_ok / month.firsts * 1000) / 10 : null, passed: month.ok,
      onHold: (await pool.query("SELECT count(*)::int AS n FROM qc_inspections WHERE verdict IN ('hold', 'fail') AND settled_at IS NULL")).rows[0].n,
      oldestHold: openList.length ? Math.max.apply(null, openList.map(function (i) { return i.ageDays; })) : null,
      defects: defectsMonth, scrap: round2(Number(month.scrap)), rework: round2(Number(month.rework)), notInspected: notInspected.length
    }
  };
}

async function inspectionOf(id) {
  var i = (await pool.query(SEL + 'WHERE i.id = $1', [uuidOr(id)])).rows[0];
  if (!i) fail('notfound', 'That inspection is gone.');
  return i;
}

// GET /api/quality/:id
async function get(ctx, id) {
  needRead(ctx);
  var i = await inspectionOf(id);
  var out = inspectionOut(i);
  out.results = i.results || [];
  out.defectList = (await pool.query('SELECT * FROM qc_defects WHERE inspection_id = $1 ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'major\' THEN 1 ELSE 2 END, qty DESC', [i.id])).rows.map(function (d) {
    return { id: d.id, type: d.type, qty: d.qty, severity: d.severity, note: d.note, photo: !!d.photo };
  });
  // The other inspections of the same batch: the first, the re-inspections.
  out.others = i.batch_id ? (await pool.query(SEL + 'WHERE i.batch_id = $1 AND i.id <> $2 ORDER BY i.inspected_at', [i.batch_id, i.id])).rows.map(inspectionOut) : [];
  out.canManage = ctx.can('quality.manage');
  return out;
}

// What the results say: a critical point not ok, or a critical defect, fails
// the lot; any point not ok or a major defect holds it; minor defects or a
// note let it pass with notes.
function verdictOf(results, defects, note) {
  if (results.some(function (r) { return r.ok === false && r.critical; }) || defects.some(function (d) { return d.severity === 'critical'; })) return 'fail';
  if (results.some(function (r) { return r.ok === false; }) || defects.some(function (d) { return d.severity === 'major'; })) return 'hold';
  if (defects.length || (note && note.length)) return 'pass_notes';
  return 'pass';
}

// POST /api/quality { checklistId, batchId | productId + lotRef, stage,
// lotQty, sampleSize, results: [{ label, ok, value, note }], defects: [{ type,
// qty, severity, note, photo }], note, verdict }
async function inspect(ctx, p) {
  need(ctx);
  p = p || {};
  var checklist = uuidOr(p.checklistId) ? (await pool.query('SELECT * FROM qc_checklists WHERE id = $1', [p.checklistId])).rows[0] : null;
  if (p.checklistId && !checklist) fail('invalid', 'That checklist is gone.');
  var batch = uuidOr(p.batchId) ? (await pool.query('SELECT * FROM production_batches WHERE id = $1', [p.batchId])).rows[0] : null;
  if (p.batchId && !batch) fail('invalid', 'That batch is gone.');
  if (batch && batch.status === 'cancelled') fail('invalid', 'That batch was cancelled.');
  var product = batch ? batch.output_product_id : uuidOr(p.productId) || (checklist && checklist.product_id) || null;
  var lotRef = text(p.lotRef, 60);
  if (!batch && !lotRef) fail('invalid', 'Which lot? Pick a batch, or give its reference.');
  // Each point of the checklist, as the inspector found it.
  var points = checklist ? checklist.points || [] : [];
  var given = Array.isArray(p.results) ? p.results : [];
  var results = points.map(function (pt, n) {
    var r = given[n] || {};
    if (pt.kind === 'measure') {
      var v = num(r.value);
      var ok = v == null || !isFinite(v) ? null : (pt.min == null || v >= pt.min) && (pt.max == null || v <= pt.max);
      return { label: pt.label, kind: 'measure', value: v != null && isFinite(v) ? v : null, unit: pt.unit, min: pt.min, max: pt.max, ok: ok, critical: !!pt.critical, note: text(r.note, 200) };
    }
    return { label: pt.label, kind: 'check', ok: r.ok === true ? true : r.ok === false ? false : null, critical: !!pt.critical, note: text(r.note, 200) };
  });
  if (results.some(function (r) { return r.ok === null; })) fail('invalid', 'Go through every point on the checklist.');
  var defects = (Array.isArray(p.defects) ? p.defects : []).slice(0, MAX_DEFECTS).map(function (d) {
    return { type: DEFECTS.indexOf(d && d.type) >= 0 ? d.type : 'other', qty: Math.max(1, Math.min(100000, Math.round(Number(d && d.qty) || 1))), severity: ['minor', 'major', 'critical'].indexOf(d && d.severity) >= 0 ? d.severity : 'minor', note: text(d && d.note, 300), photo: d && d.photo || null };
  });
  var note = text(p.note, 2000);
  var verdict = VERDICTS.indexOf(p.verdict) >= 0 ? p.verdict : verdictOf(results, defects, note);
  var lotQty = Math.max(0, Number(p.lotQty) || (batch ? Number(batch.output_qty) : 0));
  var sample = Math.max(0, Math.min(1000000, Math.round(Number(p.sampleSize) || 0)));
  var photos = [];
  for (var k = 0; k < defects.length; k++) photos.push(defects[k].photo ? await require('./restaurantCashOffice.service').photoFrom(defects[k].photo, 'defect') : null);
  var stage = STAGES.indexOf(p.stage) >= 0 ? p.stage : checklist ? checklist.stage : 'final';
  var row = await withTransaction(async function (db) {
    await db.query('LOCK TABLE qc_inspections IN SHARE ROW EXCLUSIVE MODE');
    var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM qc_inspections')).rows[0].n;
    var firstPass = !(batch && (await db.query('SELECT 1 FROM qc_inspections WHERE batch_id = $1 AND stage = $2', [batch.id, stage])).rows[0]);
    var r = (await db.query(
      'INSERT INTO qc_inspections (number, checklist_id, batch_id, product_id, stage, lot_ref, lot_qty, sample_size, results, verdict, note, inspector_id, first_pass, settled_at, settled_by, disposition) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
      [n, checklist ? checklist.id : null, batch ? batch.id : null, product, stage, lotRef || (batch ? batch.batch_no : ''), lotQty, sample, JSON.stringify(results), verdict, note, me(ctx), firstPass,
        verdict === 'hold' || verdict === 'fail' ? null : new Date(), verdict === 'hold' || verdict === 'fail' ? null : me(ctx), verdict === 'hold' || verdict === 'fail' ? null : 'release'])).rows[0];
    for (var j = 0; j < defects.length; j++) {
      await db.query('INSERT INTO qc_defects (inspection_id, type, qty, severity, note, photo) VALUES ($1,$2,$3,$4,$5,$6)',
        [r.id, defects[j].type, defects[j].qty, defects[j].severity, defects[j].note, photos[j] ? JSON.stringify({ key: photos[j].key, type: photos[j].type }) : null]);
    }
    return r;
  });
  if (verdict === 'hold' || verdict === 'fail') {
    var what = batch ? 'Batch ' + batch.batch_no : 'Lot ' + row.lot_ref;
    var told = {};
    var holders = await require('./staffAlerts.service').holdersOf(['production.manage', 'quality.manage']);
    if (batch && batch.supervisor_id) holders.push({ employee_id: batch.supervisor_id });
    for (var i = 0; i < holders.length; i++) {
      var to = holders[i].employee_id;
      if (!to || to === me(ctx) || told[to]) continue;
      told[to] = true;
      await notify(pool, to, (verdict === 'fail' ? '⛔ ' : '✋ ') + refOf(row.number) + ': ' + what + (verdict === 'fail' ? ' failed inspection' : ' is on hold'),
        defects.length ? defects.map(function (d) { return d.qty + ' ' + DEFECT_WORDS[d.type].toLowerCase(); }).join(', ') : 'A point on the checklist was not met.', '/quality?inspection=' + row.id);
    }
  }
  await audit(pool, ctx, 'quality.inspect', 'qc_inspection', row.id, refOf(row.number) + ' ' + verdict + (batch ? ' (batch ' + batch.batch_no + ')' : '') + '.');
  return get(ctx, row.id);
}

// POST /api/quality/:id/settle { disposition, reworkQty, scrapQty, note } —
// a lot on hold or failed: released, reworked, scrapped or sent back.
async function settle(ctx, id, p) {
  need(ctx);
  p = p || {};
  var i = await inspectionOf(id);
  if (i.verdict !== 'hold' && i.verdict !== 'fail') fail('conflict', 'It passed: nothing to decide.');
  if (i.settled_at) fail('conflict', 'It is decided already.');
  var disposition = DISPOSITIONS.indexOf(p.disposition) >= 0 ? p.disposition : fail('invalid', 'Release it, rework it, scrap it or send it back?');
  if (i.verdict === 'fail' && disposition === 'release') fail('invalid', 'A failed lot is not released as it is: rework it, scrap it or send it back.');
  var lot = Number(i.lot_qty) || 0;
  var rework = Math.max(0, Number(p.reworkQty) || 0), scrap = Math.max(0, Number(p.scrapQty) || 0);
  if (disposition === 'rework' && !rework) rework = lot;
  if (disposition === 'scrap' && !scrap) scrap = lot;
  if (lot && rework + scrap > lot) fail('invalid', 'More than the lot: it has ' + lot + '.');
  var note = text(p.note, 1000);
  if (note.length < 3) fail('invalid', 'Say what was decided and why.');
  await pool.query('UPDATE qc_inspections SET disposition = $2, rework_qty = $3, scrap_qty = $4, settled_at = now(), settled_by = $5, settle_note = $6 WHERE id = $1', [i.id, disposition, rework, scrap, me(ctx), note]);
  await audit(pool, ctx, 'quality.settle', 'qc_inspection', i.id, refOf(i.number) + ': ' + disposition + (rework ? ', rework ' + rework : '') + (scrap ? ', scrap ' + scrap : '') + '.');
  return get(ctx, i.id);
}

// GET /api/quality/:id/defects/:defectId/photo
async function photoOf(ctx, id, defectId) {
  needRead(ctx);
  var d = (await pool.query('SELECT photo FROM qc_defects WHERE id = $1 AND inspection_id = $2', [uuidOr(defectId), uuidOr(id)])).rows[0];
  if (!d || !d.photo) fail('notfound', 'No photo.');
  return d.photo;
}

// Checklists: GET /api/quality/checklists, POST, PUT /:id { name, stage,
// productId, points, active }
async function checklists(ctx) {
  needRead(ctx);
  return (await pool.query('SELECT c.*, p.name AS product_name FROM qc_checklists c LEFT JOIN products p ON p.id = c.product_id ORDER BY c.active DESC, c.stage, c.name')).rows.map(checklistOut);
}
async function saveChecklist(ctx, id, p) {
  need(ctx);
  p = p || {};
  var name = text(p.name, 100);
  if (name.length < 3) fail('invalid', 'Name the checklist.');
  var points = cleanPoints(p.points);
  if (!points.length) fail('invalid', 'Add at least one point to check.');
  var bad = points.find(function (pt) { return pt.kind === 'measure' && pt.min == null && pt.max == null; });
  if (bad) fail('invalid', '"' + bad.label + '": give a min, a max or both.');
  var stage = STAGES.indexOf(p.stage) >= 0 ? p.stage : 'final';
  var product = uuidOr(p.productId);
  var row;
  if (id) {
    var cur = (await pool.query('SELECT id FROM qc_checklists WHERE id = $1', [uuidOr(id)])).rows[0];
    if (!cur) fail('notfound', 'That checklist is gone.');
    row = (await pool.query('UPDATE qc_checklists SET name = $2, stage = $3, product_id = $4, points = $5, active = $6, updated_at = now() WHERE id = $1 RETURNING *', [cur.id, name, stage, product, JSON.stringify(points), p.active !== false])).rows[0];
  } else {
    row = (await pool.query('INSERT INTO qc_checklists (name, stage, product_id, points, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, stage, product, JSON.stringify(points), me(ctx)])).rows[0];
  }
  await audit(pool, ctx, 'quality.checklist', 'qc_checklist', row.id, 'Checklist "' + name + '" saved (' + points.length + ' points).');
  return checklists(ctx);
}

// For the daily round: lots on hold or failed, not decided after two days.
async function staleHolds() {
  return (await pool.query("SELECT i.id, i.number, i.inspected_at, i.lot_ref, i.verdict, b.batch_no FROM qc_inspections i LEFT JOIN production_batches b ON b.id = i.batch_id WHERE i.verdict IN ('hold', 'fail') AND i.settled_at IS NULL AND i.inspected_at < now() - interval '2 days'")).rows;
}

module.exports = { overview: overview, get: get, inspect: inspect, settle: settle, photoOf: photoOf, checklists: checklists, saveChecklist: saveChecklist, staleHolds: staleHolds, verdictOf: verdictOf, refOf: refOf, DEFECTS: DEFECTS };
