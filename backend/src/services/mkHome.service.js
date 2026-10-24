var { pool } = require('../db/pool');
var S = require('./mkShared');
var campaigns = require('./mkCampaigns.service');
var routines = require('./mkRoutines.service');

// The marketing department's home and its calendar.
//
// Home — the month at a glance for the head of marketing: leads this month
// against last month (all of the CRM's for Bamboo Products, which owns
// it; those credited to the company's campaigns for the others), spend
// against the year's budget and its pace, cost per lead, campaigns live,
// posts published against planned, requests waiting (and late), followers
// against a month ago, where the leads came from, the last 90 days' leads
// by where they got to, the week ahead, and what stands out.
//
// Calendar — everything with a date in one place: campaigns (from start to
// end), posts, events, promotions, requests' due dates, the requests
// routines will make (on the day each will be needed), events' checklist
// items, public holidays (the company's holiday list) and the marketing
// moments of the year (Valentine's, Mother's Day, Black Friday…).

function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDaysIso(isoDate, n) { var d = new Date(isoDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function home(ctx, opts) {
  S.requireRead(ctx);
  var co = await S.company(opts && opts.company);
  var now = new Date(), today = S.todayIso();
  var mStart = S.iso(monthStart(now)), prevStart = S.iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  var prevSameDay = S.iso(new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate())));
  var yStart = now.getFullYear() + '-01-01';
  var allLeads = co.code === 'BPL';
  // Leads that count for this company: all of them for Bamboo Products,
  // otherwise those credited to its campaigns.
  var LEADS = allLeads ? 'crm_leads l WHERE $1::uuid IS NOT NULL' : 'crm_leads l JOIN marketing_campaigns mc ON mc.id = l.campaign_id WHERE mc.company_id = $1';
  var q = await Promise.all([
    pool.query('SELECT count(*) FILTER (WHERE l.received_on >= $2)::int AS now, count(*) FILTER (WHERE l.received_on BETWEEN $3 AND $4)::int AS before, ' +
      'count(*) FILTER (WHERE l.received_on >= $2 AND l.campaign_id IS NOT NULL)::int AS credited FROM ' + LEADS, [co.id, mStart, prevStart, prevSameDay]),
    pool.query("SELECT coalesce(sum(amount) FILTER (WHERE spent_on >= $2), 0) AS month, coalesce(sum(amount) FILTER (WHERE spent_on >= $3), 0) AS year, " +
      'coalesce(sum(amount) FILTER (WHERE spent_on BETWEEN $4 AND $5), 0) AS before FROM marketing_spend WHERE company_id = $1', [co.id, mStart, yStart, prevStart, prevSameDay]),
    pool.query('SELECT coalesce(sum(amount), 0) AS v FROM marketing_budgets WHERE company_id = $1 AND year = $2', [co.id, now.getFullYear()]),
    pool.query("SELECT count(*) FILTER (WHERE p.status = 'published' AND p.published_at >= $2)::int AS published, " +
      "count(*) FILTER (WHERE p.status IN ('planned', 'scheduled') AND p.scheduled_at >= $2 AND p.scheduled_at < ($2::date + interval '1 month'))::int AS planned, " +
      "count(*) FILTER (WHERE p.status IN ('planned', 'scheduled') AND p.scheduled_at < now())::int AS late, " +
      "coalesce(sum(p.reach) FILTER (WHERE p.published_at >= $2), 0)::bigint AS reach " +
      'FROM marketing_posts p JOIN marketing_channels ch ON ch.id = p.channel_id WHERE ch.company_id = $1', [co.id, mStart]),
    pool.query("SELECT count(*) FILTER (WHERE status IN ('new', 'in_progress', 'review'))::int AS open, count(*) FILTER (WHERE status = 'new')::int AS fresh, " +
      "count(*) FILTER (WHERE status IN ('new', 'in_progress', 'review') AND due_on < current_date)::int AS late, " +
      "count(*) FILTER (WHERE status IN ('new', 'in_progress', 'review') AND priority = 'urgent')::int AS urgent FROM marketing_requests WHERE company_id = $1", [co.id]),
    // Followers: each channel's latest count, and its count a month ago.
    pool.query('SELECT ch.id, ch.name, ' +
      '(SELECT followers FROM marketing_channel_stats s WHERE s.channel_id = ch.id ORDER BY captured_on DESC LIMIT 1) AS now, ' +
      "(SELECT followers FROM marketing_channel_stats s WHERE s.channel_id = ch.id AND captured_on <= current_date - 28 ORDER BY captured_on DESC LIMIT 1) AS before " +
      'FROM marketing_channels ch WHERE ch.company_id = $1', [co.id]),
    pool.query("SELECT coalesce(nullif(trim(l.source), ''), 'Not recorded') AS source, count(*)::int AS n FROM " + LEADS + ' AND l.received_on >= $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 8', [co.id, S.iso(new Date(Date.now() - 90 * 86400000))]),
    pool.query("SELECT count(*) FILTER (WHERE l.stage IN ('new', 'contacted', 'follow_up'))::int AS leads, count(*) FILTER (WHERE l.stage IN ('qualified', 'quote_sent', 'negotiation'))::int AS prospects, " +
      "count(*) FILTER (WHERE l.stage = 'won')::int AS won, count(*) FILTER (WHERE l.stage = 'lost')::int AS lost, count(*)::int AS total FROM " + LEADS + ' AND l.received_on >= $2', [co.id, S.iso(new Date(Date.now() - 90 * 86400000))]),
    pool.query("SELECT id FROM marketing_campaigns WHERE company_id = $1 AND status IN ('active', 'planned', 'paused') ORDER BY start_date NULLS LAST LIMIT 12", [co.id]),
    pool.query("SELECT count(*) FILTER (WHERE active AND starts_on <= current_date AND (ends_on IS NULL OR ends_on >= current_date))::int AS running, " +
      "count(*) FILTER (WHERE active AND ends_on BETWEEN current_date AND current_date + 7)::int AS ending FROM marketing_promotions WHERE company_id = $1", [co.id]),
    pool.query("SELECT id, name, starts_on, venue FROM marketing_events WHERE company_id = $1 AND status <> 'cancelled' AND coalesce(ends_on, starts_on) >= current_date ORDER BY starts_on LIMIT 1", [co.id])
  ]);
  var leads = q[0].rows[0], spend = q[1].rows[0], budget = S.num(q[2].rows[0].v), posts = q[3].rows[0], reqs = q[4].rows[0];
  var thisYear = now.getFullYear();
  var through = (Date.UTC(thisYear, now.getMonth(), now.getDate()) - Date.UTC(thisYear, 0, 1) + 86400000) / (Date.UTC(thisYear + 1, 0, 1) - Date.UTC(thisYear, 0, 1));
  var followers = q[5].rows.filter(function (r) { return r.now !== null; });
  var fNow = followers.reduce(function (s, r) { return s + Number(r.now); }, 0);
  var fBefore = followers.filter(function (r) { return r.before !== null; }).reduce(function (s, r) { return s + Number(r.before); }, 0);
  var liveIds = q[8].rows.map(function (r) { return r.id; });
  var board = [];
  if (liveIds.length) {
    var all = await campaigns.list(ctx, { company: co.code });
    board = all.campaigns.filter(function (c) { return liveIds.indexOf(c.id) >= 0; })
      .sort(function (a, b) { return (a.phase === 'running' ? 0 : 1) - (b.phase === 'running' ? 0 : 1); });
  }
  var week = await calendar(ctx, { company: co.code, from: today, to: addDaysIso(today, 7) });
  var out = {
    company: { code: co.code, name: co.name }, canManage: ctx.can('marketing.manage'), allLeads: allLeads, today: today,
    leads: { month: leads.now, before: leads.before, credited: leads.credited },
    spend: { month: S.num(spend.month), before: S.num(spend.before), year: S.num(spend.year), budget: budget, onPace: budget ? S.num(budget * through) : null,
      pct: budget ? Math.round((Number(spend.year) / budget) * 100) : null, yearThrough: Math.round(through * 100) },
    costPerLead: leads.now > 0 && Number(spend.month) > 0 ? S.num(Number(spend.month) / leads.now) : null,
    posts: { published: posts.published, planned: posts.planned, late: posts.late, reach: Number(posts.reach || 0) },
    requests: { open: reqs.open, fresh: reqs.fresh, late: reqs.late, urgent: reqs.urgent },
    followers: { now: fNow, before: fBefore, channels: followers.length },
    sources: q[6].rows, funnel: q[7].rows[0],
    campaigns: board, live: board.filter(function (c) { return c.phase === 'running'; }).length,
    promotions: q[9].rows[0], nextEvent: q[10].rows[0] ? { id: q[10].rows[0].id, name: q[10].rows[0].name, startsOn: q[10].rows[0].starts_on, venue: q[10].rows[0].venue } : null,
    week: week.items
  };
  out.insights = insights(out);
  return out;
}

// What stands out, as { tone, kind, text, values, link }: the page writes
// the words (and translates them); the server picks what matters.
function insights(h) {
  var list = [];
  if (h.requests.late) list.push({ tone: 'bad', kind: 'requests_late', values: { n: h.requests.late }, link: 'mkrequests' });
  else if (h.requests.fresh) list.push({ tone: 'warn', kind: 'requests_new', values: { n: h.requests.fresh }, link: 'mkrequests' });
  if (h.spend.budget && h.spend.onPace !== null && h.spend.year > h.spend.onPace * 1.1) {
    list.push({ tone: 'warn', kind: 'spend_ahead', values: { spent: h.spend.year, pace: h.spend.onPace, pct: h.spend.pct }, link: 'mkbudget' });
  }
  if (!h.spend.budget) list.push({ tone: 'info', kind: 'no_budget', values: {}, link: 'mkbudget' });
  var overdue = h.campaigns.filter(function (c) { return c.phase === 'overdue'; });
  if (overdue.length) list.push({ tone: 'warn', kind: 'campaign_overdue', values: { name: overdue[0].name, n: overdue.length }, link: 'mkcampaigns', id: overdue[0].id });
  var behind = h.campaigns.filter(function (c) { return c.phase === 'running' && c.targetLeads && c.results && c.results.leads < c.targetLeads * 0.5 && c.endDate && c.endDate <= addDaysIso(h.today, 14); });
  if (behind.length) list.push({ tone: 'warn', kind: 'campaign_behind', values: { name: behind[0].name, leads: behind[0].results.leads, target: behind[0].targetLeads }, link: 'mkcampaigns', id: behind[0].id });
  var best = h.campaigns.filter(function (c) { return c.results && c.results.roi !== null && c.results.roi > 0; }).sort(function (a, b) { return b.results.roi - a.results.roi; })[0];
  if (best) list.push({ tone: 'good', kind: 'campaign_best', values: { name: best.name, roi: best.results.roi }, link: 'mkcampaigns', id: best.id });
  if (h.posts.late) list.push({ tone: 'warn', kind: 'posts_late', values: { n: h.posts.late }, link: 'socialtracker' });
  else if (!h.posts.published && !h.posts.planned) list.push({ tone: 'info', kind: 'posts_none', values: {}, link: 'socialtracker' });
  if (h.leads.before > 0 && h.leads.month < h.leads.before * 0.7) list.push({ tone: 'warn', kind: 'leads_down', values: { now: h.leads.month, before: h.leads.before }, link: 'mkcampaigns' });
  else if (h.leads.month > h.leads.before && h.leads.month > 0) list.push({ tone: 'good', kind: 'leads_up', values: { now: h.leads.month, before: h.leads.before }, link: 'mkcampaigns' });
  if (h.promotions.ending) list.push({ tone: 'info', kind: 'promos_ending', values: { n: h.promotions.ending }, link: 'mkpromotions' });
  if (h.nextEvent) {
    var days = Math.round((new Date(h.nextEvent.startsOn + 'T00:00:00Z') - new Date(h.today + 'T00:00:00Z')) / 86400000);
    if (days <= 21) list.push({ tone: 'info', kind: 'event_soon', values: { name: h.nextEvent.name, days: days }, link: 'mkevents', id: h.nextEvent.id });
  }
  return list.slice(0, 6);
}

// The year's marketing moments (beyond the public holidays): fixed dates
// and the ones that move (Easter, Mother's and Father's Day, Black Friday).
function nthWeekday(year, month, weekday, n) {
  var d = new Date(Date.UTC(year, month, 1));
  var shift = (weekday - d.getUTCDay() + 7) % 7;
  d.setUTCDate(1 + shift + (n - 1) * 7);
  return d.toISOString().slice(0, 10);
}
function easter(year) {
  var a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  var h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  var month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}
function moments(year) {
  var thanksgiving = nthWeekday(year, 10, 4, 4);
  return [
    [year + '-01-01', 'new_year'], [year + '-02-14', 'valentines'], [year + '-03-08', 'womens_day'], [easter(year), 'easter'],
    [nthWeekday(year, 4, 0, 2), 'mothers_day'], [nthWeekday(year, 5, 0, 3), 'fathers_day'], [addDaysIso(thanksgiving, 1), 'black_friday'],
    [year + '-12-24', 'christmas_eve'], [year + '-12-25', 'christmas'], [year + '-12-31', 'new_years_eve']
  ].map(function (m) { return { date: m[0], key: m[1] }; });
}

// GET /api/mk/calendar?company=&from=&to=
// marketing.read sees everything. The sales team (crm.read; the sales app)
// sees what they sell around — campaigns, posts, events, promotions,
// holidays and the year's moments — and, of the requests, only their own
// (as on Requests to marketing); not the events' checklists or the
// requests routines will make. full says which.
async function calendar(ctx, opts) {
  var full = S.canRead(ctx);
  if (!full && !ctx.can('crm.read')) S.requireRead(ctx);
  var mine = full ? null : ctx.employee && ctx.employee.id;
  var co = await S.company(opts && opts.company);
  var from = S.dateOrNull(opts && opts.from, 'From') || S.iso(monthStart(new Date()));
  var to = S.dateOrNull(opts && opts.to, 'To') || addDaysIso(from, 41);
  if (to < from) to = from;
  if ((new Date(to) - new Date(from)) / 86400000 > 400) to = addDaysIso(from, 400);
  var q = await Promise.all([
    pool.query("SELECT id, name, status, start_date, end_date FROM marketing_campaigns WHERE company_id = $1 AND status NOT IN ('cancelled', 'draft') " +
      'AND coalesce(start_date, created_at::date) <= $3 AND coalesce(end_date, start_date, created_at::date) >= $2', [co.id, from, to]),
    pool.query('SELECT p.id, p.title, p.status, coalesce(p.published_at, p.scheduled_at) AS at, ch.name AS channel, ch.platform FROM marketing_posts p JOIN marketing_channels ch ON ch.id = p.channel_id ' +
      "WHERE ch.company_id = $1 AND coalesce(p.published_at, p.scheduled_at)::date BETWEEN $2 AND $3 AND p.status <> 'failed'", [co.id, from, to]),
    pool.query("SELECT id, name, kind, status, starts_on, ends_on, venue FROM marketing_events WHERE company_id = $1 AND status <> 'cancelled' AND starts_on <= $3 AND coalesce(ends_on, starts_on) >= $2", [co.id, from, to]),
    pool.query('SELECT id, name, code, starts_on, ends_on, active FROM marketing_promotions WHERE company_id = $1 AND starts_on <= $3 AND coalesce(ends_on, $3) >= $2', [co.id, from, to]),
    full
      ? pool.query("SELECT id, number, title, status, due_on, priority, routine_id FROM marketing_requests WHERE company_id = $1 AND due_on BETWEEN $2 AND $3 AND status <> 'declined'", [co.id, from, to])
      : pool.query("SELECT id, number, title, status, due_on, priority, routine_id FROM marketing_requests r WHERE company_id = $1 AND due_on BETWEEN $2 AND $3 AND status <> 'declined' " +
        'AND (r.requested_by = $4 OR r.assigned_to = $4 OR EXISTS (SELECT 1 FROM marketing_request_members m WHERE m.request_id = r.id AND m.employee_id = $4))', [co.id, from, to, mine]),
    full
      ? pool.query('SELECT t.id, t.title, t.due_on, t.done, ev.id AS event_id, ev.name AS event_name FROM marketing_event_tasks t JOIN marketing_events ev ON ev.id = t.event_id ' +
        "WHERE ev.company_id = $1 AND ev.status <> 'cancelled' AND t.due_on BETWEEN $2 AND $3", [co.id, from, to])
      : { rows: [] },
    pool.query('SELECT date, name FROM holidays WHERE (company_id = $1 OR company_id IS NULL) AND date BETWEEN $2 AND $3', [co.id, from, to]),
    full ? routines.upcoming(co.id, from, to) : []
  ]);
  var items = [];
  q[0].rows.forEach(function (r) { items.push({ kind: 'campaign', id: r.id, title: r.name, start: r.start_date || from, end: r.end_date || r.start_date || from, status: r.status }); });
  q[1].rows.forEach(function (r) { var d = S.iso(new Date(r.at)); items.push({ kind: 'post', id: r.id, title: r.title || r.channel, start: d, end: d, status: r.status, channel: r.channel, platform: r.platform, at: r.at }); });
  q[2].rows.forEach(function (r) { items.push({ kind: 'event', id: r.id, title: r.name, start: r.starts_on, end: r.ends_on || r.starts_on, status: r.status, eventKind: r.kind, venue: r.venue }); });
  q[3].rows.forEach(function (r) { items.push({ kind: 'promotion', id: r.id, title: r.name, code: r.code, start: r.starts_on, end: r.ends_on || to, status: r.active ? 'active' : 'paused' }); });
  q[4].rows.forEach(function (r) { items.push({ kind: 'request', id: r.id, title: r.title, ref: 'MR-' + String(r.number).padStart(4, '0'), start: r.due_on, end: r.due_on, status: r.status, priority: r.priority, fromRoutine: !!r.routine_id }); });
  // Requests routines will make, on the day each will be needed.
  q[7].forEach(function (u) { items.push({ kind: 'routine', id: u.routine, title: u.title, start: u.due, end: u.due, comesOn: u.on, requestKind: u.kind, priority: u.priority }); });
  q[5].rows.forEach(function (r) { items.push({ kind: 'task', id: r.id, eventId: r.event_id, title: r.title, event: r.event_name, start: r.due_on, end: r.due_on, status: r.done ? 'done' : 'open' }); });
  q[6].rows.forEach(function (r) { items.push({ kind: 'holiday', title: r.name, start: r.date, end: r.date }); });
  var years = [];
  for (var y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) years.push(y);
  var holidayDates = new Set(q[6].rows.map(function (r) { return r.date; }));
  years.forEach(function (y) {
    moments(y).forEach(function (m) { if (m.date >= from && m.date <= to && !holidayDates.has(m.date)) items.push({ kind: 'moment', key: m.key, start: m.date, end: m.date }); });
  });
  var ORDER = ['holiday', 'moment', 'campaign', 'event', 'promotion', 'post', 'request', 'routine', 'task'];
  items.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind); });
  return { company: { code: co.code, name: co.name }, from: from, to: to, full: full, items: items };
}

module.exports = { home: home, calendar: calendar, _moments: moments, _easter: easter };
