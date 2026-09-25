var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');

// The audit log: every change made in the OS, who made it and when
// (utils/audit.js writes it). Read-only here, for people with audit.read.
//
// Actions are "<area>.<what>" (leave.decide, invoice.create). The areas are
// grouped so the log can be narrowed to what matters for a question —
// access and security, settings, money, people, operations. "After hours"
// means before 6:00 or from 20:00 Ghana time (GMT, the same as UTC).

var GROUPS = {
  access: ['auth', 'user', 'role', 'mcp', 'ai'],
  settings: ['settings', 'integration', 'company', 'department', 'shift', 'sms', 'mail', 'system'],
  money: ['invoice', 'payment', 'receipt', 'expense', 'payroll', 'report', 'estimate', 'quotation', 'salesorder'],
  people: ['employee', 'leave', 'attendance', 'task', 'project', 'announcement', 'document', 'chat', 'message'],
  operations: ['product', 'stock', 'warehouse', 'toolroom', 'itdevice', 'asset', 'maintenance', 'waybill', 'production', 'rawbatch',
    'procurement', 'supplier', 'catalog', 'restaurant', 'poki', 'customer', 'marketing']
};
var PAGE = 100;
var AFTER_HOURS = "(extract(hour from a.at AT TIME ZONE 'UTC') < 6 OR extract(hour from a.at AT TIME ZONE 'UTC') >= 20)";
var REMOVALS = "a.action ~ '(delete|remove|void|cancel|revoke|disable)'";

function groupOf(action) {
  var prefix = String(action || '').split('.')[0];
  for (var g in GROUPS) if (GROUPS[g].indexOf(prefix) >= 0) return g;
  return 'other';
}
function rowOut(l) {
  return {
    id: l.id, at: l.at, actorUserId: l.actor_user_id, actorName: l.actor_name, actorEmployeeId: l.employee_id || null,
    actorPhoto: l.photo_key ? (l.photo_updated_at ? new Date(l.photo_updated_at).getTime() : 1) : null,
    action: l.action, area: String(l.action || '').split('.')[0], group: groupOf(l.action),
    entity: l.entity, entityId: l.entity_id, summary: l.summary, meta: l.meta
  };
}

// kernel.js: handlers['audit.list']
// params: q (words in the action, summary, name or record id), group, actorId (a user
// id, or "system"), from / to (dates), kind ("removals" or "afterhours"),
// before (the time of the last row already shown, for the next page).
// Newest first, 100 at a time.
async function list(ctx, params) {
  if (!ctx.can('audit.read')) fail('forbidden', 'Your role does not allow this action (audit.read).');
  var p = typeof params === 'string' ? { q: params } : (params || {});
  var where = [];
  var args = [];
  function arg(v) { args.push(v); return '$' + args.length; }
  var q = String(p.q || '').trim().toLowerCase();
  if (q) where.push("lower(a.action || ' ' || a.summary || ' ' || coalesce(a.actor_name, '') || ' ' || a.entity_id) LIKE " + arg('%' + q + '%'));
  if (p.group && GROUPS[p.group]) where.push("split_part(a.action, '.', 1) = ANY(" + arg(GROUPS[p.group]) + '::text[])');
  else if (p.group === 'other') where.push("NOT (split_part(a.action, '.', 1) = ANY(" + arg([].concat.apply([], Object.values(GROUPS))) + '::text[]))');
  if (p.actorId === 'system') where.push('a.actor_user_id IS NULL');
  else if (p.actorId && /^[0-9a-f-]{36}$/i.test(p.actorId)) where.push('a.actor_user_id = ' + arg(p.actorId));
  if (p.from && /^\d{4}-\d{2}-\d{2}$/.test(p.from)) where.push('a.at >= ' + arg(p.from) + '::date');
  if (p.to && /^\d{4}-\d{2}-\d{2}$/.test(p.to)) where.push('a.at < ' + arg(p.to) + "::date + interval '1 day'");
  if (p.kind === 'removals') where.push(REMOVALS);
  if (p.kind === 'afterhours') where.push(AFTER_HOURS);
  if (p.before && !isNaN(new Date(p.before).getTime())) where.push('a.at < ' + arg(new Date(p.before).toISOString()));
  var res = await pool.query(
    'SELECT a.*, e.id AS employee_id, e.photo_key, e.photo_updated_at FROM audit_logs a ' +
    'LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN employees e ON e.id = u.employee_id ' +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY a.at DESC LIMIT ' + PAGE, args);
  return res.rows.map(rowOut);
}

// The shape of the last 30 days: actions per day, by group and area, the
// most active people, sign-ins, changes to access and settings, removals
// and after-hours actions — and everyone who appears in the log, for the
// person filter.
async function summary(ctx) {
  if (!ctx.can('audit.read')) fail('forbidden', 'Your role does not allow this action (audit.read).');
  var since = "a.at >= now() - interval '30 days'";
  var days = (await pool.query(
    "SELECT to_char(d, 'YYYY-MM-DD') AS day, count(a.id)::int AS n FROM generate_series((now() AT TIME ZONE 'UTC')::date - 29, (now() AT TIME ZONE 'UTC')::date, interval '1 day') d " +
    "LEFT JOIN audit_logs a ON (a.at AT TIME ZONE 'UTC')::date = d::date GROUP BY d ORDER BY d")).rows;
  var areas = (await pool.query("SELECT split_part(a.action, '.', 1) AS area, count(*)::int AS n FROM audit_logs a WHERE " + since + ' GROUP BY 1 ORDER BY 2 DESC')).rows;
  var people = (await pool.query(
    "SELECT a.actor_user_id AS id, max(a.actor_name) AS name, count(*)::int AS n, count(*) FILTER (WHERE " + AFTER_HOURS + ")::int AS after_hours, " +
    "  max(e.id::text) AS employee_id, max(e.photo_key) AS photo_key, max(e.photo_updated_at) AS photo_updated_at " +
    'FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN employees e ON e.id = u.employee_id WHERE ' + since +
    " AND a.action <> 'auth.login' GROUP BY a.actor_user_id ORDER BY 3 DESC")).rows;
  var counts = (await pool.query(
    "SELECT count(*) FILTER (WHERE a.at >= now() - interval '7 days')::int AS week, count(*) FILTER (WHERE a.at >= now() - interval '14 days' AND a.at < now() - interval '7 days')::int AS prev_week, " +
    "  count(*) FILTER (WHERE a.action = 'auth.login')::int AS sign_ins, count(DISTINCT a.actor_user_id) FILTER (WHERE a.at >= now() - interval '7 days')::int AS actors_week, " +
    "  count(*) FILTER (WHERE split_part(a.action, '.', 1) = ANY($1::text[]) AND a.action <> 'auth.login' AND a.action <> 'auth.logout')::int AS access_changes, " +
    "  count(*) FILTER (WHERE split_part(a.action, '.', 1) = ANY($2::text[]))::int AS settings_changes, " +
    '  count(*) FILTER (WHERE ' + REMOVALS + ')::int AS removals, count(*) FILTER (WHERE ' + AFTER_HOURS + " AND a.action <> 'auth.login')::int AS after_hours " +
    'FROM audit_logs a WHERE ' + since, [GROUPS.access, GROUPS.settings])).rows[0];
  var latestAccess = (await pool.query(
    "SELECT a.* FROM audit_logs a WHERE split_part(a.action, '.', 1) = ANY($1::text[]) AND a.action NOT IN ('auth.login', 'auth.logout') ORDER BY a.at DESC LIMIT 1", [GROUPS.access.concat(GROUPS.settings)])).rows[0];
  var actors = (await pool.query(
    'SELECT a.actor_user_id AS id, max(a.actor_name) AS name, max(a.at) AS last_at FROM audit_logs a GROUP BY a.actor_user_id ORDER BY max(a.actor_name)')).rows;
  return {
    days: days.map(function (d) { return { day: d.day, n: d.n }; }),
    groups: Object.keys(GROUPS).concat('other').map(function (g) {
      return { group: g, n: areas.filter(function (a) { return groupOf(a.area + '.') === g; }).reduce(function (s, a) { return s + a.n; }, 0) };
    }),
    areas: areas.map(function (a) { return { area: a.area, group: groupOf(a.area + '.'), n: a.n }; }),
    people: people.map(function (r) {
      return { id: r.id, name: r.id ? r.name : 'System', n: r.n, afterHours: r.after_hours, employeeId: r.employee_id, photo: r.photo_key ? (r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : 1) : null };
    }),
    week: counts.week, prevWeek: counts.prev_week, signIns: counts.sign_ins, actorsWeek: counts.actors_week,
    accessChanges: counts.access_changes, settingsChanges: counts.settings_changes, removals: counts.removals, afterHours: counts.after_hours,
    latestAccess: latestAccess ? { at: latestAccess.at, actorName: latestAccess.actor_name, action: latestAccess.action, summary: latestAccess.summary } : null,
    actors: actors.map(function (r) { return { id: r.id || 'system', name: r.id ? r.name : 'System', lastAt: r.last_at }; })
  };
}

module.exports = { list: list, summary: summary, GROUPS: GROUPS };
