var express = require('express');
var { requireAuth } = require('../middleware/auth');
var catalogService = require('../services/catalog.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await catalogService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await catalogService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/:id', async function (req, res, next) {
  try { res.json(await catalogService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/:id/active', async function (req, res, next) {
  try { res.json(await catalogService.setActive(req.ctx, req.params.id, req.body.active)); } catch (e) { next(e); }
});
router.delete('/:id', async function (req, res, next) {
  try { res.json(await catalogService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
