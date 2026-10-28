var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var bom = require('./bom.service');
var staffAlerts = require('./staffAlerts.service');

// Production jobs (migration 0203): N of a product made from its bill of
// materials (bom.service.js). Planned, the bill's parts for N (with their
// waste) and its cost are kept. Started, the parts are taken out of stock —
// what is there; the rest is taken when it comes — and more can be taken or
// some given back while it runs. Finished, the good ones go into stock, what
// was spoilt is recorded as scrap, and the job's real cost (the parts taken
// at their cost, the hours at the bill's rate, the overhead) is set against
// the bill's. Quality is told there is a lot to inspect (its reference is
// the job's). A kiln charge can be linked: the boards the job was made from.

var MAX_QTY = 100000;
var DAY = /^\d{4}-\d{2}-\d{2}$/;

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function round4(n) { return Math.round(Number(n || 0) * 10000) / 10000; }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function nameOf(first, last) { return first ? (first + ' ' + (last || '')).trim() : null; }
function ref(n) { return 'J-' + String(n).padStart(4, '0'); }
function canRead(ctx) { return ctx.can('production.read') || ctx.can('production.manage') || ctx.can('inventory.read'); }
function needRead(ctx) { if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (production.read).'); }
function need(ctx) { if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).'); }
function qtyOf(v, label, opts) {
  var n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_QTY || (opts && opts.positive && !(n > 0))) fail('invalid', label);
  return round2(n);
}

var SEL = 'SELECT j.*, p.name AS product_name, p.sku AS product_sku, p.unit AS product_unit, p.selling_price, p.current_stock AS product_stock, ' +
  'le.first_name AS lead_first, le.last_name AS lead_last, k.number AS kiln_no, kl.name AS kiln_name, k.status AS kiln_status, k.description AS kiln_what ' +
  'FROM production_jobs j JOIN products p ON p.id = j.product_id LEFT JOIN employees le ON le.id = j.lead_id ' +
  'LEFT JOIN kiln_charges k ON k.id = j.kiln_charge_id LEFT JOIN kilns kl ON kl.id = k.kiln_id ';

// The cost of the parts taken so far.
function partsCost(parts) { return round2(parts.reduce(function (a, x) { return a + Number(x.issued_qty) * Number(x.unit_cost); }, 0)); }

function stateOf(j, day) {
  if (j.status === 'done' || j.status === 'cancelled') return j.status;
  if (j.due_on && dayText(j.due_on) < day) return 'late';
  return j.status;
}

function jobOut(j, parts, day) {
  var qty = Number(j.qty);
  var plan = { material: round2(j.plan_material), labour: round2(j.plan_labour), overhead: round2(j.plan_overhead), hours: Number(j.plan_hours) };
  plan.total = round2(plan.material + plan.labour + plan.overhead);
  plan.each = qty > 0 ? round2(plan.total / qty) : 0;
  var out = {
    id: j.id, ref: ref(j.number), number: j.number, status: j.status, state: stateOf(j, day || today()),
    product: { id: j.product_id, name: j.product_name, sku: j.product_sku, unit: j.product_unit, price: Number(j.selling_price), stock: Number(j.product_stock) },
    qty: qty, dueOn: dayText(j.due_on), note: j.note,
    lead: j.lead_id ? { id: j.lead_id, name: nameOf(j.lead_first, j.lead_last) } : null,
    kiln: j.kiln_charge_id ? { id: j.kiln_charge_id, ref: j.kiln_no ? 'K-' + String(j.kiln_no).padStart(4, '0') : '', name: j.kiln_name, status: j.kiln_status, what: j.kiln_what } : null,
    plan: plan,
    good: j.good_qty == null ? null : Number(j.good_qty), scrap: Number(j.scrap_qty), scrapReason: j.scrap_reason,
    createdAt: j.created_at, startedAt: j.started_at, finishedAt: j.finished_at, cancelledAt: j.cancelled_at, cancelReason: j.cancel_reason
  };
  if (parts) {
    var material = partsCost(parts);
    var hours = j.labour_hours == null ? null : Number(j.labour_hours);
    var labour = round2((hours == null ? 0 : hours) * Number(j.labour_rate));
    var overhead = j.overhead == null ? null : round2(j.overhead);
    var total = round2(material + labour + (overhead || 0));
    out.actual = j.status === 'planned' || j.status === 'cancelled' ? null : {
      material: material, hours: hours, rate: Number(j.labour_rate), labour: labour, overhead: overhead, total: total,
      each: out.good > 0 ? round2(total / out.good) : null
    };
    // The bill for what was actually made, against what it really cost.
    if (j.status === 'done' && out.good > 0) {
      var planFor = round2(plan.each * out.good);
      out.actual.planFor = planFor;
      out.actual.variance = round2(total - planFor);
      out.actual.variancePct = planFor > 0 ? Math.round((total - planFor) / planFor * 1000) / 10 : null;
    }
    out.parts = parts.map(function (x) {
      return {
        id: x.id, componentId: x.component_id, name: x.name, sku: x.sku, unit: x.unit, stock: Number(x.current_stock),
        planned: round4(x.planned_qty), issued: round4(x.issued_qty), unitCost: round4(x.unit_cost),
        cost: round2(Number(x.issued_qty) * Number(x.unit_cost)), extra: Number(x.planned_qty) === 0
      };
    });
    // Short: what is still to take is more than the store holds.
    out.short = j.status === 'done' || j.status === 'cancelled' ? [] : out.parts.filter(function (x) { return x.planned - x.issued > 1e-9 && x.stock < x.planned - x.issued - 1e-9; }).map(function (x) {
      return { id: x.componentId, name: x.name, unit: x.unit, need: round4(x.planned - x.issued), have: x.stock };
    });
  }
  return out;
}

async function partsOf(db, jobId) {
  return (await db.query(
    'SELECT x.*, p.name, p.sku, p.unit, p.current_stock FROM production_job_parts x JOIN products p ON p.id = x.component_id WHERE x.job_id = $1 ORDER BY x.seq, p.name', [jobId])).rows;
}
async function jobRow(db, id, lock) {
  var j = (await db.query(SEL + 'WHERE j.id = $1', [uuidOr(id)])).rows[0];
  if (!j) fail('notfound', 'That job is gone.');
  if (lock) await db.query('SELECT 1 FROM production_jobs WHERE id = $1 FOR UPDATE', [j.id]);
  return j;
}

async function people() {
  return (await pool.query("SELECT id, first_name, last_name FROM employees WHERE status = 'active' ORDER BY first_name, last_name")).rows.map(function (p) { return { id: p.id, name: nameOf(p.first_name, p.last_name) }; });
}

// GET /api/jobs?show=open|done|all
async function overview(ctx, q) {
  needRead(ctx);
  q = q || {};
  var day = today();
  var show = ['open', 'done', 'all'].indexOf(q.show) >= 0 ? q.show : 'open';
  var where = show === 'open' ? "j.status IN ('planned', 'in_progress')" : show === 'done' ? "j.status IN ('done', 'cancelled') AND coalesce(j.finished_at, j.cancelled_at) >= now() - interval '120 days'" : "j.created_at >= now() - interval '180 days' OR j.status IN ('planned', 'in_progress')";
  var rows = (await pool.query(SEL + 'WHERE ' + where + " ORDER BY CASE j.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, j.due_on NULLS LAST, j.number DESC LIMIT 200")).rows;
  var ids = rows.map(function (j) { return j.id; });
  var partRows = ids.length ? (await pool.query('SELECT x.*, p.name, p.sku, p.unit, p.current_stock FROM production_job_parts x JOIN products p ON p.id = x.component_id WHERE x.job_id = ANY($1) ORDER BY x.seq', [ids])).rows : [];
  var byJob = {};
  partRows.forEach(function (x) { (byJob[x.job_id] = byJob[x.job_id] || []).push(x); });
  var jobs = rows.map(function (j) { return jobOut(j, byJob[j.id] || [], day); });

  // The last 90 days of finished jobs: scrap, and real cost against the bill.
  var done = (await pool.query(SEL + "WHERE j.status = 'done' AND j.finished_at >= now() - interval '90 days'")).rows;
  var doneParts = done.length ? (await pool.query('SELECT x.*, p.name, p.sku, p.unit, p.current_stock FROM production_job_parts x JOIN products p ON p.id = x.component_id WHERE x.job_id = ANY($1)', [done.map(function (j) { return j.id; })])).rows : [];
  var dp = {};
  doneParts.forEach(function (x) { (dp[x.job_id] = dp[x.job_id] || []).push(x); });
  var good = 0, scrap = 0, actual = 0, planned = 0, madeValue = 0, madeQty = 0;
  var monthStart = day.slice(0, 8) + '01';
  done.forEach(function (j) {
    var o = jobOut(j, dp[j.id] || [], day);
    good += o.good || 0; scrap += o.scrap;
    if (o.actual && o.actual.planFor > 0) { actual += o.actual.total; planned += o.actual.planFor; }
    if (dayText(j.finished_at) >= monthStart) { madeQty += o.good || 0; madeValue += (o.good || 0) * o.product.price; }
  });
  var open = jobs.filter(function (j) { return j.status === 'planned' || j.status === 'in_progress'; });

  // What a job can be planned for: the products with a bill of materials.
  var data = await bom.load();
  var memo = {};
  var products = Object.keys(data.lines).filter(function (id) { return (data.lines[id] || []).length && data.products[id]; }).map(function (id) {
    var p = data.products[id], r = bom.rollup(data, id, memo, []);
    var lines = data.lines[id];
    var can = null;
    lines.forEach(function (l) {
      var c = data.products[l.component_id];
      var n = Math.max(0, Math.floor(Number(c ? c.current_stock : 0) / (Number(l.qty) * (1 + Number(l.waste_pct) / 100)) + 1e-9));
      if (can === null || n < can) can = n;
    });
    return { id: id, name: p.name, sku: p.sku, unit: p.unit, cost: round2(r.total), price: Number(p.selling_price), stock: Number(p.current_stock), parts: lines.length, canMake: can };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  var charges = (await pool.query(
    "SELECT k.id, k.number, k.description, k.status, k.out_qty, k.unit, kl.name AS kiln FROM kiln_charges k JOIN kilns kl ON kl.id = k.kiln_id " +
    "WHERE k.status = 'running' OR (k.status = 'done' AND k.ended_at >= now() - interval '45 days') ORDER BY k.started_at DESC LIMIT 40")).rows.map(function (k) {
    return { id: k.id, ref: 'K-' + String(k.number).padStart(4, '0'), what: k.description, status: k.status, kiln: k.kiln, qty: k.out_qty == null ? null : Number(k.out_qty), unit: k.unit };
  });

  return {
    jobs: jobs, show: show, products: products, charges: charges, people: ctx.can('production.manage') ? await people() : [],
    canManage: ctx.can('production.manage'),
    summary: {
      inProgress: open.filter(function (j) { return j.status === 'in_progress'; }).length,
      planned: open.filter(function (j) { return j.status === 'planned'; }).length,
      late: open.filter(function (j) { return j.state === 'late'; }).length,
      dueWeek: open.filter(function (j) { return j.dueOn && j.dueOn >= day && j.dueOn <= addDays(day, 7); }).length,
      short: open.filter(function (j) { return j.short.length; }).length,
      madeQty: round2(madeQty), madeValue: round2(madeValue),
      scrapPct: good + scrap > 0 ? Math.round(scrap / (good + scrap) * 1000) / 10 : null,
      variancePct: planned > 0 ? Math.round((actual - planned) / planned * 1000) / 10 : null,
      finished: done.length
    }
  };
}

// GET /api/jobs/:id — the job, its parts, its costs, its inspections and
// the stock it moved.
async function get(ctx, id) {
  needRead(ctx);
  var j = await jobRow(pool, id);
  var out = jobOut(j, await partsOf(pool, j.id));
  out.inspections = (await pool.query("SELECT id, number, verdict, inspected_at, lot_qty, settled_at FROM qc_inspections WHERE lot_ref = $1 ORDER BY inspected_at", [out.ref])).rows.map(function (i) {
    return { id: i.id, ref: 'QC-' + String(i.number).padStart(4, '0'), verdict: i.verdict, at: i.inspected_at, qty: Number(i.lot_qty), settled: !!i.settled_at };
  });
  out.moves = (await pool.query(
    "SELECT t.type, t.qty, t.date, t.notes, p.name, p.unit, e.first_name, e.last_name FROM inventory_tx t JOIN products p ON p.id = t.item_id LEFT JOIN employees e ON e.id = t.user_id " +
    "WHERE t.item_type = 'product' AND t.reference = $1 ORDER BY t.date, t.id", [out.ref])).rows.map(function (t) {
    return { type: t.type, qty: Number(t.qty), day: dayText(t.date), name: t.name, unit: t.unit, note: t.notes, by: nameOf(t.first_name, t.last_name) };
  });
  out.canManage = ctx.can('production.manage');
  out.canInspect = ctx.can('quality.manage');
  return out;
}

async function checkLead(db, v) {
  var id = uuidOr(v);
  if (!v) return null;
  if (!id || !(await db.query("SELECT 1 FROM employees WHERE id = $1 AND status = 'active'", [id])).rows[0]) fail('invalid', 'Pick who runs the job from the list.');
  return id;
}
async function checkCharge(db, v) {
  var id = uuidOr(v);
  if (!v) return null;
  if (!id || !(await db.query('SELECT 1 FROM kiln_charges WHERE id = $1', [id])).rows[0]) fail('invalid', 'That kiln charge is gone.');
  return id;
}

// The bill for N: each direct part with its waste, at its cost now.
function planFor(data, productId, qty) {
  var memo = {};
  var r = bom.rollup(data, productId, memo, []);
  var c = data.costs[productId] || {};
  var parts = (data.lines[productId] || []).map(function (l, i) {
    return { componentId: l.component_id, planned: round4(Number(l.qty) * (1 + Number(l.waste_pct) / 100) * qty), unitCost: round4(bom.rollup(data, l.component_id, memo, [productId]).total), seq: i };
  });
  return {
    material: round2(r.material * qty), labour: round2(r.labour * qty), overhead: round2(r.overhead * qty),
    hours: round2(Number(c.labour_hours || 0) * qty), rate: Number(c.labour_rate || 0), parts: parts
  };
}
async function writePlan(db, jobId, plan) {
  await db.query('DELETE FROM production_job_parts WHERE job_id = $1', [jobId]);
  for (var i = 0; i < plan.parts.length; i++) {
    var x = plan.parts[i];
    await db.query('INSERT INTO production_job_parts (job_id, component_id, planned_qty, unit_cost, seq) VALUES ($1,$2,$3,$4,$5)', [jobId, x.componentId, x.planned, x.unitCost, x.seq]);
  }
  await db.query('UPDATE production_jobs SET plan_material = $2, plan_labour = $3, plan_overhead = $4, plan_hours = $5, labour_rate = $6 WHERE id = $1',
    [jobId, plan.material, plan.labour, plan.overhead, plan.hours, plan.rate]);
}

// POST /api/jobs { productId, qty, dueOn, leadId, kilnChargeId, note }
async function create(ctx, p) {
  need(ctx);
  p = p || {};
  var data = await bom.load();
  var productId = uuidOr(p.productId);
  var product = productId && data.products[productId];
  if (!product) fail('invalid', 'Pick what to make.');
  if (!(data.lines[productId] || []).length) fail('invalid', product.name + ' has no bill of materials yet: write what it is made of first.');
  var qty = qtyOf(p.qty, 'How many to make? A number over 0.', { positive: true });
  var dueOn = p.dueOn ? String(p.dueOn) : null;
  if (dueOn && !DAY.test(dueOn)) fail('invalid', 'The day it is due is not a date.');
  var plan = planFor(data, productId, qty);
  var id = await withTransaction(async function (db) {
    var lead = await checkLead(db, p.leadId);
    var charge = await checkCharge(db, p.kilnChargeId);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('production-jobs'))");
    var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM production_jobs')).rows[0].n;
    var j = (await db.query(
      'INSERT INTO production_jobs (number, product_id, qty, due_on, lead_id, kiln_charge_id, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [n, productId, qty, dueOn, lead, charge, text(p.note, 500), me(ctx)])).rows[0];
    await writePlan(db, j.id, plan);
    await audit(db, ctx, 'job.create', 'production_job', j.id, 'Planned ' + ref(n) + ': ' + qty + ' × ' + product.name + '.');
    if (lead && lead !== me(ctx)) await notify(db, lead, 'Job ' + ref(n) + ': ' + qty + ' × ' + product.name, dueOn ? 'Due ' + dueOn + '.' : 'Yours to run.', '/production-jobs?job=' + j.id);
    return j.id;
  });
  return get(ctx, id);
}

// PATCH /api/jobs/:id { dueOn, leadId, kilnChargeId, note, qty (planned only) }
async function update(ctx, id, p) {
  need(ctx);
  p = p || {};
  await withTransaction(async function (db) {
    var j = await jobRow(db, id, true);
    if (j.status === 'done' || j.status === 'cancelled') fail('conflict', 'The job is closed: it cannot be changed.');
    var dueOn = p.dueOn === undefined ? dayText(j.due_on) : p.dueOn ? String(p.dueOn) : null;
    if (dueOn && !DAY.test(dueOn)) fail('invalid', 'The day it is due is not a date.');
    var lead = p.leadId === undefined ? j.lead_id : await checkLead(db, p.leadId);
    var charge = p.kilnChargeId === undefined ? j.kiln_charge_id : await checkCharge(db, p.kilnChargeId);
    var note = p.note === undefined ? j.note : text(p.note, 500);
    var qty = Number(j.qty);
    if (p.qty !== undefined && Number(p.qty) !== qty) {
      if (j.status !== 'planned') fail('conflict', 'The job has started: make the rest as a new job.');
      qty = qtyOf(p.qty, 'How many to make? A number over 0.', { positive: true });
      await writePlan(db, j.id, planFor(await bom.load(), j.product_id, qty));
    }
    await db.query('UPDATE production_jobs SET due_on = $2, lead_id = $3, kiln_charge_id = $4, note = $5, qty = $6 WHERE id = $1', [j.id, dueOn, lead, charge, note, qty]);
    if (lead && lead !== j.lead_id && lead !== me(ctx)) await notify(db, lead, 'Job ' + ref(j.number) + ': ' + qty + ' × ' + j.product_name, 'Yours to run.', '/production-jobs?job=' + j.id);
    await audit(db, ctx, 'job.update', 'production_job', j.id, 'Changed ' + ref(j.number) + '.');
  });
  return get(ctx, id);
}

// Parts out of stock (qty > 0) or back into it (qty < 0), logged against the job.
async function move(db, ctx, j, part, qty, note) {
  if (!qty) return;
  await db.query('UPDATE products SET current_stock = current_stock - $1 WHERE id = $2', [qty, part.component_id]);
  await db.query('UPDATE production_job_parts SET issued_qty = issued_qty + $1 WHERE id = $2', [qty, part.id]);
  await db.query(
    "INSERT INTO inventory_tx (item_type, item_id, type, qty, date, user_id, reference, notes) VALUES ('product',$1,$2,$3,$4,$5,$6,$7)",
    [part.component_id, qty > 0 ? 'job_issue' : 'job_return', round2(-qty), today(), me(ctx), ref(j.number), note]);
}

// POST /api/jobs/:id/start — takes the parts out of stock: what is there.
async function start(ctx, id) {
  need(ctx);
  var short = [];
  await withTransaction(async function (db) {
    var j = await jobRow(db, id, true);
    if (j.status !== 'planned') fail('conflict', 'Only a planned job can be started.');
    var data = await bom.load();
    var memo = {};
    var parts = (await db.query('SELECT x.*, p.name, p.unit FROM production_job_parts x JOIN products p ON p.id = x.component_id WHERE x.job_id = $1 ORDER BY x.seq FOR UPDATE OF x', [j.id])).rows;
    for (var i = 0; i < parts.length; i++) {
      var x = parts[i];
      var stock = Number((await db.query('SELECT current_stock FROM products WHERE id = $1 FOR UPDATE', [x.component_id])).rows[0].current_stock);
      var take = round2(Math.min(Number(x.planned_qty), Math.max(0, stock)));
      // Taken at what it costs now.
      await db.query('UPDATE production_job_parts SET unit_cost = $2 WHERE id = $1', [x.id, round4(bom.rollup(data, x.component_id, memo, [j.product_id]).total)]);
      if (take < Number(x.planned_qty)) short.push({ name: x.name, unit: x.unit, need: round4(Number(x.planned_qty) - take) });
      await move(db, ctx, j, x, take, 'Taken for ' + ref(j.number) + ': ' + Number(j.qty) + ' × ' + j.product_name);
    }
    await db.query("UPDATE production_jobs SET status = 'in_progress', started_at = now(), started_by = $2 WHERE id = $1", [j.id, me(ctx)]);
    await audit(db, ctx, 'job.start', 'production_job', j.id, 'Started ' + ref(j.number) + (short.length ? '; short of ' + short.map(function (s) { return s.name; }).join(', ') : '') + '.');
  });
  var out = await get(ctx, id);
  out.wasShort = short;
  return out;
}

// POST /api/jobs/:id/parts { componentId, qty, note } — more taken (qty > 0)
// or some given back (qty < 0) while the job runs.
async function issue(ctx, id, p) {
  need(ctx);
  p = p || {};
  await withTransaction(async function (db) {
    var j = await jobRow(db, id, true);
    if (j.status !== 'in_progress') fail('conflict', 'Parts are taken or given back while the job runs.');
    var componentId = uuidOr(p.componentId);
    var c = componentId && (await db.query('SELECT id, name, unit, current_stock FROM products WHERE id = $1 FOR UPDATE', [componentId])).rows[0];
    if (!c) fail('invalid', 'Pick the part.');
    if (c.id === j.product_id) fail('invalid', 'A job cannot use what it makes.');
    var qty = Number(p.qty);
    if (!Number.isFinite(qty) || qty === 0 || Math.abs(qty) > MAX_QTY) fail('invalid', 'How many? Above 0 to take, below 0 to give back.');
    qty = round2(qty);
    var part = (await db.query('SELECT * FROM production_job_parts WHERE job_id = $1 AND component_id = $2 FOR UPDATE', [j.id, c.id])).rows[0];
    if (qty < 0 && (!part || -qty > Number(part.issued_qty) + 1e-9)) fail('invalid', 'Only ' + (part ? round4(part.issued_qty) : 0) + ' ' + c.unit + ' of ' + c.name + ' was taken: that is all that can go back.');
    if (qty > 0 && qty > Number(c.current_stock) + 1e-9) fail('conflict', 'Only ' + round2(c.current_stock) + ' ' + c.unit + ' of ' + c.name + ' in stock.');
    if (!part) {
      var data = await bom.load();
      var seq = (await db.query('SELECT coalesce(max(seq), 0) + 1 AS s FROM production_job_parts WHERE job_id = $1', [j.id])).rows[0].s;
      part = (await db.query('INSERT INTO production_job_parts (job_id, component_id, planned_qty, unit_cost, seq) VALUES ($1,$2,0,$3,$4) RETURNING *',
        [j.id, c.id, round4(bom.rollup(data, c.id, {}, [j.product_id]).total), seq])).rows[0];
    }
    var note = text(p.note, 200);
    await move(db, ctx, j, part, qty, (qty > 0 ? 'More for ' : 'Back from ') + ref(j.number) + (note ? ': ' + note : ''));
    await audit(db, ctx, qty > 0 ? 'job.issue' : 'job.return', 'production_job', j.id, (qty > 0 ? 'Took ' : 'Gave back ') + Math.abs(qty) + ' ' + c.unit + ' of ' + c.name + ' for ' + ref(j.number) + '.');
  });
  return get(ctx, id);
}

// POST /api/jobs/:id/finish { good, scrap, scrapReason, labourHours, overhead }
async function finish(ctx, id, p) {
  need(ctx);
  p = p || {};
  var made = null;
  await withTransaction(async function (db) {
    var j = await jobRow(db, id, true);
    if (j.status !== 'in_progress') fail('conflict', 'Only a job that has started can be finished.');
    var good = qtyOf(p.good, 'How many good ones? A number, 0 or more.');
    var scrap = qtyOf(p.scrap == null || p.scrap === '' ? 0 : p.scrap, 'How many spoilt? A number, 0 or more.');
    if (good + scrap <= 0) fail('invalid', 'How many were made? Give the good ones and what was spoilt.');
    if (good + scrap > Number(j.qty) * 2) fail('invalid', 'That is more than twice what the job was for: check the numbers.');
    var reason = text(p.scrapReason, 200);
    if (scrap > 0 && !reason) fail('invalid', 'What spoilt them? A few words, e.g. split in the press.');
    var hours = p.labourHours === undefined || p.labourHours === '' || p.labourHours === null ? Number(j.plan_hours) : Number(p.labourHours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 100000) fail('invalid', 'The hours worked must be a number, 0 or more.');
    var overhead = p.overhead === undefined || p.overhead === '' || p.overhead === null ? round2(Number(j.plan_overhead) / Number(j.qty) * (good + scrap)) : Number(p.overhead);
    if (!Number.isFinite(overhead) || overhead < 0 || overhead > 1e9) fail('invalid', 'The overhead must be a number, 0 or more.');
    var fg = (await db.query("SELECT id FROM warehouses WHERE code = 'WH-FG' LIMIT 1")).rows[0];
    if (good > 0) {
      await db.query('UPDATE products SET current_stock = current_stock + $1 WHERE id = $2', [good, j.product_id]);
      await db.query(
        "INSERT INTO inventory_tx (item_type, item_id, warehouse_id, type, qty, date, user_id, reference, notes) VALUES ('product',$1,$2,'job_output',$3,$4,$5,$6,$7)",
        [j.product_id, fg ? fg.id : null, good, today(), me(ctx), ref(j.number), 'Made in ' + ref(j.number) + (scrap > 0 ? '; ' + scrap + ' spoilt: ' + reason : '')]);
    }
    await db.query(
      "UPDATE production_jobs SET status = 'done', good_qty = $2, scrap_qty = $3, scrap_reason = $4, labour_hours = $5, overhead = $6, finished_at = now(), finished_by = $7 WHERE id = $1",
      [j.id, good, scrap, reason, round2(hours), round2(overhead), me(ctx)]);
    await audit(db, ctx, 'job.finish', 'production_job', j.id, 'Finished ' + ref(j.number) + ': ' + good + ' good, ' + scrap + ' spoilt.');
    made = { ref: ref(j.number), good: good, name: j.product_name, productId: j.product_id, id: j.id };
  });
  // Quality is told there is a lot to inspect.
  if (made.good > 0) {
    var link = '/quality?lot=' + encodeURIComponent(made.ref) + '&product=' + made.productId + '&qty=' + made.good;
    var inspectors = (await staffAlerts.holdersOf(['quality.manage'])).map(function (h) { return h.employee_id; });
    for (var i = 0; i < inspectors.length; i++) {
      if (inspectors[i] !== me(ctx)) await notify(pool, inspectors[i], made.ref + ' is done: ' + made.good + ' × ' + made.name + ' to inspect', 'The lot is ' + made.ref + '.', link);
    }
  }
  return get(ctx, id);
}

// POST /api/jobs/:id/cancel { reason } — what was taken goes back to stock.
async function cancel(ctx, id, p) {
  need(ctx);
  p = p || {};
  var reason = text(p.reason, 300);
  if (!reason) fail('invalid', 'Why is it cancelled?');
  await withTransaction(async function (db) {
    var j = await jobRow(db, id, true);
    if (j.status !== 'planned' && j.status !== 'in_progress') fail('conflict', 'Only a job not finished yet can be cancelled.');
    var parts = (await db.query('SELECT * FROM production_job_parts WHERE job_id = $1 FOR UPDATE', [j.id])).rows;
    for (var i = 0; i < parts.length; i++) {
      if (Number(parts[i].issued_qty) > 0) await move(db, ctx, j, parts[i], -Number(parts[i].issued_qty), 'Back from ' + ref(j.number) + ', cancelled: ' + reason);
    }
    await db.query("UPDATE production_jobs SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1", [j.id, me(ctx), reason]);
    await audit(db, ctx, 'job.cancel', 'production_job', j.id, 'Cancelled ' + ref(j.number) + ': ' + reason);
  });
  return get(ctx, id);
}

// For the monthly report: what was made in a month.
async function monthFigures(from, to) {
  var r = (await pool.query(
    "SELECT count(*)::int AS jobs, coalesce(sum(j.good_qty), 0) AS good, coalesce(sum(j.scrap_qty), 0) AS scrap, coalesce(sum(j.good_qty * p.selling_price), 0) AS value " +
    "FROM production_jobs j JOIN products p ON p.id = j.product_id WHERE j.status = 'done' AND j.finished_at >= $1::date AND j.finished_at < $2::date + 1", [from, to])).rows[0];
  var good = Number(r.good), scrap = Number(r.scrap);
  return { jobs: r.jobs, good: round2(good), scrap: round2(scrap), value: round2(r.value), scrapPct: good + scrap > 0 ? Math.round(scrap / (good + scrap) * 1000) / 10 : null };
}

module.exports = { overview: overview, get: get, create: create, update: update, start: start, issue: issue, finish: finish, cancel: cancel, monthFigures: monthFigures, ref: ref };
