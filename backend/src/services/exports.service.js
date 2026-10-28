var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { loadLineItems } = require('../utils/documents');
var pdf = require('./documentPdf.service');

// Export papers (migration 0205): a shipment of Bamboo Products' goods
// abroad — usually from a sales order — with what goes (each line with its
// HS code), how it is packed (the packages: their marks, how many, the
// weights and sizes), how and where it travels (Incoterms 2020, the ports,
// the vessel and container), and the other papers it needs (the
// phytosanitary and fumigation certificates, the export permit, the customs
// entry, the bill of lading). Three documents are printed from it: the
// proforma invoice (for the buyer to pay against, with our bank details),
// the packing list (for the forwarder and customs) and the certificate of
// origin (filled in for the chamber or customs to certify and stamp).
// Products carry an HS code and a weight (migration 0205), which the
// shipment starts from.

var INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];
// The terms where the seller pays the main carriage (freight on the
// invoice), and those where the seller insures it.
var WITH_FREIGHT = ['CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];
var WITH_INSURANCE = ['CIF', 'CIP', 'DAP', 'DPU', 'DDP'];
var STATUSES = ['draft', 'proforma_sent', 'packed', 'shipped', 'cancelled'];
var MOVES = { draft: ['proforma_sent', 'packed', 'cancelled'], proforma_sent: ['packed', 'draft', 'cancelled'], packed: ['shipped', 'proforma_sent', 'cancelled'], shipped: ['packed'], cancelled: ['draft'] };
var PAPERS = [
  { key: 'phyto', label: 'Phytosanitary certificate' },
  { key: 'fumigation', label: 'Fumigation certificate' },
  { key: 'permit', label: 'Export permit' },
  { key: 'customs', label: 'Customs export declaration' },
  { key: 'origin', label: 'Certificate of origin (certified)' },
  { key: 'bl', label: 'Bill of lading / air waybill' }
];
var KINDS = ['carton', 'crate', 'pallet', 'bundle', 'bale', 'box', 'piece'];
// Bamboo's own headings, to choose from (the buyer's customs may want more digits).
var HS = [
  { code: '9403.82', what: 'Furniture of bamboo' },
  { code: '9401.41', what: 'Seats of bamboo, convertible into beds' },
  { code: '9401.51', what: 'Seats of bamboo' },
  { code: '4418.73', what: 'Assembled flooring panels of bamboo' },
  { code: '4421.91', what: 'Other articles of bamboo' },
  { code: '4602.11', what: 'Basketwork of bamboo' },
  { code: '4401.21', what: 'Bamboo chips and particles' },
  { code: '4402.10', what: 'Charcoal of bamboo' }
];

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function round3(n) { return Math.round(Number(n || 0) * 1000) / 1000; }
function num(v, max) { var n = Number(v); return n >= 0 && n < (max || 1e9) ? n : 0; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function xref(n) { return 'EXP-' + String(n).padStart(4, '0'); }
function canRead(ctx) { return ctx.can('sales.read'); }
function canManage(ctx) { return ctx.can('sales.manage'); }
function needRead(ctx) { if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (sales.read).'); }
function needManage(ctx) { if (!canManage(ctx)) fail('forbidden', 'Your role does not allow this action (sales.manage).'); }

function party(v) {
  v = v || {};
  return { name: text(v.name, 160), address: text(v.address, 400), country: text(v.country, 80), phone: text(v.phone, 40), email: text(v.email, 120), taxId: text(v.taxId, 60) };
}
function cleanLines(list) {
  return (Array.isArray(list) ? list : []).slice(0, 60).map(function (l) {
    var d = text(l && l.description, 200);
    if (!d) return null;
    return { description: d, hsCode: text(l.hsCode, 20), qty: round3(num(l.qty, 1e7)), unit: text(l.unit, 20) || 'pcs', unitPrice: round2(num(l.unitPrice, 1e9)), productId: uuidOr(l.productId) };
  }).filter(Boolean);
}
function cleanPackages(list) {
  return (Array.isArray(list) ? list : []).slice(0, 80).map(function (p) {
    var contents = text(p && p.contents, 200);
    var count = Math.round(num(p && p.count, 1e5));
    if (!contents && !count) return null;
    return { marks: text(p.marks, 80), count: Math.max(1, count), kind: KINDS.indexOf(p.kind) >= 0 ? p.kind : 'carton', contents: contents,
      netKg: round3(num(p.netKg, 1e6)), grossKg: round3(num(p.grossKg, 1e6)), l: round2(num(p.l, 1e4)), w: round2(num(p.w, 1e4)), h: round2(num(p.h, 1e4)) };
  }).filter(Boolean);
}
function cleanPapers(v, cur) {
  var out = {};
  PAPERS.forEach(function (p) {
    var x = (v && v[p.key]) || (cur && cur[p.key]) || {};
    out[p.key] = { done: !!x.done, ref: text(x.ref, 60), on: /^\d{4}-\d{2}-\d{2}$/.test(String(x.on || '')) ? x.on : null };
  });
  return out;
}

// The sums each document shows.
function totalsOf(s) {
  var lines = s.lines || [], packages = s.packages || [];
  var goods = round2(lines.reduce(function (a, l) { return a + Number(l.qty) * Number(l.unitPrice); }, 0));
  var freight = WITH_FREIGHT.indexOf(s.incoterm) >= 0 ? Number(s.freight) : 0;
  var insurance = WITH_INSURANCE.indexOf(s.incoterm) >= 0 ? Number(s.insurance) : 0;
  return {
    goods: goods, freight: round2(freight), insurance: round2(insurance), total: round2(goods + freight + insurance),
    packages: packages.reduce(function (a, p) { return a + Number(p.count); }, 0),
    netKg: round3(packages.reduce(function (a, p) { return a + Number(p.netKg) * Number(p.count); }, 0)),
    grossKg: round3(packages.reduce(function (a, p) { return a + Number(p.grossKg) * Number(p.count); }, 0)),
    cbm: round3(packages.reduce(function (a, p) { return a + Number(p.l) * Number(p.w) * Number(p.h) / 1e6 * Number(p.count); }, 0)),
    qty: round3(lines.reduce(function (a, l) { return a + Number(l.qty); }, 0))
  };
}

var SEL = 'SELECT x.*, so.order_no, c.name AS customer_name FROM export_shipments x LEFT JOIN sales_orders so ON so.id = x.sales_order_id LEFT JOIN customers c ON c.id = x.customer_id ';

function out(x) {
  var papers = cleanPapers(x.papers);
  var s = {
    id: x.id, ref: xref(x.number), status: x.status, salesOrder: x.sales_order_id ? { id: x.sales_order_id, orderNo: x.order_no } : null,
    customer: x.customer_id ? { id: x.customer_id, name: x.customer_name } : null, consignee: party(x.consignee), notify: party(x.notify), buyerRef: x.buyer_ref,
    currency: x.currency, incoterm: x.incoterm, incotermPlace: x.incoterm_place, transport: x.transport, portLoading: x.port_loading, portDischarge: x.port_discharge,
    finalDestination: x.final_destination, country: x.country, vessel: x.vessel, containerNo: x.container_no, sealNo: x.seal_no, blNo: x.bl_no,
    shipOn: dayText(x.ship_on), paymentTerms: x.payment_terms, validDays: x.valid_days, freight: Number(x.freight), insurance: Number(x.insurance),
    lines: x.lines || [], packages: x.packages || [], papers: papers, originCriterion: x.origin_criterion, note: x.note,
    proformaSentAt: x.proforma_sent_at, packedAt: x.packed_at, shippedAt: x.shipped_at, createdAt: x.created_at, updatedAt: x.updated_at
  };
  s.totals = totalsOf(s);
  s.papersDone = PAPERS.filter(function (p) { return papers[p.key].done; }).length;
  s.missingHs = s.lines.filter(function (l) { return !l.hsCode; }).length;
  return s;
}

async function rowOf(db, id) {
  var x = (await db.query(SEL + 'WHERE x.id = $1', [uuidOr(id)])).rows[0];
  if (!x) fail('notfound', 'That shipment is gone.');
  return x;
}

// GET /api/exports — the shipments; what can be started from; the year.
async function overview(ctx) {
  needRead(ctx);
  var rows = (await pool.query(SEL + "WHERE x.status <> 'cancelled' OR x.updated_at > now() - interval '60 days' ORDER BY (x.status IN ('draft', 'proforma_sent', 'packed')) DESC, coalesce(x.ship_on, x.created_at::date) DESC LIMIT 200")).rows.map(out);
  var year = today().slice(0, 4);
  var shipped = rows.filter(function (s) { return s.status === 'shipped' && String(s.shippedAt ? new Date(s.shippedAt).toISOString() : '').slice(0, 4) === year; });
  var byCurrency = {}, byCountry = {};
  shipped.forEach(function (s) {
    byCurrency[s.currency] = round2((byCurrency[s.currency] || 0) + s.totals.total);
    var k = s.country || s.consignee.country || '—';
    byCountry[k] = (byCountry[k] || 0) + 1;
  });
  var open = rows.filter(function (s) { return ['draft', 'proforma_sent', 'packed'].indexOf(s.status) >= 0; });
  var orders = canManage(ctx) ? (await pool.query(
    "SELECT s.id, s.order_no, s.currency, s.total, s.status, c.name FROM sales_orders s JOIN customers c ON c.id = s.customer_id " +
    "WHERE s.status <> 'cancelled' AND s.created_at > now() - interval '365 days' AND NOT EXISTS (SELECT 1 FROM export_shipments x WHERE x.sales_order_id = s.id AND x.status <> 'cancelled') ORDER BY s.created_at DESC LIMIT 60")).rows.map(function (o) {
    return { id: o.id, orderNo: o.order_no, name: o.name, currency: o.currency, total: Number(o.total), status: o.status };
  }) : [];
  return {
    shipments: rows, orders: orders, canManage: canManage(ctx), incoterms: INCOTERMS, papers: PAPERS, kinds: KINDS, hs: HS,
    byCurrency: Object.keys(byCurrency).map(function (c) { return { currency: c, total: byCurrency[c] }; }),
    byCountry: Object.keys(byCountry).map(function (c) { return { country: c, shipments: byCountry[c] }; }).sort(function (a, b) { return b.shipments - a.shipments; }),
    summary: {
      open: open.length, shippedYear: shipped.length,
      papersMissing: open.reduce(function (a, s) { return a + (PAPERS.length - s.papersDone); }, 0),
      sailingSoon: open.filter(function (s) { return s.shipOn && s.shipOn >= today() && s.shipOn <= new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10); }).length,
      noHs: open.reduce(function (a, s) { return a + s.missingHs; }, 0),
      next: open.filter(function (s) { return s.shipOn && s.shipOn >= today(); }).sort(function (a, b) { return a.shipOn < b.shipOn ? -1 : 1; })[0] || null
    }
  };
}

async function get(ctx, id) {
  needRead(ctx);
  return out(await rowOf(pool, id));
}

// POST /api/exports { salesOrderId } — a shipment for a sales order: its
// lines (with the products' HS codes), the buyer as consignee, and a package
// a line from the products' weights; or { } for one from nothing.
async function create(ctx, p) {
  needManage(ctx);
  p = p || {};
  var lines = [], packages = [], consignee = {}, customerId = null, currency = 'USD', orderId = uuidOr(p.salesOrderId), order = null;
  if (orderId) {
    order = (await pool.query('SELECT s.*, c.name, c.address, c.phone, c.email, c.tax_id, c.billing_address FROM sales_orders s JOIN customers c ON c.id = s.customer_id WHERE s.id = $1', [orderId])).rows[0];
    if (!order) fail('notfound', 'That sales order is gone.');
    if (order.status === 'cancelled') fail('conflict', 'That order is cancelled.');
    customerId = order.customer_id; currency = order.currency || 'USD';
    consignee = { name: order.name, address: order.billing_address || order.address || '', phone: order.phone || '', email: order.email || '', taxId: order.tax_id || '' };
    var items = await loadLineItems(pool, 'sales_order', order.id);
    var ids = items.map(function (i) { return i.productId; }).filter(Boolean);
    var prods = {};
    if (ids.length) (await pool.query('SELECT id, hs_code, weight_kg FROM products WHERE id = ANY($1::uuid[])', [ids])).rows.forEach(function (r) { prods[r.id] = r; });
    var initials = String(order.name || '').split(/\s+/).filter(function (w) { return /^[A-Za-z]/.test(w) && w !== 'Zq'; }).map(function (w) { return w[0].toUpperCase(); }).join('').slice(0, 4) || 'X';
    items.forEach(function (it, i) {
      var pr = prods[it.productId] || {};
      lines.push({ description: it.description, hsCode: pr.hs_code || '', qty: Number(it.qty), unit: it.unit || 'pcs', unitPrice: Number(it.unitPrice), productId: it.productId || null });
      var w = Number(pr.weight_kg) || 0;
      packages.push({ marks: 'BPL/' + initials + '/' + (i + 1), count: Math.max(1, Math.round(Number(it.qty))), kind: 'carton', contents: it.description, netKg: round3(w), grossKg: round3(w ? w * 1.15 : 0), l: 0, w: 0, h: 0 });
    });
  }
  var id = await withTransaction(async function (db) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('export_shipments'))");
    var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM export_shipments')).rows[0].n;
    var r = (await db.query(
      'INSERT INTO export_shipments (number, sales_order_id, customer_id, consignee, currency, port_loading, incoterm_place, lines, packages, papers, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
      [n, orderId, customerId, JSON.stringify(party(consignee)), currency, 'Tema, Ghana', 'Tema', JSON.stringify(cleanLines(lines)), JSON.stringify(cleanPackages(packages)), JSON.stringify(cleanPapers({})), me(ctx)])).rows[0];
    await audit(db, ctx, 'export.create', 'export_shipment', r.id, xref(n) + ' started' + (order ? ' for ' + order.order_no + ' (' + order.name + ')' : '') + '.');
    return r.id;
  });
  return get(ctx, id);
}

// PUT /api/exports/:id { …every field }
async function update(ctx, id, p) {
  needManage(ctx);
  p = p || {};
  var x = await rowOf(pool, id);
  if (x.status === 'shipped' || x.status === 'cancelled') fail('conflict', 'It is ' + x.status + ': open it again to change it.');
  function pick(k, col, fn) { return p[k] === undefined ? x[col] : fn(p[k]); }
  var incoterm = pick('incoterm', 'incoterm', function (v) { return INCOTERMS.indexOf(v) >= 0 ? v : fail('invalid', 'Which Incoterm?'); });
  var currency = pick('currency', 'currency', function (v) { return /^[A-Z]{3}$/.test(String(v)) ? v : fail('invalid', 'Which currency?'); });
  var lines = p.lines === undefined ? x.lines : cleanLines(p.lines);
  var packages = p.packages === undefined ? x.packages : cleanPackages(p.packages);
  var shipOn = pick('shipOn', 'ship_on', function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null; });
  await pool.query(
    'UPDATE export_shipments SET consignee = $2, notify = $3, buyer_ref = $4, currency = $5, incoterm = $6, incoterm_place = $7, transport = $8, port_loading = $9, port_discharge = $10, final_destination = $11, country = $12, ' +
    'vessel = $13, container_no = $14, seal_no = $15, bl_no = $16, ship_on = $17, payment_terms = $18, valid_days = $19, freight = $20, insurance = $21, lines = $22, packages = $23, papers = $24, origin_criterion = $25, note = $26, updated_at = now() WHERE id = $1',
    [x.id, JSON.stringify(p.consignee === undefined ? party(x.consignee) : party(p.consignee)), JSON.stringify(p.notify === undefined ? party(x.notify) : party(p.notify)),
      pick('buyerRef', 'buyer_ref', function (v) { return text(v, 80); }), currency, incoterm, pick('incotermPlace', 'incoterm_place', function (v) { return text(v, 80); }),
      pick('transport', 'transport', function (v) { return ['sea', 'air', 'road'].indexOf(v) >= 0 ? v : 'sea'; }),
      pick('portLoading', 'port_loading', function (v) { return text(v, 80); }), pick('portDischarge', 'port_discharge', function (v) { return text(v, 80); }),
      pick('finalDestination', 'final_destination', function (v) { return text(v, 120); }), pick('country', 'country', function (v) { return text(v, 80); }),
      pick('vessel', 'vessel', function (v) { return text(v, 80); }), pick('containerNo', 'container_no', function (v) { return text(v, 40).toUpperCase(); }),
      pick('sealNo', 'seal_no', function (v) { return text(v, 40); }), pick('blNo', 'bl_no', function (v) { return text(v, 60); }), shipOn,
      pick('paymentTerms', 'payment_terms', function (v) { return text(v, 300); }), pick('validDays', 'valid_days', function (v) { var n = Math.round(Number(v)); return n >= 1 && n <= 365 ? n : 30; }),
      pick('freight', 'freight', function (v) { return round2(num(v)); }), pick('insurance', 'insurance', function (v) { return round2(num(v)); }),
      JSON.stringify(lines), JSON.stringify(packages), JSON.stringify(cleanPapers(p.papers, x.papers)),
      pick('originCriterion', 'origin_criterion', function (v) { return v === 'worked' ? 'worked' : 'wholly'; }), pick('note', 'note', function (v) { return text(v, 1000); })]);
  await audit(pool, ctx, 'export.update', 'export_shipment', x.id, xref(x.number) + ' changed.');
  return get(ctx, x.id);
}

// POST /api/exports/:id/status { status }
async function setStatus(ctx, id, p) {
  needManage(ctx);
  var x = await rowOf(pool, id);
  var to = STATUSES.indexOf(p && p.status) >= 0 ? p.status : fail('invalid', 'Unknown status.');
  if (MOVES[x.status].indexOf(to) < 0) fail('conflict', 'It is ' + x.status.replace('_', ' ') + '.');
  var s = out(x);
  if (to !== 'cancelled' && to !== 'draft') {
    if (!s.lines.length) fail('invalid', 'Add what goes in it first.');
    if (!s.consignee.name) fail('invalid', 'Who is it going to? The consignee.');
  }
  if ((to === 'packed' || to === 'shipped') && !s.packages.length) fail('invalid', 'Add the packages: the packing list needs them.');
  if (to === 'shipped' && !(s.blNo || s.vessel)) fail('invalid', 'Give the bill of lading number or the vessel.');
  var col = { proforma_sent: 'proforma_sent_at', packed: 'packed_at', shipped: 'shipped_at' }[to];
  await pool.query('UPDATE export_shipments SET status = $2' + (col ? ', ' + col + ' = coalesce(' + col + ', now())' : '') + (to === 'shipped' ? ', ship_on = coalesce(ship_on, current_date)' : '') + ', updated_at = now() WHERE id = $1', [x.id, to]);
  await audit(pool, ctx, 'export.' + to, 'export_shipment', x.id, xref(x.number) + ': ' + to.replace('_', ' ') + '.');
  return get(ctx, x.id);
}

// ---- the three documents -----------------------------------------------------

// Spelled out for the proforma: "Twelve thousand and fifty US dollars and 50 cents".
var ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
var TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function under1000(n) {
  var h = Math.floor(n / 100), r = n % 100, out = [];
  if (h) out.push(ONES[h] + ' hundred');
  if (r) out.push((h ? 'and ' : '') + (r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : '')));
  return out.join(' ');
}
function words(n) {
  n = Math.floor(n);
  if (!n) return 'zero';
  var parts = [], scales = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  scales.forEach(function (s) { var k = Math.floor(n / s[0]); if (k) { parts.push(under1000(k) + ' ' + s[1]); n %= s[0]; } });
  if (n) parts.push((parts.length && n < 100 ? 'and ' : '') + under1000(n));
  return parts.join(' ');
}
var CURRENCY_WORDS = { USD: ['US dollars', 'cents'], EUR: ['euros', 'cents'], GBP: ['pounds sterling', 'pence'], GHS: ['Ghana cedis', 'pesewas'], CNY: ['yuan renminbi', 'fen'], XOF: ['CFA francs', 'centimes'], NGN: ['naira', 'kobo'] };
function amountInWords(amount, currency) {
  var w = CURRENCY_WORDS[currency] || [currency, 'cents'];
  var whole = Math.floor(Number(amount) + 1e-9), cents = Math.round((Number(amount) - whole) * 100);
  var s = words(whole) + ' ' + w[0] + (cents ? ' and ' + cents + ' ' + w[1] : ' only');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function seller() {
  var c = (await pool.query("SELECT name, legal_name, address, ghana_post_gps, phone, email, tax_id, payment_details FROM companies WHERE code = 'BPL'")).rows[0] || {};
  var commercial = ((await pool.query('SELECT commercial FROM settings WHERE id = 1')).rows[0] || {}).commercial || {};
  var bank = (c.payment_details && c.payment_details.instructions) || ((commercial.paymentDetails || {}).instructions) || '';
  return {
    name: c.legal_name || c.name || 'Bamboo Products Limited', tin: c.tax_id || '', bank: bank, email: c.email || '', phone: c.phone || '',
    address: [c.address, c.ghana_post_gps ? c.ghana_post_gps + ' (GhanaPostGPS)' : ''].filter(Boolean).join(', ') || 'Tema, Ghana'
  };
}
function partyLines(pt) { return [pt.name, pt.address, pt.country, pt.phone, pt.email, pt.taxId ? 'Tax ID: ' + pt.taxId : ''].filter(Boolean); }
function kv(doc, x, y, w, label, value) {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#6b6966').text(pdf.clean(label.toUpperCase()), x, y, { width: w });
  doc.font('Helvetica').fontSize(9.5).fillColor('#1d1d1b').text(pdf.clean(value || '—'), x, doc.y + 1, { width: w });
  return doc.y;
}
// A row of small labelled facts, four across.
function facts(doc, list) {
  var L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right, colW = W / 4, y0 = doc.y, ends = [];
  list.forEach(function (f, i) {
    var col = i % 4, x = L + col * colW;
    if (col === 0 && i) { y0 = Math.max.apply(null, ends) + 8; ends = []; }
    ends.push(kv(doc, x, y0, colW - 10, f[0], f[1]));
  });
  doc.y = Math.max.apply(null, ends) + 14;
}
// A plain table: cols [{ label, w (share), num }], rows [[cells]].
function table(doc, cols, rows, foot) {
  var L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
  function head() {
    var x = L, y = doc.y;
    doc.rect(L, y - 3, W, 18).fill('#f1f0ec');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#1d1d1b');
    cols.forEach(function (c) { var w = c.w * W; doc.text(pdf.clean(c.label), x + 4, y + 2, { width: w - 8, align: c.num ? 'right' : 'left', lineBreak: false, ellipsis: true }); x += w; });
    doc.y = y + 20;
  }
  head();
  rows.concat(foot ? [foot] : []).forEach(function (r, ri) {
    var isFoot = foot && ri === rows.length;
    doc.font(isFoot ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    var h = 0;
    cols.forEach(function (c, i) { h = Math.max(h, doc.heightOfString(pdf.clean(r[i] == null ? '' : String(r[i])), { width: c.w * W - 8 })); });
    if (doc.y + h + 8 > doc.page.height - doc.page.margins.bottom) { doc.addPage(); doc.y = doc.page.margins.top; head(); }
    var x = L, y = doc.y;
    cols.forEach(function (c, i) { var w = c.w * W; doc.fillColor(isFoot ? '#1d1d1b' : '#3a3a38').text(pdf.clean(r[i] == null ? '' : String(r[i])), x + 4, y, { width: w - 8, align: c.num ? 'right' : 'left' }); x += w; });
    doc.y = y + h + 5;
    doc.moveTo(L, doc.y - 2).lineTo(L + W, doc.y - 2).lineWidth(isFoot ? 1 : 0.5).strokeColor(isFoot ? '#bbbbbb' : '#e6e6e6').stroke();
    doc.y += 3;
  });
}
function kg(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' kg'; }
function qtyText(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 }); }
function headerFor(doc, sell, title, number, date) {
  var L = doc.page.margins.left, R = doc.page.width - doc.page.margins.right, top = doc.page.margins.top;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#1d1d1b').text(pdf.clean(sell.name), L, top, { width: 300 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#555555').text(pdf.clean(sell.address), L, doc.y + 2, { width: 300 });
  doc.text(pdf.clean([sell.phone, sell.email].filter(Boolean).join(' · ')), L, doc.y + 1, { width: 300 });
  if (sell.tin) doc.text('TIN: ' + pdf.clean(sell.tin), L, doc.y + 1, { width: 300 });
  var leftEnd = doc.y;
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#1d1d1b').text(pdf.clean(title), R - 240, top, { width: 240, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#4a4a4a').text(pdf.clean(number), R - 240, doc.y + 4, { width: 240, align: 'right' });
  doc.text(pdf.clean(date), R - 240, doc.y + 1, { width: 240, align: 'right' });
  doc.y = Math.max(leftEnd, doc.y) + 12;
  doc.rect(L, doc.y, R - L, 4).fill('#1f7a4d');
  doc.y += 16;
}
function twoParties(doc, a, aTitle, b, bTitle) {
  var L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right, colW = (W - 16) / 2, top = doc.y, ends = [];
  [[aTitle, a], [bTitle, b]].forEach(function (p, i) {
    var x = L + i * (colW + 16);
    doc.moveTo(x, top).lineTo(x + colW, top).lineWidth(1.2).strokeColor('#cccccc').stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b6966').text(pdf.clean(p[0].toUpperCase()), x, top + 5, { width: colW });
    doc.font('Helvetica').fontSize(9.5).fillColor('#1d1d1b');
    (p[1].length ? p[1] : ['—']).forEach(function (l) { doc.text(pdf.clean(l), x, doc.y + 2, { width: colW }); });
    ends.push(doc.y);
  });
  doc.y = Math.max.apply(null, ends) + 16;
}
function sign(doc, who, place) {
  if (doc.y + 70 > doc.page.height - doc.page.margins.bottom) { doc.addPage(); doc.y = doc.page.margins.top; }
  var L = doc.page.margins.left;
  doc.y += 26;
  doc.moveTo(L, doc.y).lineTo(L + 200, doc.y).lineWidth(0.6).strokeColor('#888888').stroke();
  doc.font('Helvetica').fontSize(8.5).fillColor('#4a4a4a').text(pdf.clean('Signed for ' + who + (place ? ' · ' + place : '')), L, doc.y + 4, { width: 300 });
}

async function document(ctx, id, which) {
  needRead(ctx);
  var s = out(await rowOf(pool, id));
  var sell = await seller();
  var t = s.totals;
  var made = (function () {
    var PDFDocument = require('pdfkit');
    var doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: { Title: which, Author: 'Bamboo OS' } });
    var chunks = [];
    doc.on('data', function (c) { chunks.push(c); });
    return { doc: doc, done: new Promise(function (res, rej) { doc.on('end', function () { res(Buffer.concat(chunks)); }); doc.on('error', rej); }) };
  })();
  var doc = made.doc, date = pdf.docDate(today()), n = String(s.ref).slice(4), m = function (v) { return pdf.money(v, s.currency); };
  var route = [s.portLoading, s.portDischarge].filter(Boolean).join(' to ');
  if (which === 'proforma') {
    headerFor(doc, sell, 'Proforma invoice', 'PI-' + n + (s.buyerRef ? ' · your ref. ' + s.buyerRef : ''), date);
    twoParties(doc, partyLines(s.consignee), 'Buyer / consignee', s.notify.name ? partyLines(s.notify) : ['Same as the consignee'], 'Notify party');
    facts(doc, [['Incoterms 2020', s.incoterm + (s.incotermPlace ? ' ' + s.incotermPlace : '')], ['Shipped by', s.transport], ['Loading / discharge', route], ['Final destination', s.finalDestination || s.country],
      ['Country of origin', 'Ghana'], ['Ready to ship', s.shipOn ? pdf.docDate(s.shipOn) : 'To agree'], ['Valid for', s.validDays + ' days'], ['Currency', s.currency]]);
    table(doc, [{ label: 'Description', w: 0.42 }, { label: 'HS code', w: 0.12 }, { label: 'Quantity', w: 0.14, num: true }, { label: 'Unit price', w: 0.15, num: true }, { label: 'Amount', w: 0.17, num: true }],
      s.lines.map(function (l) { return [l.description, l.hsCode || '—', qtyText(l.qty) + ' ' + l.unit, m(l.unitPrice), m(Number(l.qty) * Number(l.unitPrice))]; }));
    var L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
    function tot(label, v, big) {
      doc.font(big ? 'Helvetica-Bold' : 'Helvetica').fontSize(big ? 12 : 9.5).fillColor('#1d1d1b');
      var y = doc.y; doc.text(pdf.clean(label), L + W * 0.5, y, { width: W * 0.3 }); doc.text(pdf.clean(v), L + W * 0.8, y, { width: W * 0.2, align: 'right' }); doc.y += 3;
    }
    doc.y += 4;
    tot('Goods (' + (s.incoterm === 'EXW' ? 'EXW' : 'FOB value') + ')', m(t.goods));
    if (t.freight) tot('Freight', m(t.freight));
    if (t.insurance) tot('Insurance', m(t.insurance));
    tot('Total ' + s.incoterm + (s.incotermPlace ? ' ' + s.incotermPlace : ''), m(t.total), true);
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#4a4a4a').text(pdf.clean(amountInWords(t.total, s.currency)), L, doc.y + 6, { width: W });
    doc.y += 10;
    facts(doc, [['Packages', t.packages ? String(t.packages) : 'To follow'], ['Net weight', t.netKg ? kg(t.netKg) : '—'], ['Gross weight', t.grossKg ? kg(t.grossKg) : '—'], ['Volume', t.cbm ? t.cbm + ' m³' : '—']]);
    [['Payment terms', s.paymentTerms], ['Pay to', sell.bank], ['Notes', s.note]].forEach(function (x) {
      if (!x[1]) return;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1d1d1b').text(pdf.clean(x[0]), L, doc.y + 6, { width: W });
      doc.font('Helvetica').fontSize(9).fillColor('#4a4a4a').text(pdf.clean(x[1]), L, doc.y + 2, { width: W });
    });
    doc.font('Helvetica').fontSize(8).fillColor('#6b6966').text('This proforma invoice is not a demand for payment of VAT. The commercial invoice follows on shipment.', L, doc.y + 10, { width: W });
    sign(doc, sell.name);
  } else if (which === 'packing') {
    headerFor(doc, sell, 'Packing list', 'PL-' + n + ' · for PI-' + n, date);
    twoParties(doc, [sell.name, sell.address], 'Shipper', partyLines(s.consignee), 'Consignee');
    facts(doc, [['Loading / discharge', route], ['Vessel / flight', s.vessel], ['Container', s.containerNo], ['Seal', s.sealNo], ['B/L or AWB', s.blNo], ['Shipped on', s.shipOn ? pdf.docDate(s.shipOn) : '—'], ['Incoterms 2020', s.incoterm + (s.incotermPlace ? ' ' + s.incotermPlace : '')], ['Buyer\'s ref.', s.buyerRef]]);
    table(doc, [{ label: 'Marks & numbers', w: 0.17 }, { label: 'Packages', w: 0.13 }, { label: 'Contents', w: 0.26 }, { label: 'Net each', w: 0.1, num: true }, { label: 'Gross each', w: 0.11, num: true }, { label: 'Size (cm)', w: 0.13, num: true }, { label: 'm³', w: 0.1, num: true }],
      s.packages.map(function (p) { return [p.marks, p.count + ' ' + p.kind + (p.count === 1 ? '' : 's'), p.contents, kg(p.netKg), kg(p.grossKg), p.l && p.w && p.h ? p.l + '×' + p.w + '×' + p.h : '—', round3(p.l * p.w * p.h / 1e6 * p.count) || '—']; }),
      ['Total', t.packages + ' packages', '', kg(t.netKg), kg(t.grossKg), '', t.cbm || '—']);
    var L2 = doc.page.margins.left, W2 = doc.page.width - L2 - doc.page.margins.right;
    doc.font('Helvetica').fontSize(9).fillColor('#4a4a4a').text(pdf.clean('Total net weight ' + kg(t.netKg) + ', gross weight ' + kg(t.grossKg) + ', ' + t.cbm + ' m³ in ' + t.packages + ' packages.'), L2, doc.y + 8, { width: W2 });
    sign(doc, sell.name);
  } else if (which === 'origin') {
    headerFor(doc, sell, 'Certificate of origin', 'CO-' + n, date);
    var L3 = doc.page.margins.left, W3 = doc.page.width - L3 - doc.page.margins.right;
    twoParties(doc, [sell.name, sell.address, sell.tin ? 'TIN: ' + sell.tin : ''].filter(Boolean), '1. Exporter', partyLines(s.consignee), '2. Consignee');
    facts(doc, [['3. Means of transport', s.transport + (s.vessel ? ' · ' + s.vessel : '')], ['4. Port of loading', s.portLoading], ['5. Port of discharge', s.portDischarge], ['6. Country of destination', s.country || s.consignee.country],
      ['7. Country of origin', 'Republic of Ghana'], ['8. Invoice', 'PI-' + n + ' · ' + date], ['9. Container / seal', [s.containerNo, s.sealNo].filter(Boolean).join(' / ')], ['10. Origin criterion', s.originCriterion === 'worked' ? 'Sufficiently worked in Ghana' : 'Wholly obtained in Ghana']]);
    var marks = s.packages.map(function (p) { return p.marks; }).filter(Boolean).join(', ');
    table(doc, [{ label: '11. Marks and numbers', w: 0.2 }, { label: '12. Packages and description of the goods', w: 0.42 }, { label: '13. HS code', w: 0.13 }, { label: '14. Quantity / gross weight', w: 0.25, num: true }],
      s.lines.map(function (l, i) { return [i === 0 ? marks || '—' : '', l.description, l.hsCode || '—', qtyText(l.qty) + ' ' + l.unit]; }),
      ['', t.packages + ' packages in all', '', kg(t.grossKg) + ' gross']);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1d1d1b').text('15. Declaration by the exporter', L3, doc.y + 10, { width: W3 });
    doc.font('Helvetica').fontSize(9).fillColor('#3a3a38').text(pdf.clean('We, ' + sell.name + ', declare that the goods described above were ' + (s.originCriterion === 'worked' ? 'sufficiently worked or processed' : 'wholly obtained') + ' in the Republic of Ghana and that they meet the rules of origin for export to ' + (s.country || s.consignee.country || 'the country of destination') + '.'), L3, doc.y + 3, { width: W3 });
    sign(doc, sell.name, 'Tema, ' + date);
    doc.y += 18;
    var boxTop = doc.y;
    if (boxTop + 110 > doc.page.height - doc.page.margins.bottom) { doc.addPage(); boxTop = doc.page.margins.top; }
    doc.rect(L3, boxTop, W3, 100).lineWidth(0.8).dash(4, { space: 3 }).strokeColor('#999999').stroke().undash();
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1d1d1b').text('16. Certification', L3 + 10, boxTop + 8, { width: W3 - 20 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#6b6966').text('For the issuing authority (the chamber of commerce or customs): it is certified that the declaration by the exporter is correct. Stamp, signature, place and date.', L3 + 10, doc.y + 3, { width: W3 - 20 });
  } else fail('notfound', 'Which document?');
  var range = doc.bufferedPageRange();
  for (var i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    var keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor('#6b6966').text(pdf.clean(s.ref + ' · ' + sell.name + ' · made with Bamboo OS'), doc.page.margins.left, doc.page.height - 28, { width: 400, lineBreak: false });
    if (range.count > 1) doc.text('Page ' + (i + 1) + ' of ' + range.count, doc.page.margins.left, doc.page.height - 28, { width: doc.page.width - doc.page.margins.left * 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.end();
  var name = { proforma: 'proforma-PI-', packing: 'packing-list-PL-', origin: 'certificate-of-origin-CO-' }[which] + n + '.pdf';
  return { buffer: await made.done, filename: name };
}

module.exports = { overview: overview, get: get, create: create, update: update, setStatus: setStatus, document: document, totalsOf: totalsOf, amountInWords: amountInWords, INCOTERMS: INCOTERMS, PAPERS: PAPERS, HS: HS };
