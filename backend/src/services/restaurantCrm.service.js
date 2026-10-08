var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { todayISO } = require('../utils/documents');

// The guest CRM of a restaurant (migration 0134), starting with Bamboo
// Garden. A guest's orders come from two places:
//   - the sales on the till (restaurant_orders): Square's, brought in by
//     restaurantSquareImport.service.js, which puts each sale with a Square
//     customer (or a number on its pick-up or delivery) on that guest;
//   - the order log (restaurant_guest_orders): what customer service takes
//     by phone, WhatsApp or Bolt — who ordered, how it came in, pick-up,
//     dine-in or delivery, and what the guest said about it afterwards.
// Those orders are rung up on Square as well, so each logged order is linked
// to its sale (autoLink: same day, same dishes, and Bolt, pick-up/delivery
// and the name agreeing where Square has them) and is then counted once,
// with the sale's amount. Sales with a guest and no logged order count on
// their own.
//
// A complaint (a rating of 3 or less, or words such as "small protein",
// "wrong order", "came late") opens a follow-up: someone should call the
// guest back. Regulars who have stopped ordering are listed to invite back.

var CHANNELS = ['phone', 'whatsapp', 'bolt', 'walk_in', 'instagram', 'facebook', 'website', 'other'];
var SERVICES = ['pickup', 'dine_in', 'delivery', 'reservation'];
var RANGES = { '30': 30, '90': 90, '365': 365, all: null };
var QUIET_MIN_DAYS = 30;
var NEW_DAYS = 30;
var OPEN_IMPORTED_DAYS = 14;

function canRead(ctx) { if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).'); }
function canManage(ctx) { if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).'); }
function num(x) { return x === null || x === undefined ? null : Math.round(Number(x) * 100) / 100; }
function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 500); }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }

async function company(companyId) {
  if (!companyId) fail('invalid', 'Choose a restaurant.');
  var c = (await pool.query('SELECT id, code, name FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!c) fail('notfound', 'Restaurant not found.');
  return c;
}

// The same forms as the database's restaurant_phone_key/restaurant_name_key.
function phoneKey(p) {
  var d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.indexOf('00') === 0) return d.slice(2);
  if (d.length === 10 && d[0] === '0') return '233' + d.slice(1);
  if (d.length === 9) return '233' + d;
  return d;
}
function nameKey(n) {
  return String(n || '').toLowerCase()
    .replace(/^\s*((madam|madame|mrs|mr|ms|miss|dr|auntie|aunty|uncle|sister|sis|brother|bro|chef|boss)\.?\s+)+/, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── what the guest said ───────────────────────────────────────────────
// Problems are words that only ever mean one (a small portion, the wrong
// order, a long wait); taste, service and price count when said with a "not",
// "too" or "but". Praise is kept too, for the overview.
var NEGATIVE = /\b(not|no|too|but|bad|poor|terrible|awful|horrible|disappoint\w*|didn'?t|wasn'?t|isn'?t|never|without)\b/i;
var THEMES = [
  ['portion', /\b(protein|proteins|protien|protiens|portion|portions|small|few|little|quantity|not enough|tiny)\b/i, false],
  ['order', /\b(wrong|missing|forgot|forgotten|didn'?t get|did not get|not what|asked for|instead of)\b/i, false],
  ['wait', /\b(late|waited|waiting|slow|delay|delayed|long time|took long|took too long)\b/i, false],
  ['taste', /\b(salt|salty|bland|tasteless|taste|spicy|spice|pepper|peppery|oily|sour|cold|overcooked|undercooked|burnt|raw|soggy|hard)\b/i, true],
  ['service', /\b(rude|attitude|unfriendly|ignored|service|staff|waiter|waitress|rider|driver)\b/i, true],
  ['price', /\b(expensive|pricey|price|overcharged|cost)\b/i, true]
];
var PRAISE = /\b(good|great|nice|delicious|tasty|love|loved|excellent|perfect|amazing|enjoyed|fresh|best|thanks?|thank you|wonderful|awesome)\b/i;

function feedbackOf(text, rating) {
  var t = String(text || '').replace(/small\s*chops?/ig, ' ');
  var neg = NEGATIVE.test(t);
  var themes = [];
  THEMES.forEach(function (th) {
    if (th[1].test(t) && (!th[2] || neg || (rating && rating <= 3))) themes.push(th[0]);
  });
  var complaint = !!(themes.length || (rating && rating <= 3));
  var praise = !complaint && !!(PRAISE.test(t) || (rating && rating >= 4));
  return { themes: themes, complaint: complaint, praise: praise };
}

// ── dishes ────────────────────────────────────────────────────────────
// "Assorted Fried Rice, beef sauce", "A90, A85", "2x Crazy Tuna Roll":
// one dish per part (parts split by commas, semicolons, new lines or +); a menu code (A90) becomes the dish on the menu; the
// till's "N05 Assorted Fried Rice" and the log's "assorted fried rice" are
// the same dish.
var CODE = /^([a-z]{1,2}\d{1,3})$/i;
var CODED_NAME = /^([A-Za-z]{1,2}\d{1,3})\s+(.+)$/;
// { CODE: dish } for the menu's coded items, with ._names: each dish's name
// as the menu writes it, so "assorted fried rice" typed in the sheet shows
// as "Assorted Fried Rice".
async function menuCodes(companyId) {
  var map = {};
  var names = {};
  (await pool.query('SELECT name FROM restaurant_menu_items WHERE company_id = $1', [companyId])).rows.forEach(function (r) {
    var n = String(r.name).trim();
    var m = CODED_NAME.exec(n);
    if (m) { map[m[1].toUpperCase()] = m[2].trim(); names[dishKey(m[2])] = m[2].trim(); } else names[dishKey(n)] = n;
  });
  Object.defineProperty(map, '_names', { value: names, enumerable: false });
  return map;
}
function hasCode(items) { return String(items || '').split(/[,;\s]+/).some(function (x) { return CODE.test(x); }); }
function dishKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9À-￿]+/g, ' ').trim(); }
function dishesOf(items, codes) {
  var out = [];
  // Not on "and" or "&": "Jollof and Chicken", "Banku and Okro" are one dish.
  String(items || '').split(/[,;\n+]/).forEach(function (part) {
    var p = part.trim().replace(/^\d+\s*(x|×|pcs?|pieces?)?\s+/i, '').replace(/\s*(x|×)\s*\d+$/i, '').trim();
    if (!p || /^reserv/i.test(p)) return;
    var code = CODE.exec(p);
    if (code) p = codes[code[1].toUpperCase()] || code[1].toUpperCase();
    else { var coded = CODED_NAME.exec(p); if (coded && !/\s/.test(coded[1])) p = coded[2]; }
    var key = dishKey(p);
    if (key) out.push({ key: key, name: p.charAt(0).toUpperCase() + p.slice(1) });
  });
  return out;
}

// ── every order of a restaurant's guests ─────────────────────────────
// The logged orders (with their sale's amount and items when linked), then
// the sales with a guest that no logged order stands for.
async function allOrders(companyId, opts) {
  opts = opts || {};
  var args = [companyId];
  var gWhere = '', oWhere = '';
  if (opts.guestId) { args.push(opts.guestId); gWhere += ' AND g.guest_id = $' + args.length; oWhere += ' AND o.guest_id = $' + args.length; }
  var rows = (await pool.query(
    "SELECT 'log' AS kind, g.id, g.guest_id, g.ordered_on::text AS day, g.channel, g.service, " +
    "  CASE WHEN g.items <> '' THEN g.items ELSE coalesce(ti.items, '') END AS items, coalesce(t.total, g.amount) AS amount, " +
    '  g.rating, g.feedback, g.follow_up, g.party_size, g.till_order_id, t.order_no ' +
    'FROM restaurant_guest_orders g LEFT JOIN restaurant_orders t ON t.id = g.till_order_id ' +
    'LEFT JOIN LATERAL (SELECT string_agg(name, \', \' ORDER BY name) AS items FROM restaurant_order_items WHERE order_id = t.id) ti ON true ' +
    'WHERE g.company_id = $1' + gWhere + ' ' +
    'UNION ALL ' +
    "SELECT 'till', o.id, o.guest_id, (o.created_at AT TIME ZONE 'UTC')::date::text, " +
    "  CASE WHEN o.source_name ~* 'bolt' THEN 'bolt' ELSE 'till' END, " +
    "  CASE WHEN o.fulfillment <> '' THEN o.fulfillment WHEN o.table_id IS NOT NULL THEN 'dine_in' ELSE 'counter' END, " +
    "  coalesce((SELECT string_agg(name, ', ' ORDER BY name) FROM restaurant_order_items WHERE order_id = o.id), ''), o.total, " +
    "  NULL, '', 'none', NULL, o.id, o.order_no " +
    "FROM restaurant_orders o WHERE o.company_id = $1 AND o.status = 'completed' AND o.guest_id IS NOT NULL" + oWhere + ' ' +
    '  AND NOT EXISTS (SELECT 1 FROM restaurant_guest_orders g2 WHERE g2.till_order_id = o.id) ' +
    'ORDER BY day DESC', args)).rows;
  return rows.map(function (r) {
    var fb = r.kind === 'log' ? feedbackOf(r.feedback, r.rating) : { themes: [], complaint: false, praise: false };
    return {
      kind: r.kind, id: r.id, guestId: r.guest_id, day: r.day, channel: r.channel, service: r.service, items: r.items,
      amount: num(r.amount), rating: r.rating, feedback: r.feedback, followUp: r.follow_up, partySize: r.party_size,
      tillOrderId: r.till_order_id, orderNo: r.order_no, themes: fb.themes, complaint: fb.complaint, praise: fb.praise
    };
  });
}

// Each guest's orders, first and last order, and where they stand.
function guestStats(rows, today) {
  var by = {};
  rows.forEach(function (r) {
    if (!r.guestId) return;
    var s = by[r.guestId] || (by[r.guestId] = { orders: 0, first: r.day, last: r.day, days: [], ratings: [], complaints: 0, open: 0, amount: 0, channels: {} });
    s.orders++;
    if (r.day < s.first) s.first = r.day;
    if (r.day > s.last) s.last = r.day;
    s.days.push(r.day);
    if (r.rating) s.ratings.push(r.rating);
    if (r.complaint) s.complaints++;
    if (r.followUp === 'open') s.open++;
    if (r.amount) s.amount += r.amount;
    s.channels[r.channel] = (s.channels[r.channel] || 0) + 1;
  });
  Object.keys(by).forEach(function (id) {
    var s = by[id];
    var days = s.days.slice().sort();
    var gaps = [];
    for (var i = 1; i < days.length; i++) gaps.push(daysBetween(days[i - 1], days[i]));
    s.avgGap = gaps.length ? Math.round(gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length) : null;
    s.daysSince = daysBetween(s.last, today);
    s.quietAfter = Math.max(QUIET_MIN_DAYS, s.avgGap ? s.avgGap * 2 : 0);
    s.segment = s.orders >= 3 ? (s.daysSince >= s.quietAfter ? 'quiet' : 'regular')
      : s.orders === 2 ? 'returning'
        : daysBetween(s.first, today) <= NEW_DAYS ? 'new' : 'once';
    s.avgRating = s.ratings.length ? Math.round(s.ratings.reduce(function (a, b) { return a + b; }, 0) / s.ratings.length * 10) / 10 : null;
    s.amount = num(s.amount);
    delete s.days;
  });
  return by;
}

function count(list, keyFn) {
  var m = {};
  list.forEach(function (x) { var k = keyFn(x); if (k) m[k] = (m[k] || 0) + 1; });
  return Object.keys(m).map(function (k) { return { key: k, orders: m[k] }; }).sort(function (a, b) { return b.orders - a.orders || a.key.localeCompare(b.key); });
}
function topDishes(rows, codes, limit) {
  var m = {};
  rows.forEach(function (r) {
    var seen = {};
    dishesOf(r.items, codes).forEach(function (d) {
      if (seen[d.key]) return;
      seen[d.key] = true;
      var x = m[d.key] || (m[d.key] = { key: d.key, name: (codes._names && codes._names[d.key]) || d.name, orders: 0 });
      x.orders++;
    });
  });
  return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.orders - a.orders || a.name.localeCompare(b.name); }).slice(0, limit || 10);
}

// ── the overview ──────────────────────────────────────────────────────
async function overview(ctx, q) {
  canRead(ctx);
  q = q || {};
  var co = await company(q.companyId);
  var range = Object.prototype.hasOwnProperty.call(RANGES, String(q.range)) ? String(q.range) : '365';
  var today = todayISO();
  var all = await allOrders(co.id);
  var first = all.length ? all[all.length - 1].day : today;
  var from = RANGES[range] ? addDays(today, -(RANGES[range] - 1)) : first;
  var inRange = all.filter(function (r) { return r.day >= from && r.day <= today; });
  var stats = guestStats(all, today);
  var guests = (await pool.query('SELECT id, name, phone, phone_key FROM restaurant_guests WHERE company_id = $1', [co.id])).rows;
  var guestById = {};
  guests.forEach(function (g) { guestById[g.id] = g; });
  var codes = await menuCodes(co.id);

  var guestIds = {};
  inRange.forEach(function (r) { if (r.guestId) guestIds[r.guestId] = (guestIds[r.guestId] || 0) + 1; });
  var ids = Object.keys(guestIds);
  var logged = inRange.filter(function (r) { return r.kind === 'log'; });
  var withFeedback = logged.filter(function (r) { return r.rating || String(r.feedback || '').trim(); });
  var ratings = inRange.filter(function (r) { return r.rating; }).map(function (r) { return r.rating; });
  var known = inRange.filter(function (r) { return r.amount !== null; });

  // The months of the period (at most the last 24), each with its orders and
  // the guests who ordered for the first time.
  var months = [];
  var startMonth = from.slice(0, 7);
  var m = today.slice(0, 7);
  while (m >= startMonth && months.length < 24) {
    months.unshift({ month: m, orders: 0, guests: 0, newGuests: 0, amount: 0 });
    var d = new Date(m + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); m = d.toISOString().slice(0, 7);
  }
  var monthIndex = {};
  months.forEach(function (x, i) { monthIndex[x.month] = i; });
  var monthGuests = {};
  inRange.forEach(function (r) {
    var i = monthIndex[r.day.slice(0, 7)];
    if (i === undefined) return;
    months[i].orders++;
    if (r.amount) months[i].amount = num(months[i].amount + r.amount);
    if (r.guestId) {
      var k = i + ':' + r.guestId;
      if (!monthGuests[k]) { monthGuests[k] = true; months[i].guests++; if (stats[r.guestId].first.slice(0, 7) === r.day.slice(0, 7)) months[i].newGuests++; }
    }
  });

  var weekdays = [0, 0, 0, 0, 0, 0, 0];
  inRange.forEach(function (r) { weekdays[new Date(r.day + 'T00:00:00Z').getUTCDay()]++; });

  var themeCount = {};
  var themeExample = {};
  logged.forEach(function (r) {
    r.themes.forEach(function (t) { themeCount[t] = (themeCount[t] || 0) + 1; if (!themeExample[t] && r.feedback) themeExample[t] = r.feedback; });
    if (r.praise) { themeCount.praise = (themeCount.praise || 0) + 1; if (!themeExample.praise && r.feedback) themeExample.praise = r.feedback; }
  });

  function guestBrief(id) {
    var g = guestById[id] || {};
    var s = stats[id] || {};
    return { id: id, name: g.name || '—', phone: g.phone || '', orders: s.orders || 0, lastOn: s.last || null, daysSince: s.daysSince, segment: s.segment, avgGap: s.avgGap };
  }
  var open = (await pool.query(
    "SELECT g.id, g.ordered_on::text AS day, g.feedback, g.rating, g.items, gu.id AS guest_id, gu.name, gu.phone FROM restaurant_guest_orders g " +
    "LEFT JOIN restaurant_guests gu ON gu.id = g.guest_id WHERE g.company_id = $1 AND g.follow_up = 'open' ORDER BY g.ordered_on DESC LIMIT 50", [co.id])).rows;

  var quiet = Object.keys(stats).filter(function (id) { return stats[id].segment === 'quiet'; }).map(guestBrief)
    .sort(function (a, b) { return b.orders - a.orders || a.daysSince - b.daysSince; });
  var linked = logged.filter(function (r) { return r.tillOrderId; }).length;

  return {
    company: co, range: range, from: from, to: today, firstOrderOn: all.length ? first : null,
    totals: {
      orders: inRange.length, logged: logged.length, tillWithGuest: inRange.length - logged.length,
      guests: ids.length, anonymous: inRange.filter(function (r) { return !r.guestId; }).length,
      newGuests: ids.filter(function (id) { return stats[id].first >= from; }).length,
      repeatGuests: ids.filter(function (id) { return stats[id].orders >= 2; }).length,
      feedback: withFeedback.length, feedbackRate: logged.length ? Math.round(withFeedback.length / logged.length * 100) : null,
      ratings: ratings.length, avgRating: ratings.length ? Math.round(ratings.reduce(function (a, b) { return a + b; }, 0) / ratings.length * 10) / 10 : null,
      complaints: logged.filter(function (r) { return r.complaint; }).length,
      openFollowUps: open.length,
      amount: num(known.reduce(function (a, r) { return a + r.amount; }, 0)), amountOrders: known.length,
      linkedToTill: linked,
      noPhone: ids.filter(function (id) { return !(guestById[id] && guestById[id].phone_key); }).length,
      allGuests: guests.length
    },
    months: months,
    weekdays: weekdays,
    channels: count(inRange, function (r) { return r.channel; }),
    services: count(inRange, function (r) { return r.service; }),
    topGuests: ids.map(function (id) { return Object.assign(guestBrief(id), { inRange: guestIds[id] }); })
      .sort(function (a, b) { return b.inRange - a.inRange || String(b.lastOn).localeCompare(String(a.lastOn)); }).slice(0, 8),
    dishes: topDishes(inRange, codes, 10),
    themes: Object.keys(themeCount).map(function (k) { return { key: k, count: themeCount[k], example: themeExample[k] || '' }; })
      .sort(function (a, b) { return (a.key === 'praise') - (b.key === 'praise') || b.count - a.count; }),
    openFollowUps: open.map(function (r) {
      var fb = feedbackOf(r.feedback, r.rating);
      return { id: r.id, day: r.day, feedback: r.feedback, rating: r.rating, items: r.items, themes: fb.themes, guest: r.guest_id ? { id: r.guest_id, name: r.name, phone: r.phone } : null };
    }),
    quiet: quiet.slice(0, 12), quietCount: quiet.length
  };
}

// ── the order log ─────────────────────────────────────────────────────
var ORDER_SELECT =
  'SELECT g.*, g.ordered_on::text AS day, gu.name AS guest_name, gu.phone AS guest_phone, ' +
  "  t.order_no AS till_no, t.total AS till_total, t.created_at AS till_at, t.source_name AS till_source, " +
  "  (SELECT string_agg(name, ', ' ORDER BY name) FROM restaurant_order_items WHERE order_id = t.id) AS till_items, " +
  "  fu.first_name || ' ' || fu.last_name AS followed_up_by_name, cb.first_name || ' ' || cb.last_name AS created_by_name " +
  'FROM restaurant_guest_orders g LEFT JOIN restaurant_guests gu ON gu.id = g.guest_id ' +
  'LEFT JOIN restaurant_orders t ON t.id = g.till_order_id ' +
  'LEFT JOIN employees fu ON fu.id = g.followed_up_by LEFT JOIN employees cb ON cb.id = g.created_by ';

function rowToOrder(r, codes) {
  var fb = feedbackOf(r.feedback, r.rating);
  return {
    id: r.id, companyId: r.company_id, orderedOn: r.day, channel: r.channel, service: r.service, items: r.items,
    // menu codes (A90, A85) read as the dishes they stand for
    itemsRead: codes && hasCode(r.items) ? dishesOf(r.items, codes).map(function (d) { return (codes._names && codes._names[d.key]) || d.name; }).join(', ') : null,
    amount: r.till_order_id && r.till_total !== null ? num(r.till_total) : num(r.amount), amountFromTill: !!(r.till_order_id && r.till_total !== null),
    partySize: r.party_size, tableNote: r.table_note, feedback: r.feedback, rating: r.rating,
    themes: fb.themes, complaint: fb.complaint, praise: fb.praise,
    followUp: r.follow_up, followUpNote: r.follow_up_note, followedUpAt: r.followed_up_at, followedUpByName: r.followed_up_by_name || null,
    guest: r.guest_id ? { id: r.guest_id, name: r.guest_name, phone: r.guest_phone } : null,
    till: r.till_order_id ? { id: r.till_order_id, orderNo: r.till_no, total: num(r.till_total), at: r.till_at, items: r.till_items || '', source: r.till_source || '', link: r.till_link } : null,
    tillLink: r.till_link, imported: !!r.external_key, createdAt: r.created_at, createdByName: r.created_by_name || null
  };
}
async function orderRow(id) {
  var r = (await pool.query(ORDER_SELECT + 'WHERE g.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Order not found.');
  return r;
}

async function listOrders(ctx, q) {
  canRead(ctx);
  q = q || {};
  var co = await company(q.companyId);
  var args = [co.id];
  var where = ['g.company_id = $1'];
  function add(sql, v) { args.push(v); where.push(sql.replace('?', '$' + args.length)); }
  if (q.from) add('g.ordered_on >= ?', V.date(q.from, 'From'));
  if (q.to) add('g.ordered_on <= ?', V.date(q.to, 'To'));
  if (q.channel && CHANNELS.indexOf(q.channel) >= 0) add('g.channel = ?', q.channel);
  if (q.service && SERVICES.indexOf(q.service) >= 0) add('g.service = ?', q.service);
  if (q.followUp === 'open') where.push("g.follow_up = 'open'");
  if (q.feedback === '1') where.push("(g.feedback <> '' OR g.rating IS NOT NULL)");
  if (q.till === 'none') where.push('g.till_order_id IS NULL');
  if (q.guestId) add('g.guest_id = ?', q.guestId);
  if (q.q) {
    args.push('%' + String(q.q).trim() + '%');
    var p = '$' + args.length;
    where.push('(g.items ILIKE ' + p + ' OR g.feedback ILIKE ' + p + ' OR gu.name ILIKE ' + p + ' OR gu.phone ILIKE ' + p + ')');
  }
  var limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  var offset = Math.max(Number(q.offset) || 0, 0);
  var total = Number((await pool.query('SELECT count(*) FROM restaurant_guest_orders g LEFT JOIN restaurant_guests gu ON gu.id = g.guest_id WHERE ' + where.join(' AND '), args)).rows[0].count);
  var rows = (await pool.query(ORDER_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY g.ordered_on DESC, g.created_at DESC LIMIT ' + limit + ' OFFSET ' + offset, args)).rows;
  var codes = await menuCodes(co.id);
  return { total: total, orders: rows.map(function (r) { return rowToOrder(r, codes); }) };
}

// A guest by name and number: the same number is the same guest; a name
// alone is the guest of that name (the one with most orders when there are
// several) — a guest found by name without a number gets the number.
async function findOrCreateGuest(db, companyId, p, source) {
  var name = str(p.name, 100);
  var phone = str(p.phone, 40);
  var pk = phoneKey(phone);
  if (pk) {
    var byPhone = (await db.query('SELECT id FROM restaurant_guests WHERE company_id = $1 AND phone_key = $2 ORDER BY created_at LIMIT 1', [companyId, pk])).rows[0];
    if (byPhone) return { id: byPhone.id, created: false };
  }
  var nk = nameKey(name);
  if (nk) {
    var byName = (await db.query(
      'SELECT g.id, g.phone_key, (SELECT count(*) FROM restaurant_guest_orders o WHERE o.guest_id = g.id) + (SELECT count(*) FROM restaurant_orders o WHERE o.guest_id = g.id) AS n ' +
      'FROM restaurant_guests g WHERE g.company_id = $1 AND g.name_key = $2 ORDER BY n DESC, g.created_at', [companyId, nk])).rows;
    var pick = pk ? byName.filter(function (g) { return !g.phone_key; })[0] : byName[0];
    if (pick) {
      if (pk) await db.query('UPDATE restaurant_guests SET phone = $2, updated_at = now() WHERE id = $1', [pick.id, phone]);
      return { id: pick.id, created: false };
    }
  }
  if (!name && !phone) return { id: null, created: false };
  var g = (await db.query('INSERT INTO restaurant_guests (company_id, name, phone, source) VALUES ($1,$2,$3,$4) RETURNING id', [companyId, name || phone, phone, source || 'order'])).rows[0];
  return { id: g.id, created: true };
}

function readOrder(p, existing) {
  p = p || {};
  var e = existing || {};
  var out = {};
  out.orderedOn = V.date(p.orderedOn || e.day || todayISO(), 'Date');
  if (out.orderedOn > todayISO()) fail('invalid', 'The order date cannot be in the future.');
  out.channel = V.oneOf(p.channel || e.channel || 'phone', CHANNELS, 'How it came in');
  out.service = V.oneOf(p.service || e.service || 'pickup', SERVICES, 'Pick-up, dine-in or delivery');
  out.items = str(p.items !== undefined ? p.items : e.items, 1000);
  if (!out.items && out.service !== 'reservation') fail('invalid', 'Write what was ordered.');
  var amount = p.amount !== undefined ? p.amount : e.amount;
  out.amount = amount === '' || amount === null || amount === undefined ? null : Number(amount);
  if (out.amount !== null && !(out.amount >= 0 && out.amount < 1e8)) fail('invalid', 'The amount must be a number.');
  var party = p.partySize !== undefined ? p.partySize : e.party_size;
  out.partySize = party === '' || party === null || party === undefined ? null : Number(party);
  if (out.partySize !== null && !(Number.isInteger(out.partySize) && out.partySize >= 1 && out.partySize <= 500)) fail('invalid', 'The number of guests must be a whole number.');
  out.tableNote = str(p.tableNote !== undefined ? p.tableNote : e.table_note, 100);
  out.feedback = str(p.feedback !== undefined ? p.feedback : e.feedback, 1000);
  var rating = p.rating !== undefined ? p.rating : e.rating;
  out.rating = rating === '' || rating === null || rating === undefined ? null : Number(rating);
  if (out.rating !== null && !(Number.isInteger(out.rating) && out.rating >= 1 && out.rating <= 5)) fail('invalid', 'The rating is from 1 to 5.');
  return out;
}

async function guestFor(db, co, p) {
  if (p.guestId) {
    var g = (await db.query('SELECT id FROM restaurant_guests WHERE id = $1 AND company_id = $2', [p.guestId, co.id])).rows[0];
    if (!g) fail('notfound', 'Guest not found at ' + co.name + '.');
    return g.id;
  }
  var who = p.guest || {};
  if (!str(who.name) && !str(who.phone)) fail('invalid', 'Choose the guest, or write their name.');
  return (await findOrCreateGuest(db, co.id, who, 'order')).id;
}

async function createOrder(ctx, p) {
  canManage(ctx);
  p = p || {};
  var co = await company(p.companyId);
  var o = readOrder(p);
  var fb = feedbackOf(o.feedback, o.rating);
  var id = await withTransaction(async function (client) {
    var guestId = await guestFor(client, co, p);
    return (await client.query(
      'INSERT INTO restaurant_guest_orders (company_id, guest_id, ordered_on, channel, service, items, amount, party_size, table_note, feedback, rating, follow_up, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',
      [co.id, guestId, o.orderedOn, o.channel, o.service, o.items, o.amount, o.partySize, o.tableNote, o.feedback, o.rating, fb.complaint ? 'open' : 'none', ctx.employee ? ctx.employee.id : null])).rows[0].id;
  });
  await autoLink(co.id, { ids: [id] });
  var r = await orderRow(id);
  await audit(pool, ctx, 'restaurant.guest_order.create', 'restaurant_guest_order', id, 'Logged ' + (r.guest_name || 'a guest') + '\'s ' + o.channel + ' order of ' + o.orderedOn + ' at ' + co.name + '.');
  return rowToOrder(r);
}

async function updateOrder(ctx, id, p) {
  canManage(ctx);
  p = p || {};
  var cur = await orderRow(id);
  var co = await company(cur.company_id);
  var o = readOrder(p, cur);
  var fb = feedbackOf(o.feedback, o.rating);
  // A new complaint opens a follow-up; one no longer a complaint closes,
  // unless someone already wrote what was done.
  var followUp = cur.follow_up;
  if (fb.complaint && followUp === 'none') followUp = 'open';
  if (!fb.complaint && followUp === 'open' && !cur.follow_up_note) followUp = 'none';
  await withTransaction(async function (client) {
    var guestId = p.guestId || p.guest ? await guestFor(client, co, p) : cur.guest_id;
    await client.query(
      'UPDATE restaurant_guest_orders SET guest_id = $2, ordered_on = $3, channel = $4, service = $5, items = $6, amount = $7, party_size = $8, table_note = $9, ' +
      'feedback = $10, rating = $11, follow_up = $12, updated_at = now() WHERE id = $1',
      [id, guestId, o.orderedOn, o.channel, o.service, o.items, o.amount, o.partySize, o.tableNote, o.feedback, o.rating, followUp]);
    // A different day: the sale found by the OS no longer stands.
    if (cur.till_link === 'auto' && o.orderedOn !== cur.day) {
      await client.query("UPDATE restaurant_guest_orders SET till_order_id = NULL, till_link = '' WHERE id = $1", [id]);
      await releaseSale(client, cur.till_order_id, cur.guest_id);
    }
  });
  await autoLink(co.id, { ids: [id] });
  await audit(pool, ctx, 'restaurant.guest_order.update', 'restaurant_guest_order', id, 'Changed the order of ' + o.orderedOn + ' (' + (cur.guest_name || 'a guest') + ') at ' + co.name + '.');
  return rowToOrder(await orderRow(id));
}

async function deleteOrder(ctx, id) {
  canManage(ctx);
  var cur = await orderRow(id);
  await pool.query('DELETE FROM restaurant_guest_orders WHERE id = $1', [id]);
  await audit(pool, ctx, 'restaurant.guest_order.delete', 'restaurant_guest_order', id, 'Removed ' + (cur.guest_name || 'a guest') + '\'s order of ' + cur.day + ' from the order log.');
  return { ok: true };
}

// Someone called the guest back (done, with what was said), or the
// complaint is put back on the list.
async function setFollowUp(ctx, id, p) {
  canManage(ctx);
  p = p || {};
  var cur = await orderRow(id);
  var status = V.oneOf(p.status || 'done', ['open', 'done', 'none'], 'Follow-up');
  var note = str(p.note, 1000);
  if (status === 'done' && !note) fail('invalid', 'Write what was done — for example "Called her, apologised, a free drink next time".');
  await pool.query(
    'UPDATE restaurant_guest_orders SET follow_up = $2, follow_up_note = $3, followed_up_by = $4, followed_up_at = $5, updated_at = now() WHERE id = $1',
    [id, status, status === 'done' ? note : note || cur.follow_up_note, status === 'done' ? (ctx.employee ? ctx.employee.id : null) : cur.followed_up_by, status === 'done' ? new Date() : cur.followed_up_at]);
  await audit(pool, ctx, 'restaurant.guest_order.follow_up', 'restaurant_guest_order', id,
    (status === 'done' ? 'Followed up ' : status === 'open' ? 'Reopened the follow-up of ' : 'Cleared the follow-up of ') + (cur.guest_name || 'a guest') + '\'s order of ' + cur.day + (note ? ': ' + note : '.'));
  return rowToOrder(await orderRow(id));
}

// ── linking a logged order to its sale on the till ───────────────────
var STOP = { with: 1, and: 1, the: 1, of: 1, in: 1, extra: 1, plus: 1, add: 1, pcs: 1, pieces: 1, portion: 1, order: 1, for: 1 };
function words(s) {
  var out = {};
  dishKey(s).split(' ').forEach(function (w) {
    if (w.length < 3 || STOP[w] || /^\d+$/.test(w)) return;
    out[w.length > 4 ? w.replace(/s$/, '') : w] = true;
  });
  return out;
}
function saleWords(items) {
  return words(String(items || '').split(/,\s*/).map(function (n) { var m = CODED_NAME.exec(n.trim()); return m ? m[1] + ' ' + m[2] : n; }).join(' '));
}
// How well a sale fits a logged order: the dishes, then whatever Square
// knows (Bolt, pick-up or delivery, the name or number on it).
function fit(o, s, codes) {
  var lw = words(dishesOf(o.items, codes).map(function (d) { return d.name; }).join(' '));
  var sw = saleWords(s.items);
  var lk = Object.keys(lw);
  var shared = lk.filter(function (w) { return sw[w]; }).length;
  var score = lk.length ? 2 * shared / lk.length : 0;
  if (lk.length && !shared) return -1;
  var codesInLog = String(o.items || '').split(/[,;\s]+/).filter(function (x) { return CODE.test(x); }).map(function (x) { return x.toUpperCase(); });
  var saleCodes = String(s.items || '').split(/,\s*/).map(function (n) { var m = CODED_NAME.exec(n.trim()); return m ? m[1].toUpperCase() : null; }).filter(Boolean);
  score += Math.min(2, codesInLog.filter(function (c) { return saleCodes.indexOf(c) >= 0; }).length);
  var svc = { pickup: 'pickup', delivery: 'delivery', dine_in: 'dine_in', reservation: 'dine_in' }[o.service];
  if (s.fulfillment && svc) score += s.fulfillment === svc ? 0.5 : -1;
  var bolt = /bolt/i.test(s.source_name || '');
  if (o.channel === 'bolt' && bolt) score += 1.5;
  else if (o.channel !== 'bolt' && bolt) score -= 1.5;
  var gk = phoneKey(o.guest_phone);
  if (gk && phoneKey(s.customer_phone) === gk) score += 3;
  var gn = words(nameKey(o.guest_name));
  var sn = words(nameKey(s.customer_name) + ' ' + nameKey(s.ticket_name));
  if (Object.keys(gn).some(function (w) { return sn[w]; })) score += 1.5;
  return score;
}

// Links each logged order without a sale to the one sale of that day that
// clearly fits it (opts.ids: only those orders); leaves it when two sales
// fit about as well. Returns how many were linked.
async function autoLink(companyId, opts) {
  opts = opts || {};
  var args = [companyId];
  var where = "g.company_id = $1 AND g.till_order_id IS NULL AND g.till_link = ''";
  if (opts.ids) { args.push(opts.ids); where += ' AND g.id = ANY($2::uuid[])'; }
  if (opts.from) { args.push(opts.from); where += ' AND g.ordered_on >= $' + args.length; }
  var logged = (await pool.query(
    'SELECT g.id, g.ordered_on::text AS day, g.channel, g.service, g.items, g.guest_id, gu.name AS guest_name, gu.phone AS guest_phone ' +
    'FROM restaurant_guest_orders g LEFT JOIN restaurant_guests gu ON gu.id = g.guest_id WHERE ' + where + ' ORDER BY g.ordered_on', args)).rows;
  if (!logged.length) return 0;
  var codes = await menuCodes(companyId);
  var byDay = {};
  logged.forEach(function (o) { (byDay[o.day] = byDay[o.day] || []).push(o); });
  var linked = 0;
  for (var day of Object.keys(byDay)) {
    var sales = (await pool.query(
      "SELECT o.id, o.guest_id, o.source_name, o.fulfillment, o.customer_name, o.customer_phone, o.ticket_name, " +
      "  coalesce((SELECT string_agg(name, ', ') FROM restaurant_order_items WHERE order_id = o.id), '') AS items " +
      "FROM restaurant_orders o WHERE o.company_id = $1 AND o.status = 'completed' AND (o.created_at AT TIME ZONE 'UTC')::date = $2 " +
      '  AND NOT EXISTS (SELECT 1 FROM restaurant_guest_orders g WHERE g.till_order_id = o.id)', [companyId, day])).rows;
    var taken = {};
    for (var o of byDay[day]) {
      var scored = sales.filter(function (s) { return !taken[s.id]; }).map(function (s) { return { s: s, score: fit(o, s, codes) }; })
        .sort(function (a, b) { return b.score - a.score; });
      var best = scored[0], next = scored[1];
      if (!best || best.score < 1.5 || (next && best.score - next.score < 0.5)) continue;
      taken[best.s.id] = true;
      var done = await pool.query(
        "UPDATE restaurant_guest_orders SET till_order_id = $2, till_link = 'auto', updated_at = now() WHERE id = $1 AND till_order_id IS NULL " +
        'AND NOT EXISTS (SELECT 1 FROM restaurant_guest_orders WHERE till_order_id = $2)', [o.id, best.s.id]);
      if (done.rowCount) {
        linked++;
        if (o.guest_id) await pool.query('UPDATE restaurant_orders SET guest_id = $2 WHERE id = $1 AND guest_id IS NULL', [best.s.id, o.guest_id]);
      }
    }
  }
  return linked;
}

// The sales of the order's day (and the day either side) to choose from,
// best fit first.
async function tillCandidates(ctx, id) {
  canRead(ctx);
  var o = await orderRow(id);
  var codes = await menuCodes(o.company_id);
  var sales = (await pool.query(
    "SELECT o.id, o.order_no, o.total, o.created_at, o.source_name, o.fulfillment, o.customer_name, o.customer_phone, o.ticket_name, " +
    "  coalesce((SELECT string_agg(name, ', ') FROM restaurant_order_items WHERE order_id = o.id), '') AS items, " +
    '  (SELECT g.id FROM restaurant_guest_orders g WHERE g.till_order_id = o.id) AS linked_to ' +
    "FROM restaurant_orders o WHERE o.company_id = $1 AND o.status = 'completed' " +
    "  AND (o.created_at AT TIME ZONE 'UTC')::date BETWEEN $2::date - 1 AND $2::date + 1 ORDER BY o.created_at", [o.company_id, o.day])).rows;
  var base = { items: o.items, service: o.service, channel: o.channel, guest_name: o.guest_name, guest_phone: o.guest_phone };
  return sales.filter(function (s) { return !s.linked_to || s.linked_to === o.id; }).map(function (s) {
    return {
      id: s.id, orderNo: s.order_no, total: num(s.total), at: s.created_at, items: s.items, source: s.source_name, fulfillment: s.fulfillment,
      customerName: s.customer_name || s.ticket_name || '', linked: s.id === o.till_order_id, fit: Math.round(fit(base, s, codes) * 10) / 10
    };
  }).sort(function (a, b) { return b.fit - a.fit || new Date(a.at) - new Date(b.at); });
}

// A sale no longer linked gives back the guest the link put on it (not one
// Square itself named).
async function releaseSale(db, saleId, guestId) {
  if (!saleId || !guestId) return;
  await db.query("UPDATE restaurant_orders SET guest_id = NULL WHERE id = $1 AND guest_id = $2 AND square_customer_id IS NULL AND customer_phone = ''", [saleId, guestId]);
}

// Staff choose the sale (tillOrderId), or say there is none (null).
async function linkTill(ctx, id, p) {
  canManage(ctx);
  p = p || {};
  var o = await orderRow(id);
  if (o.till_order_id && o.till_order_id !== p.tillOrderId) await releaseSale(pool, o.till_order_id, o.guest_id);
  if (p.tillOrderId) {
    var s = (await pool.query("SELECT id, order_no, guest_id FROM restaurant_orders WHERE id = $1 AND company_id = $2 AND status = 'completed'", [p.tillOrderId, o.company_id])).rows[0];
    if (!s) fail('notfound', 'Sale not found.');
    var other = (await pool.query('SELECT id FROM restaurant_guest_orders WHERE till_order_id = $1 AND id <> $2', [s.id, id])).rows[0];
    if (other) fail('conflict', 'That sale is already linked to another order in the log.');
    await pool.query("UPDATE restaurant_guest_orders SET till_order_id = $2, till_link = 'staff', updated_at = now() WHERE id = $1", [id, s.id]);
    if (o.guest_id) await pool.query('UPDATE restaurant_orders SET guest_id = $2 WHERE id = $1 AND guest_id IS NULL', [s.id, o.guest_id]);
    await audit(pool, ctx, 'restaurant.guest_order.link', 'restaurant_guest_order', id, 'Linked ' + (o.guest_name || 'a guest') + '\'s order of ' + o.day + ' to the sale ' + s.order_no + '.');
  } else {
    await pool.query("UPDATE restaurant_guest_orders SET till_order_id = NULL, till_link = 'none', updated_at = now() WHERE id = $1", [id]);
    await audit(pool, ctx, 'restaurant.guest_order.link', 'restaurant_guest_order', id, 'Marked ' + (o.guest_name || 'a guest') + '\'s order of ' + o.day + ' as not on the till.');
  }
  return rowToOrder(await orderRow(id));
}

// ── guests ────────────────────────────────────────────────────────────
var SEGMENTS = ['regular', 'quiet', 'returning', 'new', 'once', 'none'];

async function listGuests(ctx, q) {
  canRead(ctx);
  q = q || {};
  var co = await company(q.companyId);
  var today = todayISO();
  var rows = await allOrders(co.id);
  var stats = guestStats(rows, today);
  var codes = await menuCodes(co.id);
  var guests = (await pool.query('SELECT * FROM restaurant_guests WHERE company_id = $1', [co.id])).rows;
  var favs = {};
  rows.forEach(function (r) { if (r.guestId) (favs[r.guestId] = favs[r.guestId] || []).push(r); });
  var dupes = await duplicatePairs(co.id);
  var dupeIds = {};
  dupes.forEach(function (d) { dupeIds[d.a.id] = true; dupeIds[d.b.id] = true; });
  var list = guests.map(function (g) {
    var s = stats[g.id] || { orders: 0, segment: 'none', complaints: 0, open: 0, channels: {} };
    var fav = favs[g.id] ? topDishes(favs[g.id], codes, 1)[0] : null;
    return {
      id: g.id, name: g.name, phone: g.phone, notes: g.notes, source: g.source, fromSquare: !!g.square_customer_id,
      orders: s.orders, firstOn: s.first || null, lastOn: s.last || null, daysSince: s.daysSince === undefined ? null : s.daysSince,
      avgGap: s.avgGap || null, segment: s.segment, avgRating: s.avgRating || null, complaints: s.complaints, openFollowUps: s.open,
      amount: s.amount || 0, favourite: fav ? fav.name : null,
      channel: Object.keys(s.channels).sort(function (a, b) { return s.channels[b] - s.channels[a]; })[0] || null,
      possibleDuplicate: !!dupeIds[g.id]
    };
  });
  var counts = { all: list.length, complaints: 0, nophone: 0, duplicates: dupes.length };
  SEGMENTS.forEach(function (k) { counts[k] = 0; });
  list.forEach(function (g) { counts[g.segment]++; if (g.complaints) counts.complaints++; if (!phoneKey(g.phone)) counts.nophone++; });
  var seg = q.segment;
  var shown = list.filter(function (g) {
    if (SEGMENTS.indexOf(seg) >= 0) return g.segment === seg;
    if (seg === 'complaints') return g.complaints > 0;
    if (seg === 'nophone') return !phoneKey(g.phone);
    return true;
  });
  if (q.q) {
    var needle = String(q.q).toLowerCase().trim();
    var digits = needle.replace(/\D/g, '').replace(/^0/, '');
    shown = shown.filter(function (g) { return g.name.toLowerCase().indexOf(needle) >= 0 || (digits.length >= 5 && phoneKey(g.phone).indexOf(digits) >= 0); });
  }
  var sort = q.sort === 'orders' ? function (a, b) { return b.orders - a.orders || String(b.lastOn).localeCompare(String(a.lastOn)); }
    : q.sort === 'name' ? function (a, b) { return a.name.localeCompare(b.name); }
      : function (a, b) { return String(b.lastOn || '').localeCompare(String(a.lastOn || '')) || b.orders - a.orders || a.name.localeCompare(b.name); };
  shown.sort(sort);
  var limit = Math.min(Math.max(Number(q.limit) || 60, 1), 500);
  var offset = Math.max(Number(q.offset) || 0, 0);
  return { total: shown.length, counts: counts, guests: shown.slice(offset, offset + limit) };
}

async function getGuest(ctx, id) {
  canRead(ctx);
  var g = (await pool.query('SELECT * FROM restaurant_guests WHERE id = $1', [id])).rows[0];
  if (!g) fail('notfound', 'Guest not found.');
  var today = todayISO();
  var rows = await allOrders(g.company_id, { guestId: g.id });
  var s = guestStats(rows, today)[g.id] || { orders: 0, segment: 'none', complaints: 0, open: 0, channels: {}, amount: 0 };
  var codes = await menuCodes(g.company_id);
  var dupes = (await duplicatePairs(g.company_id)).filter(function (d) { return d.a.id === g.id || d.b.id === g.id; })
    .map(function (d) { var other = d.a.id === g.id ? d.b : d.a; return Object.assign({ reason: d.reason }, other); });
  return {
    id: g.id, companyId: g.company_id, name: g.name, phone: g.phone, notes: g.notes, source: g.source, fromSquare: !!g.square_customer_id, createdAt: g.created_at,
    orders: s.orders, firstOn: s.first || null, lastOn: s.last || null, daysSince: s.daysSince === undefined ? null : s.daysSince,
    avgGap: s.avgGap || null, quietAfter: s.quietAfter || null, segment: s.segment, avgRating: s.avgRating || null,
    complaints: s.complaints, openFollowUps: s.open, amount: s.amount || 0,
    channels: Object.keys(s.channels).map(function (k) { return { key: k, orders: s.channels[k] }; }).sort(function (a, b) { return b.orders - a.orders; }),
    dishes: topDishes(rows, codes, 6),
    timeline: rows.slice(0, 200),
    duplicates: dupes
  };
}

// Two guests who are probably one: the same number, or the same name where
// one of them has no number.
async function duplicatePairs(companyId) {
  var rows = (await pool.query(
    'SELECT a.id AS a_id, a.name AS a_name, a.phone AS a_phone, b.id AS b_id, b.name AS b_name, b.phone AS b_phone, ' +
    "  CASE WHEN a.phone_key <> '' AND a.phone_key = b.phone_key THEN 'phone' ELSE 'name' END AS reason, " +
    '  (SELECT count(*) FROM restaurant_guest_orders o WHERE o.guest_id = a.id) + (SELECT count(*) FROM restaurant_orders o WHERE o.guest_id = a.id) AS a_orders, ' +
    '  (SELECT count(*) FROM restaurant_guest_orders o WHERE o.guest_id = b.id) + (SELECT count(*) FROM restaurant_orders o WHERE o.guest_id = b.id) AS b_orders ' +
    'FROM restaurant_guests a JOIN restaurant_guests b ON b.company_id = a.company_id AND a.id < b.id ' +
    "WHERE a.company_id = $1 AND ((a.phone_key <> '' AND a.phone_key = b.phone_key) OR " +
    "  (a.name_key <> '' AND a.name_key = b.name_key AND (a.phone_key = '' OR b.phone_key = ''))) LIMIT 200", [companyId])).rows;
  return rows.map(function (r) {
    return {
      reason: r.reason,
      a: { id: r.a_id, name: r.a_name, phone: r.a_phone, orders: Number(r.a_orders) },
      b: { id: r.b_id, name: r.b_name, phone: r.b_phone, orders: Number(r.b_orders) }
    };
  });
}

async function duplicates(ctx, q) {
  canRead(ctx);
  var co = await company((q || {}).companyId);
  return duplicatePairs(co.id);
}

// One guest kept, the other's orders, sales and open tables moved onto it,
// its number and notes kept, then the other removed.
async function mergeGuests(ctx, p) {
  canManage(ctx);
  p = p || {};
  if (!p.keepId || !p.dropId || p.keepId === p.dropId) fail('invalid', 'Choose the two guests to put together.');
  var both = (await pool.query('SELECT * FROM restaurant_guests WHERE id = ANY($1::uuid[])', [[p.keepId, p.dropId]])).rows;
  var keep = both.find(function (g) { return g.id === p.keepId; });
  var drop = both.find(function (g) { return g.id === p.dropId; });
  if (!keep || !drop) fail('notfound', 'Guest not found.');
  if (keep.company_id !== drop.company_id) fail('invalid', 'Those guests are at different restaurants.');
  var moved = await withTransaction(async function (client) {
    var a = await client.query('UPDATE restaurant_guest_orders SET guest_id = $1 WHERE guest_id = $2', [keep.id, drop.id]);
    var b = await client.query('UPDATE restaurant_orders SET guest_id = $1 WHERE guest_id = $2', [keep.id, drop.id]);
    await client.query('UPDATE restaurant_open_tabs SET guest_id = $1 WHERE guest_id = $2', [keep.id, drop.id]);
    var square = keep.square_customer_id || drop.square_customer_id;
    await client.query('DELETE FROM restaurant_guests WHERE id = $1', [drop.id]);
    var notes = [keep.notes, drop.notes].filter(function (x) { return x && x.trim(); }).join('\n');
    await client.query('UPDATE restaurant_guests SET phone = $2, notes = $3, square_customer_id = $4, updated_at = now() WHERE id = $1',
      [keep.id, keep.phone || drop.phone, notes, square]);
    return a.rowCount + b.rowCount;
  });
  await audit(pool, ctx, 'restaurant.guest.merge', 'restaurant_guest', keep.id, 'Put guest ' + drop.name + ' together with ' + keep.name + ' (' + moved + ' order(s) moved).');
  return getGuest(ctx, keep.id);
}

// ── the order sheet (Bamboo Garden's "BG ORDER RECORD", Star Bar's …) ──
// One row per order: the date, the customer's name, what they ordered, how
// it came in (Phone call, Bolt, WhatsApp), how it was served (Pick-up,
// Dine-in, Delivery), feedback and the phone number. Columns are found by
// their headings. What the sheet did to the feedback is undone: a rating
// typed as 3/5 that the spreadsheet turned into a date (5 March) is read as
// 3 out of 5, and "4 Guests. Table 10 reserved" is the party size and table,
// not feedback. Each row carries a key made from its contents, so the same
// sheet imported again (with new rows on top) adds only the new rows.
var MAX_ROWS = 10000;
var HEADINGS = {
  date: /^(month\s*\/?\s*date|date|order date|day)$/,
  name: /^(customer name|customer|name|guest|guest name|client|client name|customer's name)$/,
  items: /^(order details|order|orders|items|item|what was ordered|food|order items|food and drinks|food & drinks|details)$/,
  channel: /^(mode of communication|channel|communication|source|order channel|how)$/,
  service: /^(mode of delivery|delivery|service|order type|type|mode|dine in or takeaway)$/,
  feedback: /^(feedback|comment|comments|remarks|review)$/,
  phone: /^(phone number|phone|contact|telephone|mobile|number|contact number|tel)$/,
  amount: /^(amount|total|price|value|amount ghs|total ghs)$/
};

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if (Array.isArray(v.richText)) return v.richText.map(function (t) { return t.text; }).join('');
    if ('text' in v) return String(v.text);
    return null;
  }
  return v;
}
function cellText(v) { v = cellValue(v); return v === null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim(); }
function sheetDate(v) {
  v = cellValue(v);
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  var s = String(v || '').trim();
  var m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return validDate(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s))) return validDate(+m[3], +m[2], +m[1]);
  return null;
}
function validDate(y, mo, d) {
  var dt = new Date(Date.UTC(y, mo - 1, d));
  return y > 2000 && dt.getUTCMonth() === mo - 1 ? dt.toISOString().slice(0, 10) : null;
}
function channelOf(s) {
  s = String(s || '').toLowerCase();
  if (/whats/.test(s)) return 'whatsapp';
  if (/bolt/.test(s)) return 'bolt';
  if (/phone|call|tel/.test(s)) return 'phone';
  if (/walk/.test(s)) return 'walk_in';
  if (/insta|\big\b/.test(s)) return 'instagram';
  if (/face|\bfb\b|messenger/.test(s)) return 'facebook';
  if (/web|online|site/.test(s)) return 'website';
  return 'other';
}
function serviceOf(s) {
  s = String(s || '').toLowerCase();
  if (/reserv|book/.test(s)) return 'reservation';
  if (/dine|eat ?in|sit/.test(s)) return 'dine_in';
  if (/deliver|rider|bolt/.test(s)) return 'delivery';
  if (/pick|take ?away|collect/.test(s)) return 'pickup';
  return null;
}
// The feedback cell: a rating (3/5, or a date the sheet made of it), the
// party size and table of a reservation, and what the guest said.
function feedbackCell(v) {
  var out = { rating: null, partySize: null, tableNote: '', feedback: '', reserved: false, ratingFromDate: false };
  v = cellValue(v);
  if (v instanceof Date) {
    if (v.getUTCDate() === 5 && v.getUTCMonth() <= 4) { out.rating = v.getUTCMonth() + 1; out.ratingFromDate = true; }
    return out;
  }
  if (typeof v === 'number') { if (v >= 1 && v <= 5 && Number.isInteger(v)) out.rating = v; return out; }
  var s = String(v || '').trim();
  if (!s) return out;
  var m = /\b([1-5])\s*\/\s*5\b/.exec(s) || /\b([1-5])\s*(stars?|out of 5)\b/i.exec(s);
  if (m) { out.rating = +m[1]; s = s.replace(m[0], ' '); }
  if ((m = /\b(\d{1,3})\s*(guests?|people|persons?|pax)\b/i.exec(s))) { out.partySize = +m[1]; s = s.replace(m[0], ' '); }
  if ((m = /\btable\s*(no\.?\s*)?([a-z0-9-]{1,6})\b/i.exec(s))) { out.tableNote = 'Table ' + m[2]; s = s.replace(m[0], ' '); }
  if (/\breserv(ed|ation)?\b|\bbooked\b/i.test(s)) { out.reserved = true; s = s.replace(/\breserv(ed|ation)?\b|\bbooked\b/ig, ' '); }
  out.feedback = s.replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, '').replace(/\s{2,}/g, ' ');
  if (out.feedback && !/[a-z]{2}/i.test(out.feedback)) out.feedback = '';
  return out;
}
function sheetPhone(v) {
  var s = cellText(v);
  if (!/\d/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  return /^\d{9}$/.test(s) ? '0' + s : s;
}

async function readSheet(file) {
  if (!file || !file.buffer) fail('invalid', 'Choose the order sheet (.xlsx).');
  var ExcelJS = require('exceljs');
  var wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(file.buffer); } catch (e) { fail('invalid', 'That file could not be read as an Excel workbook (.xlsx).'); }
  var found = null;
  wb.eachSheet(function (ws) {
    if (found) return;
    for (var r = 1; r <= Math.min(ws.rowCount, 10) && !found; r++) {
      var cols = {};
      ws.getRow(r).eachCell(function (cell, c) {
        var h = cellText(cell.value).toLowerCase().replace(/\s+/g, ' ').trim();
        Object.keys(HEADINGS).forEach(function (k) { if (!cols[k] && HEADINGS[k].test(h)) cols[k] = c; });
      });
      if (cols.date && cols.name && cols.items) found = { ws: ws, headerRow: r, cols: cols };
    }
  });
  if (!found) fail('invalid', 'No tab with the columns date, customer name and order details was found. Use the sheet where customer service records the orders, one row per order (like BG ORDER RECORD).');
  var rows = [];
  var skipped = [];
  var seen = {};
  for (var r = found.headerRow + 1; r <= found.ws.rowCount && rows.length < MAX_ROWS; r++) {
    var row = found.ws.getRow(r);
    var get = function (k) { return found.cols[k] ? row.getCell(found.cols[k]).value : null; };
    var name = cellText(get('name'));
    var items = cellText(get('items'));
    var dateCell = get('date');
    if (!name && !items && !cellText(dateCell)) continue;
    var day = sheetDate(dateCell);
    if (!day) { skipped.push({ row: r, reason: 'no date' }); continue; }
    if (day > todayISO()) { skipped.push({ row: r, reason: 'date in the future' }); continue; }
    if (!name && !sheetPhone(get('phone'))) { skipped.push({ row: r, reason: 'no customer name' }); continue; }
    var fb = feedbackCell(get('feedback'));
    var service = serviceOf(cellText(get('service')));
    if (/^reserv/i.test(items) || fb.reserved) { service = 'reservation'; if (/^reserv\w*\.?$/i.test(items)) items = ''; }
    var amount = cellValue(get('amount'));
    amount = typeof amount === 'number' ? amount : amount ? Number(String(amount).replace(/[^\d.]/g, '')) || null : null;
    var o = {
      row: r, day: day, name: name, phone: sheetPhone(get('phone')), items: items, channel: channelOf(cellText(get('channel'))),
      service: service || 'pickup', serviceGuessed: !service, amount: amount, rating: fb.rating, ratingFromDate: fb.ratingFromDate,
      partySize: fb.partySize, tableNote: fb.tableNote, feedback: fb.feedback
    };
    var base = [day, nameKey(name), dishKey(items), o.channel, o.service].join('|');
    seen[base] = (seen[base] || 0) + 1;
    o.key = 'sheet:' + crypto.createHash('sha1').update(base + '#' + seen[base]).digest('hex').slice(0, 24);
    rows.push(o);
  }
  return { sheet: found.ws.name, rows: rows, skipped: skipped };
}

// Who each row is: rows with the same number are one guest; rows with the
// same name and no number go with that name's guest.
function sheetGuests(rows) {
  var byKey = {};
  var nameToKey = {};
  rows.forEach(function (o) {
    var pk = phoneKey(o.phone);
    var nk = nameKey(o.name);
    var k = pk ? 'p:' + pk : null;
    if (!k && nk && nameToKey[nk]) k = nameToKey[nk];
    if (!k) k = 'n:' + (nk || o.name);
    if (pk && nk && !nameToKey[nk]) nameToKey[nk] = k;
    if (!byKey[k]) byKey[k] = { name: o.name, phone: o.phone, rows: [] };
    if (!byKey[k].phone && o.phone) byKey[k].phone = o.phone;
    byKey[k].rows.push(o);
    o.guestKey = k;
  });
  // A name seen first without a number, later with one: one guest.
  rows.forEach(function (o) {
    var nk = nameKey(o.name);
    var from = o.guestKey;
    var to = nameToKey[nk];
    if (from.indexOf('n:') === 0 && to && byKey[from]) {
      byKey[to].rows = byKey[to].rows.concat(byKey[from].rows);
      byKey[from].rows.forEach(function (x) { x.guestKey = to; });
      delete byKey[from];
    }
  });
  return byKey;
}

async function importPreview(ctx, companyId, file) {
  canManage(ctx);
  var co = await company(companyId);
  var sheet = await readSheet(file);
  var keys = sheet.rows.map(function (o) { return o.key; });
  var have = {};
  if (keys.length) (await pool.query('SELECT external_key FROM restaurant_guest_orders WHERE company_id = $1 AND external_key = ANY($2)', [co.id, keys])).rows.forEach(function (r) { have[r.external_key] = true; });
  var fresh = sheet.rows.filter(function (o) { return !have[o.key]; });
  var guests = sheetGuests(sheet.rows);
  var known = 0;
  for (var k of Object.keys(guests)) {
    var g = guests[k];
    var pk = phoneKey(g.phone);
    var hit = pk ? (await pool.query('SELECT 1 FROM restaurant_guests WHERE company_id = $1 AND phone_key = $2 LIMIT 1', [co.id, pk])).rows[0] : null;
    if (!hit && nameKey(g.name)) hit = (await pool.query('SELECT 1 FROM restaurant_guests WHERE company_id = $1 AND name_key = $2 LIMIT 1', [co.id, nameKey(g.name)])).rows[0];
    if (hit) known++;
  }
  var days = sheet.rows.map(function (o) { return o.day; }).sort();
  var repeat = Object.keys(guests).filter(function (k) { return guests[k].rows.length >= 2; }).length;
  return {
    company: co, sheet: sheet.sheet, rows: sheet.rows.length, newOrders: fresh.length, alreadyImported: sheet.rows.length - fresh.length,
    from: days[0] || null, to: days[days.length - 1] || null,
    guests: Object.keys(guests).length, knownGuests: known, newGuests: Object.keys(guests).length - known, repeatGuests: repeat,
    withPhone: Object.keys(guests).filter(function (k) { return guests[k].phone; }).length,
    channels: count(sheet.rows, function (o) { return o.channel; }),
    services: count(sheet.rows, function (o) { return o.service; }),
    ratings: sheet.rows.filter(function (o) { return o.rating; }).length,
    ratingsFromDates: sheet.rows.filter(function (o) { return o.ratingFromDate; }).length,
    reservations: sheet.rows.filter(function (o) { return o.service === 'reservation'; }).length,
    partySizes: sheet.rows.filter(function (o) { return o.partySize; }).length,
    feedback: sheet.rows.filter(function (o) { return o.feedback; }).length,
    complaints: sheet.rows.filter(function (o) { return feedbackOf(o.feedback, o.rating).complaint; }).length,
    serviceGuessed: sheet.rows.filter(function (o) { return o.serviceGuessed; }).length,
    skipped: sheet.skipped.slice(0, 20), skippedCount: sheet.skipped.length,
    sample: sheet.rows.slice(0, 8).map(function (o) {
      return { row: o.row, day: o.day, name: o.name, phone: o.phone, items: o.items, channel: o.channel, service: o.service, rating: o.rating, partySize: o.partySize, tableNote: o.tableNote, feedback: o.feedback, already: !!have[o.key] };
    })
  };
}

async function importRun(ctx, companyId, file) {
  canManage(ctx);
  var co = await company(companyId);
  var sheet = await readSheet(file);
  var guests = sheetGuests(sheet.rows);
  var today = todayISO();
  var result = await withTransaction(async function (client) {
    var added = 0, already = 0, newGuests = 0, opened = 0;
    var guestId = {};
    for (var k of Object.keys(guests)) {
      var g = await findOrCreateGuest(client, co.id, guests[k], 'import');
      guestId[k] = g.id;
      if (g.created) newGuests++;
    }
    for (var o of sheet.rows) {
      var fb = feedbackOf(o.feedback, o.rating);
      var open = fb.complaint && daysBetween(o.day, today) <= OPEN_IMPORTED_DAYS;
      var r = await client.query(
        'INSERT INTO restaurant_guest_orders (company_id, guest_id, ordered_on, channel, service, items, amount, party_size, table_note, feedback, rating, follow_up, external_key, created_by) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (company_id, external_key) DO NOTHING',
        [co.id, guestId[o.guestKey] || null, o.day, o.channel, o.service, o.items, o.amount, o.partySize, o.tableNote, o.feedback, o.rating,
          open ? 'open' : 'none', o.key, ctx.employee ? ctx.employee.id : null]);
      if (r.rowCount) { added++; if (open) opened++; } else already++;
    }
    return { added: added, already: already, newGuests: newGuests, openFollowUps: opened };
  });
  result.linkedToTill = await autoLink(co.id, {});
  result.skipped = sheet.skipped.length;
  await audit(pool, ctx, 'restaurant.guest_order.import', 'company', co.id,
    'Imported the order sheet for ' + co.name + ': ' + result.added + ' order(s) added, ' + result.already + ' already there, ' + result.newGuests + ' new guest(s), ' + result.linkedToTill + ' linked to the till.');
  return result;
}

module.exports = {
  overview: overview, listOrders: listOrders, createOrder: createOrder, updateOrder: updateOrder, deleteOrder: deleteOrder,
  setFollowUp: setFollowUp, tillCandidates: tillCandidates, linkTill: linkTill, autoLink: autoLink,
  listGuests: listGuests, getGuest: getGuest, duplicates: duplicates, mergeGuests: mergeGuests,
  importPreview: importPreview, importRun: importRun, findOrCreateGuest: findOrCreateGuest,
  // pure helpers, for tests
  phoneKey: phoneKey, nameKey: nameKey, feedbackOf: feedbackOf, dishesOf: dishesOf, feedbackCell: feedbackCell,
  CHANNELS: CHANNELS, SERVICES: SERVICES
};
