var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { internationalNumber } = require('../utils/phone');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// Gift cards (migration 0173; the till's settings, giftCards). Sold at the
// till for cash or Mobile Money — money into the drawer, not a sale (the
// food is sold when the card is spent) — with a 16-digit code printed on it
// and a link to its own page (online/GiftCard.jsx) to send by WhatsApp or
// text. Spent as a way of paying (gift_card, restaurantTillMoney
// planPayments) until its balance — the sum of its entries — is used up. A
// refund of a sale it paid can go back on it. A manager voids a card sold
// by mistake: what is left on it is given back in cash from the drawer.

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function cleanText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function digitsOf(code) { return String(code || '').replace(/\D/g, ''); }
function codeWords(c) { return String(c).replace(/(\d{4})(?=\d)/g, '$1 '); }
function online() { return require('./restaurantOnline.service'); }
var MONEY = ['cash', 'mobile_money'];
var METHOD_NAME = { cash: 'cash', mobile_money: 'Mobile Money' };

async function balanceOf(db, cardId) {
  return round2((await db.query('SELECT coalesce(sum(amount), 0) AS b FROM restaurant_gift_card_entries WHERE card_id = $1', [cardId])).rows[0].b);
}
function linkOf(companyCode, token) { return online().siteUrlFor(companyCode) + '/g/' + token; }

async function cardOut(db, c, withEntries) {
  var out = {
    id: c.id, code: c.code, codeWords: codeWords(c.code), amount: round2(c.amount), balance: await balanceOf(db, c.id), status: c.status,
    toName: c.to_name || '', toPhone: c.to_phone || '', fromName: c.from_name || '', message: c.message || '',
    soldBy: c.sold_first ? c.sold_first + ' ' + c.sold_last : null, soldMethod: c.sold_method, createdAt: c.created_at,
    voidedAt: c.voided_at || null, voidReason: c.void_reason || '', link: linkOf(c.company_code, c.token)
  };
  if (withEntries) {
    out.entries = (await db.query(
      'SELECT x.*, o.order_no, e.first_name, e.last_name FROM restaurant_gift_card_entries x LEFT JOIN restaurant_orders o ON o.id = x.order_id LEFT JOIN employees e ON e.id = x.cashier_id ' +
      'WHERE x.card_id = $1 ORDER BY x.created_at DESC LIMIT 30', [c.id])).rows.map(function (x) {
      return { id: x.id, kind: x.kind, amount: round2(x.amount), method: x.method || null, orderNo: x.order_no || null, by: x.first_name ? x.first_name + ' ' + x.last_name : null, note: x.note || '', createdAt: x.created_at };
    });
  }
  return out;
}
var CARD_SELECT = 'SELECT g.*, c.code AS company_code, e.first_name AS sold_first, e.last_name AS sold_last FROM restaurant_gift_cards g JOIN companies c ON c.id = g.company_id LEFT JOIN employees e ON e.id = g.sold_by ';

async function newCode(client) {
  for (var i = 0; i < 8; i++) {
    var c = String(crypto.randomInt(1, 10)) + Array.from({ length: 15 }, function () { return crypto.randomInt(0, 10); }).join('');
    if (!(await client.query('SELECT 1 FROM restaurant_gift_cards WHERE code = $1', [c])).rows[0]) return c;
  }
  fail('conflict', 'Could not make a card number. Try again.');
}

// POST /api/pos/gift-cards { amount, method, toName, toPhone, fromName,
// message } — a card sold, paid in cash or Mobile Money into the drawer.
async function sell(token, p) {
  var session = await access.need(token, 'giftCards');
  if (!session.access.settings.giftCards.on) fail('conflict', 'Gift cards are turned off in the till settings.');
  p = p || {};
  var amount = round2(p.amount);
  if (!(amount >= 1 && amount <= 100000)) fail('invalid', 'A gift card is from 1 to 100,000 cedis.');
  var method = MONEY.indexOf(p.method) >= 0 ? p.method : fail('invalid', 'Paid in cash or Mobile Money?');
  var toPhone = cleanText(p.toPhone, 30);
  if (toPhone && !internationalNumber(toPhone)) fail('invalid', 'That phone number does not look right.');
  return withTransaction(async function (client) {
    var drawer = (await client.query("SELECT id FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId])).rows[0];
    if (!drawer) fail('conflict', 'Only the cashier on duty takes money: open your cash drawer first.');
    var code = await newCode(client);
    var c = (await client.query(
      'INSERT INTO restaurant_gift_cards (company_id, code, token, amount, to_name, to_phone, from_name, message, sold_by, sold_method) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [session.posCompanyId, code, crypto.randomBytes(18).toString('base64url'), amount, cleanText(p.toName, 60), toPhone, cleanText(p.fromName, 60), cleanText(p.message, 200), session.posEmployeeId, method])).rows[0];
    await client.query("INSERT INTO restaurant_gift_card_entries (card_id, company_id, kind, amount, method, cashier_id) VALUES ($1,$2,'sold',$3,$4,$5)", [c.id, session.posCompanyId, amount, method, session.posEmployeeId]);
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.gift_card',
      summary: 'Sold a gift card of ' + amount.toFixed(2) + ' (' + METHOD_NAME[method] + ')' + (c.to_name ? ' for ' + c.to_name : '') + ', card ending ' + code.slice(-4) + '.', amount: amount, refType: 'gift_card', refId: c.id });
    return cardOut(client, (await client.query(CARD_SELECT + 'WHERE g.id = $1', [c.id])).rows[0], true);
  });
}

// GET /api/pos/gift-cards/:code — a card by the code on it (its balance and what was spent).
async function lookup(token, code) {
  var session = await access.need(token, 'till');
  var d = digitsOf(code);
  if (d.length !== 16) fail('invalid', 'A gift card number has 16 digits.');
  var c = (await pool.query(CARD_SELECT + 'WHERE g.code = $1 AND g.company_id = $2', [d, session.posCompanyId])).rows[0];
  if (!c) fail('notfound', 'No gift card here has that number.');
  return cardOut(pool, c, true);
}

// POST /api/pos/gift-cards/:id/send { channel: sms | whatsapp, phone } —
// the card's link to whoever it is for.
async function send(token, id, p) {
  var session = await access.need(token, 'till');
  p = p || {};
  var c = (await pool.query(CARD_SELECT + 'WHERE g.id = $1 AND g.company_id = $2', [id, session.posCompanyId])).rows[0];
  if (!c) fail('notfound', 'That gift card is not here.');
  var digits = internationalNumber(p.phone || c.to_phone);
  if (!digits) fail('invalid', 'Type the phone number to send it to, e.g. 024 412 3456.');
  var co = (await pool.query('SELECT name FROM companies WHERE id = $1', [c.company_id])).rows[0];
  var words = (c.from_name ? c.from_name + ' sent you' : 'You have') + ' a ' + co.name + ' gift card of GHS ' + round2(c.amount).toFixed(2) + (c.message ? ': "' + c.message + '"' : '.') + ' ' + linkOf(c.company_code, c.token);
  if (p.channel === 'sms') {
    await require('./sms.service').send({ to: '+' + digits, message: words, purpose: 'gift_card', refId: c.id });
    return { sent: true, channel: 'sms' };
  }
  return { channel: 'whatsapp', url: 'https://wa.me/' + digits + '?text=' + encodeURIComponent(words) };
}

// POST /api/pos/gift-cards/:id/void { managerPin, reason } — a card sold by
// mistake: what is left on it given back in cash, with a manager's PIN.
async function voidCard(token, id, p, ip) {
  var session = await access.need(token, 'giftCards');
  p = p || {};
  var reason = cleanText(p.reason, 200);
  if (reason.length < 3) fail('invalid', 'Say why the card is cancelled.');
  var manager = await access.refundApprover(session.posCompanyId, p.managerPin, ip);
  return withTransaction(async function (client) {
    var c = (await client.query('SELECT * FROM restaurant_gift_cards WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, session.posCompanyId])).rows[0];
    if (!c) fail('notfound', 'That gift card is not here.');
    if (c.status === 'void') fail('conflict', 'That gift card was cancelled already.');
    var drawer = (await client.query("SELECT id FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId])).rows[0];
    if (!drawer) fail('conflict', 'Only the cashier on duty gives back money: open your cash drawer first.');
    var left = await balanceOf(client, c.id);
    if (left > 0) await client.query("INSERT INTO restaurant_gift_card_entries (card_id, company_id, kind, amount, method, cashier_id, note) VALUES ($1,$2,'void',$3,'cash',$4,$5)", [c.id, c.company_id, -left, session.posEmployeeId, reason]);
    await client.query("UPDATE restaurant_gift_cards SET status = 'void', voided_by = $2, voided_at = now(), void_reason = $3 WHERE id = $1", [c.id, manager.id, reason]);
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.gift_card_void',
      summary: 'Cancelled the gift card ending ' + c.code.slice(-4) + (left > 0 ? ': ' + left.toFixed(2) + ' given back in cash' : '') + ', approved by ' + manager.first_name + ' ' + manager.last_name + '. ' + reason, amount: left, refType: 'gift_card', refId: c.id });
    return cardOut(client, (await client.query(CARD_SELECT + 'WHERE g.id = $1', [c.id])).rows[0], true);
  });
}

// Called by restaurantPos.chargeOrder in its transaction: each part paid by
// gift card taken off its card (which must cover it). rows: the sale's
// payments (planPayments, each gift part with its giftCode); each gets its
// card's id (giftCardId) for restaurant_order_payments.
async function redeemForSale(client, companyId, order, cashierId, rows) {
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.method !== 'gift_card') continue;
    var c = (await client.query('SELECT * FROM restaurant_gift_cards WHERE code = $1 AND company_id = $2 FOR UPDATE', [r.giftCode, companyId])).rows[0];
    if (!c) fail('notfound', 'No gift card here has the number ' + codeWords(r.giftCode) + '.');
    if (c.status !== 'active') fail('conflict', 'The gift card ending ' + c.code.slice(-4) + ' was cancelled.');
    var left = await balanceOf(client, c.id);
    if (left + 0.004 < r.amount) fail('invalid', 'The gift card ending ' + c.code.slice(-4) + ' has ' + left.toFixed(2) + ' left: pay the rest another way.');
    await client.query("INSERT INTO restaurant_gift_card_entries (card_id, company_id, kind, amount, order_id, cashier_id) VALUES ($1,$2,'redeem',$3,$4,$5)", [c.id, companyId, -r.amount, order.id, cashierId]);
    r.giftCardId = c.id;
    r.giftLeft = round2(left - r.amount);
  }
}

// A refund back on the card that paid the sale (no more than it paid).
async function refundToCard(client, o, amount, cashierId) {
  var spent = (await client.query("SELECT card_id, -sum(amount) AS paid FROM restaurant_gift_card_entries WHERE order_id = $1 AND kind IN ('redeem', 'refund') GROUP BY card_id HAVING -sum(amount) > 0 ORDER BY 2 DESC", [o.id])).rows;
  if (!spent.length) fail('invalid', 'No gift card paid this sale.');
  var back = round2(Math.min(amount, Number(spent[0].paid)));
  if (back + 0.004 < amount) fail('invalid', 'The gift card paid ' + Number(spent[0].paid).toFixed(2) + ' of this sale: refund the rest in cash.');
  await client.query("INSERT INTO restaurant_gift_card_entries (card_id, company_id, kind, amount, order_id, cashier_id, note) VALUES ($1,$2,'refund',$3,$4,$5,'Refund')", [spent[0].card_id, o.company_id, back, o.id, cashierId]);
}
// A voided sale's gift card parts go back on their cards.
async function onVoid(client, o) {
  var spent = (await client.query("SELECT card_id, -sum(amount) AS paid FROM restaurant_gift_card_entries WHERE order_id = $1 AND kind IN ('redeem', 'refund') GROUP BY card_id HAVING -sum(amount) > 0", [o.id])).rows;
  for (var i = 0; i < spent.length; i++) {
    await client.query("INSERT INTO restaurant_gift_card_entries (card_id, company_id, kind, amount, order_id, note) VALUES ($1,$2,'refund',$3,$4,'Sale voided')", [spent[i].card_id, o.company_id, round2(spent[i].paid), o.id]);
  }
}

// Gift card money this cashier took in (cards sold for cash) and gave back
// (cards cancelled), for their drawer.
async function drawerCash(db, cashierId, companyId, from, to) {
  var r = (await db.query(
    "SELECT coalesce(sum(amount) FILTER (WHERE kind = 'sold' AND method = 'cash'), 0) AS sold, coalesce(-sum(amount) FILTER (WHERE kind = 'void' AND method = 'cash'), 0) AS voided " +
    'FROM restaurant_gift_card_entries WHERE cashier_id = $1 AND company_id = $2 AND created_at >= $3 AND created_at <= $4', [cashierId, companyId, from, to])).rows[0];
  return { sold: round2(r.sold), voided: round2(r.voided) };
}
async function drawerMoves(db, cashierId, companyId, from, to) {
  var rows = (await db.query(
    "SELECT x.id, CASE WHEN x.kind = 'sold' THEN 'in' ELSE 'out' END AS direction, abs(x.amount) AS amount, g.to_name, g.code, x.note, x.created_at FROM restaurant_gift_card_entries x " +
    "JOIN restaurant_gift_cards g ON g.id = x.card_id WHERE x.cashier_id = $1 AND x.company_id = $2 AND x.method = 'cash' AND x.kind IN ('sold', 'void') AND x.created_at >= $3 AND x.created_at <= $4", [cashierId, companyId, from, to])).rows;
  return rows.map(function (r) { return { id: r.id, direction: r.direction, account: 'gift', amount: round2(r.amount), customer: r.to_name || null, note: r.note || '', ref: '•••• ' + r.code.slice(-4), createdAt: r.created_at }; });
}

// POST /api/pos/settings/gift-cards — for a manager: cards sold, spent and
// still to spend (what the restaurant owes in food), and the cards.
async function report(companyId, q) {
  q = q || {};
  var args = [companyId];
  var where = '';
  if (q.q && String(q.q).trim()) {
    var d = digitsOf(q.q);
    args.push('%' + String(q.q).trim() + '%');
    where = ' AND (g.to_name ILIKE $2 OR g.from_name ILIKE $2' + (d.length >= 4 ? " OR g.code LIKE '%' || $3" : '') + ')';
    if (d.length >= 4) args.push(d);
  }
  var cards = (await pool.query(CARD_SELECT + 'WHERE g.company_id = $1' + where + ' ORDER BY g.created_at DESC LIMIT 100', args)).rows;
  var sums = (await pool.query(
    "SELECT coalesce(sum(x.amount) FILTER (WHERE x.kind = 'sold'), 0) AS sold, coalesce(-sum(x.amount) FILTER (WHERE x.kind = 'redeem'), 0) AS spent, " +
    "coalesce(sum(x.amount) FILTER (WHERE x.kind = 'refund'), 0) AS refunded, coalesce(-sum(x.amount) FILTER (WHERE x.kind = 'void'), 0) AS voided, coalesce(sum(x.amount), 0) AS outstanding, " +
    "coalesce(sum(x.amount) FILTER (WHERE x.kind = 'sold' AND x.created_at >= date_trunc('month', now())), 0) AS sold_month, count(DISTINCT x.card_id) FILTER (WHERE x.kind = 'sold') AS cards " +
    'FROM restaurant_gift_card_entries x WHERE x.company_id = $1', [companyId])).rows[0];
  var out = [];
  for (var i = 0; i < cards.length; i++) out.push(await cardOut(pool, cards[i], false));
  return {
    totals: { cards: Number(sums.cards), sold: round2(sums.sold), spent: round2(round2(sums.spent) - round2(sums.refunded)), voided: round2(sums.voided), outstanding: round2(sums.outstanding), soldMonth: round2(sums.sold_month) },
    cards: out
  };
}

// GET /api/pos/online/gift/:token — the card's own page: whoever has the
// link has the card.
async function publicCard(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) fail('notfound', 'This gift card link is not right.');
  var c = (await pool.query('SELECT g.*, co.code AS company_code, co.name AS company_name FROM restaurant_gift_cards g JOIN companies co ON co.id = g.company_id WHERE g.token = $1', [token])).rows[0];
  if (!c) fail('notfound', 'This gift card link is not right, or the card is no longer there.');
  return {
    restaurant: { code: c.company_code, name: c.company_name, website: require('./restaurantDelivery.service').shopUrl(c.company_code) },
    code: c.code, codeWords: codeWords(c.code), amount: round2(c.amount), balance: await balanceOf(pool, c.id), status: c.status,
    toName: c.to_name || '', fromName: c.from_name || '', message: c.message || '', createdAt: c.created_at
  };
}

module.exports = {
  digitsOf: digitsOf, codeWords: codeWords, balanceOf: balanceOf, sell: sell, lookup: lookup, send: send, voidCard: voidCard,
  redeemForSale: redeemForSale, refundToCard: refundToCard, onVoid: onVoid, drawerCash: drawerCash, drawerMoves: drawerMoves, report: report, publicCard: publicCard
};
