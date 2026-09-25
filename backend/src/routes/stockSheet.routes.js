var express = require('express');
var { requireAuth } = require('../middleware/auth');
var stockSheetService = require('../services/stockSheet.service');

// The daily stock sheet and monthly summary — see stockSheet.service.js.
var router = express.Router();
router.use(requireAuth);

router.get('/day/:date', async function (req, res, next) {
  try { res.json(await stockSheetService.getDay(req.ctx, req.params.date)); } catch (e) { next(e); }
});
router.put('/day/:date/lines/:productId', async function (req, res, next) {
  try { res.json(await stockSheetService.saveLine(req.ctx, req.params.date, req.params.productId, req.body)); } catch (e) { next(e); }
});
router.put('/day/:date', async function (req, res, next) {
  try { res.json(await stockSheetService.saveDay(req.ctx, req.params.date, req.body.lines)); } catch (e) { next(e); }
});
// GET /api/stock-sheet/days?to=YYYY-MM-DD&n=14 — a few days at a glance
router.get('/days', async function (req, res, next) {
  try { res.json(await stockSheetService.days(req.ctx, req.query.to, req.query.n)); } catch (e) { next(e); }
});
router.get('/months', async function (req, res, next) {
  try { res.json(await stockSheetService.months(req.ctx)); } catch (e) { next(e); }
});
router.get('/month/:month', async function (req, res, next) {
  try { res.json(await stockSheetService.month(req.ctx, req.params.month)); } catch (e) { next(e); }
});

module.exports = router;
