var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var activity = require('./restaurantActivity.service');

// Low stock and purchase orders (migration 0183), from the till's back
// office (restaurantTillAccess purchasing):
//
// - Low stock: a counted dish or drink at or under its "low" figure, an
//   ingredient or a supply at or under its reorder level — with what is on
//   order already and how much to order (back up to twice the level). The
//   managers are told when something goes under (a sale, a count, waste).
// - Suppliers: who each thing is bought from, with their phone and email.
// - Purchase orders: drafted by hand or from the low stock (one per
//   supplier), sent on WhatsApp (the manager's phone opens the message) or
//   by email, and received: what came in goes into the stock, at the price
//   paid, logged as stock that came in.

var TYPES = { menu: 'restaurant_menu_items', ingredient: 'restaurant_ingredients', supply: 'restaurant_supplies' };
var MAX_LINES = 60;

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function round3(n) { return Math.round(Number(n || 0) * 1000) / 1000; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function who(m) { return { user: { id: null }, employee: { first_name: m.first_name, last_name: m.last_name } }; }
function money(n) { return 'GHS ' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function waNumber(v) { return require('./crmProductSheets.service').waNumber(v); }
function mail() { return require('./mail.service'); }

// ── low stock ──

// What is on order already (sent, not received yet), by type:id.
async function onOrder(db, companyId) {
  var rows = (await db.query(
    "SELECT l.item_type, l.item_id, sum(l.qty) AS qty FROM restaurant_purchase_order_lines l JOIN restaurant_purchase_orders o ON o.id = l.po_id " +
    "WHERE o.company_id = $1 AND o.status = 'sent' GROUP BY 1, 2", [companyId])).rows;
  var m = new Map();
  rows.forEach(function (r) { m.set(r.item_type + ':' + r.item_id, Number(r.qty)); });
  return m;
}
// Everything at or under its level: [{ type, id, name, unit, stock, level, unitCost, supplierId, supplier, onOrder, suggest }].
async function lowStock(companyId, db) {
  db = db || pool;
  var rows = (await db.query(
    "SELECT 'menu' AS type, m.id, m.name, 'each' AS unit, m.stock_qty, m.low_stock AS level, m.unit_cost, m.supplier_id FROM restaurant_menu_items m " +
    'WHERE m.company_id = $1 AND m.active AND m.track_stock AND m.low_stock > 0 AND m.stock_qty <= m.low_stock ' +
    "UNION ALL SELECT 'ingredient', i.id, i.name, i.unit, i.stock_qty, i.reorder_level, i.unit_cost, i.supplier_id FROM restaurant_ingredients i " +
    'WHERE i.company_id = $1 AND i.active AND i.reorder_level > 0 AND i.stock_qty <= i.reorder_level ' +
    "UNION ALL SELECT 'supply', s.id, s.name, s.unit, s.stock_qty, s.reorder_level, s.unit_cost, s.supplier_id FROM restaurant_supplies s " +
    'WHERE s.company_id = $1 AND s.active AND s.reorder_level > 0 AND s.stock_qty <= s.reorder_level', [companyId])).rows;
  var sup = new Map((await db.query('SELECT id, name FROM restaurant_suppliers WHERE company_id = $1', [companyId])).rows.map(function (s) { return [s.id, s.name]; }));
  var ordered = await onOrder(db, companyId);
  return rows.map(function (r) {
    var stock = Number(r.stock_qty), level = Number(r.level), on = ordered.get(r.type + ':' + r.id) || 0;
    var want = Math.max(0, level * 2 - Math.max(0, stock) - on);
    return {
      type: r.type, id: r.id, name: r.name, unit: r.unit, stock: round3(stock), level: round3(level), unitCost: Number(r.unit_cost),
      supplierId: r.supplier_id || null, supplier: r.supplier_id ? sup.get(r.supplier_id) || null : null, onOrder: round3(on),
      suggest: r.unit === 'each' ? Math.ceil(want) : round3(want), out: stock <= 0
    };
  }).sort(function (a, b) { return (a.stock / a.level) - (b.stock / b.level) || a.name.localeCompare(b.name); });
}

// The till managers and those who manage the restaurant in the OS.
async function managersOf(db, companyId) {
  return (await db.query(
    "SELECT employee_id AS id FROM restaurant_till_staff WHERE company_id = $1 AND role = 'manager' " +
    'UNION SELECT e.id FROM employees e JOIN departments d ON d.id = e.department_id JOIN users u ON u.employee_id = e.id ' +
    'JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id ' +
    "WHERE d.company_id = $1 AND e.status = 'active' AND u.status = 'active' AND rp.permission_key = 'restaurant.manage'", [companyId])).rows.map(function (r) { return r.id; });
}
// Things that just went under their level (before above it, after at or
// under): the managers are told, once for all of them.
// list: [{ name, unit, before, after, level }].
async function tellLow(db, companyId, list) {
  var under = (list || []).filter(function (x) { return x.level > 0 && x.before > x.level && x.after <= x.level; });
  if (!under.length) return 0;
  var co = (await db.query('SELECT code, name FROM companies WHERE id = $1', [companyId])).rows[0];
  var title = under.length === 1 ? (under[0].after <= 0 ? under[0].name + ' has run out' : under[0].name + ' is running low') : under.length + ' things are running low';
  var body = under.map(function (x) { return x.name + ': ' + round3(Math.max(0, x.after)) + (x.unit && x.unit !== 'each' ? ' ' + x.unit : '') + ' left'; }).join(' · ') + ' (' + co.name + ')';
  var ids = await managersOf(db, companyId);
  for (var i = 0; i < ids.length; i++) await notify(db, ids[i], title, body, '/restaurant?restaurant=' + encodeURIComponent(co.code) + '&view=stock');
  return ids.length;
}

// ── suppliers ──

function supplierOut(r) { return { id: r.id, name: r.name, phone: r.phone, email: r.email, note: r.note, active: r.active, items: Number(r.items || 0) }; }
async function suppliers(companyId) {
  return (await pool.query(
    'SELECT s.*, (SELECT count(*) FROM restaurant_menu_items WHERE supplier_id = s.id) + (SELECT count(*) FROM restaurant_ingredients WHERE supplier_id = s.id) + ' +
    '(SELECT count(*) FROM restaurant_supplies WHERE supplier_id = s.id) AS items FROM restaurant_suppliers s WHERE s.company_id = $1 ORDER BY s.active DESC, lower(s.name)', [companyId])).rows.map(supplierOut);
}
async function saveSupplier(companyId, by, p) {
  p = p || {};
  var name = text(p.name, 80);
  if (!name) fail('invalid', 'Give the supplier a name.');
  var phone = text(p.phone, 30), email = text(p.email, 120);
  if (email && !mail().isEmail(email)) fail('invalid', 'That email address does not look right.');
  if (phone && !waNumber(phone)) fail('invalid', 'That phone number does not look right.');
  var row;
  if (p.id) {
    row = (await pool.query('UPDATE restaurant_suppliers SET name = $3, phone = $4, email = $5, note = $6, active = $7 WHERE id = $1 AND company_id = $2 RETURNING *',
      [p.id, companyId, name, phone, email, text(p.note, 300), p.active !== false])).rows[0];
    if (!row) fail('notfound', 'That supplier is not this restaurant\'s.');
  } else {
    row = (await pool.query('INSERT INTO restaurant_suppliers (company_id, name, phone, email, note) VALUES ($1,$2,$3,$4,$5) RETURNING *', [companyId, name, phone, email, text(p.note, 300)])).rows[0];
  }
  await activity.log(pool, { companyId: companyId, employeeId: by.id, app: 'settings', action: 'settings.supplier', summary: (p.id ? 'Changed supplier ' : 'Added supplier ') + name + '.', refType: 'supplier', refId: row.id });
  return row.id;
}
async function removeSupplier(companyId, by, id) {
  var r = (await pool.query('DELETE FROM restaurant_suppliers WHERE id = $1 AND company_id = $2 RETURNING name', [id, companyId])).rows[0];
  if (!r) fail('notfound', 'That supplier is not this restaurant\'s.');
  await activity.log(pool, { companyId: companyId, employeeId: by.id, app: 'settings', action: 'settings.supplier', summary: 'Removed supplier ' + r.name + '.', refType: 'supplier', refId: id });
}
// Who something is bought from: { type, id, supplierId (none: nobody) }.
async function setSupplier(companyId, p) {
  var table = TYPES[p && p.type];
  if (!table) fail('invalid', 'Pick what is bought.');
  var sid = p.supplierId || null;
  if (sid && !(await pool.query('SELECT 1 FROM restaurant_suppliers WHERE id = $1 AND company_id = $2', [sid, companyId])).rows[0]) fail('notfound', 'That supplier is not this restaurant\'s.');
  var r = (await pool.query('UPDATE ' + table + ' SET supplier_id = $3 WHERE id = $1 AND company_id = $2 RETURNING id', [p.id, companyId, sid])).rows[0];
  if (!r) fail('notfound', 'That item is not this restaurant\'s.');
}

// ── purchase orders ──

function poOut(o, lines) {
  return {
    id: o.id, number: o.number, ref: 'PO-' + String(o.number).padStart(4, '0'), status: o.status, supplierId: o.supplier_id,
    supplier: { name: o.supplier_name, phone: o.supplier_phone, email: o.supplier_email }, note: o.note,
    expectedOn: o.expected_on ? String(o.expected_on instanceof Date ? o.expected_on.toISOString().slice(0, 10) : o.expected_on).slice(0, 10) : null,
    total: Number(o.total), createdAt: o.created_at, createdBy: o.created_by_name || null, sentAt: o.sent_at, receivedAt: o.received_at, receivedBy: o.received_by_name || null,
    // Its bill to pay, when not paid at the door (migration 0196).
    bill: o.bill_number ? { ref: 'B-' + String(o.bill_number).padStart(4, '0'), status: o.bill_status, dueDate: require('./bills.service').dayText(o.bill_due), balance: round2(Number(o.bill_amount) - Number(o.bill_paid)) } : null,
    lines: (lines || []).map(function (l) {
      return { id: l.id, type: l.item_type, itemId: l.item_id, name: l.name, unit: l.unit, qty: Number(l.qty), unitCost: Number(l.unit_cost), total: round2(Number(l.qty) * Number(l.unit_cost)),
        receivedQty: l.received_qty == null ? null : Number(l.received_qty) };
    })
  };
}
async function ordersWhere(where, args) {
  var rows = (await pool.query(
    "SELECT o.*, e.first_name || ' ' || e.last_name AS created_by_name, r.first_name || ' ' || r.last_name AS received_by_name, " +
    'b.number AS bill_number, b.status AS bill_status, b.due_date AS bill_due, b.amount AS bill_amount, b.paid AS bill_paid FROM restaurant_purchase_orders o ' +
    'LEFT JOIN employees e ON e.id = o.created_by LEFT JOIN employees r ON r.id = o.received_by LEFT JOIN supplier_bills b ON b.purchase_order_id = o.id WHERE ' + where + ' ORDER BY o.created_at DESC LIMIT 60', args)).rows;
  if (!rows.length) return [];
  var lines = (await pool.query('SELECT * FROM restaurant_purchase_order_lines WHERE po_id = ANY($1::uuid[]) ORDER BY sort_order', [rows.map(function (r) { return r.id; })])).rows;
  return rows.map(function (o) { return poOut(o, lines.filter(function (l) { return l.po_id === o.id; })); });
}
async function orders(companyId) { return ordersWhere('o.company_id = $1', [companyId]); }
async function orderOf(companyId, id) {
  var o = (await ordersWhere('o.company_id = $1 AND o.id = $2', [companyId, id]))[0];
  if (!o) fail('notfound', 'That purchase order is not this restaurant\'s.');
  return o;
}

// The lines asked for, checked: [{ type, id, qty, unitCost }] → with each item's name and unit.
async function linesOf(db, companyId, asked) {
  var list = Array.isArray(asked) ? asked : [];
  if (!list.length) fail('invalid', 'Add what to order.');
  if (list.length > MAX_LINES) fail('invalid', 'At most ' + MAX_LINES + ' lines on one order.');
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i] || {};
    var table = TYPES[a.type];
    if (!table) fail('invalid', 'Pick what to order.');
    var it = (await db.query('SELECT id, name, ' + (a.type === 'menu' ? "'each' AS unit" : 'unit') + ', unit_cost FROM ' + table + ' WHERE id = $1 AND company_id = $2', [a.id, companyId])).rows[0];
    if (!it) fail('notfound', 'Something on the order is not this restaurant\'s.');
    var qty = round3(a.qty);
    if (!(qty > 0 && qty < 1e7)) fail('invalid', it.name + ': how many?');
    var cost = a.unitCost === undefined || a.unitCost === '' ? Number(it.unit_cost) : Math.round(Number(a.unitCost) * 10000) / 10000;
    if (!(cost >= 0 && cost < 1e7)) fail('invalid', it.name + ': what does one cost?');
    out.push({ type: a.type, id: it.id, name: it.name, unit: it.unit || '', qty: qty, unitCost: cost });
  }
  return out;
}
async function supplierRow(db, companyId, id) {
  if (!id) return null;
  var s = (await db.query('SELECT * FROM restaurant_suppliers WHERE id = $1 AND company_id = $2', [id, companyId])).rows[0];
  if (!s) fail('notfound', 'That supplier is not this restaurant\'s.');
  return s;
}
async function writeLines(db, poId, lines) {
  await db.query('DELETE FROM restaurant_purchase_order_lines WHERE po_id = $1', [poId]);
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    await db.query('INSERT INTO restaurant_purchase_order_lines (po_id, item_type, item_id, name, unit, qty, unit_cost, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [poId, l.type, l.id, l.name, l.unit, l.qty, l.unitCost, i]);
  }
  var total = round2(lines.reduce(function (a, l) { return a + l.qty * l.unitCost; }, 0));
  await db.query('UPDATE restaurant_purchase_orders SET total = $2 WHERE id = $1', [poId, total]);
}
async function newOrder(db, companyId, by, sup, lines, note, expectedOn) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('restaurant-po:' || $1))", [companyId]);
  var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM restaurant_purchase_orders WHERE company_id = $1', [companyId])).rows[0].n;
  var o = (await db.query(
    'INSERT INTO restaurant_purchase_orders (company_id, number, supplier_id, supplier_name, supplier_phone, supplier_email, note, expected_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [companyId, n, sup ? sup.id : null, sup ? sup.name : '', sup ? sup.phone : '', sup ? sup.email : '', note || '', expectedOn || null, by.id])).rows[0];
  await writeLines(db, o.id, lines);
  return o;
}
function dateOf(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; }

// A draft, new or changed: { id?, supplierId, lines, note, expectedOn }.
async function saveDraft(companyId, by, p) {
  p = p || {};
  var id = await withTransaction(async function (db) {
    var lines = await linesOf(db, companyId, p.lines);
    var sup = await supplierRow(db, companyId, p.supplierId);
    if (p.id) {
      var o = (await db.query('SELECT * FROM restaurant_purchase_orders WHERE id = $1 AND company_id = $2 FOR UPDATE', [p.id, companyId])).rows[0];
      if (!o) fail('notfound', 'That purchase order is not this restaurant\'s.');
      if (o.status !== 'draft') fail('conflict', 'It was sent already: it cannot be changed.');
      await db.query('UPDATE restaurant_purchase_orders SET supplier_id = $2, supplier_name = $3, supplier_phone = $4, supplier_email = $5, note = $6, expected_on = $7 WHERE id = $1',
        [o.id, sup ? sup.id : null, sup ? sup.name : '', sup ? sup.phone : '', sup ? sup.email : '', text(p.note, 400), dateOf(p.expectedOn)]);
      await writeLines(db, o.id, lines);
      return o.id;
    }
    return (await newOrder(db, companyId, by, sup, lines, text(p.note, 400), dateOf(p.expectedOn))).id;
  });
  return orderOf(companyId, id);
}

// Drafts from the low stock: one per supplier, for what is not on order
// already; things with no supplier yet go on one draft without one.
async function draftLow(companyId, by) {
  var made = await withTransaction(async function (db) {
    var low = (await lowStock(companyId, db)).filter(function (x) { return x.suggest > 0; });
    if (!low.length) fail('conflict', 'Nothing is low that is not on order already.');
    var groups = new Map();
    low.forEach(function (x) { var k = x.supplierId || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); });
    var ids = [];
    for (var e of groups) {
      var sup = await supplierRow(db, companyId, e[0] || null);
      var o = await newOrder(db, companyId, by, sup, e[1].map(function (x) { return { type: x.type, id: x.id, name: x.name, unit: x.unit === 'each' ? 'each' : x.unit, qty: x.suggest, unitCost: x.unitCost }; }), 'From the low stock', null);
      ids.push(o.id);
    }
    await activity.log(db, { companyId: companyId, employeeId: by.id, app: 'settings', action: 'settings.purchasing', summary: 'Drafted ' + ids.length + ' purchase order' + (ids.length === 1 ? '' : 's') + ' from the low stock (' + low.length + ' items).' });
    return ids;
  });
  return Promise.all(made.map(function (id) { return orderOf(companyId, id); }));
}

// The order in words, for WhatsApp and email.
function words(o, co, by) {
  var lines = [];
  lines.push('Hello' + (o.supplier.name ? ' ' + o.supplier.name : '') + ',');
  lines.push('');
  lines.push('Please supply ' + co.name + ' with (purchase order ' + o.ref + '):');
  lines.push('');
  o.lines.forEach(function (l) {
    lines.push('• ' + round3(l.qty) + (l.unit && l.unit !== 'each' ? ' ' + l.unit : ' ×') + ' ' + l.name + (l.unitCost > 0 ? ' at ' + money(l.unitCost) + (l.unit && l.unit !== 'each' ? ' / ' + l.unit : ' each') : ''));
  });
  if (o.total > 0) { lines.push(''); lines.push('Total: ' + money(o.total)); }
  if (o.expectedOn) lines.push('Needed by: ' + o.expectedOn);
  if (o.note && o.note !== 'From the low stock') { lines.push(''); lines.push(o.note); }
  lines.push('');
  lines.push('Thank you,');
  lines.push(by ? by + ', ' + co.name : co.name);
  return lines.join('\n');
}

// Sent: { id, via: 'whatsapp' | 'email' | 'other' }. WhatsApp: the link
// that opens it on the manager's phone; email: sent from the restaurant.
async function send(companyId, by, p) {
  p = p || {};
  var o = await orderOf(companyId, p.id);
  if (o.status === 'received' || o.status === 'cancelled') fail('conflict', 'It was ' + o.status + ' already.');
  var co = (await pool.query('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0];
  var byName = (by.first_name + ' ' + by.last_name).trim();
  var message = words(o, co, byName);
  var via = ['whatsapp', 'email', 'other'].indexOf(p.via) >= 0 ? p.via : 'whatsapp';
  var out = { message: message };
  if (via === 'whatsapp') {
    var wa = waNumber(o.supplier.phone);
    out.whatsappUrl = 'https://wa.me/' + (wa || '') + '?text=' + encodeURIComponent(message);
    out.hasNumber = !!wa;
  } else if (via === 'email') {
    if (!mail().isEmail(o.supplier.email)) fail('invalid', 'This supplier has no email address. Add it, or send it on WhatsApp.');
    var esc = mail().escapeHtml;
    await mail().send({ to: o.supplier.email, subject: 'Purchase order ' + o.ref + ' from ' + co.name, fromName: co.name, text: message,
      html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2937">' + esc(message).replace(/\n/g, '<br>') + '</div>' });
    out.emailed = o.supplier.email;
  }
  if (o.status === 'draft') {
    await pool.query("UPDATE restaurant_purchase_orders SET status = 'sent', sent_at = now() WHERE id = $1", [o.id]);
    await activity.log(pool, { companyId: companyId, employeeId: by.id, app: 'settings', action: 'settings.purchasing',
      summary: 'Sent purchase order ' + o.ref + (o.supplier.name ? ' to ' + o.supplier.name : '') + (via === 'email' ? ' by email' : via === 'whatsapp' ? ' on WhatsApp' : '') + ', ' + money(o.total) + '.', amount: o.total, refType: 'purchase_order', refId: o.id });
  }
  out.order = await orderOf(companyId, o.id);
  return out;
}

// Received: { id, lines: [{ id, receivedQty, unitCost }] } — none given:
// all as ordered. What came in goes into the stock at the price paid.
async function receive(companyId, by, p) {
  p = p || {};
  var tm = require('./restaurantTillMenu.service');
  var bills = require('./bills.service');
  var bill = null, rises = [], told = null;
  await withTransaction(async function (db) {
    var o = (await db.query('SELECT * FROM restaurant_purchase_orders WHERE id = $1 AND company_id = $2 FOR UPDATE', [p.id, companyId])).rows[0];
    if (!o) fail('notfound', 'That purchase order is not this restaurant\'s.');
    if (o.status === 'received' || o.status === 'cancelled') fail('conflict', 'It was ' + o.status + ' already.');
    var lines = (await db.query('SELECT * FROM restaurant_purchase_order_lines WHERE po_id = $1 ORDER BY sort_order', [o.id])).rows;
    var given = new Map((Array.isArray(p.lines) ? p.lines : []).map(function (l) { return [l && l.id, l]; }));
    var total = 0, came = 0;
    var ref = 'PO-' + String(o.number).padStart(4, '0');
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i], g = given.get(l.id);
      var qty = g && g.receivedQty !== undefined && g.receivedQty !== '' ? round3(g.receivedQty) : Number(l.qty);
      if (!(qty >= 0 && qty < 1e7)) fail('invalid', l.name + ': how many came?');
      var cost = g && g.unitCost !== undefined && g.unitCost !== '' ? Math.round(Number(g.unitCost) * 10000) / 10000 : Number(l.unit_cost);
      if (!(cost >= 0 && cost < 1e7)) fail('invalid', l.name + ': what did one cost?');
      var table = TYPES[l.item_type];
      var cur = (await db.query('SELECT * FROM ' + table + ' WHERE id = $1 AND company_id = $2 FOR UPDATE', [l.item_id, companyId])).rows[0];
      // What it cost before, for the price watch (restaurantPrices.service.js).
      await db.query('UPDATE restaurant_purchase_order_lines SET received_qty = $2, unit_cost = $3, previous_cost = $4 WHERE id = $1', [l.id, qty, cost, cur ? Number(cur.unit_cost) : null]);
      total += qty * cost;
      if (qty <= 0) continue;
      if (!cur) continue;
      if (cost > 0 && Number(cur.unit_cost) > 0) rises.push({ name: cur.name, unit: cur.unit, before: Number(cur.unit_cost), after: cost });
      var after = round2(Number(cur.stock_qty) + qty);
      await db.query('UPDATE ' + table + ' SET stock_qty = $2, unit_cost = CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE unit_cost END, updated_at = now() WHERE id = $1', [cur.id, after, cost]);
      await tm.logMove(db, { companyId: companyId, type: l.item_type, id: cur.id, kind: 'received', delta: qty, after: after, unitCost: cost, note: ref + (o.supplier_name ? ' · ' + o.supplier_name : ''), by: by.id });
      came++;
    }
    await db.query("UPDATE restaurant_purchase_orders SET status = 'received', received_at = now(), received_by = $2, total = $3, sent_at = coalesce(sent_at, now()) WHERE id = $1", [o.id, by.id, round2(total)]);
    // Not paid at the door: a bill to pay (migration 0196).
    if (!p.paidAtDoor) bill = await bills.fromPurchaseOrder(db, companyId, o, round2(total), by, { dueDate: p.dueDate, supplierRef: p.supplierRef });
    var summary = 'Received purchase order ' + ref + (o.supplier_name ? ' from ' + o.supplier_name : '') + ': ' + came + ' item' + (came === 1 ? '' : 's') + ' into the stock, ' + money(total) +
      (bill ? '; bill B-' + String(bill.number).padStart(4, '0') + ' to pay by ' + bills.dayText(bill.due_date) : p.paidAtDoor ? '; paid at the door' : '') + '.';
    await audit(db, who(by), 'restaurant.purchase.receive', 'restaurant_purchase_order', o.id, summary);
    await activity.log(db, { companyId: companyId, employeeId: by.id, app: 'settings', action: 'settings.purchasing', summary: summary, amount: round2(total), refType: 'purchase_order', refId: o.id });
    told = { ref: ref, supplier: o.supplier_name };
  });
  if (bill) await bills.tellApprovers(bill, null);
  if (told) await require('./restaurantPrices.service').tellRises(pool, companyId, told.ref, told.supplier, rises);
  return orderOf(companyId, p.id);
}
async function cancel(companyId, by, id) {
  var o = await orderOf(companyId, id);
  if (o.status === 'received' || o.status === 'cancelled') fail('conflict', 'It was ' + o.status + ' already.');
  await pool.query("UPDATE restaurant_purchase_orders SET status = 'cancelled' WHERE id = $1", [o.id]);
  await activity.log(pool, { companyId: companyId, employeeId: by.id, app: 'settings', action: 'settings.purchasing', summary: 'Cancelled purchase order ' + o.ref + '.', refType: 'purchase_order', refId: o.id });
  return orderOf(companyId, o.id);
}

// The back office's Purchasing tab: { action: 'list' | 'saveSupplier' |
// 'removeSupplier' | 'setSupplier' | 'draft' | 'draftLow' | 'send' |
// 'receive' | 'cancel', … } → what it shows, and what was done.
async function tab(companyId, by, p) {
  p = p || {};
  var done = null;
  if (p.action === 'saveSupplier') done = { supplierId: await saveSupplier(companyId, by, p.supplier) };
  else if (p.action === 'removeSupplier') await removeSupplier(companyId, by, p.id);
  else if (p.action === 'setSupplier') await setSupplier(companyId, p);
  else if (p.action === 'draft') done = { order: await saveDraft(companyId, by, p.order) };
  else if (p.action === 'draftLow') done = { orders: await draftLow(companyId, by) };
  else if (p.action === 'send') done = await send(companyId, by, p);
  else if (p.action === 'receive') done = { order: await receive(companyId, by, p) };
  else if (p.action === 'cancel') done = { order: await cancel(companyId, by, p.id) };
  var items = (await pool.query(
    "SELECT 'menu' AS type, id, name, 'each' AS unit, stock_qty, low_stock AS level, unit_cost, supplier_id FROM restaurant_menu_items WHERE company_id = $1 AND track_stock AND active " +
    "UNION ALL SELECT 'ingredient', id, name, unit, stock_qty, reorder_level, unit_cost, supplier_id FROM restaurant_ingredients WHERE company_id = $1 AND active " +
    "UNION ALL SELECT 'supply', id, name, unit, stock_qty, reorder_level, unit_cost, supplier_id FROM restaurant_supplies WHERE company_id = $1 AND active ORDER BY 3", [companyId])).rows;
  return {
    low: await lowStock(companyId), suppliers: await suppliers(companyId), orders: await orders(companyId),
    items: items.map(function (r) { return { type: r.type, id: r.id, name: r.name, unit: r.unit, stock: round3(r.stock_qty), level: round3(r.level), unitCost: Number(r.unit_cost), supplierId: r.supplier_id || null }; }),
    emailOn: mail().configured(), done: done
  };
}

module.exports = { lowStock: lowStock, tellLow: tellLow, managersOf: managersOf, suppliers: suppliers, orders: orders, tab: tab, newOrder: newOrder, linesOf: linesOf, _words: words };
