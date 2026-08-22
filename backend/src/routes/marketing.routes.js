var express = require('express');
var { requireAuth } = require('../middleware/auth');
var marketingService = require('../services/marketing.service');
var tiktokOAuthService = require('../services/tiktokOAuth.service');
var metaOAuthService = require('../services/metaOAuth.service');

var router = express.Router();
router.use(requireAuth);

router.post('/tiktok/sync', async function (req, res, next) {
  try { res.json(await tiktokOAuthService.sync(req.ctx)); } catch (e) { next(e); }
});

router.get('/meta/pages', async function (req, res, next) {
  try { res.json(await metaOAuthService.listPages(req.ctx, req.query.pending)); } catch (e) { next(e); }
});
router.post('/meta/pages/:pageId/connect', async function (req, res, next) {
  try { res.json(await metaOAuthService.connectPage(req.ctx, req.body.pending, req.params.pageId)); } catch (e) { next(e); }
});
router.post('/facebook/sync', async function (req, res, next) {
  try { res.json(await metaOAuthService.syncFacebook(req.ctx)); } catch (e) { next(e); }
});
router.post('/instagram/sync', async function (req, res, next) {
  try { res.json(await metaOAuthService.syncInstagram(req.ctx)); } catch (e) { next(e); }
});

router.get('/dashboard', async function (req, res, next) {
  try { res.json(await marketingService.dashboard(req.ctx)); } catch (e) { next(e); }
});

router.get('/channels', async function (req, res, next) {
  try { res.json(await marketingService.listChannels(req.ctx)); } catch (e) { next(e); }
});
router.patch('/channels/:id', async function (req, res, next) {
  try { res.json(await marketingService.updateChannel(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.get('/channels/:id/stats', async function (req, res, next) {
  try { res.json(await marketingService.listChannelStats(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/channels/:id/stats', async function (req, res, next) {
  try { res.status(201).json(await marketingService.logChannelStat(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

router.get('/campaigns', async function (req, res, next) {
  try { res.json(await marketingService.listCampaigns(req.ctx)); } catch (e) { next(e); }
});
router.post('/campaigns', async function (req, res, next) {
  try { res.status(201).json(await marketingService.createCampaign(req.ctx, req.body)); } catch (e) { next(e); }
});
router.patch('/campaigns/:id', async function (req, res, next) {
  try { res.json(await marketingService.updateCampaign(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

router.get('/posts', async function (req, res, next) {
  try { res.json(await marketingService.listPosts(req.ctx, req.query)); } catch (e) { next(e); }
});
router.post('/posts', async function (req, res, next) {
  try { res.status(201).json(await marketingService.createPost(req.ctx, req.body)); } catch (e) { next(e); }
});
router.patch('/posts/:id', async function (req, res, next) {
  try { res.json(await marketingService.updatePost(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/posts/:id', async function (req, res, next) {
  try { res.json(await marketingService.deletePost(req.ctx, req.params.id)); } catch (e) { next(e); }
});

router.get('/inbox', async function (req, res, next) {
  try { res.json(await marketingService.listInboxItems(req.ctx, req.query)); } catch (e) { next(e); }
});
router.post('/inbox', async function (req, res, next) {
  try { res.status(201).json(await marketingService.createInboxItem(req.ctx, req.body)); } catch (e) { next(e); }
});
router.post('/inbox/:id/reply', async function (req, res, next) {
  try { res.json(await marketingService.replyInboxItem(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/inbox/:id/status', async function (req, res, next) {
  try { res.json(await marketingService.setInboxStatus(req.ctx, req.params.id, req.body.status)); } catch (e) { next(e); }
});

module.exports = router;
