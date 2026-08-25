var express = require('express');
var whatsappService = require('../services/whatsapp.service');

// WhatsApp Cloud API webhook, mounted at /api/marketing/whatsapp in app.js
// — a separate mount from marketing.routes.js's /api/marketing (which
// applies requireAuth to its whole router), same reasoning as
// oauth.routes.js's public callback routes: Meta calls this directly, not
// our own frontend with a Bearer token, so it can't sit behind requireAuth.
// Must match exactly what's configured on the WhatsApp product's
// "Webhook" screen in Meta for Developers:
//   https://bamboo-os-backend.onrender.com/api/marketing/whatsapp/webhook

var router = express.Router();

router.get('/webhook', function (req, res) {
  var challenge = whatsappService.verifyWebhookChallenge(req.query);
  if (challenge === null) return res.sendStatus(403);
  res.status(200).send(challenge);
});

router.post('/webhook', async function (req, res) {
  // Always 200 — Meta retries (and eventually disables) a webhook that
  // doesn't return 2xx promptly, so a bad/duplicate event should be
  // swallowed here, not surfaced as an HTTP error.
  if (!whatsappService.isValidSignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(403);
  try {
    await whatsappService.handleWebhookEvent(req.body);
  } catch (e) {
    console.error('WhatsApp webhook handling failed:', e);
  }
  res.sendStatus(200);
});

module.exports = router;
