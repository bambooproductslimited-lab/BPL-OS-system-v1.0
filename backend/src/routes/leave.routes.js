var express = require('express');
var { requireAuth } = require('../middleware/auth');
var leaveService = require('../services/leave.service');

var router = express.Router();

router.use(requireAuth);

// kernel.js: handlers['leave.types'] -> GET /api/leave/types
router.get('/types', async function (req, res, next) {
  try { res.json(await leaveService.listTypes()); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.types.all'] -> GET /api/leave/types/all — the
// HR/Admin management list (includes inactive types); placed before the
// param-taking /types/:id routes below so "all" is never swallowed as an id.
router.get('/types/all', async function (req, res, next) {
  try { res.json(await leaveService.listAllTypes(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.types.create'] -> POST /api/leave/types
router.post('/types', async function (req, res, next) {
  try { res.status(201).json(await leaveService.createType(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.types.update'] -> PATCH /api/leave/types/:id
router.patch('/types/:id', async function (req, res, next) {
  try { res.json(await leaveService.updateType(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.balances'] -> GET /api/leave/balances/:employeeId?year=
router.get('/balances/:employeeId', async function (req, res, next) {
  try { res.json(await leaveService.getBalances(req.ctx, req.params.employeeId, req.query.year)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.balances.set'] -> POST /api/leave/balances
router.post('/balances', async function (req, res, next) {
  try { res.json(await leaveService.setBalance(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.rollover'] -> POST /api/leave/rollover
router.post('/rollover', async function (req, res, next) {
  try { res.json(await leaveService.rollover(req.ctx, req.body.year)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.entitlements'] -> GET /api/leave/entitlements/:employeeId
router.get('/entitlements/:employeeId', async function (req, res, next) {
  try { res.json(await leaveService.getEntitlements(req.ctx, req.params.employeeId)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.entitlements.set'] -> POST /api/leave/entitlements
router.post('/entitlements', async function (req, res, next) {
  try { res.json(await leaveService.setEntitlement(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.entitlements.clear'] -> DELETE /api/leave/entitlements/:employeeId/:leaveTypeId?year=
router.delete('/entitlements/:employeeId/:leaveTypeId', async function (req, res, next) {
  try { res.json(await leaveService.clearEntitlement(req.ctx, req.params.employeeId, req.params.leaveTypeId, req.query.year)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.holidays'] -> GET /api/leave/holidays?companyId=&year=
router.get('/holidays', async function (req, res, next) {
  try { res.json(await leaveService.listHolidays(req.ctx, req.query.companyId, req.query.year)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.holidays.add'] -> POST /api/leave/holidays
router.post('/holidays', async function (req, res, next) {
  try { res.status(201).json(await leaveService.addHoliday(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.holidays.remove'] -> DELETE /api/leave/holidays/:id
router.delete('/holidays/:id', async function (req, res, next) {
  try { res.json(await leaveService.removeHoliday(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.list'] -> GET /api/leave?status=&companyId=&departmentId=
router.get('/', async function (req, res, next) {
  try {
    res.json(await leaveService.list(req.ctx, { status: req.query.status, companyId: req.query.companyId, departmentId: req.query.departmentId }));
  } catch (e) { next(e); }
});

// kernel.js: handlers['leave.request'] -> POST /api/leave
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await leaveService.requestLeave(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.decide'] -> POST /api/leave/:id/decision
router.post('/:id/decision', async function (req, res, next) {
  try { res.json(await leaveService.decide(req.ctx, req.params.id, req.body.decision, req.body.note)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.cancel'] -> POST /api/leave/:id/cancel
router.post('/:id/cancel', async function (req, res, next) {
  try { res.json(await leaveService.cancel(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
