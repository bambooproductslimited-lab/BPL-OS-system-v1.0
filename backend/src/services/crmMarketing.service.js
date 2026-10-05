/*
 * Marketing from the CRM.
 *
 * topics() reads what customers have been writing (every channel), what
 * they were quoted and what they bought, and finds: which products they
 * ask about (and whether that is rising), what they ask (prices, delivery,
 * custom sizes, payment, stock), and on which channels.
 *
 * contentIdeas() turns that into posts to make: what, in which format, on
 * which platform, and why — from rules, or written by the AI Assistant when
 * it is set up (it is sent the counts only: no names, numbers or messages).
 *
 * audience() takes a product (or any words) and ranks the customers to tell
 * about it: who asked about it, who was quoted it and didn't buy, who bought
 * it, whose lead is for it, who buys the same kind of thing — each with the
 * reason, the rep, and the best way to reach them. Customers who said no to
 * marketing are never on it. handToReps() puts the list on each rep's
 * follow-ups.
 */
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { bplScopeClause } = require('../utils/documents');

var SCOPE = bplScopeClause('c');
var QUESTIONS = {
  price: { label: 'Prices', re: /\b(how much|price|prices|cost|costs|rate|rates|quote|quotation|discount)\b/i },
  delivery: { label: 'Delivery and location', re: /\b(deliver|delivery|shipping|ship|send it|location|where are you|address|pick ?up|transport)\b/i },
  custom: { label: 'Custom sizes and designs', re: /\b(custom|design|size|sizes|dimension|dimensions|measure|measurement|colou?r|made to)\b/i },
  stock: { label: 'Availability', re: /\b(available|availability|in stock|do you have|still have|ready)\b/i },
  payment: { label: 'Paying', re: /\b(momo|mobile money|pay|payment|account number|bank|installment|instalment|deposit)\b/i },
  bulk: { label: 'Bulk orders', re: /\b(bulk|wholesale|dozen|pieces|pcs|carton|cartons|large order)\b/i },
  quality: { label: 'Quality and care', re: /\b(durable|durability|last long|quality|termite|treated|waterproof|water ?proof|warranty|guarantee)\b/i }
};
var LANGS = { fr: 'French', zh: 'Simplified Chinese' };
var CHANNEL_PLATFORM = { instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp Status', email: 'email newsletter' };

function need(ctx, any) {
  if (!any.some(function (p) { return ctx.can(p); })) fail('forbidden', 'Your role does not allow this action (' + any.join(' or ') + ').');
}
function me(ctx) { return ctx && ctx.employee ? ctx.employee.id : null; }
function day(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
// Words that stand for a product: its name, and its name without sizes,
// codes and brackets ("Bamboo straw (pack of 50)" → "bamboo straw").
function phrases(name) {
  var n = String(name || '').toLowerCase().trim();
  var core = n.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\b\d+(\.\d+)?\s*(cm|mm|m|ft|inch|in|kg|g|l|ml|pcs|pc|x)?\b/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  var out = [];
  if (n.length >= 4) out.push(n);
  if (core.length >= 4 && out.indexOf(core) < 0) out.push(core);
  // A plural or a singular is the same product.
  out.slice().forEach(function (p) { if (/s$/.test(p) && p.length > 5) out.push(p.slice(0, -1)); else out.push(p + 's'); });
  return out;
}
function matches(text, list) { for (var i = 0; i < list.length; i++) if (text.indexOf(list[i]) >= 0) return true; return false; }
// An excerpt with nothing personal in it.
function clean(s) { return String(s || '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\+?\d[\d\s-]{6,}\d/g, '[number]').replace(/\s+/g, ' ').slice(0, 140); }

async function productList() {
  var rows = (await pool.query(
    "SELECT ci.id, ci.name, COALESCE(cc.name, '') AS category, 'catalog' AS kind FROM catalog_items ci LEFT JOIN catalog_categories cc ON cc.id = ci.category_id WHERE ci.active " +
    "UNION ALL SELECT p.id, p.name, COALESCE(p.category, ''), 'product' FROM products p WHERE p.active")).rows;
  var seen = {};
  return rows.filter(function (r) { var k = r.name.toLowerCase().trim(); if (seen[k]) return false; seen[k] = true; return true; })
    .map(function (r) { return { id: r.id, name: r.name, category: r.category, kind: r.kind, phrases: phrases(r.name) }; });
}

// ── what customers talk about ────────────────────────────────────────
async function topics(ctx, q) {
  need(ctx, ['crm.read', 'marketing.read']);
  var days = Math.min(365, Math.max(7, Number(q && q.days) || 30));
  var since = new Date(Date.now() - days * 86400000), before = new Date(Date.now() - 2 * days * 86400000);
  var msgs = (await pool.query(
    "SELECT m.body, m.sent_at, cv.channel, cv.customer_id, cv.id AS conversation_id FROM crm_messages m JOIN crm_conversations cv ON cv.id = m.conversation_id " +
    "LEFT JOIN customers c ON c.id = cv.customer_id WHERE m.direction = 'in' AND m.sent_at >= $1 AND cv.status <> 'spam' AND (cv.customer_id IS NULL OR " + SCOPE + ") " +
    "ORDER BY m.sent_at DESC LIMIT 20000", [before])).rows;
  var products = await productList();
  var stats = {};
  products.forEach(function (p) { stats[p.name] = { name: p.name, id: p.id, category: p.category, asks: 0, askedBefore: 0, customers: new Set(), channels: {}, questions: {} }; });
  var questions = {};
  Object.keys(QUESTIONS).forEach(function (k) { questions[k] = { key: k, label: QUESTIONS[k].label, count: 0, customers: new Set(), examples: [] }; });
  var channels = {};
  var who = function (m) { return m.customer_id || 'conv:' + m.conversation_id; };
  msgs.forEach(function (m) {
    var text = String(m.body || '').toLowerCase();
    var recent = new Date(m.sent_at) >= since;
    if (recent) channels[m.channel] = (channels[m.channel] || 0) + 1;
    var qs = Object.keys(QUESTIONS).filter(function (k) { return QUESTIONS[k].re.test(text); });
    if (recent) qs.forEach(function (k) { questions[k].count++; questions[k].customers.add(who(m)); if (questions[k].examples.length < 3) questions[k].examples.push(clean(m.body)); });
    products.forEach(function (p) {
      if (!matches(text, p.phrases)) return;
      var s = stats[p.name];
      if (!recent) { s.askedBefore++; return; }
      s.asks++; s.customers.add(who(m));
      s.channels[m.channel] = (s.channels[m.channel] || 0) + 1;
      qs.forEach(function (k) { s.questions[k] = (s.questions[k] || 0) + 1; });
    });
  });
  // Quoted and sold in the same period, by product.
  var lines = (await pool.query(
    "SELECT li.description, li.document_type, sum(li.qty) AS qty, count(DISTINCT x.customer_id)::int AS customers FROM document_line_items li " +
    "JOIN (SELECT id, customer_id, 'invoice' AS t, issued_at AS at FROM invoices WHERE status <> 'void' UNION ALL SELECT id, customer_id, 'quotation', created_at FROM quotations) x " +
    "  ON x.id = li.document_id AND x.t = li.document_type JOIN customers c ON c.id = x.customer_id WHERE x.at >= $1 AND " + SCOPE +
    " GROUP BY li.description, li.document_type", [since])).rows;
  products.forEach(function (p) {
    var s = stats[p.name];
    s.quoted = 0; s.sold = 0; s.buyers = 0;
    lines.forEach(function (l) {
      if (!matches(String(l.description || '').toLowerCase(), p.phrases)) return;
      if (l.document_type === 'invoice') { s.sold += Number(l.qty); s.buyers += l.customers; } else s.quoted += Number(l.qty);
    });
  });
  var list = Object.keys(stats).map(function (k) {
    var s = stats[k];
    return { id: s.id, name: s.name, category: s.category, asks: s.asks, customers: s.customers.size, trend: s.askedBefore ? Math.round((s.asks - s.askedBefore) / s.askedBefore * 100) : (s.asks ? null : 0),
      askedBefore: s.askedBefore, channels: s.channels, questions: s.questions, quoted: s.quoted, sold: s.sold, buyers: s.buyers };
  }).filter(function (s) { return s.asks || s.sold || s.quoted; })
    .sort(function (a, b) { return b.customers - a.customers || b.asks - a.asks || b.sold - a.sold; });
  var newCustomers = (await pool.query(
    "SELECT origin_channel AS channel, count(*)::int AS n FROM customers c WHERE c.source = 'crm' AND c.created_at >= $1 AND " + SCOPE + " GROUP BY origin_channel", [since])).rows;
  return {
    days: days, messages: msgs.filter(function (m) { return new Date(m.sent_at) >= since; }).length,
    products: list.slice(0, 30),
    questions: Object.keys(questions).map(function (k) { var x = questions[k]; return { key: k, label: x.label, count: x.count, customers: x.customers.size, examples: x.examples }; })
      .filter(function (x) { return x.count; }).sort(function (a, b) { return b.customers - a.customers; }),
    channels: channels, newCustomers: newCustomers
  };
}

function topChannelKey(ch) { return Object.keys(ch || {}).filter(function (k) { return CHANNEL_PLATFORM[k]; }).sort(function (a, b) { return ch[b] - ch[a]; })[0] || 'instagram'; }
function topChannel(ch) {
  var k = Object.keys(ch || {}).sort(function (a, b) { return ch[b] - ch[a]; })[0];
  return CHANNEL_PLATFORM[k] || 'Instagram';
}

// ── posts to make ────────────────────────────────────────────────────
function ruleIdeas(t) {
  var ideas = [];
  var q = {};
  t.questions.forEach(function (x) { q[x.key] = x; });
  // The numbers each idea is built from, so the page can word it in the reader's language.
  function v(p, more) { return Object.assign({ product: p.name, customers: p.customers, days: t.days, trend: p.trend, platform: topChannelKey(p.channels) }, more || {}); }
  t.products.slice(0, 6).forEach(function (p, i) {
    if (!p.customers) return;
    var why = p.customers + ' customer(s) asked about ' + p.name + ' in the last ' + t.days + ' days' + (p.trend > 0 ? ' (' + p.trend + '% more than before)' : '');
    if ((p.questions.price || 0) >= Math.max(2, p.asks / 3)) {
      ideas.push({ kind: 'price', vars: v(p, { asks: p.questions.price }), product: p.name, title: p.name + ': prices and sizes', format: 'Carousel post and Status', platform: topChannel(p.channels),
        why: why + '; ' + p.questions.price + ' of the messages asked the price.', hook: 'How much is ' + p.name + '? Here is the full price list.',
        points: ['Every size with its price', 'What is included and how long it lasts', 'How to order: WhatsApp number and payment'] });
    } else if (p.asks >= 3 && p.sold < p.customers) {
      ideas.push({ kind: 'inUse', vars: v(p), product: p.name, title: p.name + ' in real homes and businesses', format: 'Short video (Reel) or customer photos', platform: topChannel(p.channels),
        why: why + ', but few went on to buy — show it in use to win them over.', hook: 'See ' + p.name + ' after a year of use.',
        points: ['A customer showing it in their space', 'Close-ups of the finish', 'A short testimonial'] });
    } else if (p.trend !== null && p.trend >= 50) {
      ideas.push({ kind: 'trending', vars: v(p), product: p.name, title: 'Trending now: ' + p.name, format: 'Story / Status', platform: topChannel(p.channels),
        why: why + '.', hook: 'Everyone is asking about ' + p.name + ' — here is why.', points: ['What it is for', 'Price from', 'Order today'] });
    } else if (i < 3) {
      ideas.push({ kind: 'why', vars: v(p), product: p.name, title: 'Why choose ' + p.name, format: 'Post', platform: topChannel(p.channels), why: why + '.',
        hook: p.name + ', made from Ghanaian bamboo.', points: ['What makes it different', 'Who it is for', 'How to order'] });
    }
  });
  var best = t.products.filter(function (p) { return p.sold; }).sort(function (a, b) { return b.buyers - a.buyers; })[0];
  if (best) ideas.push({ kind: 'showcase', vars: { product: best.name, buyers: best.buyers, days: t.days }, product: best.name, title: 'Customer showcase: ' + best.name, format: 'Photo post', platform: 'Instagram and Facebook',
    why: best.buyers + ' customer(s) bought ' + best.name + ' in the last ' + t.days + ' days — your best seller.', hook: 'From our workshop to your space.', points: ['Installed photos (with the customer\'s permission)', 'A thank-you', 'Order link'] });
  if (q.delivery && q.delivery.customers >= 2) ideas.push({ kind: 'delivery', vars: { customers: q.delivery.customers }, product: null, title: 'How ordering and delivery work', format: 'Short video, pinned post and WhatsApp Status', platform: 'All channels',
    why: q.delivery.customers + ' customers asked about delivery or where you are.', hook: 'Ordering from Bamboo Products in 3 steps.', points: ['Where the workshop and showroom are', 'Delivery areas and how long it takes', 'How to pay'] });
  if (q.custom && q.custom.customers >= 2) ideas.push({ kind: 'custom', vars: { customers: q.custom.customers }, product: null, title: 'Made to your size: behind the scenes', format: 'Reel', platform: 'Instagram and TikTok',
    why: q.custom.customers + ' customers asked about custom sizes or designs.', hook: 'Your idea, our bamboo.', points: ['Measuring', 'Building in the workshop', 'The finished piece'] });
  if (q.payment && q.payment.customers >= 2) ideas.push({ kind: 'payment', vars: { customers: q.payment.customers }, product: null, title: 'Ways to pay', format: 'Story highlight and Status', platform: 'Instagram and WhatsApp Status',
    why: q.payment.customers + ' customers asked how to pay.', hook: 'Pay by MoMo, bank or cash.', points: ['MoMo number', 'Bank details', 'Deposit and balance terms'] });
  if (q.quality && q.quality.customers >= 2) ideas.push({ kind: 'quality', vars: { customers: q.quality.customers }, product: null, title: 'How long bamboo lasts (and how we treat it)', format: 'Carousel', platform: 'Instagram and Facebook',
    why: q.quality.customers + ' customers asked about durability or treatment.', hook: 'Does bamboo last? Yes — here is how.', points: ['Treatment against termites and water', 'Care tips', 'Warranty'] });
  return ideas.slice(0, 10);
}

async function contentIdeas(ctx, q) {
  need(ctx, ['crm.read', 'marketing.read']);
  var t = await topics(ctx, q);
  var ideas = ruleIdeas(t);
  var source = 'rules';
  var claude = require('../ai/claude');
  if (q && (q.ai === '1' || q.ai === true) && claude.configured() && (t.products.length || t.questions.length)) {
    try {
      var facts = { days: t.days, messages: t.messages,
        products: t.products.slice(0, 12).map(function (p) { return { name: p.name, category: p.category, customersAsking: p.customers, trendPct: p.trend, questions: p.questions, quoted: p.quoted, sold: p.sold, channels: p.channels }; }),
        questions: t.questions.map(function (x) { return { topic: x.label, customers: x.customers, examples: x.examples }; }), channels: t.channels };
      var text = await claude.complete(
        'You are the marketing lead of Bamboo Products Limited, a Ghanaian maker of bamboo furniture, decor and everyday bamboo products. ' +
        'From what customers asked in the last weeks, suggest content to make.' + (LANGS[q.lang] ? ' Write every text field in ' + LANGS[q.lang] + '.' : '') + ' Answer with JSON only: an array of up to 8 objects ' +
        '{ "product": string or null, "title": string, "format": string, "platform": string, "why": string (cite the numbers), "hook": string, "points": [3 short strings] }.',
        [{ role: 'user', content: JSON.stringify(facts) }], 3000);
      var m = /\[[\s\S]*\]/.exec(text || '');
      var parsed = m ? JSON.parse(m[0]) : null;
      if (Array.isArray(parsed) && parsed.length) {
        ideas = parsed.slice(0, 8).map(function (x) {
          return { product: x.product || null, title: String(x.title || '').slice(0, 160), format: String(x.format || '').slice(0, 80), platform: String(x.platform || '').slice(0, 80),
            why: String(x.why || '').slice(0, 400), hook: String(x.hook || '').slice(0, 200), points: (x.points || []).slice(0, 5).map(function (p) { return String(p).slice(0, 160); }) };
        });
        source = 'ai';
      }
    } catch (e) { console.error('[crm marketing] AI ideas failed, rules used:', e.message); }
  }
  return { ideas: ideas, source: source, aiAvailable: claude.configured(), topics: t };
}

// ── who to tell about a product ──────────────────────────────────────
async function audience(ctx, q) {
  need(ctx, ['crm.read']);
  q = q || {};
  var product = null, terms = [];
  if (q.productId) {
    product = (await productList()).find(function (p) { return p.id === q.productId; });
    if (!product) fail('notfound', 'Product not found.');
    terms = product.phrases;
  }
  String(q.text || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s.length >= 3; })
    .forEach(function (s) { phrases(s).forEach(function (p) { if (terms.indexOf(p) < 0) terms.push(p); }); });
  if (!terms.length) fail('invalid', 'Choose a product, or type what it is (e.g. "bamboo straws").');
  var pats = terms.map(function (t) { return '%' + t.replace(/[\\%_]/g, '\\$&') + '%'; });

  var asked = (await pool.query(
    "SELECT DISTINCT ON (cv.customer_id) cv.customer_id, m.body, m.sent_at, cv.channel FROM crm_messages m JOIN crm_conversations cv ON cv.id = m.conversation_id " +
    "WHERE m.direction = 'in' AND cv.customer_id IS NOT NULL AND m.body ILIKE ANY($1) ORDER BY cv.customer_id, m.sent_at DESC", [pats])).rows;
  var docs = (await pool.query(
    "SELECT x.customer_id, x.t, x.ref, x.at, li.description FROM document_line_items li " +
    "JOIN (SELECT id, customer_id, 'invoice' AS t, invoice_no AS ref, issued_at AS at FROM invoices WHERE status <> 'void' " +
    "      UNION ALL SELECT id, customer_id, 'quotation', quote_no, created_at FROM quotations WHERE status <> 'cancelled') x ON x.id = li.document_id AND x.t = li.document_type " +
    "WHERE li.description ILIKE ANY($1) ORDER BY x.at DESC", [pats])).rows;
  var leads = (await pool.query("SELECT customer_id, ref, item, received_on FROM crm_leads WHERE customer_id IS NOT NULL AND stage <> 'lost' AND item ILIKE ANY($1)", [pats])).rows;
  var sameKind = [];
  if (product && product.category) {
    var kin = (await productList()).filter(function (p) { return p.category === product.category && p.id !== product.id; });
    var kinPats = [].concat.apply([], kin.map(function (p) { return p.phrases; })).map(function (t) { return '%' + t.replace(/[\\%_]/g, '\\$&') + '%'; });
    if (kinPats.length) {
      sameKind = (await pool.query(
        "SELECT DISTINCT ON (i.customer_id) i.customer_id, li.description, i.issued_at FROM document_line_items li JOIN invoices i ON i.id = li.document_id AND li.document_type = 'invoice' " +
        "WHERE i.status <> 'void' AND li.description ILIKE ANY($1) ORDER BY i.customer_id, i.issued_at DESC", [kinPats])).rows;
    }
  }
  var score = {};
  function add(id, pts, reason, why) { var s = score[id] || (score[id] = { points: 0, reasons: [], why: [] }); s.points += pts; if (reason) { s.reasons.push(reason); s.why.push(why); } }
  var CH = { whatsapp: 'WhatsApp', email: 'email', instagram: 'Instagram', facebook: 'Facebook', sms: 'SMS', call: 'a call', visit: 'a visit', other: 'a message' };
  asked.forEach(function (a) {
    var recent = Date.now() - new Date(a.sent_at).getTime() < 90 * 86400000;
    add(a.customer_id, recent ? 50 : 40, 'Asked about it on ' + CH[a.channel] + ' on ' + day(a.sent_at) + ': "' + clean(a.body).slice(0, 90) + '"',
      { type: 'asked', channel: a.channel, on: day(a.sent_at), excerpt: clean(a.body).slice(0, 90) });
  });
  var bought = {}, quoted = {};
  docs.forEach(function (d) { if (d.t === 'invoice') { if (!bought[d.customer_id]) bought[d.customer_id] = d; } else if (!quoted[d.customer_id]) quoted[d.customer_id] = d; });
  Object.keys(quoted).forEach(function (id) { if (!bought[id]) add(id, 45, 'Was quoted ' + quoted[id].description + ' (' + quoted[id].ref + ', ' + day(quoted[id].at) + ') and didn\'t buy', { type: 'quoted', item: quoted[id].description, ref: quoted[id].ref, on: day(quoted[id].at) }); });
  Object.keys(bought).forEach(function (id) { add(id, 30, 'Bought ' + bought[id].description + ' (' + bought[id].ref + ', ' + day(bought[id].at) + ')', { type: 'bought', item: bought[id].description, ref: bought[id].ref, on: day(bought[id].at) }); });
  leads.forEach(function (l) { add(l.customer_id, 35, 'Lead ' + l.ref + ' is for ' + l.item, { type: 'lead', ref: l.ref, item: l.item }); });
  sameKind.forEach(function (s) { if (!score[s.customer_id]) add(s.customer_id, 15, 'Buys other ' + product.category + ' (' + s.description + ')', { type: 'kind', category: product.category, item: s.description }); });
  var ids = Object.keys(score);
  if (!ids.length) return { product: product ? { id: product.id, name: product.name } : null, terms: terms, people: [], left: { optedOut: 0, unreachable: 0 }, message: draft(product, q.text) };
  var cust = (await pool.query(
    "SELECT c.id, c.name, c.phone, c.email, c.category, c.marketing_opt_out, c.last_contact_at, c.account_manager_id, e.first_name || ' ' || e.last_name AS rep_name, " +
    "(SELECT array_agg(kind) FROM customer_identities i WHERE i.customer_id = c.id) AS kinds, " +
    "(SELECT array_agg(DISTINCT channel) FROM crm_conversations w WHERE w.customer_id = c.id) AS channels " +
    "FROM customers c LEFT JOIN employees e ON e.id = c.account_manager_id WHERE c.id = ANY($1) AND c.status = 'active' AND " + SCOPE, [ids])).rows;
  var optedOut = 0, unreachable = 0, people = [];
  cust.forEach(function (c) {
    if (c.marketing_opt_out) { optedOut++; return; }
    var kinds = c.kinds || [], chans = c.channels || [];
    var via = chans.indexOf('whatsapp') >= 0 || kinds.indexOf('phone') >= 0 ? 'whatsapp' : kinds.indexOf('email') >= 0 || c.email ? 'email'
      : chans.indexOf('instagram') >= 0 ? 'instagram' : chans.indexOf('facebook') >= 0 ? 'facebook' : c.phone ? 'whatsapp' : null;
    if (!via) { unreachable++; return; }
    var s = score[c.id];
    if (c.last_contact_at && Date.now() - new Date(c.last_contact_at).getTime() < 60 * 86400000) s.points += 5;
    people.push({ id: c.id, name: c.name, phone: c.phone, email: c.email, category: c.category, via: via, lastContactAt: c.last_contact_at,
      rep: c.account_manager_id ? { id: c.account_manager_id, name: c.rep_name } : null, score: Math.min(100, s.points), reasons: s.reasons, why: s.why });
  });
  people.sort(function (a, b) { return b.score - a.score || String(a.name).localeCompare(b.name); });
  return { product: product ? { id: product.id, name: product.name, category: product.category } : null, terms: terms, people: people.slice(0, 300),
    left: { optedOut: optedOut, unreachable: unreachable }, message: draft(product, q.text) };
}

function draft(product, text) {
  var what = product ? product.name : String(text || '').split(',')[0].trim() || 'our new product';
  return 'Hello {name}, this is {rep} from Bamboo Products. You asked us about bamboo products before, so we wanted you to be among the first to know: ' + what +
    ' is now available. Would you like the prices and photos? Reply here and we will send them.';
}

async function productsForPicker(ctx) {
  need(ctx, ['crm.read', 'marketing.read']);
  return (await productList()).map(function (p) { return { id: p.id, name: p.name, category: p.category }; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
}

// The chosen customers on each rep's follow-ups, with what to say. Customers
// with no rep go to whoever sends this.
async function handToReps(ctx, p) {
  need(ctx, ['crm.manage']);
  var ids = Array.from(new Set((p && p.customerIds) || [])).slice(0, 500);
  if (!ids.length) fail('invalid', 'Choose the customers.');
  var what = String((p && p.what) || '').trim().slice(0, 200);
  if (!what) fail('invalid', 'Say what to tell them about.');
  var on = p.on && /^\d{4}-\d{2}-\d{2}$/.test(p.on) ? p.on : new Date().toISOString().slice(0, 10);
  var note = 'Tell them about ' + what + (p.message ? ': ' + String(p.message).slice(0, 300) : '');
  var rows = (await pool.query(
    'UPDATE customers c SET follow_up_on = LEAST(COALESCE(c.follow_up_on, $2::date), $2::date), follow_up_note = $3 WHERE c.id = ANY($1) AND ' + SCOPE + ' AND NOT c.marketing_opt_out RETURNING c.id, c.account_manager_id',
    [ids, on, note])).rows;
  var byRep = {};
  rows.forEach(function (r) { var k = r.account_manager_id || me(ctx); (byRep[k] = byRep[k] || []).push(r.id); });
  for (var repId of Object.keys(byRep)) {
    if (repId && repId !== String(me(ctx))) {
      await notify(pool, repId, byRep[repId].length + ' customer(s) to tell about ' + what, 'They are on your follow-ups from ' + on + '.', '/crmfollowups');
    }
  }
  await audit(pool, ctx, 'crm.campaign', 'customer', 'many', 'Put ' + rows.length + ' customer(s) on their reps\' follow-ups to tell them about ' + what + '.');
  return { customers: rows.length, reps: Object.keys(byRep).length };
}

module.exports = { topics: topics, contentIdeas: contentIdeas, audience: audience, productsForPicker: productsForPicker, handToReps: handToReps, phrases: phrases };
