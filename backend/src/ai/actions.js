var { pool } = require('../db/pool');
var { fail, AppError } = require('../utils/errors');
var { audit } = require('../utils/audit');
var tools = require('./tools');

// Changes the AI Assistant has offered to make, and the Confirm / Cancel
// that decides them (see migration 0069 for why nothing happens without
// Confirm).
//
// An offer is good for 30 minutes and only for the person it was made to.
// Confirming runs the tool's execute() with the ctx of the request that
// pressed Confirm — so it is that person's permissions now, not when the
// offer was made, that decide whether it may happen.

var EXPIRES_AFTER_MINUTES = 30;

function toCard(row) {
  return {
    id: row.id, tool: row.tool, summary: row.summary, status: row.status, result: row.result || null,
    source: row.source || 'assistant', conversationId: row.conversation_id || null, createdAt: row.created_at, decidedAt: row.decided_at || null
  };
}

// Offers nobody answered in time are marked expired, so lists and cards
// read the truth without waiting for someone to press the button.
async function expireOld(ctx) {
  await pool.query(
    "UPDATE ai_actions SET status = 'expired', decided_at = now() WHERE user_id = $1 AND status = 'pending' AND created_at <= now() - make_interval(mins => $2)",
    [ctx.user.id, EXPIRES_AFTER_MINUTES]);
}

// The cards for these ids, as they stand now, in the order given.
async function cards(ctx, ids) {
  if (!ids || !ids.length) return [];
  var rows = (await pool.query('SELECT * FROM ai_actions WHERE user_id = $1 AND id = ANY($2::uuid[])', [ctx.user.id, ids])).rows;
  var byId = {};
  rows.forEach(function (r) { byId[r.id] = toCard(r); });
  return ids.map(function (id) { return byId[id]; }).filter(Boolean);
}

async function offer(ctx, toolName, prepared) {
  var res = await pool.query(
    'INSERT INTO ai_actions (user_id, tool, summary, payload) VALUES ($1,$2,$3,$4) RETURNING *',
    [ctx.user.id, toolName, prepared.summary, JSON.stringify(prepared.payload)]
  );
  return toCard(res.rows[0]);
}

async function findOwn(ctx, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('notfound', 'That action was not found.');
  var row = (await pool.query('SELECT * FROM ai_actions WHERE id = $1 AND user_id = $2', [id, ctx.user.id])).rows[0];
  if (!row) fail('notfound', 'That action was not found.');
  return row;
}

// Claims a pending, unexpired offer for this person in one statement, so a
// double click (or two tabs) can't run it twice.
async function claim(ctx, id, status) {
  var res = await pool.query(
    "UPDATE ai_actions SET status = $3, decided_at = now() WHERE id = $1 AND user_id = $2 AND status = 'pending' " +
    "AND created_at > now() - make_interval(mins => $4) RETURNING *",
    [id, ctx.user.id, status, EXPIRES_AFTER_MINUTES]
  );
  if (res.rows[0]) return res.rows[0];
  var row = await findOwn(ctx, id);
  if (row.status === 'pending') {
    await pool.query("UPDATE ai_actions SET status = 'expired', decided_at = now() WHERE id = $1 AND status = 'pending'", [id]);
    fail('conflict', 'This was offered more than ' + EXPIRES_AFTER_MINUTES + ' minutes ago and has expired. Ask the assistant again.');
  }
  fail('conflict', 'This has already been ' + (row.status === 'done' ? 'done' : row.status) + '.');
}

async function confirm(ctx, id) {
  return execute(ctx, await claim(ctx, id, 'done'), 'Confirmed in the AI Assistant: ');
}

async function execute(ctx, row, auditPrefix) {
  var tool = tools.get(row.tool);
  try {
    if (!tool || tool.kind !== 'action') fail('invalid', 'This kind of action is no longer available.');
    if (tool.perm && !ctx.can(tool.perm)) fail('forbidden', 'You no longer have permission to do this.');
    var out = await tool.execute(ctx, row.payload);
    await pool.query('UPDATE ai_actions SET result = $2 WHERE id = $1', [row.id, out.message]);
    await audit(pool, ctx, 'ai.action', 'ai_action', row.id, auditPrefix + row.summary);
    return Object.assign(toCard(row), { status: 'done', result: out.message });
  } catch (err) {
    var message = err instanceof AppError ? err.message : 'Something went wrong doing this.';
    if (!(err instanceof AppError)) console.error('[ai] action ' + row.tool + ' failed:', err);
    await pool.query("UPDATE ai_actions SET status = 'failed', result = $2 WHERE id = $1", [row.id, message]);
    return Object.assign(toCard(row), { status: 'failed', result: message });
  }
}

// Through the connector there is no Confirm button of ours: claude.ai and
// the Claude apps ask the person to approve each call to a tool that
// changes something before making it. So the change runs at once — still
// recorded here, as done or failed, like one confirmed on the Assistant
// screen.
async function runNow(ctx, toolName, prepared, source) {
  var res = await pool.query(
    "INSERT INTO ai_actions (user_id, tool, summary, payload, status, decided_at, source) VALUES ($1,$2,$3,$4,'done',now(),$5) RETURNING *",
    [ctx.user.id, toolName, prepared.summary, JSON.stringify(prepared.payload), source]
  );
  return execute(ctx, res.rows[0], 'Done through the Claude connector: ');
}

// Cancelling something that has already expired or been decided is not an
// error — the card just shows how it ended.
async function cancel(ctx, id) {
  try {
    return toCard(await claim(ctx, id, 'cancelled'));
  } catch (err) {
    if (err.code !== 'conflict') throw err;
    return toCard(await findOwn(ctx, id));
  }
}

module.exports = { offer: offer, expireOld: expireOld, cards: cards, toCard: toCard, confirm: confirm, cancel: cancel, runNow: runNow, EXPIRES_AFTER_MINUTES: EXPIRES_AFTER_MINUTES };
