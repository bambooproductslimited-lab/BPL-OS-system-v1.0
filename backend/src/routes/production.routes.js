var express = require('express');
var { requireAuth } = require('../middleware/auth');
var productionService = require('../services/production.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await productionService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await productionService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

module.exports = router;
