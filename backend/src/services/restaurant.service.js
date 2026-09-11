var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var storage = require('../lib/storage');

var MAX_MENU_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB — a food photo, not a scanned document

// Restaurant module, Phase 1 (inventory): Star Bar Restaurant and Bamboo
// Garden each get their own sellable menu (restaurant_menu_items) and two
// separate stock trackers (restaurant_supplies for non-food items like
// glassware/napkins, restaurant_ingredients for food, which alone carries
// an expiry date). Scoped by company_id, same pattern as departments —
// not hardcoded to the two companies that exist today, so a future third
// restaurant needs no code change, just a new company row.
//
// Stock adjustment mirrors catalog.service.js's adjustStock() exactly: one
// atomic UPDATE ... WHERE stock_qty + $delta >= 0 (can't race past zero),
// audit-logged with the delta and reason rather than a separate ledger
// table — same choice Catalog and Tool Room both already made.

async function requireCompany(companyId) {
  var res = await pool.query('SELECT id, name FROM companies WHERE id = $1', [companyId]);
  if (!res.rows[0]) fail('notfound', 'Company not found.');
  return res.rows[0];
}

// ── menu items ───────────────────────────────────────────────────────────

function rowToMenuItem(r) {
  return {
    id: r.id, companyId: r.company_id, name: r.name, category: r.category,
    price: Number(r.price), active: r.active, source: r.source,
    photoUrl: r.photo_object_key ? '/api/menu-photos/' + r.id : null
  };
}

async function listMenuItems(ctx, companyId) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  var args = [];
  var where = '';
  if (companyId) { args.push(companyId); where = 'WHERE company_id = $1'; }
  var res = await pool.query('SELECT * FROM restaurant_menu_items ' + where + ' ORDER BY category, name', args);
  return res.rows.map(rowToMenuItem);
}

async function createMenuItem(ctx, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var company = await requireCompany(p.companyId);
  var name = V.text(p.name, 'Name', 100);
  var category = V.text(p.category || 'General', 'Category', 40);
  var price = Math.max(0, Number(p.price) || 0);

  var res = await pool.query(
    "INSERT INTO restaurant_menu_items (company_id, name, category, price) VALUES ($1,$2,$3,$4) RETURNING *",
    [company.id, name, category, price]
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'restaurant.menu.create', 'restaurant_menu_item', item.id, 'Added ' + item.name + ' to ' + company.name + "'s menu.");
  return rowToMenuItem(item);
}

async function updateMenuItem(ctx, id, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var existing = await pool.query('SELECT * FROM restaurant_menu_items WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Menu item not found.');

  var name = V.text(p.name, 'Name', 100);
  var category = V.text(p.category || 'General', 'Category', 40);
  var price = Math.max(0, Number(p.price) || 0);

  var res = await pool.query(
    'UPDATE restaurant_menu_items SET name = $1, category = $2, price = $3, updated_at = now() WHERE id = $4 RETURNING *',
    [name, category, price, id]
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'restaurant.menu.update', 'restaurant_menu_item', item.id, 'Updated ' + item.name + '.');
  return rowToMenuItem(item);
}

async function setMenuItemActive(ctx, id, active) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var res = await pool.query('UPDATE restaurant_menu_items SET active = $1, updated_at = now() WHERE id = $2 RETURNING *', [!!active, id]);
  if (!res.rows[0]) fail('notfound', 'Menu item not found.');
  var item = res.rows[0];
  await audit(pool, ctx, 'restaurant.menu.active', 'restaurant_menu_item', item.id, (active ? 'Enabled ' : 'Disabled ') + item.name + '.');
  return rowToMenuItem(item);
}

async function removeMenuItem(ctx, id) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var existing = await pool.query('SELECT * FROM restaurant_menu_items WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Menu item not found.');
  await pool.query('DELETE FROM restaurant_menu_items WHERE id = $1', [id]);
  if (existing.rows[0].photo_object_key) { try { await storage.deleteFile(existing.rows[0].photo_object_key); } catch (e) { /* orphaned object, not worth failing the delete over */ } }
  await audit(pool, ctx, 'restaurant.menu.delete', 'restaurant_menu_item', id, 'Removed ' + existing.rows[0].name + ' from the menu.');
  return true;
}

// A photo per menu item, for the POS till grid — same R2 storage the
// Documents module and employee ID documents already use (migration
// 0045). The uploaded file replaces any existing photo (old object
// deleted, not left orphaned); see routes/menuPhotos.routes.js for how
// this gets served back out as a plain, unauthenticated <img src>.
async function setMenuItemPhoto(ctx, id, file) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  if (!storage.configured) fail('invalid', 'Photo storage is not configured on the server.');
  if (!file) fail('invalid', 'Choose a photo to upload.');
  if (file.size > MAX_MENU_PHOTO_BYTES) fail('invalid', 'Photo must be smaller than 5MB.');
  var existing = await pool.query('SELECT * FROM restaurant_menu_items WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Menu item not found.');

  var key = await storage.uploadFile(file.originalname, file.buffer, file.mimetype);
  var res = await pool.query(
    'UPDATE restaurant_menu_items SET photo_object_key = $1, photo_file_name = $2, updated_at = now() WHERE id = $3 RETURNING *',
    [key, file.originalname, id]
  );
  var oldKey = existing.rows[0].photo_object_key;
  if (oldKey) { try { await storage.deleteFile(oldKey); } catch (e) { /* best-effort cleanup */ } }
  var item = res.rows[0];
  await audit(pool, ctx, 'restaurant.menu.photo', 'restaurant_menu_item', id, 'Updated photo for ' + item.name + '.');
  return rowToMenuItem(item);
}

async function removeMenuItemPhoto(ctx, id) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var existing = await pool.query('SELECT * FROM restaurant_menu_items WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Menu item not found.');
  if (existing.rows[0].photo_object_key) { try { await storage.deleteFile(existing.rows[0].photo_object_key); } catch (e) { /* best-effort cleanup */ } }
  var res = await pool.query(
    'UPDATE restaurant_menu_items SET photo_object_key = NULL, photo_file_name = NULL, updated_at = now() WHERE id = $1 RETURNING *',
    [id]
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'restaurant.menu.photo', 'restaurant_menu_item', id, 'Removed photo for ' + item.name + '.');
  return rowToMenuItem(item);
}

// No permission gate — this backs a plain <img src>, which can't attach an
// Authorization header at all, and needs to work from both the main app
// and the separately-authenticated (PIN-token) POS till. Menu photos
// aren't sensitive data the way ID documents are; the UUID in the URL is
// unguessable in practice, which is the same protection level unlisted
// (not access-controlled) images get on most sites.
async function getMenuItemPhoto(id) {
  var res = await pool.query('SELECT photo_object_key FROM restaurant_menu_items WHERE id = $1', [id]);
  if (!res.rows[0] || !res.rows[0].photo_object_key) fail('notfound', 'No photo.');
  return storage.getObjectStream(res.rows[0].photo_object_key);
}

// ── supplies (non-food, no expiry) ──────────────────────────────────────

function rowToSupply(r) {
  return {
    id: r.id, companyId: r.company_id, name: r.name, category: r.category, unit: r.unit,
    stockQty: Number(r.stock_qty), reorderLevel: Number(r.reorder_level), unitCost: Number(r.unit_cost),
    active: r.active, lowStock: Number(r.stock_qty) <= Number(r.reorder_level)
  };
}

async function listSupplies(ctx, companyId) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  var args = [];
  var where = '';
  if (companyId) { args.push(companyId); where = 'WHERE company_id = $1'; }
  var res = await pool.query('SELECT * FROM restaurant_supplies ' + where + ' ORDER BY category, name', args);
  return res.rows.map(rowToSupply);
}

async function createSupply(ctx, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var company = await requireCompany(p.companyId);
  var name = V.text(p.name, 'Name', 100);
  var category = V.text(p.category || 'General', 'Category', 40);

  var res = await pool.query(
    'INSERT INTO restaurant_supplies (company_id, name, category, unit, stock_qty, reorder_level, unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [company.id, name, category, p.unit || 'each', Math.max(0, Number(p.stockQty) || 0), Math.max(0, Number(p.reorderLevel) || 0), Math.max(0, Number(p.unitCost) || 0)]
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'restaurant.supply.create', 'restaurant_supply', item.id, 'Added supply ' + item.name + ' to ' + company.name + '.');
  return rowToSupply(item);
}

async function updateSupply(ctx, id, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var existing = await pool.query('SELECT * FROM restaurant_supplies WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Supply item not found.');

  var name = V.text(p.name, 'Name', 100);
  var category = V.text(p.category || 'General', 'Category', 40);
  var reorderLevel = Math.max(0, Number(p.reorderLevel) || 0);
  var unitCost = Math.max(0, Number(p.unitCost) || 0);

  var res = await pool.query(
    'UPDATE restaurant_supplies SET name = $1, category = $2, unit = $3, reorder_level = $4, unit_cost = $5, updated_at = now() WHERE id = $6 RETURNING *',
    [name, category, p.unit || existing.rows[0].unit, reorderLevel, unitCost, id]
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'restaurant.supply.update', 'restaurant_supply', item.id, 'Updated ' + item.name + '.');
  return rowToSupply(item);
}

async function adjustSupplyStock(ctx, id, delta, note) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  delta = Number(delta);
  if (!delta || isNaN(delta)) fail('invalid', 'Enter a non-zero quantity.');
  var res = await pool.query(
    'UPDATE restaurant_supplies SET stock_qty = stock_qty + $1, updated_at = now() WHERE id = $2 AND stock_qty + $1 >= 0 RETURNING *',
    [delta, id]
  );
  if (!res.rows[0]) {
    var existing = await pool.query('SELECT stock_qty FROM restaurant_supplies WHERE id = $1', [id]);
    if (!existing.rows[0]) fail('notfound', 'Supply item not found.');
    fail('invalid', 'That would take stock below zero (currently ' + Number(existing.rows[0].stock_qty) + ').');
  }
  var item = res.rows[0];
  await audit(pool, ctx, 'restaurant.supply.stock', 'restaurant_supply', id,
    (delta > 0 ? '+' : '') + delta + ' stock on ' + item.name + ' (now ' + Number(item.stock_qty) + ').' + (note ? ' ' + note : ''));
  return rowToSupply(item);
}

async function removeSupply(ctx, id) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var existing = await pool.query('SELECT * FROM restaurant_supplies WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Supply item not found.');
  await pool.query('DELETE FROM restaurant_supplies WHERE id = $1', [id]);
  await audit(pool, ctx, 'restaurant.supply.delete', 'restaurant_supply', id, 'Removed supply ' + existing.rows[0].name + '.');
  return true;
}

// ── ingredients (food, expiry-tracked) ──────────────────────────────────

function rowToIngredient(r) {
  return {
    id: r.id, companyId: r.company_id, name: r.name, unit: r.unit,
    stockQty: Number(r.stock_qty), reorderLevel: Number(r.reorder_level), unitCost: Number(r.unit_cost),
    expiryDate: r.expiry_date, active: r.active, lowStock: Number(r.stock_qty) <= Number(r.reorder_level),
    expiringSoon: !!(r.expiry_date && new Date(r.expiry_date) <= new Date(Date.now() + 3 * 24 * 60 * 60 * 1000))
  };
}

async function listIngredients(ctx, companyId) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  var args = [];
  var where = '';
  if (companyId) { args.push(companyId); where = 'WHERE company_id = $1'; }
  var res = await pool.query('SELECT * FROM restaurant_ingredients ' + where + ' ORDER BY name', args);
  return res.rows.map(rowToIngredient);
}

async function createIngredient(ctx, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var company = await requireCompany(p.companyId);
  var name = V.text(p.name, 'Name', 100);
  var expiryDate = p.expiryDate ? V.date(p.expiryDate, 'Expiry date') : null;

  var res = await pool.query(
    'INSERT INTO restaurant_ingredients (company_id, name, unit, stock_qty, reorder_level, unit_cost, expiry_date) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [company.id, name, p.unit || 'kg', Math.max(0, Number(p.stockQty) || 0), Math.max(0, Number(p.reorderLevel) || 0), Math.max(0, Number(p.unitCost) || 0), expiryDate]
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'restaurant.ingredient.create', 'restaurant_ingredient', item.id, 'Added ingredient ' + item.name + ' to ' + company.name + '.');
  return rowToIngredient(item);
}

async function updateIngredient(ctx, id, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var existing = await pool.query('SELECT * FROM restaurant_ingredients WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Ingredient not found.');

  var name = V.text(p.name, 'Name', 100);
  var reorderLevel = Math.max(0, Number(p.reorderLevel) || 0);
  var unitCost = Math.max(0, Number(p.unitCost) || 0);
  var expiryDate = p.expiryDate ? V.date(p.expiryDate, 'Expiry date') : null;

  var res = await pool.query(
    'UPDATE restaurant_ingredients SET name = $1, unit = $2, reorder_level = $3, unit_cost = $4, expiry_date = $5, updated_at = now() WHERE id = $6 RETURNING *',
    [name, p.unit || existing.rows[0].unit, reorderLevel, unitCost, expiryDate, id]
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'restaurant.ingredient.update', 'restaurant_ingredient', item.id, 'Updated ' + item.name + '.');
  return rowToIngredient(item);
}

async function adjustIngredientStock(ctx, id, delta, note) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  delta = Number(delta);
  if (!delta || isNaN(delta)) fail('invalid', 'Enter a non-zero quantity.');
  var res = await pool.query(
    'UPDATE restaurant_ingredients SET stock_qty = stock_qty + $1, updated_at = now() WHERE id = $2 AND stock_qty + $1 >= 0 RETURNING *',
    [delta, id]
  );
  if (!res.rows[0]) {
    var existing = await pool.query('SELECT stock_qty FROM restaurant_ingredients WHERE id = $1', [id]);
    if (!existing.rows[0]) fail('notfound', 'Ingredient not found.');
    fail('invalid', 'That would take stock below zero (currently ' + Number(existing.rows[0].stock_qty) + ').');
  }
  var item = res.rows[0];
  await audit(pool, ctx, 'restaurant.ingredient.stock', 'restaurant_ingredient', id,
    (delta > 0 ? '+' : '') + delta + ' stock on ' + item.name + ' (now ' + Number(item.stock_qty) + ').' + (note ? ' ' + note : ''));
  return rowToIngredient(item);
}

async function removeIngredient(ctx, id) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var existing = await pool.query('SELECT * FROM restaurant_ingredients WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Ingredient not found.');
  await pool.query('DELETE FROM restaurant_ingredients WHERE id = $1', [id]);
  await audit(pool, ctx, 'restaurant.ingredient.delete', 'restaurant_ingredient', id, 'Removed ingredient ' + existing.rows[0].name + '.');
  return true;
}

// ── tables (fixed per-restaurant list, assigned to an order at the till) ──

function rowToTable(r) {
  return { id: r.id, companyId: r.company_id, name: r.name, status: r.status };
}

async function listTables(ctx, companyId) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  var args = [];
  var where = '';
  if (companyId) { args.push(companyId); where = 'WHERE company_id = $1'; }
  var res = await pool.query('SELECT * FROM restaurant_tables ' + where + ' ORDER BY name', args);
  return res.rows.map(rowToTable);
}

async function createTable(ctx, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var company = await requireCompany(p.companyId);
  var name = V.text(p.name, 'Name', 40);
  var existing = await pool.query('SELECT id FROM restaurant_tables WHERE company_id = $1 AND name = $2', [company.id, name]);
  if (existing.rows[0]) fail('invalid', company.name + ' already has a table named "' + name + '".');
  var res = await pool.query('INSERT INTO restaurant_tables (company_id, name) VALUES ($1,$2) RETURNING *', [company.id, name]);
  var t = res.rows[0];
  await audit(pool, ctx, 'restaurant.table.create', 'restaurant_table', t.id, 'Added table "' + t.name + '" to ' + company.name + '.');
  return rowToTable(t);
}

async function updateTable(ctx, id, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var existing = await pool.query('SELECT * FROM restaurant_tables WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Table not found.');
  var name = V.text(p.name, 'Name', 40);
  var res = await pool.query('UPDATE restaurant_tables SET name = $1 WHERE id = $2 RETURNING *', [name, id]);
  var t = res.rows[0];
  await audit(pool, ctx, 'restaurant.table.update', 'restaurant_table', t.id, 'Renamed table to "' + t.name + '".');
  return rowToTable(t);
}

async function setTableActive(ctx, id, active) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var res = await pool.query("UPDATE restaurant_tables SET status = $1 WHERE id = $2 RETURNING *", [active ? 'active' : 'archived', id]);
  if (!res.rows[0]) fail('notfound', 'Table not found.');
  var t = res.rows[0];
  await audit(pool, ctx, 'restaurant.table.active', 'restaurant_table', t.id, (active ? 'Reactivated ' : 'Archived ') + 'table "' + t.name + '".');
  return rowToTable(t);
}

async function removeTable(ctx, id) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var existing = await pool.query('SELECT * FROM restaurant_tables WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Table not found.');
  await pool.query('DELETE FROM restaurant_tables WHERE id = $1', [id]);
  await audit(pool, ctx, 'restaurant.table.delete', 'restaurant_table', id, 'Removed table "' + existing.rows[0].name + '".');
  return true;
}

// ── guests (lightweight, restaurant-scoped — not the B2B customers module) ──

function rowToGuest(r) {
  return { id: r.id, companyId: r.company_id, name: r.name, phone: r.phone, notes: r.notes };
}

async function listGuests(ctx, companyId, q) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  var args = [];
  var where = [];
  if (companyId) { args.push(companyId); where.push('company_id = $' + args.length); }
  if (q) { args.push('%' + q + '%'); where.push('(name ILIKE $' + args.length + ' OR phone ILIKE $' + args.length + ')'); }
  var whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  var res = await pool.query('SELECT * FROM restaurant_guests ' + whereSql + ' ORDER BY name LIMIT 200', args);
  return res.rows.map(rowToGuest);
}

async function createGuest(ctx, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var company = await requireCompany(p.companyId);
  var name = V.text(p.name, 'Name', 100);
  var res = await pool.query(
    'INSERT INTO restaurant_guests (company_id, name, phone, notes) VALUES ($1,$2,$3,$4) RETURNING *',
    [company.id, name, (p.phone || '').trim(), (p.notes || '').trim()]
  );
  var g = res.rows[0];
  await audit(pool, ctx, 'restaurant.guest.create', 'restaurant_guest', g.id, 'Added guest ' + g.name + ' for ' + company.name + '.');
  return rowToGuest(g);
}

async function updateGuest(ctx, id, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var existing = await pool.query('SELECT * FROM restaurant_guests WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Guest not found.');
  var name = V.text(p.name, 'Name', 100);
  var res = await pool.query(
    'UPDATE restaurant_guests SET name = $1, phone = $2, notes = $3, updated_at = now() WHERE id = $4 RETURNING *',
    [name, (p.phone || '').trim(), (p.notes || '').trim(), id]
  );
  var g = res.rows[0];
  await audit(pool, ctx, 'restaurant.guest.update', 'restaurant_guest', g.id, 'Updated guest ' + g.name + '.');
  return rowToGuest(g);
}

async function removeGuest(ctx, id) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var existing = await pool.query('SELECT * FROM restaurant_guests WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Guest not found.');
  await pool.query('DELETE FROM restaurant_guests WHERE id = $1', [id]);
  await audit(pool, ctx, 'restaurant.guest.delete', 'restaurant_guest', id, 'Removed guest ' + existing.rows[0].name + '.');
  return true;
}

module.exports = {
  listMenuItems: listMenuItems, createMenuItem: createMenuItem, updateMenuItem: updateMenuItem,
  setMenuItemActive: setMenuItemActive, removeMenuItem: removeMenuItem,
  setMenuItemPhoto: setMenuItemPhoto, removeMenuItemPhoto: removeMenuItemPhoto, getMenuItemPhoto: getMenuItemPhoto,
  listSupplies: listSupplies, createSupply: createSupply, updateSupply: updateSupply,
  adjustSupplyStock: adjustSupplyStock, removeSupply: removeSupply,
  listIngredients: listIngredients, createIngredient: createIngredient, updateIngredient: updateIngredient,
  adjustIngredientStock: adjustIngredientStock, removeIngredient: removeIngredient,
  listTables: listTables, createTable: createTable, updateTable: updateTable,
  setTableActive: setTableActive, removeTable: removeTable,
  listGuests: listGuests, createGuest: createGuest, updateGuest: updateGuest, removeGuest: removeGuest
};
