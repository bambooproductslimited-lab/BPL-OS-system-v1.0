var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// Purchase orders (migration 0219): the document one of our companies sends
// a supplier or a bamboo farmer, laid out as Bamboo Products' own —
// "PURCHASE ORDER – BAMBOO POLES": the PO number and date; the supplier or
// farmer with their location and contact; what is bought, line by line
// (description, specification, quantity, unit price, total); the total
// purchase value; the quality requirements; where and when it is to be
// delivered; and who prepared it (name, position, signature, date).
//
// A purchase order starts as a draft, is marked sent to the supplier
// (issued), then delivered — with what actually came, line by line — or
// cancelled with a reason. Drafts and sent ones can still be changed; a
// draft can be deleted.
//
// Numbers follow the company's code: BPL 001, BPL 002 … — the next one is
// offered, and any number not used yet by that company can be given (the
// orders made on paper before this).
//
// Who: procurement.approve makes and changes them (as it orders purchase
// requests, procurement.service.js); procurement.read.all sees them.

var STATUSES = ['draft', 'issued', 'delivered', 'cancelled'];
var CURRENCIES = ['GHS', 'USD', 'EUR', 'GBP', 'CNY'];
var MAX_LINES = 50, MAX_QUALITY = 20;

function text(v, max) { return String(v == null ? '' : v).replace(/[ \t]+/g, ' ').trim().slice(0, max); }
function longText(v, max) { return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max); }
function isUuid(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')); }
function isDay(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T00:00:00Z')); }
function today() { return new Date().toISOString().slice(0, 10); }
function iso(v) { if (!v) return null; return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10); }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function nameOf(first, last) { return first ? (first + ' ' + (last || '')).trim() : ''; }
function initials(name) { return String(name || '').split(/\s+/).filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase(); }).join('').slice(0, 4); }

function canEdit(ctx) { return ctx.can('procurement.approve'); }
function canRead(ctx) { return canEdit(ctx) || ctx.can('procurement.read.all'); }
function needEdit(ctx) { if (!canEdit(ctx)) fail('forbidden', 'Your role does not allow this action (procurement.approve).'); }
function needRead(ctx) { if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (procurement.read.all).'); }

function dayOr(v, label) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!isDay(v)) fail('invalid', label + ' must be a date.');
  return v;
}
function number(v, label, opts) {
  var n = Number(String(v == null ? '' : v).replace(/,/g, '').trim());
  if (v === '' || v == null || !Number.isFinite(n) || n < 0 || n > 1e10 || (opts && opts.positive && !(n > 0))) fail('invalid', label);
  return n;
}

// ── reading ─────────────────────────────────────────────────────────────

var SELECT =
  'SELECT p.*, p.po_date::text AS po_day, p.delivery_date::text AS delivery_day, p.prepared_on::text AS prepared_day, p.delivered_on::text AS delivered_day, ' +
  'c.name AS company_name, c.code AS company_code FROM purchase_orders p JOIN companies c ON c.id = p.company_id ';

function shape(r, lines) {
  var ls = (lines || []).map(function (l) {
    return {
      id: l.id, description: l.description, specification: l.specification, quantity: Number(l.quantity), unit: l.unit,
      unitPrice: Number(l.unit_price), total: Number(l.total), receivedQty: l.received_qty === null ? null : Number(l.received_qty)
    };
  });
  var ordered = ls.reduce(function (s, l) { return s + l.quantity; }, 0);
  var received = ls.some(function (l) { return l.receivedQty !== null; }) ? ls.reduce(function (s, l) { return s + (l.receivedQty || 0); }, 0) : null;
  return {
    id: r.id, number: r.number, title: r.title, poDate: r.po_day,
    company: { id: r.company_id, name: r.company_name, code: r.company_code },
    supplier: { id: r.supplier_id || null, name: r.supplier_name, location: r.supplier_location, contact: r.supplier_contact },
    currency: r.currency, lines: ls, total: Number(r.total),
    quality: Array.isArray(r.quality) ? r.quality : [],
    deliveryLocation: r.delivery_location, deliveryDate: r.delivery_day, notes: r.notes,
    preparedBy: { id: r.prepared_by || null, name: r.prepared_name, position: r.prepared_position, signature: r.prepared_signature, on: r.prepared_day },
    requestId: r.request_id || null,
    status: r.status, issuedAt: r.issued_at, deliveredOn: r.delivered_day, deliveryNote: r.delivery_note,
    cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason,
    ordered: ordered, received: received,
    late: !!(r.delivery_day && r.delivery_day < today() && (r.status === 'draft' || r.status === 'issued')),
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}

async function linesOf(db, ids) {
  if (!ids.length) return new Map();
  var rows = (await db.query('SELECT * FROM purchase_order_lines WHERE po_id = ANY($1::uuid[]) ORDER BY sort_order, id', [ids])).rows;
  var by = new Map();
  rows.forEach(function (l) { if (!by.has(l.po_id)) by.set(l.po_id, []); by.get(l.po_id).push(l); });
  return by;
}

async function load(id, db) {
  db = db || pool;
  if (!isUuid(id)) fail('notfound', 'That purchase order no longer exists.');
  var r = (await db.query(SELECT + 'WHERE p.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'That purchase order no longer exists.');
  return { row: r, order: shape(r, (await linesOf(db, [id])).get(id)) };
}

// The next number for a company: its code and the next of its numbers
// (BPL 005 after BPL 004).
async function nextNumber(companyId, db) {
  db = db || pool;
  var co = (await db.query('SELECT code FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!co) fail('invalid', 'Choose the company buying.');
  var code = String(co.code || 'PO').toUpperCase();
  var nums = (await db.query('SELECT number FROM purchase_orders WHERE company_id = $1', [companyId])).rows
    .map(function (r) { var m = /(\d+)\s*$/.exec(r.number); return m ? Number(m[1]) : 0; });
  var n = nums.length ? Math.max.apply(null, nums) + 1 : 1;
  return code + ' ' + String(n).padStart(3, '0');
}

// GET /api/purchase-orders — every purchase order, newest first, and what
// the form offers: our companies (with each one's next number), the
// suppliers and farmers, the places delivered to before, and who is
// preparing it (the person signed in).
async function list(ctx) {
  needRead(ctx);
  var rows = (await pool.query(SELECT + 'ORDER BY p.po_date DESC, p.created_at DESC LIMIT 2000')).rows;
  var lines = await linesOf(pool, rows.map(function (r) { return r.id; }));
  var orders = rows.map(function (r) { return shape(r, lines.get(r.id)); });
  var companies = (await pool.query('SELECT id, code, name FROM companies ORDER BY (code = \'BPL\') DESC, name')).rows;
  for (var i = 0; i < companies.length; i++) companies[i].next = await nextNumber(companies[i].id);
  var suppliers = (await pool.query(
    "SELECT id, name, contact_person, phone, town, district, region, address, outgrower FROM suppliers WHERE status IS DISTINCT FROM 'inactive' ORDER BY name LIMIT 3000")).rows
    .map(function (s) {
      return { id: s.id, name: s.name, contactPerson: s.contact_person || '', contact: s.phone || '', location: s.town || s.district || s.region || s.address || '', outgrower: !!s.outgrower };
    });
  var places = (await pool.query(
    "SELECT delivery_location AS p, count(*)::int AS n FROM purchase_orders WHERE delivery_location <> '' GROUP BY 1 ORDER BY n DESC, p LIMIT 20")).rows.map(function (r) { return r.p; });
  var me = ctx.employee ? (await pool.query('SELECT first_name, last_name, position_title FROM employees WHERE id = $1', [ctx.employee.id])).rows[0] : null;
  var myName = me ? nameOf(me.first_name, me.last_name) : '';
  return {
    orders: orders,
    options: {
      companies: companies, suppliers: suppliers, places: places, currencies: CURRENCIES, statuses: STATUSES,
      me: { name: myName, position: me ? me.position_title || '' : '', signature: initials(myName) }
    },
    can: { edit: canEdit(ctx) },
    today: today()
  };
}

async function get(ctx, id) {
  needRead(ctx);
  return (await load(id)).order;
}

// ── writing ─────────────────────────────────────────────────────────────

function cleanLines(given) {
  if (!Array.isArray(given) || !given.length) fail('invalid', 'Add at least one line: what is being bought.');
  if (given.length > MAX_LINES) fail('invalid', 'At most ' + MAX_LINES + ' lines.');
  return given.map(function (l, i) {
    l = l || {};
    var description = text(l.description, 160);
    if (!description) fail('invalid', 'Line ' + (i + 1) + ': say what is being bought.');
    var quantity = number(l.quantity, 'Line ' + (i + 1) + ': the quantity must be more than 0.', { positive: true });
    var unitPrice = number(l.unitPrice, 'Line ' + (i + 1) + ': the unit price must be 0 or more.');
    return { description: description, specification: text(l.specification, 300), quantity: quantity, unit: text(l.unit, 20) || 'pcs', unitPrice: unitPrice, total: round2(quantity * unitPrice) };
  });
}
function cleanQuality(given) {
  return (Array.isArray(given) ? given : []).map(function (q) { return longText(q, 300); }).filter(Boolean).slice(0, MAX_QUALITY);
}

// The fields of the form, checked; fills what a chosen supplier has on
// record when left empty.
async function fields(client, body, was) {
  var f = {};
  var has = function (k) { return !was || body[k] !== undefined; };
  if (has('companyId')) {
    if (!isUuid(body.companyId)) fail('invalid', 'Choose the company buying.');
    if (!(await client.query('SELECT 1 FROM companies WHERE id = $1', [body.companyId])).rows[0]) fail('invalid', 'Choose the company buying.');
    f.company_id = body.companyId;
  }
  if (has('title')) { f.title = text(body.title, 120); if (!f.title) fail('invalid', 'Give the purchase order a title, such as Bamboo poles.'); }
  if (has('poDate')) f.po_date = dayOr(body.poDate, 'The date') || today();
  if (has('supplierId') || has('supplierName')) {
    var sup = null;
    if (body.supplierId) {
      if (!isUuid(body.supplierId)) fail('invalid', 'Choose the supplier from the list, or type their name.');
      sup = (await client.query('SELECT id, name, phone, town, district, region, address FROM suppliers WHERE id = $1', [body.supplierId])).rows[0];
      if (!sup) fail('invalid', 'That supplier is not on the list any more.');
    }
    f.supplier_id = sup ? sup.id : null;
    f.supplier_name = text(body.supplierName, 160) || (sup ? sup.name : '');
    if (!f.supplier_name) fail('invalid', 'Say who the supplier or farmer is.');
    f.supplier_location = text(body.supplierLocation, 160) || (sup ? text(sup.town || sup.district || sup.region || sup.address, 160) : '');
    f.supplier_contact = text(body.supplierContact, 80) || (sup ? text(sup.phone, 80) : '');
  } else {
    if (body.supplierLocation !== undefined) f.supplier_location = text(body.supplierLocation, 160);
    if (body.supplierContact !== undefined) f.supplier_contact = text(body.supplierContact, 80);
  }
  if (has('currency')) {
    f.currency = text(body.currency || 'GHS', 3).toUpperCase();
    if (CURRENCIES.indexOf(f.currency) < 0) fail('invalid', 'Currency must be one of ' + CURRENCIES.join(', ') + '.');
  }
  if (has('quality')) f.quality = JSON.stringify(cleanQuality(body.quality));
  if (has('deliveryLocation')) f.delivery_location = text(body.deliveryLocation, 200);
  if (has('deliveryDate')) f.delivery_date = dayOr(body.deliveryDate, 'The delivery date');
  if (has('notes')) f.notes = longText(body.notes, 2000);
  if (has('preparedName')) f.prepared_name = text(body.preparedName, 120);
  if (has('preparedPosition')) f.prepared_position = text(body.preparedPosition, 120);
  if (has('preparedSignature')) f.prepared_signature = text(body.preparedSignature, 40);
  if (has('preparedOn')) f.prepared_on = dayOr(body.preparedOn, 'The date it was prepared');
  if (has('requestId')) f.request_id = isUuid(body.requestId) ? body.requestId : null;
  return f;
}

async function numberFor(client, companyId, given, exceptId) {
  var n = text(given, 30).toUpperCase();
  if (!n) return nextNumber(companyId, client);
  var taken = (await client.query('SELECT 1 FROM purchase_orders WHERE company_id = $1 AND upper(number) = $2 AND id IS DISTINCT FROM $3', [companyId, n, exceptId || null])).rows[0];
  if (taken) fail('conflict', 'Purchase order ' + n + ' is already used by this company: give another number.');
  return n;
}

async function writeLines(client, poId, lines) {
  await client.query('DELETE FROM purchase_order_lines WHERE po_id = $1', [poId]);
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    await client.query('INSERT INTO purchase_order_lines (po_id, sort_order, description, specification, quantity, unit, unit_price, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [poId, i, l.description, l.specification, l.quantity, l.unit, l.unitPrice, l.total]);
  }
  var total = round2(lines.reduce(function (s, l) { return s + l.total; }, 0));
  await client.query('UPDATE purchase_orders SET total = $2 WHERE id = $1', [poId, total]);
  return total;
}

// POST /api/purchase-orders — a new one, as a draft.
async function create(ctx, body) {
  needEdit(ctx);
  body = body || {};
  return withTransaction(async function (client) {
    var f = await fields(client, body, null);
    var lines = cleanLines(body.lines);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['purchase_orders.number:' + f.company_id]);
    f.number = await numberFor(client, f.company_id, body.number, null);
    // Prepared by: the person signed in, unless the form says otherwise.
    var me = (await client.query('SELECT first_name, last_name, position_title FROM employees WHERE id = $1', [ctx.employee.id])).rows[0] || {};
    var myName = nameOf(me.first_name, me.last_name);
    f.prepared_by = ctx.employee.id;
    if (!f.prepared_name) f.prepared_name = myName;
    if (!f.prepared_position) f.prepared_position = me.position_title || '';
    if (!f.prepared_signature) f.prepared_signature = initials(f.prepared_name);
    if (!f.prepared_on) f.prepared_on = f.po_date;
    f.created_by = ctx.employee.id;
    var keys = Object.keys(f);
    var row = (await client.query('INSERT INTO purchase_orders (' + keys.join(', ') + ') VALUES (' + keys.map(function (k, i) { return '$' + (i + 1); }).join(', ') + ') RETURNING id, number',
      keys.map(function (k) { return f[k]; }))).rows[0];
    var total = await writeLines(client, row.id, lines);
    await audit(client, ctx, 'purchase_order.create', 'purchase_order', row.id, 'Purchase order ' + row.number + ' "' + f.title + '" to ' + f.supplier_name + ': ' + (f.currency || 'GHS') + ' ' + total.toFixed(2) + '.');
    return (await load(row.id, client)).order;
  });
}

// PATCH /api/purchase-orders/:id — changed while a draft or sent.
async function update(ctx, id, body) {
  needEdit(ctx);
  body = body || {};
  return withTransaction(async function (client) {
    var was = (await load(id, client)).row;
    if (was.status === 'delivered' || was.status === 'cancelled') fail('conflict', 'A purchase order that is ' + was.status + ' cannot be changed.');
    var f = await fields(client, body, was);
    var companyId = f.company_id || was.company_id;
    if (body.number !== undefined || f.company_id) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['purchase_orders.number:' + companyId]);
      f.number = await numberFor(client, companyId, body.number !== undefined ? body.number : was.number, id);
    }
    var keys = Object.keys(f);
    if (keys.length) {
      await client.query('UPDATE purchase_orders SET ' + keys.map(function (k, i) { return k + ' = $' + (i + 2); }).join(', ') + ', updated_at = now() WHERE id = $1',
        [id].concat(keys.map(function (k) { return f[k]; })));
    }
    if (body.lines !== undefined) await writeLines(client, id, cleanLines(body.lines));
    var after = (await load(id, client)).order;
    await audit(client, ctx, 'purchase_order.update', 'purchase_order', id, 'Changed purchase order ' + after.number + '.');
    return after;
  });
}

// POST /api/purchase-orders/:id/status { status: 'issued' | 'delivered' |
// 'cancelled' | 'draft', received?: [qty per line], deliveredOn?, note?, reason? }
async function setStatus(ctx, id, body) {
  needEdit(ctx);
  body = body || {};
  var status = String(body.status || '');
  if (STATUSES.indexOf(status) < 0) fail('invalid', 'Choose what happened to the purchase order.');
  return withTransaction(async function (client) {
    var loaded = await load(id, client);
    var was = loaded.row, po = loaded.order;
    var f = {};
    if (status === 'issued') {
      if (was.status !== 'draft') fail('conflict', 'Only a draft is sent to the supplier.');
      f.issued_at = new Date();
    } else if (status === 'delivered') {
      if (was.status !== 'issued' && was.status !== 'draft') fail('conflict', 'This purchase order is ' + was.status + '.');
      var on = dayOr(body.deliveredOn, 'The delivery date') || today();
      if (on > today()) fail('invalid', 'The day it was delivered cannot be in the future.');
      f.delivered_on = on;
      f.delivery_note = longText(body.note, 1000);
      if (!was.issued_at) f.issued_at = new Date();
      var got = Array.isArray(body.received) ? body.received : null;
      for (var i = 0; i < po.lines.length; i++) {
        var q = got && got[i] !== undefined && got[i] !== '' && got[i] !== null ? number(got[i], 'Line ' + (i + 1) + ': what came must be 0 or more.') : po.lines[i].quantity;
        await client.query('UPDATE purchase_order_lines SET received_qty = $2 WHERE id = $1', [po.lines[i].id, q]);
      }
    } else if (status === 'cancelled') {
      if (was.status === 'delivered' || was.status === 'cancelled') fail('conflict', 'This purchase order is ' + was.status + '.');
      f.cancel_reason = text(body.reason, 300);
      if (!f.cancel_reason) fail('invalid', 'Say why the purchase order is cancelled.');
      f.cancelled_at = new Date();
    } else if (status === 'draft') {
      // Back to a draft: a sent one taken back, or a delivery recorded by mistake.
      if (was.status === 'draft' || was.status === 'cancelled') fail('conflict', 'This purchase order is ' + was.status + '.');
      f.issued_at = null; f.delivered_on = null; f.delivery_note = '';
      await client.query('UPDATE purchase_order_lines SET received_qty = NULL WHERE po_id = $1', [id]);
    }
    f.status = status;
    var keys = Object.keys(f);
    await client.query('UPDATE purchase_orders SET ' + keys.map(function (k, i) { return k + ' = $' + (i + 2); }).join(', ') + ', updated_at = now() WHERE id = $1',
      [id].concat(keys.map(function (k) { return f[k]; })));
    var after = (await load(id, client)).order;
    var words = { issued: 'sent to the supplier', delivered: 'delivered' + (after.received !== null ? ' (' + after.received + ' of ' + after.ordered + ')' : ''), cancelled: 'cancelled: ' + f.cancel_reason, draft: 'back to a draft' }[status];
    await audit(client, ctx, 'purchase_order.' + status, 'purchase_order', id, 'Purchase order ' + after.number + ' ' + words + '.');
    return after;
  });
}

// DELETE /api/purchase-orders/:id — a draft, or a cancelled one.
async function remove(ctx, id) {
  needEdit(ctx);
  return withTransaction(async function (client) {
    var was = (await load(id, client)).row;
    if (was.status !== 'draft' && was.status !== 'cancelled') fail('conflict', 'Only a draft or a cancelled purchase order can be deleted.');
    await client.query('DELETE FROM purchase_orders WHERE id = $1', [id]);
    await audit(client, ctx, 'purchase_order.delete', 'purchase_order', id, 'Deleted purchase order ' + was.number + ' "' + was.title + '".');
    return { ok: true };
  });
}

module.exports = { list: list, get: get, create: create, update: update, setStatus: setStatus, remove: remove, nextNumber: nextNumber, STATUSES: STATUSES };
