var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { internationalNumber } = require('../utils/phone');
var { computeDocTotals } = require('../utils/documents');
var config = require('../config');

// Payment links (migration 0189) — Square's: a link for an amount, for
// items from the catalogue, or for what the customer types in (a deposit, a
// balance), sent on WhatsApp, by text or as a QR code. Paid on Bamboo
// Products' website (online.bplghana.com/pay/<token>): the customer gives a
// name and a phone (a link made for a customer asks nothing), an invoice is
// raised for them from the link (invoices.payment_link_id) and they go to
// Paystack to pay it (invoicePay), else to the invoice's page with the bank
// details. A single-use link is done once paid. While Paystack is set up,
// an invoice from a link left unpaid for three days is voided (sweep).

var KINDS = ['amount', 'items', 'open'];
var STATUSES = ['active', 'paused', 'closed'];
var MAX_AMOUNT = 1000000;
var PER_IP_HOUR = 10;
var STALE_DAYS = 3;
var ctxLink = { can: function () { return true; }, user: { id: null }, employee: { id: null, first_name: 'Payment link', last_name: '' } };

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function isEmail(v) { return /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i.test(String(v || '')); }
function isDay(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
function today() { return new Date().toISOString().slice(0, 10); }
function urlOf(token) { return config.bplSiteUrl + '/pay/' + token; }
function kindOf(r) { return r.amount != null ? 'amount' : (r.lines || []).length ? 'items' : 'open'; }
// What a link asks for: its amount, or its items with their tax; nothing
// for one where the customer types the amount.
function totalOf(r) {
  if (r.amount != null) return round2(r.amount);
  if (!(r.lines || []).length) return null;
  return computeDocTotals(r.lines.map(function (l) { return { qty: Number(l.qty), unitPrice: Number(l.unitPrice), taxRate: Number(l.taxRate) || 0 }; }), null, 0).grandTotal;
}
// Open, paused, closed, past its date, or (single use) paid.
function stateOf(r, paidCount) {
  if (r.status !== 'active') return r.status;
  if (r.expires_on && String(r.expires_on instanceof Date ? r.expires_on.toISOString() : r.expires_on).slice(0, 10) < today()) return 'expired';
  if (r.single_use && paidCount > 0) return 'paid';
  return 'open';
}

var STATS = "(SELECT count(*) FILTER (WHERE i.status = 'paid')::int FROM invoices i WHERE i.payment_link_id = l.id) AS paid_count, " +
  "(SELECT coalesce(sum(i.amount_paid), 0) FROM invoices i WHERE i.payment_link_id = l.id AND i.status <> 'void') AS paid_total, " +
  "(SELECT count(*) FILTER (WHERE i.status NOT IN ('paid', 'void'))::int FROM invoices i WHERE i.payment_link_id = l.id) AS open_count";
var SELECT = 'SELECT l.*, c.name AS customer_name, e.first_name AS by_first, e.last_name AS by_last, ' + STATS +
  ' FROM payment_links l LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN employees e ON e.id = l.created_by ';

function linkOut(r) {
  return {
    id: r.id, token: r.token, url: urlOf(r.token), title: r.title, description: r.description, kind: kindOf(r), amount: r.amount != null ? round2(r.amount) : null,
    lines: r.lines || [], total: totalOf(r), customer: r.customer_id ? { id: r.customer_id, name: r.customer_name } : null, singleUse: r.single_use,
    expiresOn: r.expires_on ? String(r.expires_on instanceof Date ? r.expires_on.toISOString() : r.expires_on).slice(0, 10) : null,
    status: r.status, state: stateOf(r, r.paid_count || 0), paidCount: r.paid_count || 0, paidTotal: round2(r.paid_total || 0), openCount: r.open_count || 0,
    createdBy: r.by_first ? r.by_first + ' ' + r.by_last : null, createdAt: r.created_at
  };
}

// The catalogue's items for a link, priced as they are now.
async function linesOf(want) {
  if (!Array.isArray(want) || !want.length) fail('invalid', 'Add at least one item.');
  if (want.length > 20) fail('invalid', 'At most 20 items on one link.');
  var commercial = (await pool.query('SELECT commercial FROM settings WHERE id = 1')).rows[0].commercial || {};
  var out = [];
  for (var i = 0; i < want.length; i++) {
    var w = want[i] || {};
    if (!/^[0-9a-f-]{36}$/i.test(String(w.variationId || ''))) fail('invalid', 'Choose the items from the catalogue.');
    var v = (await pool.query(
      'SELECT v.id, v.name, v.code, v.unit, v.unit_price, v.product_id, i.name AS item_name, i.tax_rate_id FROM catalog_item_variations v JOIN catalog_items i ON i.id = v.item_id WHERE v.id = $1 AND v.active AND i.active',
      [w.variationId])).rows[0];
    if (!v || !(Number(v.unit_price) > 0)) fail('invalid', 'An item on the link is not sold or has no price.');
    var qty = Number(w.qty);
    if (!(Number.isInteger(qty) && qty >= 1 && qty <= 999)) fail('invalid', 'Each quantity is a whole number from 1 to 999.');
    var tax = (commercial.taxRates || []).find(function (t) { return t.id === v.tax_rate_id; });
    out.push({ variationId: v.id, description: (v.name && v.name !== 'Regular' ? v.item_name + ' — ' + v.name : v.item_name).slice(0, 160), qty: qty, unit: v.unit || 'each',
      unitPrice: round2(v.unit_price), taxRate: tax ? Number(tax.rate) : 0, itemNo: v.code || '', productId: v.product_id || null });
  }
  return out;
}

// POST /api/payment-links { title, description, kind: amount|items|open,
// amount, lines: [{ variationId, qty }], customerId, singleUse, expiresOn }
async function create(ctx, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  p = p || {};
  var title = text(p.title, 120);
  if (title.length < 2) fail('invalid', 'Give the link a title the customer will see, e.g. Deposit for the kitchen.');
  var kind = KINDS.indexOf(p.kind) >= 0 ? p.kind : fail('invalid', 'A set amount, items, or the customer types the amount?');
  var amount = null, lines = [];
  if (kind === 'amount') {
    amount = round2(p.amount);
    if (!(amount >= 1 && amount <= MAX_AMOUNT)) fail('invalid', 'The amount is from GHS 1 to GHS 1,000,000.');
  }
  if (kind === 'items') lines = await linesOf(p.lines);
  var customerId = null;
  if (p.customerId) {
    var c = (await pool.query("SELECT id FROM customers WHERE id = $1 AND status = 'active'", [p.customerId])).rows[0];
    if (!c) fail('invalid', 'Choose an active customer, or none.');
    customerId = c.id;
  }
  var expiresOn = null;
  if (p.expiresOn) {
    if (!isDay(p.expiresOn) || p.expiresOn < today()) fail('invalid', 'The last day is today or later.');
    expiresOn = p.expiresOn;
  }
  var row = (await pool.query(
    'INSERT INTO payment_links (token, title, description, amount, lines, customer_id, single_use, expires_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [crypto.randomBytes(12).toString('base64url'), title, text(p.description, 500), amount, JSON.stringify(lines), customerId, !!p.singleUse, expiresOn, ctx.employee.id])).rows[0];
  var r = (await pool.query(SELECT + 'WHERE l.id = $1', [row.id])).rows[0];
  await audit(pool, ctx, 'payment_link.create', 'payment_link', r.id, 'Payment link "' + title + '"' + (totalOf(r) != null ? ' for GHS ' + totalOf(r).toFixed(2) : ', the customer types the amount') + (r.customer_name ? ', for ' + r.customer_name : '') + '.');
  return linkOut(r);
}

// GET /api/payment-links?state= — the links, newest first, with what each took.
async function list(ctx, q) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  q = q || {};
  var rows = (await pool.query(SELECT + 'ORDER BY l.created_at DESC LIMIT 300')).rows.map(linkOut);
  var all = rows;
  if (q.state === 'open') rows = rows.filter(function (r) { return r.state === 'open'; });
  else if (q.state === 'done') rows = rows.filter(function (r) { return r.state !== 'open'; });
  return {
    links: rows, payOnline: require('./invoicePay.service').configured(), siteUrl: config.bplSiteUrl,
    summary: { open: all.filter(function (r) { return r.state === 'open'; }).length, paidCount: all.reduce(function (a, r) { return a + r.paidCount; }, 0), paidTotal: round2(all.reduce(function (a, r) { return a + r.paidTotal; }, 0)) }
  };
}

// GET /api/payment-links/:id — a link and the invoices raised from it.
async function get(ctx, id) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  var r = (await pool.query(SELECT + 'WHERE l.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'That payment link is gone.');
  var invoices = (await pool.query(
    'SELECT i.id, i.invoice_no, i.status, i.grand_total, i.amount_paid, i.issued_at, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.payment_link_id = $1 ORDER BY i.issued_at DESC, i.invoice_no DESC LIMIT 100', [id])).rows;
  return Object.assign(linkOut(r), {
    invoices: invoices.map(function (i) { return { id: i.id, invoiceNo: i.invoice_no, status: i.status, total: round2(i.grand_total), paid: round2(i.amount_paid), customer: i.customer_name, issuedAt: i.issued_at }; })
  });
}

// PATCH /api/payment-links/:id { status: active|paused|closed } — paused
// and back again; closed for good.
async function setStatus(ctx, id, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var status = STATUSES.indexOf((p || {}).status) >= 0 ? p.status : fail('invalid', 'Open, paused or closed?');
  var r = (await pool.query('SELECT * FROM payment_links WHERE id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'That payment link is gone.');
  if (r.status === 'closed' && status !== 'closed') fail('conflict', 'A closed link stays closed. Make a new one.');
  await pool.query('UPDATE payment_links SET status = $2 WHERE id = $1', [id, status]);
  if (r.status !== status) await audit(pool, ctx, 'payment_link.' + status, 'payment_link', id, 'Payment link "' + r.title + '" ' + (status === 'active' ? 'opened again' : status) + '.');
  return get(ctx, id);
}

// ── the customer's side ──

async function byToken(token) {
  if (!/^[A-Za-z0-9_-]{12,64}$/.test(String(token || ''))) fail('notfound', 'We cannot find that payment link.');
  var r = (await pool.query(SELECT + 'WHERE l.token = $1', [token])).rows[0];
  if (!r) fail('notfound', 'We cannot find that payment link.');
  return r;
}
function publicOut(r) {
  var o = linkOut(r);
  return {
    title: o.title, description: o.description, kind: o.kind, amount: o.amount, total: o.total, state: o.state, currency: 'GHS',
    lines: o.lines.map(function (l) { return { description: l.description, qty: l.qty, unitPrice: l.unitPrice, taxRate: l.taxRate }; }),
    // Made for a customer: their first name to greet, nothing more.
    forName: r.customer_name ? String(r.customer_name).split(' ')[0] : null,
    payOnline: require('./invoicePay.service').configured()
  };
}
// GET /api/pay/:token — the link's page.
async function view(token) { return publicOut(await byToken(token)); }

var paidBy = new Map(); // address -> [times]
function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (paidBy.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Too many tries from here in the last hour. Call us instead.');
  list.push(now);
  paidBy.set(key, list);
  if (paidBy.size > 5000) paidBy.clear();
}

// POST /api/pay/:token { name, phone, email, amount (when the customer
// types it), note, website (left empty: a form robot fills it) } — the
// invoice for this customer (the one already raised from the link for them
// and still unpaid, when there is one for the same amount), its page, and
// Paystack's page to pay on when online payment is set up.
async function pay(token, p, ip) {
  p = p || {};
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  var r = await byToken(token);
  var state = stateOf(r, r.paid_count || 0);
  if (state !== 'open') {
    fail('conflict', state === 'paid' ? 'This link has been paid. Thank you!' : state === 'expired' ? 'This link has expired. Ask us for a new one.' : 'This link is not taking payments. Ask us for a new one.');
  }
  var total = totalOf(r);
  var items;
  if (total == null) {
    var typed = round2(p.amount);
    if (!(typed >= 1 && typed <= MAX_AMOUNT)) fail('invalid', 'Type the amount to pay, from GHS 1.');
    total = typed;
    items = [{ description: r.title, qty: 1, unitPrice: typed }];
  } else if (r.amount != null) {
    items = [{ description: r.title, qty: 1, unitPrice: round2(r.amount) }];
  } else {
    items = r.lines.map(function (l) { return { description: l.description, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, taxRate: l.taxRate, itemNo: l.itemNo, productId: l.productId }; });
  }
  var note = text(p.note, 300);
  var customerId = r.customer_id;
  if (!customerId) {
    var name = text(p.name, 120);
    if (name.length < 2) fail('invalid', 'Type your name.');
    var phone = text(p.phone, 30);
    if (!internationalNumber(phone)) fail('invalid', 'Type a phone number we can call, e.g. 024 412 3456.');
    var email = text(p.email, 160).toLowerCase();
    if (email && !isEmail(email)) fail('invalid', 'That email address does not look right.');
    throttle(ip);
    customerId = await withTransaction(function (client) { return require('./shop.service').customerFor(client, { name: name, phone: phone, email: email, address: '' }); });
  } else {
    throttle(ip);
  }

  var shares = require('./shares.service');
  // The same customer back for the same amount: the invoice they already have.
  var again = (await pool.query(
    "SELECT i.id, i.invoice_no, i.grand_total FROM invoices i WHERE i.payment_link_id = $1 AND i.customer_id = $2 AND i.status = 'unpaid' AND i.amount_paid = 0 AND i.grand_total = $3 " +
    "AND i.issued_at >= current_date - $4::int ORDER BY i.issued_at DESC, i.invoice_no DESC LIMIT 1", [r.id, customerId, total, STALE_DAYS - 1])).rows[0];
  var inv;
  if (again) {
    inv = { id: again.id, invoiceNo: again.invoice_no, grandTotal: round2(again.grand_total) };
  } else {
    inv = await require('./invoices.service').createManual(ctxLink, {
      customerId: customerId, currency: 'GHS', items: items, dueDate: today(),
      notes: ('Paid by link: ' + r.title + (note ? '. ' + note : '') + '.').slice(0, 1000)
    });
    await pool.query('UPDATE invoices SET payment_link_id = $2 WHERE id = $1', [inv.id, r.id]);
    var who = (await pool.query('SELECT name FROM customers WHERE id = $1', [customerId])).rows[0];
    await audit(pool, ctxLink, 'payment_link.invoice', 'payment_link', r.id, (who ? who.name : 'A customer') + ' opened "' + r.title + '": ' + inv.invoiceNo + ', GHS ' + round2(inv.grandTotal).toFixed(2) + '.');
    if (r.created_by) await notify(pool, r.created_by, '🔗 ' + r.title, (who ? who.name : 'A customer') + ' is paying GHS ' + round2(inv.grandTotal).toFixed(2) + ' (' + inv.invoiceNo + ').', '/payment-links?open=' + r.id);
  }
  // A fresh link to the invoice's page; it is the creator's, so a payment
  // is put down as received by them.
  var link = await shares.issueLink('invoice', inv.id, 30, r.created_by || null);
  var out = { invoiceNo: inv.invoiceNo, total: round2(inv.grandTotal), token: link.token, url: config.bplSiteUrl + '/share/' + link.token, payUrl: null };
  var invoicePay = require('./invoicePay.service');
  if (invoicePay.configured()) {
    try { out.payUrl = (await invoicePay.start(link.token, { pay: 'all', back: config.bplSiteUrl })).url || null; } catch (e) { out.payUrl = null; /* the invoice's page has the button */ }
  }
  return out;
}

// Unpaid invoices from links left three days, voided, while Paystack is
// set up (without it they are paid by bank, which can take longer). Says
// how many.
async function sweep() {
  if (!require('./invoicePay.service').configured()) return 0;
  var stale = (await pool.query(
    "SELECT i.id FROM invoices i WHERE i.payment_link_id IS NOT NULL AND i.status = 'unpaid' AND i.amount_paid = 0 AND i.issued_at < current_date - $1::int " +
    "AND NOT EXISTS (SELECT 1 FROM invoice_online_payments op WHERE op.invoice_id = i.id AND op.created_at > now() - interval '1 day') LIMIT 200", [STALE_DAYS])).rows;
  var n = 0;
  for (var i = 0; i < stale.length; i++) {
    try { await require('./invoices.service').voidInvoice(ctxLink, stale[i].id, 'Payment link not paid in ' + STALE_DAYS + ' days.'); n++; } catch (e) { /* tried again next time */ }
  }
  return n;
}

module.exports = { create: create, list: list, get: get, setStatus: setStatus, view: view, pay: pay, sweep: sweep, _paidBy: paidBy };
