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
// ?company=<code> (Bamboo Products when left out).
router.get('/marketing', async function (req, res, next) {
  try { res.json(await reportsService.marketingDashboard(req.ctx, req.query.company)); } catch (e) { next(e); }
});

// The companies with a marketing dashboard, for its company switcher.
router.get('/marketing/companies', async function (req, res, next) {
  try { res.json(await reportsService.marketingCompanies(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['finance.dashboard'] -> GET /api/reports/finance
// ?company=<code>&periodType=months|years&periodCount=1-12 (Bamboo Products when left out).
router.get('/finance', async function (req, res, next) {
  try { res.json(await reportsService.financeDashboard(req.ctx, req.query)); } catch (e) { next(e); }
});

// The companies with a finance dashboard, for its company switcher.
router.get('/finance/companies', async function (req, res, next) {
  try { res.json(await reportsService.financeCompanies(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['commercial.dashboard'] -> GET /api/reports/commercial
// ?company=<code> (Bamboo Products when left out).
router.get('/commercial', async function (req, res, next) {
  try { res.json(await reportsService.commercialDashboard(req.ctx, req.query.company)); } catch (e) { next(e); }
});

// The companies with a quotations & invoicing overview, for its switcher.
router.get('/commercial/companies', async function (req, res, next) {
  try { res.json(await reportsService.commercialCompanies(req.ctx)); } catch (e) { next(e); }
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
