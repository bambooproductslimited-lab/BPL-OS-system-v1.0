var express = require('express');
var { requireAuth } = require('../middleware/auth');
var procurementService = require('../services/procurement.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['procurement.list'] -> GET /api/procurement
router.get('/', async function (req, res, next) {
  try { res.json(await procurementService.list(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['procurement.request'] -> POST /api/procurement
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await procurementService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['procurement.decide'] -> POST /api/procurement/:id/decision
router.post('/:id/decision', async function (req, res, next) {
  try { res.json(await procurementService.decide(req.ctx, req.params.id, req.body.decision, req.body.note)); } catch (e) { next(e); }
});

// POST /api/procurement/:id/cancel — the requester takes it back while pending
router.post('/:id/cancel', async function (req, res, next) {
  try { res.json(await procurementService.cancel(req.ctx, req.params.id)); } catch (e) { next(e); }
});
// POST /api/procurement/:id/order { supplierId?, supplierName?, actualCost? }
router.post('/:id/order', async function (req, res, next) {
  try { res.json(await procurementService.markOrdered(req.ctx, req.params.id, req.body || {})); } catch (e) { next(e); }
});
// POST /api/procurement/:id/receive { actualCost? }
router.post('/:id/receive', async function (req, res, next) {
  try { res.json(await procurementService.markReceived(req.ctx, req.params.id, req.body || {})); } catch (e) { next(e); }
});

module.exports = router;
