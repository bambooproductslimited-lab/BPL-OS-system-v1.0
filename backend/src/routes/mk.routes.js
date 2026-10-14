var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var { allowlistFilter } = require('../lib/uploadFilters');
var fileStore = require('../lib/fileStore');
var S = require('../services/mkShared');
var home = require('../services/mkHome.service');
var campaigns = require('../services/mkCampaigns.service');
var budget = require('../services/mkBudget.service');
var requests = require('../services/mkRequests.service');
var routines = require('../services/mkRoutines.service');
var events = require('../services/mkEvents.service');
var brand = require('../services/mkBrand.service');
var audiences = require('../services/mkAudiences.service');

// The marketing department (/api/mk): home and calendar, campaigns,
// budget and spend, requests from the company, events and promotions,
// the brand kit, the market and audiences. Permissions are checked in the
// services (mkShared.js).

var DOC = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'];
var BRAND = DOC.concat(['svg', 'ai', 'eps', 'psd', 'indd', 'ttf', 'otf', 'woff', 'woff2', 'mp4', 'mov', 'zip']);
var receiptUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: allowlistFilter(DOC, 'That file type isn’t supported for a receipt.') });
var requestUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: allowlistFilter(BRAND, 'That file type isn’t supported.') });
var assetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 }, fileFilter: allowlistFilter(BRAND, 'That file type isn’t supported for the brand kit.') });

// Shown in the page only when the browser cannot run anything in it.
var INLINE = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/i;
async function sendFile(res, f, wantDownload) {
  var stored = await fileStore.get(f.key);
  var inline = !wantDownload && stored && INLINE.test(stored.contentType || '');
  await fileStore.send(res, f.key, f.fileName, inline);
}
function h(fn) { return function (req, res, next) { Promise.resolve(fn(req, res)).then(function (out) { if (out !== undefined) res.json(out); }).catch(next); }; }

var router = express.Router();
router.use(requireAuth);

router.get('/companies', h(function (req) { return S.companies(req.ctx); }));
router.get('/home', h(function (req) { return home.home(req.ctx, req.query); }));
router.get('/calendar', h(function (req) { return home.calendar(req.ctx, req.query); }));

router.get('/campaigns', h(function (req) { return campaigns.list(req.ctx, req.query); }));
router.get('/campaigns/options', h(function (req) { S.requireRead(req.ctx); return campaigns.options(req.ctx, req.query.company); }));
router.post('/campaigns', h(function (req) { return campaigns.create(req.ctx, req.body || {}); }));
router.get('/campaigns/:id', h(function (req) { return campaigns.get(req.ctx, req.params.id); }));
router.put('/campaigns/:id', h(function (req) { return campaigns.update(req.ctx, req.params.id, req.body || {}); }));
router.post('/campaigns/:id/status', h(function (req) { return campaigns.setStatus(req.ctx, req.params.id, req.body || {}); }));
router.delete('/campaigns/:id', h(function (req) { return campaigns.remove(req.ctx, req.params.id); }));
router.get('/campaigns/:id/lead-candidates', h(function (req) { return campaigns.leadCandidates(req.ctx, req.params.id); }));
router.post('/campaigns/:id/leads', h(function (req) { return campaigns.creditLeads(req.ctx, req.params.id, req.body || {}); }));

router.get('/budget', h(function (req) { return budget.overview(req.ctx, req.query); }));
router.put('/budget', h(function (req) { return budget.setBudget(req.ctx, req.body || {}); }));
router.post('/spend', receiptUpload.single('receipt'), h(function (req) { return budget.addSpend(req.ctx, req.body || {}, req.file); }));
router.put('/spend/:id', receiptUpload.single('receipt'), h(function (req) { return budget.updateSpend(req.ctx, req.params.id, req.body || {}, req.file); }));
// The same as a POST, for the page's file upload helper (it only posts).
router.post('/spend/:id', receiptUpload.single('receipt'), h(function (req) { return budget.updateSpend(req.ctx, req.params.id, req.body || {}, req.file); }));
router.delete('/spend/:id', h(function (req) { return budget.removeSpend(req.ctx, req.params.id); }));
router.get('/spend/:id/receipt', h(async function (req, res) { await sendFile(res, await budget.receipt(req.ctx, req.params.id), req.query.download === '1'); }));

router.get('/routines', h(function (req) { return routines.list(req.ctx, req.query); }));
router.post('/routines', h(function (req) { return routines.create(req.ctx, req.body || {}); }));
router.get('/routines/:id', h(function (req) { return routines.get(req.ctx, req.params.id); }));
router.put('/routines/:id', h(function (req) { return routines.update(req.ctx, req.params.id, req.body || {}); }));
router.post('/routines/:id/pause', h(function (req) { return routines.setPaused(req.ctx, req.params.id, req.body || {}); }));
router.delete('/routines/:id', h(function (req) { return routines.remove(req.ctx, req.params.id); }));
router.get('/requests', h(function (req) { return requests.list(req.ctx, req.query); }));
router.get('/requests/team', h(function (req) { return requests.team(req.ctx); }));
router.get('/requests/people', h(function (req) { return requests.people(req.ctx); }));
router.post('/requests', h(function (req) { return requests.create(req.ctx, req.body || {}); }));
router.get('/requests/:id', h(function (req) { return requests.get(req.ctx, req.params.id); }));
router.put('/requests/:id', h(function (req) { return requests.update(req.ctx, req.params.id, req.body || {}); }));
router.put('/requests/:id/team', h(function (req) { return requests.setTeam(req.ctx, req.params.id, req.body || {}); }));
router.post('/requests/:id/status', h(function (req) { return requests.setStatus(req.ctx, req.params.id, req.body || {}); }));
router.post('/requests/:id/comments', h(function (req) { return requests.comment(req.ctx, req.params.id, req.body || {}); }));
router.post('/requests/:id/files', requestUpload.single('file'), h(function (req) { return requests.addFile(req.ctx, req.params.id, req.file, req.body || {}); }));
router.get('/requests/:id/files/:fileId', h(async function (req, res) { await sendFile(res, await requests.file(req.ctx, req.params.id, req.params.fileId), req.query.download === '1'); }));
router.delete('/requests/:id/files/:fileId', h(function (req) { return requests.removeFile(req.ctx, req.params.id, req.params.fileId); }));

router.get('/events', h(function (req) { return events.listEvents(req.ctx, req.query); }));
router.post('/events', h(function (req) { return events.createEvent(req.ctx, req.body || {}); }));
router.get('/events/:id', h(function (req) { return events.getEvent(req.ctx, req.params.id); }));
router.put('/events/:id', h(function (req) { return events.updateEvent(req.ctx, req.params.id, req.body || {}); }));
router.delete('/events/:id', h(function (req) { return events.removeEvent(req.ctx, req.params.id); }));
router.post('/events/:id/tasks', h(function (req) { return events.addTask(req.ctx, req.params.id, req.body || {}); }));
router.post('/events/:id/tasks/:taskId', h(function (req) { return events.setTask(req.ctx, req.params.id, req.params.taskId, req.body || {}); }));
router.delete('/events/:id/tasks/:taskId', h(function (req) { return events.removeTask(req.ctx, req.params.id, req.params.taskId); }));

router.get('/promotions', h(function (req) { return events.listPromotions(req.ctx, req.query); }));
router.post('/promotions', h(function (req) { return events.createPromotion(req.ctx, req.body || {}); }));
router.get('/promotions/:id', h(function (req) { return events.getPromotion(req.ctx, req.params.id); }));
router.put('/promotions/:id', h(function (req) { return events.updatePromotion(req.ctx, req.params.id, req.body || {}); }));
router.delete('/promotions/:id', h(function (req) { return events.removePromotion(req.ctx, req.params.id); }));
router.post('/promotions/:id/uses', h(function (req) { return events.logUse(req.ctx, req.params.id, req.body || {}); }));
router.delete('/promotions/:id/uses/:useId', h(function (req) { return events.removeUse(req.ctx, req.params.id, req.params.useId); }));

router.get('/brand', h(function (req) { return brand.brand(req.ctx, req.query); }));
router.put('/brand', h(function (req) { return brand.updateBrand(req.ctx, req.body || {}); }));
router.post('/assets', assetUpload.single('file'), h(function (req) { return brand.addAsset(req.ctx, req.body || {}, req.file); }));
router.patch('/assets/:id', h(function (req) { return brand.updateAsset(req.ctx, req.params.id, req.body || {}); }));
router.delete('/assets/:id', h(function (req) { return brand.removeAsset(req.ctx, req.params.id); }));
router.get('/assets/:id/file', h(async function (req, res) { await sendFile(res, await brand.assetFile(req.ctx, req.params.id, req.query.download === '1'), req.query.download === '1'); }));

router.get('/market', h(function (req) { return brand.market(req.ctx, req.query); }));
router.post('/competitors', h(function (req) { return brand.addCompetitor(req.ctx, req.body || {}); }));
router.put('/competitors/:id', h(function (req) { return brand.updateCompetitor(req.ctx, req.params.id, req.body || {}); }));
router.delete('/competitors/:id', h(function (req) { return brand.removeCompetitor(req.ctx, req.params.id); }));
router.post('/intel', h(function (req) { return brand.addIntel(req.ctx, req.body || {}); }));
router.delete('/intel/:id', h(function (req) { return brand.removeIntel(req.ctx, req.params.id); }));

router.get('/audiences', h(function (req) { return audiences.list(req.ctx, req.query); }));
router.post('/audiences/preview', h(function (req) { return audiences.preview(req.ctx, req.body || {}); }));
router.post('/audiences', h(function (req) { return audiences.create(req.ctx, req.body || {}); }));
router.put('/audiences/:id', h(function (req) { return audiences.update(req.ctx, req.params.id, req.body || {}); }));
router.delete('/audiences/:id', h(function (req) { return audiences.remove(req.ctx, req.params.id); }));
router.get('/audiences/:id/export', h(async function (req, res) {
  var out = await audiences.exportCsv(req.ctx, req.params.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + out.fileName + '"');
  res.end(out.csv);
}));

module.exports = router;
