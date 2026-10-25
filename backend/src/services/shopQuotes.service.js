var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { internationalNumber } = require('../utils/phone');
var config = require('../config');
var fileStore = require('../lib/fileStore');

// "Ask for a quote" on Bamboo Products' website (migration 0192): a
// customer wanting something made to their size — a pergola for their
// garden, ten stools for a bar — says what, how big, how many, where, by
// when and roughly for how much, with up to four photos (the space, a
// picture they like). It becomes a customer (as a shop order does) and a
// request staff see on the Online shop page; "Make the quotation" opens a
// draft quotation for that customer with the request written in, to price
// and send as any other. The customer is emailed that it arrived, and
// sees it in My account until the quotation comes.

var MAX_PHOTOS = 4;
var MAX_PHOTO_BYTES = 6 * 1024 * 1024;
var PER_IP_HOUR = 5;
var STATUSES = ['new', 'quoted', 'closed'];
var askedBy = new Map();
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function isEmail(v) { return /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i.test(String(v || '')); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function numberOf(n) { return 'QR-' + n; }

// What a photo really is, by its first bytes (the name can say anything).
function photoType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return { type: 'image/png', ext: 'png' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  return null;
}
function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (askedBy.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Too many requests from here in the last hour. Call us instead.');
  list.push(now); askedBy.set(key, list);
  if (askedBy.size > 5000) askedBy.clear();
}

// POST /api/shop/quotes (multipart: the fields, and photos) — a request.
async function ask(p, files, ip) {
  p = p || {};
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  var name = text(p.name, 120);
  if (name.length < 2) fail('invalid', 'Type your name.');
  var phone = text(p.phone, 30);
  if (!internationalNumber(phone)) fail('invalid', 'Type a phone number we can call, e.g. 024 412 3456.');
  var email = text(p.email, 160).toLowerCase();
  if (email && !isEmail(email)) fail('invalid', 'That email address does not look right.');
  var what = text(p.what, 160);
  if (what.length < 3) fail('invalid', 'Say what you would like us to make.');
  var qty = Math.round(Number(p.qty || 1));
  if (!(qty >= 1 && qty <= 9999)) fail('invalid', 'How many? From 1 to 9,999.');
  var budget = p.budget === undefined || p.budget === null || p.budget === '' ? null : round2(p.budget);
  if (budget !== null && !(budget >= 0 && budget < 100000000)) fail('invalid', 'The budget is not right.');
  var neededBy = /^\d{4}-\d{2}-\d{2}$/.test(String(p.neededBy || '')) ? p.neededBy : null;
  if (neededBy && neededBy < new Date().toISOString().slice(0, 10)) fail('invalid', 'The date you need it by has passed.');
  var itemId = /^[0-9a-f-]{36}$/i.test(String(p.itemId || '')) ? p.itemId : null;
  if (itemId && !(await pool.query('SELECT 1 FROM catalog_items WHERE id = $1 AND active', [itemId])).rows[0]) itemId = null;
  files = (files || []).slice(0, MAX_PHOTOS);
  var photos = files.map(function (f) {
    var t = photoType(f.buffer);
    if (!t) fail('invalid', 'Add photos (JPG, PNG or WebP).');
    return { buffer: f.buffer, t: t };
  });
  throttle(ip);

  var customerId = await withTransaction(function (client) {
    return require('./shop.service').customerFor(client, { name: name, phone: phone, email: email, address: text(p.area, 80) });
  });
  var kept = [];
  for (var i = 0; i < photos.length; i++) {
    var key = await fileStore.put('quote-request-' + (i + 1) + '.' + photos[i].t.ext, photos[i].buffer, photos[i].t.type);
    kept.push({ key: key, type: photos[i].t.type, size: photos[i].buffer.length });
  }
  var row = null;
  for (var tries = 0; tries < 5 && !row; tries++) {
    try {
      row = (await pool.query(
        'INSERT INTO shop_quote_requests (number, token, customer_id, name, phone, email, item_id, what, size, qty, area, budget, needed_by, note, photos, ip) ' +
        'VALUES ((SELECT coalesce(max(number), 1000) + 1 FROM shop_quote_requests), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
        [crypto.randomBytes(18).toString('base64url'), customerId, name, '+' + internationalNumber(phone), email, itemId, what, text(p.size, 160), qty, text(p.area, 80),
          budget, neededBy, text(p.note, 800), JSON.stringify(kept), String(ip || '').slice(0, 60)])).rows[0];
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  if (!row) fail('conflict', 'Could not number the request. Try again.');
  var label = numberOf(row.number);
  await audit(pool, { can: function () { return true; }, user: { id: null }, employee: { id: null, first_name: 'Online shop', last_name: '' } },
    'shop.quote_request', 'shop_quote_request', row.id, label + ' from ' + name + ': ' + what + (kept.length ? ' (' + kept.length + ' photos)' : '') + '.');
  var holders = await require('./staffAlerts.service').holdersOf(['quotation.manage']);
  for (var h = 0; h < holders.length; h++) {
    await notify(pool, holders[h].employee_id, '📐 Quote request ' + label, name + ' · ' + what + (qty > 1 ? ' × ' + qty : ''), '/shoporders?quotes=1&open=' + row.id);
  }
  var emailed = false;
  if (email) {
    try {
      var mail = require('./mail.service');
      if (mail.configured()) {
        var words = 'Thank you, ' + name.split(' ')[0] + '! We have your request ' + label + ' for ' + what + (qty > 1 ? ' (' + qty + ')' : '') + '. ' +
          'We will prepare your quotation and send it to you, usually within two working days. You will see it in My account too: ' + config.bplSiteUrl + '/account.';
        await mail.send({ to: email, subject: 'Your quote request ' + label + ' — Bamboo Products', fromName: 'Bamboo Products', text: words,
          html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">' + mail.escapeHtml(words) + '</div>' });
        emailed = true;
      }
    } catch (e) { /* staff call them */ }
  }
  return { number: label, emailed: emailed, photos: kept.length };
}

function requestOut(r) {
  return {
    id: r.id, number: numberOf(r.number), status: r.status, name: r.name, phone: r.phone, email: r.email, customerId: r.customer_id,
    item: r.item_id ? { id: r.item_id, name: r.item_name || '' } : null, what: r.what, size: r.size, qty: r.qty, area: r.area,
    budget: r.budget == null ? null : round2(r.budget), neededBy: r.needed_by ? String(r.needed_by).slice(0, 10) : null, note: r.note,
    photos: (r.photos || []).map(function (ph, i) { return { n: i, type: ph.type }; }), createdAt: r.created_at,
    quotation: r.quotation_id ? { id: r.quotation_id, quoteNo: r.quote_no || '', status: r.quote_status || '' } : null
  };
}
var SELECT = 'SELECT r.*, i.name AS item_name, q.quote_no, q.status AS quote_status FROM shop_quote_requests r LEFT JOIN catalog_items i ON i.id = r.item_id LEFT JOIN quotations q ON q.id = r.quotation_id ';
function canSee(ctx) { if (!ctx.can('quotation.read') && !ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (quotation.read).'); }

// GET /api/shop-orders/quotes?status= — staff: the requests, new first.
async function list(ctx, q) {
  canSee(ctx);
  q = q || {};
  var status = STATUSES.indexOf(q.status) >= 0 ? q.status : null;
  var rows = (await pool.query(SELECT + (status ? 'WHERE r.status = $1 ' : '') + "ORDER BY (r.status = 'new') DESC, r.created_at DESC LIMIT 200", status ? [status] : [])).rows;
  var counts = (await pool.query("SELECT count(*) FILTER (WHERE status = 'new')::int AS fresh, count(*) FILTER (WHERE status = 'quoted')::int AS quoted FROM shop_quote_requests")).rows[0];
  return { requests: rows.map(requestOut), counts: { new: counts.fresh, quoted: counts.quoted } };
}
// GET /api/shop-orders/quotes/:id/photos/:n — one of its photos, for staff.
async function photoKey(ctx, id, n) {
  canSee(ctx);
  var r = (await pool.query('SELECT photos FROM shop_quote_requests WHERE id = $1', [id])).rows[0];
  var ph = r && (r.photos || [])[Number(n)];
  if (!ph) fail('notfound', 'Photo not found.');
  return ph.key;
}
// PATCH /api/shop-orders/quotes/:id { status: new|closed } — opened again,
// one already priced goes back to priced.
async function setStatus(ctx, id, p) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  var status = ['new', 'closed'].indexOf((p || {}).status) >= 0 ? p.status : fail('invalid', 'Open or closed?');
  var r = (await pool.query("UPDATE shop_quote_requests SET status = CASE WHEN $2 = 'new' AND quotation_id IS NOT NULL THEN 'quoted' ELSE $2 END, handled_by = $3, updated_at = now() WHERE id = $1 RETURNING *", [id, status, ctx.employee ? ctx.employee.id : null])).rows[0];
  if (!r) fail('notfound', 'That request is gone.');
  await audit(pool, ctx, 'shop.quote_request_' + status, 'shop_quote_request', id, numberOf(r.number) + (status === 'closed' ? ' closed.' : ' opened again.'));
  return requestOut((await pool.query(SELECT + 'WHERE r.id = $1', [id])).rows[0]);
}
// POST /api/shop-orders/quotes/:id/quotation — a draft quotation for the
// customer with the request written in (one: a second press opens it).
async function makeQuotation(ctx, id) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  var r = (await pool.query(SELECT + 'WHERE r.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'That request is gone.');
  if (r.quotation_id) return { quotationId: r.quotation_id, quoteNo: r.quote_no, made: false };
  var price = r.item_id ? Number(((await pool.query('SELECT min(unit_price) AS p FROM catalog_item_variations WHERE item_id = $1 AND active', [r.item_id])).rows[0] || {}).p || 0) : 0;
  var details = [r.size ? 'Size: ' + r.size : '', r.area ? 'Where: ' + r.area : '', r.needed_by ? 'Needed by ' + String(r.needed_by).slice(0, 10) : '', r.note].filter(Boolean).join(' · ');
  var q = await require('./quotations.service').create(ctx, {
    customerId: r.customer_id, currency: 'GHS', title: ('Quotation: ' + r.what).slice(0, 120),
    items: [{ description: r.what.slice(0, 160), qty: r.qty, unitPrice: price, notes: details }],
    notes: 'From quote request ' + numberOf(r.number) + ' on the website.' + (r.budget != null ? ' Their budget: GHS ' + round2(r.budget).toFixed(2) + '.' : '')
  });
  await pool.query("UPDATE shop_quote_requests SET quotation_id = $2, status = 'quoted', handled_by = $3, updated_at = now() WHERE id = $1", [id, q.id, ctx.employee ? ctx.employee.id : null]);
  await audit(pool, ctx, 'shop.quote_request_quoted', 'shop_quote_request', id, numberOf(r.number) + ': draft quotation ' + (q.quoteNo || q.quote_no || '') + ' made.');
  return { quotationId: q.id, quoteNo: q.quoteNo || q.quote_no || '', made: true };
}

// For My account (portal.service.js): a customer's requests and where each stands.
async function ofCustomers(ids) {
  if (!ids.length) return [];
  return (await pool.query(SELECT + "WHERE r.customer_id = ANY($1) AND r.status <> 'closed' ORDER BY r.created_at DESC LIMIT 20", [ids])).rows.map(function (r) {
    return { number: numberOf(r.number), what: r.what, qty: r.qty, status: r.status, createdAt: r.created_at, quoteNo: r.quote_no || null, quoteSent: !!r.quote_status && r.quote_status !== 'draft' };
  });
}

module.exports = { ask: ask, list: list, photoKey: photoKey, setStatus: setStatus, makeQuotation: makeQuotation, ofCustomers: ofCustomers, photoType: photoType,
  MAX_PHOTOS: MAX_PHOTOS, MAX_PHOTO_BYTES: MAX_PHOTO_BYTES, _askedBy: askedBy };
