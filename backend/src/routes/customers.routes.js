var express = require('express');
var { requireAuth } = require('../middleware/auth');
var customersService = require('../services/customers.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await customersService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await customersService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/:id', async function (req, res, next) {
  try { res.json(await customersService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/:id/category', async function (req, res, next) {
  try { res.json(await customersService.setCategory(req.ctx, req.params.id, req.body.category)); } catch (e) { next(e); }
});
router.delete('/:id', async function (req, res, next) {
  try { res.json(await customersService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
