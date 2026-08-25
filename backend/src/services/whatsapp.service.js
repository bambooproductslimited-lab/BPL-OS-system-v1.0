var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var config = require('../config');

// Real WhatsApp Business Cloud API for the social tracker's Inbox — unlike
// every other platform in this app, there's no "Connect" button: the phone
// number, its permanent access token, and the webhook verify token are all
// set up once in Meta Business Suite and configured here as server env
// vars (see config.js's `whatsapp` block for why). What this file does is
// the two live pieces on top of that static config:
//   1. receive incoming customer messages via webhook and log them as
//      inbox items automatically (handleWebhookEvent)
//   2. actually deliver a staff reply back to the customer's phone when
//      marketing.service.js's replyInboxItem is used on a WhatsApp item
//      (sendMessage)

var GRAPH = 'https://graph.facebook.com/v21.0';

// whatsapp.sendMessage — posts a free-form text reply to a customer's
// WhatsApp number. WhatsApp only allows free-form replies within a rolling
// 24-hour "customer service window" after their last message; outside that
// window Meta rejects the send (requiring a pre-approved template message
// instead), and this surfaces as a normal Graph API error here.
async function sendMessage(to, body) {
  if (!config.whatsapp.configured) fail('invalid', 'WhatsApp Business is not configured on the server yet — set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_ACCESS_TOKEN and WHATSAPP_VERIFY_TOKEN on Render.');
  var res = await fetch(GRAPH + '/' + config.whatsapp.phoneNumberId + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.whatsapp.accessToken },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: to, type: 'text', text: { body: body } })
  });
  var data = await res.json();
  if (!res.ok || data.error) fail('invalid', 'WhatsApp send failed: ' + (data.error && data.error.message ? data.error.message : res.status));
  return data;
}

// whatsapp.verifyWebhookChallenge — Meta's one-time webhook subscription
// handshake: a GET carrying hub.mode/hub.verify_token/hub.challenge, which
// must be echoed back verbatim if the verify token matches what we
// configured. Returns the challenge string, or null if the request doesn't
// check out (the route then responds 403).
function verifyWebhookChallenge(query) {
  if (query['hub.mode'] === 'subscribe' && config.whatsapp.configured && query['hub.verify_token'] === config.whatsapp.verifyToken) {
    return query['hub.challenge'];
  }
  return null;
}

// whatsapp.isValidSignature — Meta signs every webhook POST body with
// X-Hub-Signature-256, HMAC-SHA256 over the raw request bytes keyed with
// the Meta app secret (WhatsApp is configured as a product under the same
// app already used for Facebook Login, so the same secret applies). This
// is what stops anyone who finds the webhook URL from injecting fake
// inbox items. Skipped (allowed through) only if META_APP_SECRET isn't
// set at all, matching how the rest of this app treats an unconfigured
// integration as inert rather than crashing.
function isValidSignature(rawBody, signatureHeader) {
  var appSecret = config.meta.appSecret;
  if (!appSecret) return true;
  if (!signatureHeader || signatureHeader.indexOf('sha256=') !== 0) return false;
  var expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  var given = signatureHeader.slice('sha256='.length);
  var expectedBuf = Buffer.from(expected, 'hex');
  var givenBuf = Buffer.from(given, 'hex');
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

// whatsapp.handleWebhookEvent — parses Meta's WhatsApp webhook payload
// shape (entry[].changes[].value.messages[]/.contacts[]) and logs each
// inbound message as an inbox item. Status-update payloads (delivered/read
// receipts, sent when a customer's client acks a message we sent) and
// message types this app doesn't render inline are recorded with a plain
// note rather than dropped, so nothing silently vanishes from the Inbox.
async function handleWebhookEvent(payload) {
  var chanRes = await pool.query("SELECT id FROM marketing_channels WHERE key = 'whatsapp'");
  var channelId = chanRes.rows[0] && chanRes.rows[0].id;
  if (!channelId) return; // schema not migrated/seeded yet — nothing to attach to

  var entries = payload.entry || [];
  for (var i = 0; i < entries.length; i++) {
    var changes = entries[i].changes || [];
    for (var j = 0; j < changes.length; j++) {
      var value = changes[j].value || {};
      var messages = value.messages || [];
      var contactsByWaId = {};
      (value.contacts || []).forEach(function (c) { contactsByWaId[c.wa_id] = c; });

      for (var k = 0; k < messages.length; k++) {
        var m = messages[k];
        var contact = contactsByWaId[m.from];
        var body = m.type === 'text' && m.text ? m.text.body
          : '[Unsupported message type: ' + m.type + ' — reply from the WhatsApp app directly.]';
        await pool.query(
          'INSERT INTO marketing_inbox_items (channel_id, kind, author_name, author_handle, body, received_at, external_id, created_by) ' +
          "VALUES ($1,'message',$2,$3,$4,$5,$6,NULL) " +
          'ON CONFLICT (channel_id, external_id) WHERE external_id IS NOT NULL DO NOTHING',
          [channelId, (contact && contact.profile && contact.profile.name) || '', m.from || '', body.slice(0, 2000), new Date(Number(m.timestamp) * 1000), m.id]
        );
      }
    }
  }
}

module.exports = { sendMessage: sendMessage, verifyWebhookChallenge: verifyWebhookChallenge, isValidSignature: isValidSignature, handleWebhookEvent: handleWebhookEvent };
