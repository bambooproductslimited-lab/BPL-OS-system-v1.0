var express = require('express');
var { requireAuth } = require('../middleware/auth');
var attendanceService = require('../services/attendance.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['attendance.clockIn'] -> POST /api/attendance/clock-in
router.post('/clock-in', async function (req, res, next) {
  try { res.status(201).json(await attendanceService.clockIn(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['attendance.clockOut'] -> POST /api/attendance/clock-out
router.post('/clock-out', async function (req, res, next) {
  try { res.json(await attendanceService.clockOut(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['attendance.adjust'] -> POST /api/attendance/adjust
router.post('/adjust', async function (req, res, next) {
  try { res.json(await attendanceService.adjust(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['attendance.list'] -> GET /api/attendance?date=
router.get('/', async function (req, res, next) {
  try { res.json(await attendanceService.list(req.ctx, { date: req.query.date })); } catch (e) { next(e); }
});

// kernel.js: handlers['attendance.report'] -> GET /api/attendance/report?from=&to=
router.get('/report', async function (req, res, next) {
  try { res.json(await attendanceService.report(req.ctx, req.query.from, req.query.to)); } catch (e) { next(e); }
});

// kernel.js: handlers['attendance.delete'] -> DELETE /api/attendance/:id
router.delete('/:id', async function (req, res, next) {
  try { res.json(await attendanceService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
