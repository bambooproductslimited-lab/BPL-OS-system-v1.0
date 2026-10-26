var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var config = require('../config');
var { internationalNumber } = require('../utils/phone');
var access = require('./restaurantTillAccess.service');
var times = require('./restaurantTillTimes.service');
var promos = require('./restaurantPromos.service');
var activity = require('./restaurantActivity.service');
var kitchen = require('./restaurantKitchen.service');
var tillMenu = require('./restaurantTillMenu.service');
var restaurantService = require('./restaurant.service');
var delivery = require('./restaurantDelivery.service');
var marketing = require('./marketingChannels');

// Ordering on the restaurant's website (online.starbartema.com, migration
// 0159). Anyone sees the menu and places an order — delivered to a pin on
// the map, or picked up — paid on delivery or at pickup, in cash or by
// Mobile Money. It waits on the delivery screen for the restaurant to
// accept it (it becomes an open order on the till, sent to the kitchen
// like any other) or turn it down with a reason. The customer follows it
// on a link of their own (track): accepted, cooking, ready, the rider on
// the map, delivered. No sign-in: the order's link is its key.
//
// Or for later (migration 0164): the customer picks a day and a time from
// those on offer (delivery settings 'later'), even while the restaurant is
// not taking orders now. Confirmed, it waits — the customer may still
// cancel it — until the time to start cooking for it (start_at), and only
// then becomes the open order on the till (release: jobs/onlineScheduled.js,
// the delivery screen, or Start now).
//
//   pending → accepted → done (paid at the till)      or rejected / cancelled

var MAX_LINES = 40;
var MAX_QTY = 50;
var MAX_PENDING_PER_PHONE = 3;
// Orders placed from one address, at most, in an hour (a backstop against
// someone filling the screen with fake orders).
var PER_IP_HOUR = 8;
var placedBy = new Map();
// Orders for later: the times on offer are this many minutes apart; one is
// on offer if there is time to cook it (readyMinutes), ride it over
// (RIDE_MINUTES, the distance not known yet) and LEAD_SPARE to spare. The
// kitchen starts on it its cooking time and the ride (by its distance)
// before, and START_SPARE more.
var STEP = 15, RIDE_MINUTES = 20, LEAD_SPARE = 15, START_SPARE = 5;

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function cleanText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
// A dish's add-ons as a customer's phone sends them (restaurantTillCheck
// pickMods checks them against the menu): [{ id, how }].
function modsFrom(list) {
  return (Array.isArray(list) ? list.slice(0, 30) : []).map(function (m) { return { id: String((m && m.id) || ''), how: m && ['no', 'extra', 'side'].indexOf(m.how) >= 0 ? m.how : undefined }; });
}
function hash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function pos() { return require('./restaurantPos.service'); }
function accounts() { return require('./restaurantCustomerAccounts.service'); }
function paystack() { return require('./restaurantPaystack.service'); }
// Paid online when ordering (migration 0192): an order waits, unpaid, this
// long for its payment, then is cancelled.
var UNPAID_MINUTES = 30;
function ref(n) { return 'W-' + String(n).padStart(4, '0'); }
function fullPhotoUrl(id, key) { var u = restaurantService.menuThumbUrl(id, key); return u ? u.replace('?size=thumb&', '?') : null; }

// ── times (Ghana keeps GMT all year: the restaurant's clock is UTC) ──

function pad2(n) { return String(n).padStart(2, '0'); }
function minutesOf(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
function clock(m) { return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }
function dayOf(d) { return d.toISOString().slice(0, 10); }
function hhmmOf(d) { return new Date(d).toISOString().slice(11, 16); }
// 'Sat 24 Oct, 18:30'
function whenText(d) {
  d = new Date(d);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) + ', ' + hhmmOf(d);
}
// The first time on a day (YYYY-MM-DD) on offer, lead minutes from now at
// the soonest, or null.
function firstSlot(l, date, now, lead) {
  var dayStart = Date.parse(date + 'T00:00:00Z'), earliest = now.getTime() + lead * 60000;
  var last = Math.floor(minutesOf(l.to) / STEP) * STEP;
  for (var m = Math.ceil(minutesOf(l.from) / STEP) * STEP; m <= last; m += STEP) {
    if (dayStart + m * 60000 >= earliest) return clock(m);
  }
  return null;
}
// The times a customer may order for: { on, step, days: [{ date, to,
// from: { delivery, pickup } }] } — each day's first time for delivery and
// for pickup (null if not offered), and its last; days with none left are
// not there.
function laterOut(s, now) {
  var l = s.later;
  if (!l.on || !(s.open || l.whenClosed)) return { on: false, step: STEP, days: [] };
  var days = [];
  for (var i = 0; i <= l.days; i++) {
    var date = dayOf(new Date(now.getTime() + i * 86400000)), from = {};
    ['delivery', 'pickup'].forEach(function (f) { from[f] = s[f] ? firstSlot(l, date, now, s.readyMinutes + (f === 'delivery' ? RIDE_MINUTES : 0) + LEAD_SPARE) : null; });
    if (from.delivery || from.pickup) days.push({ date: date, from: from, to: clock(Math.floor(minutesOf(l.to) / STEP) * STEP) });
  }
  return { on: days.length > 0, step: STEP, days: days };
}
// The time a customer chose (an ISO time), if it is one on offer: a Date.
function whenOf(co, value, fulfillment, now) {
  var d = new Date(String(value));
  if (isNaN(d.getTime())) fail('invalid', 'Choose a day and a time for your order.');
  var l = laterOut(co.settings, now);
  if (!l.on) fail('conflict', co.name + ' is not taking orders for later right now.');
  var day = l.days.find(function (x) { return x.date === dayOf(d); });
  var first = day && day.from[fulfillment];
  var m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (first && m < minutesOf(first) && d.getTime() > now.getTime()) fail('invalid', 'That time is too soon now: the earliest is ' + first + '.');
  if (!first || d.getUTCSeconds() || d.getUTCMilliseconds() || m % STEP || m > minutesOf(day.to) || m < minutesOf(first)) fail('invalid', 'That time is not on offer: choose another one.');
  return d;
}
// When the kitchen starts on an order for later: its cooking time and, for
// a delivery, the ride before the time chosen, and a few minutes to spare.
function startOf(o, readyMinutes) {
  var ride = o.fulfillment === 'delivery' ? (delivery.travelMinutes(o.distance_km == null ? null : Number(o.distance_km), 'motorbike') || RIDE_MINUTES) : 0;
  return new Date(new Date(o.scheduled_for).getTime() - (readyMinutes + ride + START_SPARE) * 60000);
}

// ── order limits (migration 0193) ──
// Each website order counts in the 15 minutes it is due in: as soon as it
// can be, when it will be ready; for later, the time chosen. A slot is full
// at the restaurant's limit of orders, or of dishes (a first order bigger
// than that still fits an empty slot). Full times are not offered.
var SLOT_MS = STEP * 60000;
function slotOf(d) { return new Date(Math.floor(new Date(d).getTime() / SLOT_MS) * SLOT_MS); }
function dueOf(s, scheduledFor, now) { return scheduledFor ? new Date(scheduledFor) : new Date(now.getTime() + s.readyMinutes * 60000); }
// How full each slot is from `from` to `to`: Map(slot time → { orders, dishes }).
async function slotLoad(db, companyId, from, to) {
  var rows = (await db.query(
    "SELECT slot_at, count(*)::int AS orders, coalesce(sum(dish_count), 0)::int AS dishes FROM restaurant_online_orders " +
    "WHERE company_id = $1 AND slot_at >= $2 AND slot_at < $3 AND status NOT IN ('rejected', 'cancelled') GROUP BY slot_at", [companyId, from, to])).rows;
  var m = new Map();
  rows.forEach(function (r) { m.set(new Date(r.slot_at).getTime(), { orders: r.orders, dishes: r.dishes }); });
  return m;
}
function hasRoom(lim, load, dishes) {
  if (!load) return true;
  if (load.orders >= lim.orders) return false;
  return !(lim.dishes > 0 && load.dishes > 0 && load.dishes + (dishes || 1) > lim.dishes);
}
// The first time on offer for later with room (from `after` on, if given), or null.
function nextFree(s, load, dishes, fulfillment, now, after) {
  var l = laterOut(s, now);
  for (var i = 0; i < l.days.length; i++) {
    var day = l.days[i], first = day.from[fulfillment];
    if (!first) continue;
    for (var m = minutesOf(first); m <= minutesOf(day.to); m += STEP) {
      var at = new Date(day.date + 'T' + clock(m) + ':00Z');
      if (after && at <= after) continue;
      if (hasRoom(s.limits, load.get(slotOf(at).getTime()), dishes)) return at;
    }
  }
  return null;
}
// For the website: whether limits are on, whether "as soon as it can be"
// is full now, the times full for later ({ date: ['18:30'] }), and the
// first time with room for each way.
async function limitsOut(co, now) {
  var s = co.settings, lim = s.limits;
  if (!lim || !lim.on) return { on: false };
  var load = await slotLoad(pool, co.id, slotOf(now), new Date(now.getTime() + (s.later.days + 2) * 86400000));
  var full = {};
  laterOut(s, now).days.forEach(function (day) {
    var first = [day.from.delivery, day.from.pickup].filter(Boolean).sort()[0];
    for (var m = minutesOf(first); m <= minutesOf(day.to); m += STEP) {
      var at = new Date(day.date + 'T' + clock(m) + ':00Z');
      if (!hasRoom(lim, load.get(slotOf(at).getTime()), 1)) (full[day.date] = full[day.date] || []).push(clock(m));
    }
  });
  var nowFull = !hasRoom(lim, load.get(slotOf(dueOf(s, null, now)).getTime()), 1);
  var next = {};
  ['delivery', 'pickup'].forEach(function (f) { var at = s[f] ? nextFree(s, load, 1, f, now) : null; next[f] = at ? at.toISOString() : null; });
  return { on: true, nowFull: nowFull, full: full, next: next };
}

// The codes a restaurant may go by. Company codes are set by hand (Star Bar
// Restaurant is 'SB' on the live system, 'SBR' in the demo data), so the
// website's code stands for all of the restaurant's — the same aliases the
// marketing tracker knows (marketingChannels TRACKED) — and its name.
function aliasesOf(code) {
  var want = String(code || '').trim().toUpperCase().slice(0, 12);
  var t = marketing.TRACKED.find(function (x) { return x.codes.indexOf(want) >= 0; });
  return { codes: [want].concat(t ? t.codes.filter(function (c) { return c !== want; }) : []), name: t && t.name ? t.name.source : null };
}
// Where a restaurant's own website is (kind 'online', or 'delivery' for
// its delivery screen): its own address (config restaurantSiteUrl:
// Bamboo Garden on bamboogarden.biz), else the shared one.
function siteUrlFor(code, kind) {
  var own = config.restaurantSiteUrl(kind || 'online', aliasesOf(code).codes);
  if (own) return own;
  return kind === 'delivery' ? config.deliverySiteUrl : config.onlineSiteUrl;
}
// The restaurant by its code, if it takes orders on the website at all
// (it has delivery settings): of the companies it may be, the one that does,
// the code asked for first.
async function shopOf(code) {
  var a = aliasesOf(code);
  var rows = (await pool.query(
    'SELECT c.id, c.code, c.name, (s.company_id IS NOT NULL) AS takes FROM companies c LEFT JOIN restaurant_delivery_settings s ON s.company_id = c.id ' +
    'WHERE c.code = ANY($1::text[])' + (a.name ? ' OR c.name ~* $2' : ''), a.name ? [a.codes, a.name] : [a.codes])).rows;
  var rank = function (r) { var i = a.codes.indexOf(r.code); return i < 0 ? a.codes.length : i; };
  var co = rows.filter(function (r) { return r.takes; }).sort(function (x, y) { return rank(x) - rank(y); })[0];
  if (!co) fail('notfound', 'This restaurant does not take orders online.');
  co = { id: co.id, code: co.code, name: co.name };
  co.settings = await delivery.liveSettingsOf(co.id);
  // Paying online when ordering: on in the website's settings, and Paystack on for the restaurant.
  co.payOnline = !!co.settings.payOnline && paystack().onFor(await access.settingsOf(co.id));
  return co;
}
function shopOut(co) {
  var s = co.settings;
  return {
    code: co.code, name: co.name, open: s.open, delivery: s.delivery, pickup: s.pickup, phone: s.phone, note: s.note,
    location: s.location, fee: s.fee, maxKm: s.maxKm, minOrder: s.minOrder, readyMinutes: s.readyMinutes, payMethods: co.payOnline ? ['online', 'cash', 'mobile_money'] : ['cash', 'mobile_money'],
    later: laterOut(s, new Date()), busy: s.busy ? { mode: s.busy.mode, extraMinutes: s.busy.extraMinutes, until: s.busy.until } : null
  };
}

// The sections of the menu taken off the website (restaurantDelivery onlineMenu).
async function categoriesOff(companyId) {
  return new Set((await pool.query('SELECT category FROM restaurant_online_categories_off WHERE company_id = $1', [companyId])).rows.map(function (r) { return r.category; }));
}

// What a restaurant sells now, for a customer's phone: each dish with its
// photo, sizes, and whether it is sold out; the website's (online) not the
// dishes or the sections taken off it — the table's QR menu
// (restaurantTableOrders) has everything on the till's menu.
async function menuItems(companyId, online) {
  var off = online ? await categoriesOff(companyId) : new Set();
  var rows = (await pool.query('SELECT id, name, category, price, photo_object_key, allergens FROM restaurant_menu_items WHERE company_id = $1 AND active = true' + (online ? ' AND online = true' : '') + ' ORDER BY category, name', [companyId])).rows
    .filter(function (r) { return !off.has(r.category || ''); });
  var vars = rows.length ? (await pool.query('SELECT id, menu_item_id, name, price FROM restaurant_menu_item_variations WHERE menu_item_id = ANY($1::uuid[]) ORDER BY sort_order, created_at',
    [rows.map(function (r) { return r.id; })])).rows : [];
  var items = rows.map(function (r) {
    return {
      id: r.id, name: r.name, category: r.category || '', price: Number(r.price),
      photoUrl: restaurantService.menuThumbUrl(r.id, r.photo_object_key), photoFull: fullPhotoUrl(r.id, r.photo_object_key),
      variations: vars.filter(function (v) { return v.menu_item_id === r.id; }).map(function (v) { return { id: v.id, name: v.name, price: Number(v.price) }; }),
      allergens: r.allergens || []
    };
  });
  // Its menu's hours (served only then: notNow outside them), and a happy
  // hour on it now (restaurantTillTimes).
  var settings = await access.settingsOf(companyId);
  items.forEach(function (i) {
    var h = settings.hours.categories[Object.keys(settings.hours.categories).find(function (k) { return k.toLowerCase() === i.category.toLowerCase(); })];
    if (h) { i.hours = { from: h.from, to: h.to }; if (!times.categoryOpen(settings, i.category)) i.notNow = true; }
    var happy = times.happyFor(settings, i.category);
    if (happy) i.happy = { id: happy.id, name: happy.name, percent: happy.percent, to: happy.to };
  });
  await tillMenu.tileStock(companyId, items);
  items.forEach(function (i) { i.soldOut = !!(i.stock && i.stock.soldOut); delete i.stock; });
  // Each dish's add-ons (restaurantTillCheck), picked on the dish's sheet.
  var groups = await require('./restaurantTillCheck.service').groupsFor(pool, items.map(function (i) { return i.id; }));
  items.forEach(function (i) { i.addOns = groups.get(i.id) || []; });
  // What goes well with each (migration 0193): the manager's picks or the till's own.
  await require('./restaurantSuggestions.service').forMenu(companyId, items);
  var categories = [];
  items.forEach(function (i) { if (categories.indexOf(i.category) < 0) categories.push(i.category); });
  return { categories: categories, items: items };
}

// GET /api/pos/online/:code/menu — the restaurant and what it sells now on
// the website.
async function menu(code) {
  var co = await shopOf(code);
  var m = await menuItems(co.id, true);
  var till = await access.settingsOf(co.id);
  // book: tables booked on the website (restaurantBookings onlineOptions);
  // gift: gift cards sold on it (restaurantGiftCards buyOnline).
  // limits: times full (order limits, migration 0193).
  return { restaurant: Object.assign(shopOut(co), { bill: billRules(till), book: !!till.bookings.online, gift: require('./restaurantGiftCards.service').onlineOptions(till), limits: await limitsOut(co, new Date()) }), categories: m.categories, items: m.items };
}
// The service charge (on the order types it is charged on) and the taxes,
// for a customer's phone to show the same total the restaurant charges
// (restaurantTillCheck compute).
function billRules(settings, channel) {
  // And the deals on there now (restaurantPromos; codes stay hidden).
  return { serviceCharge: settings.serviceCharge, tax: settings.tax, promotions: promos.shown(settings.promotions, channel || 'online') };
}
// A website order's bill: the dishes, the delivery fee, a deal (on by
// itself or with its code), and any service charge and tax added on top;
// { total, charges, adjust } — adjust: the deal, carried to the till.
async function chargesOf(companyId, lines, fee, fulfillment, promoCode) {
  var settings = await access.settingsOf(companyId);
  var all = lines.concat(fee > 0 ? [{ name: pos().FEE_NAME, qty: 1, unitPrice: fee, lineTotal: fee, custom: true, fee: true, modifiers: [] }] : []);
  var b = require('./restaurantTillCheck.service').compute(all, { promoCode: promoCode || undefined }, settings, fulfillment, { can: {}, before: null, channel: 'online' });
  var charges = b.serviceCharge > 0 || b.taxes.length ? { serviceCharge: b.serviceCharge, serviceName: b.serviceName, serviceRate: b.serviceRate, taxes: b.taxes, taxTotal: b.taxTotal } : {};
  if (b.promo) charges.promo = { name: b.promo.name, amount: b.promo.amount };
  return { total: b.total, charges: charges, adjust: b.adjust };
}
// GET /api/pos/online/:code/promo?code= — a promo code's deal, for the
// basket to show what it takes off (the till checks it again).
var codeTries = new Map();
function promoThrottle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (codeTries.get(key) || []).filter(function (t) { return now - t < 600000; });
  if (list.length >= 20) fail('ratelimited', 'Too many codes tried. Wait a few minutes.');
  list.push(now);
  codeTries.set(key, list);
  if (codeTries.size > 5000) codeTries.clear();
}
function promoByCode(settings, code, channel) {
  var c = promos.codeOf(code);
  var p = c && settings.promotions.find(function (x) { return x.code === c; });
  if (!p || !promos.isOpen(p, { channel: channel, code: c })) fail('notfound', 'That promo code is not right, or not on now.');
  return promos.publicOf(p, channel, true);
}
async function promo(code, q, ip) {
  promoThrottle(ip);
  var co = await shopOf(code);
  return { promo: promoByCode(await access.settingsOf(co.id), q && q.code, 'online') };
}

function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (placedBy.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Too many orders from here in the last hour. Call the restaurant instead.');
  list.push(now);
  placedBy.set(key, list);
  if (placedBy.size > 5000) placedBy.clear();
}

// POST /api/pos/online/:code/orders — an order placed: { name, phone,
// fulfillment: delivery|pickup, address, landmark, lat, lng, note,
// payMethod: cash|mobile_money, scheduledFor (for later: an ISO time on
// offer; none, as soon as it can be), items: [{ menuItemId, variationId, qty,
// note }] }. Priced from the menu as it is now, the delivery fee from the
// distance by road (restaurantDelivery quote). Returns its number and the
// link to follow it.
// Signed in (accountToken: restaurantCustomerAccounts), the order is the
// customer's own: in their orders, their name and number as the account
// has them unless typed, and where it went kept for next time when asked
// (saveAddress).
async function place(code, p, ip, accountToken) {
  p = p || {};
  // A field people never see: filled in, it was not a person.
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  var account = await accounts().accountOf(accountToken);
  if (account) p = Object.assign({}, p, { name: p.name || account.name, phone: p.phone || account.phone });
  var co = await shopOf(code);
  var s = co.settings;
  var later = p.scheduledFor != null && p.scheduledFor !== '';
  if (!s.open && !later) {
    fail('conflict', co.name + ' is not taking orders online right now.' + (laterOut(s, new Date()).on ? ' Order for later instead.' : s.phone ? ' Call ' + s.phone + '.' : ''));
  }
  // Paused while the kitchen is full: only orders for later.
  if (s.busy && s.busy.mode === 'paused' && !later) {
    fail('conflict', co.name + ' is very busy and is not taking orders for now: try again after ' + new Date(s.busy.until).toISOString().slice(11, 16) + (laterOut(s, new Date()).on ? ', or order for later.' : '.'));
  }
  var fulfillment = V.oneOf(p.fulfillment || 'delivery', ['delivery', 'pickup'], 'Delivery or pickup');
  if (!s[fulfillment]) fail('invalid', fulfillment === 'delivery' ? co.name + ' is not delivering right now: pick it up instead.' : co.name + ' only delivers.');
  var scheduledFor = later ? whenOf(co, p.scheduledFor, fulfillment, new Date()) : null;
  var name = V.text(cleanText(p.name, 80), 'Your name', 80);
  var phone = cleanText(p.phone, 30);
  if (!internationalNumber(phone)) fail('invalid', 'Give a phone number we can call you on.');
  var address = cleanText(p.address, 200), landmark = cleanText(p.landmark, 200);
  var point = delivery.pointOf(p.lat, p.lng);
  if (fulfillment === 'delivery') {
    if (!point) fail('invalid', 'Show us where to bring it: drop the pin on the map, or use your location.');
    if (!address) fail('invalid', 'Write the address or the area, for the rider.');
  }
  var payMethod = V.oneOf(p.payMethod || 'cash', co.payOnline ? ['online', 'cash', 'mobile_money'] : ['cash', 'mobile_money'], 'How you pay');
  if (!Array.isArray(p.items) || !p.items.length) fail('invalid', 'Your basket is empty.');
  if (p.items.length > MAX_LINES) fail('invalid', 'That is a lot of dishes: call the restaurant for a big order.');
  var items = p.items.map(function (i) {
    var qty = Math.round(Number(i && i.qty));
    if (!(qty >= 1 && qty <= MAX_QTY)) fail('invalid', 'Choose between 1 and ' + MAX_QTY + ' of each dish.');
    return { menuItemId: String(i.menuItemId || ''), variationId: i.variationId || undefined, qty: qty, note: cleanText(i.note, 140), modifiers: modsFrom(i.modifiers), suggested: !!i.suggested };
  });
  var priced = await pos().priceLines(pool, co.id, items, false);
  await tillMenu.checkOrder(pool, co.id, priced.lines, null, null);
  var dishes = items.reduce(function (a, i) { return a + i.qty; }, 0);
  // Served then (breakfast in the morning), and a happy hour on now goes on its dishes.
  var tillSettings = await access.settingsOf(co.id);
  times.checkHours(tillSettings, priced.lines, null, scheduledFor || null);
  times.applyHappy(tillSettings, priced.lines);
  // Not a dish taken off the website since the menu was loaded.
  var off = await categoriesOff(co.id);
  var shown = (await pool.query('SELECT id, name, category, online FROM restaurant_menu_items WHERE id = ANY($1::uuid[])', [priced.lines.map(function (l) { return l.menuItemId; })])).rows;
  shown.forEach(function (m) { if (!m.online || off.has(m.category || '')) fail('invalid', m.name + ' is not on the website right now. Take it out of your basket.'); });
  if (s.minOrder > 0 && priced.subtotal < s.minOrder) fail('invalid', 'The smallest order is ' + s.minOrder.toFixed(2) + ' before delivery.');
  var q = delivery.quote(s, priced.subtotal, point, fulfillment);
  if (!q.deliverable) fail('invalid', 'That is ' + q.distanceKm + ' km away by road: ' + co.name + ' delivers up to ' + s.maxKm + ' km. Pick it up instead?');
  var pending = (await pool.query("SELECT count(*)::int AS n FROM restaurant_online_orders WHERE company_id = $1 AND customer_phone = $2 AND (status = 'pending' OR (status = 'unpaid' AND created_at > now() - make_interval(mins => $3)))", [co.id, phone, UNPAID_MINUTES])).rows[0].n;
  if (pending >= MAX_PENDING_PER_PHONE) fail('conflict', 'You have orders waiting for the restaurant already. Wait for their answer, or call them.');
  throttle(ip);

  var token = crypto.randomBytes(24).toString('base64url');
  var bill = await chargesOf(co.id, priced.lines, q.fee, fulfillment, p.promoCode);
  var saved = await withTransaction(async function (client) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('online:' || $1))", [co.id]);
    // Room in its 15 minutes, when the restaurant limits them.
    var now = new Date(), slot = slotOf(dueOf(s, scheduledFor, now));
    if (s.limits.on) {
      var load = await slotLoad(client, co.id, slot, new Date(slot.getTime() + SLOT_MS));
      if (!hasRoom(s.limits, load.get(slot.getTime()), dishes)) {
        var wide = await slotLoad(client, co.id, slotOf(now), new Date(now.getTime() + (s.later.days + 2) * 86400000));
        var next = nextFree(s, wide, dishes, fulfillment, now, scheduledFor);
        var then = next ? ' The next time with room is ' + whenText(next) + (later ? '.' : ': order for then.') : later ? '' : ' Try again in a few minutes.';
        fail('conflict', (later ? 'That time is full now: choose another one.' : co.name + ' has all the website orders it can make for now.') + then);
      }
    }
    var number = (await client.query('SELECT coalesce(max(number), 0) + 1 AS n FROM restaurant_online_orders WHERE company_id = $1', [co.id])).rows[0].n;
    var lines = priced.lines.map(function (l, i) { return Object.assign({ menuItemId: l.menuItemId, variationId: l.variationId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal, note: items[i].note || '', modifiers: l.modifiers || [] }, l.discount ? { discount: l.discount } : {}, items[i].suggested ? { suggested: true } : {}); });
    var row = (await client.query(
      'INSERT INTO restaurant_online_orders (company_id, number, token_hash, fulfillment, customer_name, customer_phone, address, landmark, lat, lng, note, pay_method, items, subtotal, delivery_fee, total, distance_km, ip, scheduled_for, charges, account_id, adjust, status, slot_at, dish_count) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *',
      [co.id, number, hash(token), fulfillment, name, phone, address, landmark, point ? point.lat : null, point ? point.lng : null, cleanText(p.note, 300), payMethod, JSON.stringify(lines),
        priced.subtotal, q.fee, bill.total, q.distanceKm, String(ip || '').slice(0, 60), scheduledFor, JSON.stringify(bill.charges), account ? account.id : null, JSON.stringify(bill.adjust || {}),
        payMethod === 'online' ? 'unpaid' : 'pending', slot, dishes])).rows[0];
    if (account && p.saveAddress && fulfillment === 'delivery') {
      await client.query('UPDATE restaurant_customer_accounts SET address = $2, landmark = $3, lat = $4, lng = $5, updated_at = now() WHERE id = $1', [account.id, address, landmark, point.lat, point.lng]);
    }
    await activity.log(client, { companyId: co.id, employeeId: null, app: 'online', action: 'online.placed',
      summary: name + ' ordered ' + ref(number) + ' on the website: ' + (fulfillment === 'delivery' ? 'delivery' : 'pickup') + (scheduledFor ? ' for ' + whenText(scheduledFor) : '') + ', ' + bill.total.toFixed(2) + (payMethod === 'online' ? ', to pay online' : '') + '.',
      amount: bill.total, refType: 'online', refId: row.id });
    return row;
  });
  var trackUrl = siteUrlFor(co.code) + '/t/' + token;
  // Paid online: straight on to Paystack's page, back to the order's own.
  var payUrl = null;
  if (payMethod === 'online') {
    try { payUrl = (await paystack().begin(co.id, bill.total, 'online', null, null, trackUrl, { onlineOrderId: saved.id, payer: name })).url; }
    catch (e) {
      await pool.query("UPDATE restaurant_online_orders SET status = 'cancelled', reject_reason = 'Paying online did not start.', updated_at = now() WHERE id = $1", [saved.id]);
      fail('unavailable', 'Paying online is not working just now. Choose to pay on ' + (fulfillment === 'delivery' ? 'delivery' : 'pickup') + ' instead, or try again.');
    }
  }
  return { ref: ref(saved.number), token: token, trackUrl: trackUrl, payUrl: payUrl, order: await trackOut(saved) };
}

// ── paid online (migration 0192) ──

// The latest payment started for an order paid online.
async function paymentOf(orderId) {
  return (await pool.query("SELECT * FROM restaurant_paystack_payments WHERE online_order_id = $1 AND purpose = 'online' ORDER BY (status = 'success') DESC, created_at DESC LIMIT 1", [orderId])).rows[0] || null;
}
// Paid: the order goes to the restaurant (pending), once — from the
// customer back on its page, or Paystack's webhook.
async function settlePaid(row) {
  if (!row || row.status !== 'success' || !row.online_order_id) return null;
  var o = (await pool.query("UPDATE restaurant_online_orders SET status = 'pending', created_at = now(), updated_at = now() WHERE id = $1 AND status = 'unpaid' RETURNING *", [row.online_order_id])).rows[0];
  if (o) {
    await activity.log(pool, { companyId: o.company_id, employeeId: null, app: 'online', action: 'online.paid',
      summary: o.customer_name + ' paid ' + ref(o.number) + ' online: ' + round2(row.amount).toFixed(2) + (row.channel ? ' (' + (row.channel === 'mobile_money' ? 'Mobile Money' : 'card') + ')' : '') + '.',
      amount: round2(row.amount), refType: 'online', refId: o.id });
    return o;
  }
  // Paid after it was cancelled (too late, or by the customer): given back.
  var gone = (await pool.query("SELECT status FROM restaurant_online_orders WHERE id = $1", [row.online_order_id])).rows[0];
  if (gone && (gone.status === 'cancelled' || gone.status === 'rejected')) await paystack().refund(row, 'The order was cancelled before it was paid.');
  return null;
}
// An unpaid order asked about: its payment checked with Paystack.
async function checkPaid(o) {
  if (o.status !== 'unpaid') return o;
  var row = await paymentOf(o.id);
  if (row && row.status === 'pending') row = await paystack().check(row, false);
  if (row && row.status === 'success') await settlePaid(row);
  return (await pool.query('SELECT * FROM restaurant_online_orders WHERE id = $1', [o.id])).rows[0];
}
// POST /api/pos/online/track/:token/pay — try paying again (the first did
// not go through): a new page to pay on.
async function payAgain(raw, account) {
  var o = account ? await byAccount(account, raw) : await byToken(raw);
  o = await checkPaid(o);
  if (o.status !== 'unpaid') fail('conflict', o.status === 'cancelled' ? 'This order was cancelled: order again.' : 'This order is paid already.');
  var co = (await pool.query('SELECT code FROM companies WHERE id = $1', [o.company_id])).rows[0];
  var trackUrl = account ? siteUrlFor(co.code) + '/?r=' + co.code + '&mine=' + o.id : siteUrlFor(co.code) + '/t/' + raw;
  var started = await paystack().begin(o.company_id, round2(o.total), 'online', null, null, trackUrl, { onlineOrderId: o.id, payer: o.customer_name });
  await pool.query("UPDATE restaurant_online_orders SET updated_at = now() WHERE id = $1 AND status = 'unpaid'", [o.id]);
  return { url: started.url };
}
// Orders never paid: cancelled after UNPAID_MINUTES (the job, with orders for later).
async function sweepUnpaid() {
  var rows = (await pool.query("SELECT * FROM restaurant_online_orders WHERE status = 'unpaid' AND updated_at < now() - make_interval(mins => $1) LIMIT 100", [UNPAID_MINUTES])).rows;
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    var o = await checkPaid(rows[i]);
    if (o.status !== 'unpaid') continue;
    var up = await pool.query("UPDATE restaurant_online_orders SET status = 'cancelled', reject_reason = 'Not paid.', updated_at = now() WHERE id = $1 AND status = 'unpaid'", [o.id]);
    if (up.rowCount) n++;
  }
  return n;
}
// Paid online and turned down or cancelled: given back.
async function refundFor(orderId, reason) {
  var row = await paymentOf(orderId);
  if (!row) return null;
  if (row.status === 'pending') row = await paystack().check(row, true);
  return paystack().refund(row, reason);
}
// The till's open order for a paid order: its payment there to take.
async function attachPaid(db, orderId, tabId) {
  await db.query("UPDATE restaurant_paystack_payments SET tab_id = $2 WHERE online_order_id = $1 AND purpose = 'online' AND status = 'success' AND used_by_order IS NULL AND refund_status IS NULL", [orderId, tabId]);
}
// Staff's view of orders, with what was paid online (and given back).
async function withPaid(list) {
  var ids = list.filter(function (o) { return o.payMethod === 'online'; }).map(function (o) { return o.id; });
  if (!ids.length) return list;
  var rows = (await pool.query("SELECT DISTINCT ON (online_order_id) * FROM restaurant_paystack_payments WHERE online_order_id = ANY($1::uuid[]) AND purpose = 'online' ORDER BY online_order_id, (status = 'success') DESC, created_at DESC", [ids])).rows;
  var by = {};
  rows.forEach(function (r) { by[r.online_order_id] = r; });
  return list.map(function (o) {
    var r = by[o.id];
    return r ? Object.assign({}, o, { paid: { status: r.status, amount: round2(r.amount), channel: r.channel || '', refund: r.refund_status ? { status: r.refund_status, note: r.refund_note || '', at: r.refunded_at } : null } }) : o;
  });
}

// ── following an order (the customer's link) ──

async function byToken(raw, lock, client) {
  var o = (await (client || pool).query('SELECT * FROM restaurant_online_orders WHERE token_hash = $1' + (lock ? ' FOR UPDATE' : ''), [hash(String(raw || ''))])).rows[0];
  if (!o) fail('notfound', 'We cannot find that order. Check the link.');
  return o;
}
// Where an order stands, for its customer: one of waiting, rejected,
// cancelled, scheduled (confirmed for later, not started), preparing, ready
// (pickup: ready_pickup), rider (on the way to the restaurant), on_the_way,
// arrived, delivered, collected, failed.
async function stageOf(o, d) {
  if (o.status === 'unpaid') return 'unpaid';
  if (o.status === 'pending' || o.status === 'rejected' || o.status === 'cancelled') return o.status === 'pending' ? 'waiting' : o.status;
  if (o.status === 'accepted' && !o.tab_id && o.scheduled_for) return 'scheduled';
  if (d) {
    if (d.status === 'assigned') return 'rider';
    if (d.status === 'picked_up') return 'on_the_way';
    if (d.status === 'arrived') return 'arrived';
    if (d.status === 'delivered') return 'delivered';
    if (d.status === 'failed') return 'failed';
  }
  if (o.status === 'done') return o.fulfillment === 'pickup' ? 'collected' : 'delivered';
  var st = o.tab_id ? (await kitchen.statusOf(pool, o.company_id, 'tab_id', [o.tab_id]))[o.tab_id] : null;
  if (st && (st.state === 'ready' || st.state === 'served')) return o.fulfillment === 'pickup' ? 'ready_pickup' : 'ready';
  return 'preparing';
}
async function trackOut(o) {
  var d = o.status === 'accepted' || o.status === 'done' ? await delivery.forOnline(o.id) : null;
  var paidRow = o.pay_method === 'online' ? await paymentOf(o.id) : null;
  var stage = await stageOf(o, d);
  var r = await delivery.restaurantOf(o.company_id);
  return {
    ref: ref(o.number), status: o.status, stage: stage, fulfillment: o.fulfillment,
    customer: { name: o.customer_name, phone: o.customer_phone, address: o.address, landmark: o.landmark, lat: o.lat, lng: o.lng },
    items: o.items, note: o.note, payMethod: o.pay_method, subtotal: round2(o.subtotal), deliveryFee: round2(o.delivery_fee), total: round2(o.total), charges: o.charges || {},
    distanceKm: o.distance_km == null ? null : Number(o.distance_km), readyMinutes: o.ready_minutes, rejectReason: o.reject_reason,
    placedAt: o.created_at, decidedAt: o.decided_at, scheduledFor: o.scheduled_for, canCancel: canCancel(o),
    here: o.here_at ? { at: o.here_at, note: o.here_note || '', broughtAt: o.brought_at || null } : null, canSayHere: canSayHere(o, stage),
    paid: paidRow ? { status: paidRow.status, amount: round2(paidRow.amount), channel: paidRow.channel || '', refund: paidRow.refund_status ? { status: paidRow.refund_status, at: paidRow.refunded_at } : null } : null,
    payBy: o.status === 'unpaid' ? new Date(new Date(o.updated_at).getTime() + UNPAID_MINUTES * 60000).toISOString() : null,
    restaurant: { code: r.code, name: r.name, phone: r.phone, location: r.location },
    delivery: d ? {
      ref: d.ref, status: d.status, rider: { name: d.rider.name, phone: d.rider.phone, vehicle: d.rider.vehicle, plate: d.rider.plate },
      riderAt: d.riderAt, trail: d.trail, route: d.route, etaMinutes: d.etaMinutes, distanceKm: d.distanceKm, createdAt: d.createdAt, pickedUpAt: d.pickedUpAt, arrivedAt: d.arrivedAt, endedAt: d.endedAt,
      toCollect: d.toCollect, collectMethod: d.collectMethod, note: d.status === 'failed' ? d.note : ''
    } : null
  };
}
// GET /api/pos/online/track/:token
async function track(raw) { return trackOut(await checkPaid(await byToken(raw))); }

// ── curbside pickup (migration 0191) ──
// A pickup customer outside says so on their order's page, with a word
// about their car; the till sees them (curbside) and brings it out.
function canSayHere(o, stage) {
  return o.fulfillment === 'pickup' && o.status === 'accepted' && !o.brought_at && stage !== 'scheduled';
}
// POST /api/pos/online/track/:token/here { note }, or by a signed-in
// customer (account: their token, raw: the order's id).
async function here(raw, p, account) {
  var o = account ? await byAccount(account, raw) : await byToken(raw);
  var d = null;
  if (!canSayHere(o, await stageOf(o, d))) fail('conflict', o.fulfillment !== 'pickup' ? 'This order is delivered to you.' : o.brought_at || o.status === 'done' ? 'Your order was brought out already.' : 'Your order is not on its way yet.');
  var note = cleanText((p || {}).note, 120);
  var first = !o.here_at;
  await pool.query('UPDATE restaurant_online_orders SET here_at = coalesce(here_at, now()), here_note = $2, updated_at = now() WHERE id = $1', [o.id, note]);
  if (first) {
    await activity.log(pool, { companyId: o.company_id, employeeId: null, app: 'online', action: 'online.here',
      summary: o.customer_name + ' is outside for ' + ref(o.number) + (note ? ' (' + note + ')' : '') + '.', refType: 'online', refId: o.id });
  }
  return trackOut(await byToken(raw));
}
// GET /api/pos/curbside — who is outside now, waiting longest first, with
// whether the kitchen has their order ready.
async function curbside(token) {
  var session = await access.need(token, ['charge', 'delivery']);
  var rows = (await pool.query(
    "SELECT * FROM restaurant_online_orders WHERE company_id = $1 AND here_at IS NOT NULL AND brought_at IS NULL AND status IN ('accepted', 'done') AND here_at > now() - interval '6 hours' ORDER BY here_at",
    [session.posCompanyId])).rows;
  var states = rows.length ? await kitchen.statusOf(pool, session.posCompanyId, 'tab_id', rows.filter(function (o) { return o.tab_id; }).map(function (o) { return o.tab_id; })) : {};
  return { outside: rows.map(function (o) {
    var st = o.tab_id ? states[o.tab_id] : null;
    return { id: o.id, ref: ref(o.number), name: o.customer_name, phone: o.customer_phone, note: o.here_note || '', hereAt: o.here_at, total: round2(o.total), payMethod: o.pay_method,
      waitedMinutes: Math.max(0, Math.round((Date.now() - new Date(o.here_at).getTime()) / 60000)), ready: !!(st && (st.state === 'ready' || st.state === 'served')) };
  }) };
}
// POST /api/pos/curbside/:id/brought — it is in their hands.
async function brought(token, id) {
  var session = await access.need(token, ['charge', 'delivery']);
  var o = (await pool.query("UPDATE restaurant_online_orders SET brought_at = now(), brought_by = $3, updated_at = now() WHERE id = $1 AND company_id = $2 AND here_at IS NOT NULL AND brought_at IS NULL RETURNING *",
    [id, session.posCompanyId, session.posEmployeeId])).rows[0];
  if (!o) fail('conflict', 'That order was brought out already.');
  await activity.log(pool, { companyId: o.company_id, employeeId: session.posEmployeeId, app: 'till', action: 'online.brought',
    summary: ref(o.number) + ' brought out to ' + o.customer_name + ' after ' + Math.max(0, Math.round((new Date(o.brought_at) - new Date(o.here_at)) / 60000)) + ' min.', refType: 'online', refId: o.id });
  return curbside(token);
}
// An order of a signed-in customer's own, by its id (their orders, on any phone).
async function byAccount(accountToken, id, lock, client) {
  var a = await accounts().need(accountToken);
  var o = /^[0-9a-f-]{36}$/i.test(String(id || '')) ? (await (client || pool).query('SELECT * FROM restaurant_online_orders WHERE id = $1 AND account_id = $2' + (lock ? ' FOR UPDATE' : ''), [id, a.id])).rows[0] : null;
  if (!o) fail('notfound', 'We cannot find that order in your account.');
  return o;
}
// GET /api/pos/online/account/orders/:id
async function trackMine(accountToken, id) { return trackOut(await checkPaid(await byAccount(accountToken, id))); }
// Whether the customer may still cancel: while it waits for the restaurant,
// or, for later, until the kitchen starts on it.
function canCancel(o) { return o.status === 'unpaid' || o.status === 'pending' || (o.status === 'accepted' && !o.tab_id && !!o.scheduled_for); }
// POST /api/pos/online/track/:token/cancel, or by a signed-in customer
// (account: their token, raw: the order's id).
async function cancel(raw, account) {
  var o = await withTransaction(async function (client) {
    var row = account ? await byAccount(account, raw, true, client) : await byToken(raw, true, client);
    if (!canCancel(row)) fail('conflict', row.status === 'accepted' ? 'The restaurant has started on your order already: call them to change it.' : 'This order is not waiting any more.');
    var up = (await client.query("UPDATE restaurant_online_orders SET status = 'cancelled', reject_reason = 'Cancelled by the customer.', updated_at = now() WHERE id = $1 RETURNING *", [row.id])).rows[0];
    await activity.log(client, { companyId: row.company_id, app: 'online', action: 'online.cancelled',
      summary: row.customer_name + ' cancelled ' + ref(row.number) + (row.status === 'unpaid' ? ' before paying.' : row.status === 'pending' ? ' before it was accepted.' : ' (for ' + whenText(row.scheduled_for) + ') before the kitchen started on it.'), refType: 'online', refId: row.id });
    return up;
  });
  if (o.pay_method === 'online') await refundFor(o.id, 'Cancelled by the customer.');
  return trackOut(o);
}

// ── the restaurant's answer (the delivery screen) ──

function staffOut(o) {
  return {
    id: o.id, ref: ref(o.number), status: o.status, fulfillment: o.fulfillment,
    customer: { name: o.customer_name, phone: o.customer_phone, address: o.address, landmark: o.landmark, lat: o.lat, lng: o.lng },
    items: o.items, note: o.note, payMethod: o.pay_method, subtotal: round2(o.subtotal), deliveryFee: round2(o.delivery_fee), total: round2(o.total),
    distanceKm: o.distance_km == null ? null : Number(o.distance_km), rejectReason: o.reject_reason, readyMinutes: o.ready_minutes,
    scheduledFor: o.scheduled_for, startAt: o.start_at, startError: o.release_error,
    placedAt: o.created_at, decidedAt: o.decided_at, waitingMinutes: Math.max(0, Math.floor((Date.now() - new Date(o.created_at).getTime()) / 60000))
  };
}
// The open order on the till for a website order, sent to the kitchen: its
// dishes at today's prices, the delivery fee a line of its own.
function openTab(session, o) {
  var items = o.items.map(function (l) { return Object.assign({ menuItemId: l.menuItemId, variationId: l.variationId || undefined, qty: l.qty, note: l.note || '', modifiers: modsFrom(l.modifiers) }, l.discount ? { discount: l.discount } : {}); });
  if (Number(o.delivery_fee) > 0) items.push({ custom: { name: pos().FEE_NAME, price: Number(o.delivery_fee), fee: true }, qty: 1 });
  return pos().saveTabFor(session, {
    adjust: o.adjust || {}, placed: { adjust: o.adjust || {} },
    label: ref(o.number) + ' ' + o.customer_name, fulfillment: o.fulfillment, customerName: o.customer_name, customerPhone: o.customer_phone,
    deliveryAddress: o.fulfillment === 'delivery' ? (o.address + (o.landmark ? ' · ' + o.landmark : '')) : '',
    items: items, kitchenNote: [ref(o.number) + ' (website)', o.scheduled_for ? 'for ' + hhmmOf(o.scheduled_for) : '', o.note].filter(Boolean).join(' · ')
  });
}
function tabOut(tab) { return tab ? { id: tab.id, total: tab.total, kitchenTicket: tab.kitchenTicket || null } : null; }

// POST /api/pos/delivery/online/:id/accept { readyMinutes } — it becomes an
// open order on the till, sent to the kitchen. One for later is confirmed
// for its time and waits until its time to cook (start_at), unless that has
// come already.
async function accept(token, id, p) {
  var session = await access.need(token, 'delivery');
  var company = session.posCompanyId;
  p = p || {};
  var settings = await delivery.liveSettingsOf(company);
  var readyMinutes = Math.round(Math.min(240, Math.max(5, Number(p.readyMinutes) || settings.readyMinutes)));
  // Claimed first, so two people pressing Accept make one order.
  var o = (await pool.query("UPDATE restaurant_online_orders SET decided_by = $3, decided_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'pending' AND decided_at IS NULL RETURNING *",
    [id, company, session.posEmployeeId])).rows[0];
  if (!o) {
    var now = (await pool.query('SELECT status FROM restaurant_online_orders WHERE id = $1 AND company_id = $2', [id, company])).rows[0];
    if (!now) fail('notfound', 'That order is not this restaurant\'s.');
    fail('conflict', now.status === 'cancelled' ? 'The customer cancelled that order.' : 'Someone has answered that order already.');
  }
  var startAt = o.scheduled_for ? startOf(o, readyMinutes) : null;
  if (startAt && startAt.getTime() > Date.now()) {
    var later = (await pool.query("UPDATE restaurant_online_orders SET status = 'accepted', ready_minutes = $2, start_at = $3, release_error = NULL, updated_at = now() WHERE id = $1 RETURNING *",
      [o.id, readyMinutes, startAt])).rows[0];
    await activity.log(pool, { companyId: company, employeeId: session.posEmployeeId, app: 'delivery', action: 'online.accepted',
      summary: 'Confirmed ' + ref(o.number) + ' from ' + o.customer_name + ' for ' + whenText(o.scheduled_for) + ' (to the kitchen at ' + hhmmOf(startAt) + ').',
      amount: round2(o.total), refType: 'online', refId: o.id });
    return { order: staffOut(later), tab: null };
  }
  var tab;
  try {
    tab = await openTab(session, o);
  } catch (err) {
    await pool.query('UPDATE restaurant_online_orders SET decided_by = NULL, decided_at = NULL WHERE id = $1', [o.id]);
    throw err;
  }
  var row = (await pool.query("UPDATE restaurant_online_orders SET status = 'accepted', tab_id = $2, ready_minutes = $3, start_at = CASE WHEN scheduled_for IS NULL THEN NULL ELSE now() END, updated_at = now() WHERE id = $1 RETURNING *",
    [o.id, tab.id, readyMinutes])).rows[0];
  await attachPaid(pool, o.id, tab.id);
  await activity.log(pool, { companyId: company, employeeId: session.posEmployeeId, app: 'delivery', action: 'online.accepted',
    summary: 'Accepted ' + ref(o.number) + ' from ' + o.customer_name + (o.scheduled_for ? ' for ' + whenText(o.scheduled_for) : ' (ready in about ' + readyMinutes + ' min)') + (tab.kitchenTicket ? '; kitchen ticket #' + tab.kitchenTicket.number : '') + '.',
    amount: round2(o.total), refType: 'online', refId: o.id });
  return { order: staffOut(row), tab: tabOut(tab) };
}

// An order for later goes to the kitchen: the open order on the till, in
// the name of the person given (who confirmed it, or pressed Start now).
// If it cannot (a dish sold out since), why is kept for the delivery screen
// and it waits for Start now. { order, tab } or { order, error }; null if it
// is not waiting (gone to the kitchen already, cancelled, or being sent).
async function release(id, session, early) {
  return withTransaction(async function (client) {
    var o = (await client.query("SELECT * FROM restaurant_online_orders WHERE id = $1 AND company_id = $2 AND status = 'accepted' AND tab_id IS NULL FOR UPDATE SKIP LOCKED",
      [id, session.posCompanyId])).rows[0];
    if (!o) return null;
    var tab;
    try {
      tab = await openTab(session, o);
    } catch (err) {
      var stuck = (await client.query('UPDATE restaurant_online_orders SET release_error = $2, updated_at = now() WHERE id = $1 RETURNING *', [o.id, String(err.message || err).slice(0, 300)])).rows[0];
      return { order: stuck, error: err };
    }
    var row = (await client.query('UPDATE restaurant_online_orders SET tab_id = $2, start_at = least(start_at, now()), release_error = NULL, updated_at = now() WHERE id = $1 RETURNING *', [o.id, tab.id])).rows[0];
    await attachPaid(client, o.id, tab.id);
    await activity.log(client, { companyId: o.company_id, employeeId: early ? session.posEmployeeId : null, app: 'delivery', action: 'online.started',
      summary: (early ? 'Started ' : 'Time to cook: ') + ref(o.number) + ' from ' + o.customer_name + ' for ' + hhmmOf(o.scheduled_for) + ' went to the kitchen' + (tab.kitchenTicket ? ' as #' + tab.kitchenTicket.number : '') + '.',
      amount: round2(o.total), refType: 'online', refId: o.id });
    return { order: row, tab: tab };
  });
}
// POST /api/pos/delivery/online/:id/start — an order for later to the kitchen now.
async function start(token, id) {
  var session = await access.need(token, 'delivery');
  var r = await release(id, session, true);
  if (!r) {
    var now = (await pool.query('SELECT status, tab_id FROM restaurant_online_orders WHERE id = $1 AND company_id = $2', [id, session.posCompanyId])).rows[0];
    if (!now) fail('notfound', 'That order is not this restaurant\'s.');
    fail('conflict', now.status === 'cancelled' ? 'The customer cancelled that order.' : now.tab_id ? 'That order has gone to the kitchen already.' : 'That order is not confirmed for later.');
  }
  if (r.error) throw r.error;
  return { order: staffOut(r.order), tab: tabOut(r.tab) };
}
// Every order for later whose time to cook has come — of one restaurant,
// or all of them (the job). Those that could not be sent before wait for
// Start now. How many went.
async function releaseDue(companyId) {
  var rows = (await pool.query("SELECT id, company_id, decided_by FROM restaurant_online_orders WHERE status = 'accepted' AND tab_id IS NULL AND start_at <= now() AND release_error IS NULL" +
    (companyId ? ' AND company_id = $1' : '') + ' ORDER BY start_at LIMIT 40', companyId ? [companyId] : [])).rows;
  var went = 0;
  for (var i = 0; i < rows.length; i++) {
    var o = rows[i];
    try {
      if (!o.decided_by) {
        await pool.query('UPDATE restaurant_online_orders SET release_error = $2, updated_at = now() WHERE id = $1', [o.id, 'Whoever confirmed it is not on the staff any more: press Start now.']);
        continue;
      }
      var r = await release(o.id, { posCompanyId: o.company_id, posEmployeeId: o.decided_by, access: await access.accessOf(o.company_id, o.decided_by) }, false);
      if (r && r.tab) went++;
    } catch (e) {
      console.error('Website order for later not sent to the kitchen:', e.message);
    }
  }
  return went;
}
// POST /api/pos/delivery/online/:id/reject { reason } — turned down; the customer sees why.
async function reject(token, id, p) {
  var session = await access.need(token, 'delivery');
  var reason = V.text(cleanText((p || {}).reason, 200), 'Why it is turned down', 200);
  var o = (await pool.query("UPDATE restaurant_online_orders SET status = 'rejected', reject_reason = $3, decided_by = $4, decided_at = now(), updated_at = now() " +
    "WHERE id = $1 AND company_id = $2 AND status = 'pending' AND decided_at IS NULL RETURNING *", [id, session.posCompanyId, reason, session.posEmployeeId])).rows[0];
  if (!o) fail('conflict', 'That order has been answered already, or cancelled.');
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'delivery', action: 'online.rejected',
    summary: 'Turned down ' + ref(o.number) + ' from ' + o.customer_name + ': ' + reason, amount: round2(o.total), refType: 'online', refId: o.id });
  var given = o.pay_method === 'online' ? await refundFor(o.id, 'Turned down by the restaurant: ' + reason) : null;
  return { order: (await withPaid([staffOut(o)]))[0], refund: given ? { status: given.refund_status, note: given.refund_note || '' } : null };
}

module.exports = {
  siteUrlFor: siteUrlFor, shopOf: shopOf,
  modsFrom: modsFrom, billRules: billRules,
  categoriesOff: categoriesOff, aliasesOf: aliasesOf, menu: menu, menuItems: menuItems, cleanText: cleanText, place: place, track: track, trackMine: trackMine, cancel: cancel, accept: accept, reject: reject, start: start, here: here, curbside: curbside, brought: brought,
  releaseDue: releaseDue, laterOut: laterOut, staffOut: staffOut, ref: ref, STEP: STEP, slotOf: slotOf, slotLoad: slotLoad, limitsOut: limitsOut,
  settlePaid: settlePaid, payAgain: payAgain, sweepUnpaid: sweepUnpaid, refundFor: refundFor, withPaid: withPaid, UNPAID_MINUTES: UNPAID_MINUTES,
  promo: promo, promoByCode: promoByCode, promoThrottle: promoThrottle
};
