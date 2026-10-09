var express = require('express');
var meta = require('../services/crmMeta.service');
var whatsappService = require('../services/whatsapp.service');

// Facebook Page (Messenger) and Instagram messages webhook, mounted at
// /api/marketing/meta in app.js — before marketing.routes.js's
// /api/marketing, which puts requireAuth on its whole router: Meta calls
// this directly, not the OS's own pages with a Bearer token. Set from
// Integrations → Facebook & Instagram messages ("Point Meta's webhook at
// the OS"), as:
//   https://bamboo-os-backend.onrender.com/api/marketing/meta/webhook

var router = express.Router();

router.get('/webhook', function (req, res) {
  var challenge = meta.verifyWebhookChallenge(req.query);
  if (challenge === null) return res.sendStatus(403);
  res.status(200).send(challenge);
});

router.post('/webhook', async function (req, res) {
  // Signed with the app secret (the same app as WhatsApp's) — anything else
  // is refused, so finding the address is not enough to put messages in.
  if (!whatsappService.isValidSignature(req.rawBody, req.get('x-hub-signature-256'))) {
    if (/^sha256=/.test(req.get('x-hub-signature-256') || '')) meta.noteWebhook(false, 0);
    return res.sendStatus(403);
  }
  // Answered first: Meta waits only a few seconds, and looking up who wrote
  // can take longer. Each message carries its id, so a resend adds nothing.
  res.sendStatus(200);
  try { await meta.handleWebhook(req.body); } catch (e) { console.error('Facebook/Instagram webhook handling failed:', e); }
});

module.exports = router;
