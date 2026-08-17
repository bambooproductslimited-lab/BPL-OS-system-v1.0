var express = require('express');
var { requireAuth } = require('../middleware/auth');
var departmentsService = require('../services/departments.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['departments.list'] -> GET /api/departments
router.get('/', async function (req, res, next) {
  try { res.json(await departmentsService.list(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['departments.save'] (create) -> POST /api/departments
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await departmentsService.save(req.ctx, null, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['departments.save'] (update) -> PUT /api/departments/:id
router.put('/:id', async function (req, res, next) {
  try { res.json(await departmentsService.save(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['departments.delete'] -> DELETE /api/departments/:id
router.delete('/:id', async function (req, res, next) {
  try { res.json(await departmentsService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
