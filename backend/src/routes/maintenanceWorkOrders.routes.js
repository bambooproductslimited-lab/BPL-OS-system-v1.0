var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var { allowlistFilter } = require('../lib/uploadFilters');
var fileStore = require('../lib/fileStore');
var mwo = require('../services/maintenanceWorkOrders.service');
var mwoImport = require('../services/maintenanceWoImport.service');
var myJobsAccess = require('../services/myJobsAccess.service');

// Maintenance and IT work orders and routines (migration 0214).
var router = express.Router();
router.use(requireAuth);

var sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: allowlistFilter(['xlsx'], 'Download the Google Sheet as Microsoft Excel (.xlsx) and upload that file.')
});

function run(fn, status) {
  return async function (req, res, next) {
    try { res.status(status || 200).json(await fn(req)); } catch (e) { next(e); }
  };
}

// The whole tracker: work orders, routines, the dashboard, the options.
router.get('/', run(function (req) { return mwo.list(req.ctx, req.query); }));

// My Jobs, the team's phone app: the jobs given to me and my routines.
router.get('/mine', run(function (req) { return mwo.mine(req.ctx); }));
// …and adding jobs and routines of one's own from it.
router.post('/mine/jobs', run(function (req) { return mwo.addJob(req.ctx, req.body); }, 201));
router.post('/mine/routines', run(function (req) { return mwo.saveMyRoutine(req.ctx, null, req.body); }, 201));
router.patch('/mine/routines/:id', run(function (req) { return mwo.saveMyRoutine(req.ctx, req.params.id, req.body); }));
router.post('/mine/routines/:id/stop', run(function (req) { return mwo.stopMyRoutine(req.ctx, req.params.id); }));

// Its team code, for signing in with a kiosk code (the work order managers).
router.get('/myjobs-team', run(function (req) { return myJobsAccess.teamCode(req.ctx); }));
router.post('/myjobs-team/renew', run(function (req) { return myJobsAccess.renewTeamCode(req.ctx); }));

// Photos of the finished work: of a work order, of a routine done that time.
function sendPhoto(find) {
  return async function (req, res, next) {
    try { var f = await find(req); await fileStore.send(res, f.key, f.name, req.query.inline === '1'); } catch (e) { next(e); }
  };
}
router.get('/routines/log/:id/photos/:n', sendPhoto(function (req) { return mwo.routinePhotoOf(req.ctx, req.params.id, req.params.n); }));
router.get('/routines/:id/photos/:n', sendPhoto(function (req) { return mwo.routineRefPhotoOf(req.ctx, req.params.id, req.params.n); }));
router.get('/:id/photos/:n', sendPhoto(function (req) { return mwo.photoOf(req.ctx, req.params.id, req.params.n); }));
router.get('/:id/report-photos/:n', sendPhoto(function (req) { return mwo.reportPhotoOf(req.ctx, req.params.id, req.params.n); }));

// The IT work order sheet: preview what a workbook holds, then import it.
router.post('/import/preview', sheetUpload.single('file'), run(function (req) { return mwoImport.preview(req.ctx, req.file, req.body); }));
router.post('/import', sheetUpload.single('file'), run(function (req) { return mwoImport.run(req.ctx, req.file, req.body); }));

// Routines: add, change, mark done, make the next work order, put away.
router.post('/routines', run(function (req) { return mwo.saveRoutine(req.ctx, null, req.body); }, 201));
router.patch('/routines/:id', run(function (req) { return mwo.saveRoutine(req.ctx, req.params.id, req.body); }));
router.post('/routines/:id/done', run(function (req) { return mwo.routineDone(req.ctx, req.params.id, req.body); }));
router.post('/routines/:id/order', run(function (req) { return mwo.routineOrder(req.ctx, req.params.id, req.body); }, 201));
router.post('/routines/:id/archive', run(function (req) { return mwo.archiveRoutine(req.ctx, req.params.id, !!(req.body && req.body.archived)); }));
router.delete('/routines/:id', run(function (req) { return mwo.removeRoutine(req.ctx, req.params.id); }));

// Work orders: ask for or record one, change it, move it along, check it
// for billing, delete it.
router.post('/', run(function (req) { return mwo.create(req.ctx, req.body); }, 201));
router.get('/:id', run(function (req) { return mwo.get(req.ctx, req.params.id); }));
router.patch('/:id', run(function (req) { return mwo.update(req.ctx, req.params.id, req.body); }));
router.post('/:id/status', run(function (req) { return mwo.setStatus(req.ctx, req.params.id, req.body); }));
router.post('/:id/audit', run(function (req) { return mwo.setAudited(req.ctx, req.params.id, !!(req.body && req.body.audited)); }));
router.delete('/:id', run(function (req) { return mwo.remove(req.ctx, req.params.id); }));

module.exports = router;
