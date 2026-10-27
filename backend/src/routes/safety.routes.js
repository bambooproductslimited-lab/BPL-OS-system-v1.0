var express = require('express');
var { requireAuth } = require('../middleware/auth');
var safety = require('../services/safety.service');
var fileStore = require('../lib/fileStore');

// Health and safety (safety.service.js, migration 0199).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return safety.overview(req.ctx, req.query); }));
router.get('/mine', h(function (req) { return safety.mine(req.ctx); }));
router.post('/', h(function (req) { return safety.report(req.ctx, req.body); }));
router.post('/actions/:id', h(function (req) { return safety.doneAction(req.ctx, req.params.id, req.body); }));
router.get('/:id', h(function (req) { return safety.get(req.ctx, req.params.id); }));
router.put('/:id', h(function (req) { return safety.update(req.ctx, req.params.id, req.body); }));
router.post('/:id/actions', h(function (req) { return safety.addAction(req.ctx, req.params.id, req.body); }));
router.post('/:id/close', h(function (req) { return safety.close(req.ctx, req.params.id, false); }));
router.post('/:id/reopen', h(function (req) { return safety.close(req.ctx, req.params.id, true); }));
router.get('/:id/photos/:n', async function (req, res, next) {
  try { var ph = await safety.photoKey(req.ctx, req.params.id, req.params.n); await fileStore.send(res, ph.key, 'incident', true); } catch (e) { next(e); }
});

module.exports = router;
