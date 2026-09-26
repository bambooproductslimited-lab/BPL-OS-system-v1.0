var express = require('express');
var { requireAuth } = require('../middleware/auth');
var squareImportService = require('../services/squareImport.service');

var router = express.Router();
router.use(requireAuth);

// The Square import (squareImport.service.js) runs in the background:
// POST starts it and answers at once (202); GET shows the latest import's
// progress. Safe to run more than once: every row it writes is upserted by
// its Square id.
router.post('/import', async function (req, res, next) {
  try { res.status(202).json(await squareImportService.startImport(req.ctx)); } catch (e) { next(e); }
});
router.get('/import', async function (req, res, next) {
  try { res.json(await squareImportService.jobStatus(req.ctx)); } catch (e) { next(e); }
});

module.exports = router;
