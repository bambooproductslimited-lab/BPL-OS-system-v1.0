var express = require('express');
var { requireAuth } = require('../middleware/auth');
var commercialSettingsService = require('../services/commercialSettings.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await commercialSettingsService.get(req.ctx)); } catch (e) { next(e); }
});
router.patch('/', async function (req, res, next) {
  try { res.json(await commercialSettingsService.save(req.ctx, req.body)); } catch (e) { next(e); }
});
router.post('/tax-rates', async function (req, res, next) {
  try { res.status(201).json(await commercialSettingsService.addTaxRate(req.ctx, req.body)); } catch (e) { next(e); }
});

module.exports = router;
