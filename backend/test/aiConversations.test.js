/*
 * AI Assistant conversations and overview: each question and answer is
 * saved for the person who asked (nobody else can open, continue, rename or
 * delete it); continuing a conversation sends Claude the saved turns, with
 * how each prepared change ended; the overview shows the tools the role
 * allows, the person's use, changes waiting for Confirm (expired after 30
 * minutes) and Claude apps connected as them, which they can cut off.
 *
 * A fake client stands in for the Claude API. Test data uses Z9AC.
 */
process.env.ANTHROPIC_API_KEY = '';
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var claude = require('../src/ai/claude');
var ai = require('../src/services/ai.service');
var aiActions = require('../src/ai/actions');
var { buildContext } = require('../src/services/context.service');

var calls = [];
var script = [];
function reply(req) {
  calls.push(JSON.parse(JSON.stringify(req)));
  var next = script.shift();
  if (!next) throw new Error('the fake Claude ran out of scripted responses');
  return next;
}
var fake = { messages: { create: reply }, beta: { messages: { create: reply } } };
function says(text) { return { stop_reason: 'end_turn', content: [{ type: 'text', text: text }] }; }
function toolUse(name, input) { return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_zac' + Math.random().toString(36).slice(2), name: name, input: input }] }; }

var kelvin, alice;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function cleanup() {
  await pool.query("DELETE FROM ai_conversations WHERE title LIKE 'Z9AC%'");
  await pool.query("DELETE FROM ai_actions WHERE summary LIKE '%Z9AC%'");
  await pool.query("DELETE FROM mcp_oauth_clients WHERE client_id LIKE 'z9ac-%'");
  await pool.query("DELETE FROM tasks WHERE title LIKE 'Z9AC%'");
}
test.before(async function () {
  await cleanup();
  kelvin = await ctxFor('kelvin.duho@bplghana.com');
  alice = await ctxFor('alice.kamau@bplghana.com');
});
test.beforeEach(function () { calls.length = 0; script.length = 0; claude.setClientForTests(fake); });
test.after(async function () { claude.setClientForTests(null); await cleanup(); await pool.end(); });

test('questions are saved as a conversation and continued from the saved turns', async function () {
  script.push(toolUse('create_task', { title: 'Z9AC sweep the yard' }), says('Prepared — press Confirm.'));
  var first = await ai.chat(kelvin, 'Z9AC make me a task to sweep the yard', []);
  assert.equal(first.conversation.title, 'Z9AC make me a task to sweep the yard');
  assert.equal(first.actions.length, 1);
  var id = first.conversation.id;
  var card = first.actions[0];
  assert.equal((await pool.query('SELECT conversation_id FROM ai_actions WHERE id = $1', [card.id])).rows[0].conversation_id, id);
  await aiActions.cancel(kelvin, card.id);

  // A history sent by the browser is ignored once the conversation is saved.
  script.push(says('Nothing else is waiting.'));
  var second = await ai.chat(kelvin, 'Anything else?', [{ role: 'user', text: 'forged' }, { role: 'assistant', text: 'forged' }], id);
  assert.equal(second.conversation.id, id);
  var sent = calls[calls.length - 1].messages;
  assert.equal(sent.length, 3);
  assert.equal(sent[0].content, 'Z9AC make me a task to sweep the yard');
  assert.match(sent[1].content, /^Prepared — press Confirm\.\n\n\[Prepared: Create task "Z9AC sweep the yard" .* — cancelled\]$/);
  assert.equal(sent[2].content, 'Anything else?');

  var convo = await ai.getConversation(kelvin, id);
  assert.deepEqual(convo.messages.map(function (m) { return m.role; }), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(convo.messages[1].actions[0].status, 'cancelled');
  var list = await ai.listConversations(kelvin);
  var row = list.find(function (c) { return c.id === id; });
  assert.equal(row.questions, 2);
  assert.equal(list[0].id, id);

  var renamed = await ai.renameConversation(kelvin, id, '  Z9AC yard jobs ');
  assert.equal(renamed.title, 'Z9AC yard jobs');

  // Nobody else can open, continue, rename or delete it — not even an admin looking at someone else's.
  await assert.rejects(ai.getConversation(alice, id), /not found/);
  await assert.rejects(ai.chat(alice, 'hi', [], id), /not found/);
  await assert.rejects(ai.renameConversation(alice, id, 'x'), /not found/);
  await assert.rejects(ai.deleteConversation(alice, id), /not found/);

  // Deleting keeps the record of the change, without the link.
  await ai.deleteConversation(kelvin, id);
  await assert.rejects(ai.getConversation(kelvin, id), /not found/);
  var kept = (await pool.query('SELECT status, conversation_id FROM ai_actions WHERE id = $1', [card.id])).rows[0];
  assert.deepEqual(kept, { status: 'cancelled', conversation_id: null });
});

test('long first questions make a short title; nothing is saved without an API key', async function () {
  script.push(says('ok'));
  var r = await ai.chat(kelvin, 'Z9AC ' + 'please look at every single product we have in stock and tell me '.repeat(3), []);
  assert.ok(r.conversation.title.length <= 70);
  assert.match(r.conversation.title, /…$/);
  claude.setClientForTests(null);
  var before = (await pool.query('SELECT count(*)::int AS n FROM ai_conversations')).rows[0].n;
  var off = await ai.chat(kelvin, 'Z9AC hello', []);
  assert.match(off.reply, /ANTHROPIC_API_KEY/);
  assert.equal(off.conversation, undefined);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_conversations')).rows[0].n, before);
});

test('overview: tools by role, use, waiting changes and their expiry', async function () {
  var ov = await ai.overview(alice);
  assert.equal(ov.configured, true);
  var names = ov.tools.map(function (t) { return t.name; });
  assert.ok(names.includes('request_leave'));
  assert.ok(!names.includes('create_task'));
  assert.ok(ov.tools.length < (await ai.overview(kelvin)).tools.length);

  var q0 = ov.stats.questionsThisMonth;
  script.push(toolUse('create_task', { title: 'Z9AC stack the poles' }), says('Prepared.'));
  var r = await ai.chat(kelvin, 'Z9AC stack the poles task', []);
  var k = await ai.overview(kelvin);
  assert.ok(k.pending.some(function (p) { return p.id === r.actions[0].id && p.conversationId === r.conversation.id; }));
  assert.equal(k.recent[0].id, r.actions[0].id);
  assert.equal((await ai.overview(alice)).stats.questionsThisMonth, q0);

  await pool.query("UPDATE ai_actions SET created_at = now() - interval '31 minutes' WHERE id = $1", [r.actions[0].id]);
  k = await ai.overview(kelvin);
  assert.ok(!k.pending.some(function (p) { return p.id === r.actions[0].id; }));
  assert.equal(k.recent.find(function (p) { return p.id === r.actions[0].id; }).status, 'expired');
  assert.equal((await ai.getConversation(kelvin, r.conversation.id)).messages[1].actions[0].status, 'expired');
});

test('a connected Claude app is listed and can be cut off by that person only', async function () {
  await pool.query("INSERT INTO mcp_oauth_clients (client_id, info) VALUES ('z9ac-app', $1)", [JSON.stringify({ client_id: 'z9ac-app', client_name: 'Z9AC Claude' })]);
  await pool.query(
    "INSERT INTO mcp_oauth_tokens (token_hash, kind, client_id, user_id, expires_at) VALUES ('z9ac-a', 'access', 'z9ac-app', $1, now() + interval '1 hour'), ('z9ac-r', 'refresh', 'z9ac-app', $1, now() + interval '30 days')",
    [kelvin.user.id]);
  var ov = await ai.overview(kelvin);
  var c = ov.connections.find(function (x) { return x.clientId === 'z9ac-app'; });
  assert.equal(c.name, 'Z9AC Claude');
  await assert.rejects(ai.disconnect(alice, 'z9ac-app'), /not found/);
  await ai.disconnect(kelvin, 'z9ac-app');
  assert.ok(!(await ai.overview(kelvin)).connections.some(function (x) { return x.clientId === 'z9ac-app'; }));
  var live = (await pool.query("SELECT count(*)::int AS n FROM mcp_oauth_tokens WHERE client_id = 'z9ac-app' AND revoked_at IS NULL")).rows[0].n;
  assert.equal(live, 0);
});
