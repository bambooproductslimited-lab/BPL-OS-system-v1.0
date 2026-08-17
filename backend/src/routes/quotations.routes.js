var express = require('express');
var { requireAuth } = require('../middleware/auth');
var quotationsService = require('../services/quotations.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await quotationsService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await quotationsService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.post('/:id/status', async function (req, res, next) {
  try { res.json(await quotationsService.setStatus(req.ctx, req.params.id, req.body.status)); } catch (e) { next(e); }
});

module.exports = router;
