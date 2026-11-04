var express = require('express');
var hub = require('../services/restaurantPrintHub.service');

// The Bamboo print hub (tools/print-hub): asks every few seconds on the
// restaurant's printer link — the printers it found on the network, what it
// printed, and the next tickets (services/restaurantPrintHub.service.js).
// The link carries the restaurant's printer token, so no sign-in.
var router = express.Router();

router.post('/:token', async function (req, res, next) {
  try { res.json(await hub.poll(req.params.token, req.body, req.ip)); } catch (e) { next(e); }
});

module.exports = router;
