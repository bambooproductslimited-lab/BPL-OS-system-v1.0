var express = require('express');
var { requireAuth } = require('../middleware/auth');
var recruitment = require('../services/recruitment.service');
var fileStore = require('../lib/fileStore');

// Recruitment (recruitment.service.js, migration 0198): the OS side under
// /api/recruitment, the public jobs page under /api/jobs.
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return recruitment.overview(req.ctx); }));
router.post('/openings', h(function (req) { return recruitment.saveOpening(req.ctx, req.body); }));
router.get('/openings/:id', h(function (req) { return recruitment.opening(req.ctx, req.params.id); }));
router.post('/applicants', h(function (req) { return recruitment.addApplicant(req.ctx, req.body); }));
router.get('/applicants/:id', h(function (req) { return recruitment.applicant(req.ctx, req.params.id); }));
router.put('/applicants/:id', h(function (req) { return recruitment.updateApplicant(req.ctx, req.params.id, req.body); }));
router.post('/applicants/:id/notes', h(function (req) { return recruitment.addNote(req.ctx, req.params.id, req.body); }));
router.post('/applicants/:id/hire', h(function (req) { return recruitment.hire(req.ctx, req.params.id, req.body); }));
router.get('/applicants/:id/cv', async function (req, res, next) {
  try { var f = await recruitment.cvOf(req.ctx, req.params.id); await fileStore.send(res, f.key, f.name, true); } catch (e) { next(e); }
});

var publicRouter = express.Router();
publicRouter.get('/', async function (req, res, next) {
  try { res.json(await recruitment.publicList()); } catch (e) { next(e); }
});
publicRouter.get('/:slug', async function (req, res, next) {
  try { res.json(await recruitment.publicJob(req.params.slug)); } catch (e) { next(e); }
});
publicRouter.post('/:slug/apply', async function (req, res, next) {
  try { res.status(201).json(await recruitment.apply(req.params.slug, req.body, req.ip)); } catch (e) { next(e); }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
