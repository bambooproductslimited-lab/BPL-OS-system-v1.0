var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var config = require('../config');
var square = require('./square.service');
var fileStore = require('../lib/fileStore');

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

// A Square ITEM with more than one qualifying variation — e.g. "Cucumber
// with Garlic" sold as "M" ₵98 or "Jellyfish" ₵238 — now upserts as ONE
// restaurant_menu_items row (keyed by the ITEM's own external_id, which no
// variation-keyed row has ever used) plus one restaurant_menu_item_variations
// row per variation, matching the named-price-variation feature the till
// and management UI already support. Single-variation items are untouched
// (still upsertMenuItem's one-flat-row shape) — grouping only changes
// behavior for items that genuinely have more than one price.
//
// A restaurant re-importing after this shipped will have OLD flat rows
// sitting around from before — one per variation, keyed by that
// variation's own external_id (see upsertMenuItem above). Those are left
// in place (never deleted: real historical orders' restaurant_order_items
// rows may still reference them, and that FK has no ON DELETE) but
// deactivated, since the new grouped item now supersedes them as what's
// actually sold.
async function upsertGroupedMenuItem(company, item, variations, categoryNameByExternal) {
  if (variations.length <= 1) {
    var menuItemId = await upsertMenuItem(company, item, variations[0], categoryNameByExternal);
    return { menuItemId: menuItemId, variationRowIdByExternalId: {} };
  }

  var squareCategoryId = item.item_data.categories && item.item_data.categories[0] && item.item_data.categories[0].id;
  var category = (squareCategoryId && categoryNameByExternal[squareCategoryId]) || 'General';
  var fallbackPrice = minorToMajor(variations[0].item_variation_data.price_money);
  var active = !item.is_deleted;

  var parentRes = await pool.query(
    "INSERT INTO restaurant_menu_items (company_id, name, category, price, active, external_id, source) " +
    "VALUES ($1,$2,$3,$4,$5,$6,'square') " +
    "ON CONFLICT (company_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET " +
    "name = EXCLUDED.name, category = EXCLUDED.category, price = EXCLUDED.price, active = EXCLUDED.active, updated_at = now() " +
    "RETURNING id",
    [company.id, item.item_data.name, category, fallbackPrice, active, item.id]
  );
  var menuItemId = parentRes.rows[0].id;

  var variationRowIdByExternalId = {};
  for (var i = 0; i < variations.length; i++) {
    var v = variations[i];
    var vName = (v.item_variation_data.name || '').trim() || 'Regular';
    var vPrice = minorToMajor(v.item_variation_data.price_money);
    var vRes = await pool.query(
      "INSERT INTO restaurant_menu_item_variations (menu_item_id, name, price, sort_order, external_id) " +
      "VALUES ($1,$2,$3,$4,$5) " +
      "ON CONFLICT (menu_item_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET " +
      "name = EXCLUDED.name, price = EXCLUDED.price " +
      "RETURNING id",
      [menuItemId, vName, vPrice, i, v.id]
    );
    variationRowIdByExternalId[v.id] = vRes.rows[0].id;
    await pool.query(
      'UPDATE restaurant_menu_items SET active = false, updated_at = now() WHERE company_id = $1 AND external_id = $2 AND id <> $3',
      [company.id, v.id, menuItemId]
    );
  }
  return { menuItemId: menuItemId, variationRowIdByExternalId: variationRowIdByExternalId };
}

// The menu item's picture from Square: the item's own first picture, or else
// the first one of a variation sold here. A photo uploaded in the OS is never
// replaced; one that came from Square is replaced when the picture changed
// there, and left alone (not downloaded again) when it didn't.
function squarePictureId(item, variations) {
  var own = (item.item_data && item.item_data.image_ids) || [];
  if (own.length) return own[0];
  for (var i = 0; i < variations.length; i++) {
    var ids = (variations[i].item_variation_data && variations[i].item_variation_data.image_ids) || [];
    if (ids.length) return ids[0];
  }
  return null;
}

// Returns 'imported', 'kept' (theirs, or the same picture) or 'none'.
async function importMenuPhoto(client, menuItemId, imageId, imageById) {
  var img = imageById[imageId];
  var url = img && img.image_data && img.image_data.url;
  if (!url) return 'none';
  var cur = (await pool.query('SELECT name, photo_object_key, photo_square_image_id FROM restaurant_menu_items WHERE id = $1', [menuItemId])).rows[0];
  if (!cur) return 'none';
  if (cur.photo_object_key && !cur.photo_square_image_id) return 'kept'; // uploaded here
  if (cur.photo_object_key && cur.photo_square_image_id === imageId) return 'kept'; // already this picture
  if (!cur.photo_object_key && cur.photo_square_image_id === '-' + imageId) return 'kept'; // taken off here on purpose
  var file = await client.downloadImage(url);
  var slug = String(cur.name || 'menu').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'menu';
  var type = /^image\/(jpeg|png|webp|gif)$/.test(file.contentType || '') ? file.contentType : 'image/jpeg';
  var key = await fileStore.put('menu-' + slug + (type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : type === 'image/gif' ? '.gif' : '.jpg'), file.buffer, type);
  try {
    // Only if nobody uploaded one meanwhile.
    var res = await pool.query(
      'UPDATE restaurant_menu_items SET photo_object_key = $2, photo_file_name = $3, photo_square_image_id = $4, updated_at = now() ' +
      'WHERE id = $1 AND (photo_object_key IS NULL OR photo_square_image_id IS NOT NULL) RETURNING id',
      [menuItemId, key, 'square-' + slug, imageId]);
    if (!res.rows[0]) { await fileStore.del(key); return 'kept'; }
  } catch (e) { await fileStore.del(key); throw e; }
  if (cur.photo_object_key) await fileStore.del(cur.photo_object_key); // Square's previous picture
  return 'imported';
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

function buildOrderItems(order, menuItemIdByVariation, variationRowIdByVariation) {
  var lineItems = order.line_items || [];
  if (!lineItems.length) {
    return [{ menuItemId: null, variationId: null, name: 'Square order total', qty: 1, unitPrice: minorToMajor(order.total_money), lineTotal: minorToMajor(order.total_money), gross: null }];
  }
  return lineItems.map(function (li) {
    var qty = Math.max(0.01, Number(li.quantity) || 1);
    var lineTotal = minorToMajor(li.total_money);
    var unitPrice = li.base_price_money ? minorToMajor(li.base_price_money) : Math.round((lineTotal / qty) * 100) / 100;
    return {
      menuItemId: (li.catalog_object_id && menuItemIdByVariation[li.catalog_object_id]) || null,
      variationId: (li.catalog_object_id && variationRowIdByVariation && variationRowIdByVariation[li.catalog_object_id]) || null,
      name: li.name || 'Item', qty: qty, unitPrice: unitPrice, lineTotal: lineTotal,
      // before discounts, with modifiers — the report ranks items on it
      gross: li.gross_sales_money ? minorToMajor(li.gross_sales_money) : null
    };
  });
}

// What Square says about who and how, beyond the items and total: the app
// it came from (Bolt Food and the like; empty for Square's own till),
// pick-up or delivery, and the customer — the one on the order, or the name
// and number on its pick-up or delivery. The guest CRM
// (restaurantCrm.service.js) puts the sale on that guest and matches it to
// the order customer service logged.
var FULFILLMENT = { PICKUP: 'pickup', DELIVERY: 'delivery', SHIPMENT: 'delivery', DINE_IN: 'dine_in' };
function orderMeta(order) {
  var f = (order.fulfillments || [])[0] || {};
  var details = f.pickup_details || f.delivery_details || f.shipment_details || f.dine_in_details || {};
  var who = details.recipient || {};
  return {
    sourceName: String((order.source && order.source.name) || '').slice(0, 100),
    fulfillment: FULFILLMENT[f.type] || '',
    customerName: String(who.display_name || '').slice(0, 120),
    customerPhone: String(who.phone_number || '').slice(0, 40),
    squareCustomerId: order.customer_id || who.customer_id || null,
    ticketName: String(order.ticket_name || '').slice(0, 120)
  };
}

// The guest a Square sale belongs to: its Square customer (made a guest the
// first time, or found by number), else the number on its pick-up or
// delivery. A name alone is not enough — two "Ama"s are not one guest.
// cache: { squareId or phone -> guest id } for the length of one import.
async function guestForOrder(company, meta, customers, cache) {
  var crm = require('./restaurantCrm.service');
  var sq = meta.squareCustomerId;
  if (sq) {
    if (cache['s:' + sq] !== undefined) return cache['s:' + sq];
    var found = (await pool.query('SELECT id FROM restaurant_guests WHERE company_id = $1 AND square_customer_id = $2', [company.id, sq])).rows[0];
    if (!found) {
      var c = (customers && customers[sq]) || {};
      var name = [c.given_name, c.family_name].filter(Boolean).join(' ').trim() || c.company_name || c.nickname || meta.customerName || '';
      var phone = c.phone_number || meta.customerPhone || '';
      if (name || phone) {
        var pk = crm.phoneKey(phone);
        var byPhone = pk ? (await pool.query('SELECT id FROM restaurant_guests WHERE company_id = $1 AND phone_key = $2 AND square_customer_id IS NULL ORDER BY created_at LIMIT 1', [company.id, pk])).rows[0] : null;
        if (byPhone) {
          await pool.query('UPDATE restaurant_guests SET square_customer_id = $2, updated_at = now() WHERE id = $1', [byPhone.id, sq]);
          found = byPhone;
        } else {
          found = (await pool.query(
            "INSERT INTO restaurant_guests (company_id, name, phone, source, square_customer_id) VALUES ($1,$2,$3,'square',$4) " +
            'ON CONFLICT (company_id, square_customer_id) WHERE square_customer_id IS NOT NULL DO UPDATE SET updated_at = now() RETURNING id',
            [company.id, name || phone, phone, sq])).rows[0];
        }
      }
    }
    cache['s:' + sq] = found ? found.id : null;
    return cache['s:' + sq];
  }
  var key = crm.phoneKey(meta.customerPhone);
  if (!key) return null;
  if (cache['p:' + key] !== undefined) return cache['p:' + key];
  var g = await crm.findOrCreateGuest(pool, company.id, { name: meta.customerName, phone: meta.customerPhone }, 'square');
  if (g.created) await pool.query("UPDATE restaurant_guests SET source = 'square' WHERE id = $1", [g.id]);
  cache['p:' + key] = g.id;
  return g.id;
}

// quiet: a background import records one summary in the audit log when it
// finishes instead of one line per order (a busy restaurant's history is
// tens of thousands of orders). guestId: the guest it is for, if known.
async function upsertOrder(ctx, company, order, cashierId, menuItemIdByVariation, variationRowIdByVariation, quiet, guestId) {
  var total = minorToMajor(order.total_money);
  var items = buildOrderItems(order, menuItemIdByVariation, variationRowIdByVariation);
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
  var meta = orderMeta(order);

  return withTransaction(async function (client) {
    // A guest set on the sale before (in the OS, or by the guest CRM) stays.
    var res = await client.query(
      "INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, payment_method, status, created_at, external_id, source, " +
      "  source_name, fulfillment, customer_name, customer_phone, square_customer_id, ticket_name, guest_id) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'square',$10,$11,$12,$13,$14,$15,$16) " +
      "ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET " +
      "subtotal = EXCLUDED.subtotal, total = EXCLUDED.total, payment_method = EXCLUDED.payment_method, created_at = EXCLUDED.created_at, " +
      "source_name = EXCLUDED.source_name, fulfillment = EXCLUDED.fulfillment, customer_name = EXCLUDED.customer_name, customer_phone = EXCLUDED.customer_phone, " +
      "square_customer_id = EXCLUDED.square_customer_id, ticket_name = EXCLUDED.ticket_name, guest_id = COALESCE(restaurant_orders.guest_id, EXCLUDED.guest_id) " +
      "RETURNING id",
      [company.id, orderNo, cashierId, subtotal, total, paymentMethod, status, createdAt, order.id,
        meta.sourceName, meta.fulfillment, meta.customerName, meta.customerPhone, meta.squareCustomerId, meta.ticketName, guestId || null]
    );
    var orderId = res.rows[0].id;
    await client.query('DELETE FROM restaurant_order_items WHERE order_id = $1', [orderId]);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      await client.query(
        'INSERT INTO restaurant_order_items (order_id, menu_item_id, variation_id, name, qty, unit_price, line_total, gross) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [orderId, it.menuItemId, it.variationId, it.name, it.qty, it.unitPrice, it.lineTotal, it.gross]
      );
    }
    if (!quiet) await audit(client, ctx, 'restaurant.square_import.order', 'restaurant_order', orderId, 'Imported from Square order ' + order.id + ' (GHS ' + total.toLocaleString() + ').');
    return orderId;
  });
}

// ── the import, as a background job ─────────────────────────────────
//
// startImport() checks everything that can be checked at once (permission,
// company, Square token), records a job and returns straight away; the work
// runs after the response, and the page asks jobStatus() for progress.
// Orders are fetched a page at a time, oldest first, and saved as each page
// arrives — memory stays small however long the history is. Unless a full
// re-import is asked for, orders are fetched only from the last Square order
// already saved (less a day, in case of late edits), so a later import takes
// seconds, and an import stopped by a server restart carries on where it
// left off. Saving is by Square id, so nothing is ever duplicated.

var STALE_MS = 3 * 60 * 1000;
var MAX_ERRORS_KEPT = 50;
var clientFactory = function (creds) { return square.createClient(creds); };
// Tests hand in a fake Square client instead of the real API.
function setClientFactoryForTests(fn) { clientFactory = fn || function (creds) { return square.createClient(creds); }; }

function rowToJob(r) {
  if (!r) return null;
  var stale = r.status === 'running' && Date.now() - new Date(r.heartbeat_at).getTime() > STALE_MS;
  return {
    id: r.id, companyId: r.company_id, status: stale ? 'interrupted' : r.status, phase: r.phase, fullImport: r.full_import,
    ordersSince: r.orders_since, menuItems: { imported: r.menu_imported, skipped: r.menu_skipped },
    photos: { imported: r.photos_imported || 0, skipped: r.photos_skipped || 0 },
    orders: { imported: r.orders_imported, skipped: r.orders_skipped }, pagesDone: r.pages_done, lastOrderAt: r.last_order_at,
    errorCount: r.error_count, errors: r.errors || [], message: r.message || null,
    startedAt: r.started_at, heartbeatAt: r.heartbeat_at, finishedAt: r.finished_at
  };
}

async function latestJob(companyId) {
  return (await pool.query('SELECT * FROM restaurant_import_jobs WHERE company_id = $1 ORDER BY started_at DESC LIMIT 1', [companyId])).rows[0] || null;
}

// The latest import for this restaurant, with its progress.
async function jobStatus(ctx, companyId) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  await requireCompany(companyId);
  return rowToJob(await latestJob(companyId));
}

async function startImport(ctx, companyId, opts) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  opts = opts || {};
  var company = await requireCompany(companyId);
  var creds = config.restaurantSquare.forCompanyCode(company.code);
  if (!creds.configured) fail('invalid', 'Square is not configured for ' + company.name + " — set SQUARE_ACCESS_TOKEN_" + company.code + ' on the server.');

  var last = await latestJob(company.id);
  if (last && rowToJob(last).status === 'running') fail('conflict', 'An import for ' + company.name + ' is already running. It carries on in the background — watch its progress here.');
  if (last && last.status === 'running') {
    await pool.query("UPDATE restaurant_import_jobs SET status = 'failed', message = 'Stopped when the server restarted.', finished_at = now() WHERE id = $1", [last.id]);
  }
  var job = (await pool.query(
    'INSERT INTO restaurant_import_jobs (company_id, full_import, started_by) VALUES ($1,$2,$3) RETURNING *',
    [company.id, !!opts.full, ctx.employee ? ctx.employee.id : null])).rows[0];
  await audit(pool, ctx, 'restaurant.square_import.start', 'restaurant_import_job', job.id, (opts.full ? 'Started a full Square re-import for ' : 'Started a Square import for ') + company.name + '.');

  var client = clientFactory(creds);
  var run = runJob(ctx, job.id, company, creds, client, !!opts.full);
  if (opts.wait) await run; // tests wait for the job; the web request never does
  else run.catch(function (e) { console.error('[restaurant import] job ' + job.id + ' crashed:', e); });
  return rowToJob((await pool.query('SELECT * FROM restaurant_import_jobs WHERE id = $1', [job.id])).rows[0]);
}

async function runJob(ctx, jobId, company, creds, client, full) {
  var errors = [];
  var counts = { menuImported: 0, menuSkipped: 0, photosImported: 0, photosSkipped: 0, ordersImported: 0, ordersSkipped: 0, pages: 0, errorCount: 0, lastOrderAt: null };
  var lastSave = Date.now();
  function keepError(e) { counts.errorCount++; if (errors.length < MAX_ERRORS_KEPT) errors.push(e); }
  async function save(phase, extra) {
    await pool.query(
      'UPDATE restaurant_import_jobs SET phase = $2, menu_imported = $3, menu_skipped = $4, orders_imported = $5, orders_skipped = $6, pages_done = $7, ' +
      'last_order_at = COALESCE($8, last_order_at), error_count = $9, errors = $10, photos_imported = $11, photos_skipped = $12, heartbeat_at = now()' + (extra || '') + ' WHERE id = $1',
      [jobId, phase, counts.menuImported, counts.menuSkipped, counts.ordersImported, counts.ordersSkipped, counts.pages, counts.lastOrderAt, counts.errorCount, JSON.stringify(errors), counts.photosImported, counts.photosSkipped]);
    lastSave = Date.now();
  }
  try {
    var cashierId = await ensureImportCashier(company);
    await save('menu');
    var squareObjects = await client.listAllCatalogItems();
    var categoryNameByExternal = {};
    squareObjects.filter(function (o) { return o.type === 'CATEGORY'; }).forEach(function (c) { categoryNameByExternal[c.id] = c.category_data.name; });
    var squareItems = squareObjects.filter(function (o) { return o.type === 'ITEM'; });
    var imageById = {};
    squareObjects.forEach(function (o) { if (o.type === 'IMAGE') imageById[o.id] = o; });

    var locations = await client.listLocations();
    var allLocationIds = locations.map(function (l) { return l.id; });
    if (!allLocationIds.length) fail('invalid', 'Square returned no locations for ' + company.name + "'s account — nothing to import.");
    if (creds.locationId && allLocationIds.indexOf(creds.locationId) === -1) {
      fail('invalid', 'Configured Square location for ' + company.name + ' (' + creds.locationId + ") wasn't found on this account.");
    }
    var locationIds = creds.locationId ? [creds.locationId] : allLocationIds;

    var menuItemIdByVariation = {};
    var variationRowIdByVariation = {};
    for (var it = 0; it < squareItems.length; it++) {
      var item = squareItems[it];
      var allVariations = (item.item_data && item.item_data.variations) || [];
      // Qualifying = actually sold at this restaurant's location and not
      // itself deleted in Square's catalog — grouped as ONE menu item when
      // there's more than one (see upsertGroupedMenuItem's comment).
      var qualifying = allVariations.filter(function (v) { return itemPresentAtLocation(item, v, creds.locationId) && !v.is_deleted; });
      if (!qualifying.length) continue;
      try {
        var grouped = await upsertGroupedMenuItem(company, item, qualifying, categoryNameByExternal);
        for (var qi = 0; qi < qualifying.length; qi++) {
          menuItemIdByVariation[qualifying[qi].id] = grouped.menuItemId;
          if (grouped.variationRowIdByExternalId[qualifying[qi].id]) variationRowIdByVariation[qualifying[qi].id] = grouped.variationRowIdByExternalId[qualifying[qi].id];
        }
        counts.menuImported += qualifying.length;
      } catch (e) {
        counts.menuSkipped += qualifying.length;
        keepError({ type: 'menuItem', externalId: item.id, message: e.message });
        grouped = null;
      }
      var pictureId = grouped && client.downloadImage ? squarePictureId(item, qualifying) : null;
      if (pictureId) {
        try {
          if ((await importMenuPhoto(client, grouped.menuItemId, pictureId, imageById)) === 'imported') counts.photosImported++;
        } catch (e) {
          counts.photosSkipped++;
          keepError({ type: 'menuPhoto', externalId: pictureId, message: 'Picture for ' + ((item.item_data && item.item_data.name) || 'an item') + ': ' + e.message });
        }
        // Downloading pictures takes a while: keep showing the job is alive.
        if (Date.now() - lastSave > 10000) await save('menu');
      }
      if (it % 100 === 99) await save('menu');
    }

    // Where to start: from the last Square order already saved (less a day),
    // unless a full re-import was asked for.
    var since = null;
    if (!full) {
      var lastSaved = (await pool.query("SELECT max(created_at) AS at FROM restaurant_orders WHERE company_id = $1 AND source = 'square'", [company.id])).rows[0].at;
      if (lastSaved) since = new Date(new Date(lastSaved).getTime() - 86400000);
    }
    await pool.query('UPDATE restaurant_import_jobs SET orders_since = $2 WHERE id = $1', [jobId, since]);
    await save('orders');

    // Square's customers, so each sale with one lands on that guest.
    var customers = {};
    var guestCache = {};
    if (client.listAllCustomers) {
      try {
        (await client.listAllCustomers()).forEach(function (c) { customers[c.id] = c; });
      } catch (e) {
        keepError({ type: 'customers', externalId: null, message: 'Square customers could not be read, so sales were saved without their guest: ' + e.message });
      }
    }

    var cursor = null;
    do {
      var page = await client.searchOrdersPage(locationIds, { cursor: cursor, since: since });
      for (var oi = 0; oi < page.orders.length; oi++) {
        var order = page.orders[oi];
        try {
          var guestId = await guestForOrder(company, orderMeta(order), customers, guestCache);
          await upsertOrder(ctx, company, order, cashierId, menuItemIdByVariation, variationRowIdByVariation, true, guestId);
          counts.ordersImported++;
          if (order.created_at) counts.lastOrderAt = order.created_at;
        } catch (e) {
          counts.ordersSkipped++;
          keepError({ type: 'order', externalId: order.id, message: e.message });
        }
      }
      counts.pages++;
      await save('orders');
      cursor = page.cursor;
    } while (cursor);

    // The orders customer service logged, matched to the sales just saved.
    try {
      await require('./restaurantCrm.service').autoLink(company.id, since ? { from: since.toISOString().slice(0, 10) } : {});
    } catch (e) {
      keepError({ type: 'guestOrders', externalId: null, message: 'Linking the order log to the sales failed: ' + e.message });
    }

    await save('done', ", status = 'done', finished_at = now()");
    await audit(pool, ctx, 'restaurant.square_import', 'restaurant_import_job', jobId,
      'Square import for ' + company.name + ': ' + counts.menuImported + ' menu item(s), ' + counts.photosImported + ' new picture(s) and ' + counts.ordersImported + ' order(s) saved' +
      (counts.menuSkipped + counts.ordersSkipped ? ', ' + (counts.menuSkipped + counts.ordersSkipped) + ' skipped' : '') + '.');
  } catch (e) {
    console.error('[restaurant import] ' + company.name + ' failed:', e);
    try {
      await pool.query("UPDATE restaurant_import_jobs SET status = 'failed', message = $2, finished_at = now(), heartbeat_at = now() WHERE id = $1",
        [jobId, e && e.message ? String(e.message).slice(0, 500) : 'The import stopped with an error.']);
      await save('failed');
    } catch (e2) { console.error('[restaurant import] could not record the failure:', e2); }
  }
}

module.exports = {
  startImport: startImport, jobStatus: jobStatus, setClientFactoryForTests: setClientFactoryForTests, STALE_MS: STALE_MS,
  // Exported for unit testing pure mapping logic without hitting Square's
  // real API — see test/restaurantSquareImport.test.js. requireCompany/
  // ensureImportCashier/upsertMenuItem/upsertOrder are also exported so a
  // one-off operational script can drive the exact same tested DB-write
  // logic from Square data fetched through a different transport (e.g. an
  // already-authorized MCP Square connector) when this environment's
  // network policy blocks the backend's own direct Square API calls.
  minorToMajor: minorToMajor, menuItemName: menuItemName, mapTenderType: mapTenderType,
  requireCompany: requireCompany, ensureImportCashier: ensureImportCashier,
  upsertMenuItem: upsertMenuItem, upsertGroupedMenuItem: upsertGroupedMenuItem,
  upsertOrder: upsertOrder, itemPresentAtLocation: itemPresentAtLocation, squarePictureId: squarePictureId,
  orderMeta: orderMeta, guestForOrder: guestForOrder
};
