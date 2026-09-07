var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var config = require('../config');
var square = require('./square.service');

// Restaurant module, Phase 4: one-time historical Square import, run
// separately per restaurant. Star Bar Restaurant and Bamboo Garden turned
// out to be two *locations* under one shared Square merchant account, not
// two separate accounts/tokens — so when config.restaurantSquare gives us a
// locationId alongside the token, everything below is scoped to that one
// location: orders/search is restricted to it, and catalog items are kept
// only if Square says they're actually sold there (itemPresentAtLocation).
// A restaurant with a genuinely separate Square account (no locationId
// configured) just imports everything the token can see, as before.
//
// This deliberately never touches catalog_items/invoices/payments — the
// single shared-account import on the Integrations page
// (squareImport.service.js) — only this company's own
// restaurant_menu_items/restaurant_orders.
//
// Same "same one-time import, run per restaurant" shape the user asked
// for, not a live/recurring sync — call it again later and it just
// re-imports (upserts by external_id), same idempotency pattern as the
// original Square importer (migration 0026) and this module's own
// restaurant_menu_items table (migration 0041, written in anticipation of
// this). external_id uniqueness is per-company (migration 0044) — a
// shared-catalog item present at both locations gets its own menu row per
// restaurant, not one row fought over by both.

function minorToMajor(money) {
  return money && typeof money.amount === 'number' ? Math.round(money.amount) / 100 : 0;
}

async function requireCompany(companyId) {
  var res = await pool.query('SELECT id, code, name FROM companies WHERE id = $1', [companyId]);
  if (!res.rows[0]) fail('notfound', 'Company not found.');
  return res.rows[0];
}

// A Square order has no concept of "which Bamboo OS employee rang this up"
// — restaurant_orders.cashier_id is NOT NULL (a real POS sale always has a
// till operator), so imported historical sales are attributed to one
// placeholder employee per restaurant, created on first use. Mirrors
// squareImport.service.js's ensureWalkinCustomer() for the same reason:
// the schema requires a real row, and a placeholder is simpler than
// loosening a NOT NULL constraint that's correct for every other caller.
async function ensureImportCashier(company) {
  var code = company.code + '-SQIMPORT';
  var existing = await pool.query('SELECT id FROM employees WHERE code = $1', [code]);
  if (existing.rows[0]) return existing.rows[0].id;

  var deptRes = await pool.query('SELECT id FROM departments WHERE company_id = $1 ORDER BY created_at LIMIT 1', [company.id]);
  if (!deptRes.rows[0]) fail('invalid', company.name + ' has no departments yet — add one before importing Square sales.');

  var res = await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, hire_date, status) " +
    "VALUES ($1,'Square','Import',$2,$3,'Square import placeholder',CURRENT_DATE,'inactive') RETURNING id",
    [code, 'square-import+' + company.code.toLowerCase() + '@bamboo.internal', deptRes.rows[0].id]
  );
  return res.rows[0].id;
}

// Square's Catalog has no separate "menu" concept — every sellable ITEM
// (with its variations) is the restaurant's menu. Unlike catalog_items/
// catalog_item_variations' two-table shape, restaurant_menu_items is flat,
// so a Square item with N variations becomes N menu rows, named "Item —
// Variation" unless the variation is just Square's default "Regular".
function menuItemName(item, variation) {
  var vName = (variation.item_variation_data.name || '').trim();
  if (!vName || vName.toLowerCase() === 'regular') return item.item_data.name;
  return item.item_data.name + ' — ' + vName;
}

// Square's per-location catalog visibility: an object (item or variation)
// is present at a location if present_at_all_locations is true and the
// location isn't explicitly excluded, or if present_at_all_locations is
// false and the location is explicitly included. Checked at the variation
// level first since a variation can override its parent item's visibility;
// falls back to the item's own fields when the variation doesn't set any.
function presentAtLocation(obj, locationId) {
  if (!locationId) return true; // no location filter configured — keep everything the token can see
  var allLocations = obj.present_at_all_locations !== false;
  var present = obj.present_at_location_ids || [];
  var absent = obj.absent_at_location_ids || [];
  if (allLocations) return absent.indexOf(locationId) === -1;
  return present.indexOf(locationId) !== -1;
}
function itemPresentAtLocation(item, variation, locationId) {
  if (!locationId) return true;
  return presentAtLocation(item, locationId) && presentAtLocation(variation, locationId);
}

async function upsertMenuItem(company, item, variation, categoryNameByExternal) {
  var squareCategoryId = item.item_data.categories && item.item_data.categories[0] && item.item_data.categories[0].id;
  var category = (squareCategoryId && categoryNameByExternal[squareCategoryId]) || 'General';
  var name = menuItemName(item, variation);
  var price = minorToMajor(variation.item_variation_data.price_money);
  var active = !item.is_deleted && !variation.is_deleted;

  var res = await pool.query(
    "INSERT INTO restaurant_menu_items (company_id, name, category, price, active, external_id, source) " +
    "VALUES ($1,$2,$3,$4,$5,$6,'square') " +
    "ON CONFLICT (company_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET " +
    "name = EXCLUDED.name, category = EXCLUDED.category, price = EXCLUDED.price, active = EXCLUDED.active, updated_at = now() " +
    "RETURNING id",
    [company.id, name, category, price, active, variation.id]
  );
  return res.rows[0].id;
}

// Square Orders don't reliably carry a payment method on the order object
// itself (tenders is a legacy field, absent on most modern orders) — where
// present it's mapped onto restaurant_orders' CHECK constraint values the
// same way squareImport.service.js's mapPaymentMethod does for invoices;
// otherwise 'other' rather than guessing.
function mapTenderType(t) {
  if (t === 'CARD') return 'card';
  if (t === 'CASH') return 'cash';
  if (t === 'WALLET' || t === 'SQUARE_ACCOUNT') return 'mobile_money';
  if (t === 'BANK_ACCOUNT') return 'bank_transfer';
  return 'other';
}
function orderPaymentMethod(order) {
  var tender = order.tenders && order.tenders[0];
  return tender ? mapTenderType(tender.type) : 'other';
}

function buildOrderItems(order, menuItemIdByVariation) {
  var lineItems = order.line_items || [];
  if (!lineItems.length) {
    return [{ menuItemId: null, name: 'Square order total', qty: 1, unitPrice: minorToMajor(order.total_money), lineTotal: minorToMajor(order.total_money) }];
  }
  return lineItems.map(function (li) {
    var qty = Math.max(0.01, Number(li.quantity) || 1);
    var lineTotal = minorToMajor(li.total_money);
    var unitPrice = li.base_price_money ? minorToMajor(li.base_price_money) : Math.round((lineTotal / qty) * 100) / 100;
    return {
      menuItemId: (li.catalog_object_id && menuItemIdByVariation[li.catalog_object_id]) || null,
      name: li.name || 'Item', qty: qty, unitPrice: unitPrice, lineTotal: lineTotal
    };
  });
}

async function upsertOrder(ctx, company, order, cashierId, menuItemIdByVariation) {
  var total = minorToMajor(order.total_money);
  var items = buildOrderItems(order, menuItemIdByVariation);
  var subtotal = items.reduce(function (sum, it) { return sum + it.lineTotal; }, 0);
  var orderNo = 'SQ-' + order.id;
  // Every imported order lands as 'completed' — an OPEN Square order (still
  // awaiting full payment) is a real historical sale just as much as a
  // COMPLETED one; restaurant_orders' status column only ever distinguishes
  // completed from voided, and Square voids/cancellations are excluded
  // upstream (square.service.js's searchAllOrders never returns CANCELED).
  var status = 'completed';
  var createdAt = order.created_at || new Date().toISOString();
  var paymentMethod = orderPaymentMethod(order);

  return withTransaction(async function (client) {
    var res = await client.query(
      "INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, payment_method, status, created_at, external_id, source) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'square') " +
      "ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET " +
      "subtotal = EXCLUDED.subtotal, total = EXCLUDED.total, payment_method = EXCLUDED.payment_method, created_at = EXCLUDED.created_at " +
      "RETURNING id",
      [company.id, orderNo, cashierId, subtotal, total, paymentMethod, status, createdAt, order.id]
    );
    var orderId = res.rows[0].id;
    await client.query('DELETE FROM restaurant_order_items WHERE order_id = $1', [orderId]);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      await client.query(
        'INSERT INTO restaurant_order_items (order_id, menu_item_id, name, qty, unit_price, line_total) VALUES ($1,$2,$3,$4,$5,$6)',
        [orderId, it.menuItemId, it.name, it.qty, it.unitPrice, it.lineTotal]
      );
    }
    await audit(client, ctx, 'restaurant.square_import.order', 'restaurant_order', orderId, 'Imported from Square order ' + order.id + ' (GHS ' + total.toLocaleString() + ').');
    return orderId;
  });
}

async function runImport(ctx, companyId) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var company = await requireCompany(companyId);

  var creds = config.restaurantSquare.forCompanyCode(company.code);
  if (!creds.configured) fail('invalid', 'Square is not configured for ' + company.name + " — set SQUARE_ACCESS_TOKEN_" + company.code + ' on the server.');
  var client = square.createClient(creds);

  var summary = { menuItems: { imported: 0, skipped: 0 }, orders: { imported: 0, skipped: 0 }, errors: [] };

  var cashierId = await ensureImportCashier(company);

  var squareObjects = await client.listAllCatalogItems();
  var squareCategories = squareObjects.filter(function (o) { return o.type === 'CATEGORY'; });
  var squareItems = squareObjects.filter(function (o) { return o.type === 'ITEM'; });

  var categoryNameByExternal = {};
  for (var ci = 0; ci < squareCategories.length; ci++) {
    categoryNameByExternal[squareCategories[ci].id] = squareCategories[ci].category_data.name;
  }

  var locations = await client.listLocations();
  var allLocationIds = locations.map(function (l) { return l.id; });
  if (!allLocationIds.length) fail('invalid', 'Square returned no locations for ' + company.name + "'s account — nothing to import.");
  if (creds.locationId && allLocationIds.indexOf(creds.locationId) === -1) {
    fail('invalid', 'Configured Square location for ' + company.name + ' (' + creds.locationId + ") wasn't found on this account.");
  }
  var locationIds = creds.locationId ? [creds.locationId] : allLocationIds;

  var menuItemIdByVariation = {};
  for (var it = 0; it < squareItems.length; it++) {
    var item = squareItems[it];
    var variations = (item.item_data && item.item_data.variations) || [];
    for (var vi = 0; vi < variations.length; vi++) {
      var v = variations[vi];
      if (!itemPresentAtLocation(item, v, creds.locationId)) continue; // not sold at this restaurant's location — not its menu item
      try {
        menuItemIdByVariation[v.id] = await upsertMenuItem(company, item, v, categoryNameByExternal);
        summary.menuItems.imported++;
      } catch (e) {
        summary.menuItems.skipped++;
        summary.errors.push({ type: 'menuItem', externalId: v.id, message: e.message });
      }
    }
  }

  var orders = await client.searchAllOrders(locationIds);
  for (var oi = 0; oi < orders.length; oi++) {
    var order = orders[oi];
    try {
      await upsertOrder(ctx, company, order, cashierId, menuItemIdByVariation);
      summary.orders.imported++;
    } catch (e) {
      summary.orders.skipped++;
      summary.errors.push({ type: 'order', externalId: order.id, message: e.message });
    }
  }

  return summary;
}

module.exports = {
  runImport: runImport,
  // Exported for unit testing pure mapping logic without hitting Square's
  // real API — see test/restaurantSquareImport.test.js. requireCompany/
  // ensureImportCashier/upsertMenuItem/upsertOrder are also exported so a
  // one-off operational script can drive the exact same tested DB-write
  // logic from Square data fetched through a different transport (e.g. an
  // already-authorized MCP Square connector) when this environment's
  // network policy blocks the backend's own direct Square API calls.
  minorToMajor: minorToMajor, menuItemName: menuItemName, mapTenderType: mapTenderType,
  requireCompany: requireCompany, ensureImportCashier: ensureImportCashier,
  upsertMenuItem: upsertMenuItem, upsertOrder: upsertOrder, itemPresentAtLocation: itemPresentAtLocation
};
