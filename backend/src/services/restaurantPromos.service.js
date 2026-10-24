var { fail } = require('../utils/errors');
var times = require('./restaurantTillTimes.service');

// Automatic discounts and promo codes (till settings promotions): deals
// the manager sets once, that go on a bill by themselves when it qualifies
// — or when the customer gives the deal's code, on the till, the kiosk or
// the website. One deal per bill: the one that saves the customer most.
//
//   kind 'percent'  value % off the deal's dishes (all dishes if it names none)
//   kind 'amount'   value off the deal's dishes, at most what they cost
//   kind 'buyget'   buy `buy` of the deal's dishes, get `get` more at value %
//                   off (100: free) — the cheapest ones in each set
//
// When: on some days (days: 0 Sunday … 6 Saturday, none for every day),
// between two times (none: all day), from and until a date; where: on the
// till (and its open orders), the kiosk, the website; and a smallest bill
// (minSpend, the dishes after their own discounts). A dish already given a
// discount or put on the house gets no deal on top. A deal on an open order
// stays as it was given (restaurantTillCheck compute: kept), even after its
// hours, so a table seated in a lunch deal pays the lunch deal.
//
// The same sums run on the till as it takes the order (frontend
// till/promos.js): keep the two the same.

var KINDS = ['percent', 'amount', 'buyget'];
var CHANNELS = ['till', 'kiosk', 'online'];
var MAX = 30;
var DATE = /^\d{4}-\d{2}-\d{2}$/;
var TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function round2(n) { return Math.round(Number(Number(n || 0).toPrecision(12)) * 100) / 100; }
function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function codeOf(v) { return String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase().slice(0, 24); }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

// ── the manager's list (restaurantTillAccess cleanSettings) ──

function cleanList(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > MAX) fail('invalid', 'At most ' + MAX + ' deals.');
  var codes = new Set();
  return list.map(function (p, i) {
    p = p || {};
    var name = text(p.name, 60);
    if (!name) fail('invalid', 'Give each deal a name, e.g. Lunch combo 10% off.');
    var kind = KINDS.indexOf(p.kind) >= 0 ? p.kind : 'percent';
    var value = round2(p.value);
    if (kind === 'amount' ? !(value > 0 && value < 100000) : !(value > 0 && value <= 100)) fail('invalid', name + ': ' + (kind === 'amount' ? 'how much off?' : 'give a percentage from 1 to 100.'));
    var buy = Math.round(Number(p.buy) || 0), get = Math.round(Number(p.get) || 0);
    if (kind === 'buyget' && !(buy >= 1 && buy <= 20 && get >= 1 && get <= 20)) fail('invalid', name + ': buy how many, and get how many?');
    var code = codeOf(p.code);
    if (code && !/^[A-Z0-9_-]{3,24}$/.test(code)) fail('invalid', name + ': a promo code is 3 to 24 letters and numbers.');
    if (code && codes.has(code)) fail('invalid', 'Two deals have the code ' + code + '.');
    if (code) codes.add(code);
    var from = TIME.test(p.from || '') ? p.from : '', to = TIME.test(p.to || '') ? p.to : '';
    if (!!from !== !!to) fail('invalid', name + ': give both times, or none for all day.');
    var startsOn = DATE.test(p.startsOn || '') ? p.startsOn : '', endsOn = DATE.test(p.endsOn || '') ? p.endsOn : '';
    if (startsOn && endsOn && endsOn < startsOn) fail('invalid', name + ': it ends before it starts.');
    var days = Array.from(new Set((Array.isArray(p.days) ? p.days : []).map(Number).filter(function (d) { return d >= 0 && d <= 6 && d % 1 === 0; }))).sort();
    var where = p.where || {};
    var ch = {};
    CHANNELS.forEach(function (c) { ch[c] = where[c] !== false; });
    if (!CHANNELS.some(function (c) { return ch[c]; })) fail('invalid', name + ': on the till, the kiosk or the website?');
    var minSpend = Math.max(0, round2(p.minSpend));
    var categories = Array.from(new Set((Array.isArray(p.categories) ? p.categories : []).map(function (c) { return text(c, 40); }).filter(Boolean))).slice(0, 40);
    var items = Array.from(new Set((Array.isArray(p.items) ? p.items : []).filter(function (x) { return /^[0-9a-f-]{36}$/i.test(String(x)); }))).slice(0, 100);
    return {
      id: /^[a-z0-9-]{1,40}$/i.test(String(p.id || '')) ? String(p.id) : 'promo-' + Date.now().toString(36) + '-' + i,
      name: name, on: p.on !== false, kind: kind, value: value, buy: kind === 'buyget' ? buy : 0, get: kind === 'buyget' ? get : 0,
      categories: categories, items: items, minSpend: minSpend, code: code,
      days: days, from: from, to: to, startsOn: startsOn, endsOn: endsOn, where: ch
    };
  });
}

// ── on a bill ──

// The day in Ghana (GMT all year).
function dayOf(at) { return new Date(at ? new Date(at) : Date.now()).toISOString().slice(0, 10); }
// Whether a deal is on for this bill now (a kept one is, as it was given).
function isOpen(p, opts) {
  if (opts.kept === p.id) return true;
  if (!p.on || !p.where[opts.channel || 'till']) return false;
  if (p.code && codeOf(opts.code) !== p.code) return false;
  var day = dayOf(opts.at);
  if (p.startsOn && day < p.startsOn) return false;
  if (p.endsOn && day > p.endsOn) return false;
  if (p.from) return times.isOn({ from: p.from, to: p.to, days: p.days }, opts.at);
  return !p.days.length || p.days.indexOf(new Date(opts.at ? new Date(opts.at) : Date.now()).getUTCDay()) >= 0;
}
// A dish the deal can go on: not a fee, not given its own discount or put on the house.
function canTake(l) { return !l.fee && !l.compReason && !(Number(l.discount) > 0) && Number(l.lineTotal) > 0; }
function onDeal(p, l) {
  if (!p.categories.length && !p.items.length) return true;
  return (l.menuItemId && p.items.indexOf(l.menuItemId) >= 0) || p.categories.some(function (c) { return norm(c) === norm(l.category); });
}

// What a deal takes off each line (by index), or null when it does not fit.
function savingOf(p, lines) {
  var dishes = round2(lines.filter(function (l) { return !l.fee; }).reduce(function (a, l) { return a + Number(l.lineTotal); }, 0));
  if (p.minSpend && dishes < p.minSpend) return null;
  var idx = [];
  lines.forEach(function (l, i) { if (canTake(l) && onDeal(p, l)) idx.push(i); });
  if (!idx.length) return null;
  var shares = lines.map(function () { return 0; });
  if (p.kind === 'percent') {
    idx.forEach(function (i) { shares[i] = round2(Number(lines[i].lineTotal) * p.value / 100); });
  } else if (p.kind === 'amount') {
    var base = round2(idx.reduce(function (a, i) { return a + Number(lines[i].lineTotal); }, 0));
    var off = Math.min(base, p.value), left = off;
    idx.forEach(function (i, k) {
      var s = k === idx.length - 1 ? left : Math.min(left, round2(off * Number(lines[i].lineTotal) / base));
      shares[i] = s; left = round2(left - s);
    });
  } else {
    // Each dish one by one, dearest first; in each set of buy + get, the last get are the deal's.
    var units = [];
    idx.forEach(function (i) {
      var n = Math.floor(Number(lines[i].qty));
      var each = n > 0 ? Number(lines[i].lineTotal) / Number(lines[i].qty) : 0;
      for (var u = 0; u < n; u++) units.push({ i: i, price: each });
    });
    units.sort(function (a, b) { return b.price - a.price || a.i - b.i; });
    var set = p.buy + p.get;
    for (var s0 = 0; s0 + set <= units.length; s0 += set) {
      for (var g = s0 + p.buy; g < s0 + set; g++) shares[units[g].i] = shares[units[g].i] + units[g].price * p.value / 100;
    }
    shares = shares.map(round2);
  }
  var amount = round2(shares.reduce(function (a, b) { return a + b; }, 0));
  return amount > 0 ? { amount: amount, shares: shares } : null;
}

// The best deal for these lines (compute's, after their own discounts):
// { promo, amount, shares } or null. opts: { channel, code, at, kept }.
// A code given that fits no deal fails, unless it was kept on the order.
function best(lines, promotions, opts) {
  opts = opts || {};
  var list = promotions || [];
  var code = codeOf(opts.code);
  if (code && code !== codeOf(opts.keptCode)) {
    var c = list.find(function (p) { return p.code === code; });
    if (!c || !isOpen(c, Object.assign({}, opts, { kept: null }))) fail('invalid', 'The promo code ' + code + ' is not right, or not on now.');
  }
  var top = null;
  list.forEach(function (p) {
    if (!isOpen(p, opts)) return;
    var s = savingOf(p, lines);
    if (s && (!top || s.amount > top.amount)) top = { promo: p, amount: s.amount, shares: s.shares };
  });
  return top;
}

// A deal as a website or kiosk gets it: only there, with its hours for the
// basket to check again (frontend till/promos.js), its code only when given.
function publicOf(p, channel, withCode) {
  var where = {};
  where[channel] = true;
  return {
    id: p.id, name: p.name, on: true, kind: p.kind, value: p.value, buy: p.buy, get: p.get, minSpend: p.minSpend, categories: p.categories, items: p.items,
    code: withCode ? p.code : '', days: p.days, from: p.from, to: p.to, startsOn: p.startsOn, endsOn: p.endsOn, where: where
  };
}
// What a website or kiosk shows: the deals on there now, without the ones that need a code.
function shown(promotions, channel, at) {
  return (promotions || []).filter(function (p) { return !p.code && isOpen(p, { channel: channel, at: at }); }).map(function (p) { return publicOf(p, channel, false); });
}

// ── the party service charge ──

// A large party at a table pays a service charge (partyService: { on,
// minGuests, rate, name }) — in place of the usual one when it is larger.
function cleanParty(p) {
  p = p || {};
  var minGuests = Math.round(Number(p.minGuests) || 8), rate = round2(p.rate);
  if (p.on && !(minGuests >= 2 && minGuests <= 200)) fail('invalid', 'A large party: from 2 to 200 guests.');
  if (p.on && !(rate > 0 && rate <= 30)) fail('invalid', 'A large party\'s service charge: from 1 to 30%.');
  return { on: !!p.on, minGuests: minGuests >= 2 && minGuests <= 200 ? minGuests : 8, rate: rate > 0 && rate <= 30 ? rate : 10, name: text(p.name, 40) || 'Large party service' };
}
// The service charge on this order: { on, rate, name } (restaurantTillCheck compute).
function serviceFor(settings, fulfillment, guests) {
  var sc = settings.serviceCharge || {};
  var usual = { on: !!(sc.on && sc.rate > 0 && (sc.types || {})[fulfillment || 'dine_in']), rate: Number(sc.rate) || 0, name: sc.name || 'Service charge', party: false };
  var ps = settings.partyService || {};
  if (ps.on && (fulfillment || 'dine_in') === 'dine_in' && Number(guests) >= ps.minGuests && (!usual.on || ps.rate > usual.rate)) {
    return { on: true, rate: ps.rate, name: ps.name, party: true };
  }
  return usual;
}

module.exports = { KINDS: KINDS, CHANNELS: CHANNELS, cleanList: cleanList, cleanParty: cleanParty, best: best, shown: shown, publicOf: publicOf, serviceFor: serviceFor, isOpen: isOpen, savingOf: savingOf, codeOf: codeOf };
