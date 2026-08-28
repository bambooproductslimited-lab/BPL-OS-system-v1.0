var express = require('express');
var { requireAuth } = require('../middleware/auth');
var timestationService = require('../services/timestation.service');

var router = express.Router();
router.use(requireAuth);

router.get('/preview', async function (req, res, next) {
  try { res.json(await timestationService.preview(req.ctx)); } catch (e) { next(e); }
});

router.post('/commit', async function (req, res, next) {
  try { res.json(await timestationService.commit(req.ctx, req.body.rows)); } catch (e) { next(e); }
});

router.get('/attendance/preview', async function (req, res, next) {
  try { res.json(await timestationService.previewAttendance(req.ctx, req.query.startDate, req.query.endDate)); } catch (e) { next(e); }
});

router.post('/attendance/commit', async function (req, res, next) {
  try { res.json(await timestationService.commitAttendance(req.ctx, req.body.rows)); } catch (e) { next(e); }
});

module.exports = router;
