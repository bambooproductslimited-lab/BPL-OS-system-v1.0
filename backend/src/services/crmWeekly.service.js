var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var crm = require('./crm.service');
var executive = require('./crmExecutive.service');

// The Saturday sales review: one week, Monday to Sunday, as the sales team
// presents it at the Saturday meeting (pages/crm/SalesPresent.jsx).
//
// New leads first, since that is what the meeting asks about most: every
// lead that came in that week (crm_leads.received_on), and the people who
// messaged the inbox for the first time that week and are not on the leads
// list yet — a profile the inbox made for them (customers.source 'crm'),
// counted from their first message, so chats brought in from older history
// are not counted as new. Where the leads came from, who has them, what
// they asked for, which day, and whether anyone has answered them.
//
// Then what moved: leads that became prospects (qualified, quoted or
// agreeing terms), were won or lost that week, from the stage history
// (crm_lead_notes). The money: sales, money in, quotations and new buyers
// against the week before (crmExecutive.service.js money, the CRM
// company's GHS invoices). Site visits, the team side by side, and what is
// due next week.

var LEAD_STAGES = crm.LEAD_STAGES;
var PROSPECT_STAGES = crm.PROSPECT_STAGES;
var OPEN_STAGES = crm.OPEN_STAGES;
var TREND_WEEKS = 8;

function r2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dateOnly(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function personName(first, last) { return [first, last].filter(Boolean).join(' '); }
// The Monday of the week a day falls in.
function monday(iso) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function countBy(list, key) {
  var m = new Map();
  list.forEach(function (x) { var k = key(x); m.set(k, (m.get(k) || 0) + 1); });
  return Array.from(m.entries()).map(function (e) { return { key: e[0], n: e[1] }; }).sort(function (a, b) { return b.n - a.n || String(a.key).localeCompare(String(b.key)); });
}

// Answered: the lead has moved on from New, or someone has written a note or
// logged a call on it.
var CONTACTED_SQL = "(l.stage <> 'new' OR EXISTS (SELECT 1 FROM crm_lead_notes cn WHERE cn.lead_id = l.id AND cn.kind IN ('note', 'call')))";

async function leadsIn(from, to) {
  var rows = (await pool.query(
    'SELECT l.id, l.ref, l.received_on, l.created_at, l.name, l.company, l.location, l.source, l.item, l.stage, l.next_follow_up, l.rep_id, l.rep_name, l.customer_id, ' +
    '  e.first_name AS rep_first, e.last_name AS rep_last, ' + CONTACTED_SQL + ' AS contacted, ' + crm.PAID_SQL + ' AS paid ' +
    'FROM crm_leads l LEFT JOIN employees e ON e.id = l.rep_id WHERE l.received_on BETWEEN $1 AND $2 ORDER BY l.received_on, l.created_at', [from, to])).rows;
  return rows.map(function (r) {
    return {
      id: r.id, ref: r.ref, receivedOn: dateOnly(r.received_on), name: r.name, company: r.company, location: r.location,
      source: r.source || '', item: r.item || '', stage: r.stage, phase: crm.phaseOf(r.stage, !!r.paid),
      nextFollowUp: dateOnly(r.next_follow_up), repId: r.rep_id, repName: r.rep_id ? personName(r.rep_first, r.rep_last) : (r.rep_name || null),
      customerId: r.customer_id, contacted: !!r.contacted
    };
  });
}

// People who wrote to the inbox for the first time in the period and are not
// on the leads list.
async function inboxFirsts(from, to) {
  var rows = (await pool.query(
    'WITH firsts AS (' +
    '  SELECT c.id, c.name, c.origin_channel, c.category, c.account_manager_id, min(m.sent_at) AS first_in ' +
    '  FROM customers c JOIN crm_conversations v ON v.customer_id = c.id AND v.status <> \'spam\' ' +
    "  JOIN crm_messages m ON m.conversation_id = v.id AND m.direction = 'in' " +
    "  WHERE c.source = 'crm' AND c.origin_channel <> '' AND NOT EXISTS (SELECT 1 FROM crm_leads l WHERE l.customer_id = c.id) " +
    '  GROUP BY c.id) ' +
    'SELECT f.*, e.first_name AS rep_first, e.last_name AS rep_last, ' +
    "  EXISTS (SELECT 1 FROM crm_conversations v2 JOIN crm_messages o ON o.conversation_id = v2.id AND o.direction = 'out' WHERE v2.customer_id = f.id) AS answered " +
    'FROM firsts f LEFT JOIN employees e ON e.id = f.account_manager_id ' +
    'WHERE f.first_in >= $1::date AND f.first_in < ($2::date + 1) ORDER BY f.first_in', [from, to])).rows;
  return rows.map(function (r) {
    return {
      customerId: r.id, name: r.name, channel: r.origin_channel, category: r.category, firstAt: r.first_in, receivedOn: dateOnly(r.first_in),
      repId: r.account_manager_id, repName: r.account_manager_id ? personName(r.rep_first, r.rep_last) : null, answered: !!r.answered
    };
  });
}

// Stage changes in the period: who became a prospect, who was won or lost.
async function moves(from, to) {
  var rows = (await pool.query(
    'SELECT n.lead_id, n.from_stage, n.to_stage, n.at, l.ref, l.name, l.company, l.item, l.source, l.rep_id, l.rep_name, l.lost_reason, l.stage AS now_stage, ' +
    '  e.first_name AS rep_first, e.last_name AS rep_last, ' +
    '  (SELECT coalesce(sum(i.grand_total - i.credit_total), 0) FROM crm_deals d JOIN invoices i ON i.id = d.invoice_id WHERE d.lead_id = l.id AND i.status <> \'void\') AS deal_value ' +
    'FROM crm_lead_notes n JOIN crm_leads l ON l.id = n.lead_id LEFT JOIN employees e ON e.id = l.rep_id ' +
    "WHERE n.kind = 'stage' AND n.to_stage IS NOT NULL AND n.at >= $1::date AND n.at < ($2::date + 1) ORDER BY n.at", [from, to])).rows;
  function lead(r) {
    return {
      id: r.lead_id, ref: r.ref, name: r.name, company: r.company, item: r.item || '', source: r.source || '', at: r.at, stage: r.now_stage,
      repId: r.rep_id, repName: r.rep_id ? personName(r.rep_first, r.rep_last) : (r.rep_name || null), dealValue: r2(r.deal_value)
    };
  }
  var prospects = new Map(), won = new Map(), lost = new Map();
  rows.forEach(function (r) {
    var cameFromLead = !r.from_stage || LEAD_STAGES.indexOf(r.from_stage) >= 0;
    if (PROSPECT_STAGES.indexOf(r.to_stage) >= 0 && cameFromLead && !prospects.has(r.lead_id)) prospects.set(r.lead_id, lead(r));
    if (r.to_stage === 'won') { won.delete(r.lead_id); won.set(r.lead_id, lead(r)); }
    if (r.to_stage === 'lost') lost.set(r.lead_id, Object.assign(lead(r), { reason: r.lost_reason || '' }));
  });
  // A lead won later in the same week is counted as won, not twice.
  won.forEach(function (_, id) { lost.delete(id); });
  lost.forEach(function (x, id) { if (x.stage !== 'lost') lost.delete(id); });
  return { prospects: Array.from(prospects.values()), won: Array.from(won.values()), lost: Array.from(lost.values()) };
}

async function week(ctx, query) {
  if (!ctx.can('crm.read')) fail('forbidden', 'Your role does not allow this action (crm.read).');
  query = query || {};
  var today = todayISO();
  var from = monday(query.from ? V.date(query.from, 'Week') : today);
  var to = addDays(from, 6);
  var prev = { from: addDays(from, -7), to: addDays(from, -1) };
  var next = { from: addDays(from, 7), to: addDays(from, 13) };
  var co = await crm._salesCompany(await crm._settingsRow());

  // ── new leads ──────────────────────────────────────────────────────
  var list = await leadsIn(from, to);
  var inbox = await inboxFirsts(from, to);
  var trendFrom = addDays(from, -7 * (TREND_WEEKS - 1));
  var past = (await pool.query('SELECT received_on FROM crm_leads WHERE received_on BETWEEN $1 AND $2', [trendFrom, to])).rows.map(function (r) { return dateOnly(r.received_on); });
  var pastInbox = (await inboxFirsts(trendFrom, to)).map(function (x) { return x.receivedOn; });
  var weeks = [];
  for (var w = 0; w < TREND_WEEKS; w++) {
    var wf = addDays(trendFrom, 7 * w), wt = addDays(wf, 6);
    var inW = function (d) { return d >= wf && d <= wt; };
    weeks.push({ from: wf, leads: past.filter(inW).length, inbox: pastInbox.filter(inW).length });
  }
  var before = weeks[TREND_WEEKS - 2];
  var earlier = weeks.slice(TREND_WEEKS - 5, TREND_WEEKS - 1);
  var average = r2(earlier.reduce(function (a, x) { return a + x.leads + x.inbox; }, 0) / earlier.length);

  var days = [];
  for (var i = 0; i < 7; i++) {
    var d = addDays(from, i);
    days.push({ date: d, leads: list.filter(function (l) { return l.receivedOn === d; }).length, inbox: inbox.filter(function (x) { return x.receivedOn === d; }).length });
  }
  var open = list.filter(function (l) { return OPEN_STAGES.indexOf(l.stage) >= 0; });
  var sources = countBy(list, function (l) { return l.source || ''; }).map(function (x) { return { source: x.key, n: x.n }; });
  var channels = countBy(inbox, function (x) { return x.channel; }).map(function (x) { return { channel: x.key, n: x.n }; });
  var items = countBy(list.filter(function (l) { return l.item.trim(); }), function (l) { return l.item.trim().toLowerCase(); })
    .slice(0, 6).map(function (x) { return { item: list.find(function (l) { return l.item.trim().toLowerCase() === x.key; }).item.trim(), n: x.n }; });
  var stages = countBy(list, function (l) { return l.phase; }).map(function (x) { return { phase: x.key, n: x.n }; });

  // ── what moved ─────────────────────────────────────────────────────
  var moved = await moves(from, to);
  var reasons = countBy(moved.lost, function (x) { return x.reason.trim() || ''; }).map(function (x) { return { reason: x.key, n: x.n }; });

  // ── the money ──────────────────────────────────────────────────────
  var money = await executive._money(co, from, to);
  var moneyBefore = await executive._money(co, prev.from, prev.to);

  // ── site visits ────────────────────────────────────────────────────
  var visitRows = (await pool.query(
    "SELECT id, client, location, scheduled_on, status FROM crm_site_visits WHERE status <> 'cancelled' AND scheduled_on BETWEEN $1 AND $2 ORDER BY scheduled_on",
    [from, next.to])).rows.map(function (v) { return { id: v.id, client: v.client, location: v.location, date: dateOnly(v.scheduled_on), status: v.status }; });
  var visits = {
    done: visitRows.filter(function (v) { return v.date <= to && v.status === 'visited'; }).length,
    planned: visitRows.filter(function (v) { return v.date <= to; }).length,
    nextWeek: visitRows.filter(function (v) { return v.date >= next.from; })
  };

  // ── follow-ups ─────────────────────────────────────────────────────
  var fu = (await pool.query(
    'SELECT count(*) FILTER (WHERE next_follow_up < $2)::int AS overdue, count(*) FILTER (WHERE next_follow_up BETWEEN $3 AND $4)::int AS next_week, ' +
    '  count(*) FILTER (WHERE next_follow_up IS NULL)::int AS none ' +
    'FROM crm_leads WHERE stage = ANY($1)', [OPEN_STAGES, today, next.from, next.to])).rows[0];
  var qx = { args: [] };
  function p(v) { qx.args.push(v); return '$' + qx.args.length; }
  var expiring = (await pool.query(
    "SELECT count(*)::int AS n, coalesce(sum(q.grand_total), 0) AS v FROM quotations q JOIN customers c ON c.id = q.customer_id " +
    "WHERE q.status IN ('sent', 'viewed') AND q.currency = 'GHS' AND q.valid_until BETWEEN " + p(next.from) + ' AND ' + p(next.to) + ' AND ' + executive._quoteScope(co, p), qx.args)).rows[0];

  // ── the team ───────────────────────────────────────────────────────
  var people = new Map();
  function rep(id, name) {
    if (!id) return null;
    if (!people.has(id)) people.set(id, { repId: id, name: name || null, newLeads: 0, contacted: 0, inbox: 0, prospects: 0, won: 0, sales: 0, cash: 0 });
    var r = people.get(id);
    if (!r.name && name) r.name = name;
    return r;
  }
  list.forEach(function (l) { var r = rep(l.repId, l.repName); if (r) { r.newLeads++; if (l.contacted) r.contacted++; } });
  inbox.forEach(function (x) { var r = rep(x.repId, x.repName); if (r) r.inbox++; });
  moved.prospects.forEach(function (l) { var r = rep(l.repId, l.repName); if (r) r.prospects++; });
  moved.won.forEach(function (l) { var r = rep(l.repId, l.repName); if (r) r.won++; });
  var S = executive._sql;
  var qs = { args: [] };
  function ps(v) { qs.args.push(v); return '$' + qs.args.length; }
  (await pool.query(
    'SELECT ' + S.REP + ' AS rep_id, sum(i.grand_total - i.credit_total) AS sales ' + S.FROM_INV +
    'WHERE ' + S.SALE + ' AND i.issued_at BETWEEN ' + ps(from) + ' AND ' + ps(to) + ' AND ' + crm._invoiceScope(co, ps) + ' GROUP BY 1', qs.args)).rows
    .forEach(function (x) { var r = rep(x.rep_id); if (r) r.sales = r2(x.sales); });
  var qc = { args: [] };
  function pc(v) { qc.args.push(v); return '$' + qc.args.length; }
  (await pool.query(
    'SELECT ' + S.REP + ' AS rep_id, sum(p.amount) AS cash FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id LEFT JOIN sales_orders so ON so.id = i.sales_order_id ' +
    'WHERE ' + S.SALE + ' AND p.date BETWEEN ' + pc(from) + ' AND ' + pc(to) + ' AND ' + crm._invoiceScope(co, pc) + ' GROUP BY 1', qc.args)).rows
    .forEach(function (x) { var r = rep(x.rep_id); if (r) r.cash = r2(x.cash); });
  var unnamed = Array.from(people.values()).filter(function (r) { return !r.name; }).map(function (r) { return r.repId; });
  if (unnamed.length) {
    (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = ANY($1::uuid[])', [unnamed])).rows
      .forEach(function (e) { people.get(e.id).name = personName(e.first_name, e.last_name); });
  }
  var team = Array.from(people.values()).filter(function (r) { return r.name; })
    .sort(function (a, b) { return (b.newLeads + b.inbox) - (a.newLeads + a.inbox) || b.won - a.won || b.sales - a.sales || a.name.localeCompare(b.name); });

  return {
    week: { from: from, to: to }, previous: prev, next: next, company: co.name,
    leads: {
      total: list.length + inbox.length, listed: list.length, fromInbox: inbox.length,
      before: before.leads + before.inbox, average: average,
      contacted: list.filter(function (l) { return l.contacted; }).length + inbox.filter(function (x) { return x.answered; }).length,
      notContacted: list.filter(function (l) { return !l.contacted; }).length + inbox.filter(function (x) { return !x.answered; }).length,
      noRep: list.filter(function (l) { return !l.repName; }).length,
      noFollowUp: open.filter(function (l) { return !l.nextFollowUp; }).length,
      prospectsAlready: list.filter(function (l) { return l.phase !== 'lead' && l.phase !== 'lost'; }).length,
      days: days, weeks: weeks, sources: sources, channels: channels, items: items, phases: stages,
      list: list, inbox: inbox
    },
    moved: { prospects: moved.prospects, won: moved.won, lost: moved.lost, lostReasons: reasons },
    money: money, moneyBefore: moneyBefore,
    visits: visits,
    followUps: { overdue: fu.overdue, nextWeek: fu.next_week, none: fu.none },
    quotesExpiringNextWeek: { n: expiring.n, value: r2(expiring.v) },
    team: team
  };
}

module.exports = { week: week, _monday: monday };
