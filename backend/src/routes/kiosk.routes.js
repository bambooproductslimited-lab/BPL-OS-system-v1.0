var express = require('express');
var kioskService = require('../services/kiosk.service');

// The clock-in/out kiosk's own endpoint — mounted at /api/kiosk in app.js,
// separate from every other router (all of which sit behind requireAuth).
// This one is deliberately public: the iPad station has no logged-in user
// at all, only a 4-digit PIN typed by whoever is standing at it. See
// kiosk.service.js for the rate limiting and PIN-hash lookup that keep
// this safe to leave unauthenticated.

var router = express.Router();

router.post('/clock', async function (req, res, next) {
  try { res.json(await kioskService.clock(req.body.pin, req.ip, req.body.occurredAt, req.body.location)); } catch (e) { next(e); }
});

module.exports = router;
