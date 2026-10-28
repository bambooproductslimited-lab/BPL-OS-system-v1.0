var express = require('express');
var { requireAuth } = require('../middleware/auth');
var report = require('../services/managementReport.service');

// The monthly management report (managementReport.service.js, migration 0203).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return report.view(req.ctx, req.query); }));
router.get('/pdf', async function (req, res, next) {
  try {
    var out = await report.pdf(req.ctx, req.query);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + out.name.replace(/[^\w .-]/g, '') + '"');
    res.send(out.buffer);
  } catch (e) { next(e); }
});
router.post('/send', h(function (req) { return report.send(req.ctx, req.body); }));
router.put('/settings', h(function (req) { return report.saveSettings(req.ctx, req.body); }));

module.exports = router;
