var express = require('express');
var { requireAuth } = require('../middleware/auth');
var salesOrdersService = require('../services/salesOrders.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await salesOrdersService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await salesOrdersService.createFromQuotation(req.ctx, req.body.quotationId)); } catch (e) { next(e); }
});
router.post('/:id/status', async function (req, res, next) {
  try { res.json(await salesOrdersService.setStatus(req.ctx, req.params.id, req.body.status)); } catch (e) { next(e); }
});

module.exports = router;
