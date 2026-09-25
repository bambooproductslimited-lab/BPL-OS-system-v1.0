var { pool, withTransaction } = require('../db/pool');
var { V } = require('../utils/validate');
var { AppError, fail } = require('../utils/errors');
var claude = require('../ai/claude');
var tools = require('../ai/tools');
var actions = require('../ai/actions');

// The AI Assistant screen: Claude, with the OS's tools (src/ai/tools.js).
//
// Claude answers by looking things up with the tools — as the signed-in
// person, so it sees only what they could see on the screens — and, when
// asked to change something, prepares the change for the person to Confirm
// (src/ai/actions.js). Each question runs a short loop: Claude asks for
// tools, the server runs them and hands back the results, until Claude has
// an answer.
//
// Problems (no key configured, the API unreachable, a refusal) come back as
// an ordinary reply rather than an HTTP error — the chat shows them as a
// message, which is what the person needs to see.

var MAX_STEPS = 8;
var MAX_OFFERS_PER_QUESTION = 5;
var HISTORY_TURNS = 20;

// Kept the same for every request, so the API can cache it together with
// the tool definitions (see the cache_control below). Anything that changes
// — who is asking, today's date — goes in the second block.
var SYSTEM_PROMPT = [
  'You are the assistant inside Bamboo OS, the company operating system of Bamboo Products Limited (BPL), a bamboo products manufacturer in Ghana. Staff use you to find things out and get things done in the OS: people and attendance, leave, tasks, stock, customers, quotations, invoices, suppliers and bamboo farmers, purchase requests, expense claims and approvals.',
  '',
  'How to answer:',
  '- Look things up with the tools before answering. Never guess or invent names, numbers, dates or statuses; if the tools do not return it, say you could not find it.',
  "- The tools run with the asking person's own permissions. If a tool is missing or returns nothing, that can be because they are not allowed to see it — say so plainly, and do not suggest ways around it.",
  '- Money is in Ghana cedis (GHS) unless a record says otherwise. Dates in answers read like "24 Sep 2026".',
  '- Keep answers short and practical. Mention when a list was cut short.',
  '- Your reply is shown as plain text in a small chat bubble: write short paragraphs and "- " bullet lines. Do not use Markdown headings, tables, links or code blocks; **bold** is fine for a key figure.',
  '- Answer in the language the person writes in.',
  '',
  'Doing things:',
  '- Tools that change something (create_task, request_leave, submit_purchase_request, add_customer, update_product_stock) do not do it. They prepare it, and the person sees a card with Confirm and Cancel buttons under your reply. Nothing happens until they press Confirm.',
  '- So after preparing, say what you have prepared and ask them to press Confirm. Never say it is done. If they reply "yes" or "do it" in the chat, remind them to press Confirm on the card.',
  '- Only prepare what the person asked for. If something needed is missing or unclear (which person, which product, which dates), ask first rather than guessing. If a tool says a name matches several people or products, ask which one.',
  '- Prepare each change once; do not prepare the same change again unless asked.'
].join('\n');

function todayISO() { return new Date().toISOString().slice(0, 10); }

var LANGUAGE_NAMES = { en: 'English', fr: 'French', zh: 'Chinese' };

function aboutTheAsker(ctx) {
  var name = ctx.employee && ctx.employee.first_name ? ctx.employee.first_name + ' ' + ctx.employee.last_name : 'a staff member';
  return [
    'Today is ' + todayISO() + ' (Ghana time, GMT).',
    'You are talking to ' + name + (ctx.employee && ctx.employee.position_title ? ', ' + ctx.employee.position_title : '') +
      (ctx.roleNames && ctx.roleNames.length ? ' (role: ' + ctx.roleNames.join(', ') + ')' : '') + '.',
    'Their OS is set to ' + (LANGUAGE_NAMES[ctx.user.locale] || 'English') + '.'
  ].join('\n');
}

function toolDefinition(t) {
  var description = t.kind === 'action' ? t.description + ' Only prepares the change: it happens when the person presses Confirm on screen.' : t.description;
  return { name: t.name, description: description, input_schema: t.input_schema };
}

// Runs one tool_use block and returns its tool_result. Errors a person
// could act on (a name matching nobody, a date in the past, not allowed)
// go back to Claude as the tool's result so it can explain or ask; anything
// else is logged and reported vaguely.
async function runTool(ctx, allowed, block, offers) {
  var result = function (content, isError) {
    return { type: 'tool_result', tool_use_id: block.id, content: typeof content === 'string' ? content : JSON.stringify(content), is_error: isError || undefined };
  };
  var tool = allowed[block.name];
  if (!tool) return result('This tool is not available to this person.', true);
  try {
    var input = block.input || {};
    if (tool.kind === 'read') return result(await tool.run(ctx, input));
    if (offers.length >= MAX_OFFERS_PER_QUESTION) return result('Too many changes prepared in one go. Ask the person to confirm these first.', true);
    var prepared = await tool.prepare(ctx, input);
    var card = await actions.offer(ctx, tool.name, prepared);
    offers.push(card);
    return result({ status: 'awaiting_confirmation', summary: prepared.summary, note: 'Shown to the person with Confirm and Cancel buttons. It has NOT happened yet.' });
  } catch (err) {
    if (err instanceof AppError) return result(err.message, true);
    console.error('[ai] tool ' + block.name + ' failed:', err);
    return result('Something went wrong running this tool.', true);
  }
}

// One question from the person. With a conversationId the earlier turns
// come from that saved conversation (only the person's own); without one a
// new conversation is started. Either way the question and the answer are
// saved, with the ids of any changes prepared, and the conversation comes
// back so the screen can keep adding to it. A client-sent history is still
// accepted for a conversation not saved yet.
async function chat(ctx, message, history, conversationId) {
  var text = V.text(message, 'Message', 2000);
  var convo = conversationId ? await ownConversation(ctx, conversationId) : null;
  if (convo) history = await historyFor(ctx, convo.id);
  var out = await answer(ctx, text, history);
  if (!claude.configured()) return out;
  convo = await saveTurn(ctx, convo, text, out);
  return Object.assign(out, { conversation: { id: convo.id, title: convo.title } });
}

async function answer(ctx, text, history) {

  if (!claude.configured()) {
    return { reply: 'The AI assistant needs an ANTHROPIC_API_KEY configured on the server, which is not set for this environment.', actions: [] };
  }

  var messages = (Array.isArray(history) ? history : [])
    .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && m.text; })
    .slice(-HISTORY_TURNS)
    .map(function (m) { return { role: m.role, content: String(m.text).slice(0, 4000) }; });
  // The API needs the conversation to start with the person and alternate.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  messages = messages.reduce(function (out, m) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1] = { role: m.role, content: out[out.length - 1].content + '\n\n' + m.content };
    else out.push(m);
    return out;
  }, []);
  if (messages.length && messages[messages.length - 1].role === 'user') messages.pop();
  messages.push({ role: 'user', content: text });

  var available = tools.toolsFor(ctx);
  var allowed = {};
  available.forEach(function (t) { allowed[t.name] = t; });
  var system = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: aboutTheAsker(ctx) }
  ];
  var offers = [];

  try {
    for (var step = 0; step < MAX_STEPS; step++) {
      var response = await claude.create({ system: system, tools: available.map(toolDefinition), messages: messages });

      if (response.stop_reason === 'refusal') return { reply: claude.REFUSAL_REPLY, actions: offers };
      if (response.stop_reason !== 'tool_use') {
        var reply = claude.textOf(response);
        if (response.stop_reason === 'max_tokens') reply = (reply ? reply + '\n\n' : '') + '(The answer was cut short — ask for less at once.)';
        return { reply: reply || "I couldn't come up with an answer to that.", actions: offers };
      }

      messages.push({ role: 'assistant', content: response.content });
      var results = [];
      var uses = response.content.filter(function (b) { return b.type === 'tool_use'; });
      for (var i = 0; i < uses.length; i++) results.push(await runTool(ctx, allowed, uses[i], offers));
      messages.push({ role: 'user', content: results });
    }
    return { reply: 'That needed more steps than I can take for one question. Try asking for something narrower.', actions: offers };
  } catch (err) {
    var said = claude.describeError(err);
    if (!said) console.error('[ai] chat failed:', err);
    return { reply: said ? 'Something went wrong answering that: ' + said : 'Something went wrong answering that. Please try again.', actions: offers };
  }
}

// ── saved conversations ─────────────────────────────────────────────
function titleFrom(text) {
  var line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > 70 ? line.slice(0, 67).replace(/\s+\S*$/, '') + '…' : line;
}
async function ownConversation(ctx, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('notfound', 'That conversation was not found.');
  var row = (await pool.query('SELECT * FROM ai_conversations WHERE id = $1 AND user_id = $2', [id, ctx.user.id])).rows[0];
  if (!row) fail('notfound', 'That conversation was not found.');
  return row;
}
// The saved turns as the history Claude is sent, each prepared change
// noted with how it ended so Claude doesn't offer it twice.
async function historyFor(ctx, convoId) {
  await actions.expireOld(ctx);
  var rows = (await pool.query('SELECT role, text, action_ids FROM ai_messages WHERE conversation_id = $1 ORDER BY id', [convoId])).rows;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var cards = await actions.cards(ctx, rows[i].action_ids);
    var t = rows[i].text;
    if (cards.length) t += '\n\n' + cards.map(function (a) { return '[Prepared: ' + a.summary + ' — ' + a.status + (a.result ? ': ' + a.result : '') + ']'; }).join('\n');
    out.push({ role: rows[i].role, text: t });
  }
  return out;
}
async function saveTurn(ctx, convo, text, out) {
  var ids = (out.actions || []).map(function (a) { return a.id; });
  return withTransaction(async function (client) {
    if (!convo) convo = (await client.query('INSERT INTO ai_conversations (user_id, title) VALUES ($1,$2) RETURNING *', [ctx.user.id, titleFrom(text)])).rows[0];
    else await client.query('UPDATE ai_conversations SET updated_at = now() WHERE id = $1', [convo.id]);
    await client.query("INSERT INTO ai_messages (conversation_id, role, text) VALUES ($1,'user',$2)", [convo.id, text]);
    await client.query("INSERT INTO ai_messages (conversation_id, role, text, action_ids) VALUES ($1,'assistant',$2,$3::uuid[])", [convo.id, out.reply, ids]);
    if (ids.length) await client.query('UPDATE ai_actions SET conversation_id = $1 WHERE id = ANY($2::uuid[]) AND user_id = $3', [convo.id, ids, ctx.user.id]);
    return convo;
  });
}

async function listConversations(ctx) {
  await actions.expireOld(ctx);
  var res = await pool.query(
    'SELECT c.*, (SELECT count(*) FROM ai_messages m WHERE m.conversation_id = c.id AND m.role = \'user\')::int AS questions, ' +
    "  (SELECT count(*) FROM ai_actions a WHERE a.conversation_id = c.id AND a.status = 'pending')::int AS pending " +
    'FROM ai_conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 100', [ctx.user.id]);
  return res.rows.map(function (r) { return { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, questions: r.questions, pending: r.pending }; });
}
async function getConversation(ctx, id) {
  var c = await ownConversation(ctx, id);
  await actions.expireOld(ctx);
  var rows = (await pool.query('SELECT * FROM ai_messages WHERE conversation_id = $1 ORDER BY id', [c.id])).rows;
  var messages = [];
  for (var i = 0; i < rows.length; i++) messages.push({ role: rows[i].role, text: rows[i].text, createdAt: rows[i].created_at, actions: await actions.cards(ctx, rows[i].action_ids) });
  return { id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at, messages: messages };
}
async function renameConversation(ctx, id, title) {
  var c = await ownConversation(ctx, id);
  var t = V.text(title, 'Name', 120);
  await pool.query('UPDATE ai_conversations SET title = $2 WHERE id = $1', [c.id, t]);
  return { id: c.id, title: t };
}
// Deleting a conversation removes its messages. The record of changes made
// through it stays (ai_actions, and the audit log) — it just loses the link.
async function deleteConversation(ctx, id) {
  var c = await ownConversation(ctx, id);
  await pool.query('DELETE FROM ai_conversations WHERE id = $1', [c.id]);
  return { ok: true };
}

// ── the page's overview ─────────────────────────────────────────────
// Whether the assistant is switched on, what it can look up and do for
// this person's role, how they have used it, changes waiting for their
// Confirm, the latest changes it made or prepared (on this screen or
// through the Claude connector), and the Claude apps connected as them.
async function overview(ctx) {
  await actions.expireOld(ctx);
  var uid = ctx.user.id;
  var q = (await pool.query(
    "SELECT count(*) FILTER (WHERE m.created_at >= date_trunc('month', now()))::int AS month, count(*)::int AS total, " +
    "  count(*) FILTER (WHERE m.created_at >= now() - interval '7 days')::int AS week " +
    "FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id WHERE c.user_id = $1 AND m.role = 'user'", [uid])).rows[0];
  var a = (await pool.query(
    "SELECT count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status = 'done' AND decided_at >= date_trunc('month', now()))::int AS done_month, " +
    "  count(*) FILTER (WHERE status = 'done' AND source = 'connector')::int AS by_connector, count(*) FILTER (WHERE status = 'failed')::int AS failed, " +
    "  count(*) FILTER (WHERE status IN ('cancelled', 'expired'))::int AS dropped FROM ai_actions WHERE user_id = $1", [uid])).rows[0];
  var conversations = (await pool.query('SELECT count(*)::int AS n FROM ai_conversations WHERE user_id = $1', [uid])).rows[0].n;
  var pending = (await pool.query("SELECT * FROM ai_actions WHERE user_id = $1 AND status = 'pending' ORDER BY created_at", [uid])).rows.map(actions.toCard);
  var recent = (await pool.query('SELECT * FROM ai_actions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [uid])).rows.map(actions.toCard);
  var conn = (await pool.query(
    "SELECT t.client_id, c.info, min(t.created_at) AS since, max(t.created_at) AS last_used FROM mcp_oauth_tokens t JOIN mcp_oauth_clients c ON c.client_id = t.client_id " +
    'WHERE t.user_id = $1 GROUP BY t.client_id, c.info HAVING bool_or(t.revoked_at IS NULL AND t.expires_at > now()) ORDER BY max(t.created_at) DESC', [uid])).rows;
  return {
    configured: claude.configured(),
    expiresAfterMinutes: actions.EXPIRES_AFTER_MINUTES,
    tools: tools.toolsFor(ctx).map(function (t) { return { name: t.name, kind: t.kind }; }),
    stats: {
      questionsThisMonth: q.month, questionsThisWeek: q.week, questions: q.total, conversations: conversations,
      done: a.done, doneThisMonth: a.done_month, doneByConnector: a.by_connector, failed: a.failed, dropped: a.dropped
    },
    pending: pending,
    recent: recent,
    connections: conn.map(function (r) { return { clientId: r.client_id, name: (r.info && r.info.client_name) || 'Claude', since: r.since, lastUsed: r.last_used }; })
  };
}

// Stops a Claude app reaching the OS as this person: every token it holds
// for them is revoked. Connecting again needs a fresh sign-in.
async function disconnect(ctx, clientId) {
  var res = await pool.query('UPDATE mcp_oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL', [ctx.user.id, String(clientId || '')]);
  if (!res.rowCount) fail('notfound', 'That connection was not found.');
  return { ok: true };
}

module.exports = {
  overview: overview, listConversations: listConversations, getConversation: getConversation, renameConversation: renameConversation,
  deleteConversation: deleteConversation, disconnect: disconnect,
  chat: chat, SYSTEM_PROMPT: SYSTEM_PROMPT, MAX_STEPS: MAX_STEPS };
