/*
 * What Meta says about the company's WhatsApp account, kept as warnings for
 * Sales & CRM → Data health:
 *   quality  — phone_number_quality_update: the number flagged for low
 *              quality, or its daily sending limit lowered or raised;
 *   account  — account_update: restricted, a policy violation, banned,
 *              deleted — or verified;
 *   template — message_template_status_update: a message template approved,
 *              rejected, paused or disabled.
 * The serious ones (tone 'bad') are also sent as a notification to everyone
 * who manages the settings. The words are made on the page, from the event
 * and its details, so they read in each person's language.
 */
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { notify } = require('../utils/notify');

var LIMITS = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: 'unlimited' };
function limit(v) { return v == null ? null : (LIMITS[v] != null ? LIMITS[v] : String(v)); }

function quality(v) {
  var ev = String(v.event || '').toUpperCase();
  var tone = ev === 'FLAGGED' || ev === 'DOWNGRADE' ? 'bad' : ev === 'UNFLAGGED' || ev === 'UPGRADE' ? 'good' : 'info';
  return { kind: 'quality', event: ev, tone: tone, details: { phone: v.display_phone_number || '', limit: limit(v.current_limit), oldLimit: limit(v.old_limit) } };
}
function account(v) {
  var ev = String(v.event || '').toUpperCase();
  var bad = ['ACCOUNT_RESTRICTION', 'ACCOUNT_VIOLATION', 'DISABLED_UPDATE', 'ACCOUNT_DELETED'];
  var tone = bad.indexOf(ev) >= 0 ? 'bad' : ev === 'VERIFIED_ACCOUNT' ? 'good' : 'info';
  var r = (v.restriction_info || [])[0] || {};
  return { kind: 'account', event: ev, tone: tone, details: {
    phone: v.phone_number || '', restriction: r.restriction_type || null, until: r.expiration ? new Date(Number(r.expiration) * 1000) : null,
    violation: v.violation_info && v.violation_info.violation_type || null, ban: v.ban_info && v.ban_info.waba_ban_state || null } };
}
function template(v) {
  var ev = String(v.event || '').toUpperCase();
  var tone = ev === 'APPROVED' || ev === 'REINSTATED' ? 'good' : ev === 'REJECTED' || ev === 'DISABLED' ? 'bad' : ev === 'PAUSED' || ev === 'FLAGGED' ? 'warn' : 'info';
  return { kind: 'template', event: ev, tone: tone, details: { name: v.message_template_name || '', language: v.message_template_language || '', reason: v.reason && v.reason !== 'NONE' ? v.reason : null } };
}
var READERS = { phone_number_quality_update: quality, account_update: account, message_template_status_update: template };

// One webhook change; true when it was one of these.
async function take(field, value) {
  var read = READERS[field];
  if (!read || !value || !value.event) return false;
  var a = read(value);
  var row = (await pool.query('INSERT INTO whatsapp_alerts (kind, event, tone, details) VALUES ($1,$2,$3,$4) RETURNING id',
    [a.kind, a.event, a.tone, JSON.stringify(a.details)])).rows[0];
  // A good-news event closes the earlier warnings of its kind (the number is
  // unflagged, the template approved again).
  if (a.tone === 'good') {
    await pool.query("UPDATE whatsapp_alerts SET dismissed_at = now() WHERE kind = $1 AND id <> $2 AND dismissed_at IS NULL AND tone IN ('bad', 'warn')" +
      (a.kind === 'template' ? " AND details->>'name' = $3" : ''), a.kind === 'template' ? [a.kind, row.id, a.details.name] : [a.kind, row.id]);
  }
  if (a.tone === 'bad') {
    var who = (await pool.query(
      "SELECT DISTINCT e.id FROM employees e JOIN users u ON u.employee_id = e.id JOIN user_roles ur ON ur.user_id = u.id " +
      "JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_key = 'settings.manage' WHERE e.status = 'active' AND u.status = 'active'")).rows;
    var title = a.kind === 'quality' ? 'WhatsApp: Meta ' + (a.event === 'FLAGGED' ? 'flagged the number\'s quality' : 'lowered the daily sending limit')
      : a.kind === 'account' ? 'WhatsApp: Meta restricted or flagged the account' : 'WhatsApp: a message template was ' + a.event.toLowerCase();
    for (var m of who) {
      try { await notify(pool, m.id, title, 'See Sales & CRM → Data health for what Meta said and what to do.', '/crmhealth#channels'); } catch (e) { /* the warning is still on Data health */ }
    }
  }
  return true;
}

function rowOut(r) { return { id: r.id, kind: r.kind, event: r.event, tone: r.tone, details: r.details, at: r.at }; }

// For Data health: the warnings not yet dismissed, the number's latest
// quality and limit, and the latest word on each template.
async function summary() {
  var open = (await pool.query("SELECT * FROM whatsapp_alerts WHERE dismissed_at IS NULL AND tone IN ('bad', 'warn') ORDER BY at DESC LIMIT 20")).rows.map(rowOut);
  var q = (await pool.query("SELECT * FROM whatsapp_alerts WHERE kind = 'quality' ORDER BY at DESC LIMIT 1")).rows[0];
  var lim = (await pool.query("SELECT details->>'limit' AS l FROM whatsapp_alerts WHERE kind = 'quality' AND details->>'limit' IS NOT NULL ORDER BY at DESC LIMIT 1")).rows[0];
  var acct = (await pool.query("SELECT * FROM whatsapp_alerts WHERE kind = 'account' ORDER BY at DESC LIMIT 1")).rows[0];
  var tpl = (await pool.query("SELECT DISTINCT ON (details->>'name') * FROM whatsapp_alerts WHERE kind = 'template' ORDER BY details->>'name', at DESC")).rows.map(rowOut);
  return {
    open: open,
    quality: q ? { event: q.event, tone: q.tone, at: q.at, flagged: q.event === 'FLAGGED' } : null,
    limit: lim ? lim.l : null,
    account: acct ? rowOut(acct) : null,
    templates: tpl.sort(function (a, b) { return new Date(b.at) - new Date(a.at); }).slice(0, 10)
  };
}

async function dismiss(ctx, id) {
  if (!ctx.can('settings.manage') && !ctx.can('crm.assign')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var r = (await pool.query('UPDATE whatsapp_alerts SET dismissed_at = now(), dismissed_by = $2 WHERE id = $1 AND dismissed_at IS NULL RETURNING id', [id, ctx.employee ? ctx.employee.id : null])).rows[0];
  if (!r) fail('notfound', 'Warning not found.');
  return { ok: true };
}

module.exports = { take: take, summary: summary, dismiss: dismiss };
