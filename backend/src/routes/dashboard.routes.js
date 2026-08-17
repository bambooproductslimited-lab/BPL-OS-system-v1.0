var express = require('express');
var { requireAuth } = require('../middleware/auth');
var dashboardService = require('../services/dashboard.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['dashboard.load'] -> GET /api/dashboard
router.get('/', async function (req, res, next) {
  try { res.json(await dashboardService.load(req.ctx)); } catch (e) { next(e); }
});

module.exports = router;
