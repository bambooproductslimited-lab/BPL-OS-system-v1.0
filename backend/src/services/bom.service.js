var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// Bills of materials and product costing (migration 0201): what one of a
// product is made of — other products (culms, boards, glue, lacquer, screws)
// with a share for waste — plus the labour hours at a rate and an overhead.
// The cost rolls up through parts that have a bill of their own; against the
// selling price it gives the margin, against the cost price on file it shows
// when that is out of date (and sets it, kept in the history). From the
// stock: how many can be made now and what runs out first; for a planned
// run, what is short and what buying it would cost.

var LOW_MARGIN = 20;
var MAX_LINES = 40;
var MAX_DEPTH = 8;

function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function round4(n) { return Math.round(Number(n || 0) * 10000) / 10000; }
function canRead(ctx) { return ctx.can('production.read') || ctx.can('production.manage') || ctx.can('inventory.read'); }
function needRead(ctx) { if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (production.read).'); }
function need(ctx) { if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).'); }

// Everything at once: the catalogue is small enough.
async function load() {
  var products = {};
  (await pool.query('SELECT id, sku, name, category, unit, cost_price, selling_price, current_stock FROM products')).rows.forEach(function (p) { products[p.id] = p; });
  var lines = {};
  (await pool.query('SELECT * FROM bom_lines ORDER BY seq, id')).rows.forEach(function (l) { (lines[l.product_id] = lines[l.product_id] || []).push(l); });
  var costs = {};
  (await pool.query('SELECT * FROM bom_costs')).rows.forEach(function (c) { costs[c.product_id] = c; });
  return { products: products, lines: lines, costs: costs };
}

function hasBom(data, id) { return !!((data.lines[id] || []).length || data.costs[id]); }
function perUnit(l) { return Number(l.qty) * (1 + Number(l.waste_pct) / 100); }

// The cost of one, rolled up through the parts with a bill of their own.
function rollup(data, id, memo, path) {
  if (memo[id]) return memo[id];
  var p = data.products[id];
  var onFile = p ? Number(p.cost_price) : 0;
  if (!hasBom(data, id)) return (memo[id] = { material: onFile, labour: 0, overhead: 0, total: onFile, fromBom: false });
  if (path.indexOf(id) >= 0 || path.length > MAX_DEPTH) return { material: onFile, labour: 0, overhead: 0, total: onFile, fromBom: false, loop: true };
  var material = 0;
  (data.lines[id] || []).forEach(function (l) { material += rollup(data, l.component_id, memo, path.concat(id)).total * perUnit(l); });
  var c = data.costs[id] || {};
  var labour = Number(c.labour_hours || 0) * Number(c.labour_rate || 0);
  var overhead = Number(c.overhead || 0);
  return (memo[id] = { material: round4(material), labour: round4(labour), overhead: round4(overhead), total: round4(material + labour + overhead), fromBom: true });
}

// How many can be made from the stock of the direct parts, and which runs out first.
function buildable(data, id) {
  var lines = data.lines[id] || [];
  if (!lines.length) return { can: null, limiting: null };
  var best = null, limiting = null;
  lines.forEach(function (l) {
    var c = data.products[l.component_id];
    var n = Math.max(0, Math.floor(Number(c ? c.current_stock : 0) / perUnit(l) + 1e-9));
    if (best === null || n < best) { best = n; limiting = c ? { id: c.id, name: c.name } : null; }
  });
  return { can: best, limiting: limiting };
}

function rowOf(data, id, memo) {
  var p = data.products[id];
  var r = rollup(data, id, memo, []);
  var price = Number(p.selling_price), onFile = Number(p.cost_price);
  var b = buildable(data, id);
  return {
    id: p.id, sku: p.sku, name: p.name, category: p.category, unit: p.unit, price: price, costOnFile: onFile, stock: Number(p.current_stock),
    material: round2(r.material), labour: round2(r.labour), overhead: round2(r.overhead), cost: round2(r.total),
    margin: round2(price - r.total), marginPct: price > 0 ? Math.round((price - r.total) / price * 1000) / 10 : null,
    diffPct: onFile > 0 ? Math.round((r.total - onFile) / onFile * 1000) / 10 : null,
    buildable: b.can, limiting: b.limiting, lines: (data.lines[id] || []).length
  };
}

// GET /api/bom
async function overview(ctx) {
  needRead(ctx);
  var data = await load();
  var memo = {};
  var ids = Object.keys(data.products).filter(function (id) { return hasBom(data, id); });
  var rows = ids.map(function (id) { return rowOf(data, id, memo); }).sort(function (a, b) { return (a.marginPct == null ? 999 : a.marginPct) - (b.marginPct == null ? 999 : b.marginPct); });
  var used = {};
  Object.keys(data.lines).forEach(function (pid) { data.lines[pid].forEach(function (l) { (used[l.component_id] = used[l.component_id] || []).push(pid); }); });
  var parts = Object.keys(used).map(function (cid) {
    var c = data.products[cid];
    return { id: cid, name: c.name, sku: c.sku, unit: c.unit, cost: Number(c.cost_price), stock: Number(c.current_stock), usedIn: used[cid].length };
  }).sort(function (a, b) { return b.usedIn - a.usedIn || a.name.localeCompare(b.name); });
  var partIds = Object.keys(used);
  var noBom = Object.values(data.products).filter(function (p) { return Number(p.selling_price) > 0 && !hasBom(data, p.id) && partIds.indexOf(p.id) < 0; })
    .map(function (p) { return { id: p.id, sku: p.sku, name: p.name, category: p.category, price: Number(p.selling_price), costOnFile: Number(p.cost_price) }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  var priced = rows.filter(function (r) { return r.marginPct != null; });
  return {
    products: rows, parts: parts.slice(0, 30), noBom: noBom.slice(0, 60), lowMargin: LOW_MARGIN, canManage: ctx.can('production.manage'),
    catalogue: Object.values(data.products).map(function (p) { return { id: p.id, sku: p.sku, name: p.name, unit: p.unit, cost: Number(p.cost_price), stock: Number(p.current_stock), category: p.category }; }).sort(function (a, b) { return a.name.localeCompare(b.name); }),
    summary: {
      costed: rows.length,
      avgMargin: priced.length ? Math.round(priced.reduce(function (a, r) { return a + r.marginPct; }, 0) / priced.length * 10) / 10 : null,
      lowMargin: priced.filter(function (r) { return r.marginPct < LOW_MARGIN; }).length,
      stale: rows.filter(function (r) { return r.diffPct != null && Math.abs(r.diffPct) > 5; }).length,
      noBom: noBom.length,
      canMake: rows.reduce(function (a, r) { return a + (r.buildable || 0) * r.price; }, 0)
    }
  };
}

// GET /api/bom/:productId?qty= — the bill, the roll-up, what can be made,
// where it is used, and for a planned run what is short.
async function get(ctx, id, q) {
  needRead(ctx);
  q = q || {};
  var data = await load();
  var p = data.products[uuidOr(id)];
  if (!p) fail('notfound', 'That product is gone.');
  var memo = {};
  var row = rowOf(data, p.id, memo);
  var lines = (data.lines[p.id] || []).map(function (l) {
    var c = data.products[l.component_id];
    var unitCost = rollup(data, l.component_id, memo, [p.id]).total;
    return {
      id: l.id, component: { id: c.id, sku: c.sku, name: c.name, unit: c.unit, stock: Number(c.current_stock), costOnFile: Number(c.cost_price), hasBom: hasBom(data, c.id) },
      qty: Number(l.qty), wastePct: Number(l.waste_pct), perUnit: round4(perUnit(l)), unitCost: round4(unitCost), lineCost: round2(unitCost * perUnit(l)), note: l.note,
      makes: Math.floor(Number(c.current_stock) / perUnit(l) + 1e-9)
    };
  });
  var c = data.costs[p.id] || {};
  var plan = null;
  var qty = Math.round(Number(q.qty) || 0);
  if (qty > 0) {
    var needs = lines.map(function (l) {
      var needQty = round4(l.perUnit * qty), short = Math.max(0, round4(needQty - l.component.stock));
      return { component: l.component, need: needQty, have: l.component.stock, short: short, shortCost: round2(short * l.unitCost) };
    });
    plan = { qty: qty, needs: needs, shortCost: round2(needs.reduce(function (a, n) { return a + n.shortCost; }, 0)), cost: round2(row.cost * qty), value: round2(row.price * qty), ok: needs.every(function (n) { return n.short === 0; }) };
  }
  var whereUsed = [];
  Object.keys(data.lines).forEach(function (pid) {
    data.lines[pid].forEach(function (l) { if (l.component_id === p.id) whereUsed.push({ id: pid, name: data.products[pid].name, qty: Number(l.qty) }); });
  });
  var history = (await pool.query('SELECT h.*, e.first_name, e.last_name FROM product_cost_history h LEFT JOIN employees e ON e.id = h.by_id WHERE h.product_id = $1 ORDER BY h.at DESC LIMIT 10', [p.id])).rows.map(function (h) {
    return { before: Number(h.cost_before), after: Number(h.cost_after), at: h.at, by: h.first_name ? (h.first_name + ' ' + (h.last_name || '')).trim() : null };
  });
  return Object.assign(row, {
    lines: lines, labourHours: Number(c.labour_hours || 0), labourRate: Number(c.labour_rate || 0), overheadEach: Number(c.overhead || 0), note: c.note || '',
    plan: plan, whereUsed: whereUsed, history: history, canManage: ctx.can('production.manage')
  });
}

// Would the product be inside its own bill, through its parts?
function loops(data, id) {
  var seen = {};
  function walk(pid, depth) {
    if (depth > MAX_DEPTH + 2) return true;
    return (data.lines[pid] || []).some(function (l) {
      if (l.component_id === id) return true;
      if (seen[l.component_id]) return false;
      seen[l.component_id] = true;
      return walk(l.component_id, depth + 1);
    });
  }
  return walk(id, 0);
}

// PUT /api/bom/:productId { lines: [{ componentId, qty, wastePct, note }],
// labourHours, labourRate, overhead, note } — the whole bill, replaced.
async function save(ctx, id, p) {
  need(ctx);
  p = p || {};
  var data = await load();
  var prod = data.products[uuidOr(id)];
  if (!prod) fail('notfound', 'That product is gone.');
  var given = Array.isArray(p.lines) ? p.lines : [];
  if (given.length > MAX_LINES) fail('invalid', MAX_LINES + ' parts at most.');
  var lines = [];
  given.forEach(function (l, n) {
    var cid = uuidOr(l && l.componentId);
    if (!cid || !data.products[cid]) fail('invalid', 'Part ' + (n + 1) + ': which product?');
    if (cid === prod.id) fail('invalid', 'A product cannot be made of itself.');
    var qty = Number(l.qty);
    if (!(qty > 0 && qty < 1e6)) fail('invalid', data.products[cid].name + ': how many go into one?');
    var waste = Number(l.wastePct) || 0;
    if (waste < 0 || waste > 90) fail('invalid', data.products[cid].name + ': waste between 0 and 90%.');
    var same = lines.find(function (x) { return x.component_id === cid; });
    if (same) same.qty = round4(same.qty + qty);
    else lines.push({ component_id: cid, qty: round4(qty), waste_pct: Math.round(waste * 100) / 100, note: text(l.note, 200), seq: n });
  });
  var hours = Number(p.labourHours) || 0, rate = Number(p.labourRate) || 0, overhead = Number(p.overhead) || 0;
  if (hours < 0 || hours > 10000 || rate < 0 || rate > 1e6 || overhead < 0 || overhead > 1e7) fail('invalid', 'Labour and overhead cannot be below nothing.');
  data.lines[prod.id] = lines;
  if (loops(data, prod.id)) fail('invalid', prod.name + ' would end up inside its own bill: one of its parts is made from it.');
  await withTransaction(async function (db) {
    await db.query('DELETE FROM bom_lines WHERE product_id = $1', [prod.id]);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      await db.query('INSERT INTO bom_lines (product_id, component_id, qty, waste_pct, note, seq) VALUES ($1,$2,$3,$4,$5,$6)', [prod.id, l.component_id, l.qty, l.waste_pct, l.note, i]);
    }
    if (!lines.length && !hours && !overhead) await db.query('DELETE FROM bom_costs WHERE product_id = $1', [prod.id]);
    else await db.query('INSERT INTO bom_costs (product_id, labour_hours, labour_rate, overhead, note, updated_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (product_id) DO UPDATE SET labour_hours = EXCLUDED.labour_hours, labour_rate = EXCLUDED.labour_rate, overhead = EXCLUDED.overhead, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()',
      [prod.id, hours, rate, overhead, text(p.note, 1000), me(ctx)]);
  });
  await audit(pool, ctx, 'bom.save', 'product', prod.id, 'Bill of materials for "' + prod.name + '": ' + lines.length + ' parts.');
  return get(ctx, prod.id, {});
}

// POST /api/bom/:productId/use-cost — the cost price on file becomes the roll-up.
async function useCost(ctx, id) {
  need(ctx);
  var data = await load();
  var prod = data.products[uuidOr(id)];
  if (!prod) fail('notfound', 'That product is gone.');
  if (!hasBom(data, prod.id)) fail('conflict', 'It has no bill of materials yet.');
  var cost = round2(rollup(data, prod.id, {}, []).total);
  var before = Number(prod.cost_price);
  if (cost === round2(before)) fail('conflict', 'The cost on file is already ' + cost.toFixed(2) + '.');
  await withTransaction(async function (db) {
    await db.query('UPDATE products SET cost_price = $2 WHERE id = $1', [prod.id, cost]);
    await db.query('INSERT INTO product_cost_history (product_id, cost_before, cost_after, source, by_id) VALUES ($1,$2,$3,$4,$5)', [prod.id, before, cost, 'bom', me(ctx)]);
  });
  await audit(pool, ctx, 'bom.cost', 'product', prod.id, '"' + prod.name + '" cost price ' + before.toFixed(2) + ' → ' + cost.toFixed(2) + ' from its bill of materials.');
  return get(ctx, prod.id, {});
}

module.exports = { overview: overview, get: get, save: save, useCost: useCost, rollup: rollup, load: load, LOW_MARGIN: LOW_MARGIN };
