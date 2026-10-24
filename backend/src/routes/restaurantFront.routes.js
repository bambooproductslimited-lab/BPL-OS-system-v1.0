var express = require('express');
var bookings = require('../services/restaurantBookings.service');
var displays = require('../services/restaurantDisplays.service');
var loyalty = require('../services/restaurantLoyalty.service');
var gifts = require('../services/restaurantGiftCards.service');
var access = require('../services/restaurantTillAccess.service');
var campaigns = require('../services/restaurantCampaigns.service');
var apps = require('../services/restaurantApps.service');
var kiosk = require('../services/restaurantKiosk.service');
var paystack = require('../services/restaurantPaystack.service');
var insights = require('../services/restaurantTillInsights.service');
var tablePay = require('../services/restaurantTablePay.service');
var tips = require('../services/restaurantTips.service');
var costs = require('../services/restaurantCosts.service');
var feedback = require('../services/restaurantFeedback.service');
var board = require('../services/restaurantBoard.service');

// The guests' side of the till (migrations 0171–0173) — mounted at /api/pos
// in app.js beside the till's own routes: bookings and the waitlist, the
// customer's screen and tips, loyalty points and gift cards. Callers: the
// till (its till-session token); a customer screen (its own key); the
// website (a booking's or a gift card's own link).

var router = express.Router();

function posToken(req) {
  var header = req.headers.authorization || '';
  return header.indexOf('Bearer ') === 0 ? header.slice(7) : null;
}
function h(fn) {
  return async function (req, res, next) {
    try { res.json(await fn(req)); } catch (e) { next(e); }
  };
}
var body = function (req) { return req.body || {}; };

// ── bookings and the waitlist ──
router.get('/bookings', h(function (req) { return bookings.list(posToken(req), req.query); }));
router.get('/bookings/soon', h(function (req) { return bookings.soon(posToken(req)); }));
router.post('/bookings', h(function (req) { return bookings.save(posToken(req), body(req)); }));
router.post('/bookings/:id/:action', h(function (req) { return bookings.act(posToken(req), req.params.id, req.params.action, body(req)); }));
// The website: the times on offer, a table asked for, and the guest's own booking by its link.
router.get('/online/:code/book', h(function (req) { return bookings.onlineOptions(req.params.code, req.query); }));
router.post('/online/:code/book', h(function (req) { return bookings.onlineBook(req.params.code, body(req), req.ip, posToken(req)); }));
router.get('/online/bookings/:token', h(function (req) { return bookings.onlineMine(req.params.token); }));
router.post('/online/bookings/:token/cancel', h(function (req) { return bookings.onlineCancel(req.params.token); }));

// ── the customer's screen (its key as the bearer token) and the till's side of it ──
router.post('/display/hello', h(function (req) { return displays.hello(body(req).key, req.ip, req.headers['user-agent']); }));
router.get('/display', h(function (req) { return displays.view(posToken(req)); }));
router.post('/display/tip', h(function (req) { return displays.chooseTip(posToken(req), body(req)); }));
router.get('/displays', h(function (req) { return displays.mine(posToken(req), req.query.device); }));
router.post('/displays/pair', h(function (req) { return displays.pair(posToken(req), body(req)); }));
router.post('/displays/push', h(function (req) { return displays.push(posToken(req), body(req)); }));
router.get('/displays/tip', h(function (req) { return displays.tipFor(posToken(req), req.query.device, req.query.ref); }));
router.post('/displays/:id/unpair', h(function (req) { return displays.unpair(posToken(req), req.params.id); }));

// ── loyalty points ──
router.get('/loyalty/:guestId', h(function (req) { return loyalty.ofGuest(posToken(req), req.params.guestId); }));
// For a manager, with their PIN: the members and points, and a correction.
router.post('/settings/loyalty', h(async function (req) {
  var m = await access.settingsManager(posToken(req), body(req).managerPin, req.ip);
  return loyalty.report(m.session.posCompanyId, body(req));
}));
router.post('/settings/loyalty/:guestId/adjust', h(async function (req) {
  var m = await access.settingsManager(posToken(req), body(req).managerPin, req.ip);
  return loyalty.adjust(m.session.posCompanyId, m.manager.id, req.params.guestId, body(req));
}));

// ── gift cards ──
router.post('/gift-cards', h(function (req) { return gifts.sell(posToken(req), body(req)); }));
router.get('/gift-cards/:code', h(function (req) { return gifts.lookup(posToken(req), req.params.code); }));
router.post('/gift-cards/:id/send', h(function (req) { return gifts.send(posToken(req), req.params.id, body(req)); }));
router.post('/gift-cards/:id/void', h(function (req) { return gifts.voidCard(posToken(req), req.params.id, body(req), req.ip); }));
router.post('/settings/gift-cards', h(async function (req) {
  var m = await access.settingsManager(posToken(req), body(req).managerPin, req.ip);
  return gifts.report(m.session.posCompanyId, body(req));
}));
// ── downloads in Square's layouts (restaurantSquareExport): the item library and the item sales ──
router.post('/settings/export', h(async function (req) {
  var m = await access.settingsManager(posToken(req), body(req).managerPin, req.ip);
  var exp = require('../services/restaurantSquareExport.service');
  return body(req).kind === 'catalog' ? exp.catalogFile([m.session.posCompanyId]) : exp.itemSalesFile([m.session.posCompanyId], body(req));
}));
// A gift card's own page: whoever has the link has the card.
router.get('/online/gift/:token', h(function (req) { return gifts.publicCard(req.params.token); }));
// Gift cards bought on the website: Paystack's page to pay on, then the card once paid.
router.post('/online/:code/gift', h(function (req) { return gifts.buyOnline(req.params.code, body(req), req.ip); }));
router.get('/online/gift-bought/:secret', h(function (req) { return gifts.bought(req.params.secret); }));

// ── campaigns to guests (migration 0175): a manager's tab, a guest's details, the stop link ──
router.post('/settings/campaigns', h(function (req) { return campaigns.tab(posToken(req), body(req), req.ip); }));
router.post('/guests/:id/contact', h(function (req) { return require('../services/restaurantPos.service').guestContact(posToken(req), req.params.id, body(req)); }));
router.get('/online/unsubscribe/:token', h(function (req) { return campaigns.unsubscribe(req.params.token, false); }));
router.post('/online/unsubscribe/:token', h(function (req) { return campaigns.unsubscribe(req.params.token, true); }));

// ── delivery apps (migration 0176): what each owes and its payouts ──
router.post('/settings/apps', h(function (req) { return apps.settingsTab(posToken(req), body(req), req.ip); }));

// ── reports beyond Square's: categories, areas, times of day, voids, labour, comparisons ──
router.post('/settings/insights', h(async function (req) {
  var m = await access.settingsManager(posToken(req), body(req).managerPin, req.ip);
  return insights.report(m.session.posCompanyId, body(req), await access.settingsOf(m.session.posCompanyId));
}));

// ── kitchen ticket times (restaurantTicketTimes.service.js) ──
router.post('/settings/tickettimes', h(async function (req) {
  var m = await access.settingsManager(posToken(req), body(req).managerPin, req.ip);
  return require('../services/restaurantTicketTimes.service').report(m.session.posCompanyId, body(req), await access.settingsOf(m.session.posCompanyId));
}));

// ── the self-order kiosk (migration 0177; its key as the bearer token) and the till's side of it ──
router.post('/kiosk/hello', h(function (req) { return kiosk.hello(body(req).key, req.ip, req.headers['user-agent']); }));
router.get('/kiosk', h(function (req) { return kiosk.view(posToken(req)); }));
router.get('/kiosk/menu', h(function (req) { return kiosk.menu(posToken(req)); }));
router.get('/kiosk/promo', h(function (req) { return kiosk.promo(posToken(req), req.query, req.ip); }));
router.post('/kiosk/orders', h(function (req) { return kiosk.place(posToken(req), body(req), req.ip); }));
router.get('/kiosk/pay/:reference', h(function (req) { return kiosk.payStatus(posToken(req), req.params.reference); }));
router.get('/kiosks', h(function (req) { return kiosk.list(posToken(req)); }));
router.post('/kiosks/pair', h(function (req) { return kiosk.pair(posToken(req), body(req)); }));
router.post('/kiosks/:id/unpair', h(function (req) { return kiosk.unpair(posToken(req), req.params.id); }));

// ── cards and Mobile Money through Paystack: the till's QR code, Paystack's webhook, the report ──
router.post('/paystack/webhook', h(function (req) { return paystack.webhook(req.rawBody, req.headers['x-paystack-signature']); }));
router.post('/paystack', h(function (req) { return paystack.start(posToken(req), body(req)); }));
router.get('/paystack/:reference', h(function (req) { return paystack.status(posToken(req), req.params.reference); }));
router.post('/settings/paystack', h(async function (req) {
  var m = await access.settingsManager(posToken(req), body(req).managerPin, req.ip);
  var d = insights.periodOf(body(req));
  return { on: paystack.onFor(await access.settingsOf(m.session.posCompanyId)), configured: paystack.configured(), from: d.from, to: d.to,
    payments: await paystack.report(m.session.posCompanyId, d.from, d.to) };
}));

// ── paying at the table (migration 0178): the table's QR code and the till's link for the printed bill ──
router.get('/table/:code/pay', h(function (req) { return tablePay.info(req.params.code); }));
router.post('/table/:code/pay', h(function (req) { return tablePay.start(req.params.code, body(req), req.ip); }));
router.get('/table/:code/pay/:reference', h(function (req) { return tablePay.status(req.params.code, req.params.reference); }));
router.get('/table-pay/link', h(function (req) { return tablePay.link(posToken(req), req.query.tabId); }));

// ── tips shared out and paid (migration 0178) ──
router.post('/settings/tips', h(function (req) { return tips.tab(posToken(req), body(req), req.ip); }));

// ── recipes and food cost (migration 0179) ──
router.post('/settings/costs', h(function (req) { return costs.tab(posToken(req), body(req), req.ip); }));

// ── guests' feedback from their receipt (migration 0180) ──
router.get('/receipt/:token/feedback', h(function (req) { return feedback.ask(req.params.token); }));
router.post('/receipt/:token/feedback', h(function (req) { return feedback.give(req.params.token, body(req), req.ip); }));
router.post('/settings/feedback', h(function (req) { return feedback.tab(posToken(req), body(req), req.ip); }));

// ── the ready-for-pickup board (its key as the bearer token) and the till's side of it ──
router.post('/board/hello', h(function (req) { return board.hello(body(req).key, req.ip, req.headers['user-agent']); }));
router.get('/board', h(function (req) { return board.view(posToken(req)); }));
router.get('/boards', h(function (req) { return board.list(posToken(req)); }));
router.post('/boards/pair', h(function (req) { return board.pair(posToken(req), body(req)); }));
router.post('/boards/:id/unpair', h(function (req) { return board.unpair(posToken(req), req.params.id); }));

module.exports = router;
