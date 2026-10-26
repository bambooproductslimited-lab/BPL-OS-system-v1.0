var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// The screen that faces the customer (migration 0172; frontend
// pages/CustomerDisplay.jsx): a tablet or a second monitor beside the till
// that shows the order as it is rung up, the bill, a tip to tap and a
// thank-you with the receipt's link.
//
// It says hello on its own (no PIN, nothing to sign in): a long key it
// keeps, and a 6-digit code it shows. Someone at the till types the code
// (Pair a customer screen): the screen then belongs to that restaurant and
// to that till (its device id, kept on the till's browser) and shows what
// the till sends it (push) — a few times a second at most, the order as it
// stands. The customer's tip is kept on the screen for the till to read.
// Nothing about the customer is kept beyond the order in front of them.

var CODE_MINUTES = 30;
var NEW_PER_IP_HOUR = 20;
var MAX_STATE = 24000; // characters of JSON
var made = new Map(); // address -> [times]
var PHASES = ['idle', 'order', 'pay', 'paid'];

function hash(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function str(v, max) { return String(v == null ? '' : v).slice(0, max); }
function money(v) { var n = round2(v); return isFinite(n) ? n : 0; }
function deviceOf(v) { var d = String(v || ''); if (!/^[A-Za-z0-9_-]{8,64}$/.test(d)) fail('invalid', 'This till has no device id: reload it.'); return d; }

// What the till sends, kept to what a customer screen shows.
function cleanState(s) {
  s = s && typeof s === 'object' ? s : {};
  var out = { phase: PHASES.indexOf(s.phase) >= 0 ? s.phase : 'idle', ref: str(s.ref, 64), lang: str(s.lang, 8) };
  if (Array.isArray(s.lines)) {
    out.lines = s.lines.slice(0, 80).map(function (l) {
      l = l || {};
      return { name: str(l.name, 120), qty: Math.max(0, Math.min(999, Number(l.qty) || 0)), amount: money(l.amount), gross: l.gross != null ? money(l.gross) : null,
        mods: str(l.mods, 200), off: str(l.off, 60), seat: Number(l.seat) > 0 ? Math.round(Number(l.seat)) : null, comp: !!l.comp };
    });
  }
  if (s.totals && typeof s.totals === 'object') {
    var t = s.totals;
    out.totals = { items: money(t.items), discount: money(t.discount), service: money(t.service), serviceName: str(t.serviceName, 40), total: money(t.total),
      taxes: Array.isArray(t.taxes) ? t.taxes.slice(0, 8).map(function (x) { return { name: str(x && x.name, 40), rate: money(x && x.rate), amount: money(x && x.amount), included: !!(x && x.included) }; }) : [] };
  }
  if (s.tip && typeof s.tip === 'object') out.tip = { ask: !!s.tip.ask, base: money(s.tip.base), percents: Array.isArray(s.tip.percents) ? s.tip.percents.slice(0, 4).map(money) : [], amount: money(s.tip.amount) };
  if (s.paid && typeof s.paid === 'object') {
    out.paid = { total: money(s.paid.total), tip: money(s.paid.tip), change: money(s.paid.change), method: str(s.paid.method, 30), orderNo: str(s.paid.orderNo, 30),
      receiptUrl: /^https?:\/\//.test(String(s.paid.receiptUrl || '')) ? str(s.paid.receiptUrl, 300) : '', points: s.paid.points ? { earned: Math.round(Number(s.paid.points.earned) || 0), balance: Math.round(Number(s.paid.points.balance) || 0) } : null };
  }
  if (s.customer) out.customer = str(s.customer, 60);
  if (s.cashier) out.cashier = str(s.cashier, 40);
  return out;
}

async function byKey(key) {
  if (!/^[A-Za-z0-9_-]{24,80}$/.test(String(key || ''))) return null;
  return (await pool.query('SELECT d.*, c.code AS company_code, c.name AS company_name FROM restaurant_displays d LEFT JOIN companies c ON c.id = d.company_id WHERE d.key_hash = $1', [hash(key)])).rows[0] || null;
}

// What the screen shows: its code while it waits for a till, then the
// restaurant and the order the till sent last (an hour old at most).
async function viewOf(d) {
  if (!d.company_id) {
    var code = d.pair_code, expires = d.code_expires;
    if (!code || new Date(expires) < new Date()) {
      for (var i = 0; i < 5; i++) {
        code = newCode();
        try {
          await pool.query("UPDATE restaurant_displays SET pair_code = $2, code_expires = now() + ($3 || ' minutes')::interval WHERE id = $1", [d.id, code, String(CODE_MINUTES)]);
          break;
        } catch (e) { if (e.code !== '23505' || i === 4) throw e; }
      }
    }
    return { paired: false, code: code };
  }
  var settings = await access.settingsOf(d.company_id);
  var fresh = d.state_at && Date.now() - new Date(d.state_at).getTime() < 3600000;
  return {
    paired: true, name: d.name, restaurant: { code: d.company_code, name: d.company_name },
    state: fresh ? d.state : { phase: 'idle' }, tipChosen: d.tip || null,
    receipt: { footer: settings.receipt.footer || '' }, tips: settings.tips
  };
}

// POST /api/pos/display/hello { key } — a screen with its key (as it was),
// or a new one: its key (kept on the screen) and its code.
async function hello(key, ip, ua, kind) {
  // A screen facing the customer, a self-order kiosk, the ready-for-pickup
  // board, or a menu board (migration 0195).
  kind = ['kiosk', 'board', 'menu'].indexOf(kind) >= 0 ? kind : 'screen';
  var d = key ? await byKey(key) : null;
  if (d && d.kind !== kind) d = null;
  if (d) return Object.assign({ key: key }, kind !== 'screen' ? { kind: kind } : await viewOf(d));
  var now = Date.now(), who = String(ip || '');
  var list = (made.get(who) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= NEW_PER_IP_HOUR) fail('ratelimited', 'Too many new screens from here. Try again in an hour.');
  list.push(now); made.set(who, list);
  if (made.size > 5000) made.clear();
  var fresh = crypto.randomBytes(24).toString('base64url');
  var row = (await pool.query('INSERT INTO restaurant_displays (key_hash, ip, user_agent, kind) VALUES ($1, $2, $3, $4) RETURNING *', [hash(fresh), str(ip, 60), str(ua, 200), kind])).rows[0];
  return Object.assign({ key: fresh }, kind !== 'screen' ? { kind: kind } : await viewOf(row));
}

// GET /api/pos/display — the screen asking what to show (its key as the
// bearer token), every second or so.
async function view(key) {
  var d = await byKey(key);
  if (!d) fail('auth', 'This screen was taken off the till. It shows a new code.');
  if (!d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > 15000) await pool.query('UPDATE restaurant_displays SET last_seen_at = now() WHERE id = $1', [d.id]);
  return viewOf(d);
}

// POST /api/pos/display/tip { ref, percent | amount | none } — the
// customer's tip, while the till is taking the payment for that order.
async function chooseTip(key, p) {
  var d = await byKey(key);
  if (!d || !d.company_id) fail('auth', 'This screen is not on a till.');
  p = p || {};
  var st = d.state || {};
  if (st.phase !== 'pay' || !st.tip || !st.tip.ask || String(p.ref || '') !== st.ref) fail('conflict', 'The bill has changed. Look again.');
  var settings = await access.settingsOf(d.company_id);
  if (!settings.tips.on) fail('conflict', 'Tips are not taken here.');
  var base = money(st.tip.base);
  var amount = 0, percent = null;
  if (p.none) amount = 0;
  else if (p.percent !== undefined && p.percent !== null) {
    percent = money(p.percent);
    if (settings.tips.percents.indexOf(percent) < 0) fail('invalid', 'Pick one of the tips shown.');
    amount = round2(base * percent / 100);
  } else {
    amount = round2(p.amount);
    if (!(amount >= 0 && amount <= Math.max(base, 50))) fail('invalid', 'That tip is more than the bill.');
  }
  var tip = { ref: st.ref, amount: amount, percent: percent, none: !amount, at: new Date().toISOString() };
  await pool.query('UPDATE restaurant_displays SET tip = $2 WHERE id = $1', [d.id, JSON.stringify(tip)]);
  return Object.assign(await viewOf(Object.assign({}, d, { tip: tip })), { tipChosen: tip });
}

function displayOut(d) {
  return { id: d.id, name: d.name || 'Customer screen', pairedAt: d.paired_at, online: !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < 45000, lastSeenAt: d.last_seen_at };
}

// POST /api/pos/displays/pair { code, device, name } — the screen showing
// that code now shows this till.
async function pair(token, p) {
  var session = await access.need(token, 'till');
  p = p || {};
  var device = deviceOf(p.device);
  var code = String(p.code || '').replace(/\D/g, '');
  if (code.length !== 6) fail('invalid', 'Type the 6 numbers the customer screen shows.');
  var d = (await pool.query("SELECT * FROM restaurant_displays WHERE pair_code = $1 AND company_id IS NULL AND code_expires > now() AND kind = 'screen'", [code])).rows[0];
  if (!d) fail('notfound', 'No customer screen shows that code. Check the numbers, or reload the screen for a new code.');
  var name = str(String(p.name || '').trim(), 40) || 'Customer screen';
  await pool.query('UPDATE restaurant_displays SET company_id = $2, till_device = $3, name = $4, paired_by = $5, paired_at = now(), pair_code = NULL, code_expires = NULL, state = $6, state_at = now(), tip = NULL WHERE id = $1',
    [d.id, session.posCompanyId, device, name, session.posEmployeeId, JSON.stringify({ phase: 'idle' })]);
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.display_paired',
    summary: 'A customer screen (' + name + ') now shows this till.', refType: 'display', refId: d.id });
  return mine(token, device);
}

// GET /api/pos/displays?device= — the customer screens on this till.
async function mine(token, device) {
  var session = await access.need(token, 'till');
  device = deviceOf(device);
  var rows = (await pool.query('SELECT * FROM restaurant_displays WHERE company_id = $1 AND till_device = $2 ORDER BY paired_at', [session.posCompanyId, device])).rows;
  return { displays: rows.map(displayOut) };
}

// POST /api/pos/displays/:id/unpair — a screen off this till (it shows a new code).
async function unpair(token, id) {
  var session = await access.need(token, 'till');
  var d = (await pool.query('DELETE FROM restaurant_displays WHERE id = $1 AND company_id = $2 RETURNING name', [id, session.posCompanyId])).rows[0];
  if (!d) fail('notfound', 'That customer screen is not on this till.');
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.display_unpaired',
    summary: 'A customer screen (' + d.name + ') was taken off the till.', refType: 'display', refId: id });
  return { ok: true };
}

// POST /api/pos/displays/push { device, state } — the order as it stands,
// to this till's customer screens. A new order (or no longer paying)
// forgets the tip chosen. Answers with the tip the customer chose for this
// order, if any.
async function push(token, p) {
  var session = await access.need(token, 'till');
  p = p || {};
  var device = deviceOf(p.device);
  var state = cleanState(p.state);
  var json = JSON.stringify(state);
  if (json.length > MAX_STATE) fail('invalid', 'That order is too long for the customer screen.');
  var rows = (await pool.query(
    "UPDATE restaurant_displays SET state = $3, state_at = now(), tip = CASE WHEN $4 = 'pay' AND tip->>'ref' = $5 THEN tip ELSE NULL END " +
    'WHERE company_id = $1 AND till_device = $2 RETURNING tip', [session.posCompanyId, device, json, state.phase, state.ref])).rows;
  var tip = rows.map(function (r) { return r.tip; }).filter(Boolean)[0] || null;
  return { screens: rows.length, tip: tip };
}

// GET /api/pos/displays/tip?device=&ref= — the tip the customer chose on
// this till's screen for this order, while the till takes the payment.
async function tipFor(token, device, ref) {
  var session = await access.need(token, 'till');
  device = deviceOf(device);
  var rows = (await pool.query("SELECT tip FROM restaurant_displays WHERE company_id = $1 AND till_device = $2 AND tip->>'ref' = $3", [session.posCompanyId, device, String(ref || '')])).rows;
  return { tip: (rows[0] && rows[0].tip) || null };
}

module.exports = { byKey: byKey, viewOf: viewOf, newCode: newCode, hash: hash, CODE_MINUTES: CODE_MINUTES, hello: hello, view: view, chooseTip: chooseTip, pair: pair, mine: mine, unpair: unpair, push: push, tipFor: tipFor, _made: made, cleanState: cleanState };
