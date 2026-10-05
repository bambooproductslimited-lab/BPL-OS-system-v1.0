var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var config = require('../config');
var access = require('./whatsappAccess');

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
var fetchImpl = null; // tests replace Meta
function setFetchForTests(f) { fetchImpl = f; }

// whatsapp.sendMessage — posts a free-form text reply to a customer's
// WhatsApp number. WhatsApp only allows free-form replies within a rolling
// 24-hour "customer service window" after their last message; outside that
// window Meta rejects the send (requiring a pre-approved template message
// instead), and this surfaces as a normal Graph API error here.
async function sendMessage(to, body) {
  var a = access.get();
  if (!a) fail('invalid', 'WhatsApp Business is not configured yet — connect it on Integrations, or set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN on Render.');
  var res = await (fetchImpl || fetch)(GRAPH + '/' + a.phoneNumberId + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + a.token },
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
  if (query['hub.mode'] === 'subscribe' && config.whatsapp.verifyToken && query['hub.verify_token'] === config.whatsapp.verifyToken) {
    return query['hub.challenge'];
  }
  return null;
}

// whatsapp.isValidSignature — Meta signs every webhook POST body with
// X-Hub-Signature-256, HMAC-SHA256 over the raw request bytes keyed with
// the Meta app secret (WhatsApp is configured as a product under the same
// app already used for Facebook Login, so the same secret applies). This
// is what stops anyone who finds the webhook URL from injecting fake
// inbox items. Fails CLOSED (rejects every POST) if META_APP_SECRET isn't
// set — a security review flagged the previous behavior (silently
// accepting unsigned webhook bodies whenever the secret was missing) as a
// real auth bypass, not the same kind of "unconfigured = inert" tradeoff
// used elsewhere for optional features: WHATSAPP_* can be fully configured
// (phone number id, access token, verify token) independently of
// META_APP_SECRET, so this specific gap could exist even on an otherwise
// working WhatsApp integration. The GET verify-challenge handshake is
// unaffected — it only depends on WHATSAPP_VERIFY_TOKEN, not this secret.
function isValidSignature(rawBody, signatureHeader) {
  var appSecret = config.meta.appSecret;
  if (!appSecret) return false;
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
// A WhatsApp message as words for the CRM: its text, or what it was (a
// photo, a voice note…) with any caption — the media stays on WhatsApp.
function describe(m) {
  if (m.type === 'text' && m.text) return { body: m.text.body, attachments: [] };
  var media = m[m.type] || {};
  var label = { image: 'Photo', video: 'Video', audio: 'Voice note', document: 'Document', sticker: 'Sticker', location: 'Location', contacts: 'Contact card' }[m.type] || m.type;
  var body = media.caption || (m.type === 'location' && media.name ? media.name : '') || (m.type === 'button' && m.button ? m.button.text : '') ||
    (m.type === 'interactive' && m.interactive ? JSON.stringify(m.interactive).slice(0, 200) : '');
  return { body: body || '[' + label + ']', attachments: m.type === 'text' ? [] : [{ name: media.filename || label, type: media.mime_type || m.type }] };
}

async function handleWebhookEvent(payload) {
  var chanRes = await pool.query("SELECT id FROM marketing_channels WHERE key = 'whatsapp'");
  var channelId = chanRes.rows[0] && chanRes.rows[0].id;

  var entries = payload.entry || [];
  for (var i = 0; i < entries.length; i++) {
    var changes = entries[i].changes || [];
    for (var j = 0; j < changes.length; j++) {
      var value = changes[j].value || {};
      // Meta's word on the account, the number's quality, the templates.
      try { if (await require('./whatsappAlerts.service').take(changes[j].field, value)) continue; } catch (e) { console.error('[whatsapp] notice not kept:', e.message); }
      // Coexistence (the number also in the WhatsApp Business app on the
      // company phone): names saved on the phone, replies typed on the
      // phone, and the chats from before the number was connected.
      if (value.state_sync) await takeContactNames(value.state_sync);
      if (value.message_echoes) await takeEchoes(value.message_echoes);
      if (value.history) await takeHistory(value.history);

      var messages = value.messages || [];
      var contactsByWaId = {};
      (value.contacts || []).forEach(function (c) { contactsByWaId[c.wa_id] = c; });

      for (var k = 0; k < messages.length; k++) {
        var m = messages[k];
        var contact = contactsByWaId[m.from];
        var name = (contact && contact.profile && contact.profile.name) || '';
        var d = describe(m);
        if (channelId) {
          await pool.query(
            'INSERT INTO marketing_inbox_items (channel_id, kind, author_name, author_handle, body, received_at, external_id, created_by) ' +
            "VALUES ($1,'message',$2,$3,$4,$5,$6,NULL) " +
            'ON CONFLICT (channel_id, external_id) WHERE external_id IS NOT NULL DO NOTHING',
            [channelId, name, m.from || '', d.body.slice(0, 2000), new Date(Number(m.timestamp) * 1000), m.id]
          );
        }
        // The CRM: the conversation with this number, on its customer's
        // profile (made now if the number is new). The name saved on the
        // company phone wins over the customer's own WhatsApp name.
        try {
          await require('./crmInbox.service').ingest({
            channel: 'whatsapp', threadId: m.from,
            contact: { name: (await savedName(m.from)) || name, handles: [{ kind: 'phone', value: m.from }] },
            messages: [{ externalId: m.id, direction: 'in', author: name, body: d.body, attachments: d.attachments, sentAt: new Date(Number(m.timestamp) * 1000) }]
          });
        } catch (e) { console.error('[crm] WhatsApp message not kept:', e.message); }
      }
    }
  }
}

// ── coexistence ──────────────────────────────────────────────────────
// Who wrote a message typed on the company phone (no OS user sent it).
var PHONE_AUTHOR = 'Bamboo Products (phone)';
function when(ts) { var d = new Date(Number(ts) * 1000); return isNaN(d.getTime()) ? new Date() : d; }
function waNumber(v) { var d = String(v || '').replace(/\D/g, ''); return d.length >= 7 && d.length <= 15 ? d : null; }

async function savedName(wa) {
  var n = require('./crmInbox.service').normIdentity({ kind: 'phone', value: wa });
  if (!n) return '';
  var r = (await pool.query("SELECT name FROM crm_contact_names WHERE kind = 'phone' AND value = $1", [n.value])).rows[0];
  return r ? r.name : '';
}

// Contacts saved (or renamed) in the WhatsApp Business app: kept, and put on
// a profile that so far has only the number for a name.
async function takeContactNames(list) {
  var inbox = require('./crmInbox.service');
  for (var s of list || []) {
    if (!s || s.type !== 'contact' || !s.contact) continue;
    var n = inbox.normIdentity({ kind: 'phone', value: s.contact.phone_number });
    var name = String(s.contact.full_name || s.contact.first_name || '').trim().slice(0, 200);
    if (!n) continue;
    if (s.action === 'remove' || !name) { await pool.query("DELETE FROM crm_contact_names WHERE kind = 'phone' AND value = $1", [n.value]); continue; }
    await pool.query(
      "INSERT INTO crm_contact_names (kind, value, name) VALUES ('phone', $1, $2) ON CONFLICT (kind, value) DO UPDATE SET name = EXCLUDED.name, updated_at = now()",
      [n.value, name]);
    await pool.query("UPDATE crm_conversations SET contact_name = $2 WHERE channel = 'whatsapp' AND contact_kind = 'phone' AND contact_key = $1", [n.value, name]);
    await pool.query(
      "UPDATE customers c SET name = $2 FROM customer_identities i WHERE i.customer_id = c.id AND i.kind = 'phone' AND i.value = $1 " +
      "AND (c.name = i.label OR c.name ~ '^[+0-9 ()./-]+$')", [n.value, name]);
  }
}

// Replies typed in the WhatsApp Business app: our side of the conversation,
// so the customer no longer counts as waiting.
async function takeEchoes(list) {
  var inbox = require('./crmInbox.service');
  for (var e of list || []) {
    var to = waNumber(e && e.to);
    if (!to) continue;
    var d = describe(e);
    try {
      await inbox.ingest({
        channel: 'whatsapp', threadId: e.to,
        contact: { name: await savedName(to), handles: [{ kind: 'phone', value: to }] },
        messages: [{ externalId: e.id, direction: 'out', author: PHONE_AUTHOR, body: d.body, attachments: d.attachments, sentAt: when(e.timestamp) }]
      });
      await channelState('whatsapp:echoes', null, null, 1);
    } catch (err) { console.error('[crm] WhatsApp reply from the phone not kept:', err.message); }
  }
}

// The chats from before the number was connected (up to about 6 months),
// sent by Meta in chunks once the business agrees on the phone. They count
// as imported: no one is notified, and a chat that ended more than a week
// ago is filed as closed rather than "waiting".
var OLD_DAYS = 7;
async function takeHistory(list) {
  var inbox = require('./crmInbox.service');
  for (var h of list || []) {
    var meta = (h && h.metadata) || {};
    if (h && h.errors && h.errors.length) {
      var why = h.errors.map(function (x) { return x.message || x.title || x.code; }).join('; ').slice(0, 300);
      console.error('[crm] WhatsApp history not shared:', why);
      await channelState('whatsapp:history', null, why, 0);
      continue;
    }
    var added = 0;
    for (var t of (h && h.threads) || []) {
      var them = waNumber(t && t.id);
      if (!them) continue; // not a one-to-one chat with a number
      var msgs = ((t.messages) || []).map(function (m) {
        var d = describe(m);
        var mine = waNumber(m.from) !== them;
        return { externalId: m.id, direction: mine ? 'out' : 'in', author: mine ? PHONE_AUTHOR : '', body: d.body, attachments: d.attachments, sentAt: when(m.timestamp) };
      });
      if (!msgs.length) continue;
      try {
        var r = await inbox.ingest({ channel: 'whatsapp', threadId: t.id, imported: true, contact: { name: await savedName(them), handles: [{ kind: 'phone', value: them }] }, messages: msgs });
        added += r.added;
        await pool.query("UPDATE crm_conversations SET status = 'closed' WHERE id = $1 AND status = 'open' AND last_message_at < now() - make_interval(days => $2)", [r.conversationId, OLD_DAYS]);
      } catch (err) { console.error('[crm] WhatsApp history thread not kept:', err.message); }
    }
    await channelState('whatsapp:history', JSON.stringify({ phase: meta.phase, chunk: meta.chunk_order, progress: meta.progress }), null, added);
  }
}

async function channelState(key, cursor, error, items) {
  await pool.query(
    'INSERT INTO crm_channel_state (key, cursor, last_run_at, last_ok_at, last_error, items) VALUES ($1,$2,now(),CASE WHEN $3::text IS NULL THEN now() END,$3,$4) ' +
    'ON CONFLICT (key) DO UPDATE SET cursor = COALESCE($2, crm_channel_state.cursor), last_run_at = now(), ' +
    'last_ok_at = CASE WHEN $3::text IS NULL THEN now() ELSE crm_channel_state.last_ok_at END, last_error = $3, items = crm_channel_state.items + $4',
    [key, cursor, error, items || 0]);
}

// For Data health: what has come in from WhatsApp so far.
async function status() {
  var rows = (await pool.query("SELECT key, cursor, last_ok_at, last_error, items FROM crm_channel_state WHERE key IN ('whatsapp:history', 'whatsapp:echoes')")).rows;
  var by = {};
  rows.forEach(function (r) { by[r.key] = r; });
  var last = (await pool.query(
    "SELECT max(m.sent_at) FILTER (WHERE m.direction = 'in') AS last_in FROM crm_messages m JOIN crm_conversations c ON c.id = m.conversation_id WHERE c.channel = 'whatsapp' AND NOT c.imported")).rows[0];
  var h = by['whatsapp:history'];
  var cur = null;
  try { cur = h && h.cursor ? JSON.parse(h.cursor) : null; } catch (e) { cur = null; }
  return {
    configured: access.configured(), signed: !!config.meta.appSecret, verifyToken: !!config.whatsapp.verifyToken,
    number: access.get() ? { source: access.get().source, displayPhone: access.get().displayPhone, coexistence: access.get().coexistence } : null,
    lastInAt: last ? last.last_in : null,
    phoneReplies: by['whatsapp:echoes'] ? { items: by['whatsapp:echoes'].items, lastAt: by['whatsapp:echoes'].last_ok_at } : null,
    history: h ? { items: h.items, progress: cur && cur.progress != null ? Number(cur.progress) : null, lastAt: h.last_ok_at, error: h.last_error } : null,
    alerts: await require('./whatsappAlerts.service').summary()
  };
}

module.exports = { sendMessage: sendMessage, verifyWebhookChallenge: verifyWebhookChallenge, isValidSignature: isValidSignature, handleWebhookEvent: handleWebhookEvent, status: status, setFetchForTests: setFetchForTests };
