var express = require('express');
var { requireAuth } = require('../middleware/auth');
var documentsService = require('../services/documents.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['documents.list'] -> GET /api/documents
router.get('/', async function (req, res, next) {
  try { res.json(await documentsService.list(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['documents.upload'] -> POST /api/documents
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await documentsService.upload(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['documents.delete'] -> DELETE /api/documents/:id
router.delete('/:id', async function (req, res, next) {
  try { res.json(await documentsService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
