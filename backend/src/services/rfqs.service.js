var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var scorecards = require('./scorecards.service');

// Requests for quotes (migration 0203): one request — what is wanted, how
// many, by when — to several suppliers, Bamboo Products' or a restaurant's.
// It goes out by WhatsApp (the buyer's phone opens the message) or email;
// each supplier's prices are typed in as they come (with a copy of their
// quote), shown side by side with the cheapest of each line, the total, how
// soon they deliver and their scorecard grade. The one awarded becomes the
// order: at Bamboo Products the purchase request is ordered from them (or
// one is made, ordered); at a restaurant, a draft purchase order with their
// prices, ready to send from the till's back office.

var MAX_LINES = 40;
var MAX_SUPPLIERS = 12;
var DAY = /^\d{4}-\d{2}-\d{2}$/;
var TYPES = { menu: 'restaurant_menu_items', ingredient: 'restaurant_ingredients', supply: 'restaurant_supplies' };

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function round3(n) { return Math.round(Number(n || 0) * 1000) / 1000; }
function round4(n) { return Math.round(Number(n || 0) * 10000) / 10000; }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function nameOf(first, last) { return first ? (first + ' ' + (last || '')).trim() : null; }
function money(n) { return 'GHS ' + round2(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function ref(n) { return 'RFQ-' + String(n).padStart(4, '0'); }
function seeBpl(ctx) { return ctx.can('procurement.approve') || ctx.can('supplier.manage') || ctx.can('supplier.read') || ctx.can('procurement.read.all'); }
function runBpl(ctx) { return ctx.can('procurement.approve') || ctx.can('supplier.manage'); }
function awardBpl(ctx) { return ctx.can('procurement.approve'); }
function runRest(ctx) { return ctx.can('restaurant.manage'); }
function canSee(ctx, kind) { return kind === 'restaurant' ? runRest(ctx) : seeBpl(ctx); }
function canRun(ctx, kind) { return kind === 'restaurant' ? runRest(ctx) : runBpl(ctx); }
function canAward(ctx, kind) { return kind === 'restaurant' ? runRest(ctx) : awardBpl(ctx); }
function needSee(ctx) { if (!seeBpl(ctx) && !runRest(ctx)) fail('forbidden', 'Your role does not allow this action (procurement.approve).'); }
function needRun(ctx, kind) { if (!canRun(ctx, kind)) fail('forbidden', 'Your role does not allow this action (' + (kind === 'restaurant' ? 'restaurant.manage' : 'procurement.approve') + ').'); }
function dayOr(v, label) {
  if (!v) return null;
  if (!DAY.test(String(v))) fail('invalid', label);
  return String(v);
}
function waNumber(v) { return require('./crmProductSheets.service').waNumber(v); }

var SEL = 'SELECT r.*, c.code AS company_code, c.name AS company_name, pr.item AS request_item, pr.status AS request_status, pr.requester_id, ' +
  'ce.first_name AS cb_first, ce.last_name AS cb_last, ae.first_name AS ab_first, ae.last_name AS ab_last, po.number AS po_number ' +
  'FROM rfqs r LEFT JOIN companies c ON c.id = r.company_id LEFT JOIN procurement_requests pr ON pr.id = r.request_id ' +
  'LEFT JOIN employees ce ON ce.id = r.created_by LEFT JOIN employees ae ON ae.id = r.awarded_by LEFT JOIN restaurant_purchase_orders po ON po.id = r.po_id ';

function headOut(r) {
  return {
    id: r.id, ref: ref(r.number), kind: r.kind, title: r.title, status: r.status, note: r.note,
    company: r.kind === 'restaurant' ? { id: r.company_id, code: r.company_code, name: r.company_name } : { id: null, code: 'BPL', name: 'Bamboo Products' },
    request: r.request_id ? { id: r.request_id, item: r.request_item, status: r.request_status } : null,
    neededBy: dayText(r.needed_by), replyBy: dayText(r.reply_by), createdAt: r.created_at, by: nameOf(r.cb_first, r.cb_last),
    awardedAt: r.awarded_at, awardedBy: nameOf(r.ab_first, r.ab_last), awardNote: r.award_note, awardedTo: r.awarded_to,
    po: r.po_id ? { id: r.po_id, ref: 'PO-' + r.po_number } : null
  };
}

// The quotes side by side: each supplier's prices, total and whether they
// priced everything; the cheapest of each line; the best value.
function compare(lines, sups, prices, grades) {
  var byS = {};
  prices.forEach(function (p) { (byS[p.rfq_supplier_id] = byS[p.rfq_supplier_id] || {})[p.line_id] = Number(p.unit_price); });
  var cheapest = {};
  lines.forEach(function (l) {
    var best = null;
    sups.forEach(function (s) { var v = (byS[s.id] || {})[l.id]; if (s.status === 'quoted' && v != null && (best == null || v < best)) best = v; });
    cheapest[l.id] = best;
  });
  var out = sups.map(function (s) {
    var mine = byS[s.id] || {};
    var priced = lines.filter(function (l) { return mine[l.id] != null; });
    var total = priced.reduce(function (a, l) { return a + mine[l.id] * Number(l.qty); }, 0);
    var g = grades[s.kind + ':' + s.supplier_id] || {};
    return {
      id: s.id, supplierId: s.supplier_id, name: s.name, phone: s.phone, email: s.email, status: s.status, sentAt: s.sent_at, quotedAt: s.quoted_at,
      deliveryDays: s.delivery_days, validUntil: dayText(s.valid_until), terms: s.terms, note: s.note, file: s.file ? { name: s.file.name, type: s.file.type } : null,
      prices: lines.map(function (l) { var v = mine[l.id]; return { lineId: l.id, unitPrice: v == null ? null : round4(v), amount: v == null ? null : round2(v * Number(l.qty)), cheapest: v != null && cheapest[l.id] != null && v === cheapest[l.id] }; }),
      total: s.status === 'quoted' ? round2(total) : null, complete: s.status === 'quoted' && priced.length === lines.length,
      priced: priced.length, score: g.score == null ? null : g.score, grade: g.grade || null,
      expired: !!(s.valid_until && dayText(s.valid_until) < today())
    };
  });
  var full = out.filter(function (s) { return s.complete && !s.expired; });
  var best = full.slice().sort(function (a, b) { return a.total - b.total; })[0] || null;
  // The best value: the cheapest, unless one graded higher is within 5% of it.
  var pick = best;
  if (best) full.forEach(function (s) {
    if (s.id !== best.id && s.total <= best.total * 1.05 && s.score != null && (best.score == null || s.score >= best.score + 10) && (!pick || pick.id === best.id || s.total < pick.total)) pick = s;
  });
  var dearest = full.slice().sort(function (a, b) { return b.total - a.total; })[0] || null;
  return { suppliers: out, cheapestId: best ? best.id : null, pickId: pick ? pick.id : null, spread: best && dearest ? round2(dearest.total - best.total) : null };
}

async function parts(ids) {
  if (!ids.length) return { lines: [], sups: [], prices: [] };
  var lines = (await pool.query('SELECT * FROM rfq_lines WHERE rfq_id = ANY($1) ORDER BY seq', [ids])).rows;
  var sups = (await pool.query('SELECT s.*, r.kind FROM rfq_suppliers s JOIN rfqs r ON r.id = s.rfq_id WHERE s.rfq_id = ANY($1) ORDER BY s.name', [ids])).rows;
  var prices = sups.length ? (await pool.query('SELECT * FROM rfq_prices WHERE rfq_supplier_id = ANY($1)', [sups.map(function (s) { return s.id; })])).rows : [];
  return { lines: lines, sups: sups, prices: prices };
}

function kindsFor(ctx) {
  var k = [];
  if (seeBpl(ctx)) k.push('bpl');
  if (runRest(ctx)) k.push('restaurant');
  return k;
}

// GET /api/rfqs?show=open|closed
async function overview(ctx, q) {
  needSee(ctx);
  q = q || {};
  var show = q.show === 'closed' ? 'closed' : 'open';
  var kinds = kindsFor(ctx);
  var rows = (await pool.query(SEL + 'WHERE r.kind = ANY($1) AND ' + (show === 'open' ? "r.status = 'open'" : "r.status <> 'open' AND coalesce(r.awarded_at, r.created_at) >= now() - interval '180 days'") + ' ORDER BY r.number DESC LIMIT 150', [kinds])).rows;
  var all = await parts(rows.map(function (r) { return r.id; }));
  var grades = await scorecards.grades(ctx, 365);
  var rfqs = rows.map(function (r) {
    var c = compare(all.lines.filter(function (l) { return l.rfq_id === r.id; }), all.sups.filter(function (s) { return s.rfq_id === r.id; }), all.prices, grades);
    var awarded = r.awarded_to ? c.suppliers.find(function (s) { return s.id === r.awarded_to; }) : null;
    var best = c.cheapestId ? c.suppliers.find(function (s) { return s.id === c.cheapestId; }) : null;
    return Object.assign(headOut(r), {
      lines: all.lines.filter(function (l) { return l.rfq_id === r.id; }).length,
      asked: c.suppliers.length, quoted: c.suppliers.filter(function (s) { return s.status === 'quoted'; }).length, declined: c.suppliers.filter(function (s) { return s.status === 'declined'; }).length,
      best: best ? { name: best.name, total: best.total, grade: best.grade } : null,
      awarded: awarded ? { name: awarded.name, total: awarded.total, grade: awarded.grade } : null, spread: c.spread,
      late: r.status === 'open' && r.reply_by && dayText(r.reply_by) < today() && c.suppliers.some(function (s) { return s.status === 'asked'; })
    });
  });
  // This month: what was awarded, and what choosing saved against the dearest full quote.
  var monthStart = today().slice(0, 8) + '01';
  var month = (await pool.query(SEL + "WHERE r.kind = ANY($1) AND r.status = 'awarded' AND r.awarded_at >= $2::date", [kinds, monthStart])).rows;
  var mp = await parts(month.map(function (r) { return r.id; }));
  var saved = 0, spent = 0;
  month.forEach(function (r) {
    var c = compare(mp.lines.filter(function (l) { return l.rfq_id === r.id; }), mp.sups.filter(function (s) { return s.rfq_id === r.id; }), mp.prices, {});
    var won = c.suppliers.find(function (s) { return s.id === r.awarded_to; });
    var full = c.suppliers.filter(function (s) { return s.complete; });
    if (won && won.total != null) {
      spent += won.total;
      var dearest = full.reduce(function (a, s) { return Math.max(a, s.total); }, 0);
      if (dearest > won.total) saved += dearest - won.total;
    }
  });
  var open = show === 'open' ? rfqs : (await pool.query("SELECT count(*)::int AS n FROM rfqs WHERE status = 'open' AND kind = ANY($1)", [kinds])).rows[0].n;
  return {
    rfqs: rfqs, show: show, kinds: kinds,
    canRun: { bpl: runBpl(ctx), restaurant: runRest(ctx) }, canAward: { bpl: awardBpl(ctx), restaurant: runRest(ctx) },
    summary: {
      open: Array.isArray(open) ? open.length : open,
      waiting: Array.isArray(open) ? open.reduce(function (a, r) { return a + (r.asked - r.quoted - r.declined); }, 0) : null,
      toCompare: Array.isArray(open) ? open.filter(function (r) { return r.quoted >= 2; }).length : null,
      late: Array.isArray(open) ? open.filter(function (r) { return r.late; }).length : null,
      awardedMonth: month.length, spentMonth: round2(spent), savedMonth: round2(saved)
    }
  };
}

// GET /api/rfqs/options — what a new request can be made from.
async function options(ctx) {
  needSee(ctx);
  var grades = await scorecards.grades(ctx, 365);
  var out = { bpl: null, restaurants: [] };
  if (runBpl(ctx)) {
    out.bpl = {
      suppliers: (await pool.query("SELECT id, name, phone, email, materials_supplied FROM suppliers WHERE status = 'active' ORDER BY name")).rows.map(function (s) {
        var g = grades['bpl:' + s.id] || {};
        return { id: s.id, name: s.name, phone: s.phone, email: s.email, supplies: s.materials_supplied, grade: g.grade || null, score: g.score == null ? null : g.score };
      }),
      requests: (await pool.query(
        "SELECT pr.id, pr.item, pr.quantity, pr.estimated_price, pr.required_date, e.first_name, e.last_name FROM procurement_requests pr JOIN employees e ON e.id = pr.requester_id " +
        "WHERE pr.status = 'approved' AND NOT EXISTS (SELECT 1 FROM rfqs r WHERE r.request_id = pr.id AND r.status <> 'cancelled') ORDER BY pr.created_at DESC LIMIT 60")).rows.map(function (r) {
        return { id: r.id, item: r.item, qty: Number(r.quantity), estimate: round2(r.estimated_price), neededBy: dayText(r.required_date), by: nameOf(r.first_name, r.last_name) };
      })
    };
  }
  if (runRest(ctx)) {
    var cos = (await pool.query("SELECT DISTINCT c.id, c.code, c.name FROM companies c WHERE EXISTS (SELECT 1 FROM restaurant_suppliers s WHERE s.company_id = c.id) OR EXISTS (SELECT 1 FROM restaurant_ingredients i WHERE i.company_id = c.id) ORDER BY c.name")).rows;
    for (var i = 0; i < cos.length; i++) {
      var c = cos[i];
      var sups = (await pool.query('SELECT id, name, phone, email FROM restaurant_suppliers WHERE company_id = $1 AND active ORDER BY name', [c.id])).rows;
      var items = (await pool.query(
        "SELECT 'ingredient' AS type, id, name, unit, unit_cost, stock_qty, reorder_level AS level FROM restaurant_ingredients WHERE company_id = $1 AND active " +
        "UNION ALL SELECT 'supply', id, name, unit, unit_cost, stock_qty, reorder_level FROM restaurant_supplies WHERE company_id = $1 AND active " +
        "UNION ALL SELECT 'menu', id, name, 'each', unit_cost, stock_qty, low_stock FROM restaurant_menu_items WHERE company_id = $1 AND track_stock AND active ORDER BY 3", [c.id])).rows;
      out.restaurants.push({
        id: c.id, code: c.code, name: c.name,
        suppliers: sups.map(function (s) { var g = grades['restaurant:' + s.id] || {}; return { id: s.id, name: s.name, phone: s.phone, email: s.email, grade: g.grade || null, score: g.score == null ? null : g.score }; }),
        items: items.map(function (it) { return { type: it.type, id: it.id, name: it.name, unit: it.unit || '', cost: round4(it.unit_cost), stock: round3(it.stock_qty), low: it.level != null && Number(it.stock_qty) <= Number(it.level) }; })
      });
    }
  }
  return out;
}

async function rfqRow(db, ctx, id, lock) {
  var r = (await db.query(SEL + 'WHERE r.id = $1', [uuidOr(id)])).rows[0];
  if (!r || !canSee(ctx, r.kind)) fail('notfound', 'That request for quotes is gone, or not yours to see.');
  if (lock) await db.query('SELECT 1 FROM rfqs WHERE id = $1 FOR UPDATE', [r.id]);
  return r;
}

// The message that goes to a supplier.
function words(r, lines, s) {
  var from = r.kind === 'restaurant' ? r.company_name : 'Bamboo Products Limited';
  var out = ['Hello ' + s.name + ',', '', from + ' asks for your best price for (' + ref(r.number) + ', ' + r.title + '):'];
  lines.forEach(function (l, i) { out.push((i + 1) + '. ' + l.name + ' — ' + round3(l.qty) + (l.unit ? ' ' + l.unit : '')); });
  out.push('');
  if (r.needed_by) out.push('Needed by ' + dayText(r.needed_by) + '.');
  if (r.reply_by) out.push('Please reply by ' + dayText(r.reply_by) + ' with your price for each, how soon you can deliver and how long the price holds.');
  else out.push('Please reply with your price for each, how soon you can deliver and how long the price holds.');
  if (r.note) out.push(r.note);
  out.push('', 'Thank you.');
  return out.join('\n');
}

// GET /api/rfqs/:id
async function get(ctx, id) {
  needSee(ctx);
  var r = await rfqRow(pool, ctx, id);
  var p = await parts([r.id]);
  var grades = await scorecards.grades(ctx, 365);
  var c = compare(p.lines, p.sups, p.prices, grades);
  return Object.assign(headOut(r), {
    lines: p.lines.map(function (l) { return { id: l.id, name: l.name, qty: round3(l.qty), unit: l.unit, itemType: l.item_type, itemId: l.item_id }; }),
    suppliers: c.suppliers.map(function (s) {
      var sup = p.sups.find(function (x) { return x.id === s.id; });
      var wa = waNumber(s.phone);
      return Object.assign(s, { message: words(r, p.lines, sup), wa: wa ? 'https://wa.me/' + wa + '?text=' + encodeURIComponent(words(r, p.lines, sup)) : null });
    }),
    cheapestId: c.cheapestId, pickId: c.pickId, spread: c.spread,
    canRun: canRun(ctx, r.kind), canAward: canAward(ctx, r.kind), emailOn: require('./mail.service').configured()
  });
}

async function supplierRows(db, kind, companyId, ids) {
  var list = Array.from(new Set((Array.isArray(ids) ? ids : []).map(uuidOr).filter(Boolean)));
  if (!list.length) fail('invalid', 'Pick the suppliers to ask: two or more is best.');
  if (list.length > MAX_SUPPLIERS) fail('invalid', 'At most ' + MAX_SUPPLIERS + ' suppliers on one request.');
  var rows = kind === 'restaurant'
    ? (await db.query('SELECT id, name, phone, email FROM restaurant_suppliers WHERE id = ANY($1) AND company_id = $2', [list, companyId])).rows
    : (await db.query('SELECT id, name, phone, email FROM suppliers WHERE id = ANY($1)', [list])).rows;
  if (rows.length !== list.length) fail('invalid', 'A supplier picked is gone, or not this restaurant\'s.');
  return rows;
}

// POST /api/rfqs { kind, companyId, title, requestId, neededBy, replyBy, note, lines, supplierIds }
async function create(ctx, p) {
  p = p || {};
  var kind = p.kind === 'restaurant' ? 'restaurant' : 'bpl';
  needRun(ctx, kind);
  var title = text(p.title, 120);
  var neededBy = dayOr(p.neededBy, 'The day it is needed by is not a date.');
  var replyBy = dayOr(p.replyBy, 'The day to reply by is not a date.') || addDays(today(), 3);
  var asked = Array.isArray(p.lines) ? p.lines : [];
  if (!asked.length) fail('invalid', 'Add what you want prices for.');
  if (asked.length > MAX_LINES) fail('invalid', 'At most ' + MAX_LINES + ' lines on one request.');
  var id = await withTransaction(async function (db) {
    var companyId = null, request = null;
    if (kind === 'restaurant') {
      companyId = uuidOr(p.companyId);
      if (!companyId || !(await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId])).rows[0]) fail('invalid', 'Which restaurant is it for?');
    } else if (p.requestId) {
      request = (await db.query('SELECT * FROM procurement_requests WHERE id = $1 FOR UPDATE', [uuidOr(p.requestId)])).rows[0];
      if (!request) fail('invalid', 'That purchase request is gone.');
      if (request.status !== 'approved') fail('conflict', 'Only an approved purchase request can go out for quotes.');
    }
    var lines = [];
    for (var i = 0; i < asked.length; i++) {
      var a = asked[i] || {};
      var qty = round3(a.qty);
      if (!(qty > 0 && qty < 1e7)) fail('invalid', 'Line ' + (i + 1) + ': how many?');
      if (kind === 'restaurant') {
        var table = TYPES[a.type];
        var it = table && (await db.query('SELECT id, name, ' + (a.type === 'menu' ? "'each' AS unit" : 'unit') + ' FROM ' + table + ' WHERE id = $1 AND company_id = $2', [uuidOr(a.id), companyId])).rows[0];
        if (!it) fail('invalid', 'Line ' + (i + 1) + ': pick it from the restaurant\'s stock.');
        lines.push({ name: it.name, qty: qty, unit: it.unit || '', type: a.type, itemId: it.id });
      } else {
        var name = text(a.name, 120);
        if (!name) fail('invalid', 'Line ' + (i + 1) + ': what is it?');
        lines.push({ name: name, qty: qty, unit: text(a.unit, 20), type: null, itemId: null });
      }
    }
    if (!title) title = lines.length === 1 ? lines[0].name : lines[0].name + ' and ' + (lines.length - 1) + ' more';
    var sups = await supplierRows(db, kind, companyId, p.supplierIds);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('rfqs'))");
    var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM rfqs')).rows[0].n;
    var r = (await db.query(
      'INSERT INTO rfqs (number, kind, company_id, title, request_id, needed_by, reply_by, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [n, kind, companyId, title, request ? request.id : null, neededBy || (request ? dayText(request.required_date) : null), replyBy, text(p.note, 500), me(ctx)])).rows[0];
    for (var j = 0; j < lines.length; j++) {
      await db.query('INSERT INTO rfq_lines (rfq_id, name, qty, unit, item_type, item_id, seq) VALUES ($1,$2,$3,$4,$5,$6,$7)', [r.id, lines[j].name, lines[j].qty, lines[j].unit, lines[j].type, lines[j].itemId, j]);
    }
    for (var k = 0; k < sups.length; k++) {
      await db.query('INSERT INTO rfq_suppliers (rfq_id, supplier_id, name, phone, email) VALUES ($1,$2,$3,$4,$5)', [r.id, sups[k].id, sups[k].name, sups[k].phone || '', sups[k].email || '']);
    }
    await audit(db, ctx, 'rfq.create', 'rfq', r.id, 'Asked ' + sups.length + ' suppliers for prices: ' + ref(n) + ', ' + title + '.');
    return r.id;
  });
  return get(ctx, id);
}

// POST /api/rfqs/:id/suppliers { supplierIds } — more suppliers asked.
async function addSuppliers(ctx, id, p) {
  await withTransaction(async function (db) {
    var r = await rfqRow(db, ctx, id, true);
    needRun(ctx, r.kind);
    if (r.status !== 'open') fail('conflict', 'The request is closed.');
    var sups = await supplierRows(db, r.kind, r.company_id, (p || {}).supplierIds);
    var have = (await db.query('SELECT count(*)::int AS n FROM rfq_suppliers WHERE rfq_id = $1', [r.id])).rows[0].n;
    if (have + sups.length > MAX_SUPPLIERS) fail('invalid', 'At most ' + MAX_SUPPLIERS + ' suppliers on one request.');
    for (var k = 0; k < sups.length; k++) {
      await db.query('INSERT INTO rfq_suppliers (rfq_id, supplier_id, name, phone, email) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [r.id, sups[k].id, sups[k].name, sups[k].phone || '', sups[k].email || '']);
    }
    await audit(db, ctx, 'rfq.suppliers', 'rfq', r.id, 'Asked ' + sups.map(function (s) { return s.name; }).join(', ') + ' too.');
  });
  return get(ctx, id);
}

async function rowOf(db, r, rfqSupplierId) {
  var s = (await db.query('SELECT * FROM rfq_suppliers WHERE id = $1 AND rfq_id = $2 FOR UPDATE', [uuidOr(rfqSupplierId), r.id])).rows[0];
  if (!s) fail('notfound', 'That supplier is not on this request.');
  return s;
}

// POST /api/rfqs/:id/send { rfqSupplierId, via: 'email' | 'whatsapp' }
async function send(ctx, id, p) {
  p = p || {};
  var out = {};
  await withTransaction(async function (db) {
    var r = await rfqRow(db, ctx, id, true);
    needRun(ctx, r.kind);
    if (r.status !== 'open') fail('conflict', 'The request is closed.');
    var s = await rowOf(db, r, p.rfqSupplierId);
    var lines = (await db.query('SELECT * FROM rfq_lines WHERE rfq_id = $1 ORDER BY seq', [r.id])).rows;
    var body = words(r, lines, s);
    if (p.via === 'email') {
      var mail = require('./mail.service');
      if (!mail.isEmail(s.email)) fail('invalid', s.name + ' has no email address: send it by WhatsApp.');
      await mail.send({ to: s.email, subject: ref(r.number) + ': request for a quote — ' + r.title, text: body, fromName: r.kind === 'restaurant' ? r.company_name : 'Bamboo Products Limited' });
      out.sent = 'email';
    } else {
      var wa = waNumber(s.phone);
      if (!wa) fail('invalid', s.name + ' has no phone number WhatsApp can use.');
      out.wa = 'https://wa.me/' + wa + '?text=' + encodeURIComponent(body);
      out.sent = 'whatsapp';
    }
    await db.query('UPDATE rfq_suppliers SET sent_at = now() WHERE id = $1', [s.id]);
    await audit(db, ctx, 'rfq.send', 'rfq', r.id, ref(r.number) + ' sent to ' + s.name + ' by ' + (out.sent === 'email' ? 'email' : 'WhatsApp') + '.');
  });
  return Object.assign(await get(ctx, id), out);
}

// POST /api/rfqs/:id/quote { rfqSupplierId, prices: { lineId: unitPrice }, deliveryDays, validUntil, terms, note, file: { dataUrl, name }, declined }
async function quote(ctx, id, p) {
  p = p || {};
  await withTransaction(async function (db) {
    var r = await rfqRow(db, ctx, id, true);
    needRun(ctx, r.kind);
    if (r.status !== 'open') fail('conflict', 'The request is closed: the quotes cannot change.');
    var s = await rowOf(db, r, p.rfqSupplierId);
    if (p.declined) {
      await db.query("DELETE FROM rfq_prices WHERE rfq_supplier_id = $1", [s.id]);
      await db.query("UPDATE rfq_suppliers SET status = 'declined', quoted_at = now(), total = NULL, note = $2 WHERE id = $1", [s.id, text(p.note, 300)]);
      await audit(db, ctx, 'rfq.declined', 'rfq', r.id, s.name + ' will not quote for ' + ref(r.number) + '.');
      return;
    }
    var lines = (await db.query('SELECT * FROM rfq_lines WHERE rfq_id = $1 ORDER BY seq', [r.id])).rows;
    var given = p.prices && typeof p.prices === 'object' ? p.prices : {};
    var priced = [];
    lines.forEach(function (l) {
      var v = given[l.id];
      if (v === '' || v == null) return;
      var n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1e8) fail('invalid', l.name + ': the price for one must be a number, 0 or more.');
      priced.push({ line: l, price: round4(n) });
    });
    if (!priced.length) fail('invalid', 'Type at least one price, or mark that they will not quote.');
    var days = p.deliveryDays === '' || p.deliveryDays == null ? null : Math.round(Number(p.deliveryDays));
    if (days != null && !(days >= 0 && days <= 365)) fail('invalid', 'The days to deliver must be 0 to 365.');
    var valid = dayOr(p.validUntil, 'The day the price holds to is not a date.');
    var file = s.file;
    if (p.file && p.file.dataUrl) file = await require('./licences.service').keepFile(p.file.dataUrl, p.file.name, 'rfq');
    else if (p.file === null) file = null;
    await db.query('DELETE FROM rfq_prices WHERE rfq_supplier_id = $1', [s.id]);
    for (var i = 0; i < priced.length; i++) await db.query('INSERT INTO rfq_prices (rfq_supplier_id, line_id, unit_price) VALUES ($1,$2,$3)', [s.id, priced[i].line.id, priced[i].price]);
    var total = round2(priced.reduce(function (a, x) { return a + x.price * Number(x.line.qty); }, 0));
    await db.query("UPDATE rfq_suppliers SET status = 'quoted', quoted_at = now(), delivery_days = $2, valid_until = $3, terms = $4, note = $5, file = $6, total = $7 WHERE id = $1",
      [s.id, days, valid, text(p.terms, 200), text(p.note, 300), file ? JSON.stringify(file) : null, total]);
    await audit(db, ctx, 'rfq.quote', 'rfq', r.id, s.name + ' quoted ' + money(total) + ' for ' + ref(r.number) + '.');
  });
  return get(ctx, id);
}

// GET /api/rfqs/:id/file/:rfqSupplierId — the supplier's own quote.
async function fileOf(ctx, id, rfqSupplierId) {
  needSee(ctx);
  var r = await rfqRow(pool, ctx, id);
  var s = (await pool.query('SELECT file FROM rfq_suppliers WHERE id = $1 AND rfq_id = $2', [uuidOr(rfqSupplierId), r.id])).rows[0];
  if (!s || !s.file) fail('notfound', 'No copy of that quote.');
  return s.file;
}

// POST /api/rfqs/:id/award { rfqSupplierId, note }
async function award(ctx, id, p) {
  p = p || {};
  var told = null;
  await withTransaction(async function (db) {
    var r = await rfqRow(db, ctx, id, true);
    if (!canAward(ctx, r.kind)) fail('forbidden', 'Your role does not allow this action (' + (r.kind === 'restaurant' ? 'restaurant.manage' : 'procurement.approve') + ').');
    if (r.status !== 'open') fail('conflict', 'It was ' + (r.status === 'awarded' ? 'awarded' : 'cancelled') + ' already.');
    var s = await rowOf(db, r, p.rfqSupplierId);
    if (s.status !== 'quoted') fail('conflict', s.name + ' has not quoted.');
    var lines = (await db.query('SELECT * FROM rfq_lines WHERE rfq_id = $1 ORDER BY seq', [r.id])).rows;
    var prices = {};
    (await db.query('SELECT * FROM rfq_prices WHERE rfq_supplier_id = $1', [s.id])).rows.forEach(function (x) { prices[x.line_id] = Number(x.unit_price); });
    var missing = lines.filter(function (l) { return prices[l.id] == null; });
    if (missing.length) fail('conflict', s.name + ' has not priced ' + missing.map(function (l) { return l.name; }).join(', ') + '.');
    var total = round2(lines.reduce(function (a, l) { return a + prices[l.id] * Number(l.qty); }, 0));
    var note = text(p.note, 300);
    var poId = null;
    if (r.kind === 'restaurant') {
      var purchasing = require('./restaurantPurchasing.service');
      var sup = (await db.query('SELECT * FROM restaurant_suppliers WHERE id = $1 AND company_id = $2', [s.supplier_id, r.company_id])).rows[0];
      var poLines = lines.map(function (l) { return { type: l.item_type, id: l.item_id, name: l.name, unit: l.unit, qty: round3(l.qty), unitCost: prices[l.id] }; });
      var po = await purchasing.newOrder(db, r.company_id, { id: me(ctx) }, sup || { id: null, name: s.name, phone: s.phone, email: s.email }, poLines,
        'From ' + ref(r.number) + (note ? ': ' + note : ''), s.delivery_days != null ? addDays(today(), s.delivery_days) : dayText(r.needed_by));
      poId = po.id;
    } else if (r.request_id) {
      var req = (await db.query('SELECT * FROM procurement_requests WHERE id = $1 FOR UPDATE', [r.request_id])).rows[0];
      if (req && req.status === 'approved') {
        await db.query("UPDATE procurement_requests SET status = 'ordered', supplier_id = $2, supplier_name = $3, actual_cost = $4, ordered_at = now(), ordered_by = $5 WHERE id = $1",
          [req.id, s.supplier_id, s.name, total, me(ctx)]);
        told = { to: req.requester_id, title: 'Purchase ordered', body: req.item + ' has been ordered from ' + s.name + ' (' + ref(r.number) + ').' };
      }
    } else {
      // No request behind it: the order is made one, approved and ordered.
      var qty = lines.length === 1 ? round2(lines[0].qty) : 1;
      await db.query(
        "INSERT INTO procurement_requests (requester_id, item, quantity, estimated_price, reason, required_date, priority, status, decided_by, decided_at, decision_note, supplier_id, supplier_name, actual_cost, ordered_at, ordered_by) " +
        "VALUES ($1,$2,$3,$4,$5,$6,'medium','ordered',$1,now(),$7,$8,$9,$4,now(),$1)",
        [me(ctx), r.title.slice(0, 200), qty, total, 'From ' + ref(r.number), dayText(r.needed_by), 'Awarded on ' + ref(r.number), s.supplier_id, s.name]);
    }
    await db.query("UPDATE rfqs SET status = 'awarded', awarded_to = $2, awarded_at = now(), awarded_by = $3, award_note = $4, po_id = $5 WHERE id = $1", [r.id, s.id, me(ctx), note, poId]);
    await audit(db, ctx, 'rfq.award', 'rfq', r.id, ref(r.number) + ' awarded to ' + s.name + ' for ' + money(total) + '.');
    if (told && told.to) await notify(db, told.to, told.title, told.body, 'procurement');
  });
  return get(ctx, id);
}

// POST /api/rfqs/:id/cancel { reason }
async function cancel(ctx, id, p) {
  await withTransaction(async function (db) {
    var r = await rfqRow(db, ctx, id, true);
    needRun(ctx, r.kind);
    if (r.status !== 'open') fail('conflict', 'It is closed already.');
    var reason = text((p || {}).reason, 300);
    if (!reason) fail('invalid', 'Why is it cancelled?');
    await db.query("UPDATE rfqs SET status = 'cancelled', award_note = $2 WHERE id = $1", [r.id, reason]);
    await audit(db, ctx, 'rfq.cancel', 'rfq', r.id, 'Cancelled ' + ref(r.number) + ': ' + reason);
  });
  return get(ctx, id);
}

module.exports = { overview: overview, options: options, get: get, create: create, addSuppliers: addSuppliers, send: send, quote: quote, fileOf: fileOf, award: award, cancel: cancel, compare: compare };
