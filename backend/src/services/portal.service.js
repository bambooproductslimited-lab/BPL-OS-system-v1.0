var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { internationalNumber } = require('../utils/phone');
var config = require('../config');

// "My account" on Bamboo Products' website (online.bplghana.com/account,
// migration 0191) — Square's customer accounts: a customer types the email
// or the phone number we have for them, gets a six-digit code there, and
// with it sees their own orders from the shop (to follow), their invoices
// (to pay), their quotations and estimates (to approve), their bookings and
// their contracts (to sign). A code is sent only to an address on file, and
// the answer does not say whether it is one. No password to keep.

var CODE_MINUTES = 10;
var MAX_TRIES = 5;
var SESSION_DAYS = 30;
var PER_ADDRESS = 3;   // codes in 15 minutes
var PER_IP_HOUR = 12;

function hash(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function dayText(d) { return d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null; }

// The address typed, as kept: { kind: email|phone, address } or nothing.
function addressOf(raw) {
  var v = String(raw == null ? '' : raw).trim();
  if (v.indexOf('@') >= 0) {
    v = v.toLowerCase();
    return /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i.test(v) ? { kind: 'email', address: v } : null;
  }
  var d = internationalNumber(v);
  return d ? { kind: 'phone', address: d } : null;
}
function masked(a) {
  if (a.kind === 'email') { var p = a.address.split('@'); return p[0].slice(0, 2) + '•••@' + p[1]; }
  return '+' + a.address.slice(0, 3) + ' ••• ' + a.address.slice(-3);
}

// The customers that address is theirs: the CRM's identities and the
// customers' own email or phone (the last nine digits of a phone).
async function customerIds(a) {
  var rows = a.kind === 'email'
    ? (await pool.query("SELECT ci.customer_id AS id FROM customer_identities ci WHERE ci.kind = 'email' AND ci.value = $1 UNION SELECT c.id FROM customers c WHERE lower(c.email) = $1", [a.address])).rows
    : (await pool.query("SELECT ci.customer_id AS id FROM customer_identities ci WHERE ci.kind = 'phone' AND ci.value = $1 UNION SELECT c.id FROM customers c WHERE length(regexp_replace(c.phone, '\\D', '', 'g')) >= 9 AND right(regexp_replace(c.phone, '\\D', '', 'g'), 9) = right($1, 9)", [a.address])).rows;
  return rows.map(function (r) { return r.id; });
}

var askedBy = new Map(); // address of the request -> [times]
function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (askedBy.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Too many codes asked for from here. Try again in an hour.');
  list.push(now); askedBy.set(key, list);
  if (askedBy.size > 5000) askedBy.clear();
}

function canSend(a) {
  var sms = require('./sms.service'), mail = require('./mail.service');
  if (a.kind === 'phone' && !sms.configured()) fail('unavailable', 'We cannot send codes by text right now. Use your email address instead.');
  if (a.kind === 'email' && !mail.configured()) fail('unavailable', 'We cannot send codes by email right now. Use your phone number instead.');
}

// POST /api/portal/code { address } — a code to that address, when it is
// one we have; the same answer either way.
async function sendCode(p, ip) {
  var a = addressOf((p || {}).address);
  if (!a) fail('invalid', 'Type the email or the phone number you gave us.');
  canSend(a);
  throttle(ip);
  await notTooMany(a);
  var out = { sent: true, kind: a.kind, to: masked(a), minutes: CODE_MINUTES };
  if (!(await customerIds(a)).length) return out;
  await issue(a, ip, null);
  return out;
}

// POST /api/portal/signup { name, email, phone } — a new account: the code
// goes to the email (else the phone), and the customer is made once it is
// typed back (login), so nobody is added for an address not theirs. One we
// have already just gets a sign-in code; the answer is the same either way.
async function signup(p, ip) {
  p = p || {};
  var name = String(p.name == null ? '' : p.name).replace(/\s+/g, ' ').trim().slice(0, 120);
  if (name.length < 2) fail('invalid', 'Type your name.');
  var email = String(p.email || '').trim() ? addressOf(String(p.email).trim()) : null;
  if (String(p.email || '').trim() && (!email || email.kind !== 'email')) fail('invalid', 'That email address does not look right.');
  var phone = String(p.phone || '').trim() ? addressOf(p.phone) : null;
  if (String(p.phone || '').trim() && (!phone || phone.kind !== 'phone')) fail('invalid', 'Type a phone number we can call, e.g. 024 412 3456.');
  if (!email && !phone) fail('invalid', 'Type your email or your phone number.');
  var a = email && require('./mail.service').configured() ? email : phone || email;
  canSend(a);
  throttle(ip);
  await notTooMany(a);
  var known = (await customerIds(a)).length > 0;
  await issue(a, ip, known ? null : { name: name, email: email ? email.address : '', phone: phone ? phone.address : '' });
  return { sent: true, kind: a.kind, to: masked(a), minutes: CODE_MINUTES, address: a.kind === 'email' ? a.address : '+' + a.address };
}

async function notTooMany(a) {
  var recent = Number((await pool.query("SELECT count(*) AS n FROM portal_codes WHERE kind = $1 AND address = $2 AND created_at > now() - interval '15 minutes'", [a.kind, a.address])).rows[0].n);
  if (recent >= PER_ADDRESS) fail('ratelimited', 'We sent a few codes already. Use the last one, or try again in 15 minutes.');
}

// A code to the address, kept hashed; with a new account's details to make.
async function issue(a, ip, newAccount) {
  var sms = require('./sms.service'), mail = require('./mail.service');
  var code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await pool.query('INSERT INTO portal_codes (kind, address, code_hash, expires_at, ip, signup) VALUES ($1, $2, $3, now() + ($4 || \' minutes\')::interval, $5, $6)',
    [a.kind, a.address, hash(a.address + ':' + code), String(CODE_MINUTES), String(ip || '').slice(0, 60), newAccount ? JSON.stringify(newAccount) : null]);
  var words = 'Your Bamboo Products ' + (newAccount ? 'code to make your account' : 'sign-in code') + ' is ' + code + '. It works for ' + CODE_MINUTES + ' minutes. If you did not ask for it, ignore this message.';
  try {
    if (a.kind === 'phone') await sms.send({ to: '+' + a.address, message: words, purpose: 'portal_code', logMessage: 'Your Bamboo Products ' + (newAccount ? 'code to make your account' : 'sign-in code') + ' is ••••••.' });
    else await mail.send({ to: a.address, subject: 'Your sign-in code: ' + code, fromName: 'Bamboo Products', text: words,
      html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937"><p>Your Bamboo Products ' + (newAccount ? 'code to make your account' : 'sign-in code') + ' is</p><p style="font-size:30px;font-weight:800;letter-spacing:6px;margin:12px 0">' + code + '</p><p>It works for ' + CODE_MINUTES + ' minutes. If you did not ask for it, ignore this email.</p></div>' });
  } catch (e) { fail('unavailable', 'The code could not be sent just now. Try again in a minute.'); }
}

// POST /api/portal/login { address, code } — the session, for 30 days.
async function login(p) {
  p = p || {};
  var a = addressOf(p.address);
  if (!a) fail('invalid', 'Type the email or the phone number you gave us.');
  var code = String(p.code || '').replace(/\D/g, '');
  var row = (await pool.query('SELECT * FROM portal_codes WHERE kind = $1 AND address = $2 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1', [a.kind, a.address])).rows[0];
  if (!row || row.tries >= MAX_TRIES) fail('invalid', 'That code is not right, or it has expired. Ask for a new one.');
  if (code.length !== 6 || hash(a.address + ':' + code) !== row.code_hash) {
    await pool.query('UPDATE portal_codes SET tries = tries + 1 WHERE id = $1', [row.id]);
    fail('invalid', 'That code is not right, or it has expired. Ask for a new one.');
  }
  var used = await pool.query('UPDATE portal_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [row.id]);
  if (!used.rowCount) fail('invalid', 'That code was used already. Ask for a new one.');
  if (row.signup && !(await customerIds(a)).length) await makeAccount(a, row.signup);
  var token = crypto.randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO portal_sessions (token_hash, kind, address, expires_at) VALUES ($1, $2, $3, now() + ($4 || \' days\')::interval)',
    [hash(token), a.kind, a.address, String(SESSION_DAYS)]);
  return { token: token };
}

// The customer for a new account, its address now proven: a lead from the
// website, with that address (and the other one typed, unless another
// customer has it) as theirs.
async function makeAccount(a, d) {
  var inbox = require('./crmInbox.service');
  var email = a.kind === 'email' ? a.address : String(d.email || '');
  var phone = a.kind === 'phone' ? a.address : String(d.phone || '');
  // The other one typed is not proven: left off when another customer has it.
  if (a.kind === 'email' && phone && (await customerIds({ kind: 'phone', address: phone })).length) phone = '';
  if (a.kind === 'phone' && email && (await customerIds({ kind: 'email', address: email })).length) email = '';
  var ids = [inbox.normIdentity({ kind: a.kind, value: a.kind === 'phone' ? '+' + a.address : a.address }),
    a.kind === 'phone' && email ? inbox.normIdentity({ kind: 'email', value: email }) : null,
    a.kind === 'email' && phone ? inbox.normIdentity({ kind: 'phone', value: '+' + phone }) : null].filter(Boolean);
  var companyId = await inbox.crmCompanyId();
  await require('../db/pool').withTransaction(async function (client) {
    var id = (await client.query(
      "INSERT INTO customers (name, phone, email, category, source, origin_channel, company_id) VALUES ($1, $2, $3, 'lead', 'crm', 'website', $4) RETURNING id",
      [String(d.name || '').slice(0, 120) || 'Website customer', phone ? '+' + phone : '', email, companyId])).rows[0].id;
    await inbox.addIdentities(client, id, ids);
  });
}

async function sessionOf(token) {
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(String(token || ''))) fail('auth', 'Sign in again.');
  var s = (await pool.query('SELECT * FROM portal_sessions WHERE token_hash = $1 AND expires_at > now()', [hash(token)])).rows[0];
  if (!s) fail('auth', 'Sign in again.');
  return s;
}
// POST /api/portal/logout
async function logout(token) {
  if (token) await pool.query('DELETE FROM portal_sessions WHERE token_hash = $1', [hash(token)]);
  return { ok: true };
}

// A live link to a document's page: one already given that lasts, else a new one.
async function shareOf(type, id) {
  var r = (await pool.query("SELECT token FROM document_shares WHERE document_type = $1 AND document_id = $2 AND expires_at > now() + interval '2 days' ORDER BY expires_at DESC LIMIT 1", [type, id])).rows[0];
  if (r) return r.token;
  return (await require('./shares.service').issueLink(type, id, 30, null)).token;
}

// GET /api/portal/me — everything of theirs, newest first; what waits on
// them (to pay, to approve, to sign) first in each list.
async function me(token) {
  var s = await sessionOf(token);
  var a = { kind: s.kind, address: s.address };
  var ids = await customerIds(a);
  var site = config.bplSiteUrl;
  var c = ids.length ? (await pool.query("SELECT name, phone, email, address FROM customers WHERE id = ANY($1) ORDER BY (status = 'active') DESC, created_at LIMIT 1", [ids])).rows[0] || {} : {};
  var out = { name: String(c.name || '').replace(/\s+/g, ' ').trim(), signedInAs: masked(a), kind: a.kind, orders: [], invoices: [], quotes: [], requests: [], bookings: [], contracts: [] };
  if (!ids.length) return out;
  // Their details, to fill the shop's checkout: the address signed in with,
  // the rest from their customer record.
  out.profile = { name: out.name, phone: a.kind === 'phone' ? '+' + a.address : c.phone || '', email: a.kind === 'email' ? a.address : c.email || '', address: c.address || '' };

  out.orders = (await pool.query(
    "SELECT o.order_no, o.status, o.fulfilment, o.total, o.created_at, o.token, o.ready_by, o.lines FROM shop_orders o WHERE o.customer_id = ANY($1) ORDER BY o.created_at DESC LIMIT 50", [ids])).rows
    .map(function (o) { return { orderNo: o.order_no, status: o.status, fulfilment: o.fulfilment, total: round2(o.total), placedAt: o.created_at, readyBy: dayText(o.ready_by), items: (o.lines || []).reduce(function (n, l) { return n + Number(l.qty || 0); }, 0), url: o.token ? site + '/o/' + o.token : null }; });

  var inv = (await pool.query(
    "SELECT id, invoice_no, status, grand_total, balance_due, amount_paid, currency, due_date, issued_at FROM invoices WHERE customer_id = ANY($1) AND status IN ('unpaid', 'partially_paid', 'paid') AND issued_at > current_date - 730 " +
    "ORDER BY (status <> 'paid') DESC, issued_at DESC, invoice_no DESC LIMIT 60", [ids])).rows;
  for (var i = 0; i < inv.length; i++) {
    var r = inv[i], owing = r.status !== 'paid';
    out.invoices.push({ invoiceNo: r.invoice_no, status: r.status, total: round2(r.grand_total), balance: round2(r.balance_due), paid: round2(r.amount_paid), currency: r.currency,
      dueDate: dayText(r.due_date), issuedAt: dayText(r.issued_at), overdue: owing && !!r.due_date && dayText(r.due_date) < new Date().toISOString().slice(0, 10),
      url: site + '/share/' + await shareOf('invoice', r.id) });
  }
  var quotes = (await pool.query(
    "SELECT 'quotation' AS type, id, quote_no AS no, title, status, grand_total, currency, valid_until, client_answer, created_at FROM quotations WHERE customer_id = ANY($1) AND status IN ('sent', 'viewed', 'accepted', 'rejected', 'expired') " +
    "UNION ALL SELECT 'estimate', id, estimate_no, '', status, grand_total, currency, valid_until, client_answer, created_at FROM estimates WHERE customer_id = ANY($1) AND status IN ('finalized', 'converted') " +
    'ORDER BY created_at DESC LIMIT 40', [ids])).rows;
  for (var q = 0; q < quotes.length; q++) {
    var d = quotes[q];
    var open = !d.client_answer && ((d.type === 'quotation' && (d.status === 'sent' || d.status === 'viewed')) || (d.type === 'estimate' && d.status === 'finalized')) &&
      !(d.valid_until && dayText(d.valid_until) < new Date().toISOString().slice(0, 10));
    out.quotes.push({ type: d.type, no: d.no, title: d.title || '', status: d.status, answer: d.client_answer || null, toAnswer: open, total: round2(d.grand_total), currency: d.currency,
      validUntil: dayText(d.valid_until), url: site + '/share/' + await shareOf(d.type, d.id) });
  }
  out.quotes.sort(function (x, y) { return (y.toAnswer ? 1 : 0) - (x.toAnswer ? 1 : 0); });

  var phones = a.kind === 'phone' ? [a.address] : [];
  out.bookings = (await pool.query(
    "SELECT service_name, starts_at, status, location, area, token FROM appointments WHERE (customer_id = ANY($1) OR ($2::text IS NOT NULL AND lower(email) = $2) OR ($3::text IS NOT NULL AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = right($3, 9))) " +
    "AND starts_at > now() - interval '120 days' ORDER BY (starts_at > now()) DESC, starts_at LIMIT 30",
    [ids, a.kind === 'email' ? a.address : null, phones[0] || null])).rows
    .map(function (b) { return { service: b.service_name, startsAt: b.starts_at, status: b.status, location: b.location, area: b.area || '', upcoming: new Date(b.starts_at) > new Date(), url: site + '/book/' + b.token }; });

  out.contracts = (await pool.query(
    "SELECT contract_no, title, status, sent_at, signed_at, token FROM contracts WHERE customer_id = ANY($1) AND status IN ('sent', 'signed', 'declined') ORDER BY (status = 'sent') DESC, sent_at DESC LIMIT 30", [ids])).rows
    .map(function (k) { return { contractNo: k.contract_no, title: k.title, status: k.status, sentAt: k.sent_at, signedAt: k.signed_at, url: site + '/c/' + k.token }; });

  // Quotes asked for on the shop, until their quotation is sent (then it is in quotes).
  out.requests = await require('./shopQuotes.service').ofCustomers(ids);

  out.waiting = {
    toPay: round2(out.invoices.filter(function (x) { return x.status !== 'paid'; }).reduce(function (n, x) { return n + x.balance; }, 0)),
    invoices: out.invoices.filter(function (x) { return x.status !== 'paid'; }).length,
    toApprove: out.quotes.filter(function (x) { return x.toAnswer; }).length,
    toSign: out.contracts.filter(function (x) { return x.status === 'sent'; }).length,
    upcoming: out.bookings.filter(function (x) { return x.upcoming && x.status !== 'cancelled'; }).length,
    orders: out.orders.filter(function (x) { return ['new', 'making', 'ready', 'out'].indexOf(x.status) >= 0; }).length
  };
  return out;
}

module.exports = { sendCode: sendCode, signup: signup, login: login, logout: logout, me: me, addressOf: addressOf, _askedBy: askedBy };
