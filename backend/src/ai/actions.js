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
  return { id: row.id, tool: row.tool, summary: row.summary, status: row.status, result: row.result || null };
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
  var row = await claim(ctx, id, 'done');
  var tool = tools.get(row.tool);
  try {
    if (!tool || tool.kind !== 'action') fail('invalid', 'This kind of action is no longer available.');
    if (tool.perm && !ctx.can(tool.perm)) fail('forbidden', 'You no longer have permission to do this.');
    var out = await tool.execute(ctx, row.payload);
    await pool.query('UPDATE ai_actions SET result = $2 WHERE id = $1', [row.id, out.message]);
    await audit(pool, ctx, 'ai.action', 'ai_action', row.id, 'Confirmed in the AI Assistant: ' + row.summary);
    return Object.assign(toCard(row), { status: 'done', result: out.message });
  } catch (err) {
    var message = err instanceof AppError ? err.message : 'Something went wrong doing this.';
    if (!(err instanceof AppError)) console.error('[ai] action ' + row.tool + ' failed:', err);
    await pool.query("UPDATE ai_actions SET status = 'failed', result = $2 WHERE id = $1", [row.id, message]);
    return Object.assign(toCard(row), { status: 'failed', result: message });
  }
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

module.exports = { offer: offer, confirm: confirm, cancel: cancel, EXPIRES_AFTER_MINUTES: EXPIRES_AFTER_MINUTES };
