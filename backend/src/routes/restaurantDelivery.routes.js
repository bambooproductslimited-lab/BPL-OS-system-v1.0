var express = require('express');
var delivery = require('../services/restaurantDelivery.service');
var online = require('../services/restaurantOnline.service');

// Deliveries and the website's orders (migration 0159) — mounted at
// /api/pos in app.js beside the till's own routes, so the delivery screen
// and the website reach them from their own addresses
// (config.restaurantSiteOrigins). Three kinds of caller:
//   the delivery screen and the till — a till-session token (PIN sign-in);
//   a rider — the link they were sent, /rider/:token;
//   a customer — no sign-in to order; their order's link, /online/track/:token.

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

// ── the maps: which one to draw (Google's with the server's key, or OpenStreetMap's) ──
router.get('/map', h(function () { return delivery.mapConfig(); }));

// ── the delivery screen ──
router.get('/delivery/board', h(function (req) { return delivery.board(posToken(req)); }));
router.post('/delivery/open', h(function (req) { return delivery.setOpen(posToken(req), body(req).open); }));
router.post('/delivery/settings', h(function (req) { return delivery.settings(posToken(req), body(req), req.ip); }));
router.post('/delivery/riders', h(function (req) { return delivery.riders(posToken(req), body(req)); }));
router.post('/delivery/send', h(function (req) { return delivery.send(posToken(req), body(req)); }));
router.post('/delivery/online/:id/accept', h(function (req) { return online.accept(posToken(req), req.params.id, body(req)); }));
router.post('/delivery/online/:id/reject', h(function (req) { return online.reject(posToken(req), req.params.id, body(req)); }));
router.post('/delivery/:id/status', h(function (req) { return delivery.setStatus(posToken(req), req.params.id, body(req)); }));
router.post('/delivery/:id/rider', h(function (req) { return delivery.reassign(posToken(req), req.params.id, body(req)); }));
// The cashier takes the money a rider brought back: the order charged into their drawer.
router.post('/delivery/:id/hand-in', h(function (req) { return delivery.handIn(posToken(req), req.params.id, body(req)); }));

// ── a rider's link ──
router.get('/rider/:token', h(function (req) { return delivery.riderView(req.params.token); }));
router.post('/rider/:token/location', h(function (req) { return delivery.riderLocation(req.params.token, body(req)); }));
router.post('/rider/:token/status', h(function (req) { return delivery.riderStatus(req.params.token, body(req)); }));

// ── the website ──
router.get('/online/:code/menu', h(function (req) { return online.menu(req.params.code); }));
router.post('/online/:code/orders', h(function (req) { return online.place(req.params.code, body(req), req.ip); }));
router.get('/online/track/:token', h(function (req) { return online.track(req.params.token); }));
router.post('/online/track/:token/cancel', h(function (req) { return online.cancel(req.params.token); }));

module.exports = router;
