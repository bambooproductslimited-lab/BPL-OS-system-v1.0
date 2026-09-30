var express = require('express');
var { requireAuth } = require('../middleware/auth');
var emails = require('../services/documentEmails.service');

// Emails to customers — see documentEmails.service.js. Permissions are
// checked in the service, per document and company.
var router = express.Router();
router.use(requireAuth);
function wrap(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/settings', wrap(function (req) { return emails.status(req.ctx); }));
router.put('/settings', wrap(function (req) { return emails.saveSettings(req.ctx, req.body); }));
router.get('/:type/:id', wrap(function (req) { return emails.draft(req.ctx, req.params.type, req.params.id); }));
router.post('/:type/:id', wrap(function (req) { return emails.send(req.ctx, req.params.type, req.params.id, req.body); }));

module.exports = router;
