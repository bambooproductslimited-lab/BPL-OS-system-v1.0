var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { withLiveConfigState } = require('./envConfiguredIntegrations');

// A stored integration secret must never travel back to a browser. It was
// riding along on settings.get, which only needs employee.read — so every
// employee could read any connected integration's key, while the properly
// gated integrations list sat next to it requiring settings.manage. Nothing
// leaks today only because no key has been set through this path yet.
//
// The Integrations screen shows this field in a disabled input as
// `apiKey || MASK`, so it never needed the real value: dropping it shows
// the mask, which is what that field was always meant to look like.
// hasApiKey carries the one bit the UI legitimately needs.
function redactIntegrations(list) {
  return (Array.isArray(list) ? list : []).map(function (i) {
    var copy = Object.assign({}, i);
    copy.hasApiKey = !!(i && i.apiKey);
    delete copy.apiKey;
    return copy;
  });
}

function rowToSettings(r) {
  return {
    companyName: r.company_name, shortName: r.short_name, country: r.country, currency: r.currency,
    timezone: r.timezone, fiscalYearStart: r.fiscal_year_start, workWeek: r.work_week,
    standardHours: r.standard_hours, lateAfter: r.late_after ? r.late_after.slice(0, 5) : null,
    plants: r.plants, leaveApprovalChain: r.leave_approval_chain,
    commercial: r.commercial, integrations: redactIntegrations(r.integrations)
  };
}

// kernel.js: handlers['settings.get']
async function get(ctx) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var res = await pool.query('SELECT * FROM settings WHERE id = 1');
  var out = rowToSettings(res.rows[0]);
  // The grace in force today (attendance.service.js, migration 0074).
  var grace = await pool.query('SELECT minutes FROM late_grace WHERE effective_from <= CURRENT_DATE ORDER BY effective_from DESC LIMIT 1');
  out.lateGraceMinutes = grace.rows[0] ? Number(grace.rows[0].minutes) : 10;
  return out;
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
  // Minutes after a shift start that still count as on time. Takes effect
  // from today; days before keep the grace they were judged by.
  if (p.lateGraceMinutes !== undefined && p.lateGraceMinutes !== null && p.lateGraceMinutes !== '') {
    var minutes = Number(p.lateGraceMinutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240) fail('invalid', 'Minutes before someone is late must be a whole number from 0 to 240.');
    var current = await pool.query('SELECT minutes FROM late_grace WHERE effective_from <= CURRENT_DATE ORDER BY effective_from DESC LIMIT 1');
    if (!current.rows[0] || Number(current.rows[0].minutes) !== minutes) {
      await pool.query(
        'INSERT INTO late_grace (effective_from, minutes, set_by) VALUES (CURRENT_DATE, $1, $2) ' +
        'ON CONFLICT (effective_from) DO UPDATE SET minutes = EXCLUDED.minutes, set_by = EXCLUDED.set_by, set_at = now()',
        [minutes, ctx.employee ? ctx.employee.id : null]
      );
      await audit(pool, ctx, 'settings.lateGrace', 'settings', 'company', 'Late after ' + minutes + ' minutes past the shift start, from today.');
    }
  }
  if (p.standardHours !== undefined) {
    values.push(Math.max(1, Math.min(12, Number(p.standardHours) || 8)));
    sets.push('standard_hours = $' + values.length);
  }
  if (sets.length) {
    await pool.query('UPDATE settings SET ' + sets.join(', ') + ', updated_at = now() WHERE id = 1', values);
  }

  // Multi-currency: the enabled-currency list every quotation/estimate/
  // invoice currency picker (and documents.js's resolveCurrency()) draws
  // from. Kept separate from the sets/values loop above since it lives in
  // the commercial jsonb blob, not a plain column.
  if (p.currencies !== undefined) {
    var codes = (Array.isArray(p.currencies) ? p.currencies : []).map(function (c) { return V.text(c, 'Currency code', 6).toUpperCase(); });
    var unique = codes.filter(function (c, i) { return codes.indexOf(c) === i; });
    if (!unique.length) fail('invalid', 'Keep at least one currency enabled.');
    var commercialRes = await pool.query('SELECT commercial FROM settings WHERE id = 1');
    var commercial = commercialRes.rows[0].commercial;
    commercial.currencies = unique;
    await pool.query('UPDATE settings SET commercial = $1, updated_at = now() WHERE id = 1', [JSON.stringify(commercial)]);
  }

  await audit(pool, ctx, 'settings.save', 'settings', 'company', 'Updated company settings.');
  return get(ctx);
}

// kernel.js: handlers['integrations.list']
async function listIntegrations(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var res = await pool.query('SELECT integrations FROM settings WHERE id = 1');
  return redactIntegrations(withLiveConfigState(res.rows[0].integrations || []));
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
  return redactIntegrations([found.list[found.index]])[0];
}

// kernel.js: handlers['integrations.disconnect']
async function disconnect(ctx, id) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var found = await findIntegration(id);
  if (found.index < 0) fail('notfound', 'Integration not found.');
  found.list[found.index].connected = false;
  found.list[found.index].apiKey = '';
  await pool.query('UPDATE settings SET integrations = $1, updated_at = now() WHERE id = 1', [JSON.stringify(found.list)]);
  // TikTok/Facebook/Instagram/YouTube/Twitch's real OAuth tokens live in
  // a dedicated table (see tiktokOAuth.service.js / metaOAuth.service.js
  // / youtubeOAuth.service.js / twitchOAuth.service.js), not the generic
  // apiKey field above — clear those out too so a "disconnected" channel
  // can't still sync.
  if (id === 'tiktok' || id === 'facebook' || id === 'instagram' || id === 'youtube' || id === 'twitch') {
    await pool.query('DELETE FROM marketing_oauth_tokens WHERE channel_key = $1', [id]);
  }
  await audit(pool, ctx, 'integration.disconnect', 'integration', id, 'Disconnected ' + found.list[found.index].name + '.');
  return found.list[found.index];
}

module.exports = { get: get, save: save, listIntegrations: listIntegrations, connect: connect, disconnect: disconnect };
