var express = require('express');
var { requireAuth } = require('../middleware/auth');
var kilns = require('../services/kilns.service');

// The kiln and treatment log (kilns.service.js, migration 0201).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return kilns.overview(req.ctx); }));
router.post('/', h(function (req) { return kilns.saveKiln(req.ctx, null, req.body); }));
router.put('/:id', h(function (req) { return kilns.saveKiln(req.ctx, req.params.id, req.body); }));
router.post('/charges', h(function (req) { return kilns.start(req.ctx, req.body); }));
router.get('/charges/:id', h(function (req) { return kilns.get(req.ctx, req.params.id); }));
router.post('/charges/:id/readings', h(function (req) { return kilns.read(req.ctx, req.params.id, req.body); }));
router.post('/charges/:id/finish', h(function (req) { return kilns.finish(req.ctx, req.params.id, req.body); }));
router.post('/charges/:id/abort', h(function (req) { return kilns.abort(req.ctx, req.params.id, req.body); }));

module.exports = router;
