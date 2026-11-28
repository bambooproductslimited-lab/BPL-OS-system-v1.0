// What a customer wants, read from their chats (crmInterests.service.js):
// Claude's reading (a fake client here — no real API call), kept on the
// profile, shown on the lead; read again only when they write again; the
// catalogue's words without an API key.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var claude = require('../src/ai/claude');
var crm = require('../src/services/crm.service');
var inbox = require('../src/services/crmInbox.service');
var interests = require('../src/services/crmInterests.service');

var boss, calls = [], answer = null, stop = 'end_turn';
var fake = {
  messages: { create: async function (req) { calls.push(req); return reply(); } },
  beta: { messages: { create: async function (req) { calls.push(req); return reply(); } } }
};
function reply() {
  return { model: 'claude-opus-5-5', stop_reason: stop, content: stop === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(answer) }] };
}
function chat(number, name, body, minutesAgo, direction) {
  return inbox.ingest({
    channel: 'whatsapp', threadId: 'zqi-' + number, contact: { name: name, handles: [{ kind: 'phone', value: number }] },
    messages: [{ externalId: 'zqi-' + number + '-' + Math.random(), direction: direction || 'in', body: body, sentAt: new Date(Date.now() - minutesAgo * 60000).toISOString() }]
  });
}
async function cleanup() {
  await pool.query("DELETE FROM crm_leads WHERE name LIKE 'Zqi%'");
  await pool.query("DELETE FROM crm_conversations WHERE external_thread_id LIKE 'zqi-%'");
  await pool.query("DELETE FROM customers WHERE name LIKE 'Zqi%' OR name LIKE '+233 2_ 555 02%'");
  await pool.query("DELETE FROM products WHERE sku LIKE 'ZQI-%'");
}
test.before(async function () {
  await cleanup();
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await pool.query("INSERT INTO products (sku, name, active) VALUES ('ZQI-BED', 'Zqi Bamboo Bed Queen', true), ('ZQI-LOU', 'Zqi Louver Blind', true)");
  claude.setClientForTests(fake);
});
test.after(async function () { claude.setClientForTests(null); await cleanup(); await pool.end(); });

test('their chat is read: what they want goes on the profile and on the lead', async function () {
  var w = await chat('+233 24 555 0201', 'Zqi Ama', 'Hello, how much is the queen bamboo bed? I need 2 for my guest house in Kumasi', 30);
  await chat('+233 24 555 0201', 'Zqi Ama', 'It is GHS 4,500 each. Where should we deliver?', 28, 'out');
  await chat('+233 24 555 0201', 'Zqi Ama', 'Kumasi, Ahodwo. Can you do it before Christmas? I will pay by momo', 25);
  var lead = await crm.createLead(boss, { name: 'Zqi Ama (fair)', phone: '024 555 0201' });
  assert.equal(lead.customerId, w.customerId);
  assert.equal(lead.item || '', '');

  answer = {
    summary: 'Guest house owner in Kumasi who wants two queen bamboo beds before Christmas.',
    interests: [{ item: 'Queen bamboo bed', catalogMatch: 'Zqi Bamboo Bed Queen', quantity: '2', details: 'for a guest house, before Christmas' },
      { item: 'Bedside tables', catalogMatch: 'Not in the catalogue', quantity: '', details: '' }],
    questions: [{ topic: 'price', text: 'How much is the queen bed?' }, { topic: 'delivery', text: 'Delivery to Ahodwo, Kumasi before Christmas' }],
    intent: 'ready_to_buy', nextStep: 'Send a quotation for 2 queen beds with delivery to Kumasi.'
  };
  calls.length = 0;
  var run = await interests.runDue();
  assert.equal(run.read >= 1, true);
  var req = calls.find(function (c) { return /guest house in Kumasi/.test(c.messages[0].content); });
  assert.ok(req, 'Claude was asked about this customer');
  assert.equal(req.output_config.format.type, 'json_schema', 'a fixed JSON shape');
  assert.ok(req.output_config.effort, 'the effort set for the OS goes with it');
  assert.match(req.system[0].text, /Zqi Bamboo Bed Queen/, 'with the catalogue to match against');
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
  assert.match(req.messages[0].content, /Customer: Hello, how much is the queen bamboo bed/);
  assert.match(req.messages[0].content, /Bamboo: It is GHS 4,500 each/);

  var got = await interests.getFor(boss, w.customerId);
  var r = got.reading;
  assert.equal(r.source, 'ai');
  assert.equal(r.intent, 'ready_to_buy');
  assert.equal(r.interests[0].productName, 'Zqi Bamboo Bed Queen', 'matched to the catalogue');
  assert.equal(r.interests[0].quantity, '2');
  assert.equal(r.interests[1].productId, null, 'a name not in the catalogue is not a match');
  assert.equal(r.questions.length, 2);
  assert.equal(r.messagesRead, 3);
  assert.equal(r.stale, false);

  var now = await crm.getLead(boss, lead.id);
  assert.equal(now.item, 'Zqi Bamboo Bed Queen, Bedside tables', 'the lead had no item: it has one now');
  assert.ok(now.notes.some(function (n) { return /Item filled in from their chat/.test(n.body); }));
  var listed = (await crm.listLeads(boss, { stage: 'all', q: 'Zqi Ama (fair)' }))[0];
  assert.deepEqual(listed.chat.interests, ['Zqi Bamboo Bed Queen', 'Bedside tables']);
  assert.equal(listed.chat.intent, 'ready_to_buy');
});

test('the Saturday review: what their chats say, on the card and for the week', async function () {
  var weekly = require('../src/services/crmWeekly.service');
  var w = await weekly.week(boss, {});
  var card = w.leads.list.find(function (l) { return l.name === 'Zqi Ama (fair)'; });
  assert.deepEqual(card.chat.interests, ['Zqi Bamboo Bed Queen', 'Bedside tables']);
  assert.equal(card.chat.intent, 'ready_to_buy');
  assert.ok(w.chats.people >= 1);
  assert.ok(w.chats.wants.some(function (x) { return x.item === 'Zqi Bamboo Bed Queen' && x.inCatalogue; }));
  assert.ok(w.chats.topics.some(function (x) { return x.topic === 'price'; }));
  var judged = w.chats.intents.reduce(function (t, x) { return t + x.n; }, 0);
  assert.equal(judged + w.chats.notJudged, w.chats.people, 'every reader counted once: judged, or read without AI');
  var ready = w.chats.ready.find(function (r) { return r.name === 'Zqi Ama'; });
  assert.ok(ready, 'ready to buy, by name');
  assert.match(ready.nextStep, /quotation/);
  assert.ok(ready.leadId, 'opens their lead');
  assert.equal(ready.answered, true, 'we wrote back this week');
});

test('read again only when they write again, once the chat is quiet', async function () {
  var c = (await pool.query("SELECT customer_id FROM crm_conversations WHERE external_thread_id = 'zqi-+233 24 555 0201'")).rows[0].customer_id;
  assert.equal((await interests.due(500)).indexOf(c), -1, 'nothing new: not read again');
  await chat('+233 24 555 0201', 'Zqi Ama', 'Also the louver blinds for the windows', 2);
  assert.equal((await interests.due(500)).indexOf(c), -1, 'still writing: wait till the chat is quiet');
  await pool.query("UPDATE crm_messages SET sent_at = now() - interval '20 minutes' WHERE body = 'Also the louver blinds for the windows'");
  await pool.query("UPDATE crm_conversations SET last_message_at = now() - interval '20 minutes' WHERE external_thread_id = 'zqi-+233 24 555 0201'");
  assert.ok((await interests.due(500)).indexOf(c) >= 0, 'quiet now: read again');
  assert.equal((await interests.getFor(boss, c)).reading.stale, true, 'the screen knows it is behind');
});

test('a reading the AI declines is kept with its reason and not tried again and again', async function () {
  var w = await chat('+233 24 555 0202', 'Zqi Kofi', 'Do you sell bamboo poles?', 30);
  stop = 'refusal';
  await interests.runDue();
  stop = 'end_turn';
  var r = (await interests.getFor(boss, w.customerId)).reading;
  assert.match(r.error, /declined/);
  assert.equal((await interests.due(500)).indexOf(w.customerId), -1);
});

test('without an API key: the catalogue\'s words and the kinds of question', async function () {
  claude.setClientForTests(null);
  try {
    var w = await chat('+233 24 555 0203', 'Zqi Efua', 'Hi, do you have zqi louver blinds? What is the price and can you deliver to Tema?', 30);
    var r = await interests.analyse(w.customerId, {});
    assert.equal(r.source, 'rules');
    assert.equal(r.interests[0].productName, 'Zqi Louver Blind');
    var topics = r.questions.map(function (q) { return q.topic; });
    assert.ok(topics.indexOf('price') >= 0 && topics.indexOf('delivery') >= 0 && topics.indexOf('availability') >= 0);
  } finally { claude.setClientForTests(fake); }
});

test('who may see it, and who may have it read again', async function () {
  var c = (await pool.query("SELECT customer_id FROM crm_conversations WHERE external_thread_id = 'zqi-+233 24 555 0201'")).rows[0].customer_id;
  var reader = { user: { id: null }, employee: boss.employee, can: function (p) { return p === 'crm.read'; } };
  assert.ok((await interests.getFor(reader, c)).reading);
  await assert.rejects(interests.readNow(reader, c), function (e) { return e.code === 'forbidden'; });
  await assert.rejects(interests.getFor({ user: { id: null }, employee: boss.employee, can: function () { return false; } }, c), function (e) { return e.code === 'forbidden'; });
  answer.intent = 'interested';
  var again = await interests.readNow(boss, c);
  assert.equal(again.reading.intent, 'interested');
});
