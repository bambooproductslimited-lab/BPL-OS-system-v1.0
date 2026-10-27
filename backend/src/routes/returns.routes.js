var express = require('express');
var { requireAuth } = require('../middleware/auth');
var returns = require('../services/returns.service');
var fileStore = require('../lib/fileStore');

// Statutory returns (returns.service.js, migration 0199).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return returns.view(req.ctx, req.query); }));
router.get('/one', h(function (req) { return returns.detail(req.ctx, req.query); }));
router.put('/', h(function (req) { return returns.save(req.ctx, req.body); }));
router.post('/settle', h(function (req) { return returns.settleBefore(req.ctx, req.body); }));
router.get('/schedule', async function (req, res, next) {
  try {
    var s = await returns.schedule(req.ctx, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + s.filename + '"');
    res.send('﻿' + s.csv);
  } catch (e) { next(e); }
});
router.get('/receipt', async function (req, res, next) {
  try { var r = await returns.receiptOf(req.ctx, req.query); await fileStore.send(res, r.key, 'receipt', true); } catch (e) { next(e); }
});

module.exports = router;
