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

// kernel.js: handlers['attendance.list'] -> GET /api/attendance?date=&companyId=&departmentId=
router.get('/', async function (req, res, next) {
  try {
    res.json(await attendanceService.list(req.ctx, { date: req.query.date, companyId: req.query.companyId, departmentId: req.query.departmentId }));
  } catch (e) { next(e); }
});

// kernel.js: handlers['attendance.report'] -> GET /api/attendance/report?from=&to=&companyId=&departmentId=
router.get('/report', async function (req, res, next) {
  try {
    res.json(await attendanceService.report(req.ctx, req.query.from, req.query.to, { companyId: req.query.companyId, departmentId: req.query.departmentId }));
  } catch (e) { next(e); }
});

// kernel.js: handlers['attendance.delete'] -> DELETE /api/attendance/:id
// Who has no shift assigned — and therefore whose lateness is being judged
// against a cutoff that does not describe their working day.
router.get('/unassigned-shifts', async function (req, res, next) {
  try {
    res.json(await attendanceService.unassignedShifts(req.ctx, {
      companyId: req.query.companyId, departmentId: req.query.departmentId
    }));
  } catch (e) { next(e); }
});

router.get('/lateness', async function (req, res, next) {
  try {
    res.json(await attendanceService.latenessReport(req.ctx, req.query.from, req.query.to, {
      companyId: req.query.companyId, departmentId: req.query.departmentId
    }));
  } catch (e) { next(e); }
});

router.delete('/:id', async function (req, res, next) {
  try { res.json(await attendanceService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
