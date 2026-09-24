var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var { allowlistFilter } = require('../lib/uploadFilters');
var fileStore = require('../lib/fileStore');
var messagesService = require('../services/messages.service');

// Chat attachments: photos, videos, audio and everyday documents — not
// programs or archives. Each file up to 25 MB (15 MB when files are kept in
// the database rather than R2, see lib/fileStore.js).
var CHAT_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif',
  'mp4', 'mov', 'webm', 'm4v', '3gp',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'amr',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'rtf', 'odt', 'ods', 'odp'
];
var files = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: allowlistFilter(CHAT_EXTENSIONS, 'That kind of file can’t be sent in a chat.')
});
var photo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: allowlistFilter(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'], 'That isn’t a photo.')
});

var router = express.Router();
router.use(requireAuth);

function wrap(fn) { return async function (req, res, next) { try { await fn(req, res); } catch (e) { next(e); } }; }

// kernel.js: handlers['messages.inbox'] -> GET /api/messages — every chat, newest first
router.get('/', wrap(async function (req, res) { res.json(await messagesService.inbox(req.ctx)); }));
// kernel.js: handlers['messages.directory'] -> GET /api/messages/directory
router.get('/directory', wrap(async function (req, res) { res.json(await messagesService.directory(req.ctx)); }));
// kernel.js: handlers['messages.unreadCount'] -> GET /api/messages/unread-count
router.get('/unread-count', wrap(async function (req, res) { res.json({ count: await messagesService.unreadCount(req.ctx) }); }));

// Group chats
router.post('/groups', wrap(async function (req, res) { res.status(201).json(await messagesService.createGroup(req.ctx, req.body || {})); }));

// One conversation: read, send (JSON { body } or multipart with body + files), settings, members, photo
router.get('/conversations/:id', wrap(async function (req, res) { res.json(await messagesService.conversation(req.ctx, req.params.id)); }));
router.post('/conversations/:id', files.array('files', 10), wrap(async function (req, res) {
  res.status(201).json(await messagesService.sendToConversation(req.ctx, req.params.id, (req.body || {}).body, req.files));
}));
router.patch('/conversations/:id', wrap(async function (req, res) { res.json(await messagesService.updateGroup(req.ctx, req.params.id, req.body || {})); }));
router.post('/conversations/:id/members', wrap(async function (req, res) {
  res.json(await messagesService.addMembers(req.ctx, req.params.id, (req.body || {}).employeeIds));
}));
router.delete('/conversations/:id/members/:employeeId', wrap(async function (req, res) {
  res.json(await messagesService.removeMember(req.ctx, req.params.id, req.params.employeeId));
}));
router.post('/conversations/:id/leave', wrap(async function (req, res) {
  res.json(await messagesService.removeMember(req.ctx, req.params.id, req.ctx.employee.id));
}));
router.post('/conversations/:id/admins/:employeeId', wrap(async function (req, res) {
  res.json(await messagesService.setAdmin(req.ctx, req.params.id, req.params.employeeId, (req.body || {}).admin !== false));
}));
router.get('/conversations/:id/photo', wrap(async function (req, res) {
  var p = await messagesService.groupPhoto(req.ctx, req.params.id);
  await fileStore.send(res, p.key, 'group.jpg', true);
}));
router.post('/conversations/:id/photo', photo.single('photo'), wrap(async function (req, res) {
  res.json(await messagesService.setGroupPhoto(req.ctx, req.params.id, req.file));
}));
router.delete('/conversations/:id/photo', wrap(async function (req, res) {
  res.json(await messagesService.setGroupPhoto(req.ctx, req.params.id, null));
}));

// A file sent in a chat — members only.
router.get('/files/:id', wrap(async function (req, res) {
  var a = await messagesService.attachment(req.ctx, req.params.id);
  await fileStore.send(res, a.key, a.fileName, req.query.inline === '1');
}));

// People's photos: anyone signed in sees them; you change your own, and
// those who manage employees change anyone's.
router.get('/people/:id/photo', wrap(async function (req, res) {
  var p = await messagesService.personPhoto(req.ctx, req.params.id);
  await fileStore.send(res, p.key, 'photo.jpg', true);
}));
router.post('/people/:id/photo', photo.single('photo'), wrap(async function (req, res) {
  var id = req.params.id === 'me' ? req.ctx.employee.id : req.params.id;
  res.json(await messagesService.setPersonPhoto(req.ctx, id, req.file));
}));
router.delete('/people/:id/photo', wrap(async function (req, res) {
  var id = req.params.id === 'me' ? req.ctx.employee.id : req.params.id;
  res.json(await messagesService.setPersonPhoto(req.ctx, id, null));
}));

// A one-to-one chat with a person (empty until the first message), and
// sending to them — GET/POST /api/messages/:peerId, as before group chats.
// kernel.js: handlers['messages.thread'] / ['messages.send']
router.get('/:peerId', wrap(async function (req, res) { res.json(await messagesService.direct(req.ctx, req.params.peerId)); }));
router.post('/:peerId', files.array('files', 10), wrap(async function (req, res) {
  res.status(201).json(await messagesService.sendDirect(req.ctx, req.params.peerId, (req.body || {}).body, req.files));
}));

module.exports = router;
