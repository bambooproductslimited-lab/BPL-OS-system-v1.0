var express = require('express');
var { requireAuth } = require('../middleware/auth');
var shiftsService = require('../services/shifts.service');

var router = express.Router();
router.use(requireAuth);

// GET /api/shifts?departmentId= — all shifts, or one department's.
router.get('/', async function (req, res, next) {
  try { res.json(await shiftsService.list(req.ctx, req.query.departmentId)); } catch (e) { next(e); }
});

router.post('/', async function (req, res, next) {
  try { res.status(201).json(await shiftsService.save(req.ctx, null, req.body)); } catch (e) { next(e); }
});

router.put('/:id', async function (req, res, next) {
  try { res.json(await shiftsService.save(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

router.delete('/:id', async function (req, res, next) {
  try { res.json(await shiftsService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
