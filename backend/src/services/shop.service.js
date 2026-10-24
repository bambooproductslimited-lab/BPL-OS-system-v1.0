var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { internationalNumber } = require('../utils/phone');
var config = require('../config');

// Bamboo Products' online shop (migration 0187; settings.shop) — Square
// Online's store, on the OS's own address at /shop: the catalogue's items in
// the categories put on it, with their photos and variations, a basket and
// an order. The order makes (or finds, by phone or email) the customer, an
// invoice for what was ordered at today's prices, and the invoice's link
// to pay on: by card or Mobile Money through Paystack when Bamboo Products'
// account is set up (invoicePay), else by the bank details on it. Staff
// follow the orders on the Online shop page and mark them ready and done.

var DEFAULTS = { on: false, title: 'Bamboo Products', intro: '', categories: [], delivery: true, pickup: true, pickupAddress: '', deliveryNote: '' };
var STATUSES = ['new', 'ready', 'done', 'cancelled'];
var MAX_LINES = 30;
var PER_IP_HOUR = 6;
var ctxShop = { can: function () { return true; }, user: { id: null }, employee: { id: null, first_name: 'Online shop', last_name: '' } };

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function isEmail(v) { return /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i.test(String(v || '')); }
function displayName(item, variation) { return variation && variation !== 'Regular' ? item + ' — ' + variation : item; }

async function settingsOf(db) {
  var s = ((await (db || pool).query('SELECT shop FROM settings WHERE id = 1')).rows[0] || {}).shop || {};
  return {
    on: !!s.on, title: text(s.title, 80) || DEFAULTS.title, intro: text(s.intro, 400), categories: Array.isArray(s.categories) ? s.categories.filter(function (c) { return /^[0-9a-f-]{36}$/i.test(c); }) : [],
    delivery: s.delivery !== false, pickup: s.pickup !== false, pickupAddress: text(s.pickupAddress, 200), deliveryNote: text(s.deliveryNote, 300)
  };
}

// What the shop sells: active items (in its categories, when it has some)
// with at least one active variation that has a price.
async function visibleItems(s) {
  var args = [];
  var where = 'i.active = true';
  if (s.categories.length) { args.push(s.categories); where += ' AND i.category_id = ANY($1::uuid[])'; }
  var rows = (await pool.query(
    'SELECT i.id, i.name, i.description, i.category_id, i.tax_rate_id, c.name AS category_name, ' +
    "coalesce((SELECT json_agg(json_build_object('id', v.id, 'name', v.name, 'code', v.code, 'unit', v.unit, 'price', v.unit_price, 'stock', v.stock_qty, 'options', v.option_values, 'productId', v.product_id) ORDER BY v.position, v.name) " +
    '  FROM catalog_item_variations v WHERE v.item_id = i.id AND v.active AND v.unit_price > 0), \'[]\') AS variations, ' +
    "coalesce((SELECT json_agg(json_build_object('id', p.id, 'variationId', p.variation_id) ORDER BY p.position, p.created_at) FROM catalog_item_photos p WHERE p.item_id = i.id), '[]') AS photos, " +
    "coalesce((SELECT json_agg(json_build_object('name', o.name, 'choices', o.choices) ORDER BY o.sort_order) FROM catalog_item_options o WHERE o.item_id = i.id), '[]') AS options " +
    'FROM catalog_items i LEFT JOIN catalog_categories c ON c.id = i.category_id WHERE ' + where + ' ORDER BY c.name NULLS LAST, i.name', args)).rows;
  return rows.filter(function (r) { return r.variations.length; });
}

// GET /api/shop — the shop's page: its words, the categories, the items.
async function view() {
  var s = await settingsOf();
  if (!s.on) fail('notfound', 'The online shop is closed for now.');
  var items = await visibleItems(s);
  var cats = [];
  items.forEach(function (r) { var n = r.category_name || 'More'; if (cats.indexOf(n) < 0) cats.push(n); });
  return {
    shop: { title: s.title, intro: s.intro, delivery: s.delivery, pickup: s.pickup, pickupAddress: s.pickupAddress, deliveryNote: s.deliveryNote, currency: 'GHS',
      payOnline: require('./invoicePay.service').configured() },
    categories: cats,
    items: items.map(function (r) {
      return {
        id: r.id, name: r.name, description: r.description || '', category: r.category_name || 'More', options: r.options,
        photos: r.photos.map(function (p) { return { id: p.id, variationId: p.variationId || null }; }),
        variations: r.variations.map(function (v) { return { id: v.id, name: v.name === 'Regular' ? '' : v.name, unit: v.unit || 'each', price: round2(v.price), options: v.options || {} }; })
      };
    })
  };
}

// GET /api/shop/photos/:id — a photo of an item on the shop (and no other).
async function photoKey(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('notfound', 'Photo not found.');
  var s = await settingsOf();
  if (!s.on) fail('notfound', 'Photo not found.');
  var r = (await pool.query('SELECT p.photo_key, i.category_id, i.active FROM catalog_item_photos p JOIN catalog_items i ON i.id = p.item_id WHERE p.id = $1', [id])).rows[0];
  if (!r || !r.active || (s.categories.length && s.categories.indexOf(r.category_id) < 0)) fail('notfound', 'Photo not found.');
  return r.photo_key;
}

var placedBy = new Map();
function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (placedBy.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Too many orders from here in the last hour. Call us instead.');
  list.push(now);
  placedBy.set(key, list);
  if (placedBy.size > 5000) placedBy.clear();
}

// The customer by their phone or email (the CRM's identities, then the
// customer's own fields), else a new one: a lead from the shop.
async function customerFor(client, p) {
  var inbox = require('./crmInbox.service');
  var ids = [inbox.normIdentity({ kind: 'phone', value: p.phone }), p.email ? inbox.normIdentity({ kind: 'email', value: p.email }) : null].filter(Boolean);
  var found = await inbox.findCustomerByIdentities(client, ids);
  if (!found && p.email) found = ((await client.query("SELECT id FROM customers WHERE lower(email) = $1 AND status = 'active' ORDER BY created_at LIMIT 1", [p.email])).rows[0] || {}).id;
  if (found) {
    await client.query("UPDATE customers SET email = CASE WHEN email = '' THEN $2 ELSE email END, address = CASE WHEN address = '' THEN $3 ELSE address END WHERE id = $1", [found, p.email, p.address]);
  } else {
    var companyId = await inbox.crmCompanyId();
    found = (await client.query(
      "INSERT INTO customers (name, phone, email, address, category, source, origin_channel, company_id) VALUES ($1,$2,$3,$4,'lead','crm','shop',$5) RETURNING id",
      [p.name, '+' + internationalNumber(p.phone), p.email, p.address, companyId])).rows[0].id;
  }
  await inbox.addIdentities(client, found, ids);
  return found;
}

// POST /api/shop/orders { name, phone, email, fulfilment: delivery|pickup,
// address, note, lines: [{ variationId, qty }], website (left empty: a
// form robot fills it) } — the order, its invoice and the link to pay it.
async function place(p, ip) {
  p = p || {};
  var s = await settingsOf();
  if (!s.on) fail('conflict', 'The online shop is closed for now.');
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  var name = text(p.name, 120);
  if (name.length < 2) fail('invalid', 'Type your name.');
  var phone = text(p.phone, 30);
  if (!internationalNumber(phone)) fail('invalid', 'Type a phone number we can call, e.g. 024 412 3456.');
  var email = text(p.email, 160).toLowerCase();
  if (email && !isEmail(email)) fail('invalid', 'That email address does not look right.');
  var fulfilment = p.fulfilment === 'pickup' ? 'pickup' : p.fulfilment === 'delivery' ? 'delivery' : fail('invalid', 'Delivery or pickup?');
  if ((fulfilment === 'delivery' && !s.delivery) || (fulfilment === 'pickup' && !s.pickup)) fail('invalid', fulfilment === 'delivery' ? 'We do not deliver from the shop: choose pickup.' : 'Pickup is not offered: choose delivery.');
  var address = text(p.address, 300);
  if (fulfilment === 'delivery' && address.length < 5) fail('invalid', 'Where should we deliver? Type the address or a landmark.');
  var note = text(p.note, 500);
  var want = Array.isArray(p.lines) ? p.lines : [];
  if (!want.length) fail('invalid', 'Your basket is empty.');
  if (want.length > MAX_LINES) fail('invalid', 'At most ' + MAX_LINES + ' different items in one order.');

  // Priced from the catalogue as it is now.
  var items = await visibleItems(s);
  var byVar = {};
  items.forEach(function (it) { it.variations.forEach(function (v) { byVar[v.id] = { item: it, v: v }; }); });
  var commercial = (await pool.query('SELECT commercial FROM settings WHERE id = 1')).rows[0].commercial || {};
  var taxOf = function (id) { var t = (commercial.taxRates || []).find(function (x) { return x.id === id; }); return t ? Number(t.rate) : 0; };
  var lines = want.map(function (l) {
    var hit = byVar[String((l || {}).variationId || '')];
    if (!hit) fail('conflict', 'Something in your basket is no longer sold. Take it out and try again.');
    var qty = Number(l.qty);
    if (!(Number.isInteger(qty) && qty >= 1 && qty <= 999)) fail('invalid', 'Each quantity is a whole number from 1 to 999.');
    return { variationId: hit.v.id, itemNo: hit.v.code || '', description: displayName(hit.item.name, hit.v.name).slice(0, 160), qty: qty, unit: hit.v.unit || 'each',
      unitPrice: round2(hit.v.price), taxRate: taxOf(hit.item.tax_rate_id), productId: hit.v.productId || null };
  });
  throttle(ip);

  var customerId = await withTransaction(function (client) { return customerFor(client, { name: name, phone: phone, email: email, address: fulfilment === 'delivery' ? address : '' }); });
  var n = Number((await pool.query('SELECT count(*) AS n FROM shop_orders')).rows[0].n) + 1001;
  var orderNo = 'SHOP-' + n;
  var inv = await require('./invoices.service').createManual(ctxShop, {
    customerId: customerId, currency: 'GHS', items: lines,
    notes: 'Online shop order ' + orderNo + ': ' + (fulfilment === 'delivery' ? 'delivery to ' + address : 'pickup' + (s.pickupAddress ? ' at ' + s.pickupAddress : '')) + (note ? '. ' + note : '') + '.'
  });
  var link = await require('./shares.service').issueLink('invoice', inv.id, 30, null);
  var share = (await pool.query('SELECT id FROM document_shares WHERE token = $1', [link.token])).rows[0];
  var row = null;
  for (var tries = 0; tries < 5 && !row; tries++) {
    try {
      row = (await pool.query(
        'INSERT INTO shop_orders (order_no, customer_id, invoice_id, share_id, name, phone, email, fulfilment, address, note, lines, total, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
        ['SHOP-' + (n + tries), customerId, inv.id, share.id, name, '+' + internationalNumber(phone), email, fulfilment, fulfilment === 'delivery' ? address : '', note,
          JSON.stringify(lines.map(function (l) { return { variationId: l.variationId, description: l.description, qty: l.qty, unitPrice: l.unitPrice }; })), inv.grandTotal, String(ip || '').slice(0, 60)])).rows[0];
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  if (!row) fail('conflict', 'Could not number the order. Try again.');
  if (row.order_no !== orderNo) await pool.query('UPDATE invoices SET notes = replace(notes, $2, $3) WHERE id = $1', [inv.id, orderNo, row.order_no]);
  await audit(pool, ctxShop, 'shop.order', 'shop_order', row.id, row.order_no + ' from ' + name + ' (' + inv.invoiceNo + ', GHS ' + round2(inv.grandTotal).toFixed(2) + ').');

  // Whoever runs the invoices is told.
  var holders = await require('./staffAlerts.service').holdersOf(['invoice.manage']);
  for (var i = 0; i < holders.length; i++) {
    await notify(pool, holders[i].employee_id, '🛍️ New shop order ' + row.order_no, name + ' · GHS ' + round2(inv.grandTotal).toFixed(2) + ' · ' + (fulfilment === 'delivery' ? 'delivery' : 'pickup'), '/shop-orders?open=' + row.id);
  }
  var url = config.bplSiteUrl + '/share/' + link.token;
  // And the customer, when they gave an email.
  if (email) {
    try {
      var mail = require('./mail.service');
      if (mail.configured()) {
        var words = 'Thank you, ' + name.split(' ')[0] + '! We have your order ' + row.order_no + ' (GHS ' + round2(inv.grandTotal).toFixed(2) + '). Its invoice ' + inv.invoiceNo + ', to see and pay: ' + url;
        await mail.send({ to: email, subject: 'Your order ' + row.order_no + ' from Bamboo Products', fromName: 'Bamboo Products', text: words,
          html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">' + mail.escapeHtml(words.replace(': ' + url, '.')) +
            '<p style="margin:18px 0"><a href="' + mail.escapeHtml(url) + '" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#2f6b2c;color:#fff;text-decoration:none;font-weight:700">See and pay the invoice</a></p></div>' });
      }
    } catch (e) { /* the page has the link */ }
  }
  return { orderNo: row.order_no, invoiceNo: inv.invoiceNo, total: round2(inv.grandTotal), currency: inv.currency, token: link.token, url: url, payOnline: require('./invoicePay.service').configured() };
}

// ── for staff ──
function orderOut(r) {
  return {
    id: r.id, orderNo: r.order_no, name: r.name, phone: r.phone, email: r.email, fulfilment: r.fulfilment, address: r.address, note: r.note, lines: r.lines,
    total: round2(r.total), status: r.status, createdAt: r.created_at, customerId: r.customer_id,
    invoice: r.invoice_id ? { id: r.invoice_id, invoiceNo: r.invoice_no, status: r.invoice_status, balance: round2(r.balance_due), paid: round2(r.amount_paid) } : null
  };
}
var ORDER_SELECT = 'SELECT o.*, i.invoice_no, i.status AS invoice_status, i.balance_due, i.amount_paid FROM shop_orders o LEFT JOIN invoices i ON i.id = o.invoice_id ';

// GET /api/shop-orders?status= — the orders, newest first, with whether each is paid.
async function list(ctx, q) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  q = q || {};
  var args = [], where = '';
  if (STATUSES.indexOf(q.status) >= 0) { args.push(q.status); where = 'WHERE o.status = $1 '; }
  var rows = (await pool.query(ORDER_SELECT + where + 'ORDER BY o.created_at DESC LIMIT 200', args)).rows;
  var sums = (await pool.query(
    "SELECT count(*) FILTER (WHERE o.status = 'new') AS fresh, count(*) FILTER (WHERE o.status = 'ready') AS ready, " +
    "coalesce(sum(o.total) FILTER (WHERE o.created_at >= date_trunc('month', now()) AND o.status <> 'cancelled'), 0) AS month, " +
    "count(*) FILTER (WHERE o.created_at >= date_trunc('month', now()) AND o.status <> 'cancelled') AS month_count, " +
    "count(*) FILTER (WHERE i.status = 'paid' AND o.created_at >= date_trunc('month', now())) AS month_paid " +
    'FROM shop_orders o LEFT JOIN invoices i ON i.id = o.invoice_id')).rows[0];
  return {
    orders: rows.map(orderOut), settings: await settingsOf(),
    totals: { fresh: Number(sums.fresh), ready: Number(sums.ready), month: round2(sums.month), monthCount: Number(sums.month_count), monthPaid: Number(sums.month_paid) },
    url: config.bplSiteUrl, payOnline: require('./invoicePay.service').configured()
  };
}

// PATCH /api/shop-orders/:id { status } — ready (the customer is texted when
// texts are set up), done, or cancelled (its invoice voided when nothing was paid).
async function setStatus(ctx, id, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var status = STATUSES.indexOf((p || {}).status) >= 0 ? p.status : fail('invalid', 'Unknown status.');
  var o = (await pool.query(ORDER_SELECT + 'WHERE o.id = $1', [id])).rows[0];
  if (!o) fail('notfound', 'That order is gone.');
  if (o.status === status) return orderOut(o);
  if (o.status === 'cancelled') fail('conflict', 'That order was cancelled.');
  if (status === 'cancelled' && o.invoice_id && Number(o.amount_paid) > 0) fail('conflict', 'Something was paid on its invoice: refund it from the invoice first.');
  await pool.query('UPDATE shop_orders SET status = $2 WHERE id = $1', [id, status]);
  if (status === 'cancelled' && o.invoice_id && o.invoice_status !== 'void') {
    try { await require('./invoices.service').voidInvoice(ctx, o.invoice_id, 'Shop order ' + o.order_no + ' cancelled.'); } catch (e) { /* left for the invoice page */ }
  }
  var texted = false;
  if (status === 'ready') {
    var sms = require('./sms.service');
    if (sms.configured()) {
      try {
        await sms.send({ to: o.phone, message: 'Bamboo Products: your order ' + o.order_no + (o.fulfilment === 'delivery' ? ' is ready and on its way to you.' : ' is ready for pickup.') + ' Thank you!', purpose: 'shop_order', refId: o.id });
        texted = true;
      } catch (e) { /* staff call instead */ }
    }
  }
  await audit(pool, ctx, 'shop.order_' + status, 'shop_order', id, o.order_no + ' marked ' + status + (texted ? ' (customer texted).' : '.'));
  return Object.assign(orderOut((await pool.query(ORDER_SELECT + 'WHERE o.id = $1', [id])).rows[0]), { texted: texted });
}

// GET/PUT /api/shop/settings — the shop on or off, its words, which categories, delivery and pickup.
async function getSettings(ctx) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  var cats = (await pool.query('SELECT c.id, c.name, (SELECT count(*) FROM catalog_items i WHERE i.category_id = c.id AND i.active) AS items FROM catalog_categories c ORDER BY c.name')).rows;
  return { settings: await settingsOf(), categories: cats.map(function (c) { return { id: c.id, name: c.name, items: Number(c.items) }; }), url: config.bplSiteUrl, payOnline: require('./invoicePay.service').configured() };
}
async function saveSettings(ctx, p) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  p = p || {};
  var known = (await pool.query('SELECT id FROM catalog_categories')).rows.map(function (r) { return r.id; });
  var s = {
    on: !!p.on, title: text(p.title, 80) || DEFAULTS.title, intro: text(p.intro, 400),
    categories: (Array.isArray(p.categories) ? p.categories : []).filter(function (c) { return known.indexOf(c) >= 0; }),
    delivery: !!p.delivery, pickup: !!p.pickup, pickupAddress: text(p.pickupAddress, 200), deliveryNote: text(p.deliveryNote, 300)
  };
  if (s.on && !s.delivery && !s.pickup) fail('invalid', 'Offer delivery, pickup or both.');
  await pool.query('UPDATE settings SET shop = $1 WHERE id = 1', [JSON.stringify(s)]);
  await audit(pool, ctx, 'settings.shop', 'settings', 'shop', 'Online shop ' + (s.on ? 'open' : 'closed') + (s.categories.length ? ', ' + s.categories.length + ' categories on it.' : ', every category on it.'));
  return getSettings(ctx);
}

module.exports = { view: view, photoKey: photoKey, place: place, customerFor: customerFor, list: list, setStatus: setStatus, getSettings: getSettings, saveSettings: saveSettings, settingsOf: settingsOf };
