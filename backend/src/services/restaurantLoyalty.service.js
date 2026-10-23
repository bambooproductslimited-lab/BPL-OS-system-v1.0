var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// Loyalty points (migration 0173; the till's settings, loyalty). A customer
// picked on a sale — or whose phone the sale has (a pickup, a delivery, a
// website order paid at the till) — earns a point for every `spend` cedis
// paid (not the tip). Points are spent on the restaurant's rewards: an
// amount or a percentage off the bill, given on the till as a bill discount
// (restaurantTillCheck, the preset 'loyalty:<reward>'), taken from the
// points when the sale is paid. A refund takes back the points it earned.
// The balance is the sum of the customer's entries, never stored.

function round2(n) { return Math.round(Number(n) * 100) / 100; }
var PREFIX = 'loyalty:';

// The same forms as the database's restaurant_phone_key (restaurantCrm phoneKey).
function phoneKey(p) {
  var d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.indexOf('00') === 0) return d.slice(2);
  if (d.length === 10 && d[0] === '0') return '233' + d.slice(1);
  if (d.length === 9) return '233' + d;
  return d;
}

async function balanceOf(db, guestId) {
  return Number((await db.query('SELECT coalesce(sum(points), 0)::int AS b FROM restaurant_loyalty_entries WHERE guest_id = $1', [guestId])).rows[0].b);
}
async function lockGuest(client, guestId) { await client.query("SELECT pg_advisory_xact_lock(hashtext('loyalty:' || $1))", [guestId]); }

// The customer a sale's points go to: the one picked, else the one with
// the sale's phone at this restaurant.
async function guestFor(db, companyId, guestId, phone) {
  if (guestId) return (await db.query('SELECT id, name FROM restaurant_guests WHERE id = $1 AND company_id = $2', [guestId, companyId])).rows[0] || null;
  var key = phoneKey(phone);
  if (!key) return null;
  return (await db.query('SELECT id, name FROM restaurant_guests WHERE company_id = $1 AND phone_key = $2 ORDER BY created_at LIMIT 1', [companyId, key])).rows[0] || null;
}

// Called by restaurantPos.chargeOrder in its transaction, once the sale is
// saved: the reward used (its points taken; it needs the customer and
// their points), and the points earned. Returns { guestId, earned, used,
// balance, reward } or null.
async function forSale(client, session, order, o) {
  var settings = session.access.settings.loyalty;
  var d = o.adjust && o.adjust.discount;
  var rewardId = d && d.presetId && String(d.presetId).indexOf(PREFIX) === 0 ? String(d.presetId).slice(PREFIX.length) : null;
  var reward = rewardId ? (settings.rewards || []).find(function (r) { return r.id === rewardId; }) : null;
  if (rewardId && (!settings.on || !reward)) fail('invalid', 'That reward is no longer offered. Take it off the bill.');
  if (!settings.on && !reward) return null;
  var g = await guestFor(client, session.posCompanyId, o.guestId, o.phone);
  if (reward && !g) fail('invalid', reward.name + ' is paid with a customer\'s points: pick the customer first.');
  if (!g) return null;
  await lockGuest(client, g.id);
  var balance = await balanceOf(client, g.id);
  var used = 0;
  if (reward) {
    if (balance < reward.points) fail('invalid', g.name + ' has ' + balance + ' points; ' + reward.name + ' takes ' + reward.points + '.');
    used = reward.points;
    await client.query("INSERT INTO restaurant_loyalty_entries (company_id, guest_id, kind, points, order_id, reward, employee_id) VALUES ($1,$2,'redeem',$3,$4,$5,$6)",
      [session.posCompanyId, g.id, -used, order.id, reward.name, session.posEmployeeId]);
  }
  var earned = settings.on ? Math.floor(round2(o.total) / settings.spend + 1e-9) : 0;
  if (earned > 0) {
    await client.query("INSERT INTO restaurant_loyalty_entries (company_id, guest_id, kind, points, order_id, employee_id) VALUES ($1,$2,'earn',$3,$4,$5)",
      [session.posCompanyId, g.id, earned, order.id, session.posEmployeeId]);
  }
  if (!earned && !used) return { guestId: g.id, name: g.name, earned: 0, used: 0, balance: balance };
  await client.query('UPDATE restaurant_orders SET points_earned = $2, points_used = $3, guest_id = coalesce(guest_id, $4) WHERE id = $1', [order.id, earned, used, g.id]);
  return { guestId: g.id, name: g.name, earned: earned, used: used, balance: balance - used + earned, reward: reward ? reward.name : null };
}

// A refund takes back the points that part of the sale earned (in its
// transaction, restaurantTillMoney.refundSale). A sale voided takes them
// all back and gives back the reward's points.
async function onRefund(client, o, amount) {
  if (!(Number(o.points_earned) > 0) || !o.guest_id) return 0;
  var takenBack = -Number((await client.query("SELECT coalesce(sum(points), 0)::int AS p FROM restaurant_loyalty_entries WHERE order_id = $1 AND kind = 'refund'", [o.id])).rows[0].p);
  var share = Number(o.total) > 0 ? Math.round(Number(o.points_earned) * Math.min(1, round2(amount) / Number(o.total))) : 0;
  var back = Math.min(share, Number(o.points_earned) - takenBack);
  if (!(back > 0)) return 0;
  await lockGuest(client, o.guest_id);
  await client.query("INSERT INTO restaurant_loyalty_entries (company_id, guest_id, kind, points, order_id, note) VALUES ($1,$2,'refund',$3,$4,'Refund')", [o.company_id, o.guest_id, -back, o.id]);
  return back;
}
async function onVoid(client, o) {
  if (!o.guest_id || (!(Number(o.points_earned) > 0) && !(Number(o.points_used) > 0))) return;
  var net = Number((await client.query('SELECT coalesce(sum(points), 0)::int AS p FROM restaurant_loyalty_entries WHERE order_id = $1', [o.id])).rows[0].p);
  if (!net) return;
  await lockGuest(client, o.guest_id);
  await client.query("INSERT INTO restaurant_loyalty_entries (company_id, guest_id, kind, points, order_id, note) VALUES ($1,$2,'adjust',$3,$4,'Sale voided')", [o.company_id, o.guest_id, -net, o.id]);
}

function entryOut(r) {
  return { id: r.id, kind: r.kind, points: r.points, reward: r.reward || null, orderNo: r.order_no || null, note: r.note || '', by: r.by_first ? r.by_first + ' ' + r.by_last : null, createdAt: r.created_at };
}

// GET /api/pos/loyalty/:guestId — a customer's points, what they can
// spend them on now, and their last entries (on the till).
async function ofGuest(token, guestId) {
  var session = await access.need(token, 'till');
  var g = (await pool.query('SELECT id, name, phone FROM restaurant_guests WHERE id = $1 AND company_id = $2', [guestId, session.posCompanyId])).rows[0];
  if (!g) fail('notfound', 'That customer is no longer available.');
  var settings = session.access.settings.loyalty;
  var balance = await balanceOf(pool, g.id);
  var entries = (await pool.query(
    'SELECT l.*, o.order_no, e.first_name AS by_first, e.last_name AS by_last FROM restaurant_loyalty_entries l LEFT JOIN restaurant_orders o ON o.id = l.order_id ' +
    'LEFT JOIN employees e ON e.id = l.employee_id WHERE l.guest_id = $1 ORDER BY l.created_at DESC LIMIT 20', [g.id])).rows;
  return {
    on: settings.on, guest: { id: g.id, name: g.name, phone: g.phone }, balance: balance, spend: settings.spend,
    rewards: (settings.rewards || []).map(function (r) { return Object.assign({}, r, { presetId: PREFIX + r.id, can: balance >= r.points }); }),
    entries: entries.map(entryOut)
  };
}

// Points for the customers the till shows (their tiles): { guestId: points }.
async function balancesOf(db, companyId, guestIds) {
  if (!guestIds.length) return {};
  var rows = (await db.query('SELECT guest_id, coalesce(sum(points), 0)::int AS b FROM restaurant_loyalty_entries WHERE company_id = $1 AND guest_id = ANY($2::uuid[]) GROUP BY guest_id', [companyId, guestIds])).rows;
  var out = {};
  rows.forEach(function (r) { out[r.guest_id] = r.b; });
  return out;
}

// POST /api/pos/settings/loyalty — for a manager: the members (most points
// first), points given and spent this month and in all, and the rewards
// most used.
async function report(companyId, q) {
  q = q || {};
  var args = [companyId];
  var where = '';
  if (q.q && String(q.q).trim()) { args.push('%' + String(q.q).trim() + '%'); where = ' AND (g.name ILIKE $2 OR g.phone ILIKE $2)'; }
  var members = (await pool.query(
    'SELECT g.id, g.name, g.phone, sum(l.points)::int AS balance, sum(l.points) FILTER (WHERE l.kind = \'earn\')::int AS earned, ' +
    "coalesce(-sum(l.points) FILTER (WHERE l.kind = 'redeem'), 0)::int AS spent, max(l.created_at) AS last_at, count(DISTINCT l.order_id)::int AS visits " +
    'FROM restaurant_loyalty_entries l JOIN restaurant_guests g ON g.id = l.guest_id WHERE l.company_id = $1' + where +
    ' GROUP BY g.id ORDER BY sum(l.points) DESC, max(l.created_at) DESC LIMIT 100', args)).rows;
  var sums = (await pool.query(
    "SELECT coalesce(sum(points) FILTER (WHERE kind = 'earn'), 0)::int AS given, coalesce(-sum(points) FILTER (WHERE kind = 'redeem'), 0)::int AS spent, " +
    "coalesce(sum(points) FILTER (WHERE kind = 'earn' AND created_at >= date_trunc('month', now())), 0)::int AS given_month, " +
    "coalesce(-sum(points) FILTER (WHERE kind = 'redeem' AND created_at >= date_trunc('month', now())), 0)::int AS spent_month, " +
    'coalesce(sum(points), 0)::int AS outstanding, count(DISTINCT guest_id)::int AS members FROM restaurant_loyalty_entries WHERE company_id = $1', [companyId])).rows[0];
  var rewards = (await pool.query("SELECT reward, count(*)::int AS n, -sum(points)::int AS points FROM restaurant_loyalty_entries WHERE company_id = $1 AND kind = 'redeem' GROUP BY reward ORDER BY count(*) DESC LIMIT 12", [companyId])).rows;
  return {
    members: members.map(function (m) { return { id: m.id, name: m.name, phone: m.phone, balance: m.balance, earned: m.earned || 0, spent: m.spent, visits: m.visits, lastAt: m.last_at }; }),
    totals: { members: sums.members, given: sums.given, spent: sums.spent, givenMonth: sums.given_month, spentMonth: sums.spent_month, outstanding: sums.outstanding },
    rewards: rewards.map(function (r) { return { name: r.reward, times: r.n, points: r.points }; })
  };
}

// A website customer's points at each restaurant (their account's phone).
async function forPhone(phone) {
  var key = phoneKey(phone);
  if (!key) return [];
  var rows = (await pool.query(
    'SELECT c.id AS company_id, c.code, c.name, coalesce(sum(l.points), 0)::int AS balance FROM restaurant_guests g JOIN companies c ON c.id = g.company_id ' +
    'JOIN restaurant_loyalty_entries l ON l.guest_id = g.id WHERE g.phone_key = $1 GROUP BY c.id ORDER BY c.name', [key])).rows;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var s = (await access.settingsOf(rows[i].company_id)).loyalty;
    if (!s.on) continue;
    out.push({ restaurant: { code: rows[i].code, name: rows[i].name }, points: rows[i].balance, spend: s.spend,
      next: (s.rewards || []).slice().sort(function (a, b) { return a.points - b.points; }).map(function (r) { return { name: r.name, points: r.points }; }) });
  }
  return out;
}

// POST /api/pos/loyalty/:guestId/adjust { points, note } — a manager's
// correction (PIN checked by the caller, restaurantTillAccess).
async function adjust(companyId, managerId, guestId, p) {
  p = p || {};
  var points = Math.round(Number(p.points));
  if (!points || Math.abs(points) > 1000000) fail('invalid', 'How many points to add (or take off, with a minus)?');
  var note = String(p.note || '').trim().slice(0, 200);
  if (note.length < 3) fail('invalid', 'Say why the points change.');
  var g = (await pool.query('SELECT id, name FROM restaurant_guests WHERE id = $1 AND company_id = $2', [guestId, companyId])).rows[0];
  if (!g) fail('notfound', 'That customer is no longer available.');
  var balance = await balanceOf(pool, g.id);
  if (balance + points < 0) fail('invalid', g.name + ' has ' + balance + ' points: no more can be taken off.');
  await pool.query("INSERT INTO restaurant_loyalty_entries (company_id, guest_id, kind, points, employee_id, note) VALUES ($1,$2,'adjust',$3,$4,$5)", [companyId, g.id, points, managerId, note]);
  await activity.log(pool, { companyId: companyId, employeeId: managerId, app: 'settings', action: 'settings.loyalty_adjust',
    summary: (points > 0 ? 'Gave ' + points : 'Took ' + (-points)) + ' loyalty points ' + (points > 0 ? 'to ' : 'from ') + g.name + ': ' + note, refType: 'guest', refId: g.id });
  return { guestId: g.id, balance: balance + points };
}

module.exports = { PREFIX: PREFIX, phoneKey: phoneKey, balanceOf: balanceOf, balancesOf: balancesOf, guestFor: guestFor, forSale: forSale, onRefund: onRefund, onVoid: onVoid, ofGuest: ofGuest, report: report, forPhone: forPhone, adjust: adjust };
