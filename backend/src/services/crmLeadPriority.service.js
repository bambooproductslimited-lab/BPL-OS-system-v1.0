var { pool } = require('../db/pool');

// How much a lead matters, so the Leads and Prospects pages can put the
// solid ones at the top and the long shots at the bottom.
//
// Every open lead and prospect gets a priority from 0 to 100: how likely
// they are to buy, and how big the job is. It starts at 35 and plain signals
// add or take away points; each is kept with its reason, so the page can say
// why a lead is where it is. (The rep's board, crmBoard.service.js, ranks by
// what needs doing now; this ranks by what is worth the most.)
//
//   marked_high / marked_low  someone on the team said so: Important or Low
//   bought_before / vip       has paid us before; a VIP customer
//   stage_*                   how far it has got: contacted, follow-up,
//                             qualified, quoted, negotiating, won
//   value_*                   the size of the job: their quotation, the sale
//                             linked, or what the thing they want usually
//                             sells for (past invoices and quotations, then
//                             the catalogue), against a typical sale
//   want_clear / want_unclear they say what they want, or not yet
//   business / bulk           a company; a big or business order (a hotel,
//                             40 chairs)
//   wrote_recently / talking / waiting
//                             their messages in the inbox: lately, many,
//                             and not answered yet
//   visit_done / visit_booked a site visit
//   referral                  someone sent them
//   source_*                  how often leads from that source got further
//                             over the last 12 months, against all leads
//   keen / cold               words in the comments, the notes and their
//                             messages: "deposit", "site visit"; "too
//                             expensive", "not reachable"
//   fresh / quiet             came in days ago; nothing heard for 2–4 months
//   no_contact                no phone, email or conversation to reach them
//
// 70 and up is solid, 50 promising, 30 maybe, the rest long shots. A lead
// marked Important is never below 70; one marked Low never above 29.
//
// What the scores compare against (the typical sale, what things sell for,
// how each source does) is worked out from the whole CRM and kept for five
// minutes.

var BASE = 35;
var TIERS = [[70, 'solid'], [50, 'promising'], [30, 'maybe'], [0, 'long_shot']];
var TIER_KEYS = TIERS.map(function (t) { return t[1]; });
var OPEN = ['new', 'contacted', 'follow_up', 'qualified', 'quote_sent', 'negotiation', 'won'];
var STAGE_POINTS = { contacted: 2, follow_up: 5, qualified: 10, quote_sent: 14, negotiation: 20, won: 20 };
var CONTEXT_MS = 5 * 60 * 1000;
var DAY = 86400000;

var BUSINESS_WORDS = ['hotel', 'resort', 'restaurant', 'school', 'church', 'mosque', 'office', 'offices', 'estate', 'apartments',
  'project', 'contract', 'contractor', 'bulk', 'wholesale', 'container', 'export', 'government', 'ministry', 'hospital', 'clinic',
  'bank', 'lodge', 'guest house', 'guesthouse', 'event centre', 'event center', 'factory', 'university', 'embassy', 'mall', 'supermarket', 'airbnb'];
var JOINERS = ['for', 'or', 'of', 'in', 'on', 'at', 'with', 'from', 'by', 'per', 'each', 'will', 'shall', 'can', 'should', 'if', 'but', 'so', 'as'];
// Numbers that are not quantities: "6 seater", "10 ft", "2 weeks".
var NOT_QTY = ['seater', 'seaters', 'ft', 'feet', 'foot', 'm', 'cm', 'mm', 'metre', 'meter', 'metres', 'meters', 'inch', 'inches', 'by', 'x',
  'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'am', 'pm', 'ghs', 'cedis', 'gh', 'k', 'percent', 'th', 'st', 'nd', 'rd',
  'min', 'mins', 'minutes', 'hr', 'hrs', 'hours', 'kg', 'g', 'l', 'litres', 'liters', 'and', 'or', 'to', 'percent',
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july', 'aug', 'august',
  'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december'];
var KEEN_WORDS = ['ready to buy', 'deposit', 'budget', 'urgent', 'urgently', 'asap', 'as soon as possible', 'this week', 'quotation', 'quote',
  'invoice', 'how much', 'price', 'measure', 'measurement', 'measurements', 'site visit', 'delivery', 'deliver', 'order', 'pay', 'payment',
  'momo', 'mobile money', 'account number', 'bank details', 'buy', 'interested', 'ready'];
var COLD_WORDS = ['not interested', 'no longer interested', 'no longer', 'too expensive', 'too costly', 'expensive', 'no response', 'not responding',
  'no reply', 'not replying', 'unreachable', 'not reachable', 'not available', 'not picking', 'not answering', 'switched off', 'wrong number',
  'just checking', 'just asking', 'just browsing', 'cancelled', 'canceled', 'cancel', 'went elsewhere', 'bought elsewhere', 'another supplier',
  'next year', 'no budget', 'no money'];
// What the "what they want" text says when it says nothing.
var STOP = {};
('a an the of for and with to in on at my me i we us you our your want wants wanted wanting need needs needed some made make making ' +
  'inquiry enquiry inquiries enquiries inquire enquire inquired enquired about price prices pricing cost info information interested ' +
  'please pls kindly looking look like would also new one two three it its is are was be this that these those just get got send sent ' +
  'asked ask asking request requested general product products item items stuff thing things available availability details detail ' +
  'na nil none other others etc dm message messaged chat chatted call called whatsapp instagram facebook tiktok').split(' ').forEach(function (w) { STOP[w] = true; });
var TYPO = { dinning: 'dining', dinnig: 'dining', dinin: 'dining', dinig: 'dining', wardrope: 'wardrobe', wadrobe: 'wardrobe', wardrob: 'wardrobe',
  shelve: 'shelf', shelves: 'shelf', chiar: 'chair', chare: 'chair', tabel: 'table', tabels: 'table', bambo: 'bamboo', bamboos: 'bamboo',
  televison: 'tv', television: 'tv', ceilling: 'ceiling', celing: 'ceiling', sofas: 'sofa', couches: 'couch', benches: 'bench', boxes: 'box' };

function day(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function daysSince(d, now) { return d ? Math.max(0, Math.floor((now - new Date(d instanceof Date ? d : day(d) + 'T00:00:00Z').getTime()) / DAY)) : null; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function tierOf(score) { for (var i = 0; i < TIERS.length; i++) if (score >= TIERS[i][0]) return TIERS[i][1]; return 'long_shot'; }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function wordRe(w) { return new RegExp('(^|[^a-z])' + escapeRe(w).replace(/ /g, '\\s+') + '(?=$|[^a-z])', 'g'); }
var KEEN_RE = KEEN_WORDS.map(function (w) { return [w, wordRe(w)]; });
var COLD_RE = COLD_WORDS.map(function (w) { return [w, wordRe(w)]; });
var BUSINESS_RE = BUSINESS_WORDS.map(function (w) { return [w, wordRe(w)]; });

// ── the words a lead's text is made of ───────────────────────────────
function fixWord(w) {
  if (TYPO[w]) return TYPO[w];
  if (w.length > 3 && /[^s]s$/.test(w)) w = w.slice(0, -1);
  return TYPO[w] || w;
}
function tokens(s) {
  var seen = {}, out = [];
  String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').forEach(function (w) {
    if (w.length < 2 || STOP[w]) return;
    w = fixWord(w);
    if (STOP[w] || seen[w]) return;
    seen[w] = true; out.push(w);
  });
  return out;
}
// Phrases from a list found in a text, the longest first, each found once:
// "not interested" is not also "interested".
function findWords(text, list) {
  var found = [];
  list.forEach(function (pair) {
    if (pair[1].test(text)) { found.push(pair[0]); text = text.replace(pair[1], '$1 '); }
    pair[1].lastIndex = 0;
  });
  return { found: found, rest: text };
}
// "40 chairs", "12 x doors", "12 dining sets": a quantity of ten or more of
// something — not an amount of money, a date, a year or a size. A second
// word is kept when things are sold under it (knows: the price book's).
function bulkQuantity(text, knows) {
  text = String(text || '').toLowerCase()
    .replace(/(ghs|gh¢|gh₵|ghc|cedis?|usd|\$)\s*[\d][\d,.]*/g, ' ')
    .replace(/[\d][\d,.]*\s*(ghs|gh¢|gh₵|ghc|cedis?|usd)/g, ' ');
  var re = /(^|[^0-9.,])(\d{2,4})(?![0-9.,])\s*(?:x\s*)?([a-z]+)?(?:[ \t]+([a-z]+))?/g, m;
  while ((m = re.exec(text))) {
    var n = Number(m[2]), w = m[3] || '', w2 = m[4] && !STOP[m[4]] && JOINERS.indexOf(m[4]) < 0 && knows && knows(fixWord(m[4])) ? m[4] : '';
    if (n >= 10 && n < 5000 && !(n >= 1990 && n <= 2100) && w && NOT_QTY.indexOf(w) < 0) return { n: n, words: [w, w2].filter(Boolean), text: [n, w, w2].filter(Boolean).join(' ') };
  }
  return null;
}

// ── what things sell for ─────────────────────────────────────────────
// Past invoice and quotation lines, then the catalogue: each a name, a
// typical amount and how many times it was sold or quoted. A lead's
// "what they want" is matched on its words, the rarer words counting
// more ("bamboo" is in every name; "bed" is not), and a match needs one
// word that isn't in half the names (once there are ten names to tell).
function priceBook(rows) {
  var entries = rows.map(function (r) { return { name: r.name, amount: Number(r.amount), unit: Number(r.unit) || Number(r.amount), n: Number(r.n) || 1, basis: r.basis, toks: tokens(r.name) }; })
    .filter(function (e) { return e.toks.length && e.amount > 0; });
  var df = {};
  entries.forEach(function (e) { e.toks.forEach(function (t) { df[t] = (df[t] || 0) + 1; }); });
  var N = entries.length || 1;
  function idf(t) { return Math.log(1 + N / ((df[t] || 0) + 1)); }
  entries.forEach(function (e) { e.weight = e.toks.reduce(function (a, t) { return a + idf(t); }, 0); });
  var memo = new Map();
  function match(item) {
    var key = tokens(item).join(' ');
    if (!key) return null;
    if (memo.has(key)) return memo.get(key);
    // Words no name has ("for the restaurant", "20 rooms") don't count
    // against a match, as long as most of the words are known.
    var all = key.split(' ');
    var lt = all.filter(function (t) { return df[t]; });
    if (!lt.length || lt.length * 2 < all.length) { memo.set(key, null); return null; }
    var total = lt.reduce(function (a, t) { return a + idf(t); }, 0);
    var scored = [];
    ['history', 'catalogue'].some(function (basis) {
      entries.forEach(function (e) {
        if (e.basis !== basis) return;
        var shared = lt.filter(function (t) { return e.toks.indexOf(t) >= 0; });
        if (!shared.length || (N >= 10 && !shared.some(function (t) { return (df[t] || 0) / N <= 0.5; }))) return;
        var got = shared.reduce(function (a, t) { return a + idf(t); }, 0);
        var cover = got / total;
        if (cover < 0.6) return;
        scored.push({ e: e, s: cover * 0.7 + (got / e.weight) * 0.3 });
      });
      return scored.length > 0;
    });
    var out = null;
    if (scored.length) {
      scored.sort(function (a, b) { return b.s - a.s || b.e.n - a.e.n; });
      var best = scored[0].s;
      var near = scored.filter(function (x) { return x.s >= best - 0.08; }).map(function (x) { return x.e; });
      // The middle amount, each weighted by how often it was sold.
      var sorted = near.slice().sort(function (a, b) { return a.amount - b.amount; });
      var count = sorted.reduce(function (a, e) { return a + e.n; }, 0), acc = 0, amount = sorted[0].amount;
      for (var i = 0; i < sorted.length; i++) { acc += sorted[i].n; if (acc * 2 >= count) { amount = sorted[i].amount; break; } }
      out = { amount: round2(amount), unit: round2(scored[0].e.unit), toks: scored[0].e.toks, basis: near[0].basis, name: scored[0].e.name, n: near[0].basis === 'history' ? count : 0 };
    }
    memo.set(key, out);
    return out;
  }
  return { match: match, size: entries.length, knows: function (t) { return !!df[t]; } };
}

// ── what the scores compare against ──────────────────────────────────
var cached = null;
function forget() { cached = null; }

async function context() {
  if (cached && Date.now() - cached.at < CONTEXT_MS) return cached;
  var crm = require('./crm.service');
  var co = await crm._salesCompany(await crm._settingsRow());
  var args = [];
  function arg(v) { args.push(v); return '$' + args.length; }
  var scope = crm._invoiceScope(co, arg);
  var lineTotal = "(li.qty * li.unit_price - CASE WHEN li.discount_type = 'percent' THEN li.qty * li.unit_price * li.discount / 100 ELSE li.discount END)";
  var [lines, catalogue, deals, sales, sources] = await Promise.all([
    pool.query(
      'SELECT min(x.description) AS name, count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY x.total) AS amount, ' +
      "  percentile_cont(0.5) WITHIN GROUP (ORDER BY x.unit_price) AS unit, 'history' AS basis FROM (" +
      '  SELECT li.description, li.unit_price, ' + lineTotal + ' AS total FROM document_line_items li JOIN invoices i ON i.id = li.document_id LEFT JOIN customers c ON c.id = i.customer_id ' +
      "  WHERE li.document_type = 'invoice' AND i.doc_kind = 'sale' AND i.status <> 'void' AND i.currency = 'GHS' AND i.issued_at > CURRENT_DATE - 730 AND li.unit_price > 0 AND " + scope +
      '  UNION ALL ' +
      '  SELECT li.description, li.unit_price, ' + lineTotal + ' FROM document_line_items li JOIN quotations i ON i.id = li.document_id LEFT JOIN customers c ON c.id = i.customer_id ' +
      "  WHERE li.document_type = 'quotation' AND i.status IN ('sent', 'viewed', 'accepted') AND i.currency = 'GHS' AND i.created_at > now() - interval '730 days' AND li.unit_price > 0 AND " + scope +
      ') x GROUP BY lower(trim(x.description)) ORDER BY n DESC LIMIT 3000', args),
    pool.query(
      "SELECT ci.name, max(v.unit_price) AS amount, max(v.unit_price) AS unit, 1 AS n, 'catalogue' AS basis FROM catalog_items ci JOIN catalog_item_variations v ON v.item_id = ci.id AND v.active " +
      'WHERE ci.active AND v.unit_price > 0 GROUP BY ci.id, ci.name LIMIT 3000'),
    pool.query(
      'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY i.grand_total) AS mid, count(*)::int AS n FROM crm_deals d JOIN invoices i ON i.id = d.invoice_id ' +
      "WHERE i.grand_total > 0 AND i.status <> 'void' AND i.issued_at > CURRENT_DATE - 730"),
    pool.query(
      'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY i.grand_total) AS mid, count(*)::int AS n FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id ' +
      "WHERE i.doc_kind = 'sale' AND i.status <> 'void' AND i.currency = 'GHS' AND i.grand_total > 0 AND i.issued_at > CURRENT_DATE - 365 AND " + scope, args),
    // Leads old enough to have had a chance (two weeks), over a year.
    pool.query(
      "SELECT lower(source) AS source, count(*)::int AS total, count(*) FILTER (WHERE stage IN ('qualified', 'quote_sent', 'negotiation', 'won'))::int AS moved " +
      "FROM crm_leads WHERE received_on BETWEEN CURRENT_DATE - 365 AND CURRENT_DATE - 14 AND source <> '' AND stage <> 'not_lead' GROUP BY lower(source)")
  ]);
  var typical = null;
  if (deals.rows[0].n >= 8) typical = Number(deals.rows[0].mid);
  else if (sales.rows[0].n >= 5) typical = Number(sales.rows[0].mid);
  var all = sources.rows.reduce(function (a, r) { return { total: a.total + r.total, moved: a.moved + r.moved }; }, { total: 0, moved: 0 });
  var bySource = {};
  sources.rows.forEach(function (r) { bySource[r.source] = r; });
  cached = {
    at: Date.now(),
    typical: typical,
    book: priceBook(lines.rows.concat(catalogue.rows)),
    sources: bySource,
    overall: all.total >= 30 ? all.moved / all.total : null
  };
  return cached;
}

// ── what is known about each lead ────────────────────────────────────
// Its customer, its history, visits and referrals, a quotation, and the
// inbox: the conversations of its customer, or of its phone number.
var SIGNALS_SQL =
  "WITH ls AS (SELECT l.id, l.customer_id, l.received_on, CASE WHEN length(regexp_replace(l.phone, '\\D', '', 'g')) >= 9 THEN right(regexp_replace(l.phone, '\\D', '', 'g'), 9) END AS pkey " +
  '  FROM crm_leads l WHERE l.id = ANY($1)), ' +
  "cv AS (SELECT c.id, c.customer_id, CASE WHEN c.contact_kind = 'phone' THEN right(c.contact_key, 9) END AS pkey, c.status, c.last_direction, c.last_message_at " +
  "  FROM crm_conversations c WHERE c.status <> 'spam' AND (c.customer_id IN (SELECT customer_id FROM ls) OR (c.contact_kind = 'phone' AND right(c.contact_key, 9) IN (SELECT pkey FROM ls)))) " +
  'SELECT ls.id, cu.category AS customer_category, ' +
  "  (SELECT max(n.at) FROM crm_lead_notes n WHERE n.lead_id = ls.id AND (n.kind IN ('note', 'call', 'visit') OR (n.kind = 'stage' AND n.by_employee IS NOT NULL))) AS last_touch, " +
  "  (SELECT string_agg(left(x.body, 400), ' | ') FROM (SELECT n.body FROM crm_lead_notes n WHERE n.lead_id = ls.id AND n.kind IN ('note', 'call') ORDER BY n.at DESC LIMIT 5) x) AS notes_text, " +
  "  (SELECT max(CASE v.status WHEN 'visited' THEN 2 WHEN 'scheduled' THEN 1 ELSE 0 END) FROM crm_site_visits v WHERE v.lead_id = ls.id) AS visit, " +
  '  EXISTS (SELECT 1 FROM crm_referrals r WHERE r.lead_id = ls.id) AS referred, ' +
  '  ((ls.customer_id IS NOT NULL AND EXISTS (SELECT 1 FROM payments p JOIN invoices i ON i.id = p.invoice_id ' +
  "     WHERE p.customer_id = ls.customer_id AND p.amount > 0 AND i.doc_kind = 'sale' AND i.issued_at < ls.received_on)) " +
  "   OR (ls.pkey IS NOT NULL AND EXISTS (SELECT 1 FROM crm_leads o WHERE o.id <> ls.id AND o.stage = 'won' AND o.received_on <= ls.received_on " +
  "     AND right(regexp_replace(o.phone, '\\D', '', 'g'), 9) = ls.pkey))) AS bought_before, " +
  '  q.quote_total, conv.ids IS NOT NULL AS has_conversation, conv.waiting_since, msg.ins, msg.last_in, txt.said ' +
  'FROM ls LEFT JOIN customers cu ON cu.id = ls.customer_id ' +
  'LEFT JOIN LATERAL (SELECT x.grand_total AS quote_total FROM quotations x WHERE ls.customer_id IS NOT NULL AND x.customer_id = ls.customer_id ' +
  "  AND x.status IN ('sent', 'viewed', 'accepted') AND x.currency = 'GHS' AND COALESCE(x.sent_at, x.created_at) >= ls.received_on - 14 ORDER BY x.grand_total DESC LIMIT 1) q ON true " +
  'LEFT JOIN LATERAL (SELECT array_agg(cv.id) AS ids, ' +
  "  max(cv.last_message_at) FILTER (WHERE cv.last_direction = 'in' AND cv.status = 'open' AND cv.last_message_at > now() - interval '14 days') AS waiting_since " +
  '  FROM cv WHERE (ls.customer_id IS NOT NULL AND cv.customer_id = ls.customer_id) OR (ls.pkey IS NOT NULL AND cv.pkey = ls.pkey)) conv ON true ' +
  "LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE m.sent_at > now() - interval '120 days')::int AS ins, max(m.sent_at) AS last_in " +
  "  FROM crm_messages m WHERE conv.ids IS NOT NULL AND m.conversation_id = ANY(conv.ids) AND m.direction = 'in') msg ON true " +
  "LEFT JOIN LATERAL (SELECT string_agg(left(y.body, 300), ' | ') AS said FROM (SELECT m.body FROM crm_messages m WHERE conv.ids IS NOT NULL AND m.conversation_id = ANY(conv.ids) " +
  "  AND m.direction = 'in' AND m.sent_at > now() - interval '120 days' ORDER BY m.sent_at DESC LIMIT 4) y) txt ON true";

async function signals(ids) {
  var out = new Map();
  if (!ids.length) return out;
  (await pool.query(SIGNALS_SQL, [ids])).rows.forEach(function (r) { out.set(r.id, r); });
  return out;
}

// ── the score ────────────────────────────────────────────────────────
// lead: as crm.service's rowToLead gives it. sig: its row from signals().
// cx: context(). now: a time in ms.
function score(lead, sig, cx, now) {
  if (OPEN.indexOf(lead.stage) < 0 || lead.phase === 'customer' || lead.noFollowUp) return null;
  sig = sig || {};
  var r = [];
  function add(k, p, extra) { r.push(Object.assign({ k: k, p: p }, extra || {})); }

  if (sig.bought_before) add('bought_before', 15);
  if (sig.customer_category === 'vip') add('vip', 5);
  if (STAGE_POINTS[lead.stage]) add('stage_' + lead.stage, STAGE_POINTS[lead.stage]);

  // The size of the job: what they were quoted or sold, else what the
  // thing usually sells for — times how many, when they say ("200 poles").
  var words = [lead.item, lead.comments, sig.notes_text || '', sig.said || ''].join(' | ').toLowerCase().replace(/\s+/g, ' ');
  var qty = bulkQuantity(words, cx.book.knows);
  var value = null;
  if (lead.dealValue > 0) value = { amount: round2(lead.dealValue), basis: 'deal' };
  else if (Number(sig.quote_total) > 0) value = { amount: round2(sig.quote_total), basis: 'quote' };
  else if (lead.item) {
    var found = cx.book.match(lead.item);
    if (found) {
      value = { amount: found.amount, basis: found.basis, name: found.name, n: found.n };
      if (qty && qty.words.some(function (w) { return found.toks.indexOf(fixWord(w)) >= 0; })) Object.assign(value, { amount: round2(found.unit * qty.n), qty: qty.n, unit: found.unit });
    }
  }
  var itemWords = tokens(lead.item);
  if (value) {
    var v = { amount: value.amount, basis: value.basis, name: value.name || null, n: value.n || 0 };
    if (value.qty) Object.assign(v, { qty: value.qty, unit: value.unit });
    if (cx.typical) {
      var ratio = value.amount / cx.typical;
      if (ratio >= 2) add('value_big', 15, v);
      else if (ratio >= 0.8) add('value_good', 9, v);
      else if (ratio >= 0.35) add('value_fair', 4, v);
      else add('value_small', -2, v);
    } else add('value_known', 5, v);
  } else if (itemWords.length) add('want_clear', 4, { item: lead.item });
  else add('want_unclear', -6);

  if (lead.company) add('business', 6, { company: lead.company });
  var biz = findWords(words, BUSINESS_RE).found;
  if (qty || biz.length) add('bulk', 8, { what: qty ? qty.text : biz[0] });

  // Their messages.
  var lastIn = sig.last_in ? new Date(sig.last_in).getTime() : null;
  var wroteDays = lastIn ? Math.floor((now - lastIn) / DAY) : null;
  if (wroteDays !== null && wroteDays <= 3) add('wrote_recently', 12, { days: wroteDays });
  else if (wroteDays !== null && wroteDays <= 14) add('wrote_recently', 7, { days: wroteDays });
  if (sig.ins >= 3) add('talking', 6, { n: sig.ins });
  if (sig.waiting_since) add('waiting', 4, { since: sig.waiting_since });

  if (sig.visit === 2) add('visit_done', 12);
  else if (sig.visit === 1) add('visit_booked', 10);
  if (sig.referred || /referr/i.test(lead.source || '')) add('referral', 8);

  // How leads from the same place usually do.
  var src = lead.source ? cx.sources[lead.source.toLowerCase()] : null;
  if (src && cx.overall && src.total >= 12) {
    var smooth = (src.moved + 10 * cx.overall) / (src.total + 10);
    var ratioS = smooth / cx.overall;
    var pcts = { source: lead.source, pct: Math.round(src.moved / src.total * 100), all: Math.round(cx.overall * 100) };
    if (ratioS >= 1.6) add('source_strong', 8, pcts);
    else if (ratioS >= 1.2) add('source_good', 4, pcts);
    else if (ratioS <= 0.6) add('source_weak', -5, pcts);
  }

  // What was said.
  var cold = findWords(words, COLD_RE);
  var keen = findWords(cold.rest, KEEN_RE).found;
  if (keen.length) add('keen', Math.min(9, 3 * keen.length), { words: keen.slice(0, 3) });
  if (cold.found.length) add('cold', -Math.min(15, 6 * cold.found.length), { words: cold.found.slice(0, 3) });

  // How fresh.
  var age = daysSince(lead.receivedOn, now);
  if (age !== null && age <= 3) add('fresh', 8, { days: age });
  else if (age !== null && age <= 10) add('fresh', 4, { days: age });
  var last = Math.max(new Date(lead.receivedOn + 'T00:00:00Z').getTime(), sig.last_touch ? new Date(sig.last_touch).getTime() : 0, lastIn || 0);
  var quiet = Math.floor((now - last) / DAY);
  if (lead.stage !== 'won' && quiet >= 120) add('quiet', -14, { days: quiet });
  else if (lead.stage !== 'won' && quiet >= 60) add('quiet', -8, { days: quiet });

  if (!lead.phone && !lead.email && !sig.has_conversation) add('no_contact', -15);

  var total = BASE + r.reduce(function (a, x) { return a + x.p; }, 0);
  if (lead.manualPriority === 'high') { r.unshift({ k: 'marked_high', p: 0, by: lead.priorityBy || null, at: lead.priorityAt || null }); total = Math.max(70, total + 15); }
  if (lead.manualPriority === 'low') { r.unshift({ k: 'marked_low', p: 0, by: lead.priorityBy || null, at: lead.priorityAt || null }); total = Math.min(29, total - 15); }
  total = Math.max(0, Math.min(100, Math.round(total)));
  r.sort(function (a, b) { return (b.k.indexOf('marked_') === 0) - (a.k.indexOf('marked_') === 0) || b.p - a.p; });
  return { score: total, tier: tierOf(total), reasons: r, value: value ? Object.assign({ amount: value.amount, basis: value.basis, name: value.name || null, n: value.n || 0 }, value.qty ? { qty: value.qty, unit: value.unit } : {}) : null };
}

// Adds .priority to each lead (crm.service's rowToLead objects).
async function attach(leads) {
  var open = leads.filter(function (l) { return OPEN.indexOf(l.stage) >= 0 && l.phase !== 'customer'; });
  var cx = await context();
  var sig = await signals(open.map(function (l) { return l.id; }));
  var now = Date.now();
  leads.forEach(function (l) { l.priority = OPEN.indexOf(l.stage) >= 0 && l.phase !== 'customer' ? score(l, sig.get(l.id), cx, now) : null; });
  return leads;
}

// Most important first: the priority, then a follow-up that is due, then
// the newest.
function byPriority(a, b) {
  var pa = a.priority ? a.priority.score : -1, pb = b.priority ? b.priority.score : -1;
  if (pb !== pa) return pb - pa;
  var fa = a.nextFollowUp || '9999', fb = b.nextFollowUp || '9999';
  if (fa !== fb) return fa < fb ? -1 : 1;
  return String(b.receivedOn).localeCompare(String(a.receivedOn));
}

module.exports = {
  BASE: BASE, TIERS: TIERS, TIER_KEYS: TIER_KEYS,
  attach: attach, score: score, byPriority: byPriority, context: context, forget: forget,
  _tokens: tokens, _priceBook: priceBook, _bulkQuantity: function (t) { var q = bulkQuantity(t); return q ? q.text : null; }, _findWords: function (text, words) { return findWords(text, words.map(function (w) { return [w, wordRe(w)]; })).found; }
};
