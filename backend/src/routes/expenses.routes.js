var express = require('express');
var { requireAuth } = require('../middleware/auth');
var expensesService = require('../services/expenses.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await expensesService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await expensesService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.patch('/:id', async function (req, res, next) {
  try { res.json(await expensesService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/:id', async function (req, res, next) {
  try { res.json(await expensesService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/:id/decision', async function (req, res, next) {
  try { res.json(await expensesService.decide(req.ctx, req.params.id, req.body.decision)); } catch (e) { next(e); }
});
router.post('/:id/mark-paid', async function (req, res, next) {
  try { res.json(await expensesService.markPaid(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
