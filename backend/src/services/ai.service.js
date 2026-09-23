var { V } = require('../utils/validate');
var { AppError } = require('../utils/errors');
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
  return { name: t.name, description: t.description, input_schema: t.input_schema };
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

async function chat(ctx, message, history) {
  var text = V.text(message, 'Message', 2000);

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

module.exports = { chat: chat, SYSTEM_PROMPT: SYSTEM_PROMPT, MAX_STEPS: MAX_STEPS };
