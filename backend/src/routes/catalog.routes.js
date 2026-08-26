var express = require('express');
var { requireAuth } = require('../middleware/auth');
var catalogService = require('../services/catalog.service');

var router = express.Router();
router.use(requireAuth);

// Flat picker list — Quotations/Estimates/Invoices/Waybills "from
// catalogue" dropdowns; unchanged shape from before the Item/Variation
// redesign so those screens needed no changes.
router.get('/', async function (req, res, next) {
  try { res.json(await catalogService.list(req.ctx)); } catch (e) { next(e); }
});

// Nested Item -> Variations view, for the Products & Services screen itself.
router.get('/items', async function (req, res, next) {
  try { res.json(await catalogService.listItems(req.ctx)); } catch (e) { next(e); }
});
router.post('/items', async function (req, res, next) {
  try { res.status(201).json(await catalogService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/items/:id', async function (req, res, next) {
  try { res.json(await catalogService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/items/:id/active', async function (req, res, next) {
  try { res.json(await catalogService.setActive(req.ctx, req.params.id, req.body.active)); } catch (e) { next(e); }
});
router.delete('/items/:id', async function (req, res, next) {
  try { res.json(await catalogService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/items/:id/variations', async function (req, res, next) {
  try { res.status(201).json(await catalogService.addVariation(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

router.put('/variations/:id', async function (req, res, next) {
  try { res.json(await catalogService.updateVariation(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/variations/:id/active', async function (req, res, next) {
  try { res.json(await catalogService.setVariationActive(req.ctx, req.params.id, req.body.active)); } catch (e) { next(e); }
});
router.delete('/variations/:id', async function (req, res, next) {
  try { res.json(await catalogService.removeVariation(req.ctx, req.params.id)); } catch (e) { next(e); }
});

router.get('/categories', async function (req, res, next) {
  try { res.json(await catalogService.listCategories(req.ctx)); } catch (e) { next(e); }
});
router.post('/categories', async function (req, res, next) {
  try { res.status(201).json(await catalogService.createCategory(req.ctx, req.body.name)); } catch (e) { next(e); }
});

module.exports = router;
