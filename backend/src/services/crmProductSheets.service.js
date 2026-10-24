var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var config = require('../config');

// Products sent to a customer on WhatsApp (frontend SendProducts.jsx, from
// a lead or a customer): the rep picks items from the catalogue — Products
// & Services — and the OS writes the message (each item and its price, and
// a link) and opens WhatsApp on the rep's phone with it ready to send. The
// link is a page of its own (the OS's /p/:token, ProductSheetPage.jsx)
// that the customer opens without signing in: the photos, what each is,
// the price, the rep's note, and a button to reply on WhatsApp. What was
// sent is kept as it was (a price changed later does not change it); the
// link lasts 60 days. Each opening is counted, and the rep is told the
// first time (a staff preview, ?preview=1, is not counted). The lead's
// history says what was sent.

var DAYS = 60;
var MAX_ITEMS = 12;

function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function str(v, max) { v = v == null ? '' : String(v).trim(); return max ? v.slice(0, max) : v; }
function money(n, cur) { return (cur || 'GHS') + ' ' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
// A number WhatsApp can open a chat with: Ghana's 0XX… and 9 digits become 233…
function waNumber(v) {
  var d = String(v || '').replace(/\D/g, '');
  if (d.length === 10 && d[0] === '0') d = '233' + d.slice(1);
  else if (d.length === 9) d = '233' + d;
  return d.length >= 10 && d.length <= 15 ? d : null;
}
// The OS's address the link points at: the one the rep is using, if it is
// the OS (the sales app sends the OS's address too, lib/osOrigin.js), else APP_URL.
function baseOf(origin) {
  var o = str(origin).replace(/\/+$/, '');
  return o && config.corsOrigin.indexOf(o) >= 0 ? o : config.appUrl;
}
function firstName(name) { return str(name).split(/\s+/)[0] || ''; }

function message(to, items, note, rep, url, currency) {
  var lines = [];
  lines.push((firstName(to) ? 'Hello ' + firstName(to) + ',' : 'Hello,'));
  lines.push('');
  lines.push(items.length === 1 ? 'Here is the product we talked about:' : 'Here are the products we talked about:');
  lines.push('');
  items.forEach(function (it) {
    var per = it.unit && it.unit !== 'each' ? ' / ' + it.unit : it.qty > 1 ? ' each' : '';
    lines.push('• ' + (it.qty > 1 ? it.qty + ' × ' : '') + it.name + ' — ' + money(it.price, currency) + per + (it.qty > 1 ? ' (' + money(it.price * it.qty, currency) + ')' : ''));
  });
  if (note) { lines.push(''); lines.push(note); }
  lines.push('');
  lines.push('Photos and details: ' + url);
  lines.push('');
  lines.push(rep ? rep + ', Bamboo Products Limited' : 'Bamboo Products Limited');
  return lines.join('\n');
}

// What the catalogue has for these variations now: name, price, unit, photo.
async function catalogItems(ids) {
  var res = await pool.query(
    "SELECT v.id, v.name AS variation, v.unit, v.unit_price, v.active, i.name AS item, i.description, i.active AS item_active, " +
    '(SELECT p.id FROM catalog_item_photos p WHERE p.item_id = v.item_id ORDER BY (p.variation_id = v.id) IS TRUE DESC, p.position LIMIT 1) AS photo_id ' +
    'FROM catalog_item_variations v JOIN catalog_items i ON i.id = v.item_id WHERE v.id = ANY($1::uuid[])', [ids]);
  var out = {};
  res.rows.forEach(function (r) {
    var v = String(r.variation || '').trim();
    out[r.id] = {
      variationId: r.id, name: !v || v.toLowerCase() === 'regular' ? r.item : r.item + ' (' + v + ')', description: r.description || '',
      unit: r.unit || '', price: Number(r.unit_price), photoId: r.photo_id || null, onSale: r.active && r.item_active
    };
  });
  return out;
}

async function whoFor(p) {
  if (p.leadId) {
    var l = (await pool.query('SELECT id, name, phone, customer_id FROM crm_leads WHERE id = $1', [p.leadId])).rows[0];
    if (!l) fail('notfound', 'Lead not found.');
    return { leadId: l.id, customerId: l.customer_id || null, name: l.name, phone: l.phone || '' };
  }
  if (p.customerId) {
    var c = (await pool.query('SELECT id, name, contact_person, phone FROM customers WHERE id = $1', [p.customerId])).rows[0];
    if (!c) fail('notfound', 'Customer not found.');
    return { leadId: null, customerId: c.id, name: c.contact_person || c.name, phone: c.phone || '' };
  }
  fail('invalid', 'Who is it for? Send products from a lead or a customer.');
}

function rowOut(r) {
  return {
    id: r.id, leadId: r.lead_id, customerId: r.customer_id, toName: r.to_name, toPhone: r.to_phone,
    items: r.items, note: r.note, currency: r.currency, sentAt: r.created_at, sentBy: r.sent_by_name || null,
    views: r.views, firstViewedAt: r.first_viewed_at, lastViewedAt: r.last_viewed_at, expiresAt: r.expires_at
  };
}

// POST /api/crm/product-sheets { leadId | customerId, items: [{ variationId, qty }], note, phone, origin }
async function create(ctx, p) {
  need(ctx, 'crm.manage');
  need(ctx, 'catalog.read');
  p = p || {};
  var to = await whoFor(p);
  var asked = (Array.isArray(p.items) ? p.items : []).filter(function (x) { return x && x.variationId; });
  if (!asked.length) fail('invalid', 'Pick at least one product to send.');
  if (asked.length > MAX_ITEMS) fail('invalid', 'Send up to ' + MAX_ITEMS + ' products at a time.');
  var found = await catalogItems(asked.map(function (x) { return x.variationId; }));
  var items = asked.map(function (x) {
    var it = found[x.variationId];
    if (!it) fail('invalid', 'One of those products is no longer in the catalogue.');
    if (!it.onSale) fail('invalid', it.name + ' is archived: pick another.');
    var qty = Math.max(1, Math.min(999, Math.round(Number(x.qty) || 1)));
    return { variationId: it.variationId, name: it.name, description: it.description, unit: it.unit, price: it.price, qty: qty, photoId: it.photoId };
  });
  var phone = str(p.phone, 40) || to.phone;
  var note = str(p.note, 600);
  var token = crypto.randomBytes(18).toString('base64url');
  var url = baseOf(p.origin) + '/p/' + token;
  var rep = ctx.employee ? (ctx.employee.first_name + ' ' + ctx.employee.last_name).trim() : '';
  var currency = 'GHS';
  var text = message(to.name, items, note, rep, url, currency);
  var id = await withTransaction(async function (db) {
    var sid = (await db.query(
      'INSERT INTO crm_product_sheets (token, lead_id, customer_id, to_name, to_phone, items, note, currency, sent_by, expires_at) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + interval '" + DAYS + " days') RETURNING id",
      [token, to.leadId, to.customerId, to.name, phone, JSON.stringify(items), note, currency, me(ctx)])).rows[0].id;
    if (to.leadId) {
      await db.query("INSERT INTO crm_lead_notes (lead_id, kind, body, by_employee) VALUES ($1, 'note', $2, $3)",
        [to.leadId, 'Sent ' + (items.length === 1 ? items[0].name : items.length + ' products (' + items.map(function (i) { return i.name; }).join(', ') + ')') + ' on WhatsApp.', me(ctx)]);
    }
    await audit(db, ctx, 'crm.products.send', 'crm_product_sheet', sid, 'Sent ' + items.length + ' product' + (items.length === 1 ? '' : 's') + ' to ' + to.name + '.');
    return sid;
  });
  var wa = waNumber(phone);
  return {
    id: id, url: url, message: text, phone: phone, hasNumber: !!wa,
    whatsappUrl: 'https://wa.me/' + (wa || '') + '?text=' + encodeURIComponent(text),
    sheet: (await listWhere('s.id = $1', [id]))[0]
  };
}

async function listWhere(where, args) {
  var res = await pool.query(
    "SELECT s.*, e.first_name || ' ' || e.last_name AS sent_by_name FROM crm_product_sheets s LEFT JOIN employees e ON e.id = s.sent_by WHERE " + where + ' ORDER BY s.created_at DESC LIMIT 20', args);
  return res.rows.map(rowOut);
}

// GET /api/crm/product-sheets?leadId= | customerId= — what was sent before, and whether it was opened.
async function list(ctx, q) {
  need(ctx, 'crm.read');
  q = q || {};
  if (q.leadId) return listWhere('s.lead_id = $1', [q.leadId]);
  if (q.customerId) return listWhere('s.customer_id = $1', [q.customerId]);
  fail('invalid', 'Which lead or customer?');
}

async function byToken(token) {
  var r = (await pool.query(
    "SELECT s.*, e.first_name AS rep_first, e.last_name AS rep_last, e.phone AS rep_phone FROM crm_product_sheets s LEFT JOIN employees e ON e.id = s.sent_by WHERE s.token = $1",
    [String(token || '')])).rows[0];
  if (!r || new Date(r.expires_at) < new Date()) fail('notfound', 'This link has expired. Ask us on WhatsApp and we will send it again.');
  return r;
}

// GET /api/public/products/:token — the customer's page. Counted unless a preview.
async function view(token, opts) {
  var r = await byToken(token);
  if (!(opts && opts.preview)) {
    var first = (await pool.query(
      'UPDATE crm_product_sheets SET views = views + 1, first_viewed_at = coalesce(first_viewed_at, now()), last_viewed_at = now() WHERE id = $1 RETURNING views',
      [r.id])).rows[0].views === 1;
    if (first && r.sent_by) {
      var link = r.lead_id ? '/crmleads?lead=' + r.lead_id : r.customer_id ? '/crmcustomers?id=' + r.customer_id : null;
      try { await notify(pool, r.sent_by, (r.to_name || 'Your customer') + ' opened the products you sent', r.items.map(function (i) { return i.name; }).join(', '), link); } catch (e) { /* the page shows either way */ }
    }
  }
  var base = '/public/products/' + encodeURIComponent(token) + '/photos/';
  var items = r.items.map(function (i) {
    return { name: i.name, description: i.description || '', unit: i.unit || '', price: i.price, qty: i.qty, photo: i.photoId ? base + i.photoId : null };
  });
  return {
    to: firstName(r.to_name), note: r.note, currency: r.currency, sentAt: r.created_at, expiresAt: r.expires_at,
    rep: { name: str((r.rep_first || '') + ' ' + (r.rep_last || '')), whatsapp: waNumber(r.rep_phone) },
    items: items, total: items.reduce(function (a, i) { return a + i.price * i.qty; }, 0)
  };
}

// GET /api/public/products/:token/photos/:photoId — only the photos of what was sent.
async function photo(token, photoId) {
  var r = await byToken(token);
  if (!r.items.some(function (i) { return i.photoId && i.photoId === photoId; })) fail('notfound', 'Photo not found.');
  var p = (await pool.query('SELECT photo_key FROM catalog_item_photos WHERE id = $1', [photoId])).rows[0];
  if (!p) fail('notfound', 'Photo not found.');
  return p.photo_key;
}

module.exports = { create: create, list: list, view: view, photo: photo, waNumber: waNumber, _message: message };
