var express = require('express');
var { requireAuth } = require('../middleware/auth');
var tasksService = require('../services/tasks.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['tasks.list'] -> GET /api/tasks?scope=&status=&q=
router.get('/', async function (req, res, next) {
  try { res.json(await tasksService.list(req.ctx, req.query)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.create'] -> POST /api/tasks
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await tasksService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.get'] -> GET /api/tasks/:id
router.get('/:id', async function (req, res, next) {
  try { res.json(await tasksService.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.update'] -> PATCH /api/tasks/:id
router.patch('/:id', async function (req, res, next) {
  try { res.json(await tasksService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.delete'] -> DELETE /api/tasks/:id
router.delete('/:id', async function (req, res, next) {
  try { res.json(await tasksService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.setStatus'] -> POST /api/tasks/:id/status
router.post('/:id/status', async function (req, res, next) {
  try { res.json(await tasksService.setStatus(req.ctx, req.params.id, req.body.status)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.addComment'] -> POST /api/tasks/:id/comments
router.post('/:id/comments', async function (req, res, next) {
  try { res.status(201).json(await tasksService.addComment(req.ctx, req.params.id, req.body.body)); } catch (e) { next(e); }
});

module.exports = router;
