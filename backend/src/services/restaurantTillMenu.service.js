var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var fileStore = require('../lib/fileStore');
var restaurantService = require('./restaurant.service');
var activity = require('./restaurantActivity.service');

// The menu and the stock, kept from the till by a manager (and the stock by
// whoever's role may count it) — restaurantTillAccess.menu / .stock:
//
// - The menu: add, change (name, category, price, sizes), take off the till
//   for now (active), or remove a dish. Past sales keep their dish's name.
// - Stock on a dish or drink (migration 0158): a dish may count its stock —
//   bottles, portions. A sale takes it off by itself (deductForSale); a
//   voided sale puts it back. Until new stock comes in, the count only goes
//   down: a manager types the new figure (a count) or adds what came in.
//   The till shows what is left; nobody can order more than is left
//   (checkOrder) — but an order already sent to the kitchen is always paid,
//   even if a count was wrong (its stock just goes below zero).
// - Supplies and ingredients (restaurant_supplies, restaurant_ingredients):
//   counted and received here too, logged the same way.

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function who(m) { return { user: { id: null }, employee: { first_name: m.first_name, last_name: m.last_name } }; }

// ── stock on the till ──

// What open orders hold of each counted dish (sent to the kitchen, not paid yet).
async function heldOnTabs(db, companyId, exceptTabId) {
  var rows = (await db.query(
    "SELECT (i->>'menuItemId')::uuid AS id, sum((i->>'qty')::numeric) AS qty FROM restaurant_open_tabs t, jsonb_array_elements(t.items) i " +
    "WHERE t.company_id = $1 AND t.id <> $2 AND i->>'menuItemId' IS NOT NULL GROUP BY 1",
    [companyId, exceptTabId || '00000000-0000-0000-0000-000000000000'])).rows;
  var m = new Map();
  rows.forEach(function (r) { m.set(r.id, Number(r.qty)); });
  return m;
}

// The till's tiles with their stock: { left, low, soldOut } on counted dishes.
async function tileStock(companyId, tiles) {
  var ids = tiles.map(function (t) { return t.id; });
  if (!ids.length) return tiles;
  var rows = (await pool.query('SELECT id, stock_qty, low_stock FROM restaurant_menu_items WHERE id = ANY($1::uuid[]) AND track_stock', [ids])).rows;
  if (!rows.length) return tiles;
  var held = await heldOnTabs(pool, companyId, null);
  var by = new Map(rows.map(function (r) { return [r.id, r]; }));
  tiles.forEach(function (t) {
    var r = by.get(t.id);
    if (!r) return;
    var left = round2(Number(r.stock_qty) - (held.get(t.id) || 0));
    t.stock = { left: left, low: left <= Number(r.low_stock), soldOut: left <= 0 };
  });
  return tiles;
}

// How many of each dish some lines take: the dishes themselves, and a
// combo's dishes (restaurantTillCheck comboParts) as many times as the combo.
function dishesOf(lines) {
  var want = new Map();
  (lines || []).forEach(function (l) {
    if (l.menuItemId) want.set(l.menuItemId, (want.get(l.menuItemId) || 0) + Number(l.qty));
    check().comboParts(l.modifiers).forEach(function (c) { want.set(c.menuItemId, (want.get(c.menuItemId) || 0) + c.qty * Number(l.qty)); });
  });
  return want;
}
function check() { return require('./restaurantTillCheck.service'); }

// Nobody orders more of a counted dish than is left: a new sale, or what an
// open order adds (tabId: the open order; before: what it held already).
async function checkOrder(db, companyId, lines, tabId, before) {
  var want = dishesOf(lines);
  if (!want.size) return;
  var rows = (await db.query('SELECT id, name, stock_qty FROM restaurant_menu_items WHERE id = ANY($1::uuid[]) AND track_stock', [Array.from(want.keys())])).rows;
  if (!rows.length) return;
  var held = await heldOnTabs(db, companyId, tabId);
  var had = dishesOf(before);
  rows.forEach(function (r) {
    var need = want.get(r.id);
    var left = round2(Number(r.stock_qty) - (held.get(r.id) || 0));
    if (need > left && need > (had.get(r.id) || 0)) {
      fail('conflict', left <= 0 ? r.name + ' is sold out: none left in stock.' : 'Only ' + left + ' × ' + r.name + ' left in stock.');
    }
  });
}

async function logMove(db, m) {
  await db.query(
    'INSERT INTO restaurant_stock_moves (company_id, item_type, item_id, kind, delta, qty_after, unit_cost, note, created_by, order_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [m.companyId, m.type, m.id, m.kind, round2(m.delta), round2(m.after), round2(m.unitCost || 0), m.note || '', m.by || null, m.orderId || null]);
}

// A sale takes its counted dishes off the stock, in the sale's transaction;
// one that goes under its "low" figure tells the managers (restaurantPurchasing).
async function deductForSale(client, companyId, orderId, cashierId, lines) {
  var by = dishesOf(lines);
  var low = [];
  for (var e of by) {
    var r = (await client.query(
      'UPDATE restaurant_menu_items SET stock_qty = stock_qty - $2, updated_at = now() WHERE id = $1 AND company_id = $3 AND track_stock RETURNING name, stock_qty, low_stock',
      [e[0], e[1], companyId])).rows[0];
    if (!r) continue;
    await logMove(client, { companyId: companyId, type: 'menu', id: e[0], kind: 'sold', delta: -e[1], after: r.stock_qty, by: cashierId, orderId: orderId });
    low.push({ name: r.name, unit: 'each', before: Number(r.stock_qty) + e[1], after: Number(r.stock_qty), level: Number(r.low_stock) });
  }
  await require('./restaurantPurchasing.service').tellLow(client, companyId, low);
}

// A voided sale puts its counted dishes back.
async function returnForVoid(client, order) {
  // What the sale took off (its own dishes and its combos' dishes), as its stock moves say.
  var rows = (await client.query(
    "SELECT item_id AS id, -sum(delta) AS qty FROM restaurant_stock_moves WHERE order_id = $1 AND item_type = 'menu' AND kind = 'sold' GROUP BY 1", [order.id])).rows;
  for (var i = 0; i < rows.length; i++) {
    var r = (await client.query('UPDATE restaurant_menu_items SET stock_qty = stock_qty + $2, updated_at = now() WHERE id = $1 RETURNING stock_qty', [rows[i].id, Number(rows[i].qty)])).rows[0];
    await logMove(client, { companyId: order.company_id, type: 'menu', id: rows[i].id, kind: 'voided', delta: Number(rows[i].qty), after: r.stock_qty, note: 'Sale ' + order.order_no + ' voided', orderId: order.id });
  }
}

// ── the menu (a manager) ──

function itemOut(r, vars) {
  return {
    id: r.id, name: r.name, category: r.category, price: Number(r.price), active: r.active, source: r.source, favorite: r.favorite,
    thumbUrl: restaurantService.menuThumbUrl(r.id, r.photo_object_key),
    trackStock: r.track_stock, stockQty: Number(r.stock_qty), lowStock: Number(r.low_stock),
    sold30: r.sold30 == null ? 0 : Number(r.sold30), allergens: r.allergens || [],
    sku: r.sku || '', description: r.description || '', itemType: r.item_type || '', containsAlcohol: r.contains_alcohol == null ? null : r.contains_alcohol,
    variations: vars || []
  };
}
// Square's item types (its item library), for the item library downloaded in its layout.
var ITEM_TYPES = ['Physical good', 'Prepared food and beverage', 'Service', 'Digital', 'Event', 'Donation', 'Membership'];

async function menu(companyId) {
  var rows = (await pool.query(
    'SELECT m.*, (SELECT coalesce(sum(oi.qty), 0) FROM restaurant_order_items oi JOIN restaurant_orders o ON o.id = oi.order_id ' +
    "  WHERE oi.menu_item_id = m.id AND o.status = 'completed' AND o.created_at > now() - interval '30 days') AS sold30 " +
    'FROM restaurant_menu_items m WHERE m.company_id = $1 ORDER BY m.category, m.name', [companyId])).rows;
  var vars = rows.length ? (await pool.query('SELECT * FROM restaurant_menu_item_variations WHERE menu_item_id = ANY($1::uuid[]) ORDER BY sort_order, created_at',
    [rows.map(function (r) { return r.id; })])).rows : [];
  var byItem = new Map();
  vars.forEach(function (v) { if (!byItem.has(v.menu_item_id)) byItem.set(v.menu_item_id, []); byItem.get(v.menu_item_id).push({ id: v.id, name: v.name, price: Number(v.price), sku: v.sku || '' }); });
  var combos = await combosOf(rows.map(function (r) { return r.id; }));
  var items = rows.map(function (r) { return Object.assign(itemOut(r, byItem.get(r.id)), { combo: combos.get(r.id) || [], supplierId: r.supplier_id || null }); });
  var categories = Array.from(new Set(items.map(function (i) { return i.category; }))).sort();
  return { items: items, categories: categories, groups: await groups(companyId) };
}

// ── add-ons (migration 0168): groups of choices, put on dishes ──
async function groups(companyId) {
  var gs = (await pool.query('SELECT * FROM restaurant_modifier_groups WHERE company_id = $1 ORDER BY sort_order, name', [companyId])).rows;
  if (!gs.length) return [];
  var ids = gs.map(function (g) { return g.id; });
  var opts = (await pool.query('SELECT * FROM restaurant_modifiers WHERE group_id = ANY($1::uuid[]) ORDER BY sort_order, name', [ids])).rows;
  var links = (await pool.query('SELECT group_id, menu_item_id FROM restaurant_menu_item_modifier_groups WHERE group_id = ANY($1::uuid[])', [ids])).rows;
  return gs.map(function (g) {
    return {
      id: g.id, name: g.name, minPick: g.min_pick, maxPick: g.max_pick, active: g.active,
      options: opts.filter(function (o) { return o.group_id === g.id; }).map(function (o) { return { id: o.id, name: o.name, price: Number(o.price), active: o.active }; }),
      itemIds: links.filter(function (l) { return l.group_id === g.id; }).map(function (l) { return l.menu_item_id; })
    };
  });
}
// Add or change a group: { id?, name, minPick, maxPick (none = any), active,
// options: [{ id?, name, price, active, remove? }], itemIds: the dishes
// that take it (all of them: the list replaces the one before).
async function saveGroup(companyId, manager, p) {
  p = p || {};
  var name = text(p.name, 60);
  if (!name) fail('invalid', 'Give the add-ons a name, e.g. Pick a side.');
  var min = Math.max(0, Math.floor(Number(p.minPick) || 0));
  var max = p.maxPick === null || p.maxPick === undefined || p.maxPick === '' || Number(p.maxPick) === 0 ? null : Math.floor(Number(p.maxPick));
  if (max !== null && !(max >= 1)) fail('invalid', name + ': "at most" is a number from 1, or empty for any.');
  if (max !== null && min > max) fail('invalid', name + ': "at least" is more than "at most".');
  var options = (Array.isArray(p.options) ? p.options : []).filter(function (o) { return o && !o.remove; });
  if (!options.length) fail('invalid', name + ': add at least one choice.');
  if (min > options.filter(function (o) { return o.active !== false; }).length) fail('invalid', name + ': there are fewer choices than must be picked.');
  return withTransaction(async function (client) {
    var g;
    if (p.id) {
      g = (await client.query('UPDATE restaurant_modifier_groups SET name = $3, min_pick = $4, max_pick = $5, active = $6 WHERE id = $1 AND company_id = $2 RETURNING *',
        [p.id, companyId, name, min, max, p.active !== false])).rows[0];
      if (!g) fail('notfound', 'Those add-ons are no longer there.');
    } else {
      g = (await client.query('INSERT INTO restaurant_modifier_groups (company_id, name, min_pick, max_pick, active, sort_order) ' +
        'VALUES ($1,$2,$3,$4,$5,(SELECT coalesce(max(sort_order), 0) + 1 FROM restaurant_modifier_groups WHERE company_id = $1)) RETURNING *',
        [companyId, name, min, max, p.active !== false])).rows[0];
    }
    var keep = [];
    var all = Array.isArray(p.options) ? p.options : [];
    for (var i = 0; i < all.length; i++) {
      var o = all[i] || {};
      if (o.remove) { if (o.id) await client.query('DELETE FROM restaurant_modifiers WHERE id = $1 AND group_id = $2', [o.id, g.id]); continue; }
      var oname = text(o.name, 60);
      if (!oname) fail('invalid', name + ': give each choice a name.');
      var price = priceOf(o.price || 0, oname);
      if (o.id) {
        var up = (await client.query('UPDATE restaurant_modifiers SET name = $3, price = $4, active = $5, sort_order = $6 WHERE id = $1 AND group_id = $2 RETURNING id', [o.id, g.id, oname, price, o.active !== false, i])).rows[0];
        if (up) { keep.push(up.id); continue; }
      }
      keep.push((await client.query('INSERT INTO restaurant_modifiers (group_id, name, price, active, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id', [g.id, oname, price, o.active !== false, i])).rows[0].id);
    }
    if (Array.isArray(p.itemIds)) {
      var mine = (await client.query('SELECT id FROM restaurant_menu_items WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, p.itemIds.filter(function (x) { return /^[0-9a-f-]{36}$/i.test(String(x)); })])).rows.map(function (r) { return r.id; });
      await client.query('DELETE FROM restaurant_menu_item_modifier_groups WHERE group_id = $1', [g.id]);
      for (var j = 0; j < mine.length; j++) await client.query('INSERT INTO restaurant_menu_item_modifier_groups (menu_item_id, group_id, sort_order) VALUES ($1,$2,$3)', [mine[j], g.id, g.sort_order]);
    }
    var what = (p.id ? 'Changed the add-ons ' : 'Added the add-ons ') + name;
    await audit(client, who(manager), p.id ? 'restaurant.menu.update' : 'restaurant.menu.create', 'restaurant_modifier_group', g.id, what + '.');
    await activity.log(client, { companyId: companyId, employeeId: manager.id, app: 'settings', action: 'settings.menu', summary: what + '.', refType: 'modifier_group', refId: g.id });
    return g.id;
  });
}
async function removeGroup(companyId, manager, id) {
  var g = (await pool.query('DELETE FROM restaurant_modifier_groups WHERE id = $1 AND company_id = $2 RETURNING name', [id, companyId])).rows[0];
  if (!g) fail('notfound', 'Those add-ons are no longer there.');
  await audit(pool, who(manager), 'restaurant.menu.delete', 'restaurant_modifier_group', id, 'Removed the add-ons ' + g.name + '.');
  await activity.log(pool, { companyId: companyId, employeeId: manager.id, app: 'settings', action: 'settings.menu', summary: 'Removed the add-ons ' + g.name + '.', refType: 'modifier_group', refId: id });
  return id;
}

async function itemOfCompany(db, companyId, id) {
  var r = (await db.query('SELECT * FROM restaurant_menu_items WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, companyId])).rows[0];
  if (!r) fail('notfound', 'That dish is not on this restaurant\'s menu.');
  return r;
}
function priceOf(v, name) {
  var n = Math.round(Number(v) * 100) / 100;
  if (!(n >= 0 && n < 1000000)) fail('invalid', 'Give ' + (name || 'it') + ' a price.');
  return n;
}

// Add or change a dish: { id?, name, category, price, active, trackStock,
// lowStock, stockQty (when stock starts being counted), variations: [{ id?,
// name, price, remove? }] }.
async function saveItem(companyId, manager, p) {
  p = p || {};
  var name = text(p.name, 100);
  if (!name) fail('invalid', 'Give the dish a name.');
  var category = text(p.category, 40) || 'General';
  var price = priceOf(p.price, name);
  var low = Math.max(0, round2(p.lowStock));
  // What it contains, for guests with an allergy (restaurantTillTimes ALLERGENS).
  var allergens = require('./restaurantTillTimes.service').cleanAllergens(p.allergens);
  return withTransaction(async function (client) {
    var clash = (await client.query('SELECT id FROM restaurant_menu_items WHERE company_id = $1 AND lower(name) = lower($2) AND id <> $3',
      [companyId, name, p.id || '00000000-0000-0000-0000-000000000000'])).rows[0];
    if (clash) fail('invalid', 'There is already a dish called "' + name + '" on the menu.');
    var row, before = null;
    if (p.id) {
      before = await itemOfCompany(client, companyId, p.id);
      row = (await client.query(
        'UPDATE restaurant_menu_items SET name = $2, category = $3, price = $4, active = $5, track_stock = $6, low_stock = $7, allergens = $8, updated_at = now() WHERE id = $1 RETURNING *',
        [p.id, name, category, price, p.active !== false, !!p.trackStock, low, p.allergens === undefined ? before.allergens || [] : allergens])).rows[0];
    } else {
      row = (await client.query(
        'INSERT INTO restaurant_menu_items (company_id, name, category, price, active, track_stock, low_stock, allergens) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [companyId, name, category, price, p.active !== false, !!p.trackStock, low, allergens])).rows[0];
    }
    // Its SKU, description, item type and whether it contains alcohol
    // (Square's item library, migration 0174): as they were unless sent.
    var itemType = p.itemType === undefined ? (before ? before.item_type : '') : String(p.itemType || '');
    if (itemType && ITEM_TYPES.indexOf(itemType) < 0) fail('invalid', 'Pick the item type from the list.');
    row = (await client.query('UPDATE restaurant_menu_items SET sku = $2, description = $3, item_type = $4, contains_alcohol = $5 WHERE id = $1 RETURNING *',
      [row.id, p.sku === undefined ? (before ? before.sku : '') : text(p.sku, 80), p.description === undefined ? (before ? before.description : '') : String(p.description || '').trim().slice(0, 4000),
        itemType, p.containsAlcohol === undefined ? (before ? before.contains_alcohol : null) : (p.containsAlcohol === null ? null : !!p.containsAlcohol)])).rows[0];
    // Starting to count it: its first figure.
    if (row.track_stock && (!before || !before.track_stock) && p.stockQty !== undefined && p.stockQty !== '') {
      var qty = Math.max(0, round2(p.stockQty));
      row = (await client.query('UPDATE restaurant_menu_items SET stock_qty = $2 WHERE id = $1 RETURNING *', [row.id, qty])).rows[0];
      await logMove(client, { companyId: companyId, type: 'menu', id: row.id, kind: 'count', delta: qty - (before ? Number(before.stock_qty) : 0), after: qty, by: manager.id, note: 'Stock counting started' });
    }
    var vars = Array.isArray(p.variations) ? p.variations : [];
    for (var i = 0; i < vars.length; i++) {
      var v = vars[i] || {};
      if (v.id && v.remove) { await client.query('DELETE FROM restaurant_menu_item_variations WHERE id = $1 AND menu_item_id = $2', [v.id, row.id]); continue; }
      if (v.remove) continue;
      var vname = text(v.name, 60);
      if (!vname) fail('invalid', 'Give each size of ' + name + ' a name, e.g. Large.');
      var vprice = priceOf(v.price, name + ' — ' + vname);
      var vsku = v.sku === undefined ? undefined : text(v.sku, 80);
      if (v.id) await client.query('UPDATE restaurant_menu_item_variations SET name = $3, price = $4, sort_order = $5, sku = coalesce($6, sku) WHERE id = $1 AND menu_item_id = $2', [v.id, row.id, vname, vprice, i, vsku === undefined ? null : vsku]);
      else await client.query('INSERT INTO restaurant_menu_item_variations (menu_item_id, name, price, sort_order, sku) VALUES ($1,$2,$3,$4,$5)', [row.id, vname, vprice, i, vsku || '']);
    }
    // A combo's slots (migration 0183), replaced when sent; who it is bought from (purchase orders).
    if (p.combo !== undefined) await saveCombo(client, companyId, row, p.combo);
    if (p.supplierId !== undefined) await client.query('UPDATE restaurant_menu_items SET supplier_id = (SELECT id FROM restaurant_suppliers WHERE id = $2 AND company_id = $3) WHERE id = $1',
      [row.id, p.supplierId || null, companyId]);
    var what = !before ? 'Added ' + name + ' to the menu' : Number(before.price) !== price ? 'Changed ' + name + ': price ' + Number(before.price).toFixed(2) + ' → ' + price.toFixed(2) : 'Changed ' + name;
    await audit(client, who(manager), before ? 'restaurant.menu.update' : 'restaurant.menu.create', 'restaurant_menu_item', row.id, what + '.');
    await activity.log(client, { companyId: companyId, employeeId: manager.id, app: 'settings', action: 'settings.menu', summary: what + '.', refType: 'menu_item', refId: row.id });
    return row.id;
  });
}

// A combo: its slots, each with the dishes to pick from and what each adds
// to the price — [{ name, minPick, maxPick, options: [{ menuItemId,
// variationId, extra }] }]; none, and it is a dish like any other.
async function saveCombo(client, companyId, row, slots) {
  var list = Array.isArray(slots) ? slots : [];
  if (list.length > 8) fail('invalid', 'A combo has at most 8 parts.');
  if (list.length && (await client.query('SELECT 1 FROM restaurant_combo_options WHERE menu_item_id = $1 LIMIT 1', [row.id])).rows[0]) {
    fail('invalid', row.name + ' is a choice in another combo, so it cannot be a combo itself.');
  }
  await client.query('DELETE FROM restaurant_combo_slots WHERE menu_item_id = $1', [row.id]);
  for (var i = 0; i < list.length; i++) {
    var s = list[i] || {};
    var name = text(s.name, 40);
    if (!name) fail('invalid', 'Give each part of the combo a name, e.g. A main.');
    var max = Math.round(Number(s.maxPick) || 1), min = s.minPick === undefined ? 1 : Math.round(Number(s.minPick));
    if (!(max >= 1 && max <= 10) || !(min >= 0 && min <= max)) fail('invalid', name + ': pick between 0 and 10, and at least no more than at most.');
    var opts = Array.isArray(s.options) ? s.options : [];
    if (!opts.length) fail('invalid', name + ': add the dishes to pick from.');
    if (opts.length > 40) fail('invalid', name + ': at most 40 dishes to pick from.');
    var slot = (await client.query('INSERT INTO restaurant_combo_slots (menu_item_id, name, min_pick, max_pick, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id', [row.id, name, min, max, i])).rows[0].id;
    for (var j = 0; j < opts.length; j++) {
      var o = opts[j] || {};
      var dish = (await client.query('SELECT id, name, (SELECT count(*) FROM restaurant_combo_slots s WHERE s.menu_item_id = m.id)::int AS slots FROM restaurant_menu_items m WHERE id = $1 AND company_id = $2', [o.menuItemId, companyId])).rows[0];
      if (!dish) fail('invalid', name + ': one of its dishes is not on this menu.');
      if (dish.id === row.id || dish.slots > 0) fail('invalid', name + ': a combo is made of dishes, not of combos.');
      var vid = o.variationId || null;
      if (vid && !(await client.query('SELECT 1 FROM restaurant_menu_item_variations WHERE id = $1 AND menu_item_id = $2', [vid, dish.id])).rows[0]) fail('invalid', name + ': ' + dish.name + ' has no such size.');
      var extra = Math.round(Number(o.extra || 0) * 100) / 100;
      if (!(extra >= 0 && extra < 100000)) fail('invalid', name + ': what ' + dish.name + ' adds to the price is out of range.');
      await client.query('INSERT INTO restaurant_combo_options (slot_id, menu_item_id, variation_id, extra, sort_order) VALUES ($1,$2,$3,$4,$5)', [slot, dish.id, vid, extra, j]);
    }
  }
}
// Each combo's slots, for the menu editor: Map(menuItemId → [{ id, name, minPick, maxPick, options }]).
async function combosOf(itemIds) {
  var out = new Map();
  if (!itemIds.length) return out;
  var slots = (await pool.query('SELECT * FROM restaurant_combo_slots WHERE menu_item_id = ANY($1::uuid[]) ORDER BY sort_order', [itemIds])).rows;
  if (!slots.length) return out;
  var opts = (await pool.query(
    'SELECT o.*, m.name AS item, v.name AS size FROM restaurant_combo_options o JOIN restaurant_menu_items m ON m.id = o.menu_item_id ' +
    'LEFT JOIN restaurant_menu_item_variations v ON v.id = o.variation_id WHERE o.slot_id = ANY($1::uuid[]) ORDER BY o.sort_order', [slots.map(function (s) { return s.id; })])).rows;
  slots.forEach(function (s) {
    if (!out.has(s.menu_item_id)) out.set(s.menu_item_id, []);
    out.get(s.menu_item_id).push({ id: s.id, name: s.name, minPick: s.min_pick, maxPick: s.max_pick,
      options: opts.filter(function (o) { return o.slot_id === s.id; }).map(function (o) { return { menuItemId: o.menu_item_id, variationId: o.variation_id, extra: Number(o.extra), name: o.size ? o.item + ' — ' + o.size : o.item }; }) });
  });
  return out;
}

// Off the menu for good: past sales keep its name.
async function removeItem(companyId, manager, id) {
  var row = await itemOfCompany(pool, companyId, id);
  await pool.query('DELETE FROM restaurant_stock_moves WHERE item_type = $1 AND item_id = $2', ['menu', id]);
  await pool.query('DELETE FROM restaurant_menu_items WHERE id = $1', [id]);
  if (row.photo_object_key) await fileStore.del(row.photo_object_key).catch(function () {});
  await audit(pool, who(manager), 'restaurant.menu.delete', 'restaurant_menu_item', id, 'Removed ' + row.name + ' from the menu.');
  await activity.log(pool, { companyId: companyId, employeeId: manager.id, app: 'settings', action: 'settings.menu', summary: 'Removed ' + row.name + ' from the menu.', refType: 'menu_item', refId: id });
  return id;
}

// ── the stock (a manager, or whoever's role may count it) ──

var TABLES = { menu: 'restaurant_menu_items', supply: 'restaurant_supplies', ingredient: 'restaurant_ingredients' };
var KINDS = ['count', 'received', 'wasted', 'used'];

async function stock(companyId) {
  var held = await heldOnTabs(pool, companyId, null);
  var menuRows = (await pool.query('SELECT id, name, category, stock_qty, low_stock, active FROM restaurant_menu_items WHERE company_id = $1 AND track_stock ORDER BY name', [companyId])).rows;
  var supplies = (await pool.query('SELECT id, name, category, unit, stock_qty, reorder_level, unit_cost FROM restaurant_supplies WHERE company_id = $1 AND active ORDER BY name', [companyId])).rows;
  var ingredients = (await pool.query('SELECT id, name, unit, stock_qty, reorder_level, unit_cost, expiry_date FROM restaurant_ingredients WHERE company_id = $1 AND active ORDER BY name', [companyId])).rows;
  var last = (await pool.query(
    "SELECT DISTINCT ON (item_id) item_id, created_at, kind FROM restaurant_stock_moves WHERE company_id = $1 AND kind IN ('count', 'received') ORDER BY item_id, created_at DESC", [companyId])).rows;
  var lastBy = new Map(last.map(function (r) { return [r.item_id, { at: r.created_at, kind: r.kind }]; }));
  function out(type, r, unit, low) {
    var qty = Number(r.stock_qty);
    return {
      type: type, id: r.id, name: r.name, category: r.category || '', unit: unit, qty: qty, low: Number(low), isLow: qty <= Number(low),
      held: type === 'menu' ? (held.get(r.id) || 0) : 0, active: r.active !== false, unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      expiryDate: r.expiry_date || null, lastCounted: lastBy.get(r.id) || null
    };
  }
  return {
    menu: menuRows.map(function (r) { return out('menu', r, 'each', r.low_stock); }),
    supplies: supplies.map(function (r) { return out('supply', r, r.unit, r.reorder_level); }),
    ingredients: ingredients.map(function (r) { return out('ingredient', r, r.unit, r.reorder_level); })
  };
}

// { type: 'menu' | 'supply' | 'ingredient', id, kind: 'count' (the new
// figure) | 'received' (+) | 'wasted' | 'used' (−), qty, note }.
async function move(companyId, by, p) {
  p = p || {};
  var table = TABLES[p.type];
  if (!table) fail('invalid', 'Pick what to count.');
  if (KINDS.indexOf(p.kind) < 0) fail('invalid', 'Pick what happened: counted, came in, thrown away or used.');
  var qty = Number(p.qty);
  if (!(Number.isFinite(qty) && qty >= 0 && qty < 1e9)) fail('invalid', 'Type how many, 0 or more.');
  if (p.kind !== 'count' && qty === 0) fail('invalid', 'Type how many.');
  var note = text(p.note, 200);
  return withTransaction(async function (client) {
    var cur = (await client.query('SELECT * FROM ' + table + ' WHERE id = $1 AND company_id = $2 FOR UPDATE', [p.id, companyId])).rows[0];
    if (!cur) fail('notfound', 'That item is not this restaurant\'s.');
    if (p.type === 'menu' && !cur.track_stock) fail('invalid', cur.name + ' does not count its stock. Turn it on in the menu first.');
    var delta = p.kind === 'count' ? qty - Number(cur.stock_qty) : p.kind === 'received' ? qty : -qty;
    var after = round2(Number(cur.stock_qty) + delta);
    if (after < 0 && p.type !== 'menu') fail('invalid', 'Only ' + Number(cur.stock_qty) + ' ' + (cur.unit || '') + ' of ' + cur.name + ' in stock.');
    await client.query('UPDATE ' + table + ' SET stock_qty = $2, updated_at = now() WHERE id = $1', [cur.id, after]);
    await logMove(client, { companyId: companyId, type: p.type, id: cur.id, kind: p.kind, delta: delta, after: after, unitCost: cur.unit_cost, note: note, by: by.id });
    await require('./restaurantPurchasing.service').tellLow(client, companyId, [{ name: cur.name, unit: cur.unit || 'each', before: Number(cur.stock_qty), after: after, level: Number(p.type === 'menu' ? cur.low_stock : cur.reorder_level) }]);
    var summary = { count: 'Counted ', received: 'Stock came in: ', wasted: 'Thrown away: ', used: 'Used: ' }[p.kind] + cur.name + ' ' +
      (p.kind === 'count' ? after : (delta > 0 ? '+' : '') + round2(delta) + ' (now ' + after + ')') + (note ? ' · ' + note : '') + '.';
    await audit(client, who(by), 'restaurant.' + p.type + '.stock', 'restaurant_' + (p.type === 'menu' ? 'menu_item' : p.type), cur.id, summary);
    await activity.log(client, { companyId: companyId, employeeId: by.id, app: 'till', action: 'till.stock', summary: summary, refType: p.type, refId: cur.id });
    return { id: cur.id, qty: after };
  });
}

// A barcode scanned at the till that no dish has yet, given to one (or one
// of its sizes): { code, menuItemId, variationId }. Its SKU from now on.
var BARCODE = /^[A-Za-z0-9._\-]{3,64}$/;
async function linkBarcode(companyId, by, p) {
  p = p || {};
  var code = String(p.code || '').trim();
  if (!BARCODE.test(code)) fail('invalid', 'That barcode cannot be read: scan it again.');
  return withTransaction(async function (client) {
    var dish = await itemOfCompany(client, companyId, p.menuItemId);
    var on = (await client.query(
      "SELECT m.name, v.name AS size FROM restaurant_menu_items m LEFT JOIN restaurant_menu_item_variations v ON v.menu_item_id = m.id AND lower(v.sku) = lower($2) " +
      'WHERE m.company_id = $1 AND (lower(m.sku) = lower($2) OR v.id IS NOT NULL) LIMIT 1', [companyId, code])).rows[0];
    if (on) fail('conflict', 'That barcode is on ' + on.name + (on.size ? ' — ' + on.size : '') + ' already.');
    var what = dish.name;
    if (p.variationId) {
      var v = (await client.query('UPDATE restaurant_menu_item_variations SET sku = $3 WHERE id = $1 AND menu_item_id = $2 RETURNING name', [p.variationId, dish.id, code])).rows[0];
      if (!v) fail('invalid', dish.name + ' has no such size.');
      what += ' — ' + v.name;
    } else {
      await client.query('UPDATE restaurant_menu_items SET sku = $2, updated_at = now() WHERE id = $1', [dish.id, code]);
    }
    var summary = 'Barcode ' + code + ' given to ' + what + '.';
    await audit(client, who(by), 'restaurant.menu.barcode', 'restaurant_menu_item', dish.id, summary);
    await activity.log(client, { companyId: companyId, employeeId: by.id, app: 'till', action: 'till.barcode', summary: summary, refType: 'menu_item', refId: dish.id });
    return { menuItemId: dish.id, variationId: p.variationId || null, code: code };
  });
}

async function history(companyId, type, id) {
  if (!TABLES[type]) fail('invalid', 'Pick an item.');
  var rows = (await pool.query(
    "SELECT m.*, e.first_name || ' ' || e.last_name AS by_name, o.order_no FROM restaurant_stock_moves m LEFT JOIN employees e ON e.id = m.created_by " +
    'LEFT JOIN restaurant_orders o ON o.id = m.order_id WHERE m.company_id = $1 AND m.item_type = $2 AND m.item_id = $3 ORDER BY m.created_at DESC LIMIT 100',
    [companyId, type, id])).rows;
  return rows.map(function (r) {
    return { id: r.id, kind: r.kind, delta: Number(r.delta), after: Number(r.qty_after), note: r.note, at: r.created_at, by: r.by_name || null, orderNo: r.order_no || null };
  });
}

module.exports = {
  groups: groups, saveGroup: saveGroup, removeGroup: removeGroup,
  heldOnTabs: heldOnTabs, tileStock: tileStock, checkOrder: checkOrder, deductForSale: deductForSale, returnForVoid: returnForVoid,
  menu: menu, saveItem: saveItem, removeItem: removeItem, stock: stock, move: move, history: history, linkBarcode: linkBarcode, logMove: logMove, ITEM_TYPES: ITEM_TYPES
};
