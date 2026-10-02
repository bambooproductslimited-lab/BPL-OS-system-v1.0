var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { insertLineItems, todayISO } = require('../utils/documents');
var square = require('./square.service');
var fileStore = require('../lib/fileStore');
var config = require('../config');

// One-time historical import from Square into Customers, Catalog and
// Invoices (unifying Square's separate Orders and Invoices APIs, since for
// already-completed sales they represent the same underlying fact — see
// PROJECT discussion) & Payments. Gated on settings.manage, the same
// permission the Integrations page itself requires, since this is an
// admin-triggered one-time data migration, not a regular commercial write.
//
// Idempotency: every row this importer writes carries external_id/source
// (migration 0026), so re-running it (e.g. after fixing a Square-side data
// issue) updates the same rows instead of duplicating them, mirroring the
// marketing_posts/marketing_inbox_items pattern already used for synced
// social + WhatsApp data.
//
// Square's Money.amount is an integer in the smallest unit of whatever
// currency the seller's Square account is configured in; per the business
// owner, that number is already the correct Ghana Cedi amount (Square's own
// "$" display is just how their UI happens to render it for this account),
// so the only conversion here is dividing by 100 — never a currency
// exchange.
function minorToMajor(money) {
  return money && typeof money.amount === 'number' ? Math.round(money.amount) / 100 : 0;
}

function squareCustomerName(sc) {
  if (sc.company_name) return sc.company_name;
  var parts = [sc.given_name, sc.family_name].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return sc.email_address || sc.phone_number || 'Square Customer';
}

function squareAddressLine(a) {
  if (!a) return '';
  return [a.address_line_1, a.address_line_2, a.locality, a.administrative_district_level_1, a.postal_code, a.country]
    .filter(Boolean).join(', ');
}

async function ensureWalkinCustomer() {
  var res = await pool.query(
    "INSERT INTO customers (name, contact_person, email, phone, address, category, status, notes, external_id, source) " +
    "VALUES ('Square POS — Walk-in Customer','','','','','active','active','Placeholder for Square sales with no customer attached.','square-walkin','square') " +
    "ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET name = EXCLUDED.name RETURNING id"
  );
  return res.rows[0].id;
}

async function upsertCustomer(sc) {
  var res = await pool.query(
    "INSERT INTO customers (name, contact_person, email, phone, address, category, status, notes, external_id, source) " +
    "VALUES ($1,$2,$3,$4,$5,'active','active',$6,$7,'square') " +
    "ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET " +
    "name = EXCLUDED.name, contact_person = EXCLUDED.contact_person, email = EXCLUDED.email, phone = EXCLUDED.phone, address = EXCLUDED.address " +
    "RETURNING id",
    [
      squareCustomerName(sc), (sc.nickname || '').trim(), (sc.email_address || '').trim(), (sc.phone_number || '').trim(),
      squareAddressLine(sc.address), (sc.note || '').trim(), sc.id
    ]
  );
  return res.rows[0].id;
}

// The catalogue is updated in place, keyed by Square's ids: an item or
// variation already here is updated (name, price, category…), a new one is
// added, and one no longer in Square is made inactive — never deleted. It
// used to be wiped and re-created on every run, which threw away
// everything added to it in Bamboo OS: photos, stock links, stock counts.
// What only Bamboo OS knows about an item (its photos, cost price, stock,
// the stock product it is linked to, its tax rate) is left alone.
async function retireMissingSquareCatalog(itemIds, variationIds) {
  var items = (await pool.query(
    "UPDATE catalog_items SET active = false WHERE source = 'square' AND active AND NOT (external_id = ANY($1::text[])) RETURNING id", [itemIds])).rowCount;
  var vars = (await pool.query(
    "UPDATE catalog_item_variations SET active = false WHERE source = 'square' AND active AND NOT (external_id = ANY($1::text[])) RETURNING id", [variationIds])).rowCount;
  return items + vars;
}

async function upsertCategory(cat) {
  var res = await pool.query(
    "INSERT INTO catalog_categories (name, external_id, source) VALUES ($1,$2,'square') " +
    "ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET name = EXCLUDED.name RETURNING id",
    [cat.category_data.name, cat.id]
  );
  return res.rows[0].id;
}

// Parent Item row — one per Square CatalogItem, keyed by the Square ITEM's
// own id (not a variation id, unlike the flat pre-redesign import).
async function upsertCatalogItem(item, categoryIdByExternal) {
  var squareCategoryId = item.item_data.categories && item.item_data.categories[0] && item.item_data.categories[0].id;
  var categoryId = (squareCategoryId && categoryIdByExternal[squareCategoryId]) || null;
  var active = !item.is_deleted;
  var res = await pool.query(
    "INSERT INTO catalog_items (name, description, category_id, tax_rate_id, active, external_id, source) " +
    "VALUES ($1,$2,$3,'tx_zero',$4,$5,'square') " +
    "ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET " +
    "name = EXCLUDED.name, description = EXCLUDED.description, category_id = EXCLUDED.category_id, active = EXCLUDED.active, source = 'square' " +
    "RETURNING id",
    [item.item_data.name, (item.item_data.description || '').trim(), categoryId, active, item.id]
  );
  return res.rows[0].id;
}

async function upsertVariation(itemRowId, v) {
  var vd = v.item_variation_data;
  var name = (vd.name || 'Regular').trim() || 'Regular';
  var code = (vd.sku || '').trim().toUpperCase() || ('SQ-' + v.id.replace(/[^A-Za-z0-9]/g, '').slice(-10).toUpperCase());
  var unitPrice = minorToMajor(vd.price_money);
  var active = !v.is_deleted;
  var res = await pool.query(
    "INSERT INTO catalog_item_variations (item_id, name, code, unit, default_qty, unit_price, cost_price, active, external_id, source) " +
    "VALUES ($1,$2,$3,'each',1,$4,0,$5,$6,'square') " +
    "ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET " +
    "item_id = EXCLUDED.item_id, name = EXCLUDED.name, code = EXCLUDED.code, unit_price = EXCLUDED.unit_price, active = EXCLUDED.active, source = 'square' " +
    "RETURNING id, code",
    [itemRowId, name, code, unitPrice, active, v.id]
  );
  return res.rows[0];
}

// The item's Square pictures (and its variations'), each once: a picture
// already brought in is known by its Square image id. Square's first
// picture is the cover when the item has no photos yet; otherwise they go
// after the ones already there. Up to the catalogue's 12 photos an item.
var MAX_PHOTOS = 12;
async function importItemImages(client, itemRowId, itemName, pictures, imageById, summary, beat) {
  if (!pictures.length) return;
  var have = (await pool.query(
    'SELECT count(*)::int AS n, coalesce(max(position), -1) AS top, coalesce(array_agg(square_image_id) FILTER (WHERE square_image_id IS NOT NULL), ARRAY[]::text[]) AS sq ' +
    'FROM catalog_item_photos WHERE item_id = $1', [itemRowId])).rows[0];
  var count = have.n, top = have.top, known = have.sq;
  var slug = String(itemName || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
  for (var i = 0; i < pictures.length; i++) {
    var pic = pictures[i];
    if (known.indexOf(pic.imageId) >= 0) continue;
    var img = imageById[pic.imageId];
    var url = img && img.image_data && img.image_data.url;
    if (!url) continue;
    if (count >= MAX_PHOTOS) { summary.photos.skipped++; continue; }
    try {
      var file = await client.downloadImage(url);
      var key = await fileStore.put('catalog-' + slug + '.jpg', file.buffer, file.contentType);
      try {
        await pool.query(
          'INSERT INTO catalog_item_photos (item_id, variation_id, photo_key, caption, position, square_image_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [itemRowId, pic.variationRowId || null, key, String((img.image_data && img.image_data.caption) || '').slice(0, 200), top + 1, pic.imageId]);
      } catch (err) { await fileStore.del(key); throw err; }
      top++; count++; known.push(pic.imageId);
      summary.photos.imported++;
    } catch (e) {
      summary.photos.skipped++;
      summary.errors.push({ type: 'catalogImage', externalId: pic.imageId, message: e.message });
    }
    if (beat) await beat();
  }
}

function buildOrderLineItems(order, catalogByVariationId) {
  var lineItems = order.line_items || [];
  if (!lineItems.length) {
    return [{ itemNo: '', description: 'Square order total', qty: 1, unit: 'each', unitPrice: minorToMajor(order.total_money), discount: 0, discountType: 'fixed', taxRate: 0 }];
  }
  return lineItems.map(function (li) {
    var qty = Math.max(0.01, Number(li.quantity) || 1);
    var lineTotal = minorToMajor(li.total_money);
    var unitPrice = li.base_price_money ? minorToMajor(li.base_price_money) : (lineTotal / qty);
    var matched = li.catalog_object_id && catalogByVariationId[li.catalog_object_id];
    return {
      itemNo: matched ? matched.code : '',
      description: li.name || 'Item',
      qty: qty, unit: 'each', unitPrice: Math.round(unitPrice * 100) / 100,
      discount: 0, discountType: 'fixed', taxRate: 0
    };
  });
}

// Upserts one invoice row from a Square Order (state COMPLETED). Payments
// and their derived status/balance are reconciled separately, once, after
// every payment has been imported — see reconcileSquareInvoiceBalances().
async function upsertInvoiceFromOrder(ctx, order, customerId, catalogByVariationId) {
  var grandTotal = minorToMajor(order.total_money);
  var items = buildOrderLineItems(order, catalogByVariationId);
  var issuedAt = (order.created_at || '').slice(0, 10) || todayISO();
  var invoiceNo = 'SQ-' + order.id;

  return withTransaction(async function (client) {
    var res = await client.query(
      "INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, external_id, source) " +
      "VALUES ($1,$2,$3,0,0,$3,0,$3,'unpaid',$4,$4,$5,'square') " +
      "ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET " +
      "customer_id = EXCLUDED.customer_id, subtotal = EXCLUDED.subtotal, grand_total = EXCLUDED.grand_total, issued_at = EXCLUDED.issued_at, " +
      // Never due before it was issued: the date can move on a re-import.
      "due_date = GREATEST(invoices.due_date, EXCLUDED.issued_at) " +
      "RETURNING id",
      [invoiceNo, customerId, grandTotal, issuedAt, order.id]
    );
    var invoiceId = res.rows[0].id;
    await client.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id = $1", [invoiceId]);
    await insertLineItems(client, 'invoice', invoiceId, items);
    await audit(client, ctx, 'invoice.create', 'invoice', invoiceId, 'Imported from Square order ' + order.id + ' (GHS ' + grandTotal.toLocaleString() + ').');
    return invoiceId;
  });
}

// A Square Invoice for an order already imported just refines the invoice
// number to Square's own human-readable one; an invoice with no matching
// order (rare — an ad hoc Square invoice never tied to an Order) gets its
// own row with a single summary line item, since real line items only
// exist on the Order object.
async function upsertInvoiceFromSquareInvoice(ctx, inv, invoiceIdByExternal, customerId) {
  var extId = inv.order_id || inv.id;
  var existingId = invoiceIdByExternal[extId];
  var invoiceNo = inv.invoice_number ? 'SQ-' + inv.invoice_number : 'SQ-' + inv.id;

  if (existingId) {
    await pool.query('UPDATE invoices SET invoice_no = $1 WHERE id = $2 AND source = $3', [invoiceNo, existingId, 'square']);
    return existingId;
  }

  var grandTotal = minorToMajor(inv.payment_requests && inv.payment_requests[0] && inv.payment_requests[0].computed_amount_money);
  var issuedAt = (inv.sale_or_service_date || (inv.created_at || '').slice(0, 10)) || todayISO();
  return withTransaction(async function (client) {
    var res = await client.query(
      "INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, external_id, source) " +
      "VALUES ($1,$2,$3,0,0,$3,0,$3,'unpaid',$4,$4,$5,'square') " +
      "ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET invoice_no = EXCLUDED.invoice_no RETURNING id",
      [invoiceNo, customerId, grandTotal, issuedAt, extId]
    );
    var invoiceId = res.rows[0].id;
    await client.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id = $1", [invoiceId]);
    await insertLineItems(client, 'invoice', invoiceId, [{ itemNo: '', description: 'Square invoice ' + (inv.invoice_number || inv.id), qty: 1, unit: 'each', unitPrice: grandTotal, discount: 0, discountType: 'fixed', taxRate: 0 }]);
    await audit(client, ctx, 'invoice.create', 'invoice', invoiceId, 'Imported from Square invoice ' + (inv.invoice_number || inv.id) + '.');
    return invoiceId;
  });
}

function mapPaymentMethod(sourceType) {
  if (sourceType === 'CARD') return 'card';
  if (sourceType === 'CASH') return 'cash';
  if (sourceType === 'WALLET' || sourceType === 'SQUARE_ACCOUNT') return 'mobile_money';
  return 'bank_transfer';
}

// Payments for one invoice, imported in Square's own chronological order so
// each receipt's balance_after is a real running balance, not a guess.
async function importPaymentsForInvoice(ctx, invoiceId, payments) {
  var sorted = payments.slice().sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); });
  var invRes = await pool.query('SELECT grand_total FROM invoices WHERE id = $1', [invoiceId]);
  var grandTotal = Number(invRes.rows[0].grand_total);
  var baseRes = await pool.query("SELECT coalesce(sum(amount),0) AS total FROM payments WHERE invoice_id = $1 AND source <> 'square'", [invoiceId]);
  var running = Number(baseRes.rows[0].total);
  var imported = 0;

  for (var i = 0; i < sorted.length; i++) {
    var p = sorted[i];
    var amount = minorToMajor(p.amount_money);
    var date = (p.created_at || '').slice(0, 10) || todayISO();
    var method = mapPaymentMethod(p.source_type);
    var reference = p.receipt_number || p.id;

    var payRes = await pool.query(
      "INSERT INTO payments (invoice_id, customer_id, date, amount, currency, method, reference, received_by, notes, external_id, source) " +
      "VALUES ($1,(SELECT customer_id FROM invoices WHERE id=$1),$2,$3,'GHS',$4,$5,$6,'Imported from Square.',$7,'square') " +
      "ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET amount = EXCLUDED.amount, date = EXCLUDED.date, method = EXCLUDED.method " +
      "RETURNING id",
      [invoiceId, date, amount, method, reference, ctx.employee.id, p.id]
    );
    var paymentId = payRes.rows[0].id;
    running = Math.round((running + amount) * 100) / 100;

    var existingReceipt = await pool.query('SELECT id FROM receipts WHERE payment_id = $1', [paymentId]);
    if (!existingReceipt.rows[0]) {
      var receiptNo = 'SQ-RCT-' + p.id;
      var balanceAfter = Math.max(Math.round((grandTotal - running) * 100) / 100, 0);
      await pool.query(
        'INSERT INTO receipts (receipt_no, payment_id, invoice_id, customer_id, date, amount, method, reference, balance_after, received_by) ' +
        'VALUES ($1,$2,$3,(SELECT customer_id FROM invoices WHERE id=$3),$4,$5,$6,$7,$8,$9)',
        [receiptNo, paymentId, invoiceId, date, amount, method, reference, balanceAfter, ctx.employee.id]
      );
    }
    imported++;
  }
  await audit(pool, ctx, 'payment.record', 'invoice', invoiceId, 'Imported ' + imported + ' Square payment(s).');
  return imported;
}

// Recomputes amount_paid/balance_due/status/paid_at for every Square-sourced
// invoice from its actual attached payments — the same "status follows the
// money" rule invoices.service.js's recordPayment enforces for manual
// payments, applied once at the end so it's correct however many times this
// importer has been re-run.
async function reconcileSquareInvoiceBalances() {
  await pool.query(
    "UPDATE invoices i SET " +
    "amount_paid = p.total, " +
    "balance_due = GREATEST(i.grand_total - p.total, 0), " +
    "status = CASE WHEN i.grand_total - p.total <= 0.01 THEN 'paid' WHEN p.total > 0 THEN 'partially_paid' ELSE 'unpaid' END, " +
    "paid_at = CASE WHEN i.grand_total - p.total <= 0.01 THEN coalesce(i.paid_at, (SELECT max(date) FROM payments WHERE invoice_id = i.id)) ELSE NULL END " +
    "FROM (SELECT invoice_id, coalesce(sum(amount),0) AS total FROM payments GROUP BY invoice_id) p " +
    "WHERE p.invoice_id = i.id AND i.source = 'square'"
  );
}

// The import itself. client is the Square API client (a fake one in tests);
// progress(phase, summary) is called as it goes, so a background job can
// record how far it has got and show it's still alive.
async function doImport(ctx, client, progress) {
  var report = progress || async function () {};
  // Progress is saved at least every BEAT_MS, not only every 100 records:
  // a step that runs long (downloading Square's pictures) must keep showing
  // it is alive, or the page takes it for a job stopped by a restart.
  var lastBeat = 0;
  progress = function (phase, s) { lastBeat = Date.now(); return report(phase, s); };
  function beat(phase) { return Date.now() - lastBeat >= BEAT_MS ? progress(phase, summary) : null; }
  var summary = {
    customers: { imported: 0, skipped: 0 }, catalogItems: { imported: 0, skipped: 0 }, photos: { imported: 0, skipped: 0 },
    invoices: { imported: 0, skipped: 0 }, payments: { imported: 0, skipped: 0 }, retired: 0, errors: []
  };

  var walkinId = await ensureWalkinCustomer();

  await progress('customers', summary);
  var squareCustomers = await client.listAllCustomers();
  var customerIdByExternal = {};
  for (var ci = 0; ci < squareCustomers.length; ci++) {
    var sc = squareCustomers[ci];
    try {
      customerIdByExternal[sc.id] = await upsertCustomer(sc);
      summary.customers.imported++;
    } catch (e) {
      summary.customers.skipped++;
      summary.errors.push({ type: 'customer', externalId: sc.id, message: e.message });
    }
    if (ci % 100 === 99) await progress('customers', summary); else await beat('customers');
  }

  await progress('catalog', summary);
  var squareObjects = await client.listAllCatalogItems();
  var squareCategories = squareObjects.filter(function (o) { return o.type === 'CATEGORY'; });
  var squareItems = squareObjects.filter(function (o) { return o.type === 'ITEM'; });
  var imageById = {};
  squareObjects.forEach(function (o) { if (o.type === 'IMAGE') imageById[o.id] = o; });

  var categoryIdByExternal = {};
  for (var cati = 0; cati < squareCategories.length; cati++) {
    var cat = squareCategories[cati];
    try {
      categoryIdByExternal[cat.id] = await upsertCategory(cat);
    } catch (e) {
      summary.errors.push({ type: 'category', externalId: cat.id, message: e.message });
    }
  }

  var catalogByVariationId = {};
  var seenItems = [], seenVariations = [];
  for (var it = 0; it < squareItems.length; it++) {
    var item = squareItems[it];
    var variations = (item.item_data && item.item_data.variations) || [];
    if (!variations.length) continue; // an item with no variations isn't sellable — nothing to import
    seenItems.push(item.id);
    variations.forEach(function (v0) { seenVariations.push(v0.id); });
    try {
      var itemRowId = await upsertCatalogItem(item, categoryIdByExternal);
      var pictures = ((item.item_data && item.item_data.image_ids) || []).map(function (id) { return { imageId: id, variationRowId: null }; });
      for (var vi = 0; vi < variations.length; vi++) {
        var v = variations[vi];
        try {
          var vr = catalogByVariationId[v.id] = await upsertVariation(itemRowId, v);
          summary.catalogItems.imported++;
          ((v.item_variation_data && v.item_variation_data.image_ids) || []).forEach(function (id) { pictures.push({ imageId: id, variationRowId: vr.id }); });
        } catch (e) {
          summary.catalogItems.skipped++;
          summary.errors.push({ type: 'catalogVariation', externalId: v.id, message: e.message });
        }
      }
      if (client.downloadImage) await importItemImages(client, itemRowId, item.item_data.name, pictures, imageById, summary, function () { return beat('catalog'); });
    } catch (e) {
      summary.catalogItems.skipped += variations.length;
      summary.errors.push({ type: 'catalogItem', externalId: item.id, message: e.message });
    }
    if (it % 100 === 99) await progress('catalog', summary); else await beat('catalog');
  }
  summary.retired = await retireMissingSquareCatalog(seenItems, seenVariations);

  var locations = await client.listLocations();
  var locationIds = locations.map(function (l) { return l.id; });
  if (!locationIds.length) fail('invalid', 'Square returned no locations for this account — nothing to import.');

  // Orders a page at a time, oldest first, saved as each page arrives, so
  // memory stays small however long the history is.
  var invoiceIdByExternal = {};
  await progress('invoices', summary);
  var cursor = null;
  do {
    var page = await client.searchOrdersPage(locationIds, { cursor: cursor });
    for (var oi = 0; oi < page.orders.length; oi++) {
      var order = page.orders[oi];
      try {
        var custId = (order.customer_id && customerIdByExternal[order.customer_id]) || walkinId;
        var invoiceId = await upsertInvoiceFromOrder(ctx, order, custId, catalogByVariationId);
        invoiceIdByExternal[order.id] = invoiceId;
        summary.invoices.imported++;
      } catch (e) {
        summary.invoices.skipped++;
        summary.errors.push({ type: 'order', externalId: order.id, message: e.message });
      }
      await beat('invoices');
    }
    summary.pages = (summary.pages || 0) + 1;
    await progress('invoices', summary);
    cursor = page.cursor;
  } while (cursor);

  for (var li = 0; li < locationIds.length; li++) {
    var sqInvoices = await client.listAllInvoices(locationIds[li]);
    for (var ii = 0; ii < sqInvoices.length; ii++) {
      var inv = sqInvoices[ii];
      if (inv.status === 'DRAFT' || inv.status === 'CANCELED') continue; // never sent, or withdrawn — not a real sale
      try {
        var invCustId = (inv.primary_recipient && inv.primary_recipient.customer_id && customerIdByExternal[inv.primary_recipient.customer_id]) || walkinId;
        var resultId = await upsertInvoiceFromSquareInvoice(ctx, inv, invoiceIdByExternal, invCustId);
        invoiceIdByExternal[inv.order_id || inv.id] = resultId;
      } catch (e) {
        summary.errors.push({ type: 'squareInvoice', externalId: inv.id, message: e.message });
      }
    }
  }

  await progress('payments', summary);
  var paymentsByInvoice = {};
  for (var pl = 0; pl < locationIds.length; pl++) {
    var sqPayments = await client.listAllPayments(locationIds[pl]);
    for (var pi = 0; pi < sqPayments.length; pi++) {
      var p = sqPayments[pi];
      if (p.status !== 'COMPLETED') continue;
      var mappedInvoiceId = p.order_id && invoiceIdByExternal[p.order_id];
      if (!mappedInvoiceId) {
        summary.payments.skipped++;
        summary.errors.push({ type: 'payment', externalId: p.id, message: 'No imported invoice found for order ' + p.order_id + '.' });
        continue;
      }
      (paymentsByInvoice[mappedInvoiceId] = paymentsByInvoice[mappedInvoiceId] || []).push(p);
    }
  }
  var invoiceIds = Object.keys(paymentsByInvoice);
  for (var pgi = 0; pgi < invoiceIds.length; pgi++) {
    try {
      summary.payments.imported += await importPaymentsForInvoice(ctx, invoiceIds[pgi], paymentsByInvoice[invoiceIds[pgi]]);
    } catch (e) {
      summary.errors.push({ type: 'paymentGroup', externalId: invoiceIds[pgi], message: e.message });
    }
    if (pgi % 100 === 99) await progress('payments', summary); else await beat('payments');
  }

  await reconcileSquareInvoiceBalances();

  return summary;
}


// ── the import as a background job ─────────────────────────────────
// Pressing "Run Square import" on the Integrations page starts a job and
// answers at once; the work runs after the response and the page asks
// jobStatus() for progress. Everything is saved by its Square id, so a job
// stopped by a server restart is simply run again.

var STALE_MS = 3 * 60 * 1000;
var BEAT_MS = 10 * 1000;
// The job this server is running right now. While it runs, it is running —
// however old its last saved progress — and a second one can't start.
var activeJobId = null;
var MAX_ERRORS_KEPT = 50;
var clientFactory = function () { return square; };
// Tests hand in a fake Square client instead of the real API.
function setClientFactoryForTests(fn) { clientFactory = fn || function () { return square; }; }
function setBeatForTests(ms) { BEAT_MS = ms == null ? 10 * 1000 : ms; }

function rowToJob(r) {
  if (!r) return null;
  var stale = r.status === 'running' && r.id !== activeJobId && Date.now() - new Date(r.heartbeat_at).getTime() > STALE_MS;
  return {
    id: r.id, status: stale ? 'interrupted' : r.status, phase: r.phase,
    customers: { imported: r.customers_imported, skipped: r.customers_skipped },
    catalogItems: { imported: r.catalog_imported, skipped: r.catalog_skipped },
    photos: { imported: r.photos_imported || 0, skipped: r.photos_skipped || 0 },
    invoices: { imported: r.invoices_imported, skipped: r.invoices_skipped },
    payments: { imported: r.payments_imported, skipped: r.payments_skipped },
    pagesDone: r.pages_done, errorCount: r.error_count, errors: r.errors || [], message: r.message || null,
    startedAt: r.started_at, heartbeatAt: r.heartbeat_at, finishedAt: r.finished_at
  };
}
async function latestJob() {
  return (await pool.query('SELECT * FROM square_import_jobs ORDER BY started_at DESC LIMIT 1')).rows[0] || null;
}

// The latest import, with its progress.
async function jobStatus(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  return rowToJob(await latestJob());
}

async function startImport(ctx, opts) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  opts = opts || {};
  var client = clientFactory();
  if (client === square && !config.square.configured) fail('invalid', 'Square is not configured — set SQUARE_ACCESS_TOKEN on the server.');
  var last = await latestJob();
  if (activeJobId || (last && rowToJob(last).status === 'running')) fail('conflict', 'A Square import is already running. It carries on in the background — watch its progress here.');
  if (last && last.status === 'running') {
    await pool.query("UPDATE square_import_jobs SET status = 'failed', message = 'Stopped when the server restarted.', finished_at = now() WHERE id = $1", [last.id]);
  }
  var job = (await pool.query('INSERT INTO square_import_jobs (started_by) VALUES ($1) RETURNING *', [ctx.employee ? ctx.employee.id : null])).rows[0];
  await audit(pool, ctx, 'square.import.start', 'square_import_job', job.id, 'Started a Square import.');
  var run = runJob(ctx, job.id, client);
  if (opts.wait) await run; // tests wait for the job; the web request never does
  else run.catch(function (e) { console.error('[square import] job ' + job.id + ' crashed:', e); });
  return rowToJob((await pool.query('SELECT * FROM square_import_jobs WHERE id = $1', [job.id])).rows[0]);
}

async function runJob(ctx, jobId, client) {
  activeJobId = jobId;
  try { await runJobInner(ctx, jobId, client); } finally { if (activeJobId === jobId) activeJobId = null; }
}
async function runJobInner(ctx, jobId, client) {
  async function save(phase, s, extra) {
    await pool.query(
      'UPDATE square_import_jobs SET phase = $2, customers_imported = $3, customers_skipped = $4, catalog_imported = $5, catalog_skipped = $6, ' +
      'invoices_imported = $7, invoices_skipped = $8, payments_imported = $9, payments_skipped = $10, pages_done = $11, error_count = $12, errors = $13, ' +
      'photos_imported = $14, photos_skipped = $15, heartbeat_at = now()' +
      (extra || '') + ' WHERE id = $1',
      [jobId, phase, s.customers.imported, s.customers.skipped, s.catalogItems.imported, s.catalogItems.skipped,
        s.invoices.imported, s.invoices.skipped, s.payments.imported, s.payments.skipped, s.pages || 0, s.errors.length, JSON.stringify(s.errors.slice(0, MAX_ERRORS_KEPT)),
        s.photos ? s.photos.imported : 0, s.photos ? s.photos.skipped : 0]);
  }
  var last = null;
  try {
    var summary = await doImport(ctx, client, function (phase, s) { last = s; return save(phase, s); });
    await save('done', summary, ", status = 'done', finished_at = now()");
    await audit(pool, ctx, 'square.import', 'square_import_job', jobId,
      'Square import: ' + summary.customers.imported + ' customer(s), ' + summary.catalogItems.imported + ' catalogue item(s), ' + summary.photos.imported + ' picture(s), ' +
      summary.invoices.imported + ' invoice(s) and ' + summary.payments.imported + ' payment(s) saved' + (summary.errors.length ? ', ' + summary.errors.length + ' with errors' : '') + '.');
  } catch (e) {
    console.error('[square import] failed:', e);
    try {
      if (last) await save('failed', last);
      await pool.query("UPDATE square_import_jobs SET status = 'failed', message = $2, finished_at = now(), heartbeat_at = now() WHERE id = $1",
        [jobId, e && e.message ? String(e.message).slice(0, 500) : 'The import stopped with an error.']);
    } catch (e2) { console.error('[square import] could not record the failure:', e2); }
  }
}

module.exports = {
  startImport: startImport, jobStatus: jobStatus, setClientFactoryForTests: setClientFactoryForTests, setBeatForTests: setBeatForTests, STALE_MS: STALE_MS,
  // Exported for unit testing pure mapping logic without hitting Square's
  // real API — see test/squareImport.test.js.
  minorToMajor: minorToMajor, squareCustomerName: squareCustomerName, squareAddressLine: squareAddressLine,
  mapPaymentMethod: mapPaymentMethod, buildOrderLineItems: buildOrderLineItems
};
