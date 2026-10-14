var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var S = require('./mkShared');
var requests = require('./mkRequests.service');

// Routines: a marketing request that comes round on its own — "an
// Instagram post every Monday and Thursday, needed 2 days later", "the
// month's price list on the 1st". Every N weeks on chosen weekdays, or
// every N months on a day of the month (the 31st is each month's last day),
// from a start date to an optional end. On each day it comes round, the
// job (jobs/mkRoutines.js → runDue) makes an ordinary request from it, with
// the routine's lead, team and campaign: the lead and the team are told
// (and the team texted, as when they are put on one); with no lead,
// marketing is told as for any new request. One request per routine per
// day (ux_marketing_requests_routine_on), so a second run makes nothing.
//
// Anyone may set one up for what they need regularly, as they may ask for
// anything; it is theirs to change, pause or stop. Marketing
// (marketing.manage) may change any, and alone sets the lead, team and
// campaign; marketing.read sees them all.

var MAX_TEAM = 20;
var CATCH_UP_DAYS = 7; // after the server was off: only the last 7 days (today and 6 before) are made

// ---- dates (UTC: Ghana keeps GMT all year) --------------------------------
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekday(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
function mondayOf(iso) { return addDays(iso, -((weekday(iso) + 6) % 7)); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function monthEnd(iso) { var d = new Date(iso + 'T00:00:00Z'); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); }

// Whether the routine comes round on a day. rt: { every, every_n, weekdays,
// month_day, starts_on, ends_on }.
function fallsOn(rt, iso) {
  if (iso < rt.starts_on || (rt.ends_on && iso > rt.ends_on)) return false;
  var n = Number(rt.every_n) || 1;
  if (rt.every === 'week') {
    if ((rt.weekdays || []).map(Number).indexOf(weekday(iso)) < 0) return false;
    return (daysBetween(mondayOf(rt.starts_on), mondayOf(iso)) / 7) % n === 0;
  }
  var d = new Date(iso + 'T00:00:00Z'), s = new Date(rt.starts_on + 'T00:00:00Z');
  var months = (d.getUTCFullYear() - s.getUTCFullYear()) * 12 + d.getUTCMonth() - s.getUTCMonth();
  return months % n === 0 && d.getUTCDate() === Math.min(Number(rt.month_day), monthEnd(iso));
}
// The first day on or after `from` it comes round; null once it has ended.
function nextOn(rt, from) {
  var day = from > rt.starts_on ? from : rt.starts_on;
  for (var i = 0; i < 800; i++, day = addDays(day, 1)) {
    if (rt.ends_on && day > rt.ends_on) return null;
    if (fallsOn(rt, day)) return day;
  }
  return null;
}

// ---- reading ----------------------------------------------------------------
function person(id, first, last, photo) { return id ? { id: id, name: S.employeeName(first, last), photo: photo ? new Date(photo).getTime() : null } : null; }
function out(r, ctx) {
  return {
    id: r.id, company: { code: r.company_code, name: r.company_name },
    title: r.title, kind: r.kind, brief: r.brief, audience: r.audience, priority: r.priority,
    every: r.every, everyN: r.every_n, weekdays: (r.weekdays || []).map(Number), monthDay: r.month_day, dueAfterDays: r.due_after_days,
    startsOn: r.starts_on, endsOn: r.ends_on, nextOn: r.paused ? null : r.next_on, paused: r.paused, ended: !r.next_on && !r.paused,
    owner: person(r.requested_by, r.ow_first, r.ow_last, r.ow_photo),
    lead: person(r.assigned_to, r.as_first, r.as_last, r.as_photo),
    team: (r.team_people || []).map(function (m) { return person(m.id, m.first, m.last, m.photo); }),
    campaign: r.campaign_id ? { id: r.campaign_id, name: r.campaign_name } : null,
    made: r.made_count, lastMadeOn: r.last_made_on, open: Number(r.open_requests || 0),
    mine: !!(ctx && ctx.employee && r.requested_by === ctx.employee.id),
    canEdit: !!(ctx && ctx.employee && (r.requested_by === ctx.employee.id || ctx.can('marketing.manage')))
  };
}
var SELECT = 'SELECT rt.*, co.code AS company_code, co.name AS company_name, c.name AS campaign_name, ' +
  'o.first_name AS ow_first, o.last_name AS ow_last, CASE WHEN o.photo_key IS NOT NULL THEN o.photo_updated_at END AS ow_photo, ' +
  'a.first_name AS as_first, a.last_name AS as_last, CASE WHEN a.photo_key IS NOT NULL THEN a.photo_updated_at END AS as_photo, ' +
  "(SELECT coalesce(json_agg(json_build_object('id', e.id, 'first', e.first_name, 'last', e.last_name, " +
  "'photo', CASE WHEN e.photo_key IS NOT NULL THEN e.photo_updated_at END) ORDER BY t.n), '[]'::json) " +
  'FROM unnest(rt.team) WITH ORDINALITY t(id, n) JOIN employees e ON e.id = t.id) AS team_people, ' +
  "(SELECT count(*) FROM marketing_requests x WHERE x.routine_id = rt.id AND x.status IN ('new', 'in_progress', 'review')) AS open_requests " +
  'FROM marketing_request_routines rt JOIN companies co ON co.id = rt.company_id LEFT JOIN marketing_campaigns c ON c.id = rt.campaign_id ' +
  'JOIN employees o ON o.id = rt.requested_by LEFT JOIN employees a ON a.id = rt.assigned_to ';

function me(ctx) {
  if (!ctx || !ctx.employee) fail('forbidden', 'Sign in first.');
  return ctx.employee.id;
}
function involved(r, who) { return r.requested_by === who || r.assigned_to === who || (r.team || []).indexOf(who) >= 0; }
async function row(id) {
  var r = (await pool.query(SELECT + 'WHERE rt.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Routine not found.');
  return r;
}
async function visible(ctx, id) {
  var my = me(ctx);
  var r = await row(id);
  if (!involved(r, my) && !S.canRead(ctx)) fail('forbidden', 'This routine is not yours to see.');
  return r;
}
async function editable(ctx, id) {
  var r = await visible(ctx, id);
  if (r.requested_by !== ctx.employee.id && !ctx.can('marketing.manage')) fail('forbidden', 'Only the one who set it up, or marketing, can change it.');
  return r;
}

// GET /api/mk/routines?scope=mine|all&company=
async function list(ctx, opts) {
  var my = me(ctx);
  var all = opts && opts.scope === 'all' && S.canRead(ctx);
  var args = [], where = [];
  if (all) {
    if (opts.company) { var co = await S.company(opts.company); args.push(co.id); where.push('rt.company_id = $' + args.length); }
  } else {
    args.push(my); where.push('(rt.requested_by = $1 OR rt.assigned_to = $1 OR $1 = ANY(rt.team))');
  }
  var rows = (await pool.query(SELECT + (where.length ? 'WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY rt.paused, rt.next_on NULLS LAST, rt.title LIMIT 200', args)).rows;
  return rows.map(function (r) { return out(r, ctx); });
}

async function get(ctx, id) { return out(await visible(ctx, id), ctx); }

// ---- setting up -------------------------------------------------------------
function whole(v, label, min, max, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  var n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail('invalid', label + ' must be a whole number from ' + min + ' to ' + max + '.');
  return n;
}
function scheduleFields(p, current) {
  var title = S.text(p.title, 160);
  if (!title) fail('invalid', 'Say what is needed each time.');
  var every = S.oneOf(p.every, ['week', 'month'], 'How often', 'week');
  var f = {
    title: title, kind: S.oneOf(p.kind, requests.KINDS, 'Kind', 'other'), brief: S.text(p.brief, 4000), audience: S.text(p.audience, 300),
    priority: S.oneOf(p.priority, ['normal', 'urgent'], 'Priority', 'normal'),
    every: every, every_n: whole(p.everyN, 'Every how many ' + (every === 'week' ? 'weeks' : 'months'), 1, 12, 1),
    weekdays: [], month_day: null,
    due_after_days: whole(p.dueAfterDays, 'Days to get it done', 0, 60, 0),
    starts_on: S.dateOrNull(p.startsOn, 'Starts on') || S.todayIso(),
    ends_on: S.dateOrNull(p.endsOn, 'Ends on')
  };
  if (every === 'week') {
    f.weekdays = Array.from(new Set((Array.isArray(p.weekdays) ? p.weekdays : []).map(Number))).filter(function (d) { return Number.isInteger(d) && d >= 0 && d <= 6; }).sort();
    if (!f.weekdays.length) fail('invalid', 'Pick the day or days of the week it comes round.');
  } else {
    f.month_day = whole(p.monthDay, 'Day of the month', 1, 31, null);
    if (!f.month_day) fail('invalid', 'Pick the day of the month it comes round.');
  }
  var startChanged = !current || current.starts_on !== f.starts_on;
  if (startChanged && f.starts_on < S.todayIso()) fail('invalid', 'The start date has already passed.');
  if (f.ends_on && f.ends_on < f.starts_on) fail('invalid', 'It ends before it starts.');
  return f;
}
async function crewFields(ctx, p, current, companyId) {
  var keep = { assigned_to: current ? current.assigned_to : null, campaign_id: current ? current.campaign_id : null, team: current ? current.team || [] : [] };
  if (!ctx.can('marketing.manage')) return keep;
  var lead = p.assignedTo === undefined ? keep.assigned_to : p.assignedTo || null;
  var campaign = p.campaignId === undefined ? keep.campaign_id : p.campaignId || null;
  var team = p.teamIds === undefined ? keep.team : S.list(p.teamIds).filter(function (x) { return x !== lead; });
  if (team.length > MAX_TEAM) fail('invalid', 'A team can have up to ' + MAX_TEAM + ' people.');
  var people = [lead].concat(team).filter(Boolean);
  if (people.length) {
    var ok = (await pool.query("SELECT id FROM employees WHERE id::text = ANY($1) AND status <> 'terminated'", [people])).rows.length;
    if (ok !== people.length) fail('invalid', 'Someone picked is not on the staff list.');
  }
  if (campaign) {
    var c = (await pool.query('SELECT company_id FROM marketing_campaigns WHERE id = $1', [campaign])).rows[0];
    if (!c || c.company_id !== companyId) fail('invalid', 'That campaign is not this company\'s.');
  }
  return { assigned_to: lead, campaign_id: campaign, team: team };
}

// POST /api/mk/routines — anyone; the first request is made straight away
// when it comes round today.
async function create(ctx, p) {
  var my = me(ctx);
  var co = await S.company(p.company);
  var f = scheduleFields(p, null);
  var crew = await crewFields(ctx, p, null, co.id);
  var next = nextOn(f, S.todayIso());
  if (!next) fail('invalid', 'It never comes round between its start and end dates.');
  var id = await withTransaction(async function (db) {
    var r = (await db.query(
      'INSERT INTO marketing_request_routines (company_id, title, kind, brief, audience, priority, every, every_n, weekdays, month_day, due_after_days, starts_on, ends_on, next_on, requested_by, assigned_to, campaign_id, team) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id',
      [co.id, f.title, f.kind, f.brief, f.audience, f.priority, f.every, f.every_n, f.weekdays, f.month_day, f.due_after_days, f.starts_on, f.ends_on, next, my, crew.assigned_to, crew.campaign_id, crew.team])).rows[0];
    await audit(db, ctx, 'marketing.routine.create', 'marketing_routine', r.id, 'Routine: ' + f.title + '.');
    return r.id;
  });
  var made = await makeDue(id, S.todayIso());
  return Object.assign(await get(ctx, id), { madeNow: made });
}

// PUT /api/mk/routines/:id — the one who set it up, or marketing. Days
// already made stay made; it carries on from today.
async function update(ctx, id, p) {
  var r = await editable(ctx, id);
  var f = scheduleFields(p, r);
  var crew = await crewFields(ctx, p, r, r.company_id);
  var from = S.todayIso();
  if (r.last_made_on && addDays(r.last_made_on, 1) > from) from = addDays(r.last_made_on, 1);
  var next = nextOn(f, from);
  await withTransaction(async function (db) {
    await db.query(
      'UPDATE marketing_request_routines SET title = $2, kind = $3, brief = $4, audience = $5, priority = $6, every = $7, every_n = $8, weekdays = $9, month_day = $10, ' +
      'due_after_days = $11, starts_on = $12, ends_on = $13, next_on = $14, assigned_to = $15, campaign_id = $16, team = $17, updated_at = now() WHERE id = $1',
      [id, f.title, f.kind, f.brief, f.audience, f.priority, f.every, f.every_n, f.weekdays, f.month_day, f.due_after_days, f.starts_on, f.ends_on, next, crew.assigned_to, crew.campaign_id, crew.team]);
    await audit(db, ctx, 'marketing.routine.update', 'marketing_routine', id, 'Updated the routine ' + f.title + '.');
  });
  var made = await makeDue(id, S.todayIso());
  return Object.assign(await get(ctx, id), { madeNow: made });
}

// POST /api/mk/routines/:id/pause { paused } — paused, nothing is made;
// resumed, it carries on from today (the days in between are not made).
async function setPaused(ctx, id, p) {
  var r = await editable(ctx, id);
  var paused = !!(p && p.paused);
  var next = paused ? r.next_on : nextOn(r, r.last_made_on && addDays(r.last_made_on, 1) > S.todayIso() ? addDays(r.last_made_on, 1) : S.todayIso());
  await withTransaction(async function (db) {
    await db.query('UPDATE marketing_request_routines SET paused = $2, next_on = $3, updated_at = now() WHERE id = $1', [id, paused, next]);
    await audit(db, ctx, paused ? 'marketing.routine.pause' : 'marketing.routine.resume', 'marketing_routine', id, (paused ? 'Paused' : 'Resumed') + ' the routine ' + r.title + '.');
  });
  var made = paused ? 0 : await makeDue(id, S.todayIso());
  return Object.assign(await get(ctx, id), { madeNow: made });
}

// DELETE /api/mk/routines/:id — stops it; the requests it made stay.
async function remove(ctx, id) {
  var r = await editable(ctx, id);
  await withTransaction(async function (db) {
    await db.query('DELETE FROM marketing_request_routines WHERE id = $1', [id]);
    await audit(db, ctx, 'marketing.routine.delete', 'marketing_routine', id, 'Stopped the routine ' + r.title + ' (' + r.made_count + ' made).');
  });
  return { deleted: true };
}

// ---- making the requests ------------------------------------------------------
// One request from the routine for a day, inside the caller's transaction.
// Returns the new request row, or null when that day's was made already.
async function makeOne(db, rt, on) {
  var due = addDays(on, rt.due_after_days || 0);
  var r = (await db.query(
    'INSERT INTO marketing_requests (company_id, title, kind, brief, audience, due_on, priority, requested_by, assigned_to, campaign_id, routine_id, routine_on, created_at) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now()) ON CONFLICT (routine_id, routine_on) DO NOTHING RETURNING id, number, title, due_on',
    [rt.company_id, rt.title, rt.kind, rt.brief, rt.audience, due, rt.priority, rt.requested_by, rt.assigned_to, rt.campaign_id, rt.id, on])).rows[0];
  if (!r) return null;
  var ref = 'MR-' + String(r.number).padStart(4, '0');
  var team = (await db.query("SELECT id FROM employees WHERE id = ANY($1) AND status = 'active'", [rt.team || []])).rows
    .map(function (e) { return e.id; }).filter(function (x) { return x !== rt.assigned_to; });
  for (var who of team) {
    await db.query('INSERT INTO marketing_request_members (request_id, employee_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [r.id, who, rt.requested_by]);
    await notify(db, who, 'You are on the team for ' + ref, r.title + ', needed by ' + due + '.', '/mkrequests?open=' + r.id);
  }
  if (rt.assigned_to) {
    await notify(db, rt.assigned_to, 'Assigned to you: ' + r.title, 'From a routine, needed by ' + due + '.', '/mkrequests?open=' + r.id);
  } else {
    for (var m of await S.managers()) {
      if (m === rt.requested_by) continue;
      await notify(db, m, (rt.priority === 'urgent' ? 'Urgent request: ' : 'New request: ') + r.title, 'From a routine, needed by ' + due + '.', '/mkrequests?open=' + r.id);
    }
  }
  await audit(db, null, 'marketing.request.create', 'marketing_request', r.id, ref + ': ' + r.title + ' (from a routine, for ' + on + ').');
  return { id: r.id, number: r.number, title: r.title, due_on: due, team: team };
}

// Makes what a routine owes up to `today`: one request for each day it came
// round (the last CATCH_UP_DAYS days), then moves next_on on. Locked, so two runs
// at once can't both make them. Returns how many were made.
async function makeDue(id, today) {
  var made = [], owner = null;
  await withTransaction(async function (db) {
    var rt = (await db.query('SELECT * FROM marketing_request_routines WHERE id = $1 FOR UPDATE SKIP LOCKED', [id])).rows[0];
    if (!rt || rt.paused || !rt.next_on || rt.next_on > today) return;
    owner = rt.requested_by;
    var on = rt.next_on, floor = addDays(today, 1 - CATCH_UP_DAYS);
    while (on && on <= today) {
      if (on >= floor) { var r = await makeOne(db, rt, on); if (r) made.push(r); }
      on = nextOn(rt, addDays(on, 1));
    }
    await db.query('UPDATE marketing_request_routines SET next_on = $2, made_count = made_count + $3, last_made_on = CASE WHEN $3 > 0 THEN $4::date ELSE last_made_on END, updated_at = now() WHERE id = $1',
      [id, on, made.length, today]);
  });
  // The team's texts, once it is all saved (never failing the run).
  for (var r of made) {
    try { await requests.textTeam({ employee: { id: owner } }, r, r.team); } catch (e) { console.error('Routine team text not sent:', e.message); }
  }
  return made.length;
}

// Every routine that is due: the job's work. Returns how many requests were made.
async function runDue(today) {
  today = today || S.todayIso();
  var due = (await pool.query('SELECT id FROM marketing_request_routines WHERE NOT paused AND next_on IS NOT NULL AND next_on <= $1 ORDER BY next_on', [today])).rows;
  var n = 0;
  for (var r of due) {
    try { n += await makeDue(r.id, today); } catch (e) { console.error('[mk] routine ' + r.id + ' not run:', e.message); }
  }
  return n;
}

module.exports = {
  list: list, get: get, create: create, update: update, setPaused: setPaused, remove: remove, runDue: runDue,
  _fallsOn: fallsOn, _nextOn: nextOn
};
