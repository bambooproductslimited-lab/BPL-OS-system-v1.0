var express = require('express');
var restaurantPosService = require('../services/restaurantPos.service');

// The till's own endpoints — mounted at /api/pos in app.js, deliberately
// public like /api/kiosk (see kiosk.routes.js's comment): no logged-in
// user, just a 4-digit PIN and then a short-lived till-session token this
// router itself issues and checks (posAuth below), not the app's normal
// requireAuth/req.ctx.

var router = express.Router();

function posAuth(req, res, next) {
  var header = req.headers.authorization || '';
  var token = header.indexOf('Bearer ') === 0 ? header.slice(7) : null;
  req.posToken = token;
  next();
}

router.post('/login', async function (req, res, next) {
  try { res.json(await restaurantPosService.login(req.body.pin, req.ip)); } catch (e) { next(e); }
});

router.get('/menu', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.menuForSession(req.posToken)); } catch (e) { next(e); }
});

router.get('/menu/mostly-bought', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.mostlyBought(req.posToken)); } catch (e) { next(e); }
});

router.post('/menu-items/:id/favorite', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.toggleFavorite(req.posToken, req.params.id)); } catch (e) { next(e); }
});

router.post('/orders', posAuth, async function (req, res, next) {
  try { res.status(201).json(await restaurantPosService.createOrder(req.posToken, req.body)); } catch (e) { next(e); }
});

router.get('/drawer', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.getOpenDrawerSession(req.posToken)); } catch (e) { next(e); }
});
router.post('/drawer/open', posAuth, async function (req, res, next) {
  try { res.status(201).json(await restaurantPosService.openDrawerSession(req.posToken, req.body.startingCash)); } catch (e) { next(e); }
});
router.post('/drawer/movements', posAuth, async function (req, res, next) {
  try { res.status(201).json(await restaurantPosService.addDrawerMovement(req.posToken, req.body)); } catch (e) { next(e); }
});
router.post('/drawer/close', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.closeDrawerSession(req.posToken, req.body)); } catch (e) { next(e); }
});

router.get('/tables', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.tablesForSession(req.posToken)); } catch (e) { next(e); }
});
router.get('/waiters', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.waitersForSession(req.posToken)); } catch (e) { next(e); }
});
router.get('/guests', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.guestsForSession(req.posToken, req.query.q)); } catch (e) { next(e); }
});
router.post('/guests', posAuth, async function (req, res, next) {
  try { res.status(201).json(await restaurantPosService.createGuestForSession(req.posToken, req.body)); } catch (e) { next(e); }
});

module.exports = router;
