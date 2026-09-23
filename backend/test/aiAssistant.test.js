/*
 * The AI Assistant: Claude answering from the OS's tools and preparing
 * changes that happen only when the person presses Confirm.
 *
 * No test calls the real Claude API. A fake client stands in for the SDK
 * (src/ai/claude.js's setClientForTests), plays back scripted responses —
 * "call this tool", "here is my answer" — and records every request, so the
 * tests can see exactly what the server sent Claude: which tools, which
 * results, which model settings.
 *
 * Test data uses the Z9AI prefix and is removed afterwards.
 * Requires `npm run migrate && npm run seed` first (the pretest hook).
 */
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_MODEL = 'claude-opus-5';
delete process.env.ANTHROPIC_EFFORT;

var test = require('node:test');
var assert = require('node:assert/strict');
var Anthropic = require('@anthropic-ai/sdk');
var app = require('../src/app');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var claude = require('../src/ai/claude');
var actions = require('../src/ai/actions');
var { buildContext } = require('../src/services/context.service');

var server, base;
var calls = [];
var script = [];

var fake = {
  messages: { create: function (req) { return answer('messages', req); } },
  beta: { messages: { create: function (req) { return answer('beta', req); } } }
};
async function answer(api, req) {
  calls.push({ api: api, req: JSON.parse(JSON.stringify(req)) });
  var next = script.shift();
  if (!next) throw new Error('the fake Claude ran out of scripted responses');
  return typeof next === 'function' ? next(req) : next;
}

var useCount = 0;
function toolUse(name, input) {
  useCount++;
  return { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_' + useCount, name: name, input: input }] };
}
function says(text) { return { stop_reason: 'end_turn', content: [{ type: 'text', text: text }] }; }

// The tool_result blocks the server sent back on the Nth request.
function resultsSentOn(n) {
  var msgs = calls[n].req.messages;
  return msgs[msgs.length - 1].content;
}

async function cleanup() {
  await pool.query("DELETE FROM ai_actions WHERE summary LIKE '%Z9AI%'");
  await pool.query("DELETE FROM notifications WHERE body LIKE 'Z9AI%'");
  await pool.query("DELETE FROM tasks WHERE title LIKE 'Z9AI%'");
  await pool.query("DELETE FROM customers WHERE name LIKE 'Z9AI%'");
  await pool.query("DELETE FROM inventory_tx WHERE item_type = 'product' AND item_id IN (SELECT id FROM products WHERE sku LIKE 'Z9AI%')");
  await pool.query("DELETE FROM products WHERE sku LIKE 'Z9AI%'");
}

var tokens = {};
async function login(email) {
  if (tokens[email]) return tokens[email];
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: 'bamboo123' })
  });
  tokens[email] = (await res.json()).token;
  return tokens[email];
}
var KELVIN = 'kelvin.duho@bplghana.com'; // administrator
var ALICE = 'alice.kamau@bplghana.com';  // employee: may request leave, nothing more

async function post(email, path, body) {
  var res = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await login(email) },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json() };
}
async function ask(email, message, history) {
  var r = await post(email, '/api/ai/chat', { message: message, history: history || [] });
  assert.equal(r.status, 200);
  return r.body;
}

test.before(async function () {
  await cleanup();
  await pool.query("INSERT INTO products (sku, name, category, unit, current_stock, reorder_level, cost_price, selling_price) VALUES ('Z9AI-1', 'Z9AI Test Slats', 'Bamboo', 'pcs', 7, 2, 1, 2)");
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
});
test.beforeEach(function () { calls.length = 0; script.length = 0; claude.setClientForTests(fake); });
test.after(async function () { claude.setClientForTests(null); server.close(); await cleanup(); await pool.end(); });

test('with no API key the assistant says so instead of failing', async function () {
  claude.setClientForTests(null);
  var r = await ask(ALICE, 'Hello');
  assert.match(r.reply, /ANTHROPIC_API_KEY/);
  assert.deepEqual(r.actions, []);
});

test('a question is answered from the tools, run as the person asking', async function () {
  script.push(toolUse('search_products', { query: 'Z9AI' }), says('There are 7 Z9AI Test Slats in stock.'));
  var r = await ask(KELVIN, 'How many Z9AI slats do we have?');
  assert.equal(r.reply, 'There are 7 Z9AI Test Slats in stock.');
  assert.deepEqual(r.actions, []);

  assert.equal(calls.length, 2);
  var first = calls[0];
  // Opus 5 with server-side fallbacks, medium effort, the stable prompt cached.
  assert.equal(first.api, 'beta');
  assert.equal(first.req.model, 'claude-opus-5');
  assert.equal(first.req.fallbacks, 'default');
  assert.deepEqual(first.req.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(first.req.output_config, { effort: 'medium' });
  assert.deepEqual(first.req.system[0].cache_control, { type: 'ephemeral' });
  assert.match(first.req.system[1].text, /Kelvin Duho/);
  assert.doesNotMatch(first.req.system[0].text, /Kelvin/, 'the cached block must not change per person');

  var results = resultsSentOn(1);
  assert.equal(results[0].type, 'tool_result');
  assert.equal(results[0].tool_use_id, 'toolu_' + useCount);
  var found = JSON.parse(results[0].content);
  assert.equal(found.total, 1);
  assert.equal(found.items[0].sku, 'Z9AI-1');
  assert.equal(found.items[0].stock, 7);
  // Claude's own turn went back unchanged, before the results.
  assert.equal(calls[1].req.messages[calls[1].req.messages.length - 2].content[1].type, 'tool_use');
});

test("Claude is offered only the tools the person's role allows", async function () {
  script.push(says('ok'), says('ok'));
  await ask(ALICE, 'What can you do?');
  await ask(KELVIN, 'What can you do?');
  var alices = calls[0].req.tools.map(function (t) { return t.name; });
  var kelvins = calls[1].req.tools.map(function (t) { return t.name; });
  ['create_task', 'add_customer', 'update_product_stock', 'search_products', 'search_customers', 'list_invoices', 'get_approval_queue'].forEach(function (n) {
    assert.ok(alices.indexOf(n) < 0, n + ' offered to an employee without the permission');
    assert.ok(kelvins.indexOf(n) >= 0, n + ' missing for the administrator');
  });
  assert.ok(alices.indexOf('request_leave') >= 0 && alices.indexOf('get_attendance') >= 0);
});

test('a tool the person may not use is refused even if Claude asks for it', async function () {
  script.push(toolUse('update_product_stock', { product: 'Z9AI-1', new_stock: 0, reason: 'Z9AI' }), says('Sorry.'));
  var r = await ask(ALICE, 'Set Z9AI slats to 0');
  var result = resultsSentOn(1)[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /not available/);
  assert.deepEqual(r.actions, []);
  var stock = (await pool.query("SELECT current_stock FROM products WHERE sku = 'Z9AI-1'")).rows[0].current_stock;
  assert.equal(Number(stock), 7);
});

test('a change is only prepared; it happens on Confirm, once, and only for the person it was prepared for', async function () {
  script.push(toolUse('create_task', { title: 'Z9AI check the kiln', assignees: ['Alice Kamau'], due_date: '2026-10-01' }), says('I have prepared the task — press Confirm.'));
  var r = await ask(KELVIN, 'Ask Alice to check the kiln by 1 October');
  assert.equal(r.actions.length, 1);
  var card = r.actions[0];
  assert.equal(card.status, 'pending');
  assert.equal(card.summary, 'Create task "Z9AI check the kiln" for Alice Kamau, due 2026-10-01 (medium priority).');
  var told = JSON.parse(resultsSentOn(1)[0].content);
  assert.equal(told.status, 'awaiting_confirmation', 'Claude is told it has not happened');

  var count = async function () { return (await pool.query("SELECT count(*)::int AS n FROM tasks WHERE title = 'Z9AI check the kiln'")).rows[0].n; };
  assert.equal(await count(), 0, 'nothing is created before Confirm');

  var byAlice = await post(ALICE, '/api/ai/actions/' + card.id + '/confirm');
  assert.equal(byAlice.status, 404, "someone else cannot confirm Kelvin's action");
  assert.equal(await count(), 0);

  var ok = await post(KELVIN, '/api/ai/actions/' + card.id + '/confirm');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'done');
  assert.match(ok.body.result, /Task created/);
  assert.equal(await count(), 1);
  var assignee = (await pool.query(
    "SELECT e.first_name FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id JOIN employees e ON e.id = ta.employee_id WHERE t.title = 'Z9AI check the kiln'"
  )).rows;
  assert.deepEqual(assignee, [{ first_name: 'Alice' }]);

  var again = await post(KELVIN, '/api/ai/actions/' + card.id + '/confirm');
  assert.equal(again.status, 409, 'a second Confirm does nothing');
  assert.equal(await count(), 1);
});

test('Cancel, or waiting more than 30 minutes, means it never happens', async function () {
  script.push(toolUse('add_customer', { name: 'Z9AI Hotel' }), says('Press Confirm.'));
  var first = (await ask(KELVIN, 'Add Z9AI Hotel as a customer')).actions[0];
  var cancelled = await post(KELVIN, '/api/ai/actions/' + first.id + '/cancel');
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal((await post(KELVIN, '/api/ai/actions/' + first.id + '/confirm')).status, 409);

  script.push(toolUse('add_customer', { name: 'Z9AI Hotel' }), says('Press Confirm.'));
  var second = (await ask(KELVIN, 'Add Z9AI Hotel as a customer')).actions[0];
  await pool.query("UPDATE ai_actions SET created_at = now() - interval '31 minutes' WHERE id = $1", [second.id]);
  var late = await post(KELVIN, '/api/ai/actions/' + second.id + '/confirm');
  assert.equal(late.status, 409);
  assert.match(late.body.error.message, /expired/);
  assert.equal((await pool.query('SELECT status FROM ai_actions WHERE id = $1', [second.id])).rows[0].status, 'expired');

  var customers = await pool.query("SELECT count(*)::int AS n FROM customers WHERE name = 'Z9AI Hotel'");
  assert.equal(customers.rows[0].n, 0);
});

test('a stock correction is recorded in the stock history; losing the permission before Confirm stops it', async function () {
  script.push(toolUse('update_product_stock', { product: 'Z9AI-1', new_stock: 4, reason: 'Z9AI recount' }), says('Press Confirm.'));
  var card = (await ask(KELVIN, 'We counted 4 Z9AI slats')).actions[0];
  assert.match(card.summary, /from 7 to 4/);

  var kelvin = await buildContext((await pool.query("SELECT id FROM users WHERE email = $1", [KELVIN])).rows[0].id);
  var demoted = Object.assign({}, kelvin, { can: function () { return false; } });
  var refused = await actions.confirm(demoted, card.id);
  assert.equal(refused.status, 'failed');
  assert.match(refused.result, /no longer have permission/);
  assert.equal(Number((await pool.query("SELECT current_stock FROM products WHERE sku = 'Z9AI-1'")).rows[0].current_stock), 7);

  script.push(toolUse('update_product_stock', { product: 'Z9AI-1', new_stock: 4, reason: 'Z9AI recount' }), says('Press Confirm.'));
  var again = (await ask(KELVIN, 'We counted 4 Z9AI slats')).actions[0];
  var done = await post(KELVIN, '/api/ai/actions/' + again.id + '/confirm');
  assert.equal(done.body.status, 'done');
  assert.equal(Number((await pool.query("SELECT current_stock FROM products WHERE sku = 'Z9AI-1'")).rows[0].current_stock), 4);
  var tx = (await pool.query(
    "SELECT type, qty, notes FROM inventory_tx WHERE item_id = (SELECT id FROM products WHERE sku = 'Z9AI-1')"
  )).rows;
  assert.deepEqual(tx.map(function (t) { return [t.type, Number(t.qty), t.notes]; }), [['adjustment', -3, 'Z9AI recount']]);
});

test("a problem preparing a change goes back to Claude to explain, and nothing is offered", async function () {
  script.push(toolUse('request_leave', { leave_type: 'Z9AI holiday on Mars', start_date: '2026-10-05', end_date: '2026-10-06' }), says('That leave type does not exist.'));
  var r = await ask(ALICE, 'I want Mars leave');
  var result = resultsSentOn(1)[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /No leave type matches .*Types: /);
  assert.deepEqual(r.actions, []);
});

test('a refusal or an API error comes back as a reply the person can read', async function () {
  script.push({ stop_reason: 'refusal', content: [] });
  assert.equal((await ask(ALICE, 'Hello')).reply, claude.REFUSAL_REPLY);

  script.push(function () { throw new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers()); });
  assert.match((await ask(ALICE, 'Hello')).reply, /API key on the server was rejected/);
});

test('models without server-side fallbacks use the plain Messages API', async function () {
  var saved = config.ai.model;
  config.ai.model = 'claude-sonnet-5';
  try {
    script.push(says('ok'));
    await ask(ALICE, 'Hello');
    assert.equal(calls[0].api, 'messages');
    assert.equal(calls[0].req.fallbacks, undefined);
    assert.equal(calls[0].req.model, 'claude-sonnet-5');
  } finally {
    config.ai.model = saved;
  }
});

test('the chat history is sent as a conversation that starts with the person and alternates', async function () {
  script.push(says('ok'));
  await ask(ALICE, 'and now?', [
    { role: 'assistant', text: 'Hello! Ask me anything.' },
    { role: 'user', text: 'a' },
    { role: 'user', text: 'b' },
    { role: 'assistant', text: 'c' },
    { role: 'system', text: 'ignored' }
  ]);
  assert.deepEqual(calls[0].req.messages, [
    { role: 'user', content: 'a\n\nb' },
    { role: 'assistant', content: 'c' },
    { role: 'user', content: 'and now?' }
  ]);
});
