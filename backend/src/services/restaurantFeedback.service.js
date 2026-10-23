var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { internationalNumber } = require('../utils/phone');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');
var insights = require('./restaurantTillInsights.service');

// Guests' feedback from their receipt (migration 0180; Square's customer
// feedback). The receipt page (the till's receipt link, sent by WhatsApp,
// text or the printed QR code) asks how it was: a face from 1 to 5, what
// was good or not, the dishes they liked or not, a comment, and whether
// the restaurant may get in touch. An unhappy one (1 or 2) waits for a
// manager to follow it up privately — a WhatsApp message to the guest, if
// they said yes — before it becomes a bad review; a happy one (4 or 5) is
// shown the restaurant's review page (till settings feedback.reviewUrl).
// One per sale, changeable for 14 days.

var TAGS = ['food', 'service', 'speed', 'value', 'ambience', 'cleanliness'];
var OPEN_DAYS = 14;
var PER_IP_HOUR = 30;
var fromIp = new Map();
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function clean(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (fromIp.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Thank you — that is plenty for now.');
  list.push(now);
  fromIp.set(key, list);
  if (fromIp.size > 5000) fromIp.clear();
}

async function saleOf(tok) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(tok || ''))) fail('notfound', 'This receipt link is not right.');
  var o = (await pool.query(
    'SELECT o.id, o.company_id, o.order_no, o.status, o.created_at, o.guest_id, o.customer_name, c.name AS company_name FROM restaurant_orders o JOIN companies c ON c.id = o.company_id WHERE o.receipt_token = $1', [tok])).rows[0];
  if (!o) fail('notfound', 'This receipt link is not right, or the sale is no longer there.');
  o.settings = await access.settingsOf(o.company_id);
  return o;
}
function openFor(o) { return o.status === 'completed' && Date.now() - new Date(o.created_at).getTime() < OPEN_DAYS * 86400000; }
function given(r) { return r ? { rating: r.rating, tags: r.tags || [], dishes: r.dishes || [], comment: r.comment || '', contactOk: !!r.contact_ok, at: r.updated_at } : null; }

// GET /api/pos/receipt/:token/feedback — asked or not, and what was said.
async function ask(tok) {
  var o = await saleOf(tok);
  var on = o.settings.feedback.on;
  var r = on ? (await pool.query('SELECT * FROM restaurant_feedback WHERE order_id = $1', [o.id])).rows[0] : null;
  var dishes = on ? (await pool.query("SELECT DISTINCT ON (name) name FROM restaurant_order_items WHERE order_id = $1 AND name <> '' ORDER BY name LIMIT 20", [o.id])).rows.map(function (x) { return x.name; }) : [];
  return { on: on, open: on && openFor(o), tags: TAGS, dishes: dishes, given: given(r), reviewUrl: r && r.rating >= 4 ? o.settings.feedback.reviewUrl || null : null };
}

// POST /api/pos/receipt/:token/feedback { rating, tags, dishes: [{ name, liked }], comment, contactOk }
async function give(tok, p, ip) {
  p = p || {};
  var o = await saleOf(tok);
  if (!o.settings.feedback.on) fail('conflict', 'This restaurant is not asking for feedback here.');
  if (!openFor(o)) fail('conflict', 'Feedback on this visit is closed now. Thank you!');
  var rating = Number(p.rating);
  if (!(rating >= 1 && rating <= 5 && rating === Math.floor(rating))) fail('invalid', 'Pick a face from 1 to 5.');
  var tags = (Array.isArray(p.tags) ? p.tags : []).filter(function (t, i, a) { return TAGS.indexOf(t) >= 0 && a.indexOf(t) === i; });
  var names = (await pool.query('SELECT DISTINCT name FROM restaurant_order_items WHERE order_id = $1', [o.id])).rows.map(function (x) { return x.name; });
  var dishes = (Array.isArray(p.dishes) ? p.dishes : []).filter(function (d) { return d && names.indexOf(d.name) >= 0 && typeof d.liked === 'boolean'; })
    .filter(function (d, i, a) { return a.findIndex(function (x) { return x.name === d.name; }) === i; }).slice(0, 20).map(function (d) { return { name: d.name, liked: d.liked }; });
  var comment = clean(p.comment, 600);
  throttle(ip);
  var before = (await pool.query('SELECT rating FROM restaurant_feedback WHERE order_id = $1', [o.id])).rows[0];
  var r = (await pool.query(
    'INSERT INTO restaurant_feedback (company_id, order_id, guest_id, rating, tags, dishes, comment, contact_ok, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ' +
    "ON CONFLICT (order_id) DO UPDATE SET rating = EXCLUDED.rating, tags = EXCLUDED.tags, dishes = EXCLUDED.dishes, comment = EXCLUDED.comment, contact_ok = EXCLUDED.contact_ok, ip = EXCLUDED.ip, " +
    "  status = CASE WHEN restaurant_feedback.status = 'resolved' AND EXCLUDED.rating >= restaurant_feedback.rating THEN 'resolved' ELSE 'new' END, updated_at = now() RETURNING *",
    [o.company_id, o.id, o.guest_id || null, rating, tags, JSON.stringify(dishes), comment, !!p.contactOk, String(ip || '').slice(0, 60)])).rows[0];
  if (rating <= 2 && (!before || before.rating > 2)) {
    await activity.log(pool, { companyId: o.company_id, employeeId: null, app: 'guests', action: 'feedback.unhappy',
      summary: 'A guest was unhappy with ' + o.order_no + ' (' + rating + ' of 5)' + (tags.length ? ': ' + tags.join(', ') : '') + (comment ? ' — "' + comment.slice(0, 120) + '"' : '') + '.',
      refType: 'order', refId: o.id });
  }
  return { saved: true, given: given(r), reviewUrl: rating >= 4 ? o.settings.feedback.reviewUrl || null : null };
}

// The manager's view: how guests rate the visits, what they say.
async function report(companyId, q) {
  q = q || {};
  var p = insights.periodOf(q);
  var args = [companyId, p.from, p.to];
  var WHERE = "f.company_id = $1 AND f.created_at >= $2::date AND f.created_at < $3::date + interval '1 day'";
  var rows = (await pool.query(
    "SELECT f.*, o.order_no, o.total, o.customer_name, o.customer_phone, o.created_at AS sale_at, t.name AS table_name, g.name AS guest_name, g.phone AS guest_phone, " +
    "  we.first_name AS waiter_first, ce.first_name AS cashier_first, re.first_name || ' ' || re.last_name AS resolved_name " +
    'FROM restaurant_feedback f JOIN restaurant_orders o ON o.id = f.order_id LEFT JOIN restaurant_tables t ON t.id = o.table_id LEFT JOIN restaurant_guests g ON g.id = f.guest_id ' +
    'LEFT JOIN employees we ON we.id = o.waiter_id LEFT JOIN employees ce ON ce.id = o.cashier_id LEFT JOIN employees re ON re.id = f.resolved_by ' +
    'WHERE ' + WHERE + ' ORDER BY f.created_at DESC LIMIT 500', args)).rows;
  var sales = (await pool.query("SELECT count(*)::int AS n FROM restaurant_orders o WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at >= $2::date AND o.created_at < $3::date + interval '1 day'", args)).rows[0].n;
  var dist = [1, 2, 3, 4, 5].map(function (n) { return { rating: n, count: rows.filter(function (r) { return r.rating === n; }).length }; });
  var tags = TAGS.map(function (t) {
    var with_ = rows.filter(function (r) { return (r.tags || []).indexOf(t) >= 0; });
    return { tag: t, happy: with_.filter(function (r) { return r.rating >= 4; }).length, unhappy: with_.filter(function (r) { return r.rating <= 2; }).length, count: with_.length };
  });
  var dishMap = {};
  rows.forEach(function (r) {
    (r.dishes || []).forEach(function (d) { var x = dishMap[d.name] = dishMap[d.name] || { name: d.name, liked: 0, disliked: 0 }; if (d.liked) x.liked += 1; else x.disliked += 1; });
  });
  var people = {};
  rows.forEach(function (r) {
    var who = r.waiter_first || r.cashier_first;
    if (!who) return;
    var x = people[who] = people[who] || { name: who, count: 0, sum: 0 };
    x.count += 1; x.sum += r.rating;
  });
  var count = rows.length, sum = rows.reduce(function (a, r) { return a + r.rating; }, 0);
  var happy = rows.filter(function (r) { return r.rating >= 4; }).length, unhappy = rows.filter(function (r) { return r.rating <= 2; }).length;
  return {
    period: p, on: true,
    summary: { count: count, average: count ? round2(sum / count) : null, happy: happy, unhappy: unhappy, open: rows.filter(function (r) { return r.rating <= 2 && r.status !== 'resolved'; }).length,
      // Like a net promoter score, on the faces: happy less unhappy, in %.
      score: count ? Math.round((happy - unhappy) / count * 100) : null, responseRate: sales ? round2(count / sales * 100) : null, sales: sales },
    distribution: dist, tags: tags,
    dishes: Object.keys(dishMap).map(function (k) { return dishMap[k]; }).sort(function (a, b) { return (b.liked + b.disliked) - (a.liked + a.disliked) || b.liked - a.liked; }).slice(0, 20),
    people: Object.keys(people).map(function (k) { var x = people[k]; return { name: x.name, count: x.count, average: round2(x.sum / x.count) }; }).sort(function (a, b) { return b.count - a.count; }),
    items: rows.map(function (r) {
      var phone = r.contact_ok ? (r.guest_phone || r.customer_phone || '') : '';
      var digits = phone ? internationalNumber(phone) : null;
      return { id: r.id, rating: r.rating, tags: r.tags || [], dishes: r.dishes || [], comment: r.comment || '', status: r.status, reply: r.reply || '',
        orderNo: r.order_no, total: round2(r.total), table: r.table_name || null, servedBy: r.waiter_first || r.cashier_first || null, saleAt: r.sale_at, at: r.updated_at,
        guest: r.guest_name || r.customer_name || null, contactOk: !!r.contact_ok, phone: digits ? '+' + digits : null,
        resolvedBy: r.resolved_name || null, resolvedAt: r.resolved_at };
    })
  };
}

// { action: 'seen' | 'resolve', id, reply } — read, or followed up (what was done).
async function act(companyId, managerId, p) {
  var r = (await pool.query(
    'SELECT f.*, o.order_no, o.customer_phone, g.phone AS guest_phone, g.name AS guest_name, o.customer_name, c.name AS company_name FROM restaurant_feedback f JOIN restaurant_orders o ON o.id = f.order_id ' +
    'JOIN companies c ON c.id = f.company_id LEFT JOIN restaurant_guests g ON g.id = f.guest_id WHERE f.id = $1 AND f.company_id = $2', [String(p.id || ''), companyId])).rows[0];
  if (!r) fail('notfound', 'That feedback is not here.');
  if (p.action === 'seen') {
    await pool.query("UPDATE restaurant_feedback SET status = 'seen', updated_at = now() WHERE id = $1 AND status = 'new'", [r.id]);
    return {};
  }
  var reply = clean(p.reply, 600);
  await pool.query("UPDATE restaurant_feedback SET status = 'resolved', reply = $2, resolved_by = $3, resolved_at = now(), updated_at = now() WHERE id = $1", [r.id, reply, managerId]);
  await activity.log(pool, { companyId: companyId, employeeId: managerId, app: 'guests', action: 'feedback.resolved',
    summary: 'Feedback on ' + r.order_no + ' (' + r.rating + ' of 5) followed up' + (reply ? ': ' + reply.slice(0, 160) : '') + '.', refType: 'order', refId: r.order_id });
  // A message to the guest, if they said the restaurant may get in touch.
  var phone = r.contact_ok ? r.guest_phone || r.customer_phone : null;
  var digits = phone ? internationalNumber(phone) : null;
  if (p.message && digits) {
    var name = String(r.guest_name || r.customer_name || '').split(' ')[0];
    var words = clean(p.message, 600) || ('Hello' + (name ? ' ' + name : '') + ', thank you for telling us about your visit to ' + r.company_name + '. We are sorry it was not right.');
    return { whatsapp: 'https://wa.me/' + digits + '?text=' + encodeURIComponent(words) };
  }
  return {};
}

// POST /api/pos/settings/feedback { managerPin, action: 'list' | 'seen' | 'resolve', from, to }
async function tab(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var companyId = m.session.posCompanyId;
  var extra = {};
  if (p.action === 'seen' || p.action === 'resolve') extra = await act(companyId, m.manager.id, p);
  var out = await report(companyId, p);
  var settings = await access.settingsOf(companyId);
  out.on = settings.feedback.on;
  out.reviewUrl = settings.feedback.reviewUrl || '';
  return Object.assign(out, extra);
}

// The till's home for a manager: unhappy guests not followed up yet.
async function waiting(companyId) {
  return (await pool.query("SELECT count(*)::int AS n FROM restaurant_feedback WHERE company_id = $1 AND rating <= 2 AND status <> 'resolved' AND created_at > now() - interval '30 days'", [companyId])).rows[0].n;
}

module.exports = { TAGS: TAGS, ask: ask, give: give, report: report, act: act, tab: tab, waiting: waiting };
