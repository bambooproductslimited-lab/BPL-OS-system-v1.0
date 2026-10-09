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
var WEBHOOK_URL = 'https://bamboo-os-backend.onrender.com/api/marketing/whatsapp/webhook';
// The webhook fields the OS reads: the messages; with the number kept in the
// WhatsApp Business app, the replies typed on the phone, the past chats and
// the saved contacts; and Meta's word on the number, account and templates
// (whatsappAlerts.service.js).
var FIELDS = ['messages', 'smb_message_echoes', 'history', 'smb_app_state_sync', 'phone_number_quality_update', 'account_update', 'message_template_status_update'];
var FIELDS_BASIC = ['messages', 'phone_number_quality_update', 'account_update', 'message_template_status_update'];
function appToken() { return config.meta.appId + '|' + config.meta.appSecret; }

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
    webhookUrl: WEBHOOK_URL,
    connection: rowOut(await current()),
    fromEnv: a && a.source === 'env' ? { phoneNumberId: a.phoneNumberId } : null,
    // What the test message and the templates screen can use.
    sending: a ? { source: a.source, phoneNumberId: a.phoneNumberId, displayPhone: a.displayPhone || '', templates: !!a.wabaId } : null
  };
}

// ── a test message, and message templates ────────────────────────────
// For Meta's App Review videos (sending from the app; creating a
// template through the API) — and for later: templates are how the OS will
// message customers who haven't written in the last 24 hours (reminders).
function sender() {
  var a = access.get();
  if (!a) fail('invalid', 'No WhatsApp number is set up: connect one above, or put the test number\'s ids and a token on Render.');
  return a;
}
function waTo(v) {
  var d = String(v || '').replace(/\D/g, '');
  if (d.length === 10 && d.charAt(0) === '0') d = '233' + d.slice(1);
  if (d.length < 8 || d.length > 15) fail('invalid', 'That phone number isn\'t right. Use the full number, e.g. 024 000 0000 or +233 24 000 0000.');
  return d;
}

// p: { to, template (default hello_world), language (default en_US), params: [..] }
async function sendTest(ctx, p) {
  need(ctx);
  var a = sender();
  var to = waTo(p && p.to);
  var name = String((p && p.template) || 'hello_world').trim();
  var lang = String((p && p.language) || 'en_US').trim();
  var params = ((p && p.params) || []).map(function (x) { return String(x || '').slice(0, 300); });
  var template = { name: name, language: { code: lang } };
  if (params.length) template.components = [{ type: 'body', parameters: params.map(function (t) { return { type: 'text', text: t }; }) }];
  var out;
  try {
    out = await graph('/' + a.phoneNumberId + '/messages', a.token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: to, type: 'template', template: template }) });
  } catch (e) {
    if (e.metaCode === 131030) fail('invalid', 'Meta only lets the test number message phones on its recipient list. Add this number in Meta → Connect on WhatsApp → Step 1. Try it out → Recipient.');
    fail('invalid', 'WhatsApp did not send it: ' + e.message);
  }
  await audit(pool, ctx, 'whatsapp.test_message', 'whatsapp_connection', a.phoneNumberId, 'Sent the WhatsApp template "' + name + '" to +' + to + '.');
  return { sent: true, to: '+' + to, template: name, messageId: out.messages && out.messages[0] && out.messages[0].id };
}

var CATEGORIES = ['UTILITY', 'MARKETING'];
function templateOut(t) {
  var body = (t.components || []).find(function (c) { return c.type === 'BODY'; });
  var text = body ? body.text : '';
  var vars = (text.match(/\{\{\d+\}\}/g) || []).length;
  return { id: t.id, name: t.name, status: t.status, category: t.category, language: t.language, body: text, variables: vars, rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null };
}
async function listTemplates(ctx) {
  need(ctx);
  var a = sender();
  if (!a.wabaId) fail('invalid', 'The WhatsApp Business Account ID isn\'t known: connect the number above, or set WHATSAPP_BUSINESS_ACCOUNT_ID on Render.');
  try {
    var r = await graph('/' + a.wabaId + '/message_templates?limit=100&fields=' + encodeURIComponent('id,name,status,category,language,components,rejected_reason'), a.token);
    return (r.data || []).map(templateOut);
  } catch (e) { fail('invalid', 'Meta did not list the templates: ' + e.message); }
}
// p: { name, category, language, body, examples: [..] } — a text template;
// {{1}}, {{2}} … in the body are filled in when it is sent.
async function createTemplate(ctx, p) {
  need(ctx);
  var a = sender();
  if (!a.wabaId) fail('invalid', 'The WhatsApp Business Account ID isn\'t known: connect the number above, or set WHATSAPP_BUSINESS_ACCOUNT_ID on Render.');
  var name = String((p && p.name) || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!/^[a-z0-9_]{1,512}$/.test(name)) fail('invalid', 'A template name uses only small letters, numbers and _ (e.g. order_ready).');
  var category = String((p && p.category) || 'UTILITY').toUpperCase();
  if (CATEGORIES.indexOf(category) < 0) fail('invalid', 'Choose Utility or Marketing.');
  var language = String((p && p.language) || 'en').trim();
  var body = String((p && p.body) || '').trim();
  if (!body) fail('invalid', 'Write the message.');
  if (body.length > 1024) fail('invalid', 'The message can be at most 1,024 characters.');
  var nums = (body.match(/\{\{(\d+)\}\}/g) || []).map(function (x) { return Number(x.replace(/\D/g, '')); });
  var count = nums.length ? Math.max.apply(null, nums) : 0;
  for (var i = 1; i <= count; i++) if (nums.indexOf(i) < 0) fail('invalid', 'Number the blanks in order: {{1}}, {{2}}, {{3}}…');
  var examples = ((p && p.examples) || []).map(function (x) { return String(x || '').trim(); });
  if (examples.length < count || examples.slice(0, count).some(function (x) { return !x; })) fail('invalid', 'Give an example for every blank — Meta needs them to review the template.');
  var comp = { type: 'BODY', text: body };
  if (count) comp.example = { body_text: [examples.slice(0, count)] };
  var out;
  try {
    out = await graph('/' + a.wabaId + '/message_templates', a.token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, category: category, language: language, components: [comp] }) });
  } catch (e) { fail('invalid', 'Meta did not accept the template: ' + e.message); }
  await audit(pool, ctx, 'whatsapp.template.create', 'whatsapp_connection', a.wabaId, 'Created the WhatsApp template "' + name + '" (' + category.toLowerCase() + ', ' + language + ').');
  return { id: out.id, name: name, status: out.status || 'PENDING', category: out.category || category };
}
async function deleteTemplate(ctx, name) {
  need(ctx);
  var a = sender();
  if (!a.wabaId) fail('invalid', 'The WhatsApp Business Account ID isn\'t known.');
  name = String(name || '').trim();
  if (!/^[a-z0-9_]{1,512}$/.test(name)) fail('invalid', 'Unknown template.');
  try { await graph('/' + a.wabaId + '/message_templates?name=' + encodeURIComponent(name), a.token, { method: 'DELETE' }); } catch (e) { fail('invalid', 'Meta did not delete it: ' + e.message); }
  await audit(pool, ctx, 'whatsapp.template.delete', 'whatsapp_connection', a.wabaId, 'Deleted the WhatsApp template "' + name + '".');
  return { deleted: true };
}

// ── the setup check ──────────────────────────────────────────────────
// Asks Meta, step by step, whether everything a WhatsApp message needs to
// reach the OS is in place, and says which step is not: the settings on
// Render, the app's id and secret, the app's webhook, the number, the
// token, the account's subscription to the app, and what has arrived.
// Each step: { key, state: ok | warn | bad | wait | skip, data, error, fix }
// (fix: 'webhook' | 'subscribe' | 'connect' — what the card offers).
var MESSAGING_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'];
async function check(ctx) {
  need(ctx);
  var steps = [];
  function add(key, state, data, error, fix) { steps.push({ key: key, state: state, data: data || {}, error: error || null, fix: fix || null }); }
  var missing = [!config.meta.appId && 'META_APP_ID', !config.meta.appSecret && 'META_APP_SECRET', !config.meta.waConfigId && 'META_WA_CONFIG_ID', !config.whatsapp.verifyToken && 'WHATSAPP_VERIFY_TOKEN'].filter(Boolean);
  add('settings', missing.length ? 'bad' : 'ok', { missing: missing });

  var app = null;
  if (!config.meta.appId || !config.meta.appSecret) add('app', 'skip');
  else {
    try { app = await graph('/' + encodeURIComponent(config.meta.appId) + '?fields=id,name&access_token=' + encodeURIComponent(appToken())); add('app', 'ok', { name: app.name || '' }); }
    catch (e) { add('app', 'bad', {}, e.message); }
  }

  if (!app) add('webhook', 'skip');
  else {
    try {
      var subs = await graph('/' + encodeURIComponent(config.meta.appId) + '/subscriptions?access_token=' + encodeURIComponent(appToken()));
      var wa = (subs.data || []).find(function (x) { return x.object === 'whatsapp_business_account'; });
      if (!wa) add('webhook', 'bad', { set: false, url: WEBHOOK_URL }, null, config.whatsapp.verifyToken ? 'webhook' : null);
      else {
        var names = (wa.fields || []).map(function (f) { return typeof f === 'string' ? f : f.name; });
        var lacking = FIELDS.filter(function (f) { return names.indexOf(f) < 0; });
        var data = { set: true, url: wa.callback_url || '', expected: WEBHOOK_URL, active: wa.active !== false, fields: names, lacking: lacking };
        var fixable = config.whatsapp.verifyToken ? 'webhook' : null;
        if (!data.active || data.url !== WEBHOOK_URL || names.indexOf('messages') < 0) add('webhook', 'bad', data, null, fixable);
        else if (lacking.length) add('webhook', 'warn', data, null, fixable);
        else add('webhook', 'ok', data);
      }
    } catch (e) { add('webhook', 'bad', {}, e.message, config.whatsapp.verifyToken ? 'webhook' : null); }
  }

  var a = access.get();
  if (!a) {
    add('number', 'bad', {}, null, 'connect');
    add('token', 'skip'); add('subscribed', 'skip');
  } else {
    var num = null;
    try { num = await graph('/' + a.phoneNumberId + '?fields=' + encodeURIComponent('display_phone_number,verified_name,status,name_status,quality_rating,platform_type,messaging_limit_tier'), a.token); }
    catch (e) {
      try { num = await graph('/' + a.phoneNumberId + '?fields=display_phone_number,verified_name', a.token); }
      catch (e2) { add('number', 'bad', { source: a.source, expired: /expired|session has been invalidated|Error validating access token/i.test(e2.message) }, e2.message, 'connect'); }
    }
    if (num) {
      var nd = { source: a.source, coexistence: !!a.coexistence, displayPhone: num.display_phone_number || a.displayPhone || '', verifiedName: num.verified_name || '',
        status: num.status || null, nameStatus: num.name_status || null, quality: num.quality_rating || null, platform: num.platform_type || null, tier: num.messaging_limit_tier || null };
      var nstate = nd.platform && nd.platform !== 'CLOUD_API' ? 'bad'
        : (nd.status && nd.status !== 'CONNECTED') || nd.nameStatus === 'DECLINED' || nd.quality === 'RED' ? 'warn' : 'ok';
      add('number', nstate, nd);
    }
    var tokenDead = false;
    if (!config.meta.appId || !config.meta.appSecret) add('token', 'skip');
    else {
      try {
        var dbg = (await graph('/debug_token?input_token=' + encodeURIComponent(a.token) + '&access_token=' + encodeURIComponent(appToken()))).data || {};
        var lackingScopes = MESSAGING_SCOPES.filter(function (sc) { return (dbg.scopes || []).indexOf(sc) < 0; });
        var expires = dbg.expires_at ? new Date(dbg.expires_at * 1000) : null;
        var td = { valid: !!dbg.is_valid, expiresAt: expires, lacking: lackingScopes, source: a.source };
        tokenDead = !dbg.is_valid;
        add('token', !dbg.is_valid || lackingScopes.length ? 'bad' : expires && expires.getTime() < Date.now() + 7 * 86400000 ? 'warn' : 'ok', td, null,
          !dbg.is_valid || lackingScopes.length || expires ? 'connect' : null);
      } catch (e) { add('token', 'bad', { source: a.source }, e.message, 'connect'); tokenDead = true; }
    }
    // Asking with a token that no longer works says nothing about the account.
    if (tokenDead) add('subscribed', 'skip', { tokenDead: true });
    else if (!a.wabaId) add('subscribed', 'skip', { noAccount: true });
    else {
      try {
        var sa = await graph('/' + a.wabaId + '/subscribed_apps', a.token);
        var appIds = (sa.data || []).map(function (x) { return String((x.whatsapp_business_api_data && x.whatsapp_business_api_data.id) || x.id || ''); });
        add('subscribed', appIds.indexOf(String(config.meta.appId)) >= 0 ? 'ok' : 'bad', { apps: appIds.length }, null, appIds.indexOf(String(config.meta.appId)) >= 0 ? null : 'subscribe');
      } catch (e) { add('subscribed', 'bad', {}, e.message, 'subscribe'); }
    }
  }

  // What has arrived: any message from Meta (whatsapp.routes.js notes each
  // one), and the last from a customer.
  var hook = (await pool.query("SELECT last_ok_at, last_run_at, last_error, items FROM crm_channel_state WHERE key = 'whatsapp:webhook'")).rows[0] || null;
  var lastIn = (await pool.query(
    "SELECT max(m.sent_at) FILTER (WHERE m.direction = 'in') AS t FROM crm_messages m JOIN crm_conversations c ON c.id = m.conversation_id WHERE c.channel = 'whatsapp' AND NOT c.imported")).rows[0];
  var rd = { lastAt: hook ? hook.last_ok_at : null, count: hook ? Number(hook.items) : 0, lastCustomerAt: lastIn ? lastIn.t : null };
  if (hook && hook.last_error === 'signature' && (!hook.last_ok_at || new Date(hook.last_run_at) > new Date(hook.last_ok_at))) add('receiving', 'bad', Object.assign(rd, { signature: true, badAt: hook.last_run_at }));
  else add('receiving', rd.lastAt ? 'ok' : 'wait', rd);

  var blocking = steps.filter(function (x) { return x.state === 'bad'; }).length;
  return { steps: steps, ready: !blocking, checkedAt: new Date(), webhookUrl: WEBHOOK_URL };
}

// Points the app's WhatsApp webhook at the OS (Meta then calls it once
// with the verify phrase, which whatsapp.routes.js answers).
async function setWebhook(ctx) {
  need(ctx);
  if (!config.meta.appId || !config.meta.appSecret) fail('invalid', 'META_APP_ID and META_APP_SECRET must be set on Render first.');
  if (!config.whatsapp.verifyToken) fail('invalid', 'WHATSAPP_VERIFY_TOKEN must be set on Render first.');
  async function post(fields) {
    var body = new URLSearchParams({ object: 'whatsapp_business_account', callback_url: WEBHOOK_URL, verify_token: config.whatsapp.verifyToken,
      fields: fields.join(','), include_values: 'true', access_token: appToken() });
    return graph('/' + encodeURIComponent(config.meta.appId) + '/subscriptions', null, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  }
  var used = FIELDS;
  try { await post(FIELDS); }
  catch (e) {
    // Fields only for numbers kept in the WhatsApp Business app may not be
    // offered to this app yet: the messages and Meta's notices still are.
    try { used = FIELDS_BASIC; await post(FIELDS_BASIC); }
    catch (e2) { fail('invalid', 'Meta did not set the webhook: ' + e2.message); }
  }
  await audit(pool, ctx, 'whatsapp.webhook', 'whatsapp_connection', config.meta.appId, 'Pointed the app\'s WhatsApp webhook at the OS (' + used.join(', ') + ').');
  return Object.assign(await check(ctx), { webhookFields: used });
}

// Subscribes the app to the number's WhatsApp Business Account, so its
// messages come to the webhook (also done when connecting).
async function subscribeAccount(ctx) {
  need(ctx);
  var a = access.get();
  if (!a) fail('invalid', 'No WhatsApp number is connected.');
  if (!a.wabaId) fail('invalid', 'The WhatsApp Business Account ID isn\'t known: connect the number above, or set WHATSAPP_BUSINESS_ACCOUNT_ID on Render.');
  try { await graph('/' + a.wabaId + '/subscribed_apps', a.token, { method: 'POST' }); } catch (e) { fail('invalid', 'Meta did not subscribe the app: ' + e.message); }
  await audit(pool, ctx, 'whatsapp.subscribe', 'whatsapp_connection', a.wabaId, 'Subscribed the app to the WhatsApp Business Account\'s messages.');
  return check(ctx);
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

module.exports = { info: info, finish: finish, resync: resync, disconnect: disconnect, sendTest: sendTest, listTemplates: listTemplates, createTemplate: createTemplate, deleteTemplate: deleteTemplate, check: check, setWebhook: setWebhook, subscribeAccount: subscribeAccount, setFetchForTests: setFetchForTests };
