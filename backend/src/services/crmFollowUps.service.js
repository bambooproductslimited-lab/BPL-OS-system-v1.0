/*
 * Who needs a follow-up, and why — what a sales rep sees when they sign in.
 *
 * For each of the rep's customers, any of:
 *   waiting   — wrote on a channel and nobody has answered yet (2 hours on);
 *   planned   — a follow-up date set on the profile has come;
 *   overdue   — an invoice past its due date with money still owed;
 *   quote     — a quotation sent 3+ days ago with no answer, or one about to
 *               expire;
 *   lead      — a lead of theirs whose follow-up date has come;
 *   quiet     — a buying customer (active or VIP) nobody has been in touch
 *               with for 45 days.
 * Plus the rep's own leads with a follow-up due that aren't on a profile yet.
 * Each comes with the customer's details and the next step to take.
 */
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { bplScopeClause } = require('../utils/documents');

var WAIT_HOURS = 2;
var QUOTE_DAYS = 3;
var QUIET_DAYS = 45;
var CHANNEL_NAME = { whatsapp: 'WhatsApp', email: 'email', instagram: 'Instagram', facebook: 'Facebook', sms: 'SMS', call: 'a call', visit: 'a visit', other: 'a message' };
var ORDER = { waiting: 1, planned: 2, overdue: 3, quote: 4, lead: 5, quiet: 6 };

function day(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function daysSince(d) { return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)); }
function hoursSince(d) { return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 3600000)); }
function money(n, cur) { return (cur || 'GHS') + ' ' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// The reasons, for the customers matching `where` (on customers c).
async function reasonsWhere(where, args) {
  var cust = (await pool.query(
    "SELECT c.*, e.first_name AS rep_first, e.last_name AS rep_last FROM customers c LEFT JOIN employees e ON e.id = c.account_manager_id " +
    "WHERE c.status = 'active' AND " + bplScopeClause('c') + ' AND ' + where, args)).rows;
  if (!cust.length) return [];
  var ids = cust.map(function (c) { return c.id; });
  var q = await Promise.all([
    pool.query(
      "SELECT DISTINCT ON (customer_id) customer_id, id, channel, last_message_at, last_preview FROM crm_conversations " +
      "WHERE customer_id = ANY($1) AND status = 'open' AND last_direction = 'in' AND last_message_at <= now() - make_interval(hours => $2) ORDER BY customer_id, last_message_at", [ids, WAIT_HOURS]),
    pool.query(
      "SELECT customer_id, invoice_no, id, balance_due, currency, due_date FROM invoices WHERE customer_id = ANY($1) AND status NOT IN ('void', 'paid') " +
      "AND balance_due > 0 AND due_date < CURRENT_DATE ORDER BY due_date", [ids]),
    pool.query(
      "SELECT customer_id, quote_no, id, grand_total, currency, sent_at, valid_until FROM quotations WHERE customer_id = ANY($1) AND status IN ('sent', 'viewed') " +
      "AND (valid_until IS NULL OR valid_until >= CURRENT_DATE) AND (COALESCE(sent_at, created_at) <= now() - make_interval(days => $2) OR valid_until <= CURRENT_DATE + 3) ORDER BY sent_at", [ids, QUOTE_DAYS]),
    pool.query(
      "SELECT customer_id, ref, id, item, next_follow_up FROM crm_leads WHERE customer_id = ANY($1) AND stage NOT IN ('won', 'lost') AND next_follow_up <= CURRENT_DATE ORDER BY next_follow_up", [ids]),
    pool.query("SELECT customer_id, max(issued_at) AS at FROM invoices WHERE customer_id = ANY($1) AND status <> 'void' GROUP BY customer_id", [ids]),
    pool.query(
      "SELECT DISTINCT ON (cv.customer_id) cv.customer_id, cv.channel, cv.id, cv.last_message_at, cv.last_direction, cv.last_preview FROM crm_conversations cv " +
      "WHERE cv.customer_id = ANY($1) ORDER BY cv.customer_id, cv.last_message_at DESC NULLS LAST", [ids]),
    pool.query("SELECT customer_id, kind, value, label FROM customer_identities WHERE customer_id = ANY($1) ORDER BY kind", [ids]),
    pool.query("SELECT customer_id, COALESCE(sum(grand_total), 0) AS lifetime, COALESCE(sum(balance_due), 0) AS outstanding FROM invoices WHERE customer_id = ANY($1) AND status <> 'void' GROUP BY customer_id", [ids]),
    pool.query(
      "SELECT x.customer_id, li.description, count(*)::int AS n FROM document_line_items li " +
      "JOIN (SELECT id, customer_id, 'invoice' AS t FROM invoices WHERE customer_id = ANY($1) AND status <> 'void' UNION ALL SELECT id, customer_id, 'quotation' FROM quotations WHERE customer_id = ANY($1)) x " +
      "  ON x.id = li.document_id AND x.t = li.document_type GROUP BY x.customer_id, li.description ORDER BY count(*) DESC", [ids])
  ]);
  function by(rows) { var o = {}; rows.forEach(function (r) { (o[r.customer_id] = o[r.customer_id] || []).push(r); }); return o; }
  var waiting = by(q[0].rows), overdue = by(q[1].rows), quotes = by(q[2].rows), leads = by(q[3].rows), lastInv = by(q[4].rows),
    lastConv = by(q[5].rows), idents = by(q[6].rows), totals = by(q[7].rows), lines = by(q[8].rows);

  var out = [];
  cust.forEach(function (c) {
    var reasons = [];
    (waiting[c.id] || []).forEach(function (w) {
      var h = hoursSince(w.last_message_at);
      reasons.push({ type: 'waiting', at: w.last_message_at, conversationId: w.id, channel: w.channel, hours: h, preview: w.last_preview,
        text: 'Wrote on ' + CHANNEL_NAME[w.channel] + ' ' + (h < 48 ? h + ' hours' : Math.floor(h / 24) + ' days') + ' ago and is waiting for a reply: "' + w.last_preview + '"' });
    });
    if (c.follow_up_on && day(c.follow_up_on) <= new Date().toISOString().slice(0, 10)) {
      var late = daysSince(c.follow_up_on);
      reasons.push({ type: 'planned', at: c.follow_up_on, on: day(c.follow_up_on), late: late, note: c.follow_up_note || '', text: (late ? 'Follow-up was planned for ' + day(c.follow_up_on) + ' (' + late + ' days ago)' : 'Follow-up planned for today') + (c.follow_up_note ? ': ' + c.follow_up_note : '') });
    }
    (overdue[c.id] || []).forEach(function (i) {
      reasons.push({ type: 'overdue', at: i.due_date, invoiceId: i.id, ref: i.invoice_no, amount: Number(i.balance_due), currency: i.currency, days: daysSince(i.due_date), text: 'Invoice ' + i.invoice_no + ': ' + money(i.balance_due, i.currency) + ' overdue by ' + daysSince(i.due_date) + ' days' });
    });
    (quotes[c.id] || []).forEach(function (x) {
      var exp = x.valid_until && day(x.valid_until) <= new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      reasons.push({ type: 'quote', at: x.sent_at, quotationId: x.id, ref: x.quote_no, amount: Number(x.grand_total), currency: x.currency,
        sentDays: x.sent_at ? daysSince(x.sent_at) : null, expires: exp ? day(x.valid_until) : null,
        text: 'Quotation ' + x.quote_no + ' (' + money(x.grand_total, x.currency) + ')' + (x.sent_at ? ' sent ' + daysSince(x.sent_at) + ' days ago' : '') + ', no answer yet' + (exp ? '; it expires on ' + day(x.valid_until) : '') });
    });
    (leads[c.id] || []).forEach(function (l) {
      reasons.push({ type: 'lead', at: l.next_follow_up, leadId: l.id, ref: l.ref, item: l.item || '', due: day(l.next_follow_up), text: 'Lead ' + l.ref + (l.item ? ' (' + l.item + ')' : '') + ': follow-up due ' + day(l.next_follow_up) });
    });
    if ((c.category === 'active' || c.category === 'vip') && !reasons.length) {
      var lastTouch = [c.last_contact_at, lastInv[c.id] && lastInv[c.id][0].at].filter(Boolean).map(function (d) { return new Date(d).getTime(); });
      var last = lastTouch.length ? Math.max.apply(null, lastTouch) : null;
      if (last && Date.now() - last > QUIET_DAYS * 86400000) {
        reasons.push({ type: 'quiet', at: new Date(last), days: daysSince(last), lastBought: lastInv[c.id] ? day(lastInv[c.id][0].at) : null, text: 'No contact for ' + daysSince(last) + ' days' + (lastInv[c.id] ? ' — last bought on ' + day(lastInv[c.id][0].at) : '') });
      }
    }
    if (!reasons.length) return;
    reasons.sort(function (a, b) { return ORDER[a.type] - ORDER[b.type]; });
    var lc = lastConv[c.id] && lastConv[c.id][0];
    var t = totals[c.id] && totals[c.id][0];
    out.push({
      customer: {
        id: c.id, name: c.name, contactPerson: c.contact_person, phone: c.phone, email: c.email, location: c.location || '', category: c.category, notes: c.notes,
        rep: c.account_manager_id ? { id: c.account_manager_id, name: c.rep_first + ' ' + c.rep_last } : null,
        identities: (idents[c.id] || []).map(function (i) { return { kind: i.kind, value: i.value, label: i.label }; }),
        lastMessage: lc && lc.last_message_at ? { channel: lc.channel, conversationId: lc.id, at: lc.last_message_at, direction: lc.last_direction, preview: lc.last_preview } : null,
        lifetime: t ? Number(t.lifetime) : 0, outstanding: t ? Number(t.outstanding) : 0,
        interests: (lines[c.id] || []).slice(0, 3).map(function (l) { return l.description; }),
        followUpOn: day(c.follow_up_on), followUpNote: c.follow_up_note || ''
      },
      lead: null, reasons: reasons, top: reasons[0].type, nextStep: nextStep(reasons[0], c)
    });
  });
  out.sort(function (a, b) { return ORDER[a.top] - ORDER[b.top] || new Date(a.reasons[0].at || 0) - new Date(b.reasons[0].at || 0); });
  return out;
}

function nextStep(r, c) {
  if (r.type === 'waiting') return 'Reply on ' + CHANNEL_NAME[r.channel] + ' — they are waiting.';
  if (r.type === 'planned') return c.follow_up_note ? c.follow_up_note : 'Get in touch as planned, then set the next date or mark it done.';
  if (r.type === 'overdue') return 'Remind them about the payment and agree a date.';
  if (r.type === 'quote') return 'Ask if the quotation works for them and answer any questions.';
  if (r.type === 'lead') return 'Move the lead on: call, then update its stage.';
  return 'Check in: ask how the last order is doing and share what is new.';
}

// The rep's own leads with a follow-up due that aren't on a profile.
async function looseLeads(repId) {
  var rows = (await pool.query(
    "SELECT id, ref, name, company, phone, email, item, stage, next_follow_up, location, comments FROM crm_leads " +
    "WHERE rep_id = $1 AND customer_id IS NULL AND stage NOT IN ('won', 'lost') AND next_follow_up <= CURRENT_DATE ORDER BY next_follow_up", [repId])).rows;
  return rows.map(function (l) {
    return {
      customer: null,
      lead: { id: l.id, ref: l.ref, name: l.name, company: l.company, phone: l.phone, email: l.email, item: l.item, stage: l.stage, location: l.location, comments: l.comments },
      reasons: [{ type: 'lead', at: l.next_follow_up, leadId: l.id, ref: l.ref, item: l.item || '', due: day(l.next_follow_up), text: 'Lead ' + l.ref + (l.item ? ' (' + l.item + ')' : '') + ': follow-up due ' + day(l.next_follow_up) }],
      top: 'lead', nextStep: 'Move the lead on: call, then update its stage.'
    };
  });
}

async function forRep(repId) {
  var items = (await reasonsWhere('c.account_manager_id = $1', [repId])).concat(await looseLeads(repId));
  var counts = {};
  items.forEach(function (i) { counts[i.top] = (counts[i.top] || 0) + 1; });
  return { items: items, counts: counts, total: items.length };
}

async function mine(ctx) {
  if (!ctx.can('crm.read')) fail('forbidden', 'Your role does not allow this action (crm.read).');
  if (!ctx.employee) return { items: [], counts: {}, total: 0 };
  return forRep(ctx.employee.id);
}

// Everyone's, for the sales manager: each rep's count, and the customers
// with no rep who need someone.
async function team(ctx, q) {
  if (!ctx.can('crm.assign')) fail('forbidden', 'Your role does not allow this action (crm.assign).');
  if (q && q.rep) return forRep(q.rep);
  var all = await reasonsWhere('true', []);
  var byRep = {};
  all.forEach(function (i) {
    var k = i.customer.rep ? i.customer.rep.id : 'none';
    if (!byRep[k]) byRep[k] = { rep: i.customer.rep, total: 0, waiting: 0 };
    byRep[k].total++;
    if (i.top === 'waiting') byRep[k].waiting++;
  });
  return { reps: Object.keys(byRep).map(function (k) { return byRep[k]; }), unassigned: all.filter(function (i) { return !i.customer.rep; }) };
}

// One customer's reasons, for their profile.
async function reasonsForCustomer(customerId) {
  var r = await reasonsWhere('c.id = $1', [customerId]);
  return r.length ? { reasons: r[0].reasons, nextStep: r[0].nextStep } : { reasons: [], nextStep: null };
}

module.exports = { mine: mine, team: team, forRep: forRep, reasonsForCustomer: reasonsForCustomer, WAIT_HOURS: WAIT_HOURS, QUIET_DAYS: QUIET_DAYS };
