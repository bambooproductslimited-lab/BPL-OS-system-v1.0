var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var visits = require('./bplVisits.service');

// Warranty claims (migration 0205): something wrong with a piece of BPL
// furniture, judged against its warranty. A claim is opened from a
// customer's repair request (Deliveries and fitting → repairs) or by staff
// on a sales order or a shop order. It is dated from the delivery, so
// whether it is still under warranty (the settings' months) is known at
// once. Staff find the cause, decide — accepted, goodwill (outside the
// warranty or the terms, but we cover it) or turned down — and choose the
// remedy: repair, replace, refund or a credit. A repair visit is booked from
// the claim (the crew sign it off as for any visit); once done, the claim
// is resolved, with what it cost us and whether the customer was happy.
// The customer is told each decision; quality is told of a fault in the
// making (a joint, the finish, the timber, the fittings), with the product,
// so it can be looked at in the workshop.

var CAUSES = ['manufacturing', 'material', 'finish', 'hardware', 'transit', 'installation', 'misuse', 'wear', 'other'];
var OUR_FAULT = ['manufacturing', 'material', 'finish', 'hardware'];
var DECISIONS = ['accepted', 'goodwill', 'rejected'];
var REMEDIES = ['repair', 'replace', 'refund', 'credit', 'none'];
var CAUSE_WORDS = { manufacturing: 'a fault in the making', material: 'the material', finish: 'the finish', hardware: 'the fittings', transit: 'damage in transit', installation: 'the installation', misuse: 'misuse', wear: 'normal wear', other: 'another cause' };
var REMEDY_WORDS = { repair: 'we will repair it', replace: 'we will replace it', refund: 'we will refund you', credit: 'we will credit your account', none: '' };
var MAX_PHOTOS = 6;

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : ''; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function wref(n) { return 'W-' + String(n).padStart(4, '0'); }
function addMonths(day, n) { var d = new Date(day + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function canRead(ctx) { return ctx.can('invoice.read'); }
function canManage(ctx) { return ctx.can('invoice.manage'); }
function needRead(ctx) { if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (invoice.read).'); }
function needManage(ctx) { if (!canManage(ctx)) fail('forbidden', 'Your role does not allow this action (invoice.manage).'); }

var SEL = 'SELECT w.*, p.name AS product_name, p.sku, so.order_no AS sales_order_no, sh.order_no AS shop_order_no, r.number AS service_number, ' +
  'e.first_name AS d_first, e.last_name AS d_last, ' +
  "(SELECT count(*)::int FROM bpl_visits v WHERE v.claim_id = w.id AND v.status <> 'cancelled') AS visits, " +
  "(SELECT min(v.day) FROM bpl_visits v WHERE v.claim_id = w.id AND v.status IN ('planned', 'on_way', 'arrived')) AS next_visit " +
  'FROM warranty_claims w LEFT JOIN products p ON p.id = w.product_id LEFT JOIN sales_orders so ON so.id = w.sales_order_id ' +
  'LEFT JOIN shop_orders sh ON sh.id = w.shop_order_id LEFT JOIN bpl_service_requests r ON r.id = w.service_id LEFT JOIN employees e ON e.id = w.decided_by ';

function claimOut(w) {
  var until = dayText(w.warranty_until), opened = dayText(w.created_at);
  var cost = round2(Number(w.cost_parts) + Number(w.cost_labour) + Number(w.cost_transport) + Number(w.refund_amount));
  return {
    id: w.id, ref: wref(w.number), status: w.status, decision: w.decision, cause: w.cause, remedy: w.remedy,
    name: w.name, phone: w.phone, email: w.email, address: w.address,
    product: w.product_id ? { id: w.product_id, name: w.product_name, sku: w.sku } : null, item: w.item || (w.product_name || ''),
    problem: w.problem, photos: (w.photos || []).length,
    deliveredOn: dayText(w.delivered_on), warrantyUntil: until, inWarranty: until ? opened <= until : null,
    salesOrder: w.sales_order_id ? { id: w.sales_order_id, orderNo: w.sales_order_no } : null,
    shopOrder: w.shop_order_id ? { id: w.shop_order_id, orderNo: w.shop_order_no } : null,
    service: w.service_id ? { id: w.service_id, ref: 'S-' + String(w.service_number).padStart(4, '0') } : null,
    decisionNote: w.decision_note, decidedBy: w.decided_by ? nameOf(w.d_first, w.d_last) : null, decidedAt: w.decided_at,
    costs: { parts: Number(w.cost_parts), labour: Number(w.cost_labour), transport: Number(w.cost_transport), refund: Number(w.refund_amount), total: cost },
    resolution: w.resolution, resolvedOn: dayText(w.resolved_on), customerHappy: w.customer_happy,
    daysOpen: daysBetween(opened, dayText(w.resolved_on) || today()),
    visits: w.visits || 0, nextVisit: dayText(w.next_visit), createdAt: w.created_at, updatedAt: w.updated_at
  };
}

async function claimRow(db, id) {
  var w = (await db.query(SEL + 'WHERE w.id = $1', [uuidOr(id)])).rows[0];
  if (!w) fail('notfound', 'That claim is gone.');
  return w;
}

// GET /api/warranty — the claims (open, and closed in the last 90 days),
// repair requests not judged yet, a year's figures by cause and product.
async function overview(ctx) {
  needRead(ctx);
  var s = await visits.settingsOf();
  var claims = (await pool.query(SEL + "WHERE w.status IN ('open', 'in_hand') OR w.updated_at > now() - interval '90 days' ORDER BY (w.status IN ('open', 'in_hand')) DESC, w.created_at DESC LIMIT 200")).rows.map(claimOut);
  var requests = (await pool.query(
    "SELECT r.id, r.number, r.name, r.item, r.problem, r.status, r.created_at, r.warranty, r.photos, o.order_no, o.steps FROM bpl_service_requests r LEFT JOIN shop_orders o ON o.id = r.shop_order_id " +
    "WHERE r.status IN ('new', 'visit') AND NOT EXISTS (SELECT 1 FROM warranty_claims w WHERE w.service_id = r.id) ORDER BY r.created_at DESC LIMIT 50")).rows.map(function (r) {
    var until = visits.warrantyUntil(r.steps, s.warrantyMonths);
    return { id: r.id, ref: 'S-' + String(r.number).padStart(4, '0'), name: r.name, item: r.item, problem: r.problem, status: r.status, at: r.created_at, orderNo: r.order_no || null,
      photos: (r.photos || []).length, warrantyUntil: until, inWarranty: until ? dayText(r.created_at) <= until : null };
  });
  // A year of claims.
  var year = (await pool.query(SEL + "WHERE w.created_at > now() - interval '365 days'")).rows.map(claimOut);
  var decided = year.filter(function (c) { return c.decision !== 'pending'; });
  var resolved = year.filter(function (c) { return c.resolvedOn; });
  var byCause = CAUSES.map(function (k) { var list = year.filter(function (c) { return c.cause === k; }); return { cause: k, claims: list.length, cost: round2(list.reduce(function (a, c) { return a + c.costs.total; }, 0)) }; }).filter(function (x) { return x.claims; }).sort(function (a, b) { return b.claims - a.claims; });
  var prod = {};
  year.forEach(function (c) {
    var key = c.product ? c.product.id : 'item:' + (c.item || '—');
    var p = prod[key] = prod[key] || { product: c.product ? c.product.name : (c.item || '—'), claims: 0, cost: 0, ourFault: 0 };
    p.claims++; p.cost = round2(p.cost + c.costs.total);
    if (OUR_FAULT.indexOf(c.cause) >= 0) p.ourFault++;
  });
  var months = [];
  var first = new Date(today().slice(0, 7) + '-01T12:00:00Z');
  for (var i = 11; i >= 0; i--) {
    var m = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
    var inM = year.filter(function (c) { return dayText(c.createdAt).slice(0, 7) === m; });
    months.push({ month: m, claims: inM.length, ourFault: inM.filter(function (c) { return OUR_FAULT.indexOf(c.cause) >= 0; }).length });
  }
  var open = claims.filter(function (c) { return c.status === 'open' || c.status === 'in_hand'; });
  return {
    claims: claims, requests: requests, causes: CAUSES, remedies: REMEDIES, warrantyMonths: s.warrantyMonths, canManage: canManage(ctx),
    byCause: byCause, byProduct: Object.keys(prod).map(function (k) { return prod[k]; }).sort(function (a, b) { return b.claims - a.claims; }).slice(0, 8), months: months,
    summary: {
      open: open.length, toDecide: open.filter(function (c) { return c.decision === 'pending'; }).length, requests: requests.length,
      year: year.length, accepted: decided.filter(function (c) { return c.decision === 'accepted' || c.decision === 'goodwill'; }).length, decided: decided.length,
      cost: round2(year.reduce(function (a, c) { return a + c.costs.total; }, 0)),
      daysToResolve: resolved.length ? Math.round(resolved.reduce(function (a, c) { return a + c.daysOpen; }, 0) / resolved.length) : null,
      happy: resolved.filter(function (c) { return c.customerHappy === true; }).length, asked: resolved.filter(function (c) { return c.customerHappy != null; }).length,
      ourFault: year.filter(function (c) { return OUR_FAULT.indexOf(c.cause) >= 0; }).length
    }
  };
}

// GET /api/warranty/options?q= — orders a claim can be opened on: sales
// orders and shop orders delivered, matching a name or number.
async function options(ctx, q) {
  needManage(ctx);
  var term = '%' + text(q && q.q, 60).replace(/[%_]/g, '') + '%';
  var sales = (await pool.query(
    "SELECT s.id, s.order_no, s.delivered_at, s.created_at, c.name FROM sales_orders s JOIN customers c ON c.id = s.customer_id WHERE s.status IN ('delivered', 'processing') AND (s.order_no ILIKE $1 OR c.name ILIKE $1) ORDER BY coalesce(s.delivered_at, s.created_at) DESC LIMIT 20", [term])).rows;
  var shop = (await pool.query(
    "SELECT o.id, o.order_no, o.name, o.steps, o.created_at FROM shop_orders o WHERE o.status IN ('out', 'done') AND (o.order_no ILIKE $1 OR o.name ILIKE $1) ORDER BY o.created_at DESC LIMIT 20", [term])).rows;
  var products = (await pool.query("SELECT id, name, sku FROM products WHERE active ORDER BY name LIMIT 400")).rows;
  return {
    orders: sales.map(function (o) { return { kind: 'sales', id: o.id, orderNo: o.order_no, name: o.name, deliveredOn: o.delivered_at ? dayText(o.delivered_at) : null }; })
      .concat(shop.map(function (o) { var st = o.steps || {}; return { kind: 'shop', id: o.id, orderNo: o.order_no, name: o.name, deliveredOn: st.done || st.out ? dayText(st.done || st.out) : null }; })),
    products: products
  };
}

// GET /api/warranty/:id — with its visits.
async function get(ctx, id) {
  needRead(ctx);
  var c = claimOut(await claimRow(pool, id));
  c.visitList = (await pool.query("SELECT v.id, v.number, v.kind, v.day, v.time_from, v.time_to, v.status, v.signed_name, v.outcome FROM bpl_visits v WHERE v.claim_id = $1 ORDER BY v.day DESC", [c.id])).rows.map(function (v) {
    return { id: v.id, ref: 'V-' + String(v.number).padStart(4, '0'), kind: v.kind, day: dayText(v.day), from: v.time_from, to: v.time_to, status: v.status, signedName: v.signed_name || null, outcome: v.outcome || '' };
  });
  c.history = (await pool.query("SELECT action, summary, actor_name, at FROM audit_logs WHERE entity = 'warranty_claim' AND entity_id = $1 ORDER BY at", [String(c.id)])).rows.map(function (h) { return { action: h.action, what: h.summary, by: h.actor_name, at: h.at }; });
  return c;
}

// POST /api/warranty { serviceId | salesOrderId | shopOrderId, productId,
// item, problem, name, phone, email, address, deliveredOn, photos: [dataUrl] }
async function create(ctx, p) {
  needManage(ctx);
  p = p || {};
  var s = await visits.settingsOf();
  var base = { name: '', phone: '', email: '', address: '', item: '', problem: '', photos: [], delivered: null, customerId: null, service: null, sales: null, shop: null };
  if (uuidOr(p.serviceId)) {
    var r = (await pool.query('SELECT r.*, o.steps, o.id AS shop_id FROM bpl_service_requests r LEFT JOIN shop_orders o ON o.id = r.shop_order_id WHERE r.id = $1', [p.serviceId])).rows[0];
    if (!r) fail('notfound', 'That repair request is gone.');
    if ((await pool.query('SELECT 1 FROM warranty_claims WHERE service_id = $1', [r.id])).rows[0]) fail('conflict', 'There is a claim for that request already.');
    var st = r.steps || {};
    Object.assign(base, { name: r.name, phone: r.phone, email: r.email, address: r.address, item: r.item, problem: r.problem, photos: r.photos || [], customerId: r.customer_id,
      service: r.id, shop: r.shop_id || null, delivered: st.done || st.out ? dayText(st.done || st.out) : null });
  } else if (uuidOr(p.salesOrderId)) {
    var so = (await pool.query('SELECT s.*, c.name, c.phone, c.email, c.address FROM sales_orders s JOIN customers c ON c.id = s.customer_id WHERE s.id = $1', [p.salesOrderId])).rows[0];
    if (!so) fail('notfound', 'That sales order is gone.');
    Object.assign(base, { name: so.name, phone: so.phone || '', email: so.email || '', address: so.address || '', customerId: so.customer_id, sales: so.id, delivered: so.delivered_at ? dayText(so.delivered_at) : null });
  } else if (uuidOr(p.shopOrderId)) {
    var sh = (await pool.query('SELECT * FROM shop_orders WHERE id = $1', [p.shopOrderId])).rows[0];
    if (!sh) fail('notfound', 'That shop order is gone.');
    var st2 = sh.steps || {};
    Object.assign(base, { name: sh.name, phone: sh.phone || '', email: sh.email || '', address: sh.address || '', customerId: sh.customer_id || null, shop: sh.id, delivered: st2.done || st2.out ? dayText(st2.done || st2.out) : null });
  }
  var name = text(p.name, 120) || base.name;
  if (name.length < 2) fail('invalid', 'Whose is it? Their name.');
  var problem = text(p.problem, 1000) || base.problem;
  if (problem.length < 5) fail('invalid', 'What is wrong with it?');
  var productId = uuidOr(p.productId);
  if (productId && !(await pool.query('SELECT 1 FROM products WHERE id = $1', [productId])).rows[0]) fail('invalid', 'Which product?');
  var delivered = /^\d{4}-\d{2}-\d{2}$/.test(String(p.deliveredOn || '')) ? p.deliveredOn : base.delivered;
  if (delivered && delivered > today()) fail('invalid', 'It cannot have been delivered after today.');
  var until = delivered && s.warrantyMonths ? addMonths(delivered, s.warrantyMonths) : null;
  // Photos given here (as for a repair request): kept like the visits' own.
  var photos = (base.photos || []).slice(0, MAX_PHOTOS);
  var given = Array.isArray(p.photos) ? p.photos.slice(0, MAX_PHOTOS - photos.length) : [];
  var cash = require('./restaurantCashOffice.service');
  for (var i = 0; i < given.length; i++) photos.push(await cash.photoFrom(given[i], 'warranty-' + (i + 1)));
  var id = await withTransaction(async function (db) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('warranty_claims'))");
    var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM warranty_claims')).rows[0].n;
    var row = (await db.query(
      'INSERT INTO warranty_claims (number, service_id, shop_order_id, sales_order_id, customer_id, name, phone, email, address, product_id, item, delivered_on, warranty_until, problem, photos, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id',
      [n, base.service, base.shop, base.sales, base.customerId, name, text(p.phone, 30) || base.phone, (text(p.email, 120) || base.email || '').toLowerCase(), text(p.address, 300) || base.address,
        productId, text(p.item, 160) || base.item, delivered, until, problem, JSON.stringify(photos), me(ctx)])).rows[0];
    await audit(db, ctx, 'warranty.open', 'warranty_claim', row.id, wref(n) + ' opened for ' + name + (until ? (today() <= until ? ', under warranty to ' + until : ', warranty ended ' + until) : '') + ': ' + problem.slice(0, 120));
    return row.id;
  });
  return get(ctx, id);
}

// POST /api/warranty/:id/decision { decision, cause, remedy, note } — the
// customer is told; a fault of ours goes to quality.
async function decide(ctx, id, p) {
  needManage(ctx);
  p = p || {};
  var w = await claimRow(pool, id);
  if (w.status === 'closed') fail('conflict', 'That claim is closed.');
  var decision = DECISIONS.indexOf(p.decision) >= 0 ? p.decision : fail('invalid', 'Accept it, cover it as goodwill, or turn it down.');
  var cause = CAUSES.indexOf(p.cause) >= 0 ? p.cause : fail('invalid', 'What caused it?');
  var remedy = decision === 'rejected' ? 'none' : REMEDIES.indexOf(p.remedy) >= 0 && p.remedy !== 'none' ? p.remedy : fail('invalid', 'Repair, replace, refund or credit?');
  var note = text(p.note, 800);
  if (decision === 'rejected' && note.length < 5) fail('invalid', 'Say why, for the customer to read.');
  await withTransaction(async function (db) {
    await db.query('UPDATE warranty_claims SET decision = $2, cause = $3, remedy = $4, decision_note = $5, decided_by = $6, decided_at = now(), status = CASE WHEN $2 = \'rejected\' THEN \'resolved\' ELSE status END, ' +
      "resolved_on = CASE WHEN $2 = 'rejected' THEN current_date ELSE resolved_on END, updated_at = now() WHERE id = $1",
      [w.id, decision, cause, remedy, note, me(ctx)]);
    if (w.service_id) await db.query('UPDATE bpl_service_requests SET warranty = $2, answer = CASE WHEN $3 = \'\' THEN answer ELSE $3 END, status = CASE WHEN $4 THEN \'closed\' ELSE status END, updated_at = now() WHERE id = $1',
      [w.service_id, decision !== 'rejected', note, decision === 'rejected']);
    await audit(db, ctx, 'warranty.' + decision, 'warranty_claim', w.id, wref(w.number) + ': ' + decision + ' — ' + CAUSE_WORDS[cause] + (remedy !== 'none' ? ', ' + remedy : '') + (note ? '. ' + note : '.'));
  });
  var words = 'Bamboo Products, about your claim ' + wref(w.number) + (w.item || w.product_name ? ' (' + (w.item || w.product_name) + ')' : '') + ': ' +
    (decision === 'rejected' ? 'we are sorry, it is not covered. ' + note : (decision === 'goodwill' ? 'we will cover it as a goodwill gesture — ' : 'it is covered by the warranty — ') + REMEDY_WORDS[remedy] + '.' + (note ? ' ' + note : '') + (remedy === 'repair' || remedy === 'replace' ? ' We will call you to agree a day.' : ''));
  var told = await visits.tellCustomer(w, 'Your warranty claim ' + wref(w.number), words, 'warranty_claim', w.id);
  if (decision !== 'rejected' && OUR_FAULT.indexOf(cause) >= 0) {
    var quality = (await require('./staffAlerts.service').holdersOf(['quality.manage'])).map(function (h) { return h.employee_id; });
    for (var i = 0; i < quality.length; i++) {
      await notify(pool, quality[i], 'Warranty: ' + CAUSE_WORDS[cause] + ' — ' + (w.product_name || w.item || wref(w.number)), wref(w.number) + ' for ' + w.name + ': ' + text(w.problem, 140), '/warranty?claim=' + w.id);
    }
  }
  return Object.assign(await get(ctx, w.id), { told: told });
}

// PUT /api/warranty/:id { costs: { parts, labour, transport, refund },
// resolution, customerHappy, productId, item, deliveredOn }
async function update(ctx, id, p) {
  needManage(ctx);
  p = p || {};
  var w = await claimRow(pool, id);
  var costs = p.costs || {};
  function money(v, cur, what) { if (v === undefined || v === '') return Number(cur); var n = Number(v); if (!(n >= 0 && n < 1e8)) fail('invalid', 'What did ' + what + ' cost?'); return round2(n); }
  var productId = p.productId === undefined ? w.product_id : uuidOr(p.productId);
  var delivered = p.deliveredOn === undefined ? dayText(w.delivered_on) : /^\d{4}-\d{2}-\d{2}$/.test(String(p.deliveredOn || '')) ? p.deliveredOn : null;
  var s = await visits.settingsOf();
  var until = delivered && s.warrantyMonths ? addMonths(delivered, s.warrantyMonths) : null;
  await pool.query(
    'UPDATE warranty_claims SET cost_parts = $2, cost_labour = $3, cost_transport = $4, refund_amount = $5, resolution = $6, customer_happy = $7, product_id = $8, item = $9, delivered_on = $10, warranty_until = $11, updated_at = now() WHERE id = $1',
    [w.id, money(costs.parts, w.cost_parts, 'the parts'), money(costs.labour, w.cost_labour, 'the labour'), money(costs.transport, w.cost_transport, 'the transport'), money(costs.refund, w.refund_amount, 'the refund'),
      p.resolution === undefined ? w.resolution : text(p.resolution, 1000), p.customerHappy === undefined ? w.customer_happy : p.customerHappy === null ? null : !!p.customerHappy,
      productId, p.item === undefined ? w.item : text(p.item, 160), delivered, until]);
  await audit(pool, ctx, 'warranty.update', 'warranty_claim', w.id, wref(w.number) + ' updated.');
  return get(ctx, w.id);
}

// POST /api/warranty/:id/resolve { resolution, customerHappy, costs } — done
// without a visit (a refund, a credit) or after one; /close; /reopen.
async function setStatus(ctx, id, status, p) {
  needManage(ctx);
  p = p || {};
  var w = await claimRow(pool, id);
  if (status === 'resolved') {
    if (w.decision === 'pending') fail('conflict', 'Decide on it first.');
    if (['open', 'in_hand'].indexOf(w.status) < 0) fail('conflict', 'It is ' + w.status + ' already.');
    if (p.costs || p.resolution !== undefined || p.customerHappy !== undefined) await update(ctx, id, p);
    if (!text(p.resolution, 1000) && !w.resolution) fail('invalid', 'What was done?');
    await pool.query("UPDATE warranty_claims SET status = 'resolved', resolved_on = current_date, updated_at = now() WHERE id = $1", [w.id]);
    if (w.service_id) await pool.query("UPDATE bpl_service_requests SET status = 'fixed', updated_at = now() WHERE id = $1 AND status IN ('new', 'visit')", [w.service_id]);
  } else if (status === 'closed') {
    if (w.status === 'closed') fail('conflict', 'It is closed already.');
    if (w.decision === 'pending') fail('conflict', 'Decide on it first.');
    await pool.query("UPDATE warranty_claims SET status = 'closed', resolved_on = coalesce(resolved_on, current_date), updated_at = now() WHERE id = $1", [w.id]);
    if (w.service_id) await pool.query("UPDATE bpl_service_requests SET status = 'closed', updated_at = now() WHERE id = $1 AND status <> 'closed'", [w.service_id]);
  } else {
    if (w.status === 'open' || w.status === 'in_hand') fail('conflict', 'It is open.');
    await pool.query("UPDATE warranty_claims SET status = 'in_hand', resolved_on = NULL, updated_at = now() WHERE id = $1", [w.id]);
  }
  await audit(pool, ctx, 'warranty.' + status, 'warranty_claim', w.id, wref(w.number) + ' ' + (status === 'in_hand' ? 'opened again' : status) + (text(p.resolution, 200) ? ': ' + text(p.resolution, 200) : '') + '.');
  return get(ctx, w.id);
}

// GET /api/warranty/:id/photos/:n
async function photoKey(ctx, id, n) {
  needRead(ctx);
  var w = (await pool.query('SELECT photos FROM warranty_claims WHERE id = $1', [uuidOr(id)])).rows[0];
  var ph = w && (w.photos || [])[Number(n)];
  if (!ph) fail('notfound', 'No such photo.');
  return { key: ph.key, name: 'claim-' + (Number(n) + 1) + (ph.type === 'image/png' ? '.png' : '.jpg') };
}

module.exports = { overview: overview, options: options, get: get, create: create, decide: decide, update: update, setStatus: setStatus, photoKey: photoKey, CAUSES: CAUSES, REMEDIES: REMEDIES, wref: wref };
