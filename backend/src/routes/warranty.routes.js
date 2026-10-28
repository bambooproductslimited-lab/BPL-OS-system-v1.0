var express = require('express');
var { requireAuth } = require('../middleware/auth');
var warranty = require('../services/warranty.service');
var fileStore = require('../lib/fileStore');

// Warranty claims (warranty.service.js, migration 0205).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return warranty.overview(req.ctx); }));
router.get('/options', h(function (req) { return warranty.options(req.ctx, req.query); }));
router.post('/', h(function (req) { return warranty.create(req.ctx, req.body); }));
router.get('/:id', h(function (req) { return warranty.get(req.ctx, req.params.id); }));
router.put('/:id', h(function (req) { return warranty.update(req.ctx, req.params.id, req.body); }));
router.post('/:id/decision', h(function (req) { return warranty.decide(req.ctx, req.params.id, req.body); }));
router.post('/:id/resolve', h(function (req) { return warranty.setStatus(req.ctx, req.params.id, 'resolved', req.body); }));
router.post('/:id/close', h(function (req) { return warranty.setStatus(req.ctx, req.params.id, 'closed', req.body); }));
router.post('/:id/reopen', h(function (req) { return warranty.setStatus(req.ctx, req.params.id, 'in_hand', req.body); }));
router.get('/:id/photos/:n', async function (req, res, next) {
  try { var f = await warranty.photoKey(req.ctx, req.params.id, req.params.n); await fileStore.send(res, f.key, f.name, true); } catch (e) { next(e); }
});

module.exports = router;
