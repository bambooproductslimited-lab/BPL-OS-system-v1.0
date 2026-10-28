var express = require('express');
var { requireAuth } = require('../middleware/auth');
var fileStore = require('../lib/fileStore');
var rfqs = require('../services/rfqs.service');

// Requests for quotes (rfqs.service.js, migration 0203).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return rfqs.overview(req.ctx, req.query); }));
router.get('/options', h(function (req) { return rfqs.options(req.ctx); }));
router.post('/', h(function (req) { return rfqs.create(req.ctx, req.body); }));
router.get('/:id', h(function (req) { return rfqs.get(req.ctx, req.params.id); }));
router.post('/:id/suppliers', h(function (req) { return rfqs.addSuppliers(req.ctx, req.params.id, req.body); }));
router.post('/:id/send', h(function (req) { return rfqs.send(req.ctx, req.params.id, req.body); }));
router.post('/:id/quote', h(function (req) { return rfqs.quote(req.ctx, req.params.id, req.body); }));
router.post('/:id/award', h(function (req) { return rfqs.award(req.ctx, req.params.id, req.body); }));
router.post('/:id/cancel', h(function (req) { return rfqs.cancel(req.ctx, req.params.id, req.body); }));
router.get('/:id/file/:rfqSupplierId', async function (req, res, next) {
  try { var f = await rfqs.fileOf(req.ctx, req.params.id, req.params.rfqSupplierId); await fileStore.send(res, f.key, f.name, true); } catch (e) { next(e); }
});

module.exports = router;
