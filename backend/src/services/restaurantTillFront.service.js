var { fail } = require('../utils/errors');

// The till's settings for the guests themselves (restaurantTillAccess
// merged / cleanSettings): bookings and the waitlist, tips, "your food is
// ready" texts, loyalty points and gift cards. Each starts off.

var TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
var STEPS = [15, 30, 60];
var READY_TEXT = 'Hi {name}, your order {number} at {restaurant} is ready. Come and pick it up at the counter.';

var DEFAULTS = {
  // Bookings (restaurantBookings): asked for on the website (online), every
  // `step` minutes from `from` to `to` on the days (0 Sunday; none, every
  // day), up to `perSlot` a time and `maxParty` people, `daysAhead` days
  // ahead; confirmed by the till unless autoConfirm. A booking keeps its
  // table `minutes`.
  bookings: { online: false, autoConfirm: false, from: '12:00', to: '21:00', days: [], step: 30, perSlot: 4, maxParty: 10, daysAhead: 30, minutes: 90 },
  // Tips on the pay screen and the customer's screen: the percentages to tap.
  tips: { on: false, percents: [5, 10, 15] },
  // A text to a pickup customer when the kitchen has their order ready.
  readyText: { on: false, message: READY_TEXT },
  // Loyalty: a point for every `spend` cedis paid; rewards to spend them on
  // ([{ id, name, points, kind: 'amount' | 'percent', value }]).
  loyalty: { on: false, spend: 10, rewards: [] },
  // Gift cards sold at the till and taken as a way of paying; the amounts
  // offered first.
  giftCards: { on: false, amounts: [50, 100, 200, 500] }
};
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function num(v) { return Math.round(Number(v) * 100) / 100; }
function days(list) { return Array.isArray(list) ? list.map(Number).filter(function (d, i, a) { return d >= 0 && d <= 6 && Math.floor(d) === d && a.indexOf(d) === i; }).sort() : []; }

// The stored settings over the defaults (what is not right is left as the default).
function merge(out, s) {
  var b = s.bookings;
  if (b && typeof b === 'object') {
    ['online', 'autoConfirm'].forEach(function (k) { if (typeof b[k] === 'boolean') out.bookings[k] = b[k]; });
    if (TIME.test(b.from || '') && TIME.test(b.to || '') && b.from < b.to) { out.bookings.from = b.from; out.bookings.to = b.to; }
    out.bookings.days = days(b.days);
    if (STEPS.indexOf(Number(b.step)) >= 0) out.bookings.step = Number(b.step);
    if (Number(b.perSlot) >= 1 && Number(b.perSlot) <= 50) out.bookings.perSlot = Math.round(Number(b.perSlot));
    if (Number(b.maxParty) >= 1 && Number(b.maxParty) <= 100) out.bookings.maxParty = Math.round(Number(b.maxParty));
    if (Number(b.daysAhead) >= 1 && Number(b.daysAhead) <= 180) out.bookings.daysAhead = Math.round(Number(b.daysAhead));
    if (Number(b.minutes) >= 15 && Number(b.minutes) <= 600) out.bookings.minutes = Math.round(Number(b.minutes));
  }
  if (s.tips && typeof s.tips === 'object') {
    if (typeof s.tips.on === 'boolean') out.tips.on = s.tips.on;
    if (Array.isArray(s.tips.percents)) { var p = s.tips.percents.map(num).filter(function (x) { return x > 0 && x <= 50; }).slice(0, 4); if (p.length) out.tips.percents = p; }
  }
  if (s.readyText && typeof s.readyText === 'object') {
    if (typeof s.readyText.on === 'boolean') out.readyText.on = s.readyText.on;
    if (typeof s.readyText.message === 'string' && s.readyText.message.trim()) out.readyText.message = s.readyText.message;
  }
  if (s.loyalty && typeof s.loyalty === 'object') {
    if (typeof s.loyalty.on === 'boolean') out.loyalty.on = s.loyalty.on;
    if (num(s.loyalty.spend) >= 0.5 && num(s.loyalty.spend) <= 100000) out.loyalty.spend = num(s.loyalty.spend);
    if (Array.isArray(s.loyalty.rewards)) out.loyalty.rewards = s.loyalty.rewards.filter(function (r) { return r && r.id && r.name && r.points > 0 && (r.kind === 'amount' || r.kind === 'percent') && Number(r.value) > 0; });
  }
  if (s.giftCards && typeof s.giftCards === 'object') {
    if (typeof s.giftCards.on === 'boolean') out.giftCards.on = s.giftCards.on;
    if (Array.isArray(s.giftCards.amounts)) { var a = s.giftCards.amounts.map(num).filter(function (x) { return x > 0 && x <= 100000; }).slice(0, 6); if (a.length) out.giftCards.amounts = a; }
  }
  return out;
}

// What a manager saves, checked (a wrong value says so).
function clean(out, p, text) {
  if (p.bookings) {
    var b = p.bookings;
    if (!TIME.test(b.from || '') || !TIME.test(b.to || '') || !(b.from < b.to)) fail('invalid', 'Bookings: give the first and last times as HH:MM, the first before the last.');
    if (STEPS.indexOf(Number(b.step)) < 0) fail('invalid', 'Bookings: every 15, 30 or 60 minutes.');
    var perSlot = Math.round(Number(b.perSlot)), maxParty = Math.round(Number(b.maxParty)), ahead = Math.round(Number(b.daysAhead)), minutes = Math.round(Number(b.minutes));
    if (!(perSlot >= 1 && perSlot <= 50)) fail('invalid', 'Bookings: from 1 to 50 bookings a time.');
    if (!(maxParty >= 1 && maxParty <= 100)) fail('invalid', 'Bookings: the biggest party on the website, from 1 to 100.');
    if (!(ahead >= 1 && ahead <= 180)) fail('invalid', 'Bookings: from 1 to 180 days ahead.');
    if (!(minutes >= 15 && minutes <= 600)) fail('invalid', 'Bookings: a table is kept from 15 to 600 minutes.');
    out.bookings = { online: !!b.online, autoConfirm: !!b.autoConfirm, from: b.from, to: b.to, days: days(b.days), step: Number(b.step), perSlot: perSlot, maxParty: maxParty, daysAhead: ahead, minutes: minutes };
  }
  if (p.tips) {
    var percents = Array.isArray(p.tips.percents) ? p.tips.percents.map(num).filter(function (x) { return x > 0; }) : [];
    if (p.tips.on && !percents.length) fail('invalid', 'Tips: give at least one percentage to tap, e.g. 10.');
    if (percents.some(function (x) { return x > 50; }) || percents.length > 4) fail('invalid', 'Tips: up to 4 percentages, each at most 50.');
    out.tips = { on: !!p.tips.on, percents: percents.length ? percents : out.tips.percents };
  }
  if (p.readyText) {
    var message = text(p.readyText.message, 300);
    if (p.readyText.on && !message) fail('invalid', 'Write the text that tells a customer their food is ready.');
    out.readyText = { on: !!p.readyText.on, message: message || READY_TEXT };
  }
  if (p.loyalty) {
    var l = p.loyalty;
    var spend = num(l.spend);
    if (!(spend >= 0.5 && spend <= 100000)) fail('invalid', 'Loyalty: one point for how many cedis spent? From 0.5.');
    var list = Array.isArray(l.rewards) ? l.rewards : [];
    if (list.length > 12) fail('invalid', 'Loyalty: keep at most 12 rewards.');
    var rewards = list.map(function (r) {
      r = r || {};
      var name = text(r.name, 40);
      if (!name) fail('invalid', 'Loyalty: give each reward a name, e.g. GHS 20 off.');
      var points = Math.round(Number(r.points));
      if (!(points >= 1 && points <= 1000000)) fail('invalid', name + ': how many points does it take?');
      if (r.kind !== 'amount' && r.kind !== 'percent') fail('invalid', name + ': an amount or a percentage off?');
      var value = num(r.value);
      if (!(value > 0) || (r.kind === 'percent' && value > 100) || value >= 1000000) fail('invalid', name + ': give it a size (a percentage up to 100, or an amount).');
      return { id: /^[a-z0-9-]{4,40}$/.test(String(r.id || '')) ? r.id : require('crypto').randomUUID(), name: name, points: points, kind: r.kind, value: value };
    });
    if (l.on && !rewards.length) fail('invalid', 'Loyalty: add at least one reward to spend the points on.');
    out.loyalty = { on: !!l.on, spend: spend, rewards: rewards };
  }
  if (p.giftCards) {
    var amounts = Array.isArray(p.giftCards.amounts) ? p.giftCards.amounts.map(num).filter(function (x) { return x > 0 && x <= 100000; }).slice(0, 6) : [];
    out.giftCards = { on: !!p.giftCards.on, amounts: amounts.length ? amounts : out.giftCards.amounts };
  }
  return out;
}

// The loyalty rewards as ready-made bill discounts (restaurantTillCheck):
// open to anyone at the till; the points are taken when the sale is paid
// (restaurantLoyalty forSale).
function rewardPresets(settings) {
  var l = settings && settings.loyalty;
  if (!l || !l.on) return [];
  return (l.rewards || []).map(function (r) { return { id: 'loyalty:' + r.id, name: r.name, kind: r.kind, value: r.value, open: true, loyalty: { id: r.id, points: r.points } }; });
}

module.exports = { DEFAULTS: DEFAULTS, rewardPresets: rewardPresets, READY_TEXT: READY_TEXT, defaults: function () { return clone(DEFAULTS); }, merge: merge, clean: clean, TIME: TIME };
