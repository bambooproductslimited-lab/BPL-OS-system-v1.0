/*
 * Integrations → WhatsApp: connecting the company number with Meta's
 * Embedded Signup. Meta is a fake here (setFetchForTests); nothing leaves
 * the machine. Fake ids and numbers only.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var config = require('../src/config');
var connect = require('../src/services/whatsappConnect.service');
var access = require('../src/services/whatsappAccess');
var whatsapp = require('../src/services/whatsapp.service');

var admin, calls = [];
var saved = {};
function fakeMeta(opts) {
  opts = opts || {};
  return async function (url, o) {
    calls.push({ url: url, method: (o && o.method) || 'GET', body: o && o.body, auth: o && o.headers && o.headers.Authorization });
    var reply = function (status, data) { return { ok: status < 400, status: status, json: async function () { return data; } }; };
    if (/\/oauth\/access_token/.test(url)) return opts.badCode ? reply(400, { error: { message: 'Invalid verification code format.' } }) : reply(200, { access_token: 'zq-business-token' });
    if (/\/subscribed_apps$/.test(url)) return reply(200, { success: true });
    if (/\/register$/.test(url)) return reply(200, { success: true });
    if (/\/smb_app_data$/.test(url)) return opts.syncRefused ? reply(400, { error: { message: 'Onboarding was more than 24 hours ago.' } }) : reply(200, { success: true });
    if (/fields=display_phone_number/.test(url)) return reply(200, { display_phone_number: '+233 20 555 0700', verified_name: 'Zq Bamboo Test' });
    if (/\/messages$/.test(url)) {
      if (opts.notRecipient) return reply(400, { error: { message: 'Recipient phone number not in allowed list', code: 131030 } });
      return reply(200, { messages: [{ id: 'wamid.zq.out.1' }] });
    }
    if (/\/message_templates\?limit=/.test(url)) return reply(200, { data: [
      { id: 't1', name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Hello World!' }] },
      { id: 't2', name: 'zq_order_ready', status: 'REJECTED', category: 'UTILITY', language: 'en', rejected_reason: 'INVALID_FORMAT', components: [{ type: 'BODY', text: 'Hi {{1}}, order {{2}} is ready.' }] }] });
    if (/\/message_templates\?name=/.test(url)) return reply(200, { success: true });
    if (/\/message_templates$/.test(url)) return reply(200, { id: 't3', status: 'PENDING', category: 'UTILITY' });
    return reply(404, { error: { message: 'not faked: ' + url } });
  };
}

test.before(async function () {
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  saved = { appId: config.meta.appId, appSecret: config.meta.appSecret, waConfigId: config.meta.waConfigId, verify: config.whatsapp.verifyToken, pn: config.whatsapp.phoneNumberId, tk: config.whatsapp.accessToken, waba: config.whatsapp.businessAccountId };
  config.meta.appId = 'zq-app'; config.meta.appSecret = 'zq-secret'; config.meta.waConfigId = 'zq-config';
  config.whatsapp.verifyToken = 'zq-phrase'; config.whatsapp.phoneNumberId = ''; config.whatsapp.accessToken = '';
  await pool.query('DELETE FROM whatsapp_connection');
  await pool.query('DELETE FROM whatsapp_alerts');
  await access.load();
});
test.after(async function () {
  connect.setFetchForTests(null); whatsapp.setFetchForTests(null);
  await pool.query('DELETE FROM whatsapp_connection');
  await pool.query('DELETE FROM whatsapp_alerts');
  config.meta.appId = saved.appId; config.meta.appSecret = saved.appSecret; config.meta.waConfigId = saved.waConfigId;
  config.whatsapp.verifyToken = saved.verify; config.whatsapp.phoneNumberId = saved.pn; config.whatsapp.accessToken = saved.tk; config.whatsapp.businessAccountId = saved.waba;
  await access.load();
  await pool.end();
});

test('the card says what is missing, and only settings managers may connect', async function () {
  config.meta.waConfigId = '';
  var i = await connect.info(admin);
  assert.deepEqual([i.ready, i.missing], [false, ['META_WA_CONFIG_ID']]);
  config.meta.waConfigId = 'zq-config';
  assert.equal((await connect.info(admin)).ready, true);
  var nobody = { can: function () { return false; }, employee: null };
  await assert.rejects(connect.finish(nobody, { code: 'x', wabaId: '1', phoneNumberId: '2' }), /settings.manage/);
});

test('a number kept in the WhatsApp Business app: token swapped, webhooks subscribed, contacts and past chats asked for, nothing registered', async function () {
  calls = []; connect.setFetchForTests(fakeMeta());
  var out = await connect.finish(admin, { code: 'zq-code', wabaId: '9900112233', phoneNumberId: '5500112233', coexistence: true });
  assert.equal(out.connection.displayPhone, '+233 20 555 0700');
  assert.equal(out.connection.coexistence, true);
  assert.ok(out.connection.historyRequestedAt && out.connection.contactsRequestedAt);
  var swap = calls.find(function (c) { return /oauth\/access_token/.test(c.url); });
  assert.match(swap.url, /client_secret=zq-secret/, 'the secret is used on the server');
  assert.ok(calls.some(function (c) { return /9900112233\/subscribed_apps$/.test(c.url) && c.auth === 'Bearer zq-business-token'; }));
  assert.ok(!calls.some(function (c) { return /\/register$/.test(c.url); }), 'a number from the app is not registered again');
  var syncs = calls.filter(function (c) { return /smb_app_data$/.test(c.url); }).map(function (c) { return JSON.parse(c.body).sync_type; });
  assert.deepEqual(syncs, ['smb_app_state_sync', 'history']);
  // The OS now sends with the connected number, not the Render settings.
  assert.equal(access.get().phoneNumberId, '5500112233');
  assert.equal(access.configured(), true);
  calls = []; whatsapp.setFetchForTests(fakeMeta());
  await whatsapp.sendMessage('233205550700', 'Zq hello');
  assert.ok(calls.some(function (c) { return /5500112233\/messages$/.test(c.url) && c.auth === 'Bearer zq-business-token'; }));
  // The token never leaves the server.
  assert.ok(!JSON.stringify(out).includes('zq-business-token'));
  var st = await whatsapp.status();
  assert.deepEqual([st.configured, st.number.coexistence, st.number.source], [true, true, 'connect']);
});

test('asking again for past chats, and Meta\'s 24-hour limit', async function () {
  calls = []; connect.setFetchForTests(fakeMeta());
  await connect.resync(admin);
  assert.equal(calls.filter(function (c) { return /smb_app_data$/.test(c.url); }).length, 2);
  await pool.query("UPDATE whatsapp_connection SET connected_at = now() - interval '25 hours'");
  await assert.rejects(connect.resync(admin), /24 hours/);
});

test('a new number is registered; a bad code is refused; disconnecting falls back to the Render settings', async function () {
  calls = []; connect.setFetchForTests(fakeMeta());
  await connect.finish(admin, { code: 'zq-code-2', wabaId: '9900112244', phoneNumberId: '5500112244', coexistence: false });
  var reg = calls.find(function (c) { return /5500112244\/register$/.test(c.url); });
  assert.ok(reg, 'registered');
  assert.match(JSON.parse(reg.body).pin, /^\d{6}$/);
  assert.ok(!calls.some(function (c) { return /smb_app_data$/.test(c.url); }), 'no history for a new number');

  connect.setFetchForTests(fakeMeta({ badCode: true }));
  await assert.rejects(connect.finish(admin, { code: 'bad', wabaId: '1', phoneNumberId: '2', coexistence: true }), /did not accept the sign-in/);
  assert.equal(access.get().phoneNumberId, '5500112244', 'a failed attempt keeps the connection');

  config.whatsapp.phoneNumberId = 'zq-env-number'; config.whatsapp.accessToken = 'zq-env-token';
  await connect.disconnect(admin);
  assert.deepEqual([access.get().source, access.get().phoneNumberId], ['env', 'zq-env-number']);
  config.whatsapp.phoneNumberId = ''; config.whatsapp.accessToken = '';
  await access.load();
  assert.equal(access.configured(), false);
});

test('Meta\'s webhook handshake needs only the verify phrase', function () {
  assert.equal(whatsapp.verifyWebhookChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'zq-phrase', 'hub.challenge': '4711' }), '4711');
  assert.equal(whatsapp.verifyWebhookChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '4711' }), null);
});

test('Meta\'s notices become Data health warnings: quality, sending limit, account, templates', async function () {
  var alerts = require('../src/services/whatsappAlerts.service');
  function notice(field, value) { return { entry: [{ id: 'zq-waba', changes: [{ field: field, value: value }] }] }; }
  var since = new Date();
  await whatsapp.handleWebhookEvent(notice('phone_number_quality_update', { display_phone_number: '233205550700', event: 'FLAGGED', current_limit: 'TIER_1K' }));
  await whatsapp.handleWebhookEvent(notice('phone_number_quality_update', { display_phone_number: '233205550700', event: 'DOWNGRADE', current_limit: 'TIER_250', old_limit: 'TIER_1K' }));
  await whatsapp.handleWebhookEvent(notice('account_update', { phone_number: '233205550700', event: 'ACCOUNT_RESTRICTION', restriction_info: [{ restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: String(Math.floor(Date.now() / 1000) + 86400) }] }));
  await whatsapp.handleWebhookEvent(notice('message_template_status_update', { event: 'REJECTED', message_template_id: 1, message_template_name: 'zq_payment_reminder', message_template_language: 'en', reason: 'INCORRECT_CATEGORY' }));
  var s = await alerts.summary();
  assert.equal(s.open.length, 4);
  assert.equal(s.limit, '250');
  assert.equal(s.quality.flagged, false, 'the latest quality word is the downgrade');
  assert.deepEqual([s.account.event, s.account.details.restriction], ['ACCOUNT_RESTRICTION', 'RESTRICTED_BIZ_INITIATED_MESSAGING']);
  assert.deepEqual([s.templates[0].details.name, s.templates[0].details.reason], ['zq_payment_reminder', 'INCORRECT_CATEGORY']);
  // The serious ones reach the people who manage the settings.
  var n = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE title LIKE 'WhatsApp:%' AND at >= $1 AND employee_id = $2", [since, admin.employee.id])).rows[0].n;
  assert.ok(n >= 4, 'notified');
  // Good news clears the warnings of its kind; the template approved clears its rejection.
  await whatsapp.handleWebhookEvent(notice('phone_number_quality_update', { display_phone_number: '233205550700', event: 'UPGRADE', current_limit: 'TIER_10K' }));
  await whatsapp.handleWebhookEvent(notice('message_template_status_update', { event: 'APPROVED', message_template_name: 'zq_payment_reminder', message_template_language: 'en', reason: 'NONE' }));
  s = await alerts.summary();
  assert.deepEqual(s.open.map(function (a) { return a.kind; }), ['account']);
  assert.equal(s.limit, '10000');
  // Dismissed by hand; and a notice is not mistaken for a message.
  await alerts.dismiss(admin, s.open[0].id);
  assert.equal((await alerts.summary()).open.length, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM crm_conversations WHERE external_thread_id = '233205550700'")).rows[0].n, 0);
  var nobody = { can: function () { return false; }, employee: null };
  await assert.rejects(alerts.dismiss(nobody, s.open[0].id), /settings.manage/);
  assert.ok((await whatsapp.status()).alerts, 'Data health gets them');
});

test('a test message (a template, so any phone works) and message templates, for Meta\'s App Review videos', async function () {
  config.whatsapp.phoneNumberId = 'zq-test-number'; config.whatsapp.accessToken = 'zq-temp-token'; config.whatsapp.businessAccountId = 'zq-test-waba';
  await pool.query('DELETE FROM whatsapp_connection'); await access.load();
  connect.setFetchForTests(fakeMeta()); calls = [];
  var i = await connect.info(admin);
  assert.deepEqual([i.sending.source, i.sending.templates], ['env', true]);

  var sent = await connect.sendTest(admin, { to: '020 555 0711' });
  assert.equal(sent.to, '+233205550711');
  var call = calls.find(function (c) { return /zq-test-number\/messages$/.test(c.url); });
  var body = JSON.parse(call.body);
  assert.deepEqual([body.to, body.type, body.template.name, body.template.language.code], ['233205550711', 'template', 'hello_world', 'en_US']);
  assert.equal(call.auth, 'Bearer zq-temp-token');
  calls = [];
  await connect.sendTest(admin, { to: '+233205550711', template: 'zq_order_ready', language: 'en', params: ['Ama', 'SO-0088'] });
  assert.deepEqual(JSON.parse(calls[0].body).template.components[0].parameters.map(function (x) { return x.text; }), ['Ama', 'SO-0088']);
  await assert.rejects(connect.sendTest(admin, { to: '12' }), /isn't right/);
  connect.setFetchForTests(fakeMeta({ notRecipient: true }));
  await assert.rejects(connect.sendTest(admin, { to: '0205550799' }), /recipient list/);
  connect.setFetchForTests(fakeMeta());

  var list = await connect.listTemplates(admin);
  assert.deepEqual(list.map(function (t) { return [t.name, t.status, t.variables]; }), [['hello_world', 'APPROVED', 0], ['zq_order_ready', 'REJECTED', 2]]);
  assert.equal(list[1].rejectedReason, 'INVALID_FORMAT');

  calls = [];
  var made = await connect.createTemplate(admin, { name: 'Zq Order Ready', category: 'utility', language: 'en', body: 'Hi {{1}}, your order {{2}} is ready for pickup.', examples: ['Ama', 'SO-0088'] });
  assert.deepEqual([made.name, made.status], ['zq_order_ready', 'PENDING']);
  var tb = JSON.parse(calls.find(function (c) { return /message_templates$/.test(c.url); }).body);
  assert.deepEqual([tb.category, tb.components[0].example.body_text[0]], ['UTILITY', ['Ama', 'SO-0088']]);
  await assert.rejects(connect.createTemplate(admin, { name: 'x', body: 'Hi {{1}}', examples: [] }), /example for every blank/);
  await assert.rejects(connect.createTemplate(admin, { name: 'x', body: 'Hi {{2}}', examples: ['a', 'b'] }), /in order/);
  await assert.rejects(connect.createTemplate(admin, { name: 'Bad name!', body: 'Hi' }), /small letters/);
  await connect.deleteTemplate(admin, 'zq_order_ready');
  assert.ok(calls.some(function (c) { return c.method === 'DELETE' && /name=zq_order_ready/.test(c.url); }));
  var nobody = { can: function () { return false; }, employee: null };
  await assert.rejects(connect.sendTest(nobody, { to: '0205550711' }), /settings.manage/);

  config.whatsapp.phoneNumberId = ''; config.whatsapp.accessToken = ''; config.whatsapp.businessAccountId = '';
  await access.load();
  await assert.rejects(connect.sendTest(admin, { to: '0205550711' }), /No WhatsApp number is set up/);
});

// ── the setup check ──────────────────────────────────────────────────
// A Meta where every step can be made right or wrong.
function checkMeta(o) {
  o = o || {};
  var base = fakeMeta();
  return async function (url, opt) {
    var method = (opt && opt.method) || 'GET';
    calls.push({ url: url, method: method, body: opt && opt.body, auth: opt && opt.headers && opt.headers.Authorization });
    var reply = function (status, data) { return { ok: status < 400, status: status, json: async function () { return data; } }; };
    if (/\/zq-app\?fields=id,name/.test(url)) return o.badSecret ? reply(400, { error: { message: 'Error validating client secret.' } }) : reply(200, { id: 'zq-app', name: 'Zq OS Tracker' });
    if (/\/zq-app\/subscriptions/.test(url) && method === 'POST') return o.noSmbFields && /smb_message_echoes/.test(String(opt.body)) ? reply(400, { error: { message: 'Invalid field smb_message_echoes' } }) : reply(200, { success: true });
    if (/\/zq-app\/subscriptions/.test(url)) return reply(200, { data: o.noWebhook ? [] : [{ object: 'whatsapp_business_account', callback_url: o.wrongUrl ? 'https://zq.example.com/hook' : 'https://bamboo-os-backend.onrender.com/api/marketing/whatsapp/webhook', active: true,
      fields: (o.fewFields ? ['messages'] : ['messages', 'smb_message_echoes', 'history', 'smb_app_state_sync', 'phone_number_quality_update', 'account_update', 'message_template_status_update']).map(function (n) { return { name: n, version: 'v21.0' }; }) }] });
    if (/\/debug_token\?/.test(url)) return reply(200, { data: { is_valid: !o.badToken, expires_at: 0, scopes: o.noScope ? ['business_management'] : ['business_management', 'whatsapp_business_messaging', 'whatsapp_business_management'] } });
    if (/\/subscribed_apps$/.test(url) && method === 'GET') return reply(200, { data: o.notSubscribed ? [] : [{ whatsapp_business_api_data: { id: 'zq-app', name: 'Zq OS Tracker' } }] });
    if (/fields=display_phone_number/.test(url)) return reply(200, { display_phone_number: '+233 20 555 0700', verified_name: 'Zq Bamboo Test', status: o.flagged ? 'FLAGGED' : 'CONNECTED', platform_type: 'CLOUD_API', quality_rating: 'GREEN', name_status: 'APPROVED' });
    return base(url, opt);
  };
}
function stepOf(r, key) { return r.steps.find(function (s) { return s.key === key; }); }

test('the setup check: each step Meta has to have in place, and what to do when one is not', async function () {
  await pool.query("DELETE FROM crm_channel_state WHERE key = 'whatsapp:webhook'");
  await pool.query("INSERT INTO whatsapp_connection (id, waba_id, phone_number_id, display_phone, verified_name, access_token, coexistence, connected_at) VALUES (1, 'zq-waba', 'zq-phone', '+233 20 555 0700', 'Zq Bamboo Test', 'zq-business-token', true, now()) ON CONFLICT (id) DO NOTHING");
  await access.load();

  connect.setFetchForTests(checkMeta());
  var r = await connect.check(admin);
  assert.deepEqual(r.steps.map(function (s) { return s.key + ':' + s.state; }), ['settings:ok', 'app:ok', 'webhook:ok', 'number:ok', 'token:ok', 'subscribed:ok', 'receiving:wait']);
  assert.equal(r.ready, true);
  assert.equal(stepOf(r, 'app').data.name, 'Zq OS Tracker');
  assert.equal(stepOf(r, 'token').data.expiresAt, null, 'a token that never expires');
  // The app token is the id and secret; the number's token is the business token.
  assert.ok(calls.some(function (c) { return /debug_token\?input_token=zq-business-token&access_token=zq-app%7Czq-secret/.test(c.url); }));

  // Nothing pointed at the OS yet: the button sets it, with every field.
  connect.setFetchForTests(checkMeta({ noWebhook: true }));
  r = await connect.check(admin);
  assert.deepEqual([stepOf(r, 'webhook').state, stepOf(r, 'webhook').fix, r.ready], ['bad', 'webhook', false]);
  calls = [];
  await connect.setWebhook(admin);
  var post = calls.find(function (c) { return c.method === 'POST' && /\/zq-app\/subscriptions$/.test(c.url); });
  var form = new URLSearchParams(post.body);
  assert.deepEqual([form.get('object'), form.get('callback_url'), form.get('verify_token')], ['whatsapp_business_account', 'https://bamboo-os-backend.onrender.com/api/marketing/whatsapp/webhook', 'zq-phrase']);
  assert.ok(form.get('fields').split(',').indexOf('history') >= 0);
  // Meta not offering the WhatsApp Business app fields: the messages still.
  connect.setFetchForTests(checkMeta({ noWebhook: true, noSmbFields: true }));
  var set = await connect.setWebhook(admin);
  assert.deepEqual(set.webhookFields, ['messages', 'phone_number_quality_update', 'account_update', 'message_template_status_update']);
  // Pointed elsewhere, or only messages.
  connect.setFetchForTests(checkMeta({ wrongUrl: true }));
  assert.equal(stepOf(await connect.check(admin), 'webhook').state, 'bad');
  connect.setFetchForTests(checkMeta({ fewFields: true }));
  assert.equal(stepOf(await connect.check(admin), 'webhook').state, 'warn');

  // A wrong secret; a token that no longer works or lacks WhatsApp; the account not subscribed; a flagged number.
  connect.setFetchForTests(checkMeta({ badSecret: true }));
  r = await connect.check(admin);
  assert.deepEqual([stepOf(r, 'app').state, stepOf(r, 'webhook').state], ['bad', 'skip']);
  assert.match(stepOf(r, 'app').error, /client secret/);
  connect.setFetchForTests(checkMeta({ badToken: true }));
  assert.deepEqual([stepOf(await connect.check(admin), 'token').state, stepOf(await connect.check(admin), 'token').fix], ['bad', 'connect']);
  connect.setFetchForTests(checkMeta({ noScope: true }));
  assert.deepEqual(stepOf(await connect.check(admin), 'token').data.lacking, ['whatsapp_business_messaging', 'whatsapp_business_management']);
  connect.setFetchForTests(checkMeta({ notSubscribed: true }));
  r = await connect.check(admin);
  assert.deepEqual([stepOf(r, 'subscribed').state, stepOf(r, 'subscribed').fix], ['bad', 'subscribe']);
  calls = [];
  await connect.subscribeAccount(admin);
  assert.ok(calls.some(function (c) { return c.method === 'POST' && /\/zq-waba\/subscribed_apps$/.test(c.url) && c.auth === 'Bearer zq-business-token'; }));
  connect.setFetchForTests(checkMeta({ flagged: true }));
  assert.equal(stepOf(await connect.check(admin), 'number').state, 'warn');

  // What arrives: a call signed with another secret, then a good one.
  connect.setFetchForTests(checkMeta());
  await whatsapp.noteWebhook(false);
  r = await connect.check(admin);
  assert.deepEqual([stepOf(r, 'receiving').state, stepOf(r, 'receiving').data.signature], ['bad', true]);
  await new Promise(function (res) { setTimeout(res, 20); });
  await whatsapp.noteWebhook(true);
  r = await connect.check(admin);
  assert.equal(stepOf(r, 'receiving').state, 'ok');
  assert.equal(stepOf(r, 'receiving').data.count, 1);

  // Settings missing on Render.
  config.whatsapp.verifyToken = '';
  r = await connect.check(admin);
  assert.deepEqual(stepOf(r, 'settings').data.missing, ['WHATSAPP_VERIFY_TOKEN']);
  await assert.rejects(connect.setWebhook(admin), /WHATSAPP_VERIFY_TOKEN/);
  config.whatsapp.verifyToken = 'zq-phrase';
  var nobody = { can: function () { return false; }, employee: null };
  await assert.rejects(connect.check(nobody), /settings.manage/);
  await assert.rejects(connect.setWebhook(nobody), /settings.manage/);

  await pool.query("DELETE FROM crm_channel_state WHERE key = 'whatsapp:webhook'");
  await pool.query('DELETE FROM whatsapp_connection'); await access.load();
});
