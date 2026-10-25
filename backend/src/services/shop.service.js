var crypto = require('crypto');
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
// Items made to order say how many days they take (catalog_items
// make_days_min/max, migration 0190), on the item and at checkout, and the
// order keeps the days it will be ready between. Discount codes
// (settings.shop.codes, migration 0189) take a percentage or an amount off.
// Delivery is priced by area when areas are set (settings.shop.areas), and
// each order has its own page to follow it (/o/<token>, migration 0191):
// received, being made, ready, on its way, delivered or collected.

var DEFAULTS = { on: false, title: 'Bamboo Products', intro: '', categories: [], delivery: true, pickup: true, pickupAddress: '', deliveryNote: '', codes: [], areas: [],
  remindAfter: 3, reviews: { on: true, autoShow: false } };
// An unpaid checkout is reminded once, this many hours after (0: never).
var REMIND_HOURS = [0, 1, 3, 6, 12, 24];
var CODE_KINDS = ['percent', 'amount'];
var MAX_MAKE_DAYS = 180;
// new, being made (making), ready, on its way (out, delivery only), done, cancelled.
var STATUSES = ['unpaid', 'new', 'making', 'ready', 'out', 'done', 'cancelled'];
var UNPAID_DAYS = 2;
var MAX_LINES = 30;
var PER_IP_HOUR = 6;
var ctxShop = { can: function () { return true; }, user: { id: null }, employee: { id: null, first_name: 'Online shop', last_name: '' } };

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function isEmail(v) { return /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i.test(String(v || '')); }
function displayName(item, variation) { return variation && variation !== 'Regular' ? item + ' — ' + variation : item; }
function isDay(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(day, n) { var d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// A day that falls on a Sunday is the Monday: the workshop is closed.
function workday(day) { return new Date(day + 'T00:00:00Z').getUTCDay() === 0 ? addDays(day, 1) : day; }
function dayText(d) { return d instanceof Date ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : String(d).slice(0, 10); }
function longDay(day) { return new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
function makeDaysOf(r) { return r.make_days_max != null ? { from: Number(r.make_days_min), to: Number(r.make_days_max) } : null; }
function codeKey(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24); }

// The delivery areas, each with its fee (Accra, Tema, further…).
function cleanAreas(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (a) {
    var name = text(a && a.name, 60), fee = round2(a && a.fee);
    if (name.length < 2 || out.length >= 30 || out.some(function (o) { return o.name.toLowerCase() === name.toLowerCase(); })) return;
    out.push({ name: name, fee: fee > 0 && fee <= 100000 ? fee : 0 });
  });
  return out;
}

// The discount codes, as kept: { code, kind: percent|amount, value,
// minTotal, endsOn, maxUses (0: no limit), on }.
function cleanCodes(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (c) {
    if (!c || out.length >= 50) return;
    var code = codeKey(c.code), kind = CODE_KINDS.indexOf(c.kind) >= 0 ? c.kind : null, value = round2(c.value);
    if (code.length < 3 || !kind || out.some(function (o) { return o.code === code; })) return;
    if (!(value > 0) || (kind === 'percent' && value > 90) || value > 1000000) return;
    out.push({ code: code, kind: kind, value: value, minTotal: Math.max(0, round2(c.minTotal) || 0), endsOn: isDay(c.endsOn) ? c.endsOn : null,
      maxUses: Math.max(0, Math.min(100000, Math.round(Number(c.maxUses) || 0))), on: c.on !== false });
  });
  return out;
}

async function settingsOf(db) {
  var s = ((await (db || pool).query('SELECT shop FROM settings WHERE id = 1')).rows[0] || {}).shop || {};
  return {
    on: !!s.on, title: text(s.title, 80) || DEFAULTS.title, intro: text(s.intro, 400), categories: Array.isArray(s.categories) ? s.categories.filter(function (c) { return /^[0-9a-f-]{36}$/i.test(c); }) : [],
    delivery: s.delivery !== false, pickup: s.pickup !== false, pickupAddress: text(s.pickupAddress, 200), deliveryNote: text(s.deliveryNote, 300),
    codes: cleanCodes(s.codes), areas: cleanAreas(s.areas),
    remindAfter: REMIND_HOURS.indexOf(Number(s.remindAfter)) >= 0 && s.remindAfter !== null && s.remindAfter !== '' ? Number(s.remindAfter) : DEFAULTS.remindAfter,
    reviews: reviewsOf(s.reviews)
  };
}
// Reviews: asked for once an order is done; shown on the shop once staff
// approve them, or at once when autoShow (4 stars and up).
function reviewsOf(r) {
  r = r && typeof r === 'object' ? r : {};
  return { on: r.on !== false, autoShow: r.autoShow === true };
}

// What the shop sells: active items (in its categories, when it has some)
// with at least one active variation that has a price.
async function visibleItems(s) {
  var args = [];
  var where = 'i.active = true';
  if (s.categories.length) { args.push(s.categories); where += ' AND i.category_id = ANY($1::uuid[])'; }
  var rows = (await pool.query(
    'SELECT i.id, i.name, i.description, i.category_id, i.tax_rate_id, i.make_days_min, i.make_days_max, c.name AS category_name, ' +
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
  var stars = s.reviews.on ? await require('./shopReviews.service').summary(items.map(function (r) { return r.id; })) : {};
  return {
    shop: { title: s.title, intro: s.intro, delivery: s.delivery, pickup: s.pickup, pickupAddress: s.pickupAddress, deliveryNote: s.deliveryNote, currency: 'GHS',
      payOnline: require('./invoicePay.service').configured(), codes: s.codes.some(function (c) { return c.on; }), areas: s.delivery ? s.areas : [], reviews: s.reviews.on, quotes: true },
    categories: cats,
    items: items.map(function (r) {
      return {
        id: r.id, name: r.name, description: r.description || '', category: r.category_name || 'More', options: r.options, makeDays: makeDaysOf(r), stars: stars[r.id] || null,
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
// customer's own fields), else a new one: a lead from the shop. What is typed
// on a public form is never linked to a customer found already: a stranger
// could type someone's phone with their own email, then sign in to "My
// account" (portal.service.js) with that email and see that customer's
// invoices. Only an empty address is filled in.
async function customerFor(client, p) {
  var inbox = require('./crmInbox.service');
  var ids = [inbox.normIdentity({ kind: 'phone', value: p.phone }), p.email ? inbox.normIdentity({ kind: 'email', value: p.email }) : null].filter(Boolean);
  var found = await inbox.findCustomerByIdentities(client, ids);
  if (!found && p.email) found = ((await client.query("SELECT id FROM customers WHERE lower(email) = $1 AND status = 'active' ORDER BY created_at LIMIT 1", [p.email])).rows[0] || {}).id;
  if (found) {
    await client.query("UPDATE customers SET address = CASE WHEN address = '' THEN $2 ELSE address END WHERE id = $1", [found, p.address]);
    return found;
  }
  var companyId = await inbox.crmCompanyId();
  found = (await client.query(
    "INSERT INTO customers (name, phone, email, address, category, source, origin_channel, company_id) VALUES ($1,$2,$3,$4,'lead','crm','shop',$5) RETURNING id",
    [p.name, '+' + internationalNumber(p.phone), p.email, p.address, companyId])).rows[0].id;
  await inbox.addIdentities(client, found, ids);
  return found;
}

// When an order will be ready: the longest of its items' days to make
// (none made to order: null), from today, Sundays skipped at either end.
function readyOf(lines) {
  var from = -1, to = -1;
  lines.forEach(function (l) { if (l.makeDays) { from = Math.max(from, l.makeDays.from); to = Math.max(to, l.makeDays.to); } });
  if (to < 0) return null;
  var t = today();
  return { fromDays: from, toDays: to, from: workday(addDays(t, from)), by: workday(addDays(t, to)) };
}

// A code for a basket of `subtotal` (before tax): what it takes off, else
// why not. Uses are the orders that used it and were not cancelled.
async function codeFor(s, raw, subtotal) {
  var key = codeKey(raw);
  var c = s.codes.find(function (x) { return x.code === key && x.on; });
  if (!c || (c.endsOn && c.endsOn < today())) fail('invalid', 'That code is not right, or has ended.');
  if (c.minTotal > 0 && subtotal < c.minTotal) fail('invalid', 'That code is for orders of GHS ' + c.minTotal.toFixed(2) + ' or more.');
  if (c.maxUses > 0) {
    var used = Number((await pool.query("SELECT count(*) AS n FROM shop_orders WHERE promo_code = $1 AND status <> 'cancelled'", [c.code])).rows[0].n);
    if (used >= c.maxUses) fail('invalid', 'That code has been used up.');
  }
  var off = c.kind === 'percent' ? round2(subtotal * c.value / 100) : Math.min(round2(c.value), round2(subtotal));
  return { code: c.code, kind: c.kind, value: c.value, discount: off };
}
var checkedBy = new Map();
// GET /api/shop/code?code=&subtotal= — the checkout checks a code.
async function checkCode(q, ip) {
  q = q || {};
  var now = Date.now(), key = String(ip || '');
  var list = (checkedBy.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= 30) fail('ratelimited', 'Too many tries from here in the last hour.');
  list.push(now); checkedBy.set(key, list);
  if (checkedBy.size > 5000) checkedBy.clear();
  var s = await settingsOf();
  if (!s.on) fail('notfound', 'The online shop is closed for now.');
  var subtotal = round2(q.subtotal);
  if (!(subtotal >= 0)) fail('invalid', 'Your basket is empty.');
  return codeFor(s, q.code, subtotal);
}

// POST /api/shop/orders { name, phone, email, fulfilment: delivery|pickup,
// address, note, lines: [{ variationId, qty }], code, area, website (left
// empty: a form robot fills it) } — the order, unpaid, its invoice and the
// page to pay it on: it is placed once paid (invoicePaid).
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
  // Delivery by area: its fee on the invoice.
  var area = null;
  if (fulfilment === 'delivery' && s.areas.length) {
    area = s.areas.find(function (a) { return a.name.toLowerCase() === String(p.area || '').trim().toLowerCase(); }) || fail('invalid', 'Choose your area for the delivery.');
  }
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
      unitPrice: round2(hit.v.price), taxRate: taxOf(hit.item.tax_rate_id), productId: hit.v.productId || null, makeDays: makeDaysOf(hit.item) };
  });
  var subtotal = round2(lines.reduce(function (a, l) { return a + l.qty * l.unitPrice; }, 0));
  var promo = p.code ? await codeFor(s, p.code, subtotal) : null;
  var ready = readyOf(lines);
  throttle(ip);

  var customerId = await withTransaction(function (client) { return customerFor(client, { name: name, phone: phone, email: email, address: fulfilment === 'delivery' ? address : '' }); });
  var n = Number((await pool.query('SELECT count(*) AS n FROM shop_orders')).rows[0].n) + 1001;
  var orderNo = 'SHOP-' + n;
  var invoiceLines = lines.slice();
  if (area && area.fee > 0) invoiceLines.push({ description: 'Delivery (' + area.name + ')', qty: 1, unit: 'trip', unitPrice: area.fee, taxRate: 0 });
  var inv = await require('./invoices.service').createManual(ctxShop, {
    customerId: customerId, currency: 'GHS', items: invoiceLines, discount: promo && promo.discount > 0 ? { value: promo.discount, type: 'fixed' } : undefined,
    notes: 'Online shop order ' + orderNo + ': ' + (fulfilment === 'delivery' ? 'delivery to ' + address : 'pickup' + (s.pickupAddress ? ' at ' + s.pickupAddress : '')) + (note ? '. ' + note : '') + '.' +
      (ready ? ' Made to order: ready between ' + longDay(ready.from) + ' and ' + longDay(ready.by) + '.' : '') + (promo ? ' Code ' + promo.code + ': GHS ' + promo.discount.toFixed(2) + ' off.' : '')
  });
  var link = await require('./shares.service').issueLink('invoice', inv.id, 30, null);
  var share = (await pool.query('SELECT id FROM document_shares WHERE token = $1', [link.token])).rows[0];
  var row = null;
  for (var tries = 0; tries < 5 && !row; tries++) {
    try {
      row = (await pool.query(
        'INSERT INTO shop_orders (order_no, customer_id, invoice_id, share_id, name, phone, email, fulfilment, address, note, lines, total, ip, promo_code, discount, ready_from, ready_by, token, area, delivery_fee, steps, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,\'unpaid\') RETURNING *',
        ['SHOP-' + (n + tries), customerId, inv.id, share.id, name, '+' + internationalNumber(phone), email, fulfilment, fulfilment === 'delivery' ? address : '', note,
          JSON.stringify(lines.map(function (l) { return { variationId: l.variationId, description: l.description, qty: l.qty, unitPrice: l.unitPrice, makeDays: l.makeDays || null }; })), inv.grandTotal, String(ip || '').slice(0, 60),
          promo ? promo.code : '', promo ? promo.discount : 0, ready ? ready.from : null, ready ? ready.by : null,
          crypto.randomBytes(18).toString('base64url'), area ? area.name : '', area ? area.fee : 0, JSON.stringify({})])).rows[0];
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  if (!row) fail('conflict', 'Could not number the order. Try again.');
  // Nothing to pay (a code took it all off): placed straight away.
  if (!(round2(inv.grandTotal) > 0)) { await invoicePaid(inv.id); row = (await pool.query('SELECT * FROM shop_orders WHERE id = $1', [row.id])).rows[0]; }
  if (row.order_no !== orderNo) await pool.query('UPDATE invoices SET notes = replace(notes, $2, $3) WHERE id = $1', [inv.id, orderNo, row.order_no]);
  await audit(pool, ctxShop, 'shop.order', 'shop_order', row.id, row.order_no + ' from ' + name + ' (' + inv.invoiceNo + ', GHS ' + round2(inv.grandTotal).toFixed(2) + '), waiting to be paid.');

  // Paid first: straight on to Paystack, back to the order's own page. Staff
  // hear of it, and the customer is emailed, once it is paid (invoicePaid).
  var url = config.bplSiteUrl + '/share/' + link.token;
  var trackUrl = config.bplSiteUrl + '/o/' + row.token;
  var pay = require('./invoicePay.service'), payUrl = null;
  if (pay.configured()) {
    try { payUrl = (await pay.start(link.token, { pay: 'all', back: trackUrl })).url || null; } catch (e) { payUrl = null; }
  }
  return { orderNo: row.order_no, invoiceNo: inv.invoiceNo, total: round2(inv.grandTotal), currency: inv.currency, token: link.token, url: url, payOnline: pay.configured(), payUrl: payUrl, status: row.status,
    discount: promo ? promo.discount : 0, code: promo ? promo.code : null, ready: ready, orderToken: row.token, trackUrl: trackUrl, deliveryFee: area ? area.fee : 0, area: area ? area.name : '' };
}

// invoices.service.js recordPayment, once an invoice is paid in full: the shop
// order waiting on it is placed — whoever runs the invoices is told and the
// customer emailed. Once: a second payment finds it placed already.
async function invoicePaid(invoiceId) {
  var row = (await pool.query(
    "UPDATE shop_orders SET status = 'new', steps = steps || jsonb_build_object('paid', to_jsonb(now()), 'new', to_jsonb(now())) WHERE invoice_id = $1 AND status = 'unpaid' RETURNING *", [invoiceId])).rows[0];
  if (!row) return null;
  var inv = (await pool.query('SELECT i.invoice_no, i.grand_total, ds.token AS share_token FROM invoices i LEFT JOIN document_shares ds ON ds.id = $2 WHERE i.id = $1', [invoiceId, row.share_id])).rows[0] || {};
  var total = 'GHS ' + round2(row.total).toFixed(2);
  await audit(pool, ctxShop, 'shop.order_paid', 'shop_order', row.id, row.order_no + ' paid (' + (inv.invoice_no || '') + ', ' + total + '): placed.');
  var holders = await require('./staffAlerts.service').holdersOf(['invoice.manage']);
  for (var i = 0; i < holders.length; i++) {
    await notify(pool, holders[i].employee_id, '🛍️ New shop order ' + row.order_no + ' · paid', row.name + ' · ' + total + ' · ' + (row.fulfilment === 'delivery' ? 'delivery' + (row.area ? ' to ' + row.area : '') : 'pickup'), '/shoporders?open=' + row.id);
  }
  var emailed = false;
  if (row.email) {
    try {
      var mail = require('./mail.service');
      if (mail.configured()) {
        var trackUrl = config.bplSiteUrl + '/o/' + row.token;
        var words = 'Thank you, ' + String(row.name).split(' ')[0] + '! We have your payment and your order ' + row.order_no + ' (' + total + ').' +
          (row.ready_by ? ' It is made to order: it will be ready between ' + longDay(dayText(row.ready_from || row.ready_by)) + ' and ' + longDay(dayText(row.ready_by)) + '.' : '') +
          ' Follow it here: ' + trackUrl + (inv.invoice_no ? '. Its invoice, ' + inv.invoice_no + ', is paid' + (inv.share_token ? ': ' + config.bplSiteUrl + '/share/' + inv.share_token : '') : '') + '.';
        await mail.send({ to: row.email, subject: 'Your order ' + row.order_no + ' from Bamboo Products', fromName: 'Bamboo Products', text: words,
          html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">' + mail.escapeHtml(words.replace(' Follow it here: ' + trackUrl + '.', '')) +
            '<p style="margin:18px 0"><a href="' + mail.escapeHtml(trackUrl) + '" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#2f6b2c;color:#fff;text-decoration:none;font-weight:700">Follow your order</a></p></div>' });
        emailed = true;
      }
    } catch (e) { /* the page has it */ }
  }
  return { orderNo: row.order_no, emailed: emailed };
}

// ── unpaid checkouts reminded (migration 0192) ──
// Once, remindAfter hours after the checkout (the hourly job), or when staff
// press Remind: by email and by text when they can, with the order's page
// to pay on and the day it is cancelled if it is not.
async function remindOne(o) {
  var trackUrl = config.bplSiteUrl + '/o/' + o.token;
  var by = longDay(dayText(new Date(new Date(o.created_at).getTime() + UNPAID_DAYS * 86400000)));
  var words = 'Bamboo Products: your order ' + o.order_no + ' (GHS ' + round2(o.total).toFixed(2) + ') is waiting for your payment. Pay here to place it: ' + trackUrl +
    '. If it is not paid, it is cancelled on ' + by + '.';
  var emailed = false, texted = false;
  if (o.email) {
    try {
      var mail = require('./mail.service');
      if (mail.configured()) {
        await mail.send({ to: o.email, subject: 'Your order ' + o.order_no + ' is waiting for your payment', fromName: 'Bamboo Products', text: words,
          html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">' + mail.escapeHtml(words.replace(' Pay here to place it: ' + trackUrl + '.', '')) +
            '<p style="margin:18px 0"><a href="' + mail.escapeHtml(trackUrl) + '" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#2f6b2c;color:#fff;text-decoration:none;font-weight:700">Pay and place my order</a></p></div>' });
        emailed = true;
      }
    } catch (e) { /* the text, or staff call */ }
  }
  var sms = require('./sms.service');
  if (o.phone && sms.configured()) {
    try { await sms.send({ to: o.phone, message: words, purpose: 'shop_order', refId: o.id }); texted = true; } catch (e) { /* staff call */ }
  }
  if (emailed || texted) await pool.query('UPDATE shop_orders SET reminded_at = now() WHERE id = $1', [o.id]);
  return { emailed: emailed, texted: texted };
}
async function remindUnpaid() {
  var s = await settingsOf();
  if (!s.remindAfter) return 0;
  var rows = (await pool.query(
    "SELECT * FROM shop_orders WHERE status = 'unpaid' AND reminded_at IS NULL AND token IS NOT NULL AND created_at < now() - make_interval(hours => $1) AND created_at > now() - make_interval(days => $2) LIMIT 100",
    [s.remindAfter, UNPAID_DAYS])).rows;
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = await remindOne(rows[i]);
    if (r.emailed || r.texted) n++;
  }
  return n;
}
// POST /api/shop-orders/:id/remind — staff remind a customer to pay now.
async function remind(ctx, id) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var o = (await pool.query('SELECT * FROM shop_orders WHERE id = $1', [id])).rows[0];
  if (!o) fail('notfound', 'That order is gone.');
  if (o.status !== 'unpaid') fail('conflict', 'Only an order not paid yet is reminded.');
  if (o.reminded_at && Date.now() - new Date(o.reminded_at).getTime() < 3600000) fail('conflict', 'Reminded less than an hour ago.');
  var r = await remindOne(o);
  if (!r.emailed && !r.texted) fail('unavailable', 'No email address or texts set up to remind them with: call them instead.');
  await audit(pool, ctx, 'shop.order_remind', 'shop_order', id, o.order_no + ' reminded to pay' + (r.emailed ? ' by email' : '') + (r.texted ? (r.emailed ? ' and text' : ' by text') : '') + '.');
  return Object.assign(orderOut((await pool.query(ORDER_SELECT + 'WHERE o.id = $1', [id])).rows[0]), r);
}

// Checkouts never paid: after two days with nothing paid, the order is
// cancelled and its invoice voided (jobs/paymentLinks.js, hourly).
async function sweepUnpaid() {
  var rows = (await pool.query(
    "SELECT o.id, o.order_no, o.invoice_id, i.status AS invoice_status, coalesce(i.amount_paid, 0) AS amount_paid FROM shop_orders o LEFT JOIN invoices i ON i.id = o.invoice_id " +
    "WHERE o.status = 'unpaid' AND o.created_at < now() - make_interval(days => $1) LIMIT 200", [UNPAID_DAYS])).rows;
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    var o = rows[i];
    if (Number(o.amount_paid) > 0) continue;
    var done = (await pool.query("UPDATE shop_orders SET status = 'cancelled', steps = steps || jsonb_build_object('cancelled', to_jsonb(now())) WHERE id = $1 AND status = 'unpaid' RETURNING id", [o.id])).rows[0];
    if (!done) continue;
    if (o.invoice_id && o.invoice_status !== 'void') {
      try { await require('./invoices.service').voidInvoice(ctxShop, o.invoice_id, 'Shop order ' + o.order_no + ' never paid.'); } catch (e) { /* left for the invoice page */ }
    }
    await audit(pool, ctxShop, 'shop.order_unpaid', 'shop_order', o.id, o.order_no + ' cancelled: not paid in ' + UNPAID_DAYS + ' days.');
    n++;
  }
  return { cancelled: n };
}

// ── for staff ──
function orderOut(r) {
  return {
    id: r.id, orderNo: r.order_no, name: r.name, phone: r.phone, email: r.email, fulfilment: r.fulfilment, address: r.address, note: r.note, lines: r.lines,
    total: round2(r.total), status: r.status, createdAt: r.created_at, customerId: r.customer_id, promoCode: r.promo_code || '', discount: round2(r.discount || 0),
    readyFrom: r.ready_from ? dayText(r.ready_from) : null, readyBy: r.ready_by ? dayText(r.ready_by) : null,
    area: r.area || '', deliveryFee: round2(r.delivery_fee || 0), steps: r.steps || {}, trackUrl: r.token ? config.bplSiteUrl + '/o/' + r.token : null, remindedAt: r.reminded_at || null,
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
  else where = "WHERE o.status <> 'unpaid' ";
  var rows = (await pool.query(ORDER_SELECT + where + 'ORDER BY o.created_at DESC LIMIT 200', args)).rows;
  var sums = (await pool.query(
    "SELECT count(*) FILTER (WHERE o.status = 'new') AS fresh, count(*) FILTER (WHERE o.status = 'unpaid') AS unpaid, count(*) FILTER (WHERE o.status = 'ready') AS ready, count(*) FILTER (WHERE o.status = 'making') AS making, count(*) FILTER (WHERE o.status = 'out') AS out_now, " +
    "coalesce(sum(o.total) FILTER (WHERE o.created_at >= date_trunc('month', now()) AND o.status NOT IN ('cancelled', 'unpaid')), 0) AS month, " +
    "count(*) FILTER (WHERE o.created_at >= date_trunc('month', now()) AND o.status NOT IN ('cancelled', 'unpaid')) AS month_count, " +
    "count(*) FILTER (WHERE i.status = 'paid' AND o.created_at >= date_trunc('month', now())) AS month_paid " +
    'FROM shop_orders o LEFT JOIN invoices i ON i.id = o.invoice_id')).rows[0];
  // The buttons for reviews to look at and quote requests not priced yet.
  var asks = (await pool.query("SELECT (SELECT count(*) FROM shop_reviews WHERE status = 'pending')::int AS reviews, (SELECT count(*) FROM shop_quote_requests WHERE status = 'new')::int AS quotes")).rows[0];
  return {
    orders: rows.map(orderOut), settings: await settingsOf(),
    totals: { fresh: Number(sums.fresh), unpaid: Number(sums.unpaid), ready: Number(sums.ready), making: Number(sums.making), out: Number(sums.out_now), month: round2(sums.month), monthCount: Number(sums.month_count), monthPaid: Number(sums.month_paid), reviews: asks.reviews, quotes: asks.quotes },
    url: config.bplSiteUrl, payOnline: require('./invoicePay.service').configured()
  };
}

// PATCH /api/shop-orders/:id { status } — being made, ready (the customer is
// texted when texts are set up), on its way, done, or cancelled (its invoice
// voided when nothing was paid). An unpaid order can only be cancelled.
async function setStatus(ctx, id, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var status = STATUSES.indexOf((p || {}).status) >= 0 ? p.status : fail('invalid', 'Unknown status.');
  if (status === 'unpaid') fail('invalid', 'An order is unpaid until its invoice is paid.');
  var o = (await pool.query(ORDER_SELECT + 'WHERE o.id = $1', [id])).rows[0];
  if (!o) fail('notfound', 'That order is gone.');
  if (o.status === status) return orderOut(o);
  if (o.status === 'cancelled') fail('conflict', 'That order was cancelled.');
  if (o.status === 'unpaid' && status !== 'cancelled') fail('conflict', 'Not paid yet: it is placed once its invoice is paid. Record the payment on the invoice.');
  if (status === 'out' && o.fulfilment !== 'delivery') fail('invalid', 'Only a delivery goes out: a pickup is collected (done).');
  if (status === 'cancelled' && o.invoice_id && Number(o.amount_paid) > 0) fail('conflict', 'Something was paid on its invoice: refund it from the invoice first.');
  await pool.query("UPDATE shop_orders SET status = $2, steps = steps || jsonb_build_object($2::text, to_jsonb(now())) WHERE id = $1", [id, status]);
  if (status === 'cancelled' && o.invoice_id && o.invoice_status !== 'void') {
    try { await require('./invoices.service').voidInvoice(ctx, o.invoice_id, 'Shop order ' + o.order_no + ' cancelled.'); } catch (e) { /* left for the invoice page */ }
  }
  // The customer is told: by text when it is ready or on its way, by email at every step.
  var link = o.token ? ' Follow it: ' + config.bplSiteUrl + '/o/' + o.token : '';
  var words = {
    making: 'Bamboo Products: we have started making your order ' + o.order_no + '.' + (o.ready_by ? ' It should be ready by ' + longDay(dayText(o.ready_by)) + '.' : '') + link,
    ready: 'Bamboo Products: your order ' + o.order_no + (o.fulfilment === 'delivery' ? ' is ready; we will deliver it soon.' : ' is ready for pickup.') + link,
    out: 'Bamboo Products: your order ' + o.order_no + ' is on its way to you.' + link,
    done: 'Bamboo Products: your order ' + o.order_no + (o.fulfilment === 'delivery' ? ' was delivered.' : ' was collected.') + ' Thank you!' +
      (o.token && (await settingsOf()).reviews.on ? ' How do you like it? Rate it here: ' + config.bplSiteUrl + '/o/' + o.token : '')
  }[status];
  var texted = false, emailed = false;
  if (words && (status === 'ready' || status === 'out')) {
    var sms = require('./sms.service');
    if (sms.configured()) { try { await sms.send({ to: o.phone, message: words, purpose: 'shop_order', refId: o.id }); texted = true; } catch (e) { /* staff call instead */ } }
  }
  if (words && o.email) {
    try {
      var mail = require('./mail.service');
      if (mail.configured()) {
        await mail.send({ to: o.email, subject: 'Your order ' + o.order_no + ': ' + { making: 'being made', ready: 'ready', out: 'on its way', done: 'thank you' }[status], fromName: 'Bamboo Products', text: words,
          html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">' + mail.escapeHtml(words) + '</div>' });
        emailed = true;
      }
    } catch (e) { /* the page shows it */ }
  }
  await audit(pool, ctx, 'shop.order_' + status, 'shop_order', id, o.order_no + ' marked ' + status + (texted ? ' (customer texted).' : '.'));
  if (status === 'done' && emailed) await pool.query('UPDATE shop_orders SET review_asked_at = now() WHERE id = $1', [id]);
  return Object.assign(orderOut((await pool.query(ORDER_SELECT + 'WHERE o.id = $1', [id])).rows[0]), { texted: texted, emailed: emailed });
}

// GET /api/shop/orders/:token — an order's own page for its customer: where
// it stands and when each step came, what is in it, the days it will be
// ready between, and its invoice to pay. Not the phone or the email.
async function track(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) fail('notfound', 'We cannot find that order.');
  var o = (await pool.query(
    'SELECT o.*, i.invoice_no, i.status AS invoice_status, i.balance_due, i.amount_paid, i.grand_total, ds.token AS share_token FROM shop_orders o ' +
    'LEFT JOIN invoices i ON i.id = o.invoice_id LEFT JOIN document_shares ds ON ds.id = o.share_id WHERE o.token = $1', [token])).rows[0];
  if (!o) fail('notfound', 'We cannot find that order.');
  var s = await settingsOf();
  return {
    orderNo: o.order_no, status: o.status, fulfilment: o.fulfilment, name: String(o.name).split(' ')[0], address: o.address, area: o.area || '', note: o.note,
    lines: (o.lines || []).map(function (l) { return { description: l.description, qty: l.qty, unitPrice: l.unitPrice, makeDays: l.makeDays || null }; }),
    deliveryFee: round2(o.delivery_fee || 0), discount: round2(o.discount || 0), promoCode: o.promo_code || '', total: round2(o.total),
    readyFrom: o.ready_from ? dayText(o.ready_from) : null, readyBy: o.ready_by ? dayText(o.ready_by) : null,
    steps: o.steps || {}, placedAt: o.created_at, pickupAddress: o.fulfilment === 'pickup' ? s.pickupAddress : '',
    invoice: o.invoice_no ? { invoiceNo: o.invoice_no, status: o.invoice_status, paid: o.invoice_status === 'paid', balance: round2(o.balance_due), amountPaid: round2(o.amount_paid), token: o.share_token || null } : null,
    payOnline: require('./invoicePay.service').configured(),
    reviews: await require('./shopReviews.service').forOrder(o)
  };
}

// GET/PUT /api/shop/settings — the shop on or off, its words, which categories, delivery and pickup.
async function getSettings(ctx) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  var cats = (await pool.query('SELECT c.id, c.name, (SELECT count(*) FROM catalog_items i WHERE i.category_id = c.id AND i.active) AS items FROM catalog_categories c ORDER BY c.name')).rows;
  var s = await settingsOf();
  var used = (await pool.query("SELECT promo_code, count(*)::int AS n, coalesce(sum(discount), 0) AS off FROM shop_orders WHERE promo_code <> '' AND status <> 'cancelled' GROUP BY promo_code")).rows;
  var items = await visibleItems(s);
  return {
    settings: s, categories: cats.map(function (c) { return { id: c.id, name: c.name, items: Number(c.items) }; }), url: config.bplSiteUrl, payOnline: require('./invoicePay.service').configured(),
    codeUses: Object.fromEntries(used.map(function (u) { return [u.promo_code, { uses: u.n, off: round2(u.off) }]; })),
    items: items.map(function (r) { return { id: r.id, name: r.name, category: r.category_name || 'More', makeDays: makeDaysOf(r) }; })
  };
}
async function saveSettings(ctx, p) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  p = p || {};
  var known = (await pool.query('SELECT id FROM catalog_categories')).rows.map(function (r) { return r.id; });
  var s = {
    on: !!p.on, title: text(p.title, 80) || DEFAULTS.title, intro: text(p.intro, 400),
    categories: (Array.isArray(p.categories) ? p.categories : []).filter(function (c) { return known.indexOf(c) >= 0; }),
    delivery: !!p.delivery, pickup: !!p.pickup, pickupAddress: text(p.pickupAddress, 200), deliveryNote: text(p.deliveryNote, 300),
    codes: p.codes !== undefined ? cleanCodes(p.codes) : (await settingsOf()).codes,
    areas: p.areas !== undefined ? cleanAreas(p.areas) : (await settingsOf()).areas,
    remindAfter: REMIND_HOURS.indexOf(Number(p.remindAfter)) >= 0 && p.remindAfter !== null && p.remindAfter !== '' ? Number(p.remindAfter) : (await settingsOf()).remindAfter,
    reviews: p.reviews !== undefined ? reviewsOf(p.reviews) : (await settingsOf()).reviews
  };
  if (s.on && !s.delivery && !s.pickup) fail('invalid', 'Offer delivery, pickup or both.');
  if (Array.isArray(p.codes) && p.codes.length !== s.codes.length) fail('invalid', 'Each code needs 3 or more letters or numbers, used once, and a value (a percentage up to 90).');
  await pool.query('UPDATE settings SET shop = $1 WHERE id = 1', [JSON.stringify(s)]);
  await audit(pool, ctx, 'settings.shop', 'settings', 'shop', 'Online shop ' + (s.on ? 'open' : 'closed') + (s.categories.length ? ', ' + s.categories.length + ' categories on it.' : ', every category on it.'));
  return getSettings(ctx);
}

// PUT /api/shop/make-days { items: [{ itemId, from, to }] } — how many
// days each item takes to make (from and to; none: in stock, ready now).
async function saveMakeDays(ctx, p) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var list = Array.isArray((p || {}).items) ? p.items : [];
  if (list.length > 500) fail('invalid', 'Too many items at once.');
  var said = 0;
  await withTransaction(async function (client) {
    for (var i = 0; i < list.length; i++) {
      var x = list[i] || {};
      if (!/^[0-9a-f-]{36}$/i.test(String(x.itemId || ''))) fail('invalid', 'Unknown item.');
      // One of the two given: both that.
      var from = x.from === '' || x.from == null ? null : Math.round(Number(x.from));
      var to = x.to === '' || x.to == null ? null : Math.round(Number(x.to));
      var none = from == null && to == null;
      if (from == null) from = to;
      if (to == null) to = from;
      if (!none && !(from >= 0 && to >= from && to <= MAX_MAKE_DAYS)) fail('invalid', 'Days to make: from 0 to ' + MAX_MAKE_DAYS + ', the first no more than the second (e.g. 3 to 7).');
      var r = await client.query('UPDATE catalog_items SET make_days_min = $2, make_days_max = $3 WHERE id = $1 AND (make_days_min IS DISTINCT FROM $2 OR make_days_max IS DISTINCT FROM $3) RETURNING id',
        [x.itemId, none ? null : from, none ? null : to]);
      said += r.rowCount;
    }
  });
  if (said) await audit(pool, ctx, 'shop.make_days', 'settings', 'shop', 'Days to make set on ' + said + ' item' + (said === 1 ? '' : 's') + ' of the online shop.');
  return getSettings(ctx);
}

module.exports = { remind: remind, remindUnpaid: remindUnpaid, _placedBy: placedBy, view: view, photoKey: photoKey, place: place, track: track, invoicePaid: invoicePaid, sweepUnpaid: sweepUnpaid, checkCode: checkCode, saveMakeDays: saveMakeDays, readyOf: readyOf, customerFor: customerFor, list: list, setStatus: setStatus, getSettings: getSettings, saveSettings: saveSettings, settingsOf: settingsOf };
