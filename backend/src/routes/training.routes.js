var express = require('express');
var { requireAuth } = require('../middleware/auth');
var training = require('../services/training.service');
var fileStore = require('../lib/fileStore');

// Training and certificates (training.service.js, migration 0198).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return training.overview(req.ctx, req.query); }));
router.get('/mine', h(function (req) { return training.mine(req.ctx); }));
router.get('/people/:id', h(function (req) { return training.person(req.ctx, req.params.id); }));
router.post('/certs', h(function (req) { return training.saveCert(req.ctx, req.body); }));
router.post('/certs/:id/verify', h(function (req) { return training.verify(req.ctx, req.params.id); }));
router.delete('/certs/:id', h(function (req) { return training.removeCert(req.ctx, req.params.id); }));
router.get('/certs/:id/photo', async function (req, res, next) {
  try { var ph = await training.photoKey(req.ctx, req.params.id); await fileStore.send(res, ph.key, 'certificate', true); } catch (e) { next(e); }
});
router.post('/types', h(function (req) { return training.saveType(req.ctx, req.body); }));
router.post('/sessions', h(function (req) { return training.saveSession(req.ctx, req.body); }));
router.get('/sessions/:id', h(function (req) { return training.session(req.ctx, req.params.id); }));
router.post('/sessions/:id/attendance', h(function (req) { return training.attendance(req.ctx, req.params.id, req.body); }));

module.exports = router;
