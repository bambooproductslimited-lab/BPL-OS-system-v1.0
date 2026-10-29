var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// Reviews of what the online shop sells (migration 0192). Once an order is
// done (delivered or collected) its customer is asked — the "thank you"
// email, and its own page (/o/<link>) — to rate each thing they bought:
// stars, and a few words if they like. Staff see them on the Online shop
// page and show, hide or answer them; a review is shown on the shop once
// approved, or at once when the shop's settings say so (four stars and
// up). The shop shows each item's average and its latest reviews, with the
// first name and the initial of the surname only.

var MAX_WORDS = 600;
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function round1(n) { return Math.round(Number(n) * 10) / 10; }
function shop() { return require('./shop.service'); }
// "Esi Boateng" → "Esi B."
function shortName(name) {
  var parts = text(name, 120).split(' ').filter(Boolean);
  if (!parts.length) return 'A customer';
  return parts.length > 1 ? parts[0] + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.' : parts[0];
}
function reviewOut(r) {
  return { id: r.id, itemId: r.item_id, rating: Number(r.rating), words: r.words || '', name: r.name, reply: r.reply || '', at: r.created_at };
}

// The things in an order, by item (several choices of one item: one review).
async function itemsOf(o) {
  var vids = (o.lines || []).map(function (l) { return l.variationId; }).filter(Boolean);
  if (!vids.length) return [];
  var rows = (await pool.query('SELECT v.id AS variation_id, i.id AS item_id, i.name FROM catalog_item_variations v JOIN catalog_items i ON i.id = v.item_id WHERE v.id = ANY($1::uuid[])', [vids])).rows;
  var seen = {}, out = [];
  rows.forEach(function (r) { if (!seen[r.item_id]) { seen[r.item_id] = true; out.push({ itemId: r.item_id, name: r.name }); } });
  return out;
}

// For the order's own page: whether it may be rated, and what was said.
async function forOrder(o) {
  var s = await shop().settingsOf();
  if (!s.reviews.on || o.status !== 'done') return null;
  var items = await itemsOf(o);
  var mine = (await pool.query('SELECT * FROM shop_reviews WHERE order_id = $1', [o.id])).rows;
  return {
    items: items.map(function (it) {
      var r = mine.find(function (m) { return m.item_id === it.itemId; });
      return { itemId: it.itemId, name: it.name, rating: r ? Number(r.rating) : null, words: r ? r.words : '', status: r ? r.status : null };
    })
  };
}

// POST /api/shop/orders/:token/reviews { reviews: [{ itemId, rating, words }] }
// — the customer rates what they bought, once the order is done. A review
// not decided on yet may be changed; one shown or hidden is kept as it is.
async function rate(token, p) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) fail('notfound', 'We cannot find that order.');
  var o = (await pool.query('SELECT * FROM shop_orders WHERE token = $1', [token])).rows[0];
  if (!o) fail('notfound', 'We cannot find that order.');
  var s = await shop().settingsOf();
  if (!s.reviews.on) fail('conflict', 'Reviews are not taken on the shop just now.');
  if (o.status !== 'done') fail('conflict', 'You can rate your order once you have it.');
  var items = await itemsOf(o);
  var list = Array.isArray((p || {}).reviews) ? p.reviews : [];
  if (!list.length) fail('invalid', 'Give each thing from 1 to 5 stars.');
  var saved = 0;
  for (var i = 0; i < list.length && i < 40; i++) {
    var r = list[i] || {};
    var it = items.find(function (x) { return x.itemId === r.itemId; });
    if (!it) fail('invalid', 'That is not in this order.');
    var rating = Math.round(Number(r.rating));
    if (!(rating >= 1 && rating <= 5)) fail('invalid', 'Give each thing from 1 to 5 stars.');
    var words = text(r.words, MAX_WORDS);
    var status = s.reviews.autoShow && rating >= 4 ? 'shown' : 'pending';
    var res = await pool.query(
      'INSERT INTO shop_reviews (item_id, order_id, name, rating, words, status) VALUES ($1, $2, $3, $4, $5, $6) ' +
      "ON CONFLICT (order_id, item_id) DO UPDATE SET rating = EXCLUDED.rating, words = EXCLUDED.words, status = EXCLUDED.status, created_at = now() WHERE shop_reviews.status = 'pending' RETURNING id",
      [it.itemId, o.id, shortName(o.name), rating, words, status]);
    if (res.rowCount) saved++;
  }
  if (saved) {
    var holders = await require('./staffAlerts.service').holdersOf(['invoice.manage']);
    var notify = require('../utils/notify').notify;
    for (var h = 0; h < holders.length; h++) {
      await notify(pool, holders[h].employee_id, '⭐ ' + shortName(o.name) + ' rated ' + o.order_no, saved === 1 ? '1 review to look at' : saved + ' reviews to look at', '/shoporders?reviews=1');
    }
  }
  return forOrder(o);
}

// The shop's page: each item's stars ({ itemId: { average, count } }).
async function summary(itemIds) {
  if (!itemIds.length) return {};
  var rows = (await pool.query("SELECT item_id, avg(rating) AS average, count(*)::int AS n FROM shop_reviews WHERE status = 'shown' AND item_id = ANY($1::uuid[]) GROUP BY item_id", [itemIds])).rows;
  var out = {};
  rows.forEach(function (r) { out[r.item_id] = { average: round1(r.average), count: r.n }; });
  return out;
}
// The shop's front page: the latest good reviews with words (4 stars and
// up, shown), one an item, of the items on the shop.
async function highlights(itemIds) {
  if (!itemIds.length) return [];
  var rows = (await pool.query(
    "SELECT DISTINCT ON (r.item_id) r.*, i.name AS item_name FROM shop_reviews r JOIN catalog_items i ON i.id = r.item_id " +
    "WHERE r.status = 'shown' AND r.rating >= 4 AND length(trim(r.words)) >= 8 AND r.item_id = ANY($1::uuid[]) ORDER BY r.item_id, r.created_at DESC", [itemIds])).rows;
  rows.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
  return rows.slice(0, 6).map(function (r) { return Object.assign(reviewOut(r), { itemName: r.item_name }); });
}

// GET /api/shop/items/:id/reviews — an item's latest reviews on the shop.
async function ofItem(itemId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(itemId || ''))) fail('notfound', 'Item not found.');
  var s = await shop().settingsOf();
  if (!s.on || !s.reviews.on) return { reviews: [], average: null, count: 0 };
  var rows = (await pool.query("SELECT * FROM shop_reviews WHERE item_id = $1 AND status = 'shown' ORDER BY created_at DESC LIMIT 20", [itemId])).rows;
  var sum = (await summary([itemId]))[itemId] || { average: null, count: 0 };
  return { reviews: rows.map(reviewOut), average: sum.average, count: sum.count };
}

// GET /api/shop-orders/reviews?status=pending|shown|hidden — staff.
async function list(ctx, q) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  q = q || {};
  var status = ['pending', 'shown', 'hidden'].indexOf(q.status) >= 0 ? q.status : null;
  var rows = (await pool.query(
    'SELECT r.*, i.name AS item_name, o.order_no FROM shop_reviews r JOIN catalog_items i ON i.id = r.item_id JOIN shop_orders o ON o.id = r.order_id ' +
    (status ? 'WHERE r.status = $1 ' : '') + "ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 200", status ? [status] : [])).rows;
  var counts = (await pool.query("SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'shown')::int AS shown, round(avg(rating) FILTER (WHERE status = 'shown'), 1) AS average FROM shop_reviews")).rows[0];
  return {
    reviews: rows.map(function (r) { return Object.assign(reviewOut(r), { status: r.status, itemName: r.item_name, orderNo: r.order_no, decidedAt: r.decided_at }); }),
    counts: { pending: counts.pending, shown: counts.shown, average: counts.average == null ? null : Number(counts.average) }
  };
}
// PATCH /api/shop-orders/reviews/:id { status: shown|hidden, reply } — staff.
async function decide(ctx, id, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  p = p || {};
  var r = (await pool.query('SELECT * FROM shop_reviews WHERE id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'That review is gone.');
  var status = p.status === undefined ? r.status : ['shown', 'hidden'].indexOf(p.status) >= 0 ? p.status : fail('invalid', 'Show it or hide it.');
  var reply = p.reply === undefined ? r.reply : text(p.reply, 400);
  await pool.query('UPDATE shop_reviews SET status = $2, reply = $3, decided_by = $4, decided_at = now() WHERE id = $1', [id, status, reply, ctx.employee ? ctx.employee.id : null]);
  var did = status === 'shown' ? 'shown on the shop' : status === 'hidden' ? 'hidden' : 'answered';
  await audit(pool, ctx, 'shop.review_' + status, 'shop_review', id, 'A ' + r.rating + '-star review by ' + r.name + ' ' + did + (reply && status !== 'pending' ? ', answered.' : '.'));
  return (await list(ctx, {})).reviews.find(function (x) { return x.id === id; });
}

module.exports = { forOrder: forOrder, rate: rate, summary: summary, ofItem: ofItem, highlights: highlights, list: list, decide: decide, shortName: shortName };
