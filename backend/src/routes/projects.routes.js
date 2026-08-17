var express = require('express');
var { requireAuth } = require('../middleware/auth');
var projectsService = require('../services/projects.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['projects.list'] -> GET /api/projects
router.get('/', async function (req, res, next) {
  try { res.json(await projectsService.list(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['projects.create'] -> POST /api/projects
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await projectsService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['projects.setStatus'] -> POST /api/projects/:id/status
router.post('/:id/status', async function (req, res, next) {
  try { res.json(await projectsService.setStatus(req.ctx, req.params.id, req.body.status)); } catch (e) { next(e); }
});

module.exports = router;
