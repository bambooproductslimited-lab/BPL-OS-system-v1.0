var express = require('express');
var printers = require('../services/restaurantPrinters.service');

// Star CloudPRNT: the restaurant's network printers ask here for their
// tickets (services/restaurantPrinters.service.js). The link carries the
// restaurant's own printer token — the printer's "server URL", set in the
// printer's own settings — so no sign-in: a printer cannot sign in.
//   POST   {link}  the printer asks whether there is work (every 5 seconds)
//   GET    {link}?mac=…&type=image/png&token=…  it takes its ticket
//   DELETE {link}?mac=…&code=200%20OK&token=…  printed (or why not)
// Older printers say "printed" with a GET carrying delete=1.
var router = express.Router();

router.post('/:token', async function (req, res, next) {
  try { res.json(await printers.poll(req.params.token, req.body, req.ip)); } catch (e) { next(e); }
});
router.get('/:token', async function (req, res, next) {
  try {
    if (req.query.delete) { res.json(await printers.finishJob(req.params.token, req.query)); return; }
    var job = await printers.fetchJob(req.params.token, req.query);
    if (!job) { res.status(204).end(); return; }
    Object.keys(job.headers).forEach(function (h) { res.setHeader(h, job.headers[h]); });
    res.end(job.body);
  } catch (e) { next(e); }
});
router.delete('/:token', async function (req, res, next) {
  try { res.json(await printers.finishJob(req.params.token, req.query)); } catch (e) { next(e); }
});

module.exports = router;
