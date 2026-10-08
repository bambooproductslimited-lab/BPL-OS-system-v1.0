var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var { allowlistFilter } = require('../lib/uploadFilters');
var tasksService = require('../services/tasks.service');
var woImport = require('../services/workOrderImport.service');

// Work orders (the tasks table, migration 0136).
var router = express.Router();
router.use(requireAuth);

var sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: allowlistFilter(['xlsx'], 'Download the Google Sheet as Microsoft Excel (.xlsx) and upload that file.')
});

// What the WO form offers to pick from (our companies, customers).
router.get('/options', async function (req, res, next) {
  try { res.json(await tasksService.options(req.ctx)); } catch (e) { next(e); }
});

// Several WOs into a project at once, or out of their project: { ids, projectId }.
router.post('/project', async function (req, res, next) {
  try { res.json(await tasksService.setProject(req.ctx, req.body.ids, req.body.projectId || null)); } catch (e) { next(e); }
});

// The WO sheet: preview what a workbook holds, then import it.
router.post('/import/preview', sheetUpload.single('file'), async function (req, res, next) {
  try { res.json(await woImport.preview(req.ctx, req.file, req.body)); } catch (e) { next(e); }
});
router.post('/import', sheetUpload.single('file'), async function (req, res, next) {
  try { res.json(await woImport.run(req.ctx, req.file, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.list'] -> GET /api/tasks?scope=&status=&q=
router.get('/', async function (req, res, next) {
  try { res.json(await tasksService.list(req.ctx, req.query)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.create'] -> POST /api/tasks
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await tasksService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.get'] -> GET /api/tasks/:id
router.get('/:id', async function (req, res, next) {
  try { res.json(await tasksService.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.update'] -> PATCH /api/tasks/:id
router.patch('/:id', async function (req, res, next) {
  try { res.json(await tasksService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.delete'] -> DELETE /api/tasks/:id
router.delete('/:id', async function (req, res, next) {
  try { res.json(await tasksService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.setStatus'] -> POST /api/tasks/:id/status
router.post('/:id/status', async function (req, res, next) {
  try { res.json(await tasksService.setStatus(req.ctx, req.params.id, req.body.status)); } catch (e) { next(e); }
});

// kernel.js: handlers['tasks.addComment'] -> POST /api/tasks/:id/comments
router.post('/:id/comments', async function (req, res, next) {
  try { res.status(201).json(await tasksService.addComment(req.ctx, req.params.id, req.body.body)); } catch (e) { next(e); }
});

module.exports = router;
