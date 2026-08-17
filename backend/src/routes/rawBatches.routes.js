var express = require('express');
var { requireAuth } = require('../middleware/auth');
var rawBatchesService = require('../services/rawBatches.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await rawBatchesService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await rawBatchesService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/:id', async function (req, res, next) {
  try { res.json(await rawBatchesService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

module.exports = router;
