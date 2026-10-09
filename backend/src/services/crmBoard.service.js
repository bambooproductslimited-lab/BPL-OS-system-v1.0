var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var crm = require('./crm.service');

// A sales rep's board: their leads, prospects and paying customers in three
// lanes, each card ranked by how much it needs the rep now. The score
// (0–100) is the sum of plain signals, each kept with its points so the
// card can say why it is where it is:
//
//   waiting          the customer wrote and nobody has answered (2 h on)
//   untouched        a new lead nobody has called yet
//   followup_overdue a follow-up date that has passed
//   followup_today   a follow-up date of today
//   quote_expiring   a quotation that runs out within 3 days
//   quote_waiting    a quotation sent 3+ days ago and not answered
//   negotiation      a prospect talking price — the closest to money
//   won_unpaid       a deal won whose money has not come in
//   overdue_invoice  a customer's invoice past its due date
//   quiet            a buying customer nobody has spoken to for 45 days
//   stuck            no move in its stage for 14 days
//   no_next_step     open, with no follow-up date planned
//   big_deal         a large open quotation (more for bigger amounts)
//   vip / referral   small boosts
//
// 55 and up is hot (act now), 25 and up warm (soon), the rest on track. The
// next action follows the strongest signal.
//
// What the rep did (calls, notes, replies, moves, quotations, wins) earns
// points, for a daily goal, a streak of days the goal was met, a level,
// badges for the week and the team's weekly ranking.

var WAIT_HOURS = 2;
var QUOTE_DAYS = 3;
var QUIET_DAYS = 45;
var STUCK_DAYS = 14;
var DAILY_GOAL = 60;
var POINTS = { call: 10, note: 5, reply: 8, logged: 8, contacted: 10, prospect: 25, won: 100, quote: 30 };
var LEVELS = [[0, 'starter'], [300, 'bronze'], [800, 'silver'], [1600, 'gold'], [3000, 'platinum']];
var NEXT = {
  waiting: 'reply', untouched: 'call', followup_overdue: 'call', followup_today: 'call', quote_expiring: 'chase_quote',
  quote_waiting: 'chase_quote', negotiation: 'close', won_unpaid: 'collect', overdue_invoice: 'collect', quiet: 'check_in',
  stuck: 'move_on', no_next_step: 'plan', big_deal: 'chase_quote'
};

function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function day(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function today() { return new Date().toISOString().slice(0, 10); }
function hoursSince(d) { return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 3600000)); }
function daysSince(d) { return Math.max(0, Math.floor((Date.now() - new Date(day(d) + 'T00:00:00Z').getTime()) / 86400000)); }
function round(n) { return Math.round(Number(n || 0) * 100) / 100; }
function personName(f, l) { return [f, l].filter(Boolean).join(' '); }
function dealPoints(v) { return v > 0 ? Math.min(20, Math.max(3, Math.round(Math.log10(v) * 5 - 10))) : 0; }

function card(base, signals) {
  signals.sort(function (a, b) { return b.points - a.points; });
  var score = Math.min(100, signals.reduce(function (a, s) { return a + s.points; }, 0));
  base.score = score;
  base.level = score >= 55 ? 'hot' : score >= 25 ? 'warm' : 'cool';
  base.signals = signals;
  base.next = signals.length ? (NEXT[signals[0].type] || 'touch') : 'touch';
  return base;
}

// Who the board is for: the rep (me), one rep, or everyone (managers).
async function scope(ctx, q) {
  var rep = (q && q.rep) || 'me';
  if (rep === 'me') {
    if (!ctx.employee) return { all: false, repId: null, rep: null };
    return { all: false, repId: ctx.employee.id, rep: { id: ctx.employee.id, name: personName(ctx.employee.first_name, ctx.employee.last_name), firstName: ctx.employee.first_name } };
  }
  need(ctx, 'crm.assign');
  if (rep === 'all') return { all: true, repId: null, rep: null };
  var e = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [rep])).rows[0];
  if (!e) fail('notfound', 'Sales rep not found.');
  return { all: false, repId: e.id, rep: { id: e.id, name: personName(e.first_name, e.last_name), firstName: e.first_name } };
}

// ── leads and prospects (crm_leads) ───────────────────────────────────
async function leadCards(sc) {
  var args = [];
  var where = "(l.stage IN ('new', 'contacted', 'follow_up', 'qualified', 'quote_sent', 'negotiation') OR (l.stage = 'won' AND NOT " + crm.PAID_SQL + '))';
  if (!sc.all) { args.push(sc.repId); where += ' AND l.rep_id = $' + args.length; }
  var rows = (await pool.query(
    'SELECT l.*, e.first_name AS rep_first, e.last_name AS rep_last, c.category AS customer_category, ' +
    "  (SELECT max(n.at) FROM crm_lead_notes n WHERE n.lead_id = l.id AND n.kind IN ('note', 'call')) AS last_touch, " +
    "  (SELECT json_build_object('body', n.body, 'at', n.at) FROM crm_lead_notes n WHERE n.lead_id = l.id AND n.kind IN ('note', 'call') ORDER BY n.at DESC LIMIT 1) AS last_note, " +
    "  q.quote_total, q.quote_currency, q.quote_sent, q.quote_until, q.quote_no, q.quote_id, " +
    "  w.id AS waiting_conv, w.channel AS waiting_channel, w.last_message_at AS waiting_at, w.last_preview AS waiting_preview " +
    'FROM crm_leads l LEFT JOIN employees e ON e.id = l.rep_id LEFT JOIN customers c ON c.id = l.customer_id ' +
    'LEFT JOIN LATERAL (SELECT x.grand_total AS quote_total, x.currency AS quote_currency, COALESCE(x.sent_at, x.created_at) AS quote_sent, x.valid_until AS quote_until, x.quote_no, x.id AS quote_id ' +
    "  FROM quotations x WHERE l.customer_id IS NOT NULL AND x.customer_id = l.customer_id AND x.status IN ('sent', 'viewed') " +
    '  AND (x.valid_until IS NULL OR x.valid_until >= CURRENT_DATE) ORDER BY x.grand_total DESC LIMIT 1) q ON true ' +
    'LEFT JOIN LATERAL (SELECT cv.id, cv.channel, cv.last_message_at, cv.last_preview FROM crm_conversations cv WHERE l.customer_id IS NOT NULL AND cv.customer_id = l.customer_id ' +
    "  AND cv.status = 'open' AND cv.last_direction = 'in' AND cv.last_message_at <= now() - make_interval(hours => " + WAIT_HOURS + ') ORDER BY cv.last_message_at LIMIT 1) w ON true ' +
    'WHERE ' + where + ' LIMIT 1500', args)).rows;
  var t = today();
  return rows.map(function (r) {
    var stage = r.stage;
    var phase = stage === 'won' ? 'prospect' : crm.LEAD_STAGES.indexOf(stage) >= 0 ? 'lead' : 'prospect';
    var s = [];
    if (r.waiting_conv) {
      var h = hoursSince(r.waiting_at);
      s.push({ type: 'waiting', points: 45 + Math.min(15, Math.floor(h / 6)), hours: h, channel: r.waiting_channel, preview: r.waiting_preview, conversationId: r.waiting_conv });
    }
    if (stage === 'new' && !r.last_touch) {
      var age = hoursSince(r.created_at < new Date(r.received_on) ? r.received_on : r.created_at);
      s.push({ type: 'untouched', points: 30 + Math.min(20, Math.floor(age / 6)), hours: age });
    }
    var fu = day(r.next_follow_up);
    if (fu && fu < t) s.push({ type: 'followup_overdue', points: 25 + Math.min(20, 3 * daysSince(fu)), days: daysSince(fu), on: fu });
    else if (fu === t) s.push({ type: 'followup_today', points: 22, on: fu });
    if (stage === 'won') s.push({ type: 'won_unpaid', points: 30 });
    if (stage === 'negotiation') s.push({ type: 'negotiation', points: 15 });
    if (r.quote_id) {
      var until = day(r.quote_until);
      var sentDays = daysSince(r.quote_sent);
      if (until && until <= day(new Date(Date.now() + 3 * 86400000))) s.push({ type: 'quote_expiring', points: 25, on: until, ref: r.quote_no, quotationId: r.quote_id });
      else if (sentDays >= QUOTE_DAYS) s.push({ type: 'quote_waiting', points: 20 + Math.min(10, sentDays - QUOTE_DAYS), days: sentDays, ref: r.quote_no, quotationId: r.quote_id });
      var dp = dealPoints(Number(r.quote_total));
      if (dp) s.push({ type: 'big_deal', points: dp, amount: round(r.quote_total), currency: r.quote_currency || 'GHS' });
    }
    var inStage = daysSince(r.stage_changed_at);
    if (inStage >= STUCK_DAYS && stage !== 'new') s.push({ type: 'stuck', points: 10 + Math.min(15, Math.floor((inStage - STUCK_DAYS) / 2)), days: inStage });
    if (!fu && stage !== 'new' && stage !== 'won') s.push({ type: 'no_next_step', points: 10 });
    if (/referr/i.test(r.source || '') && s.length) s.push({ type: 'referral', points: 5 });
    if (r.customer_category === 'vip' && s.length) s.push({ type: 'vip', points: 10 });
    return card({
      key: 'lead:' + r.id, lane: phase, kind: 'lead', id: r.id, leadId: r.id, customerId: r.customer_id || null,
      ref: r.ref, name: r.name, company: r.company || '', item: r.item || '', stage: stage, source: r.source || '',
      phone: r.phone || '', email: r.email || '', location: r.location || '',
      rep: r.rep_id ? { id: r.rep_id, name: personName(r.rep_first, r.rep_last) } : null,
      value: r.quote_total ? round(r.quote_total) : null, currency: r.quote_currency || 'GHS',
      nextFollowUp: fu, receivedOn: day(r.received_on), daysInStage: inStage,
      lastTouchAt: r.last_touch || null, lastNote: r.last_note || null
    }, s);
  });
}

// ── customers (paying, the rep's accounts) ────────────────────────────
// The CRM company's customers (the company chosen in the CRM settings, else
// Bamboo Products, whose older customers have no company set).
// Also the rep's profiles that say Lead or Prospect with no open lead
// behind them (someone who wrote in on WhatsApp, say): they go in the
// leads or prospects lane, so a message from them is not missed.
function customerScope(co, args) {
  if (!co.id) return 'true';
  args.push(co.id);
  return co.code === 'BPL' ? '(c.company_id IS NULL OR c.company_id = $' + args.length + ')' : 'c.company_id = $' + args.length;
}
async function customerCards(sc) {
  var args = [];
  var co = await crm._salesCompany(await crm._settingsRow());
  var where = "c.status = 'active' AND " + customerScope(co, args) + " AND (c.category IN ('active', 'vip') OR (c.category IN ('lead', 'prospect') AND NOT EXISTS (" +
    "SELECT 1 FROM crm_leads l WHERE l.customer_id = c.id AND (l.stage IN ('new', 'contacted', 'follow_up', 'qualified', 'quote_sent', 'negotiation') OR (l.stage = 'won' AND NOT " + crm.PAID_SQL + ')))))';
  if (!sc.all) { args.push(sc.repId); where += ' AND c.account_manager_id = $' + args.length; }
  var cust = (await pool.query(
    'SELECT c.*, e.first_name AS rep_first, e.last_name AS rep_last FROM customers c LEFT JOIN employees e ON e.id = c.account_manager_id WHERE ' + where + ' LIMIT 1500', args)).rows;
  if (!cust.length) return [];
  var ids = cust.map(function (c) { return c.id; });
  var q = await Promise.all([
    pool.query(
      "SELECT DISTINCT ON (customer_id) customer_id, id, channel, last_message_at, last_preview FROM crm_conversations WHERE customer_id = ANY($1) AND status = 'open' " +
      "AND last_direction = 'in' AND last_message_at <= now() - make_interval(hours => $2) ORDER BY customer_id, last_message_at", [ids, WAIT_HOURS]),
    pool.query(
      "SELECT customer_id, id, invoice_no, balance_due, currency, due_date FROM invoices WHERE customer_id = ANY($1) AND status NOT IN ('void', 'paid') " +
      'AND balance_due > 0 AND due_date < CURRENT_DATE ORDER BY due_date', [ids]),
    pool.query(
      "SELECT customer_id, id, quote_no, grand_total, currency, COALESCE(sent_at, created_at) AS sent, valid_until FROM quotations WHERE customer_id = ANY($1) " +
      "AND status IN ('sent', 'viewed') AND (valid_until IS NULL OR valid_until >= CURRENT_DATE) ORDER BY grand_total DESC", [ids]),
    pool.query("SELECT customer_id, max(issued_at) AS at, COALESCE(sum(grand_total), 0) AS lifetime FROM invoices WHERE customer_id = ANY($1) AND status <> 'void' GROUP BY customer_id", [ids]),
    pool.query("SELECT customer_id, max(last_message_at) AS at FROM crm_conversations WHERE customer_id = ANY($1) GROUP BY customer_id", [ids])
  ]);
  function first(rows) { var o = {}; rows.forEach(function (r) { if (!o[r.customer_id]) o[r.customer_id] = r; }); return o; }
  function all(rows) { var o = {}; rows.forEach(function (r) { (o[r.customer_id] = o[r.customer_id] || []).push(r); }); return o; }
  var waiting = first(q[0].rows), overdue = all(q[1].rows), quotes = first(q[2].rows), inv = first(q[3].rows), conv = first(q[4].rows);
  var t = today();
  return cust.map(function (c) {
    var paying = c.category === 'active' || c.category === 'vip';
    var s = [];
    var w = waiting[c.id];
    if (w) { var h = hoursSince(w.last_message_at); s.push({ type: 'waiting', points: 45 + Math.min(15, Math.floor(h / 6)), hours: h, channel: w.channel, preview: w.last_preview, conversationId: w.id }); }
    var od = overdue[c.id] || [];
    if (od.length) {
      var owed = od.reduce(function (a, i) { return a + Number(i.balance_due); }, 0);
      var oldest = daysSince(od[0].due_date);
      s.push({ type: 'overdue_invoice', points: 25 + Math.min(15, Math.floor(oldest / 3)) + Math.min(10, Math.round(dealPoints(owed) / 2)), days: oldest, amount: round(owed), currency: od[0].currency || 'GHS', ref: od[0].invoice_no, invoices: od.length, invoiceId: od[0].id });
    }
    var fu = day(c.follow_up_on);
    if (fu && fu < t) s.push({ type: 'followup_overdue', points: 25 + Math.min(20, 3 * daysSince(fu)), days: daysSince(fu), on: fu, note: c.follow_up_note || '' });
    else if (fu === t) s.push({ type: 'followup_today', points: 22, on: fu, note: c.follow_up_note || '' });
    var qt = quotes[c.id];
    if (qt) {
      var until = day(qt.valid_until);
      var sentDays = daysSince(qt.sent);
      if (until && until <= day(new Date(Date.now() + 3 * 86400000))) s.push({ type: 'quote_expiring', points: 25, on: until, ref: qt.quote_no, quotationId: qt.id });
      else if (sentDays >= QUOTE_DAYS) s.push({ type: 'quote_waiting', points: 20 + Math.min(10, sentDays - QUOTE_DAYS), days: sentDays, ref: qt.quote_no, quotationId: qt.id });
      var dp = dealPoints(Number(qt.grand_total));
      if (dp) s.push({ type: 'big_deal', points: dp, amount: round(qt.grand_total), currency: qt.currency || 'GHS' });
    }
    var touches = [c.last_contact_at, inv[c.id] && inv[c.id].at, conv[c.id] && conv[c.id].at].filter(Boolean).map(function (d) { return new Date(d).getTime(); });
    var last = touches.length ? Math.max.apply(null, touches) : null;
    var quietDays = last ? Math.floor((Date.now() - last) / 86400000) : null;
    if (paying && quietDays !== null && quietDays >= QUIET_DAYS && !w) s.push({ type: 'quiet', points: 15 + Math.min(15, Math.floor((quietDays - QUIET_DAYS) / 5)), days: quietDays, lastBought: inv[c.id] ? day(inv[c.id].at) : null });
    if (c.category === 'vip' && s.length) s.push({ type: 'vip', points: 10 });
    return card({
      key: 'customer:' + c.id, lane: paying ? 'customer' : c.category, kind: 'customer', id: c.id, leadId: null, customerId: c.id,
      ref: null, name: c.name, company: c.contact_person || '', item: '', stage: c.category, source: c.origin_channel || '',
      phone: c.phone || '', email: c.email || '', location: c.location || '',
      rep: c.account_manager_id ? { id: c.account_manager_id, name: personName(c.rep_first, c.rep_last) } : null,
      value: paying ? (inv[c.id] ? round(inv[c.id].lifetime) : null) : (qt ? round(qt.grand_total) : null), currency: paying ? 'GHS' : (qt && qt.currency) || 'GHS', vip: c.category === 'vip',
      nextFollowUp: fu, receivedOn: null, daysInStage: null,
      lastTouchAt: last ? new Date(last).toISOString() : null, lastNote: null, quietDays: quietDays
    }, s);
  });
}

// ── what the rep did: points, goal, streak, level, badges ─────────────
async function activity(repIds, days) {
  var since = new Date(Date.now() - days * 86400000);
  var rows = (await pool.query(
    "SELECT by_employee AS rep, (at AT TIME ZONE 'UTC')::date::text AS d, kind, to_stage, from_stage, NULL::uuid AS ref FROM crm_lead_notes " +
    'WHERE at >= $1 AND by_employee IS NOT NULL' + (repIds ? ' AND by_employee = ANY($2)' : '') + ' ' +
    "UNION ALL SELECT m.sent_by, (m.sent_at AT TIME ZONE 'UTC')::date::text, CASE WHEN cv.channel IN ('call', 'visit', 'other') THEN 'logged' ELSE 'reply' END, NULL, NULL, NULL " +
    "FROM crm_messages m JOIN crm_conversations cv ON cv.id = m.conversation_id WHERE m.direction = 'out' AND m.sent_by IS NOT NULL AND m.sent_at >= $1" + (repIds ? ' AND m.sent_by = ANY($2)' : '') + ' ' +
    "UNION ALL SELECT created_by, (created_at AT TIME ZONE 'UTC')::date::text, 'quote', NULL, NULL, NULL FROM quotations WHERE created_by IS NOT NULL AND created_at >= $1" + (repIds ? ' AND created_by = ANY($2)' : ''),
    repIds ? [since, repIds] : [since])).rows;
  return rows.map(function (r) {
    var pts = 0, what = r.kind;
    if (r.kind === 'call') pts = POINTS.call;
    else if (r.kind === 'note') pts = POINTS.note;
    else if (r.kind === 'reply') pts = POINTS.reply;
    else if (r.kind === 'logged') pts = POINTS.logged;
    else if (r.kind === 'quote') pts = POINTS.quote;
    else if (r.kind === 'stage') {
      if (r.to_stage === 'won') { pts = POINTS.won; what = 'won'; }
      else if (crm.PROSPECT_STAGES.indexOf(r.to_stage) >= 0 && crm.LEAD_STAGES.indexOf(r.from_stage) >= 0) { pts = POINTS.prospect; what = 'prospect'; }
      else if (r.to_stage === 'contacted' && r.from_stage === 'new') { pts = POINTS.contacted; what = 'contacted'; }
      else what = 'move';
    }
    return { rep: r.rep, d: r.d, what: what, points: pts };
  });
}

function weekStart() { var d = new Date(today() + 'T00:00:00Z'); var dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); }

async function progress(sc, lanes) {
  var t = today(), ws = weekStart();
  var mine = sc.repId ? await activity([sc.repId], 60) : [];
  var byDay = {};
  mine.forEach(function (a) { byDay[a.d] = (byDay[a.d] || 0) + a.points; });
  var todayPts = byDay[t] || 0;
  // Days in a row the goal was met: today counts once it is met, and a day
  // not yet met today does not break yesterday's run.
  var streak = 0;
  var d = new Date(t + 'T00:00:00Z');
  if ((byDay[t] || 0) < DAILY_GOAL) d.setUTCDate(d.getUTCDate() - 1);
  while ((byDay[d.toISOString().slice(0, 10)] || 0) >= DAILY_GOAL && streak < 60) { streak++; d.setUTCDate(d.getUTCDate() - 1); }
  var week = mine.filter(function (a) { return a.d >= ws; });
  var weekPts = week.reduce(function (a, x) { return a + x.points; }, 0);
  var month = mine.filter(function (a) { return a.d >= day(new Date(Date.now() - 30 * 86400000)); }).reduce(function (a, x) { return a + x.points; }, 0);
  var level = LEVELS[0], nextLevel = LEVELS[1];
  LEVELS.forEach(function (l, i) { if (month >= l[0]) { level = l; nextLevel = LEVELS[i + 1] || null; } });
  function count(list, what) { return list.filter(function (a) { return a.what === what; }).length; }
  var todayList = mine.filter(function (a) { return a.d === t; });
  var badges = [];
  if (count(week, 'won')) badges.push({ key: 'closer', n: count(week, 'won') });
  if (count(week, 'prospect') >= 3) badges.push({ key: 'hunter', n: count(week, 'prospect') });
  if (count(week, 'call') + count(week, 'logged') >= 15) badges.push({ key: 'dialer', n: count(week, 'call') + count(week, 'logged') });
  if (count(week, 'reply') >= 10) badges.push({ key: 'responder', n: count(week, 'reply') });
  if (streak >= 3) badges.push({ key: 'streak', n: streak });
  var hotLeft = lanes.filter(function (c) { return c.level === 'hot'; }).length;
  if (sc.repId && !hotLeft && (lanes.length > 0)) badges.push({ key: 'clear', n: 0 });

  // The team's week, everyone who worked the CRM.
  var team = await activity(null, 8);
  var pts = {};
  team.filter(function (a) { return a.d >= ws; }).forEach(function (a) {
    var p = pts[a.rep] || (pts[a.rep] = { points: 0, wins: 0 });
    p.points += a.points; if (a.what === 'won') p.wins++;
  });
  var repIds = Object.keys(pts);
  var names = repIds.length ? (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = ANY($1)', [repIds])).rows : [];
  var board = names.map(function (e) { return { id: e.id, name: personName(e.first_name, e.last_name), points: pts[e.id].points, wins: pts[e.id].wins }; })
    .filter(function (x) { return x.points > 0; }).sort(function (a, b) { return b.points - a.points || a.name.localeCompare(b.name); });
  var rank = sc.repId ? board.findIndex(function (x) { return x.id === sc.repId; }) : -1;

  return {
    goal: DAILY_GOAL, today: todayPts,
    todayDone: { calls: count(todayList, 'call') + count(todayList, 'logged'), replies: count(todayList, 'reply'), notes: count(todayList, 'note'),
      moves: count(todayList, 'prospect') + count(todayList, 'contacted') + count(todayList, 'move'), quotes: count(todayList, 'quote'), wins: count(todayList, 'won') },
    streak: streak, week: weekPts, weekWins: count(week, 'won'), month: month,
    weekDone: { calls: count(week, 'call') + count(week, 'logged'), replies: count(week, 'reply'), prospects: count(week, 'prospect'), wins: count(week, 'won'), quotes: count(week, 'quote') },
    level: { key: level[1], from: level[0], next: nextLevel ? { key: nextLevel[1], at: nextLevel[0] } : null },
    days: Array.from({ length: 7 }, function (_, i) { var x = new Date(t + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 6 + i); var k = x.toISOString().slice(0, 10); return { day: k, points: byDay[k] || 0 }; }),
    badges: badges,
    leaderboard: board.slice(0, 6), rank: rank >= 0 ? rank + 1 : null, of: board.length,
    points: POINTS
  };
}

async function board(ctx, q) {
  need(ctx, 'crm.read');
  var sc = await scope(ctx, q || {});
  var cards = sc.all || sc.repId ? (await leadCards(sc)).concat(await customerCards(sc)) : [];
  var byScore = function (a, b) { return b.score - a.score || String(a.nextFollowUp || '9').localeCompare(String(b.nextFollowUp || '9')) || a.name.localeCompare(b.name); };
  var lanes = { lead: [], prospect: [], customer: [] };
  cards.forEach(function (c) { lanes[c.lane].push(c); });
  Object.keys(lanes).forEach(function (k) { lanes[k].sort(byScore); lanes[k].forEach(function (c, i) { c.rank = i + 1; }); });
  function laneInfo(list) {
    return {
      total: list.length, hot: list.filter(function (c) { return c.level === 'hot'; }).length, warm: list.filter(function (c) { return c.level === 'warm'; }).length,
      value: round(list.reduce(function (a, c) { return a + (c.lane === 'customer' ? 0 : c.value || 0); }, 0))
    };
  }
  var focus = cards.filter(function (c) { return c.level !== 'cool'; }).sort(byScore).slice(0, 3);
  return {
    rep: sc.rep, all: sc.all, canAssign: ctx.can('crm.assign'), canManage: ctx.can('crm.manage'),
    lanes: lanes, counts: { lead: laneInfo(lanes.lead), prospect: laneInfo(lanes.prospect), customer: laneInfo(lanes.customer) },
    focus: focus,
    progress: await progress(sc, cards),
    reps: ctx.can('crm.assign') ? (await pool.query(
      "SELECT DISTINCT e.id, e.first_name, e.last_name FROM employees e WHERE e.status = 'active' AND (EXISTS (SELECT 1 FROM crm_leads l WHERE l.rep_id = e.id) " +
      'OR EXISTS (SELECT 1 FROM customers c WHERE c.account_manager_id = e.id)) ORDER BY e.first_name, e.last_name')).rows.map(function (e) { return { id: e.id, name: personName(e.first_name, e.last_name) }; }) : []
  };
}

// Just the day's points, streak and team ranking (the follow-ups page's
// banner), without ranking every lead and customer.
async function myDay(ctx, q) {
  need(ctx, 'crm.read');
  var sc = await scope(ctx, q || {});
  return Object.assign({ rep: sc.rep }, await progress(sc, []));
}

module.exports = { board: board, myDay: myDay, DAILY_GOAL: DAILY_GOAL, POINTS: POINTS };
