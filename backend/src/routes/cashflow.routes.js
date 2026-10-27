var express = require('express');
var { requireAuth } = require('../middleware/auth');
var cashflow = require('../services/cashflow.service');

// Cash flow forecast (cashflow.service.js, migration 0197).
var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await cashflow.forecast(req.ctx, req.query)); } catch (e) { next(e); }
});
router.put('/balance', async function (req, res, next) {
  try { res.json(await cashflow.saveBalance(req.ctx, req.body)); } catch (e) { next(e); }
});
router.post('/items', async function (req, res, next) {
  try { res.json(await cashflow.addItem(req.ctx, req.body)); } catch (e) { next(e); }
});
router.delete('/items/:id', async function (req, res, next) {
  try { res.json(await cashflow.removeItem(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
