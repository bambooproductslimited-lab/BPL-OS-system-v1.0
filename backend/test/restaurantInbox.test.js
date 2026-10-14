// A restaurant's message inbox (restaurantInbox.service.js, migration 0149):
// WhatsApp to the restaurant's own number and Messenger to its own Page
// land in its Guest CRM — never in the sales CRM — put with the guest by
// number; replies go out on the same channel within Meta's 24 hours; a
// chat can be put with a guest or make one. Meta is faked: nothing is sent.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var inbox = require('../src/services/restaurantInbox.service');
var whatsapp = require('../src/services/whatsapp.service');
var meta = require('../src/services/crmMeta.service');

var boss, sbr, bgn, guestId;
var NUMBER = 'zq-sbr-number-1', PAGE = 'zq-sbr-page-1';
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function reader(ctx, perms) { return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (x) { return perms.indexOf(x) >= 0; } }); }
async function cleanup() {
  await pool.query("DELETE FROM restaurant_conversations WHERE company_id IN (SELECT id FROM companies WHERE code IN ('SBR', 'BGN'))");
  await pool.query("DELETE FROM restaurant_guests WHERE name LIKE 'Zq Inbox%'");
  await pool.query("DELETE FROM company_whatsapp WHERE phone_number_id LIKE 'zq-%'");
  await pool.query("DELETE FROM marketing_oauth_tokens WHERE channel_key = 'sbr-facebook'");
  await pool.query("DELETE FROM crm_channel_state WHERE key LIKE 'restaurant:%'");
}
function waDelivery(to, value) { return { entry: [{ changes: [{ field: 'messages', value: Object.assign({ metadata: { phone_number_id: to } }, value) }] }] }; }
var now = function () { return String(Math.floor(Date.now() / 1000)); };

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  sbr = (await pool.query("SELECT id FROM companies WHERE code = 'SBR'")).rows[0].id;
  bgn = (await pool.query("SELECT id FROM companies WHERE code = 'BGN'")).rows[0].id;
  await cleanup();
  await pool.query("INSERT INTO company_whatsapp (company_id, waba_id, phone_number_id, display_phone, access_token) VALUES ($1, 'zq-waba', $2, '+233 30 000 0001', 'zq-token')", [sbr, NUMBER]);
  guestId = (await pool.query("INSERT INTO restaurant_guests (company_id, name, phone, source) VALUES ($1, 'Zq Inbox Ama', '024 111 2222', 'manual') RETURNING id", [sbr])).rows[0].id;
});
test.after(async function () { inbox.setFetchForTests(null); meta.setFetchForTests(null); await cleanup(); await pool.end(); });

test('a WhatsApp message to the restaurant\'s number lands in its inbox, with the guest, and not in the sales CRM', async function () {
  var d = waDelivery(NUMBER, { contacts: [{ wa_id: '233241112222', profile: { name: 'Ama Z' } }], messages: [{ id: 'zq-wamid-1', from: '233241112222', timestamp: now(), type: 'text', text: { body: 'Zq: is there jollof today?' } }] });
  await whatsapp.handleWebhookEvent(d);
  await whatsapp.handleWebhookEvent(d); // Meta sends again: kept once
  var l = await inbox.list(boss, { companyId: sbr });
  assert.equal(l.conversations.length, 1);
  var c = l.conversations[0];
  assert.equal(c.channel, 'whatsapp');
  assert.equal(c.contactHandle, '+233 24 111 2222');
  assert.equal(c.guest.id, guestId, 'put with the guest who has that number');
  assert.equal(c.unread, 1);
  assert.equal(c.waiting, true);
  assert.equal(c.canReply, true);
  assert.equal(l.counts.waiting, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM crm_conversations WHERE external_thread_id = '233241112222'")).rows[0].n, 0, 'not in the sales CRM');
  assert.equal((await inbox.list(boss, { companyId: bgn })).conversations.length, 0, 'the other restaurant does not see it');

  var full = await inbox.get(boss, c.id);
  assert.equal(full.messages.length, 1);
  assert.equal(full.messages[0].body, 'Zq: is there jollof today?');
  assert.equal(full.guest.orders, 0);
  assert.equal((await inbox.list(boss, { companyId: sbr })).conversations[0].unread, 0, 'opened: read');
});

test('a reply goes out from the restaurant\'s number; a reply typed on the phone is kept as ours; 24 hours on, no reply', async function () {
  var c = (await inbox.list(boss, { companyId: sbr, channel: 'whatsapp' })).conversations[0];
  var sent = [];
  inbox.setFetchForTests(async function (url, opts) { sent.push({ url: url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) }); return { ok: true, json: async function () { return { messages: [{ id: 'zq-wamid-out-1' }] }; } }; });
  await assert.rejects(inbox.reply(reader(boss, ['restaurant.read']), c.id, { body: 'Yes' }), /restaurant.manage/);
  var r = await inbox.reply(boss, c.id, { body: 'Zq: yes, until 9pm' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/zq-sbr-number-1\/messages$/);
  assert.equal(sent[0].auth, 'Bearer zq-token');
  assert.deepEqual([sent[0].body.to, sent[0].body.text.body], ['233241112222', 'Zq: yes, until 9pm']);
  assert.equal(r.waiting, false);
  assert.equal(r.messages[r.messages.length - 1].fromOs, true);

  await whatsapp.handleWebhookEvent(waDelivery(NUMBER, { message_echoes: [{ id: 'zq-echo-1', from: '233300000001', to: '233241112222', timestamp: now(), type: 'text', text: { body: 'Zq: see you soon' } }] }));
  r = await inbox.get(boss, c.id);
  var echo = r.messages.find(function (m) { return m.body === 'Zq: see you soon'; });
  assert.deepEqual([echo.direction, echo.author, echo.fromOs], ['out', 'Star Bar Restaurant (phone)', false]);

  await pool.query("UPDATE restaurant_messages SET sent_at = now() - interval '2 days' WHERE conversation_id = $1", [c.id]);
  await assert.rejects(inbox.reply(boss, c.id, { body: 'Hello?' }), /24 hours/);
  assert.equal(sent.length, 1);
});

test('a Messenger message to the restaurant\'s Page lands in its inbox; a chat makes a new guest', async function () {
  await pool.query("INSERT INTO marketing_oauth_tokens (channel_key, access_token, open_id, scope, expires_at) VALUES ('sbr-facebook', 'zq-page-token', $1, 'pages_messaging,pages_show_list', now() + interval '1 year')", [PAGE]);
  meta.setFetchForTests(async function (url) {
    if (/\/zq-psid-1\?fields=/.test(url)) return { ok: true, json: async function () { return { name: 'Zq Inbox Kofi' }; } };
    if (/conversations\?platform=messenger&user_id=/.test(url)) return { ok: true, json: async function () { return { data: [{ id: 'zq-thread-1' }] }; } };
    return { ok: true, json: async function () { return {}; } };
  });
  var r = await meta.handleWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: 'zq-psid-1' }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: 'zq-mid-1', text: 'Zq: a table for 4 tonight?' } }] }] });
  assert.equal(r.added, 1);
  var c = (await inbox.list(boss, { companyId: sbr, channel: 'facebook' })).conversations[0];
  assert.equal(c.contactName, 'Zq Inbox Kofi');
  assert.equal(c.guest, null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM crm_conversations WHERE contact_key = 'zq-psid-1'")).rows[0].n, 0, 'not in the sales CRM');

  await assert.rejects(inbox.linkGuest(boss, c.id, { guestId: (await pool.query("INSERT INTO restaurant_guests (company_id, name, source) VALUES ($1, 'Zq Inbox Other', 'manual') RETURNING id", [bgn])).rows[0].id }), /not this restaurant/);
  var linked = await inbox.linkGuest(boss, c.id, { create: true });
  assert.equal(linked.guest.name, 'Zq Inbox Kofi');
  assert.equal((await pool.query('SELECT source FROM restaurant_guests WHERE id = $1', [linked.guest.id])).rows[0].source, 'message');

  var closed = await inbox.setStatus(boss, c.id, { status: 'closed' });
  assert.equal(closed.status, 'closed');
  assert.equal((await inbox.list(boss, { companyId: sbr, status: 'closed' })).conversations.length, 1);
});

test('who may: restaurant.read reads, the connections say what is set up; Bamboo Products is the CRM\'s', async function () {
  await assert.rejects(inbox.list(reader(boss, ['crm.read']), { companyId: sbr }), /restaurant.read/);
  var l = await inbox.list(reader(boss, ['restaurant.read']), { companyId: sbr });
  assert.equal(l.connections.whatsapp.connection.displayPhone, '+233 30 000 0001');
  assert.equal(l.connections.whatsapp.canConnect, false);
  assert.equal(l.connections.facebook.connected, true);
  assert.equal(l.connections.facebook.messages, true);
  assert.equal(l.connections.instagram.connected, false);
  var bpl = (await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0].id;
  await assert.rejects(inbox.list(boss, { companyId: bpl }), /CRM inbox/);
  await assert.rejects(inbox.connectWhatsapp(reader(boss, ['restaurant.read']), { companyId: sbr }), /restaurant.manage/);
});
