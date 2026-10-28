var express = require('express');
var { requireAuth } = require('../middleware/auth');
var fileStore = require('../lib/fileStore');
var licences = require('../services/licences.service');

// Licences and permits (licences.service.js, migration 0201).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return licences.overview(req.ctx, req.query); }));
router.post('/', h(function (req) { return licences.save(req.ctx, null, req.body); }));
router.get('/:id', h(function (req) { return licences.get(req.ctx, req.params.id); }));
router.put('/:id', h(function (req) { return licences.save(req.ctx, req.params.id, req.body); }));
router.post('/:id/applied', h(function (req) { return licences.applied(req.ctx, req.params.id, req.body); }));
router.post('/:id/renew', h(function (req) { return licences.renew(req.ctx, req.params.id, req.body); }));
router.post('/:id/close', h(function (req) { return licences.setClosed(req.ctx, req.params.id, true, req.body); }));
router.post('/:id/reopen', h(function (req) { return licences.setClosed(req.ctx, req.params.id, false, req.body); }));
router.get('/:id/files/:n', async function (req, res, next) {
  try { var f = await licences.fileOf(req.ctx, req.params.id, req.params.n, req.query.renewal); await fileStore.send(res, f.key, f.name, true); } catch (e) { next(e); }
});

module.exports = router;
