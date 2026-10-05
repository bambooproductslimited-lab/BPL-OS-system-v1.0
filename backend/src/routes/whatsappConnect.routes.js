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
module.exports = router;
