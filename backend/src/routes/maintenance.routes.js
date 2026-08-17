var express = require('express');
var { requireAuth } = require('../middleware/auth');
var maintenanceService = require('../services/maintenance.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await maintenanceService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await maintenanceService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

module.exports = router;
