var express = require('express');
var { requireAuth } = require('../middleware/auth');
var payrollService = require('../services/payroll.service');

var router = express.Router();
router.use(requireAuth);

router.get('/runs', async function (req, res, next) {
  try { res.json(await payrollService.list(req.ctx, { companyId: req.query.companyId })); } catch (e) { next(e); }
});

router.get('/payslips', async function (req, res, next) {
  try { res.json(await payrollService.payslipHistory(req.ctx, req.query.employeeId, req.query.from, req.query.to)); } catch (e) { next(e); }
});

router.get('/runs/:id', async function (req, res, next) {
  try { res.json(await payrollService.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});

router.post('/runs', async function (req, res, next) {
  try { res.status(201).json(await payrollService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

router.put('/runs/:id/payslips/:employeeId', async function (req, res, next) {
  try { res.json(await payrollService.editSlip(req.ctx, req.params.id, req.params.employeeId, req.body.daysWorked)); } catch (e) { next(e); }
});

router.post('/runs/:id/approve', async function (req, res, next) {
  try { res.json(await payrollService.approve(req.ctx, req.params.id)); } catch (e) { next(e); }
});

router.post('/runs/:id/paid', async function (req, res, next) {
  try { res.json(await payrollService.markPaid(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
