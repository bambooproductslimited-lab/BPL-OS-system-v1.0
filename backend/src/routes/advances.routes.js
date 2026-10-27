var express = require('express');
var { requireAuth } = require('../middleware/auth');
var advances = require('../services/advances.service');

// Salary advances (advances.service.js, migration 0197).
var router = express.Router();
router.use(requireAuth);

router.get('/mine', async function (req, res, next) {
  try { res.json(await advances.mine(req.ctx)); } catch (e) { next(e); }
});
router.get('/', async function (req, res, next) {
  try { res.json(await advances.list(req.ctx, req.query)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await advances.request(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/settings', async function (req, res, next) {
  try { res.json(await advances.saveSettings(req.ctx, req.body)); } catch (e) { next(e); }
});
router.get('/:id', async function (req, res, next) {
  try { res.json(await advances.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/:id/cancel', async function (req, res, next) {
  try { res.json(await advances.cancel(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/:id/decide', async function (req, res, next) {
  try { res.json(await advances.decide(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/:id/pay', async function (req, res, next) {
  try { res.json(await advances.pay(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/:id/repay', async function (req, res, next) {
  try { res.json(await advances.repayCash(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

module.exports = router;
