var express = require('express');
var { requireAuth } = require('../middleware/auth');
var receiptsService = require('../services/receipts.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await receiptsService.list(req.ctx)); } catch (e) { next(e); }
});

module.exports = router;
