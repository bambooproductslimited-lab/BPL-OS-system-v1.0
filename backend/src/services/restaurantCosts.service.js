var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');
var insights = require('./restaurantTillInsights.service');

// Recipes and food cost (migration 0179; Square's recipes, cost of goods
// sold and margins, with menu engineering on top). A dish — or one of its
// sizes — is made of ingredients from the restaurant's stock (the OS's
// Restaurants page keeps them, with their unit costs); a dish with no
// recipe can have its cost set by hand (a bought-in soft drink). Each sale
// draws the ingredients down (stock moves 'sold', put back if the sale is
// voided) and keeps each line's cost at the time, so the report shows the
// cost of goods sold, the profit and the food cost %, by dish and by
// category, and sorts the menu into stars, plowhorses, puzzles and dogs
// (Kasavana & Smith: popular or not, against 70% of an even share of what
// sold; earning more or less than the average profit a dish makes).
//
// A size's own recipe first, else the dish's; else the size's cost set by
// hand, else the dish's; else unknown (not in the margins).

var MAX_LINES = 30;
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function round4(n) { return Math.round(Number(n) * 10000) / 10000; }
function keyOf(itemId, variationId) { return itemId + '|' + (variationId || ''); }

// What one of each costs now, for some dishes: { 'item|variation': { cost, source, lines } }.
async function costsOf(db, companyId, itemIds) {
  var out = {};
  if (!itemIds.length) return out;
  var recipes = (await db.query(
    'SELECT r.menu_item_id, r.variation_id, r.ingredient_id, r.qty, i.name, i.unit, i.unit_cost FROM restaurant_recipes r JOIN restaurant_ingredients i ON i.id = r.ingredient_id ' +
    'WHERE r.company_id = $1 AND r.menu_item_id = ANY($2::uuid[]) ORDER BY i.name', [companyId, itemIds])).rows;
  var items = (await db.query('SELECT id, unit_cost FROM restaurant_menu_items WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, itemIds])).rows;
  var vars = (await db.query('SELECT id, menu_item_id, unit_cost FROM restaurant_menu_item_variations WHERE menu_item_id = ANY($1::uuid[])', [itemIds])).rows;
  var byRecipe = {};
  recipes.forEach(function (r) {
    var k = keyOf(r.menu_item_id, r.variation_id);
    (byRecipe[k] = byRecipe[k] || []).push({ ingredientId: r.ingredient_id, name: r.name, unit: r.unit, qty: Number(r.qty), unitCost: Number(r.unit_cost), cost: round4(Number(r.qty) * Number(r.unit_cost)) });
  });
  function settle(itemId, variationId, manual, itemManual) {
    var lines = byRecipe[keyOf(itemId, variationId)] || (variationId ? byRecipe[keyOf(itemId, null)] : null);
    var own = !!byRecipe[keyOf(itemId, variationId)];
    if (lines) return { cost: round4(lines.reduce(function (a, l) { return a + l.cost; }, 0)), source: own || !variationId ? 'recipe' : 'dish_recipe', lines: lines };
    if (manual != null) return { cost: Number(manual), source: 'manual', lines: [] };
    if (itemManual != null) return { cost: Number(itemManual), source: 'dish_manual', lines: [] };
    return { cost: null, source: null, lines: [] };
  }
  items.forEach(function (it) {
    out[keyOf(it.id, null)] = settle(it.id, null, it.unit_cost, null);
    vars.filter(function (v) { return v.menu_item_id === it.id; }).forEach(function (v) { out[keyOf(it.id, v.id)] = settle(it.id, v.id, v.unit_cost, it.unit_cost); });
  });
  return out;
}

// For a sale (restaurantPos.chargeOrder): each line's cost of one, and the
// ingredients it draws.
async function forLines(db, companyId, lines) {
  var ids = [];
  lines.forEach(function (l) { if (l.menuItemId && ids.indexOf(l.menuItemId) < 0) ids.push(l.menuItemId); });
  var map = await costsOf(db, companyId, ids);
  return lines.map(function (l) {
    var c = l.menuItemId ? map[keyOf(l.menuItemId, l.variationId)] || map[keyOf(l.menuItemId, null)] : null;
    return c ? { unitCost: c.cost, lines: c.lines } : { unitCost: null, lines: [] };
  });
}
// The ingredients a sale used, off the stock (in its transaction).
async function drawDown(client, companyId, orderId, by, lines, costs) {
  var use = {};
  lines.forEach(function (l, i) {
    (costs[i].lines || []).forEach(function (r) { use[r.ingredientId] = (use[r.ingredientId] || 0) + r.qty * Number(l.qty); });
  });
  var ids = Object.keys(use);
  for (var i = 0; i < ids.length; i++) {
    var q = round4(use[ids[i]]);
    var r = (await client.query('UPDATE restaurant_ingredients SET stock_qty = stock_qty - $2, updated_at = now() WHERE id = $1 AND company_id = $3 RETURNING stock_qty, unit_cost', [ids[i], q, companyId])).rows[0];
    if (r) {
      await client.query(
        "INSERT INTO restaurant_stock_moves (company_id, item_type, item_id, kind, delta, qty_after, unit_cost, note, created_by, order_id) VALUES ($1,'ingredient',$2,'sold',$3,$4,$5,'',$6,$7)",
        [companyId, ids[i], -q, round2(r.stock_qty), round2(r.unit_cost), by || null, orderId]);
    }
  }
}
// A voided sale's ingredients back on the stock.
async function returnForVoid(client, order) {
  var rows = (await client.query(
    "SELECT item_id, -sum(delta) AS qty FROM restaurant_stock_moves WHERE order_id = $1 AND item_type = 'ingredient' AND kind = 'sold' GROUP BY 1", [order.id])).rows;
  for (var i = 0; i < rows.length; i++) {
    var r = (await client.query('UPDATE restaurant_ingredients SET stock_qty = stock_qty + $2, updated_at = now() WHERE id = $1 RETURNING stock_qty, unit_cost', [rows[i].item_id, Number(rows[i].qty)])).rows[0];
    if (r) {
      await client.query(
        "INSERT INTO restaurant_stock_moves (company_id, item_type, item_id, kind, delta, qty_after, unit_cost, note, order_id) VALUES ($1,'ingredient',$2,'voided',$3,$4,$5,$6,$7)",
        [order.company_id, rows[i].item_id, Number(rows[i].qty), round2(r.stock_qty), round2(r.unit_cost), 'Sale ' + order.order_no + ' voided', order.id]);
    }
  }
}

// { action: 'list' } — the dishes with their cost now, and the ingredients to make them of.
async function list(companyId) {
  var items = (await pool.query('SELECT id, name, category, price, unit_cost, active FROM restaurant_menu_items WHERE company_id = $1 ORDER BY category, name', [companyId])).rows;
  var vars = items.length ? (await pool.query('SELECT id, menu_item_id, name, price, unit_cost FROM restaurant_menu_item_variations WHERE menu_item_id = ANY($1::uuid[]) ORDER BY sort_order, created_at',
    [items.map(function (r) { return r.id; })])).rows : [];
  var costs = await costsOf(pool, companyId, items.map(function (r) { return r.id; }));
  function costed(price, c) {
    return { cost: c.cost == null ? null : round2(c.cost), source: c.source, recipe: c.lines.map(function (l) { return { ingredientId: l.ingredientId, name: l.name, unit: l.unit, qty: l.qty, cost: round2(l.cost) }; }),
      foodCost: c.cost != null && Number(price) > 0 ? round2(c.cost / Number(price) * 100) : null, profit: c.cost == null ? null : round2(Number(price) - c.cost) };
  }
  var ingredients = (await pool.query('SELECT id, name, unit, unit_cost, stock_qty, reorder_level FROM restaurant_ingredients WHERE company_id = $1 AND active ORDER BY name', [companyId])).rows;
  var dishes = items.map(function (it) {
    var c = costs[keyOf(it.id, null)] || { cost: null, source: null, lines: [] };
    return Object.assign({ id: it.id, name: it.name, category: it.category, price: Number(it.price), active: it.active, manualCost: it.unit_cost == null ? null : Number(it.unit_cost),
      sizes: vars.filter(function (v) { return v.menu_item_id === it.id; }).map(function (v) {
        return Object.assign({ id: v.id, name: v.name, price: Number(v.price), manualCost: v.unit_cost == null ? null : Number(v.unit_cost) }, costed(v.price, costs[keyOf(it.id, v.id)] || { cost: null, source: null, lines: [] }));
      }) }, costed(it.price, c));
  });
  var priced = dishes.filter(function (d) { return d.cost != null; });
  return {
    dishes: dishes,
    ingredients: ingredients.map(function (r) { return { id: r.id, name: r.name, unit: r.unit, unitCost: Number(r.unit_cost), stockQty: Number(r.stock_qty), low: Number(r.stock_qty) <= Number(r.reorder_level) }; }),
    summary: { dishes: dishes.length, costed: priced.length, recipes: dishes.filter(function (d) { return d.source === 'recipe'; }).length,
      averageFoodCost: priced.length ? round2(priced.reduce(function (a, d) { return a + (d.foodCost || 0); }, 0) / priced.length) : null }
  };
}

async function dishOf(companyId, menuItemId, variationId) {
  var it = (await pool.query('SELECT id, name FROM restaurant_menu_items WHERE id = $1 AND company_id = $2', [String(menuItemId || ''), companyId])).rows[0];
  if (!it) fail('notfound', 'That dish is not on this menu.');
  var v = null;
  if (variationId) {
    v = (await pool.query('SELECT id, name FROM restaurant_menu_item_variations WHERE id = $1 AND menu_item_id = $2', [String(variationId), it.id])).rows[0];
    if (!v) fail('notfound', 'That size is not this dish\'s.');
  }
  return { item: it, variation: v, name: it.name + (v ? ' (' + v.name + ')' : '') };
}

// { action: 'recipe', menuItemId, variationId, lines: [{ ingredientId, qty }] } — what goes into it (none: no recipe).
async function saveRecipe(companyId, managerId, p) {
  var d = await dishOf(companyId, p.menuItemId, p.variationId);
  var lines = Array.isArray(p.lines) ? p.lines : [];
  if (lines.length > MAX_LINES) fail('invalid', 'A recipe has at most ' + MAX_LINES + ' ingredients.');
  var seen = {};
  var clean = lines.map(function (l) {
    var qty = round4(l && l.qty);
    if (!(qty > 0 && qty <= 10000)) fail('invalid', 'Give how much of each ingredient goes in (more than 0).');
    var id = String(l.ingredientId || '');
    if (seen[id]) fail('invalid', 'An ingredient is in the recipe twice.');
    seen[id] = true;
    return { ingredientId: id, qty: qty };
  });
  if (clean.length) {
    var known = (await pool.query('SELECT id FROM restaurant_ingredients WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, clean.map(function (l) { return l.ingredientId; })]).catch(function () { return { rows: [] }; })).rows;
    if (known.length !== clean.length) fail('invalid', 'Pick the ingredients from this restaurant\'s stock.');
  }
  await withTransaction(async function (client) {
    await client.query('DELETE FROM restaurant_recipes WHERE menu_item_id = $1 AND variation_id IS NOT DISTINCT FROM $2', [d.item.id, d.variation ? d.variation.id : null]);
    for (var i = 0; i < clean.length; i++) {
      await client.query('INSERT INTO restaurant_recipes (company_id, menu_item_id, variation_id, ingredient_id, qty) VALUES ($1,$2,$3,$4,$5)',
        [companyId, d.item.id, d.variation ? d.variation.id : null, clean[i].ingredientId, clean[i].qty]);
    }
  });
  await activity.log(pool, { companyId: companyId, employeeId: managerId, app: 'till', action: 'costs.recipe',
    summary: clean.length ? 'Recipe for ' + d.name + ' set: ' + clean.length + ' ingredient' + (clean.length === 1 ? '' : 's') + '.' : 'Recipe for ' + d.name + ' taken off.', refType: 'menu_item', refId: d.item.id });
}
// { action: 'cost', menuItemId, variationId, unitCost } — a cost set by hand (null: none).
async function saveCost(companyId, managerId, p) {
  var d = await dishOf(companyId, p.menuItemId, p.variationId);
  var cost = p.unitCost === null || p.unitCost === '' || p.unitCost === undefined ? null : round2(p.unitCost);
  if (cost !== null && !(cost >= 0 && cost <= 100000)) fail('invalid', 'A cost is from GHS 0 up.');
  if (d.variation) await pool.query('UPDATE restaurant_menu_item_variations SET unit_cost = $2 WHERE id = $1', [d.variation.id, cost]);
  else await pool.query('UPDATE restaurant_menu_items SET unit_cost = $2, updated_at = now() WHERE id = $1', [d.item.id, cost]);
  await activity.log(pool, { companyId: companyId, employeeId: managerId, app: 'till', action: 'costs.cost',
    summary: 'Cost of ' + d.name + (cost === null ? ' cleared.' : ' set to ' + cost.toFixed(2) + '.'), refType: 'menu_item', refId: d.item.id });
}

// { action: 'report', from, to } — cost of goods sold and margins.
async function report(companyId, q) {
  var p = insights.periodOf(q || {});
  var rows = (await pool.query(
    "SELECT coalesce(i.menu_item_id::text, 'custom:' || i.name) AS key, i.menu_item_id, max(i.name) AS name, coalesce(max(m.category), '') AS category, " +
    '  sum(i.qty) AS qty, sum(i.line_total) AS revenue, sum(CASE WHEN i.unit_cost IS NULL THEN 0 ELSE i.qty * i.unit_cost END) AS cost, ' +
    '  sum(CASE WHEN i.unit_cost IS NULL THEN i.qty ELSE 0 END) AS uncosted_qty, sum(CASE WHEN i.unit_cost IS NULL THEN i.line_total ELSE 0 END) AS uncosted_revenue ' +
    'FROM restaurant_order_items i JOIN restaurant_orders o ON o.id = i.order_id LEFT JOIN restaurant_menu_items m ON m.id = i.menu_item_id ' +
    "WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at >= $2::date AND o.created_at < $3::date + interval '1 day' GROUP BY 1, 2", [companyId, p.from, p.to])).rows;
  var dishes = rows.map(function (r) {
    var qty = Number(r.qty), revenue = round2(r.revenue), costedRevenue = round2(r.revenue - r.uncosted_revenue), cost = round2(r.cost);
    var costed = Number(r.uncosted_qty) < qty;
    return { id: r.menu_item_id, name: r.name, category: r.category || '', qty: qty, revenue: revenue, cost: costed ? cost : null,
      profit: costed ? round2(costedRevenue - cost) : null, foodCost: costed && costedRevenue > 0 ? round2(cost / costedRevenue * 100) : null,
      unitProfit: costed && qty - Number(r.uncosted_qty) > 0 ? round2((costedRevenue - cost) / (qty - Number(r.uncosted_qty))) : null, uncosted: Number(r.uncosted_qty) };
  });
  // Menu engineering, over the costed dishes.
  var eng = dishes.filter(function (d) { return d.id && d.unitProfit != null && d.qty > 0; });
  var soldAll = eng.reduce(function (a, d) { return a + d.qty; }, 0);
  var popularAt = eng.length ? soldAll / eng.length * 0.7 : 0;
  var averageProfit = soldAll ? eng.reduce(function (a, d) { return a + d.unitProfit * d.qty; }, 0) / soldAll : 0;
  eng.forEach(function (d) {
    var popular = d.qty >= popularAt, earns = d.unitProfit >= averageProfit;
    d.class = popular && earns ? 'star' : popular ? 'plowhorse' : earns ? 'puzzle' : 'dog';
  });
  dishes.sort(function (a, b) { return b.revenue - a.revenue; });
  var cats = {};
  dishes.forEach(function (d) {
    var c = cats[d.category] = cats[d.category] || { category: d.category, qty: 0, revenue: 0, costedRevenue: 0, cost: 0 };
    c.qty += d.qty; c.revenue += d.revenue;
    if (d.cost != null) { c.cost += d.cost; c.costedRevenue += d.profit + d.cost; }
  });
  var categories = Object.keys(cats).map(function (k) {
    var c = cats[k];
    return { category: c.category, qty: c.qty, revenue: round2(c.revenue), cost: round2(c.cost), profit: round2(c.costedRevenue - c.cost),
      foodCost: c.costedRevenue > 0 ? round2(c.cost / c.costedRevenue * 100) : null };
  }).sort(function (a, b) { return b.revenue - a.revenue; });
  var used = (await pool.query(
    "SELECT g.id, g.name, g.unit, -sum(s.delta) AS qty, -sum(s.delta * s.unit_cost) AS cost FROM restaurant_stock_moves s JOIN restaurant_ingredients g ON g.id = s.item_id " +
    "WHERE s.company_id = $1 AND s.item_type = 'ingredient' AND s.kind IN ('sold', 'voided') AND s.order_id IS NOT NULL AND s.created_at >= $2::date AND s.created_at < $3::date + interval '1 day' " +
    'GROUP BY 1, 2, 3 HAVING sum(s.delta) <> 0 ORDER BY 5 DESC LIMIT 50', [companyId, p.from, p.to])).rows;
  var revenue = round2(dishes.reduce(function (a, d) { return a + d.revenue; }, 0));
  var cost = round2(dishes.reduce(function (a, d) { return a + (d.cost || 0); }, 0));
  var costedRevenue = round2(dishes.reduce(function (a, d) { return a + (d.cost != null ? d.profit + d.cost : 0); }, 0));
  return {
    period: p,
    totals: { revenue: revenue, cost: cost, profit: round2(costedRevenue - cost), foodCost: costedRevenue > 0 ? round2(cost / costedRevenue * 100) : null,
      costedShare: revenue > 0 ? round2(costedRevenue / revenue * 100) : null, uncostedRevenue: round2(revenue - costedRevenue) },
    dishes: dishes, categories: categories,
    engineering: { popularAt: round2(popularAt), averageProfit: round2(averageProfit),
      counts: ['star', 'plowhorse', 'puzzle', 'dog'].reduce(function (a, k) { a[k] = eng.filter(function (d) { return d.class === k; }).length; return a; }, {}) },
    ingredients: used.map(function (r) { return { id: r.id, name: r.name, unit: r.unit, qty: round2(r.qty), cost: round2(r.cost) }; })
  };
}

// POST /api/pos/settings/costs { managerPin, action: 'list' | 'recipe' | 'cost' | 'report' }
async function tab(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var companyId = m.session.posCompanyId;
  if (p.action === 'report') return report(companyId, p);
  if (p.action === 'recipe') await saveRecipe(companyId, m.manager.id, p);
  else if (p.action === 'cost') await saveCost(companyId, m.manager.id, p);
  return list(companyId);
}

module.exports = { costsOf: costsOf, forLines: forLines, drawDown: drawDown, returnForVoid: returnForVoid, list: list, report: report, tab: tab };
