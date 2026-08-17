var express = require('express');
var { requireAuth } = require('../middleware/auth');
var productsService = require('../services/products.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await productsService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await productsService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/:id', async function (req, res, next) {
  try { res.json(await productsService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

module.exports = router;
