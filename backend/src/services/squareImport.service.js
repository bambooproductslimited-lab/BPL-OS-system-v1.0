var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { insertLineItems, todayISO } = require('../utils/documents');
var square = require('./square.service');

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

async function upsertCatalogVariation(item, v) {
  var vd = v.item_variation_data;
  var name = item.item_data.name + (vd.name && vd.name !== 'Regular' ? ' - ' + vd.name : '');
  var code = (vd.sku || '').trim().toUpperCase() || ('SQ-' + v.id.replace(/[^A-Za-z0-9]/g, '').slice(-10).toUpperCase());
  var unitPrice = minorToMajor(vd.price_money);
  var active = !(item.is_deleted || v.is_deleted);
  var res = await pool.query(
    "INSERT INTO catalog_items (name, code, description, category, unit, default_qty, unit_price, cost_price, tax_rate_id, active, external_id, source) " +
    "VALUES ($1,$2,$3,'','each',1,$4,0,'tx_zero',$5,$6,'square') " +
    "ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET " +
    "name = EXCLUDED.name, code = EXCLUDED.code, unit_price = EXCLUDED.unit_price, active = EXCLUDED.active " +
    "RETURNING id, code",
    [name, code, (item.item_data.description || '').trim(), unitPrice, active, v.id]
  );
  return res.rows[0];
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
      "customer_id = EXCLUDED.customer_id, subtotal = EXCLUDED.subtotal, grand_total = EXCLUDED.grand_total, issued_at = EXCLUDED.issued_at " +
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

async function runImport(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');

  var summary = {
    customers: { imported: 0, skipped: 0 }, catalogItems: { imported: 0, skipped: 0 },
    invoices: { imported: 0, skipped: 0 }, payments: { imported: 0, skipped: 0 }, errors: []
  };

  var walkinId = await ensureWalkinCustomer();

  var squareCustomers = await square.listAllCustomers();
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
  }

  var squareItems = await square.listAllCatalogItems();
  var catalogByVariationId = {};
  for (var it = 0; it < squareItems.length; it++) {
    var item = squareItems[it];
    var variations = (item.item_data && item.item_data.variations) || [];
    for (var vi = 0; vi < variations.length; vi++) {
      var v = variations[vi];
      try {
        catalogByVariationId[v.id] = await upsertCatalogVariation(item, v);
        summary.catalogItems.imported++;
      } catch (e) {
        summary.catalogItems.skipped++;
        summary.errors.push({ type: 'catalogItem', externalId: v.id, message: e.message });
      }
    }
  }

  var locations = await square.listLocations();
  var locationIds = locations.map(function (l) { return l.id; });
  if (!locationIds.length) fail('invalid', 'Square returned no locations for this account — nothing to import.');

  var orders = await square.searchAllOrders(locationIds);
  var invoiceIdByExternal = {};
  for (var oi = 0; oi < orders.length; oi++) {
    var order = orders[oi];
    try {
      var custId = (order.customer_id && customerIdByExternal[order.customer_id]) || walkinId;
      var invoiceId = await upsertInvoiceFromOrder(ctx, order, custId, catalogByVariationId);
      invoiceIdByExternal[order.id] = invoiceId;
      summary.invoices.imported++;
    } catch (e) {
      summary.invoices.skipped++;
      summary.errors.push({ type: 'order', externalId: order.id, message: e.message });
    }
  }

  for (var li = 0; li < locationIds.length; li++) {
    var sqInvoices = await square.listAllInvoices(locationIds[li]);
    for (var ii = 0; ii < sqInvoices.length; ii++) {
      var inv = sqInvoices[ii];
      try {
        var invCustId = (inv.primary_recipient && inv.primary_recipient.customer_id && customerIdByExternal[inv.primary_recipient.customer_id]) || walkinId;
        var resultId = await upsertInvoiceFromSquareInvoice(ctx, inv, invoiceIdByExternal, invCustId);
        invoiceIdByExternal[inv.order_id || inv.id] = resultId;
      } catch (e) {
        summary.errors.push({ type: 'squareInvoice', externalId: inv.id, message: e.message });
      }
    }
  }

  var paymentsByInvoice = {};
  for (var pl = 0; pl < locationIds.length; pl++) {
    var sqPayments = await square.listAllPayments(locationIds[pl]);
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
  }

  await reconcileSquareInvoiceBalances();

  return summary;
}

module.exports = {
  runImport: runImport,
  // Exported for unit testing pure mapping logic without hitting Square's
  // real API — see test/squareImport.test.js.
  minorToMajor: minorToMajor, squareCustomerName: squareCustomerName, squareAddressLine: squareAddressLine,
  mapPaymentMethod: mapPaymentMethod, buildOrderLineItems: buildOrderLineItems
};
