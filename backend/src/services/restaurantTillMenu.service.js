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

// Nobody orders more of a counted dish than is left: a new sale, or what an
// open order adds (tabId: the open order; before: what it held already).
async function checkOrder(db, companyId, lines, tabId, before) {
  var want = new Map();
  lines.forEach(function (l) { if (l.menuItemId) want.set(l.menuItemId, (want.get(l.menuItemId) || 0) + Number(l.qty)); });
  if (!want.size) return;
  var rows = (await db.query('SELECT id, name, stock_qty FROM restaurant_menu_items WHERE id = ANY($1::uuid[]) AND track_stock', [Array.from(want.keys())])).rows;
  if (!rows.length) return;
  var held = await heldOnTabs(db, companyId, tabId);
  var had = new Map();
  (before || []).forEach(function (l) { if (l.menuItemId) had.set(l.menuItemId, (had.get(l.menuItemId) || 0) + Number(l.qty)); });
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

// A sale takes its counted dishes off the stock, in the sale's transaction.
async function deductForSale(client, companyId, orderId, cashierId, lines) {
  var by = new Map();
  lines.forEach(function (l) { if (l.menuItemId) by.set(l.menuItemId, (by.get(l.menuItemId) || 0) + Number(l.qty)); });
  for (var e of by) {
    var r = (await client.query(
      'UPDATE restaurant_menu_items SET stock_qty = stock_qty - $2, updated_at = now() WHERE id = $1 AND company_id = $3 AND track_stock RETURNING stock_qty',
      [e[0], e[1], companyId])).rows[0];
    if (r) await logMove(client, { companyId: companyId, type: 'menu', id: e[0], kind: 'sold', delta: -e[1], after: r.stock_qty, by: cashierId, orderId: orderId });
  }
}

// A voided sale puts its counted dishes back.
async function returnForVoid(client, order) {
  var rows = (await client.query(
    'SELECT oi.menu_item_id AS id, sum(oi.qty) AS qty FROM restaurant_order_items oi JOIN restaurant_menu_items m ON m.id = oi.menu_item_id AND m.track_stock ' +
    'WHERE oi.order_id = $1 GROUP BY 1', [order.id])).rows;
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
    sold30: r.sold30 == null ? 0 : Number(r.sold30),
    variations: vars || []
  };
}

async function menu(companyId) {
  var rows = (await pool.query(
    'SELECT m.*, (SELECT coalesce(sum(oi.qty), 0) FROM restaurant_order_items oi JOIN restaurant_orders o ON o.id = oi.order_id ' +
    "  WHERE oi.menu_item_id = m.id AND o.status = 'completed' AND o.created_at > now() - interval '30 days') AS sold30 " +
    'FROM restaurant_menu_items m WHERE m.company_id = $1 ORDER BY m.category, m.name', [companyId])).rows;
  var vars = rows.length ? (await pool.query('SELECT * FROM restaurant_menu_item_variations WHERE menu_item_id = ANY($1::uuid[]) ORDER BY sort_order, created_at',
    [rows.map(function (r) { return r.id; })])).rows : [];
  var byItem = new Map();
  vars.forEach(function (v) { if (!byItem.has(v.menu_item_id)) byItem.set(v.menu_item_id, []); byItem.get(v.menu_item_id).push({ id: v.id, name: v.name, price: Number(v.price) }); });
  var items = rows.map(function (r) { return itemOut(r, byItem.get(r.id)); });
  var categories = Array.from(new Set(items.map(function (i) { return i.category; }))).sort();
  return { items: items, categories: categories };
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
  return withTransaction(async function (client) {
    var clash = (await client.query('SELECT id FROM restaurant_menu_items WHERE company_id = $1 AND lower(name) = lower($2) AND id <> $3',
      [companyId, name, p.id || '00000000-0000-0000-0000-000000000000'])).rows[0];
    if (clash) fail('invalid', 'There is already a dish called "' + name + '" on the menu.');
    var row, before = null;
    if (p.id) {
      before = await itemOfCompany(client, companyId, p.id);
      row = (await client.query(
        'UPDATE restaurant_menu_items SET name = $2, category = $3, price = $4, active = $5, track_stock = $6, low_stock = $7, updated_at = now() WHERE id = $1 RETURNING *',
        [p.id, name, category, price, p.active !== false, !!p.trackStock, low])).rows[0];
    } else {
      row = (await client.query(
        'INSERT INTO restaurant_menu_items (company_id, name, category, price, active, track_stock, low_stock) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [companyId, name, category, price, p.active !== false, !!p.trackStock, low])).rows[0];
    }
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
      if (v.id) await client.query('UPDATE restaurant_menu_item_variations SET name = $3, price = $4, sort_order = $5 WHERE id = $1 AND menu_item_id = $2', [v.id, row.id, vname, vprice, i]);
      else await client.query('INSERT INTO restaurant_menu_item_variations (menu_item_id, name, price, sort_order) VALUES ($1,$2,$3,$4)', [row.id, vname, vprice, i]);
    }
    var what = !before ? 'Added ' + name + ' to the menu' : Number(before.price) !== price ? 'Changed ' + name + ': price ' + Number(before.price).toFixed(2) + ' → ' + price.toFixed(2) : 'Changed ' + name;
    await audit(client, who(manager), before ? 'restaurant.menu.update' : 'restaurant.menu.create', 'restaurant_menu_item', row.id, what + '.');
    await activity.log(client, { companyId: companyId, employeeId: manager.id, app: 'settings', action: 'settings.menu', summary: what + '.', refType: 'menu_item', refId: row.id });
    return row.id;
  });
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
    var summary = { count: 'Counted ', received: 'Stock came in: ', wasted: 'Thrown away: ', used: 'Used: ' }[p.kind] + cur.name + ' ' +
      (p.kind === 'count' ? after : (delta > 0 ? '+' : '') + round2(delta) + ' (now ' + after + ')') + (note ? ' · ' + note : '') + '.';
    await audit(client, who(by), 'restaurant.' + p.type + '.stock', 'restaurant_' + (p.type === 'menu' ? 'menu_item' : p.type), cur.id, summary);
    await activity.log(client, { companyId: companyId, employeeId: by.id, app: 'till', action: 'till.stock', summary: summary, refType: p.type, refId: cur.id });
    return { id: cur.id, qty: after };
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
  heldOnTabs: heldOnTabs, tileStock: tileStock, checkOrder: checkOrder, deductForSale: deductForSale, returnForVoid: returnForVoid,
  menu: menu, saveItem: saveItem, removeItem: removeItem, stock: stock, move: move, history: history
};
