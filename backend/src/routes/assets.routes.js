var express = require('express');
var { requireAuth } = require('../middleware/auth');
var assetsService = require('../services/assets.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await assetsService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await assetsService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

// PUT /api/assets/:id — change any detail (only the fields sent change)
router.put('/:id', async function (req, res, next) {
  try { res.json(await assetsService.update(req.ctx, req.params.id, req.body || {})); } catch (e) { next(e); }
});

module.exports = router;
