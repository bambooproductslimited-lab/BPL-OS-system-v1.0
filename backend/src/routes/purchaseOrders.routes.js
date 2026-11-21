var express = require('express');
var { requireAuth } = require('../middleware/auth');
var po = require('../services/purchaseOrders.service');

// Purchase orders to suppliers and bamboo farmers (migration 0219).
var router = express.Router();
router.use(requireAuth);

function run(fn, status) {
  return async function (req, res, next) {
    try { res.status(status || 200).json(await fn(req)); } catch (e) { next(e); }
  };
}

router.get('/', run(function (req) { return po.list(req.ctx); }));
router.post('/', run(function (req) { return po.create(req.ctx, req.body); }, 201));
router.get('/:id', run(function (req) { return po.get(req.ctx, req.params.id); }));
router.patch('/:id', run(function (req) { return po.update(req.ctx, req.params.id, req.body); }));
router.post('/:id/status', run(function (req) { return po.setStatus(req.ctx, req.params.id, req.body); }));
router.delete('/:id', run(function (req) { return po.remove(req.ctx, req.params.id); }));

module.exports = router;
