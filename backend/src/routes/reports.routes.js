var express = require('express');
var { requireAuth } = require('../middleware/auth');
var reportsService = require('../services/reports.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['reports.summary'] -> GET /api/reports/summary
router.get('/summary', async function (req, res, next) {
  try { res.json(await reportsService.summary(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['marketing.dashboard'] -> GET /api/reports/marketing
router.get('/marketing', async function (req, res, next) {
  try { res.json(await reportsService.marketingDashboard(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['finance.dashboard'] -> GET /api/reports/finance
router.get('/finance', async function (req, res, next) {
  try { res.json(await reportsService.financeDashboard(req.ctx, req.query)); } catch (e) { next(e); }
});

// kernel.js: handlers['commercial.dashboard'] -> GET /api/reports/commercial
router.get('/commercial', async function (req, res, next) {
  try { res.json(await reportsService.commercialDashboard(req.ctx)); } catch (e) { next(e); }
});

// ── Financial Reports ──
router.get('/pnl', async function (req, res, next) {
  try { res.json(await reportsService.profitAndLoss(req.ctx, req.query)); } catch (e) { next(e); }
});
router.get('/cashflow', async function (req, res, next) {
  try { res.json(await reportsService.cashFlow(req.ctx, req.query)); } catch (e) { next(e); }
});
router.get('/balance-sheet', async function (req, res, next) {
  try { res.json(await reportsService.balanceSheet(req.ctx)); } catch (e) { next(e); }
});
router.get('/balance-sheet/inputs', async function (req, res, next) {
  try { res.json(await reportsService.getBalanceSheetInputs(req.ctx)); } catch (e) { next(e); }
});
router.patch('/balance-sheet/inputs', async function (req, res, next) {
  try { res.json(await reportsService.saveBalanceSheetInputs(req.ctx, req.body)); } catch (e) { next(e); }
});
router.get('/ar-aging', async function (req, res, next) {
  try { res.json(await reportsService.arAging(req.ctx)); } catch (e) { next(e); }
});
router.get('/expense-detail', async function (req, res, next) {
  try { res.json(await reportsService.expenseDetail(req.ctx, req.query)); } catch (e) { next(e); }
});
router.get('/tax-summary', async function (req, res, next) {
  try { res.json(await reportsService.taxSummary(req.ctx, req.query)); } catch (e) { next(e); }
});

module.exports = router;
