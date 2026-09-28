var express = require('express');
var { requireAuth } = require('../middleware/auth');
var payrollService = require('../services/payroll.service');

var router = express.Router();
router.use(requireAuth);

router.get('/runs', async function (req, res, next) {
  try { res.json(await payrollService.list(req.ctx, { companyId: req.query.companyId })); } catch (e) { next(e); }
});

// Who pays PAYE: the staff, or (company policy) the company itself.
router.get('/paye-policy', async function (req, res, next) {
  try { res.json(await payrollService.payePolicy(req.ctx)); } catch (e) { next(e); }
});
router.put('/paye-policy/:companyId', async function (req, res, next) {
  try { res.json(await payrollService.setPayePolicy(req.ctx, req.params.companyId, req.body && req.body.paysStaffPaye)); } catch (e) { next(e); }
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
  try { res.json(await payrollService.editSlip(req.ctx, req.params.id, req.params.employeeId, req.body.daysWorked, req.body)); } catch (e) { next(e); }
});

router.delete('/runs/:id', async function (req, res, next) {
  try { res.json(await payrollService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/runs/:id/approve', async function (req, res, next) {
  try { res.json(await payrollService.approve(req.ctx, req.params.id)); } catch (e) { next(e); }
});

router.post('/runs/:id/paid', async function (req, res, next) {
  try { res.json(await payrollService.markPaid(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
