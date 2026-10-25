var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var S = require('./mkShared');
var routines = require('./mkRoutines.service');

// Ask marketing's summary (GET /api/mk/requests/summary), the figures for
// the page's Summary section and its slides: for a week (Monday to Sunday)
// or a month, what the company asked marketing for and what marketing
// delivered — asked for and done against the same days of the period
// before, how many were done by the day needed, how long they took, what
// kinds, which companies, who asked and who did the work (the one leading
// it, and the team who helped), every one done, the eight periods before,
// and, as things stand now, what is late or waiting, and what is due from
// today to 7 days on (a week) or 30 (a month), with the requests routines
// will make. Whose requests: the
// same as the board — marketing (marketing.read, scope=all) everyone's,
// optionally one company's; anyone else the ones they asked for, lead or
// are on the team of.

var OPEN = "('new', 'in_progress', 'review')";
var TREND = 8;

function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function mondayOf(iso) { return addDays(iso, -((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7)); }
function periodOf(kind, iso) {
  if (kind === 'week') { var m = mondayOf(iso); return { from: m, to: addDays(m, 6) }; }
  var first = iso.slice(0, 7) + '-01', d = new Date(first + 'T00:00:00Z');
  return { from: first, to: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10) };
}
function person(id, first, last, photo) { return id ? { id: id, name: S.employeeName(first, last), photo: photo ? new Date(photo).getTime() : null } : null; }
function ref(n) { return 'MR-' + String(n).padStart(4, '0'); }
var PHOTO = 'CASE WHEN e.photo_key IS NOT NULL THEN e.photo_updated_at END';

async function summary(ctx, opts) {
  if (!ctx || !ctx.employee) fail('forbidden', 'Sign in first.');
  opts = opts || {};
  var my = ctx.employee.id;
  var all = opts.scope === 'all' && S.canRead(ctx);
  var kind = S.oneOf(opts.period, ['week', 'month'], 'Period', 'month');
  var today = S.todayIso();
  var p = periodOf(kind, S.dateOrNull(opts.from, 'From') || today);
  if (p.from > today) fail('invalid', 'That ' + kind + ' has not started yet.');
  var until = p.to < today ? p.to : today;
  var prev = periodOf(kind, addDays(p.from, -1));
  var prevUntil = addDays(prev.from, daysBetween(p.from, until));
  if (prevUntil > prev.to) prevUntil = prev.to;
  var co = opts.company ? await S.company(opts.company) : null;

  // The requests this person may see, as the board.
  var args = [], where = [];
  if (!all) { args.push(my); where.push('(r.requested_by = $1 OR r.assigned_to = $1 OR EXISTS (SELECT 1 FROM marketing_request_members m WHERE m.request_id = r.id AND m.employee_id = $1))'); }
  if (co) { args.push(co.id); where.push('r.company_id = $' + args.length); }
  var VIS = 'WITH vis AS (SELECT r.* FROM marketing_requests r' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ') ';
  // The dates go in by name (:F the period's first day, :U the last that
  // has happened, :PF/:PU the same days of the period before, :T today,
  // :C the end of the coming days, :TF/:TT the trend's periods), each
  // query given only the ones it uses.
  var F = ':F', U = ':U', PF = ':PF', PU = ':PU', T = ':T';
  function run(sql, values) {
    var list = args.slice(), pos = {};
    sql = sql.replace(/:(TF|TT|PF|PU|F|U|T|C)\b/g, function (m, name) {
      if (!pos[name]) { list.push(values[name]); pos[name] = list.length; }
      return '$' + pos[name] + (name === 'TF' || name === 'TT' ? '::date[]' : '::date');
    });
    return pool.query(sql, list);
  }
  function doneIn(a, f, u) { return a + "status = 'done' AND " + a + 'done_at::date BETWEEN ' + f + ' AND ' + u; }
  function onTime(a) { return '(' + a + 'due_on IS NULL OR ' + a + 'done_at::date <= ' + a + 'due_on)'; }
  var NAMES = 'e.first_name, e.last_name, ' + PHOTO + ' AS photo';

  // The eight periods up to this one, for the trend.
  var trend = [];
  for (var i = TREND - 1, at = p; i >= 0; i--) { trend.unshift(at); at = periodOf(kind, addDays(at.from, -1)); }
  var comingTo = addDays(today, kind === 'week' ? 7 : 30);

  var D = { F: p.from, U: until, PF: prev.from, PU: prevUntil, T: today, C: comingTo,
    TF: trend.map(function (x) { return x.from; }), TT: trend.map(function (x) { return x.to; }) };
  var q = await Promise.all([
    run(VIS + 'SELECT ' +
      'count(*) FILTER (WHERE created_at::date BETWEEN ' + F + ' AND ' + U + ')::int AS made, ' +
      'count(*) FILTER (WHERE created_at::date BETWEEN ' + PF + ' AND ' + PU + ')::int AS made_before, ' +
      "count(*) FILTER (WHERE created_at::date BETWEEN " + F + ' AND ' + U + " AND priority = 'urgent')::int AS urgent, " +
      'count(*) FILTER (WHERE created_at::date BETWEEN ' + F + ' AND ' + U + ' AND routine_id IS NOT NULL)::int AS from_routines, ' +
      'count(*) FILTER (WHERE ' + doneIn('', F, U) + ')::int AS done, ' +
      'count(*) FILTER (WHERE ' + doneIn('', PF, PU) + ')::int AS done_before, ' +
      'count(*) FILTER (WHERE ' + doneIn('', F, U) + ' AND ' + onTime('') + ')::int AS on_time, ' +
      'count(*) FILTER (WHERE ' + doneIn('', PF, PU) + ' AND ' + onTime('') + ')::int AS on_time_before, ' +
      'avg(EXTRACT(EPOCH FROM done_at - created_at) / 86400) FILTER (WHERE ' + doneIn('', F, U) + ') AS days, ' +
      'avg(EXTRACT(EPOCH FROM done_at - created_at) / 86400) FILTER (WHERE ' + doneIn('', PF, PU) + ') AS days_before, ' +
      'count(*) FILTER (WHERE status IN ' + OPEN + ')::int AS open, ' +
      "count(*) FILTER (WHERE status = 'new')::int AS fresh, count(*) FILTER (WHERE status = 'review')::int AS review, " +
      'count(*) FILTER (WHERE status IN ' + OPEN + ' AND due_on < ' + T + ')::int AS late FROM vis', D),
    run(VIS + 'SELECT kind, count(*) FILTER (WHERE created_at::date BETWEEN ' + F + ' AND ' + U + ')::int AS made, ' +
      'count(*) FILTER (WHERE ' + doneIn('', F, U) + ')::int AS done FROM vis GROUP BY kind', D),
    run(VIS + 'SELECT co.code, co.name, count(*) FILTER (WHERE r.created_at::date BETWEEN ' + F + ' AND ' + U + ')::int AS made, ' +
      'count(*) FILTER (WHERE ' + doneIn('r.', F, U) + ')::int AS done, count(*) FILTER (WHERE r.status IN ' + OPEN + ' AND r.due_on < ' + T + ')::int AS late ' +
      'FROM vis r JOIN companies co ON co.id = r.company_id GROUP BY co.code, co.name', D),
    run(VIS + 'SELECT e.id, ' + NAMES + ', count(*)::int AS n FROM vis r JOIN employees e ON e.id = r.requested_by ' +
      'WHERE r.created_at::date BETWEEN ' + F + ' AND ' + U + ' GROUP BY e.id ORDER BY n DESC, e.first_name LIMIT 6', D),
    run(VIS + ', led AS (SELECT assigned_to AS id, count(*) FILTER (WHERE ' + doneIn('', F, U) + ')::int AS done, ' +
      'count(*) FILTER (WHERE ' + doneIn('', F, U) + ' AND ' + onTime('') + ')::int AS on_time, ' +
      'count(*) FILTER (WHERE status IN ' + OPEN + ')::int AS open, count(*) FILTER (WHERE status IN ' + OPEN + ' AND due_on < ' + T + ')::int AS late ' +
      'FROM vis WHERE assigned_to IS NOT NULL GROUP BY 1), ' +
      'helped AS (SELECT m.employee_id AS id, count(*)::int AS n FROM vis r JOIN marketing_request_members m ON m.request_id = r.id WHERE ' + doneIn('r.', F, U) + ' GROUP BY 1) ' +
      'SELECT e.id, ' + NAMES + ', coalesce(led.done, 0) AS done, coalesce(led.on_time, 0) AS on_time, coalesce(led.open, 0) AS open, coalesce(led.late, 0) AS late, coalesce(helped.n, 0) AS helped ' +
      'FROM employees e LEFT JOIN led ON led.id = e.id LEFT JOIN helped ON helped.id = e.id ' +
      'WHERE coalesce(led.done, 0) + coalesce(led.open, 0) + coalesce(helped.n, 0) > 0 ORDER BY done DESC, helped DESC, open DESC, e.first_name LIMIT 10', D),
    run(VIS + "SELECT r.id, r.number, r.title, r.kind, r.due_on, to_char(r.done_at, 'YYYY-MM-DD') AS done_on, r.routine_id, co.code AS company_code, co.name AS company_name, " +
      'r.assigned_to, ' + NAMES + ', (SELECT count(*) FROM marketing_request_files f WHERE f.request_id = r.id AND f.delivered)::int AS delivered ' +
      'FROM vis r JOIN companies co ON co.id = r.company_id LEFT JOIN employees e ON e.id = r.assigned_to WHERE ' + doneIn('r.', F, U) + ' ORDER BY r.done_at LIMIT 60', D),
    run(VIS + 'SELECT r.id, r.number, r.title, r.kind, r.status, r.due_on, r.priority, co.code AS company_code, co.name AS company_name, r.assigned_to, ' + NAMES + ' ' +
      'FROM vis r JOIN companies co ON co.id = r.company_id LEFT JOIN employees e ON e.id = r.assigned_to ' +
      'WHERE r.status IN ' + OPEN + ' AND r.due_on < ' + T + ' ORDER BY r.due_on, r.number LIMIT 30', D),
    run(VIS + "SELECT r.id, r.number, r.title, r.kind, r.status, r.due_on, r.priority, to_char(r.created_at, 'YYYY-MM-DD') AS asked_on, co.code AS company_code, co.name AS company_name, " +
      'r.requested_by, ' + NAMES + ' FROM vis r JOIN companies co ON co.id = r.company_id JOIN employees e ON e.id = r.requested_by ' +
      "WHERE r.status IN ('new', 'review') ORDER BY r.status, r.created_at LIMIT 24", D),
    run(VIS + 'SELECT b.i, b.f AS pfrom, b.t AS pto, ' +
      '(SELECT count(*) FROM vis WHERE created_at::date BETWEEN b.f AND b.t)::int AS made, ' +
      "(SELECT count(*) FROM vis WHERE status = 'done' AND done_at::date BETWEEN b.f AND b.t)::int AS done, " +
      "(SELECT count(*) FROM vis WHERE status = 'done' AND done_at::date BETWEEN b.f AND b.t AND " + onTime('') + ')::int AS on_time ' +
      'FROM unnest(:TF, :TT) WITH ORDINALITY b(f, t, i) ORDER BY b.i', D),
    run(VIS + 'SELECT r.id, r.number, r.title, r.kind, r.status, r.due_on, r.priority, co.code AS company_code, co.name AS company_name, r.assigned_to, ' + NAMES + ' ' +
      'FROM vis r JOIN companies co ON co.id = r.company_id LEFT JOIN employees e ON e.id = r.assigned_to ' +
      'WHERE r.status IN ' + OPEN + ' AND r.due_on BETWEEN ' + T + ' AND :C ORDER BY r.due_on, r.number LIMIT 40', D),
    routines.upcoming(co ? co.id : null, addDays(today, 1), comingTo, all ? null : my)
  ]);

  var c = q[0].rows[0];
  function company(r) { return { code: r.company_code, name: r.company_name }; }
  function days(v) { return v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10; }
  var out = {
    scope: all ? 'all' : 'mine', canSeeAll: S.canRead(ctx), canManage: ctx.can('marketing.manage'),
    company: co ? { code: co.code, name: co.name } : null,
    period: { kind: kind, from: p.from, to: p.to, until: until, current: today <= p.to, prevFrom: prev.from, prevUntil: prevUntil, today: today, comingTo: comingTo },
    made: c.made, madeBefore: c.made_before, urgent: c.urgent, fromRoutines: c.from_routines,
    done: c.done, doneBefore: c.done_before, onTime: c.on_time, onTimeBefore: c.on_time_before,
    days: days(c.days), daysBefore: days(c.days_before),
    open: c.open, fresh: c.fresh, review: c.review, late: c.late,
    kinds: q[1].rows.filter(function (r) { return r.made || r.done; }).sort(function (a, b) { return (b.made + b.done) - (a.made + a.done) || (a.kind < b.kind ? -1 : 1); }),
    companies: q[2].rows.filter(function (r) { return r.made || r.done || r.late; }).sort(function (a, b) { return b.made - a.made || b.done - a.done || (a.name < b.name ? -1 : 1); }),
    askers: q[3].rows.map(function (r) { return Object.assign(person(r.id, r.first_name, r.last_name, r.photo), { n: r.n }); }),
    team: q[4].rows.map(function (r) { return Object.assign(person(r.id, r.first_name, r.last_name, r.photo), { done: r.done, onTime: r.on_time, open: r.open, late: r.late, helped: r.helped }); }),
    doneList: q[5].rows.map(function (r) {
      var late = r.due_on && r.done_on > r.due_on ? daysBetween(r.due_on, r.done_on) : 0;
      return { id: r.id, ref: ref(r.number), title: r.title, kind: r.kind, company: company(r), dueOn: r.due_on, doneOn: r.done_on, daysLate: late, onTime: !late,
        fromRoutine: !!r.routine_id, delivered: r.delivered, lead: person(r.assigned_to, r.first_name, r.last_name, r.photo) };
    }),
    lateList: q[6].rows.map(function (r) {
      return { id: r.id, ref: ref(r.number), title: r.title, kind: r.kind, status: r.status, priority: r.priority, company: company(r), dueOn: r.due_on,
        daysLate: daysBetween(r.due_on, today), lead: person(r.assigned_to, r.first_name, r.last_name, r.photo) };
    }),
    waiting: q[7].rows.map(function (r) {
      return { id: r.id, ref: ref(r.number), title: r.title, kind: r.kind, status: r.status, priority: r.priority, company: company(r), dueOn: r.due_on, askedOn: r.asked_on,
        asker: person(r.requested_by, r.first_name, r.last_name, r.photo) };
    }),
    trend: q[8].rows.map(function (r) { return { from: r.pfrom, to: r.pto, made: r.made, done: r.done, onTime: r.on_time }; }),
    coming: {
      from: today, to: comingTo,
      due: q[9].rows.map(function (r) {
        return { id: r.id, ref: ref(r.number), title: r.title, kind: r.kind, status: r.status, priority: r.priority, company: company(r), dueOn: r.due_on,
          lead: person(r.assigned_to, r.first_name, r.last_name, r.photo) };
      }),
      routines: q[10].slice(0, 40).map(function (u) { return { routine: u.routine, title: u.title, kind: u.kind, company: u.company, lead: u.lead, on: u.on, dueOn: u.due }; })
    }
  };
  out.insights = insights(out);
  return out;
}

// What stands out, as { tone, kind, values }: the page writes the words.
function insights(s) {
  var list = [];
  if (s.late) list.push({ tone: 'bad', kind: 'late', values: { n: s.late } });
  if (s.done >= 3) {
    var pct = Math.round((s.onTime / s.done) * 100);
    list.push({ tone: pct >= 80 ? 'good' : pct >= 60 ? 'warn' : 'bad', kind: 'on_time', values: { pct: pct, n: s.onTime, of: s.done } });
  }
  if (s.fresh) list.push({ tone: 'warn', kind: 'not_taken', values: { n: s.fresh } });
  if (s.review) list.push({ tone: 'info', kind: 'to_check', values: { n: s.review } });
  if (s.madeBefore >= 3 && s.made >= s.madeBefore * 1.3) list.push({ tone: 'info', kind: 'asked_more', values: { now: s.made, before: s.madeBefore } });
  else if (s.madeBefore >= 3 && s.made <= s.madeBefore * 0.7) list.push({ tone: 'info', kind: 'asked_less', values: { now: s.made, before: s.madeBefore } });
  if (s.days !== null && s.daysBefore !== null && Math.abs(s.days - s.daysBefore) >= 1) {
    list.push({ tone: s.days < s.daysBefore ? 'good' : 'warn', kind: s.days < s.daysBefore ? 'faster' : 'slower', values: { days: s.days, before: s.daysBefore } });
  }
  var top = s.kinds.slice().sort(function (a, b) { return b.made - a.made; })[0];
  if (top && top.made >= 2) list.push({ tone: 'info', kind: 'top_kind', values: { kind: top.kind, n: top.made } });
  var doer = s.team.filter(function (t) { return t.done > 0; })[0];
  if (doer && doer.done >= 2) list.push({ tone: 'good', kind: 'top_doer', values: { name: doer.name, n: doer.done } });
  if (s.askers[0] && s.askers[0].n >= 2) list.push({ tone: 'info', kind: 'top_asker', values: { name: s.askers[0].name, n: s.askers[0].n } });
  if (s.fromRoutines) list.push({ tone: 'info', kind: 'routines', values: { n: s.fromRoutines } });
  return list.slice(0, 6);
}

module.exports = { summary: summary, _periodOf: periodOf };
