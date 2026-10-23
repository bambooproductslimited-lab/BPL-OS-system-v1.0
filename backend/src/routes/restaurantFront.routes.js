var express = require('express');
var bookings = require('../services/restaurantBookings.service');
var displays = require('../services/restaurantDisplays.service');
var loyalty = require('../services/restaurantLoyalty.service');
var gifts = require('../services/restaurantGiftCards.service');
var access = require('../services/restaurantTillAccess.service');

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

module.exports = router;
