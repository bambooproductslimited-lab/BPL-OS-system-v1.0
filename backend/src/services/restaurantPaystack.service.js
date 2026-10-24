var crypto = require('crypto');
var config = require('../config');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');

// Card and Mobile Money paid online through Paystack (migration 0177): the
// till shows a QR code the customer pays with on their own phone (a card,
// Apple or Google Pay where Paystack offers them, or Mobile Money), and the
// self-order kiosk takes payment on its own screen. Each payment is started
// here (Paystack's "initialize": an amount, a reference, a page to pay on),
// checked with Paystack ("verify", or its webhook) and used by one sale only
// (restaurantTillMoney.planPayments with opts.paystack).
//
// Needs PAYSTACK_SECRET_KEY on the server (config.paystack); till settings
// card.paystack turns it on for a restaurant.

var TIMEOUT_MS = 15000;
var CHECK_EVERY_MS = 3000;
var testFetch = null;
function http() { return testFetch || fetch; }
function setFetchForTests(f) { testFetch = f; }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function online() { return require('./restaurantOnline.service'); }

function configured() { return config.paystack.configured; }
function onFor(settings) { return configured() && !!(settings.card && settings.card.paystack); }

// One call to Paystack's API, with the secret key (never logged).
async function call(method, path, body) {
  if (!configured()) fail('unavailable', 'Paystack is not set up: an administrator adds PAYSTACK_SECRET_KEY on the server.');
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  try {
    var res = await http()(config.paystack.baseUrl + path, {
      method: method,
      headers: { Authorization: 'Bearer ' + config.paystack.secretKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    var json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok || !json || json.status !== true) fail('unavailable', 'Paystack said no: ' + ((json && json.message) || ('HTTP ' + res.status)) + '.');
    return json.data;
  } catch (e) {
    if (e.code) throw e;
    fail('unavailable', e.name === 'AbortError' ? 'Paystack did not answer in time. Try again.' : 'Paystack could not be reached. Try again.');
  } finally { clearTimeout(timer); }
}

// The email Paystack asks for: the restaurant's (PAYSTACK_EMAIL), else
// payments@ the ordering website's domain.
function emailFor(code) {
  if (config.paystack.email) return config.paystack.email;
  var host = new URL(online().siteUrlFor(code)).hostname.replace(/^(online|www)\./, '');
  return 'payments@' + host;
}

function out(r) {
  return { reference: r.reference, amount: round2(r.amount), status: r.status, url: r.url, channel: r.channel || '', cardBrand: r.card_brand || null, cardLast4: r.card_last4 || null, paidAt: r.paid_at || null, used: !!r.used_by_order,
    tip: round2(r.tip || 0), payer: r.payer || '' };
}

// Starts a payment of `amount` cedis for a restaurant: its page to pay on.
// extra (paying at the table): { tabId, tip, payer } — the open order it is
// for, the tip in it, and the payer's name; meta: what else it is for (a gift
// card bought on the website: restaurantGiftCards buyOnline).
async function begin(companyId, amount, purpose, employeeId, kioskOrderId, callbackUrl, extra) {
  extra = extra || {};
  amount = round2(amount);
  if (!(amount >= 1 && amount <= 100000)) fail('invalid', 'A payment is from GHS 1 to GHS 100,000.');
  var co = (await pool.query('SELECT code FROM companies WHERE id = $1', [companyId])).rows[0];
  var reference = 'BOS-' + co.code + '-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
  var data = await call('POST', '/transaction/initialize', {
    email: emailFor(co.code), amount: Math.round(amount * 100), currency: 'GHS', reference: reference,
    channels: ['card', 'mobile_money'], callback_url: callbackUrl || online().siteUrlFor(co.code) + '/paid',
    metadata: { restaurant: co.code, purpose: purpose }
  });
  var row = (await pool.query(
    'INSERT INTO restaurant_paystack_payments (company_id, reference, amount, purpose, url, created_by, kiosk_order_id, tab_id, tip, payer, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [companyId, reference, amount, purpose, String(data.authorization_url || ''), employeeId || null, kioskOrderId || null, extra.tabId || null, round2(extra.tip || 0), String(extra.payer || '').slice(0, 60), extra.meta || {}])).rows[0];
  return out(row);
}

// What Paystack says of a payment, kept: paid (its channel, card and fees),
// failed, abandoned, or still waiting.
async function check(row, force) {
  if (row.status !== 'pending') return row;
  if (!force && row.checked_at && Date.now() - new Date(row.checked_at).getTime() < CHECK_EVERY_MS) return row;
  var data;
  try { data = await call('GET', '/transaction/verify/' + encodeURIComponent(row.reference)); }
  catch (e) { await pool.query('UPDATE restaurant_paystack_payments SET checked_at = now() WHERE id = $1', [row.id]); return row; }
  return record(row.reference, data);
}
async function record(reference, data) {
  data = data || {};
  var status = data.status === 'success' ? 'success' : data.status === 'failed' ? 'failed' : data.status === 'abandoned' ? 'abandoned' : 'pending';
  var paid = status === 'success';
  var auth = data.authorization || {};
  var row = (await pool.query(
    'UPDATE restaurant_paystack_payments SET checked_at = now(), status = CASE WHEN status = \'success\' THEN status ELSE $2 END, ' +
    "channel = CASE WHEN $3 <> '' THEN $3 ELSE channel END, card_brand = coalesce($4, card_brand), card_last4 = coalesce($5, card_last4), fees = coalesce($6, fees), " +
    'paid_at = CASE WHEN $7 AND paid_at IS NULL THEN now() ELSE paid_at END WHERE reference = $1 RETURNING *',
    [reference, status, String(data.channel || ''), paid && auth.card_type ? cardBrand(auth.card_type) : null, paid && /^\d{4}$/.test(String(auth.last4 || '')) ? String(auth.last4) : null,
      paid && data.fees != null ? round2(Number(data.fees) / 100) : null, paid])).rows[0];
  // Paid less than asked (a changed amount): not good for the sale.
  if (row && paid && Number(data.amount) && Math.abs(Number(data.amount) / 100 - Number(row.amount)) > 0.009) {
    row = (await pool.query("UPDATE restaurant_paystack_payments SET status = 'failed' WHERE id = $1 RETURNING *", [row.id])).rows[0];
  }
  return row;
}
function cardBrand(t) {
  t = String(t || '').toLowerCase();
  return /visa/.test(t) ? 'Visa' : /master/.test(t) ? 'Mastercard' : /verve/.test(t) ? 'Verve' : /amex|american/.test(t) ? 'American Express' : 'Other';
}

async function rowOf(companyId, reference) {
  var r = (await pool.query('SELECT * FROM restaurant_paystack_payments WHERE reference = $1 AND company_id = $2', [String(reference || ''), companyId])).rows[0];
  if (!r) fail('notfound', 'That payment is not this restaurant\'s.');
  return r;
}

// POST /api/pos/paystack { amount } — the till: a payment for the customer
// to make on their phone (its QR code is the page's address).
async function start(token, p) {
  var session = await access.need(token, 'charge');
  if (!onFor(session.access.settings)) fail('conflict', 'Paying by phone through Paystack is not on for this restaurant.');
  return begin(session.posCompanyId, (p || {}).amount, 'till', session.posEmployeeId, null);
}
// GET /api/pos/paystack/:reference — the till waiting for it.
async function status(token, reference) {
  var session = await access.need(token, 'charge');
  return out(await check(await rowOf(session.posCompanyId, reference), false));
}

// For a sale (restaurantPos.chargeOrder): the Paystack payments it is paid
// with, paid and not used by another sale, locked until it is made.
async function claimFor(client, companyId, refs) {
  var map = {};
  for (var i = 0; i < refs.length; i++) {
    var r = await rowOf(companyId, refs[i]);
    if (r.purpose === 'gift') fail('conflict', 'That Paystack payment bought a gift card on the website.');
    if (r.status === 'pending') r = await check(r, true);
    if (r.status !== 'success') fail('conflict', r.status === 'pending' ? 'That Paystack payment is not paid yet.' : 'That Paystack payment did not go through.');
    var locked = (await client.query('SELECT * FROM restaurant_paystack_payments WHERE id = $1 FOR UPDATE', [r.id])).rows[0];
    if (locked.used_by_order) fail('conflict', 'That Paystack payment has paid for a sale already.');
    map[r.reference] = { amount: round2(locked.amount), channel: locked.channel, cardBrand: locked.card_brand, cardLast4: locked.card_last4 };
  }
  return map;
}
async function markUsed(client, refs, orderId) {
  if (refs.length) await client.query('UPDATE restaurant_paystack_payments SET used_by_order = $2 WHERE reference = ANY($1::text[])', [refs, orderId]);
}

// POST /api/pos/paystack/webhook — Paystack telling us, signed with the
// secret key (HMAC SHA-512 of the body, x-paystack-signature).
function validSignature(rawBody, signature) {
  if (!configured() || !rawBody || !signature) return false;
  var expected = crypto.createHmac('sha512', config.paystack.secretKey).update(rawBody).digest('hex');
  var a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function webhook(rawBody, signature) {
  if (!validSignature(rawBody, signature)) fail('forbidden', 'Not signed by Paystack.');
  var event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch (e) { fail('invalid', 'Not JSON.'); }
  var data = event && event.data;
  if (!data || !data.reference) return { ok: true };
  var known = (await pool.query('SELECT 1 FROM restaurant_paystack_payments WHERE reference = $1', [String(data.reference)])).rows[0];
  if (!known) return { ok: true };
  if (event.event === 'charge.success') {
    var row = await record(String(data.reference), data);
    // A gift card bought on the website is made as soon as it is paid.
    if (row && row.purpose === 'gift' && row.status === 'success') await require('./restaurantGiftCards.service').settleOnline(row);
  }
  return { ok: true };
}

// The reconciliation: what came in through Paystack on some days.
async function report(companyId, from, to) {
  var rows = (await pool.query(
    "SELECT p.*, o.order_no FROM restaurant_paystack_payments p LEFT JOIN restaurant_orders o ON o.id = p.used_by_order WHERE p.company_id = $1 AND p.status = 'success' " +
    'AND p.paid_at::date BETWEEN $2 AND $3 ORDER BY p.paid_at DESC LIMIT 500', [companyId, from, to])).rows;
  return rows.map(function (r) { return Object.assign(out(r), { fees: r.fees == null ? null : round2(r.fees), orderNo: r.order_no || null, purpose: r.purpose }); });
}

module.exports = {
  configured: configured, onFor: onFor, begin: begin, check: check, start: start, status: status, claimFor: claimFor, markUsed: markUsed,
  webhook: webhook, validSignature: validSignature, report: report, rowOf: rowOf, out: out, setFetchForTests: setFetchForTests
};
