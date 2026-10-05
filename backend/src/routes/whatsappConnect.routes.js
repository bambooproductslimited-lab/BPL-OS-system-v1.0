var express = require('express');
var { requireAuth } = require('../middleware/auth');
var connect = require('../services/whatsappConnect.service');

// Integrations → WhatsApp: connecting the company number with Meta's
// Embedded Signup (services/whatsappConnect.service.js).
var router = express.Router();
router.use(requireAuth);
function wrap(fn) { return function (req, res, next) { Promise.resolve(fn(req, res)).then(function (out) { res.json(out); }).catch(next); }; }
router.get('/', wrap(function (req) { return connect.info(req.ctx); }));
router.post('/finish', wrap(function (req) { return connect.finish(req.ctx, req.body || {}); }));
router.post('/resync', wrap(function (req) { return connect.resync(req.ctx); }));
router.delete('/', wrap(function (req) { return connect.disconnect(req.ctx); }));
router.post('/test-message', wrap(function (req) { return connect.sendTest(req.ctx, req.body || {}); }));
router.get('/templates', wrap(function (req) { return connect.listTemplates(req.ctx); }));
router.post('/templates', wrap(function (req) { return connect.createTemplate(req.ctx, req.body || {}); }));
router.delete('/templates/:name', wrap(function (req) { return connect.deleteTemplate(req.ctx, req.params.name); }));
module.exports = router;
