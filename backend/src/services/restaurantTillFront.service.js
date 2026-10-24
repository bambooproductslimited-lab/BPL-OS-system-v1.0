var { fail } = require('../utils/errors');

// The till's settings for the guests themselves (restaurantTillAccess
// merged / cleanSettings): bookings and the waitlist, tips, "your food is
// ready" texts, loyalty points and gift cards. Each starts off.

var TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
var TIME_END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/; // the hours texts may go out end at 24:00 at the latest
var STEPS = [15, 30, 60];
var READY_TEXT = 'Hi {name}, your order {number} at {restaurant} is ready. Come and pick it up at the counter.';
// The automatic texts and emails (restaurantCampaigns): {name}, {restaurant}
// and {points} are filled in; every one ends with the way to stop them.
var LAPSED_TEXT = 'Hi {name}, we miss you at {restaurant}! Come and see us this week.';
var BIRTHDAY_TEXT = 'Happy birthday, {name}! Everyone at {restaurant} wishes you a wonderful day. Come and celebrate with us.';
var WELCOME_TEXT = 'Thank you for coming to {restaurant}, {name}. We hope to see you again soon!';
var APP_KEY = /^[a-z0-9-]{2,24}$/;
var CHANNELS = ['sms', 'email', 'both'];

var DEFAULTS = {
  // Bookings (restaurantBookings): asked for on the website (online), every
  // `step` minutes from `from` to `to` on the days (0 Sunday; none, every
  // day), up to `perSlot` a time and `maxParty` people, `daysAhead` days
  // ahead; confirmed by the till unless autoConfirm. A booking keeps its
  // table `minutes`.
  bookings: { online: false, autoConfirm: false, from: '12:00', to: '21:00', days: [], step: 30, perSlot: 4, maxParty: 10, daysAhead: 30, minutes: 90 },
  // Tips on the pay screen and the customer's screen: the percentages to tap;
  // and how they are shared (restaurantTips): each to the person who served
  // the bill ('direct'), each sale's split among the tip-eligible staff
  // clocked in at the time ('sale'), or each day's split by the hours they
  // worked ('hours'). Tip-eligible: the till roles listed.
  tips: { on: false, percents: [5, 10, 15], pool: { method: 'direct', roles: ['cashier', 'waiter'] } },
  // A text to a pickup customer when the kitchen has their order ready.
  readyText: { on: false, message: READY_TEXT },
  // Loyalty: a point for every `spend` cedis paid; rewards to spend them on
  // ([{ id, name, points, kind: 'amount' | 'percent', value }]).
  loyalty: { on: false, spend: 10, rewards: [] },
  // Gift cards sold at the till and taken as a way of paying; the amounts
  // offered first; online: bought on the website too (paid through Paystack).
  giftCards: { on: false, amounts: [50, 100, 200, 500], online: false },
  // Texts and emails to guests (restaurantCampaigns): the automatic ones,
  // at most one marketing message a guest every perGuestDays, dailyMax a
  // day, sent only between from and to; onlyAgreed: only to guests who
  // said yes (else to all who have not said no).
  campaigns: {
    lapsed: { on: false, days: 30, channel: 'sms', message: LAPSED_TEXT },
    birthday: { on: false, channel: 'sms', message: BIRTHDAY_TEXT },
    welcome: { on: false, channel: 'sms', message: WELCOME_TEXT },
    perGuestDays: 7, dailyMax: 300, from: '09:00', to: '20:00', onlyAgreed: false
  },
  // Delivery apps (restaurantApps): each app's prices on top of the menu's
  // (markup %) and what it keeps (commission %).
  apps: { list: [
    { key: 'bolt', name: 'Bolt Food', on: false, markup: 0, commission: 22 },
    { key: 'glovo', name: 'Glovo', on: false, markup: 0, commission: 25 }
  ] },
  // The self-order kiosk (restaurantKiosk): taking orders at all, straight
  // to the kitchen (else when the cashier takes them), paid on the kiosk
  // through Paystack (when the server has its key), back to the start
  // after idleSeconds untouched, and its welcome line.
  kiosk: { on: false, straightToKitchen: false, payHere: false, idleSeconds: 90, welcome: 'Order here, then pay at the counter.' },
  // Cards: the terminals the till takes them on (their names, for the
  // reconciliation), and card and Mobile Money paid by the customer's phone
  // through Paystack (a QR code on the till).
  card: { terminals: ['Card terminal'], paystack: false },
  // Paying at the table (restaurantTablePay): the table's QR code, and the
  // printed bill's, let guests pay the bill or their share, with a tip,
  // by card or Mobile Money through Paystack.
  tablePay: { on: false },
  // Feedback from the receipt (restaurantFeedback): asked on every
  // receipt's page; happy guests are offered the review page (reviewUrl,
  // e.g. the restaurant's Google page).
  feedback: { on: true, reviewUrl: '' }
};
var POOL_METHODS = ['direct', 'sale', 'hours'];
var POOL_ROLES = ['manager', 'cashier', 'waiter', 'kitchen'];
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
    if (s.tips.pool && typeof s.tips.pool === 'object') {
      if (POOL_METHODS.indexOf(s.tips.pool.method) >= 0) out.tips.pool.method = s.tips.pool.method;
      if (Array.isArray(s.tips.pool.roles)) out.tips.pool.roles = s.tips.pool.roles.filter(function (r) { return POOL_ROLES.indexOf(r) >= 0; });
    }
  }
  if (s.tablePay && typeof s.tablePay.on === 'boolean') out.tablePay.on = s.tablePay.on;
  if (s.feedback && typeof s.feedback === 'object') {
    if (typeof s.feedback.on === 'boolean') out.feedback.on = s.feedback.on;
    if (typeof s.feedback.reviewUrl === 'string') out.feedback.reviewUrl = s.feedback.reviewUrl.slice(0, 300);
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
    if (typeof s.giftCards.online === 'boolean') out.giftCards.online = s.giftCards.online;
    if (Array.isArray(s.giftCards.amounts)) { var a = s.giftCards.amounts.map(num).filter(function (x) { return x > 0 && x <= 100000; }).slice(0, 6); if (a.length) out.giftCards.amounts = a; }
  }
  var c = s.campaigns;
  if (c && typeof c === 'object') {
    ['lapsed', 'birthday', 'welcome'].forEach(function (k) {
      var x = c[k];
      if (!x || typeof x !== 'object') return;
      if (typeof x.on === 'boolean') out.campaigns[k].on = x.on;
      if (CHANNELS.indexOf(x.channel) >= 0) out.campaigns[k].channel = x.channel;
      if (typeof x.message === 'string' && x.message.trim()) out.campaigns[k].message = x.message;
      if (k === 'lapsed' && Number(x.days) >= 7 && Number(x.days) <= 365) out.campaigns.lapsed.days = Math.round(Number(x.days));
    });
    if (Number(c.perGuestDays) >= 0 && Number(c.perGuestDays) <= 60) out.campaigns.perGuestDays = Math.round(Number(c.perGuestDays));
    if (Number(c.dailyMax) >= 1 && Number(c.dailyMax) <= 5000) out.campaigns.dailyMax = Math.round(Number(c.dailyMax));
    if (TIME.test(c.from || '') && TIME_END.test(c.to || '') && c.from < c.to) { out.campaigns.from = c.from; out.campaigns.to = c.to; }
    if (typeof c.onlyAgreed === 'boolean') out.campaigns.onlyAgreed = c.onlyAgreed;
  }
  if (s.apps && Array.isArray(s.apps.list)) {
    var apps = s.apps.list.filter(function (a) { return a && APP_KEY.test(String(a.key || '')) && String(a.name || '').trim(); }).slice(0, 6)
      .map(function (a) { return { key: a.key, name: String(a.name).trim().slice(0, 40), on: !!a.on, markup: Math.max(0, Math.min(100, num(a.markup) || 0)), commission: Math.max(0, Math.min(60, num(a.commission) || 0)) }; });
    if (apps.length) out.apps.list = apps;
  }
  if (s.kiosk && typeof s.kiosk === 'object') {
    ['on', 'straightToKitchen', 'payHere'].forEach(function (k) { if (typeof s.kiosk[k] === 'boolean') out.kiosk[k] = s.kiosk[k]; });
    if (Number(s.kiosk.idleSeconds) >= 30 && Number(s.kiosk.idleSeconds) <= 600) out.kiosk.idleSeconds = Math.round(Number(s.kiosk.idleSeconds));
    if (typeof s.kiosk.welcome === 'string' && s.kiosk.welcome.trim()) out.kiosk.welcome = s.kiosk.welcome.slice(0, 120);
  }
  if (s.card && typeof s.card === 'object') {
    if (Array.isArray(s.card.terminals)) { var t = s.card.terminals.map(function (x) { return String(x || '').trim().slice(0, 40); }).filter(Boolean).slice(0, 6); if (t.length) out.card.terminals = t; }
    if (typeof s.card.paystack === 'boolean') out.card.paystack = s.card.paystack;
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
    var pool = clone(out.tips.pool);
    if (p.tips.pool) {
      if (POOL_METHODS.indexOf(p.tips.pool.method) < 0) fail('invalid', 'Tips: shared how? To whoever served, by sale, or by hours worked.');
      var roles = Array.isArray(p.tips.pool.roles) ? p.tips.pool.roles.filter(function (r, i, a) { return POOL_ROLES.indexOf(r) >= 0 && a.indexOf(r) === i; }) : [];
      if (p.tips.pool.method !== 'direct' && !roles.length) fail('invalid', 'Tips: pick who shares them (waiters, cashiers, the kitchen…).');
      pool = { method: p.tips.pool.method, roles: roles };
    }
    out.tips = { on: !!p.tips.on, percents: percents.length ? percents : out.tips.percents, pool: pool };
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
    out.giftCards = { on: !!p.giftCards.on, amounts: amounts.length ? amounts : out.giftCards.amounts, online: !!p.giftCards.on && !!p.giftCards.online };
  }
  if (p.campaigns) {
    var c = p.campaigns, cc = clone(out.campaigns);
    ['lapsed', 'birthday', 'welcome'].forEach(function (k) {
      var x = c[k];
      if (!x) return;
      var label = { lapsed: 'We miss you', birthday: 'Happy birthday', welcome: 'Thank you for coming' }[k];
      if (CHANNELS.indexOf(x.channel) < 0) fail('invalid', label + ': by text, by email or both?');
      var message = text(x.message, 480);
      if (x.on && message.length < 10) fail('invalid', label + ': write the message.');
      cc[k] = { on: !!x.on, channel: x.channel, message: message || cc[k].message };
      if (k === 'lapsed') {
        var days = Math.round(Number(x.days));
        if (!(days >= 7 && days <= 365)) fail('invalid', 'We miss you: after 7 to 365 days without a visit.');
        cc.lapsed.days = days;
      }
    });
    if (c.perGuestDays !== undefined) {
      var gap = Math.round(Number(c.perGuestDays));
      if (!(gap >= 0 && gap <= 60)) fail('invalid', 'Texts and emails: from 0 to 60 days between two to the same guest.');
      cc.perGuestDays = gap;
    }
    if (c.dailyMax !== undefined) {
      var max = Math.round(Number(c.dailyMax));
      if (!(max >= 1 && max <= 5000)) fail('invalid', 'Texts and emails: from 1 to 5,000 a day.');
      cc.dailyMax = max;
    }
    if (c.from !== undefined || c.to !== undefined) {
      if (!TIME.test(c.from || '') || !TIME_END.test(c.to || '') || !(c.from < c.to)) fail('invalid', 'Texts and emails: give the hours they may go out as HH:MM, the first before the last.');
      cc.from = c.from; cc.to = c.to;
    }
    if (c.onlyAgreed !== undefined) cc.onlyAgreed = !!c.onlyAgreed;
    out.campaigns = cc;
  }
  if (p.apps) {
    var list = Array.isArray(p.apps.list) ? p.apps.list : [];
    if (list.length > 6) fail('invalid', 'Delivery apps: keep at most 6.');
    var seen = {};
    out.apps = { list: list.map(function (a) {
      a = a || {};
      var name = text(a.name, 40);
      if (!name) fail('invalid', 'Delivery apps: give each app its name, e.g. Bolt Food.');
      var key = APP_KEY.test(String(a.key || '')) ? a.key : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'app';
      if (seen[key]) fail('invalid', 'Delivery apps: ' + name + ' is there twice.');
      seen[key] = true;
      var markup = num(a.markup || 0), commission = num(a.commission || 0);
      if (!(markup >= 0 && markup <= 100)) fail('invalid', name + ': its prices from 0% to 100% above the menu\'s.');
      if (!(commission >= 0 && commission <= 60)) fail('invalid', name + ': what it keeps, from 0% to 60%.');
      return { key: key, name: name, on: !!a.on, markup: markup, commission: commission };
    }) };
  }
  if (p.kiosk) {
    var k = p.kiosk;
    var idle = Math.round(Number(k.idleSeconds === undefined ? out.kiosk.idleSeconds : k.idleSeconds));
    if (!(idle >= 30 && idle <= 600)) fail('invalid', 'The kiosk: back to the start after 30 to 600 seconds.');
    out.kiosk = { on: !!k.on, straightToKitchen: !!k.straightToKitchen, payHere: !!k.payHere, idleSeconds: idle, welcome: text(k.welcome, 120) || out.kiosk.welcome };
  }
  if (p.tablePay) out.tablePay = { on: !!p.tablePay.on };
  if (p.feedback) {
    var review = String(p.feedback.reviewUrl || '').trim().slice(0, 300);
    if (review && !/^https:\/\/[^\s]+\.[^\s]+$/.test(review)) fail('invalid', 'Feedback: the review page as a full link starting with https://');
    out.feedback = { on: !!p.feedback.on, reviewUrl: review };
  }
  if (p.card) {
    var terminals = Array.isArray(p.card.terminals) ? p.card.terminals.map(function (x) { return text(x, 40); }).filter(Boolean) : [];
    if (terminals.length > 6) fail('invalid', 'Cards: at most 6 terminals.');
    out.card = { terminals: terminals.length ? terminals : out.card.terminals, paystack: !!p.card.paystack };
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

module.exports = { DEFAULTS: DEFAULTS, rewardPresets: rewardPresets, READY_TEXT: READY_TEXT, LAPSED_TEXT: LAPSED_TEXT, defaults: function () { return clone(DEFAULTS); }, merge: merge, clean: clean, TIME: TIME };
