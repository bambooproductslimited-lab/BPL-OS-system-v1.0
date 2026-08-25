var express = require('express');
var { requireAuth } = require('../middleware/auth');
var squareImportService = require('../services/squareImport.service');

var router = express.Router();
router.use(requireAuth);

// One-time historical import trigger — see squareImport.service.js. Safe to
// call more than once: every row it writes is upserted by external_id.
router.post('/import', async function (req, res, next) {
  try { res.json(await squareImportService.runImport(req.ctx)); } catch (e) { next(e); }
});

module.exports = router;
