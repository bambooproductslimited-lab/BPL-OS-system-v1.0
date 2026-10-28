var express = require('express');
var { requireAuth } = require('../middleware/auth');
var fileStore = require('../lib/fileStore');
var policies = require('../services/policies.service');

// Policies to read and sign (policies.service.js, migration 0201).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return policies.overview(req.ctx); }));
router.get('/mine', h(function (req) { return policies.mine(req.ctx); }));
router.post('/', h(function (req) { return policies.save(req.ctx, null, req.body); }));
router.get('/:id', h(function (req) { return policies.get(req.ctx, req.params.id); }));
router.put('/:id', h(function (req) { return policies.save(req.ctx, req.params.id, req.body); }));
router.post('/:id/publish', h(function (req) { return policies.publish(req.ctx, req.params.id); }));
router.post('/:id/retire', h(function (req) { return policies.retire(req.ctx, req.params.id); }));
router.post('/:id/sign', h(function (req) { return policies.sign(req.ctx, req.params.id, req.body); }));
router.post('/:id/remind', h(function (req) { return policies.remind(req.ctx, req.params.id); }));
router.get('/:id/file', async function (req, res, next) {
  try { var f = await policies.fileOf(req.ctx, req.params.id, req.query.version); await fileStore.send(res, f.key, f.name, true); } catch (e) { next(e); }
});

module.exports = router;
