var express = require('express');
var { requireAuth } = require('../middleware/auth');
var estimatesService = require('../services/estimates.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await estimatesService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await estimatesService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/:id', async function (req, res, next) {
  try { res.json(await estimatesService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/:id', async function (req, res, next) {
  try { res.json(await estimatesService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/:id/status', async function (req, res, next) {
  try { res.json(await estimatesService.setStatus(req.ctx, req.params.id, req.body.status)); } catch (e) { next(e); }
});
router.post('/:id/convert', async function (req, res, next) {
  try { res.status(201).json(await estimatesService.convertToQuotation(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
