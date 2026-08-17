var express = require('express');
var { requireAuth } = require('../middleware/auth');
var settingsService = require('../services/settings.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['settings.get'] -> GET /api/settings
router.get('/', async function (req, res, next) {
  try { res.json(await settingsService.get(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['settings.save'] -> PATCH /api/settings
router.patch('/', async function (req, res, next) {
  try { res.json(await settingsService.save(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['integrations.list'] -> GET /api/settings/integrations
router.get('/integrations', async function (req, res, next) {
  try { res.json(await settingsService.listIntegrations(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['integrations.connect'] -> POST /api/settings/integrations/:id/connect
router.post('/integrations/:id/connect', async function (req, res, next) {
  try { res.json(await settingsService.connect(req.ctx, req.params.id, req.body.apiKey)); } catch (e) { next(e); }
});

// kernel.js: handlers['integrations.disconnect'] -> POST /api/settings/integrations/:id/disconnect
router.post('/integrations/:id/disconnect', async function (req, res, next) {
  try { res.json(await settingsService.disconnect(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
