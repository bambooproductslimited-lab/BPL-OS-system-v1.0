var express = require('express');
var { requireAuth } = require('../middleware/auth');
var warehousesService = require('../services/warehouses.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await warehousesService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await warehousesService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/:id', async function (req, res, next) {
  try { res.json(await warehousesService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/:id', async function (req, res, next) {
  try { res.json(await warehousesService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
