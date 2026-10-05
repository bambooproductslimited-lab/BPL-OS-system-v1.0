/*
 * Connecting the company's WhatsApp number from the OS (Integrations →
 * WhatsApp) with Meta's Embedded Signup — the way Meta lets a number that is
 * already in the WhatsApp Business app on a phone also be used through the
 * Cloud API ("coexistence"): the phone keeps working, and the OS gets every
 * message, the replies typed on the phone, the saved contacts and up to about
 * 6 months of past chats (whatsapp.service.js files them).
 *
 * The browser opens Meta's window (the Facebook JS SDK, with
 * META_APP_ID and META_WA_CONFIG_ID) and the person scans the QR code with
 * the WhatsApp Business app. Meta then gives the page a one-time code and the
 * number's ids; finish() swaps the code for the business token (with
 * META_APP_SECRET, here on the server), subscribes the app to the account's
 * webhooks, and asks Meta to send the contacts and past chats — which Meta
 * only allows within 24 hours of connecting. A number that is not in the
 * app (a new number) is registered for the Cloud API instead.
 */
var crypto = require('crypto');
var config = require('../config');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var access = require('./whatsappAccess');

var GRAPH = 'https://graph.facebook.com/v21.0';
var SYNC_HOURS = 24;

var fetchImpl = null; // tests replace Meta
function setFetchForTests(f) { fetchImpl = f; }

function need(ctx) { if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).'); }
function me(ctx) { return ctx && ctx.employee ? ctx.employee.id : null; }

async function graph(path, token, opts) {
  var url = GRAPH + path;
  var o = Object.assign({ headers: {} }, opts || {});
  if (token) o.headers = Object.assign({ Authorization: 'Bearer ' + token }, o.headers);
  var res = await (fetchImpl || fetch)(url, o);
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok || data.error) {
    var e = new Error((data.error && (data.error.error_user_msg || data.error.message)) || ('Meta answered ' + res.status));
    e.metaCode = data.error && data.error.code;
    throw e;
  }
  return data;
}

function rowOut(r) {
  if (!r) return null;
  var syncUntil = new Date(new Date(r.connected_at).getTime() + SYNC_HOURS * 3600000);
  return {
    wabaId: r.waba_id, phoneNumberId: r.phone_number_id, displayPhone: r.display_phone, verifiedName: r.verified_name,
    coexistence: r.coexistence, connectedAt: r.connected_at, connectedBy: r.connected_by_name || null,
    historyRequestedAt: r.history_requested_at, contactsRequestedAt: r.contacts_requested_at, lastError: r.last_error,
    canRequestHistory: r.coexistence && syncUntil > new Date(), syncUntil: syncUntil
  };
}
async function current() {
  return (await pool.query(
    "SELECT w.*, e.first_name || ' ' || e.last_name AS connected_by_name FROM whatsapp_connection w LEFT JOIN employees e ON e.id = w.connected_by WHERE w.id = 1")).rows[0] || null;
}

// What the Integrations card needs: whether the button can work, and what is connected.
async function info(ctx) {
  need(ctx);
  var a = access.get();
  return {
    appId: config.meta.appId || null, configId: config.meta.waConfigId || null,
    ready: !!(config.meta.appId && config.meta.appSecret && config.meta.waConfigId),
    missing: [!config.meta.appId && 'META_APP_ID', !config.meta.appSecret && 'META_APP_SECRET', !config.meta.waConfigId && 'META_WA_CONFIG_ID', !config.whatsapp.verifyToken && 'WHATSAPP_VERIFY_TOKEN'].filter(Boolean),
    webhookUrl: 'https://bamboo-os-backend.onrender.com/api/marketing/whatsapp/webhook',
    connection: rowOut(await current()),
    fromEnv: a && a.source === 'env' ? { phoneNumberId: a.phoneNumberId } : null
  };
}

// Ask Meta to send the contacts saved in the app, then the past chats.
async function requestSync(phoneNumberId, token) {
  var out = { contacts: null, history: null, error: null };
  try {
    await graph('/' + phoneNumberId + '/smb_app_data', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' }) });
    out.contacts = new Date();
    await graph('/' + phoneNumberId + '/smb_app_data', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: 'history' }) });
    out.history = new Date();
  } catch (e) { out.error = e.message; }
  return out;
}

// p: { code, wabaId, phoneNumberId, coexistence }
async function finish(ctx, p) {
  need(ctx);
  if (!config.meta.appId || !config.meta.appSecret) fail('invalid', 'META_APP_ID and META_APP_SECRET must be set on Render first.');
  var code = String((p && p.code) || '').trim();
  var wabaId = String((p && p.wabaId) || '').replace(/\D/g, '');
  var phoneId = String((p && p.phoneNumberId) || '').replace(/\D/g, '');
  if (!code) fail('invalid', 'Meta did not send the sign-in code. Try again.');
  if (!wabaId || !phoneId) fail('invalid', 'Meta did not say which WhatsApp number was connected. Try again, and finish every step in Meta\'s window.');
  var coex = !!(p && p.coexistence);

  var tok;
  try {
    tok = await graph('/oauth/access_token?client_id=' + encodeURIComponent(config.meta.appId) + '&client_secret=' + encodeURIComponent(config.meta.appSecret) + '&code=' + encodeURIComponent(code));
  } catch (e) { fail('invalid', 'Meta did not accept the sign-in: ' + e.message); }
  var token = tok.access_token;
  if (!token) fail('invalid', 'Meta did not send an access token.');

  // Messages for this account come to our webhook.
  try { await graph('/' + wabaId + '/subscribed_apps', token, { method: 'POST' }); } catch (e) { fail('invalid', 'Could not subscribe to the WhatsApp account\'s messages: ' + e.message); }
  // A new number (not in the app) is registered for the Cloud API, with a
  // two-step PIN of its own. A number from the app is already registered.
  if (!coex) {
    try {
      await graph('/' + phoneId + '/register', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', pin: String(crypto.randomInt(100000, 1000000)) }) });
    } catch (e) { if (!/already registered/i.test(e.message)) fail('invalid', 'Could not register the number: ' + e.message); }
  }
  var num = {};
  try { num = await graph('/' + phoneId + '?fields=display_phone_number,verified_name', token); } catch (e) { num = {}; }

  await pool.query(
    'INSERT INTO whatsapp_connection (id, waba_id, phone_number_id, display_phone, verified_name, access_token, coexistence, connected_by, connected_at, history_requested_at, contacts_requested_at, last_error) ' +
    'VALUES (1,$1,$2,$3,$4,$5,$6,$7,now(),NULL,NULL,NULL) ON CONFLICT (id) DO UPDATE SET waba_id = EXCLUDED.waba_id, phone_number_id = EXCLUDED.phone_number_id, ' +
    'display_phone = EXCLUDED.display_phone, verified_name = EXCLUDED.verified_name, access_token = EXCLUDED.access_token, coexistence = EXCLUDED.coexistence, ' +
    'connected_by = EXCLUDED.connected_by, connected_at = now(), history_requested_at = NULL, contacts_requested_at = NULL, last_error = NULL',
    [wabaId, phoneId, num.display_phone_number || '', num.verified_name || '', token, coex, me(ctx)]);
  await access.load();

  if (coex) {
    var s = await requestSync(phoneId, token);
    await pool.query('UPDATE whatsapp_connection SET contacts_requested_at = $1, history_requested_at = $2, last_error = $3 WHERE id = 1', [s.contacts, s.history, s.error]);
  }
  await audit(pool, ctx, 'whatsapp.connect', 'whatsapp_connection', phoneId,
    'Connected WhatsApp ' + (num.display_phone_number || phoneId) + (coex ? ' (kept in the WhatsApp Business app)' : '') + '.');
  return info(ctx);
}

// Ask again for the contacts and past chats (only within 24 hours of connecting).
async function resync(ctx) {
  need(ctx);
  var r = await current();
  if (!r) fail('invalid', 'No WhatsApp number is connected.');
  if (!rowOut(r).canRequestHistory) fail('invalid', 'Meta only sends past chats within 24 hours of connecting. To get them now, disconnect and connect the number again.');
  var s = await requestSync(r.phone_number_id, r.access_token);
  await pool.query('UPDATE whatsapp_connection SET contacts_requested_at = COALESCE($1, contacts_requested_at), history_requested_at = COALESCE($2, history_requested_at), last_error = $3 WHERE id = 1', [s.contacts, s.history, s.error]);
  if (s.error) fail('invalid', 'Meta refused: ' + s.error);
  return info(ctx);
}

// Forget the connection here (Meta and the phone are not touched).
async function disconnect(ctx) {
  need(ctx);
  var r = await current();
  if (!r) return info(ctx);
  await pool.query('DELETE FROM whatsapp_connection WHERE id = 1');
  await access.load();
  await audit(pool, ctx, 'whatsapp.disconnect', 'whatsapp_connection', r.phone_number_id, 'Disconnected WhatsApp ' + (r.display_phone || r.phone_number_id) + ' from the OS.');
  return info(ctx);
}

module.exports = { info: info, finish: finish, resync: resync, disconnect: disconnect, setFetchForTests: setFetchForTests };
