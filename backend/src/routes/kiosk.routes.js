var express = require('express');
var kioskService = require('../services/kiosk.service');

// The clock-in/out kiosk's own endpoint — mounted at /api/kiosk in app.js,
// separate from every other router (all of which sit behind requireAuth).
// This one is deliberately public: the iPad station has no logged-in user
// at all, only a 4-digit PIN typed by whoever is standing at it. See
// kiosk.service.js for the rate limiting and PIN-hash lookup that keep
// this safe to leave unauthenticated.

var router = express.Router();

router.post('/identify', async function (req, res, next) {
  try { res.json(await kioskService.identify(req.body.pin, req.ip)); } catch (e) { next(e); }
});

router.post('/clock', async function (req, res, next) {
  try {
    res.json(await kioskService.clock(req.body.pin, req.ip, req.body.occurredAt, req.body.location, req.body.faceDescriptor));
  } catch (e) { next(e); }
});

// Face self-enrollment link — also deliberately public, same reasoning as
// the rest of this router: the employee opening this on their own phone
// has no logged-in session either. The token itself is the authorization
// (see migration 0055 and kiosk.service.js's module comment on why it's
// single-use and always expiring).
router.get('/face-enroll/:token', async function (req, res, next) {
  try { res.json(await kioskService.getFaceEnrollTarget(req.params.token)); } catch (e) { next(e); }
});
router.post('/face-enroll/:token', async function (req, res, next) {
  try { res.json(await kioskService.enrollFaceViaLink(req.params.token, req.body.descriptors)); } catch (e) { next(e); }
});

module.exports = router;
