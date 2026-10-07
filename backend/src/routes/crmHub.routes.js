var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var inbox = require('../services/crmInbox.service');
var profiles = require('../services/crmProfiles.service');
var followUps = require('../services/crmFollowUps.service');
var health = require('../services/crmHealth.service');
var marketing = require('../services/crmMarketing.service');
var waImport = require('../services/crmWhatsappImport.service');
var email = require('../services/crmEmail.service');
var meta = require('../services/crmMeta.service');

// The CRM's customer side (mounted on /api/crm next to crm.routes.js):
// profiles, the inbox, follow-ups, data health and marketing.
var router = express.Router();
router.use(requireAuth);
function wrap(fn) { return function (req, res, next) { Promise.resolve(fn(req, res)).then(function (out) { res.json(out); }).catch(next); }; }
var chatUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

// profiles
router.get('/profiles', wrap(function (req) { return profiles.listProfiles(req.ctx, req.query); }));
router.get('/profiles/:id', wrap(function (req) { return profiles.getProfile(req.ctx, req.params.id); }));
router.put('/profiles/:id', wrap(function (req) { return profiles.updateProfile(req.ctx, req.params.id, req.body || {}); }));
router.post('/profiles/:id/identities', wrap(function (req) { return profiles.addIdentity(req.ctx, req.params.id, req.body || {}); }));
router.delete('/profiles/:id/identities/:identityId', wrap(function (req) { return profiles.removeIdentity(req.ctx, req.params.id, req.params.identityId); }));
router.put('/profiles/:id/follow-up', wrap(function (req) { return profiles.setFollowUp(req.ctx, req.params.id, req.body || {}); }));
router.post('/profiles/:id/log', wrap(function (req) { return inbox.logInteraction(req.ctx, req.params.id, req.body || {}); }));
router.get('/reps', wrap(function (req) { return profiles.reps(req.ctx); }));
router.post('/assign', wrap(function (req) { return profiles.assignRep(req.ctx, req.body || {}); }));

// the inbox
router.get('/conversations', wrap(function (req) { return inbox.listConversations(req.ctx, req.query); }));
router.get('/conversations/:id', wrap(function (req) { return inbox.getConversation(req.ctx, req.params.id); }));
router.post('/conversations/:id/reply', wrap(function (req) { return inbox.reply(req.ctx, req.params.id, req.body || {}); }));
router.post('/conversations/:id/link', wrap(function (req) { return inbox.linkConversation(req.ctx, req.params.id, req.body || {}); }));
router.put('/conversations/:id/status', wrap(function (req) { return inbox.setStatus(req.ctx, req.params.id, (req.body || {}).status); }));
router.post('/import/whatsapp/preview', chatUpload.single('file'), wrap(function (req) { return waImport.preview(req.ctx, req.file); }));
router.post('/import/whatsapp', chatUpload.single('file'), wrap(function (req) {
  var b = req.body || {};
  var ours = b.ourNames;
  try { ours = typeof ours === 'string' ? JSON.parse(ours) : ours; } catch (e) { ours = [ours]; }
  return waImport.run(req.ctx, req.file, { ourNames: ours || [], phone: b.phone || '', customerId: b.customerId || null });
}));
router.get('/channels', wrap(async function (req) {
  if (!req.ctx.can('crm.read')) { var { fail } = require('../utils/errors'); fail('forbidden', 'Your role does not allow this action (crm.read).'); }
  return { whatsapp: await require('../services/whatsapp.service').status(), email: await email.status(), meta: await meta.status() };
}));

// The sales mailbox, connected on Integrations → Email inbox
// (crmMailbox.service.js); "Read new mail now" runs the 3-minute sync at once.
var mailboxes = require('../services/crmMailbox.service');
router.get('/mailbox', wrap(function (req) { return mailboxes.info(req.ctx); }));
router.post('/mailbox/test', wrap(function (req) { return mailboxes.test(req.ctx, req.body || {}); }));
router.put('/mailbox', wrap(function (req) { return mailboxes.connect(req.ctx, req.body || {}); }));
router.delete('/mailbox', wrap(function (req) { return mailboxes.disconnect(req.ctx); }));
router.post('/mailbox/sync', wrap(async function (req) {
  if (!req.ctx.can('settings.manage')) { var { fail } = require('../utils/errors'); fail('forbidden', 'Your role does not allow this action (settings.manage).'); }
  var r = await email.sync();
  return { kept: r.kept || 0, skipped: r.skipped || 0, error: r.error || null, notSetUp: !!r.skipped && typeof r.skipped === 'string', mailbox: await mailboxes.info(req.ctx) };
}));

router.post('/whatsapp-alerts/:id/dismiss', wrap(function (req) { return require('../services/whatsappAlerts.service').dismiss(req.ctx, req.params.id); }));

// follow-ups
router.get('/follow-ups/mine', wrap(function (req) { return followUps.mine(req.ctx); }));
router.get('/follow-ups/team', wrap(function (req) { return followUps.team(req.ctx, req.query); }));

// data health
router.get('/duplicates', wrap(function (req) { return health.listDuplicates(req.ctx, req.query); }));
router.post('/duplicates/scan', wrap(async function (req) {
  if (!req.ctx.can('crm.manage')) { var { fail } = require('../utils/errors'); fail('forbidden', 'Your role does not allow this action (crm.manage).'); }
  await inbox.backfillIdentities();
  return health.scanDuplicates();
}));
router.post('/duplicates/merge', wrap(function (req) { return health.merge(req.ctx, req.body || {}); }));
router.post('/duplicates/:id/decide', wrap(function (req) { return health.decide(req.ctx, req.params.id, (req.body || {}).status); }));
router.delete('/profiles/:id', wrap(function (req) { return health.deleteEmpty(req.ctx, req.params.id, req.query.suggestion || null); }));
router.get('/coverage', wrap(function (req) { return health.unassigned(req.ctx); }));
router.post('/coverage/assign-suggested', wrap(function (req) { return health.assignSuggested(req.ctx, req.body || {}); }));

// marketing
router.get('/marketing/topics', wrap(function (req) { return marketing.topics(req.ctx, req.query); }));
router.get('/marketing/ideas', wrap(function (req) { return marketing.contentIdeas(req.ctx, req.query); }));
router.get('/marketing/products', wrap(function (req) { return marketing.productsForPicker(req.ctx); }));
router.get('/marketing/audience', wrap(function (req) { return marketing.audience(req.ctx, req.query); }));
router.post('/marketing/hand-to-reps', wrap(function (req) { return marketing.handToReps(req.ctx, req.body || {}); }));

module.exports = router;
