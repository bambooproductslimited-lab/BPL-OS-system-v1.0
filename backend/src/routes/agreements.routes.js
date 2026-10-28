var express = require('express');
var { requireAuth } = require('../middleware/auth');
var agreements = require('../services/agreements.service');
var fileStore = require('../lib/fileStore');

// The agreements register: leases and contracts (agreements.service.js,
// migration 0205).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return agreements.overview(req.ctx, req.query); }));
router.post('/', h(function (req) { return agreements.save(req.ctx, null, req.body); }));
router.get('/:id', h(function (req) { return agreements.get(req.ctx, req.params.id); }));
router.put('/:id', h(function (req) { return agreements.save(req.ctx, req.params.id, req.body); }));
router.post('/:id/renew', h(function (req) { return agreements.renew(req.ctx, req.params.id, req.body); }));
router.post('/:id/intent', h(function (req) { return agreements.setIntent(req.ctx, req.params.id, req.body); }));
router.post('/:id/end', h(function (req) { return agreements.setEnded(req.ctx, req.params.id, true, req.body); }));
router.post('/:id/reopen', h(function (req) { return agreements.setEnded(req.ctx, req.params.id, false, req.body); }));
router.get('/:id/files/:n', async function (req, res, next) {
  try {
    var f = await agreements.fileOf(req.ctx, req.params.id, req.params.n, req.query.period);
    await fileStore.send(res, f.key, f.name, true);
  } catch (e) { next(e); }
});

module.exports = router;
