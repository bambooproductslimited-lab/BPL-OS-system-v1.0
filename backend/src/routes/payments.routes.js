var express = require('express');
var { requireAuth } = require('../middleware/auth');
var paymentsService = require('../services/payments.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await paymentsService.list(req.ctx)); } catch (e) { next(e); }
});
router.delete('/:id', async function (req, res, next) {
  try { res.json(await paymentsService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
