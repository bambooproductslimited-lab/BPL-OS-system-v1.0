var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

function rowToSettings(r) {
  return {
    companyName: r.company_name, shortName: r.short_name, country: r.country, currency: r.currency,
    timezone: r.timezone, fiscalYearStart: r.fiscal_year_start, workWeek: r.work_week,
    standardHours: r.standard_hours, lateAfter: r.late_after ? r.late_after.slice(0, 5) : null,
    plants: r.plants, leaveApprovalChain: r.leave_approval_chain,
    commercial: r.commercial, integrations: r.integrations
  };
}

// kernel.js: handlers['settings.get']
async function get(ctx) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var res = await pool.query('SELECT * FROM settings WHERE id = 1');
  return rowToSettings(res.rows[0]);
}

var TEXT_FIELDS = { companyName: 'company_name', shortName: 'short_name', country: 'country', currency: 'currency', timezone: 'timezone', workWeek: 'work_week', lateAfter: 'late_after' };

// kernel.js: handlers['settings.save']
async function save(ctx, p) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');

  var sets = [], values = [];
  Object.keys(TEXT_FIELDS).forEach(function (k) {
    if (p[k] !== undefined) {
      var v = V.text(p[k], k, 60);
      values.push(v);
      sets.push(TEXT_FIELDS[k] + ' = $' + values.length);
    }
  });
  if (p.standardHours !== undefined) {
    values.push(Math.max(1, Math.min(12, Number(p.standardHours) || 8)));
    sets.push('standard_hours = $' + values.length);
  }
  if (sets.length) {
    await pool.query('UPDATE settings SET ' + sets.join(', ') + ', updated_at = now() WHERE id = 1', values);
  }
  await audit(pool, ctx, 'settings.save', 'settings', 'company', 'Updated company settings.');
  return get(ctx);
}

// kernel.js: handlers['integrations.list']
async function listIntegrations(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var res = await pool.query('SELECT integrations FROM settings WHERE id = 1');
  return res.rows[0].integrations || [];
}

async function findIntegration(id) {
  var res = await pool.query('SELECT integrations FROM settings WHERE id = 1');
  var list = res.rows[0].integrations || [];
  var i = list.findIndex(function (x) { return x.id === id; });
  return { list: list, index: i };
}

// kernel.js: handlers['integrations.connect']
async function connect(ctx, id, apiKey) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var found = await findIntegration(id);
  if (found.index < 0) fail('notfound', 'Integration not found.');
  found.list[found.index].apiKey = V.text(apiKey, 'API key', 200);
  found.list[found.index].connected = true;
  await pool.query('UPDATE settings SET integrations = $1, updated_at = now() WHERE id = 1', [JSON.stringify(found.list)]);
  await audit(pool, ctx, 'integration.connect', 'integration', id, 'Connected ' + found.list[found.index].name + '.');
  return found.list[found.index];
}

// kernel.js: handlers['integrations.disconnect']
async function disconnect(ctx, id) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var found = await findIntegration(id);
  if (found.index < 0) fail('notfound', 'Integration not found.');
  found.list[found.index].connected = false;
  found.list[found.index].apiKey = '';
  await pool.query('UPDATE settings SET integrations = $1, updated_at = now() WHERE id = 1', [JSON.stringify(found.list)]);
  // TikTok's real OAuth tokens live in a dedicated table (see
  // tiktokOAuth.service.js), not the generic apiKey field above — clear
  // those out too so a "disconnected" TikTok can't still sync.
  if (id === 'tiktok') {
    await pool.query('DELETE FROM marketing_oauth_tokens WHERE channel_key = $1', ['tiktok']);
  }
  await audit(pool, ctx, 'integration.disconnect', 'integration', id, 'Disconnected ' + found.list[found.index].name + '.');
  return found.list[found.index];
}

module.exports = { get: get, save: save, listIntegrations: listIntegrations, connect: connect, disconnect: disconnect };
