var crypto = require('crypto');
var config = require('../config');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { notify } = require('../utils/notify');

// Invoices paid online (migration 0184) — Square's "accept payments on
// invoices": the page behind an invoice's link (frontend SharePage.jsx) has
// a Pay button, by card or Mobile Money through Paystack, on Bamboo
// Products' own Paystack account (config.paystackBpl, PAYSTACK_BPL_SECRET_KEY
// — not the restaurants'). The customer pays the whole balance, or the next
// part of its payment schedule. Once Paystack says it is paid (the customer
// coming back to the page, or its webhook), the payment is recorded on the
// invoice with its receipt — the same way as one typed by staff, as made
// online — and the rep is told. A payment is recorded once, whichever comes
// first. Cedi invoices only: Paystack charges in GHS here.

var TIMEOUT_MS = 15000;
var CHECK_EVERY_MS = 3000;
var testFetch = null;
function http() { return testFetch || fetch; }
function setFetchForTests(f) { testFetch = f; }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function configured() { return config.paystackBpl.configured; }
// Recorded by nobody at the office: the audit says it was paid online, and
// the payment is put down as received by the invoice's rep (whoever shared
// the link, the order's rep, the customer's account manager), or else the
// longest-serving person who signs in.
function onlineCtx(receiverId) {
  return { can: function () { return true; }, user: { id: null }, employee: { id: receiverId, first_name: 'Paid online', last_name: '(Paystack)' } };
}
async function receiverFor(row, inv) {
  var share = row.share_id ? (await pool.query('SELECT created_by FROM document_shares WHERE id = $1', [row.share_id])).rows[0] : null;
  var q = inv.quotation_id ? (await pool.query('SELECT created_by FROM quotations WHERE id = $1', [inv.quotation_id])).rows[0] : null;
  var id = (share && share.created_by) || inv.rep_id || inv.account_manager_id || (q && q.created_by);
  if (id) return id;
  var first = (await pool.query("SELECT e.id FROM employees e JOIN users u ON u.employee_id = e.id WHERE e.status = 'active' ORDER BY e.created_at LIMIT 1")).rows[0];
  return first ? first.id : null;
}

async function call(method, path, body) {
  if (!configured()) fail('unavailable', 'Paying online is not set up yet.');
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  try {
    var res = await http()(config.paystackBpl.baseUrl + path, {
      method: method,
      headers: { Authorization: 'Bearer ' + config.paystackBpl.secretKey, 'Content-Type': 'application/json', Accept: 'application/json' },
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

// What a customer may pay now: the whole balance, and the next part of the
// payment schedule when there is one ({ on, why, options: [{ kind, label, amount }] }).
function optionsFor(inv) {
  var balance = round2(inv.balance_due);
  if (!configured()) return { on: false, why: 'off', options: [] };
  if (inv.status === 'void') return { on: false, why: 'void', options: [] };
  if (!(balance > 0)) return { on: false, why: 'paid', options: [] };
  if (inv.currency !== 'GHS') return { on: false, why: 'currency', options: [] };
  if (balance < 1) return { on: false, why: 'small', options: [] };
  var options = [];
  var schedule = Array.isArray(inv.payment_schedule) ? inv.payment_schedule : [];
  if (schedule.length > 1) {
    var paid = round2(inv.amount_paid), cum = 0;
    for (var i = 0; i < schedule.length; i++) {
      cum = round2(cum + Number(schedule[i].amount || 0));
      if (cum > paid + 0.009) {
        var part = round2(Math.min(cum - paid, balance));
        if (part >= 1 && part < balance - 0.009) options.push({ kind: 'next', label: schedule[i].label || 'Next payment', amount: part, dueDate: schedule[i].dueDate || null });
        break;
      }
    }
  }
  options.push({ kind: 'all', label: 'The full balance', amount: balance });
  return { on: true, why: null, options: options };
}

async function shareOf(token) {
  var s = (await pool.query('SELECT * FROM document_shares WHERE token = $1', [String(token || '')])).rows[0];
  if (!s || (s.expires_at && new Date(s.expires_at) < new Date())) fail('notfound', 'This link has expired — ask for a new one.');
  if (s.document_type !== 'invoice') fail('invalid', 'Only an invoice is paid here.');
  return s;
}
function emailFor(cust) {
  var e = String((cust && cust.email) || '').trim();
  if (/^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i.test(e)) return e;
  if (config.paystackBpl.email) return config.paystackBpl.email;
  var host = '';
  try { host = new URL(config.appUrl).hostname.replace(/^(www|app)\./, ''); } catch (e2) { host = ''; }
  return 'payments@' + (host || 'bambooproducts.com');
}
// Back to the invoice's page after paying: one of the OS's own addresses, or
// Bamboo Products' customer website (where the shop's invoices are paid).
function backTo(back, token) {
  var u = null;
  try { u = new URL(String(back || '')); } catch (e) { u = null; }
  var origin = u && config.corsOrigin.concat(config.bplSiteOrigins).indexOf(u.origin) >= 0 ? u.origin : config.appUrl;
  return origin + '/share/' + encodeURIComponent(token);
}

function out(r) {
  return { reference: r.reference, amount: round2(r.amount), currency: r.currency, status: r.status, url: r.url, channel: r.channel || '', recorded: !!r.payment_id, paidAt: r.paid_at || null };
}

// POST /api/share/:token/pay { pay: 'all' | 'next', back } — Paystack's page
// to pay on, for the amount chosen (worked out here, never sent).
async function start(token, p) {
  p = p || {};
  var share = await shareOf(token);
  var inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [share.document_id])).rows[0];
  if (!inv) fail('notfound', 'This invoice no longer exists.');
  var o = optionsFor(inv);
  if (!o.on) fail('conflict', o.why === 'paid' ? 'This invoice is paid. Thank you!' : o.why === 'currency' ? 'This invoice is not in cedis: pay it as its instructions say.' : 'Paying online is not available for this invoice.');
  var pick = o.options.find(function (x) { return x.kind === p.pay; }) || o.options[o.options.length - 1];
  var cust = (await pool.query('SELECT name, email FROM customers WHERE id = $1', [inv.customer_id])).rows[0];
  var reference = 'BPL-' + String(inv.invoice_no).replace(/[^A-Za-z0-9]/g, '') + '-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  var data = await call('POST', '/transaction/initialize', {
    email: emailFor(cust), amount: Math.round(pick.amount * 100), currency: 'GHS', reference: reference,
    channels: ['card', 'mobile_money'], callback_url: backTo(p.back, token),
    metadata: { invoice: inv.invoice_no, customer: cust ? cust.name : '', purpose: 'invoice' }
  });
  var row = (await pool.query(
    'INSERT INTO invoice_online_payments (invoice_id, share_id, reference, amount, currency, url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [inv.id, share.id, reference, pick.amount, inv.currency, String(data.authorization_url || '')])).rows[0];
  return out(row);
}

// Paid: the invoice payment and its receipt, once; the rep told. The row is
// held while it is recorded, so the customer's page and Paystack's webhook
// arriving together record it once: the second waits, then finds it done.
async function settle(row) {
  if (row.status !== 'success' || row.payment_id || row.problem) return row;
  var told = null;
  row = await withTransaction(async function (db) {
    var locked = (await db.query('SELECT * FROM invoice_online_payments WHERE id = $1 FOR UPDATE', [row.id])).rows[0];
    if (!locked || locked.status !== 'success' || locked.payment_id || locked.problem) return locked;
    var inv = (await pool.query('SELECT i.*, c.name AS customer_name, c.account_manager_id, so.rep_id FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN sales_orders so ON so.id = i.sales_order_id WHERE i.id = $1', [locked.invoice_id])).rows[0];
    var method = locked.channel === 'card' ? 'card' : locked.channel === 'mobile_money' ? 'mobile_money' : 'other';
    var recorded = null, problem = null;
    try {
      recorded = await require('./invoices.service').recordPayment(onlineCtx(await receiverFor(locked, inv)), locked.invoice_id, {
        amount: Number(locked.amount), method: method, reference: 'Paystack ' + locked.reference,
        notes: 'Paid online from the invoice\'s link' + (locked.card_brand ? ' · ' + locked.card_brand + (locked.card_last4 ? ' ••' + locked.card_last4 : '') : '')
      }, { source: 'online' });
    } catch (e) { problem = e.message || 'Not recorded.'; }
    locked = recorded
      ? (await db.query('UPDATE invoice_online_payments SET payment_id = $2 WHERE id = $1 RETURNING *', [locked.id, recorded.payment.id])).rows[0]
      : (await db.query('UPDATE invoice_online_payments SET problem = $2 WHERE id = $1 RETURNING *', [locked.id, String(problem).slice(0, 300)])).rows[0];
    told = { inv: inv, method: method, problem: problem };
    return locked;
  });
  if (!told) return row;
  var inv = told.inv;
  var reps = [inv.rep_id, inv.account_manager_id].filter(function (x, i, a) { return x && a.indexOf(x) === i; });
  var amount = inv.currency + ' ' + Number(row.amount).toLocaleString('en-GB', { minimumFractionDigits: 2 });
  for (var i = 0; i < reps.length; i++) {
    await notify(pool, reps[i], told.problem ? '⚠ ' + inv.customer_name + ' paid ' + amount + ' online on ' + inv.invoice_no + ', not recorded' : '💳 ' + inv.customer_name + ' paid ' + amount + ' online on ' + inv.invoice_no,
      told.problem ? told.problem + ' Record it by hand, or refund it in Paystack (' + row.reference + ').' : (told.method === 'mobile_money' ? 'Mobile Money' : told.method === 'card' ? 'Card' : 'Paystack') + ' · ' + row.reference, '/invoices?open=' + inv.id);
  }
  return row;
}

// What Paystack says of it now, kept.
async function record(reference, data) {
  data = data || {};
  var status = data.status === 'success' ? 'success' : data.status === 'failed' ? 'failed' : data.status === 'abandoned' ? 'abandoned' : 'pending';
  var paid = status === 'success';
  var auth = data.authorization || {};
  var row = (await pool.query(
    "UPDATE invoice_online_payments SET checked_at = now(), status = CASE WHEN status = 'success' THEN status ELSE $2 END, " +
    "channel = CASE WHEN $3 <> '' THEN $3 ELSE channel END, card_brand = coalesce($4, card_brand), card_last4 = coalesce($5, card_last4), fees = coalesce($6, fees), " +
    'paid_at = CASE WHEN $7 AND paid_at IS NULL THEN now() ELSE paid_at END WHERE reference = $1 RETURNING *',
    [reference, status, String(data.channel || ''), paid && auth.card_type ? String(auth.card_type).trim().slice(0, 30) : null, paid && /^\d{4}$/.test(String(auth.last4 || '')) ? String(auth.last4) : null,
      paid && data.fees != null ? round2(Number(data.fees) / 100) : null, paid])).rows[0];
  if (row && paid && Number(data.amount) && Math.abs(Number(data.amount) / 100 - Number(row.amount)) > 0.009) {
    row = (await pool.query("UPDATE invoice_online_payments SET status = 'failed' WHERE id = $1 RETURNING *", [row.id])).rows[0];
  }
  return row ? settle(row) : row;
}

// GET /api/share/:token/pay/:reference — the customer back from paying.
async function status(token, reference) {
  var share = await shareOf(token);
  var row = (await pool.query('SELECT * FROM invoice_online_payments WHERE reference = $1 AND invoice_id = $2', [String(reference || ''), share.document_id])).rows[0];
  if (!row) fail('notfound', 'That payment is not for this invoice.');
  if (row.status === 'pending' && !(row.checked_at && Date.now() - new Date(row.checked_at).getTime() < CHECK_EVERY_MS)) {
    try { row = await record(row.reference, await call('GET', '/transaction/verify/' + encodeURIComponent(row.reference))); }
    catch (e) { await pool.query('UPDATE invoice_online_payments SET checked_at = now() WHERE id = $1', [row.id]); }
  } else if (row.status === 'success' && !row.payment_id && !row.problem) row = await settle(row);
  return out(row);
}

// POST /api/share/paystack/webhook — Paystack telling us, signed with BPL's key.
function validSignature(rawBody, signature) {
  if (!configured() || !rawBody || !signature) return false;
  var expected = crypto.createHmac('sha512', config.paystackBpl.secretKey).update(rawBody).digest('hex');
  var a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function webhook(rawBody, signature) {
  if (!validSignature(rawBody, signature)) fail('forbidden', 'Not signed by Paystack.');
  var event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch (e) { fail('invalid', 'Not JSON.'); }
  var data = event && event.data;
  if (!data || !data.reference || event.event !== 'charge.success') return { ok: true };
  var known = (await pool.query('SELECT 1 FROM invoice_online_payments WHERE reference = $1', [String(data.reference)])).rows[0];
  if (known) await record(String(data.reference), data);
  return { ok: true };
}

// For the invoice's page: paying online, and what was paid online already.
async function viewFor(inv) {
  var o = optionsFor(inv);
  var paid = (await pool.query("SELECT reference, amount, channel, paid_at FROM invoice_online_payments WHERE invoice_id = $1 AND status = 'success' ORDER BY paid_at", [inv.id])).rows;
  return { on: o.on, why: o.why, options: o.options, paidOnline: paid.map(function (r) { return { reference: r.reference, amount: round2(r.amount), channel: r.channel, at: r.paid_at }; }) };
}

module.exports = { configured: configured, optionsFor: optionsFor, start: start, status: status, webhook: webhook, validSignature: validSignature, viewFor: viewFor, setFetchForTests: setFetchForTests };
