var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var { allowlistFilter } = require('../lib/uploadFilters');
var mwo = require('../services/maintenanceWorkOrders.service');
var mwoImport = require('../services/maintenanceWoImport.service');

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
