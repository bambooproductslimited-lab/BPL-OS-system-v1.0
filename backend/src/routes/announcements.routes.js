var express = require('express');
var { requireAuth } = require('../middleware/auth');
var announcementsService = require('../services/announcements.service');

var router = express.Router();
router.use(requireAuth);

function wrap(fn) { return function (req, res, next) { Promise.resolve(fn(req, res)).catch(next); }; }

// kernel.js: handlers['announcements.list'] -> GET /api/announcements
router.get('/', wrap(async function (req, res) { res.json(await announcementsService.list(req.ctx)); }));

// kernel.js: handlers['announcements.publish'] -> POST /api/announcements
router.post('/', wrap(async function (req, res) { res.status(201).json(await announcementsService.publish(req.ctx, req.body)); }));

// The viewer has seen these: POST /api/announcements/read { ids: [...] }
router.post('/read', wrap(async function (req, res) { res.json(await announcementsService.markRead(req.ctx, (req.body || {}).ids)); }));

router.patch('/:id', wrap(async function (req, res) { res.json(await announcementsService.update(req.ctx, req.params.id, req.body)); }));
router.delete('/:id', wrap(async function (req, res) { res.json(await announcementsService.remove(req.ctx, req.params.id)); }));
router.post('/:id/pin', wrap(async function (req, res) { res.json(await announcementsService.setPinned(req.ctx, req.params.id, (req.body || {}).pinned)); }));
router.post('/:id/acknowledge', wrap(async function (req, res) { res.json(await announcementsService.acknowledge(req.ctx, req.params.id)); }));
router.get('/:id/readers', wrap(async function (req, res) { res.json(await announcementsService.readers(req.ctx, req.params.id)); }));

module.exports = router;
