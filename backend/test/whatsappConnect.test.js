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
    if (/\/messages$/.test(url)) return reply(200, { messages: [{ id: 'wamid.zq.out.1' }] });
    return reply(404, { error: { message: 'not faked: ' + url } });
  };
}

test.before(async function () {
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  saved = { appId: config.meta.appId, appSecret: config.meta.appSecret, waConfigId: config.meta.waConfigId, verify: config.whatsapp.verifyToken, pn: config.whatsapp.phoneNumberId, tk: config.whatsapp.accessToken };
  config.meta.appId = 'zq-app'; config.meta.appSecret = 'zq-secret'; config.meta.waConfigId = 'zq-config';
  config.whatsapp.verifyToken = 'zq-phrase'; config.whatsapp.phoneNumberId = ''; config.whatsapp.accessToken = '';
  await pool.query('DELETE FROM whatsapp_connection');
  await access.load();
});
test.after(async function () {
  connect.setFetchForTests(null); whatsapp.setFetchForTests(null);
  await pool.query('DELETE FROM whatsapp_connection');
  config.meta.appId = saved.appId; config.meta.appSecret = saved.appSecret; config.meta.waConfigId = saved.waConfigId;
  config.whatsapp.verifyToken = saved.verify; config.whatsapp.phoneNumberId = saved.pn; config.whatsapp.accessToken = saved.tk;
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
