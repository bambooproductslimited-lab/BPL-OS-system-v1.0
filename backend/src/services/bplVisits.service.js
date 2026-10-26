var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { internationalNumber } = require('../utils/phone');
var config = require('../config');
var fileStore = require('../lib/fileStore');

// Bamboo Products: deliveries, fitting and repairs (migration 0195).
//
// A visit takes something to a customer (delivery), fits it (install) or
// mends it (repair), on a day in a time window, by a crew. It is made for a
// shop order (its delivery), a sales order, or a customer's repair request.
// The customer is told the day and the window (a text, an email). The crew
// see their visits on their phone: on the way (the customer told), there,
// done — who received it signs, with photos — or could not be done, why.
// A shop order follows: out, then done (shop.setStatus tells the customer).
//
// Something wrong afterwards: from their order's page the customer asks for
// a repair (what, the problem, photos), followed on its own page
// (/s/<its link>). Staff say if it is under warranty (so many months from
// delivery, the settings), answer, and send someone round.
//
// Settings (settings.visits): { warrantyMonths, windows ['08:00-12:00', …],
// repairs (customers may ask from their order) }.

var KINDS = ['delivery', 'install', 'repair'];
var LIVE = ['planned', 'on_way', 'arrived'];
var MOVES = { planned: ['on_way', 'arrived', 'done', 'failed', 'cancelled'], on_way: ['arrived', 'done', 'failed', 'cancelled'], arrived: ['done', 'failed'], done: [], failed: [], cancelled: [] };
var DEFAULTS = { warrantyMonths: 12, windows: ['08:00-12:00', '12:00-16:00', '16:00-19:00'], repairs: true };
var SERVICE_STATUSES = ['new', 'visit', 'fixed', 'closed'];
var MAX_PHOTOS = 4, MAX_PHOTO_BYTES = 6 * 1024 * 1024;
var DAY = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var KIND_WORDS = { delivery: 'delivery', install: 'fitting', repair: 'repair visit' };
var SYSTEM = { can: function () { return true; }, user: { id: null }, employee: { id: null, first_name: 'Deliveries', last_name: '' } };

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function dayText(d) { return d instanceof Date ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : String(d).slice(0, 10); }
function longDay(day) { var d = new Date(day + 'T00:00:00Z'); return WEEKDAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
function vref(n) { return 'V-' + String(n).padStart(4, '0'); }
function sref(n) { return 'S-' + String(n).padStart(4, '0'); }
function nameOf(e) { return e ? (e.first_name + ' ' + (e.last_name || '')).trim() : ''; }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function mondayOf(day) { var d = new Date(day + 'T00:00:00Z'); return addDays(day, -((d.getUTCDay() + 6) % 7)); }
function sms() { return require('./sms.service'); }
function mail() { return require('./mail.service'); }
function serviceUrl(token) { return config.bplSiteUrl + '/s/' + token; }
function orderUrl(token) { return config.bplSiteUrl + '/o/' + token; }
function canRead(ctx) { return ctx.can('invoice.read'); }
function canManage(ctx) { return ctx.can('invoice.manage'); }

async function settingsOf(db) {
  var v = ((await (db || pool).query('SELECT visits FROM settings WHERE id = 1')).rows[0] || {}).visits || {};
  return cleanSettings(v);
}
function cleanSettings(v) {
  var windows = (Array.isArray(v.windows) ? v.windows : DEFAULTS.windows).map(function (w) {
    var m = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.exec(String(w || '').replace(/\s/g, ''));
    return m && w.replace(/\s/g, '').slice(0, 5) < w.replace(/\s/g, '').slice(6) ? w.replace(/\s/g, '') : null;
  }).filter(Boolean).slice(0, 8);
  return {
    warrantyMonths: Math.max(0, Math.min(120, v.warrantyMonths === 0 ? 0 : Math.round(Number(v.warrantyMonths)) || DEFAULTS.warrantyMonths)),
    windows: windows.length ? windows : DEFAULTS.windows, repairs: v.repairs !== false
  };
}

// Told by a text and an email, as they can go; [channels].
async function tellCustomer(to, subject, words, purpose, refId) {
  var by = [];
  var digits = internationalNumber(to.phone || '');
  if (digits && sms().configured()) {
    try { await sms().send({ to: '+' + digits, message: words, purpose: purpose, refId: refId }); by.push('sms'); } catch (e) { /* by email, or not at all */ }
  }
  if (to.email && mail().configured()) {
    try { await mail().send({ to: to.email, subject: subject, fromName: 'Bamboo Products', text: words }); by.push('email'); } catch (e) { /* by text, or not at all */ }
  }
  return by;
}

// The crew one can pick: Bamboo Products' active staff.
async function crewChoices(db) {
  return (await (db || pool).query(
    "SELECT e.id, e.first_name, e.last_name, e.position_title FROM employees e JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id " +
    "WHERE c.code = 'BPL' AND e.status = 'active' ORDER BY e.first_name, e.last_name LIMIT 300")).rows.map(function (e) { return { id: e.id, name: nameOf(e), position: e.position_title || '' }; });
}
async function namesOf(ids) {
  var all = Array.from(new Set([].concat.apply([], ids)));
  if (!all.length) return new Map();
  return new Map((await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = ANY($1::uuid[])', [all])).rows.map(function (e) { return [e.id, nameOf(e)]; }));
}

var VISIT_SELECT = 'SELECT v.*, o.order_no AS shop_order_no, o.token AS shop_token, s.order_no AS sales_order_no, r.number AS service_number FROM bpl_visits v ' +
  'LEFT JOIN shop_orders o ON o.id = v.shop_order_id LEFT JOIN sales_orders s ON s.id = v.sales_order_id LEFT JOIN bpl_service_requests r ON r.id = v.service_id ';
function visitOut(r, names) {
  return {
    id: r.id, ref: vref(r.number), kind: r.kind, status: r.status, day: dayText(r.day), from: r.time_from, to: r.time_to,
    shopOrder: r.shop_order_id ? { id: r.shop_order_id, orderNo: r.shop_order_no } : null, salesOrder: r.sales_order_id ? { id: r.sales_order_id, orderNo: r.sales_order_no } : null,
    service: r.service_id ? { id: r.service_id, ref: sref(r.service_number) } : null,
    name: r.name, phone: r.phone, email: r.email, address: r.address, area: r.area,
    crew: (r.crew || []).map(function (id) { return { id: id, name: names.get(id) || '' }; }), vehicle: r.vehicle, items: r.items || [], note: r.note,
    steps: r.steps || {}, signedName: r.signed_name, hasSignature: !!r.signature, signature: r.signature || null, photos: (r.photos || []).length, outcome: r.outcome,
    createdAt: r.created_at
  };
}
async function visitsOut(rows) {
  var names = await namesOf(rows.map(function (r) { return r.crew || []; }));
  return rows.map(function (r) { return visitOut(r, names); });
}

var SERVICE_SELECT = 'SELECT r.*, o.order_no, o.token AS order_token, o.steps AS order_steps FROM bpl_service_requests r LEFT JOIN shop_orders o ON o.id = r.shop_order_id ';
function warrantyUntil(steps, months) {
  var done = steps && (steps.done || steps.out);
  if (!done || !months) return null;
  var d = new Date(done);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
function serviceOut(r, s, staff) {
  var until = warrantyUntil(r.order_steps, s.warrantyMonths);
  var out = {
    id: r.id, ref: sref(r.number), status: r.status, item: r.item, problem: r.problem, photos: (r.photos || []).length, warranty: r.warranty,
    warrantyUntil: until, underWarranty: until ? until >= new Date().toISOString().slice(0, 10) : null, answer: r.answer, orderNo: r.order_no || null, createdAt: r.created_at, updatedAt: r.updated_at
  };
  if (staff) Object.assign(out, { name: r.name, phone: r.phone, email: r.email, address: r.address, link: serviceUrl(r.token), orderToken: r.order_token || null });
  else out.name = String(r.name).split(' ')[0];
  return out;
}

// GET /api/visits?from=YYYY-MM-DD — the week's visits from that Monday;
// what is waiting for one (shop deliveries, sales orders, repairs); the
// crew to pick; and one's own visits today and next.
async function board(ctx, q) {
  q = q || {};
  var me = ctx.employee && ctx.employee.id;
  var read = canRead(ctx);
  var today = new Date().toISOString().slice(0, 10);
  var from = mondayOf(DAY.test(q.from || '') ? q.from : today), to = addDays(from, 6);
  var s = await settingsOf();
  var mine = me ? await visitsOut((await pool.query(VISIT_SELECT + "WHERE $1 = ANY(v.crew) AND v.day >= $2::date AND v.day <= $2::date + 6 AND v.status <> 'cancelled' ORDER BY v.day, v.time_from", [me, today])).rows) : [];
  if (!read) {
    if (!mine.length) fail('forbidden', 'Your role does not allow this action (invoice.read).');
    return { mine: mine, canManage: false, canRead: false, settings: s, today: today, me: me };
  }
  var week = await visitsOut((await pool.query(VISIT_SELECT + "WHERE v.day >= $1::date AND v.day <= $2::date AND v.status <> 'cancelled' ORDER BY v.day, v.time_from", [from, to])).rows);
  var shopWaiting = (await pool.query(
    "SELECT o.id, o.order_no, o.name, o.phone, o.email, o.address, o.area, o.status, o.lines, o.ready_by, o.created_at FROM shop_orders o WHERE o.fulfilment = 'delivery' AND o.status IN ('new', 'making', 'ready', 'out') " +
    "AND NOT EXISTS (SELECT 1 FROM bpl_visits v WHERE v.shop_order_id = o.id AND v.status NOT IN ('cancelled', 'failed')) ORDER BY (o.status = 'ready') DESC, o.created_at LIMIT 50")).rows;
  var salesWaiting = (await pool.query(
    "SELECT s.id, s.order_no, s.status, s.promised_date, c.name, c.phone, c.email, c.address FROM sales_orders s JOIN customers c ON c.id = s.customer_id WHERE s.status IN ('pending', 'processing') " +
    "AND NOT EXISTS (SELECT 1 FROM bpl_visits v WHERE v.sales_order_id = s.id AND v.status NOT IN ('cancelled', 'failed')) ORDER BY s.promised_date NULLS LAST, s.created_at LIMIT 30")).rows;
  var services = (await pool.query(SERVICE_SELECT + "WHERE r.status IN ('new', 'visit') OR r.updated_at > now() - interval '30 days' ORDER BY (r.status = 'new') DESC, r.created_at DESC LIMIT 100")).rows;
  var liveFor = new Map((await pool.query("SELECT service_id, min(day) AS day FROM bpl_visits WHERE service_id IS NOT NULL AND status IN ('planned', 'on_way', 'arrived') GROUP BY service_id")).rows.map(function (r) { return [r.service_id, dayText(r.day)]; }));
  return {
    from: from, to: to, today: today, visits: week, mine: mine, settings: s, canManage: canManage(ctx), canRead: true, me: me,
    waiting: {
      shop: shopWaiting.map(function (o) {
        return { id: o.id, orderNo: o.order_no, name: o.name, phone: o.phone, email: o.email, address: o.address, area: o.area || '', status: o.status, readyBy: o.ready_by ? dayText(o.ready_by) : null,
          items: (o.lines || []).map(function (l) { return { description: l.description, qty: Number(l.qty) || 1 }; }) };
      }),
      sales: salesWaiting.map(function (o) { return { id: o.id, orderNo: o.order_no, name: o.name, phone: o.phone, email: o.email, address: o.address, status: o.status, promised: o.promised_date ? dayText(o.promised_date) : null }; })
    },
    services: services.map(function (r) { return Object.assign(serviceOut(r, s, true), { visitDay: liveFor.get(r.id) || null }); }),
    crew: await crewChoices(),
    counts: { week: week.length, waiting: shopWaiting.length + salesWaiting.length, repairs: services.filter(function (r) { return r.status === 'new'; }).length }
  };
}

// What a visit is for: its customer and what to bring, from the order or
// the request it is made for.
async function linked(client, p) {
  if (p.shopOrderId) {
    var o = (await client.query('SELECT * FROM shop_orders WHERE id = $1', [p.shopOrderId])).rows[0];
    if (!o) fail('notfound', 'That shop order is gone.');
    if (o.status === 'cancelled' || o.status === 'unpaid') fail('conflict', 'That order is ' + (o.status === 'unpaid' ? 'not paid yet.' : 'cancelled.'));
    return { shop: o, name: o.name, phone: o.phone, email: o.email, address: o.address, area: o.area || '', items: (o.lines || []).map(function (l) { return { description: l.description, qty: Number(l.qty) || 1 }; }) };
  }
  if (p.salesOrderId) {
    var so = (await client.query('SELECT s.*, c.name, c.phone, c.email, c.address FROM sales_orders s JOIN customers c ON c.id = s.customer_id WHERE s.id = $1', [p.salesOrderId])).rows[0];
    if (!so) fail('notfound', 'That sales order is gone.');
    var lines = await require('../utils/documents').loadLineItems(client, 'sales_order', so.id);
    return { sales: so, name: so.name, phone: so.phone, email: so.email, address: so.address, area: '', items: lines.map(function (l) { return { description: l.description, qty: Number(l.qty) || 1 }; }) };
  }
  if (p.serviceId) {
    var r = (await client.query('SELECT * FROM bpl_service_requests WHERE id = $1', [p.serviceId])).rows[0];
    if (!r) fail('notfound', 'That repair request is gone.');
    return { service: r, name: r.name, phone: r.phone, email: r.email, address: r.address, area: '', items: r.item ? [{ description: r.item, qty: 1 }] : [] };
  }
  return { name: '', phone: '', email: '', address: '', area: '', items: [] };
}
function itemsOf(raw, fallback) {
  var list = Array.isArray(raw) ? raw : fallback;
  return list.slice(0, 40).map(function (x) {
    var d = text(x && x.description, 160);
    return d ? { description: d, qty: Math.max(1, Math.min(10000, Math.round(Number(x.qty)) || 1)) } : null;
  }).filter(Boolean);
}

// POST /api/visits { id?, kind, shopOrderId | salesOrderId | serviceId, name,
// phone, email, address, area, day, from, to, crew, vehicle, items, note }
async function save(ctx, p) {
  if (!canManage(ctx)) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  p = p || {};
  var kind = KINDS.indexOf(p.kind) >= 0 ? p.kind : fail('invalid', 'A delivery, a fitting or a repair?');
  if (!DAY.test(String(p.day || ''))) fail('invalid', 'Pick the day.');
  if (!TIME.test(String(p.from || '')) || !TIME.test(String(p.to || '')) || p.to <= p.from) fail('invalid', 'Pick the time window, e.g. 08:00 to 12:00.');
  if (!p.id && p.day < new Date().toISOString().slice(0, 10)) fail('invalid', 'That day is past.');
  var crewIds = Array.from(new Set((Array.isArray(p.crew) ? p.crew : []).filter(function (x) { return /^[0-9a-f-]{36}$/i.test(String(x)); })));
  if (!crewIds.length) fail('invalid', 'Pick the crew: at least one person.');
  var known = (await pool.query("SELECT id FROM employees WHERE id = ANY($1::uuid[]) AND status = 'active'", [crewIds])).rows.map(function (r) { return r.id; });
  if (known.length !== crewIds.length) fail('invalid', 'Someone on the crew is not working here any more.');
  var saved = await withTransaction(async function (client) {
    var cur = p.id ? (await client.query('SELECT * FROM bpl_visits WHERE id = $1 FOR UPDATE', [p.id])).rows[0] : null;
    if (p.id && !cur) fail('notfound', 'That visit is gone.');
    if (cur && LIVE.indexOf(cur.status) < 0) fail('conflict', 'That visit is ' + cur.status.replace('_', ' ') + '.');
    var link = cur ? { name: cur.name, phone: cur.phone, email: cur.email, address: cur.address, area: cur.area, items: cur.items || [] } : await linked(client, p);
    var name = text(p.name, 80) || link.name;
    if (name.length < 2) fail('invalid', 'Who is it for? Their name.');
    var address = text(p.address, 300) || link.address;
    if (address.length < 3) fail('invalid', 'Where? The address.');
    var phone = text(p.phone, 30) || link.phone;
    var items = itemsOf(p.items, link.items);
    var vals = [name, phone, text(p.email, 120).toLowerCase() || link.email || '', address, text(p.area, 80) || link.area || '', p.day, p.from, p.to, crewIds, text(p.vehicle, 40), JSON.stringify(items), text(p.note, 500)];
    if (cur) {
      var moved = dayText(cur.day) !== p.day || cur.time_from !== p.from || cur.time_to !== p.to;
      var row = (await client.query(
        'UPDATE bpl_visits SET kind = $2, name = $3, phone = $4, email = $5, address = $6, area = $7, day = $8, time_from = $9, time_to = $10, crew = $11, vehicle = $12, items = $13, note = $14, updated_at = now() WHERE id = $1 RETURNING *',
        [cur.id, kind].concat(vals))).rows[0];
      return { row: row, isNew: false, moved: moved, oldCrew: cur.crew || [] };
    }
    var n = null, made = null;
    for (var i = 0; i < 5 && !made; i++) {
      n = (await client.query('SELECT coalesce(max(number), 0) + 1 AS n FROM bpl_visits')).rows[0].n;
      try {
        await client.query('SAVEPOINT v');
        made = (await client.query(
          'INSERT INTO bpl_visits (number, kind, shop_order_id, sales_order_id, service_id, name, phone, email, address, area, day, time_from, time_to, crew, vehicle, items, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *',
          [n, kind, link.shop ? link.shop.id : null, link.sales ? link.sales.id : null, link.service ? link.service.id : null].concat(vals, [ctx.employee ? ctx.employee.id : null]))).rows[0];
      } catch (e) { await client.query('ROLLBACK TO SAVEPOINT v'); if (e.code !== '23505') throw e; }
    }
    if (!made) fail('conflict', 'Could not number the visit. Try again.');
    if (link.service) await client.query("UPDATE bpl_service_requests SET status = 'visit', updated_at = now() WHERE id = $1 AND status IN ('new', 'visit')", [link.service.id]);
    return { row: made, isNew: true, moved: false, oldCrew: [] };
  });
  var r = saved.row;
  var label = vref(r.number);
  await audit(pool, ctx, saved.isNew ? 'visit.planned' : 'visit.changed', 'bpl_visit', r.id, label + ': ' + KIND_WORDS[r.kind] + ' for ' + r.name + ' on ' + longDay(dayText(r.day)) + ', ' + r.time_from + '–' + r.time_to + '.');
  // The crew are told (those newly on it); the customer, of a new day or time.
  var newCrew = (r.crew || []).filter(function (id) { return saved.oldCrew.indexOf(id) < 0; });
  var who = await pool.query('SELECT id FROM employees WHERE id = ANY($1::uuid[])', [newCrew]);
  for (var e of who.rows) {
    if (ctx.employee && e.id === ctx.employee.id) continue;
    await notify(pool, e.id, '🚚 ' + label + ' · ' + longDay(dayText(r.day)) + ' ' + r.time_from, KIND_WORDS[r.kind] + ' for ' + r.name + (r.area ? ', ' + r.area : ''), '/bplvisits?mine=1');
  }
  var told = [];
  if (saved.isNew || saved.moved) {
    var orderNo = r.shop_order_id ? (await pool.query('SELECT order_no, token FROM shop_orders WHERE id = $1', [r.shop_order_id])).rows[0] : null;
    var words = 'Bamboo Products: ' + (saved.moved ? 'we moved your ' : 'we will come for your ') + KIND_WORDS[r.kind] + (orderNo ? ' (order ' + orderNo.order_no + ')' : '') + ' ' + (saved.moved ? 'to ' : 'on ') +
      longDay(dayText(r.day)) + ', between ' + r.time_from + ' and ' + r.time_to + '. We will text you when we are on the way.' + (orderNo && orderNo.token ? ' ' + orderUrl(orderNo.token) : '');
    told = await tellCustomer(r, 'Your ' + KIND_WORDS[r.kind] + ': ' + longDay(dayText(r.day)) + ', ' + r.time_from + '–' + r.time_to, words, 'bpl_visit', r.id);
    if (told.length) await pool.query('UPDATE bpl_visits SET texted = texted || $2::jsonb WHERE id = $1', [r.id, JSON.stringify([{ what: saved.moved ? 'moved' : 'planned', by: told, at: new Date().toISOString() }])]);
  }
  return Object.assign((await visitsOut([(await pool.query(VISIT_SELECT + 'WHERE v.id = $1', [r.id])).rows[0]]))[0], { told: told });
}

// POST /api/visits/:id/:action { … } — on the way, there, done (signedName,
// signature, photos, outcome), failed (outcome), cancelled.
async function act(ctx, id, action, p) {
  p = p || {};
  var status = { 'on-way': 'on_way', arrived: 'arrived', done: 'done', failed: 'failed', cancel: 'cancelled' }[action];
  if (!status) fail('invalid', 'Unknown action.');
  var v = (await pool.query('SELECT * FROM bpl_visits WHERE id = $1', [id])).rows[0];
  if (!v) fail('notfound', 'That visit is gone.');
  var crew = ctx.employee && (v.crew || []).indexOf(ctx.employee.id) >= 0;
  if (!canManage(ctx) && !(crew && status !== 'cancelled')) fail('forbidden', 'Only its crew or a manager moves a visit on.');
  if (MOVES[v.status].indexOf(status) < 0) fail('conflict', 'That visit is ' + v.status.replace('_', ' ') + ' already.');
  var set = { photos: v.photos || [] }, outcome = text(p.outcome, 500);
  if (status === 'done') {
    var signed = text(p.signedName, 80);
    if (signed.length < 2) fail('invalid', 'Who received it? Their name.');
    var sig = Array.isArray(p.signature) && p.signature.length ? p.signature.slice(0, 60).map(function (s) { return (Array.isArray(s) ? s : []).slice(0, 400).map(function (pt) { return [Math.round(Number(pt[0]) || 0), Math.round(Number(pt[1]) || 0)]; }); }) : null;
    var photos = Array.isArray(p.photos) ? p.photos.slice(0, MAX_PHOTOS) : [];
    if (!sig && !photos.length) fail('invalid', 'Ask them to sign, or take a photo of it in place.');
    var cash = require('./restaurantCashOffice.service');
    for (var i = 0; i < photos.length; i++) set.photos = set.photos.concat([await cash.photoFrom(photos[i], 'visit-' + vref(v.number) + '-' + (i + 1))]);
    set.signed = signed; set.sig = sig;
  }
  if (status === 'failed' && outcome.length < 3) fail('invalid', 'Why could it not be done?');
  var row = (await pool.query(
    'UPDATE bpl_visits SET status = $2, steps = steps || jsonb_build_object($2::text, to_jsonb(now())), outcome = CASE WHEN $3 <> \'\' THEN $3 ELSE outcome END, ' +
    'signed_name = coalesce($4, signed_name), signature = coalesce($5, signature), photos = $6, done_by = CASE WHEN $2 = \'done\' THEN $7::uuid ELSE done_by END, updated_at = now() WHERE id = $1 AND status = $8 RETURNING *',
    [v.id, status, outcome, set.signed || null, set.sig ? JSON.stringify(set.sig) : null, JSON.stringify(set.photos), ctx.employee ? ctx.employee.id : null, v.status])).rows[0];
  if (!row) fail('conflict', 'Someone else moved that visit on: look again.');
  var label = vref(v.number);
  await audit(pool, ctx, 'visit.' + status, 'bpl_visit', v.id, label + ' (' + KIND_WORDS[v.kind] + ', ' + v.name + '): ' + status.replace('_', ' ') + (outcome ? ': ' + outcome : '') + (set.signed ? ', received by ' + set.signed : '') + '.');
  // What it was for follows.
  var told = [];
  if (v.shop_order_id && (status === 'on_way' || status === 'done')) {
    var o = (await pool.query('SELECT status, fulfilment FROM shop_orders WHERE id = $1', [v.shop_order_id])).rows[0];
    var want = status === 'on_way' ? 'out' : 'done';
    if (o && o.status !== want && o.status !== 'cancelled' && o.status !== 'unpaid' && !(want === 'out' && o.status === 'done') && (want !== 'out' || o.fulfilment === 'delivery')) {
      var shopCtx = Object.assign({}, SYSTEM, { user: ctx.user || SYSTEM.user, employee: ctx.employee || SYSTEM.employee });
      var r2 = await require('./shop.service').setStatus(shopCtx, v.shop_order_id, { status: want });
      if (r2.texted) told.push('sms'); if (r2.emailed) told.push('email');
    }
  } else if (status === 'on_way' || status === 'done' || status === 'failed') {
    var words = status === 'on_way' ? 'Bamboo Products: we are on the way for your ' + KIND_WORDS[v.kind] + '.' + (v.crew && v.crew.length ? ' ' + (await namesOf([v.crew])).get(v.crew[0]).split(' ')[0] + ' will call you if we cannot find you.' : '')
      : status === 'done' ? 'Bamboo Products: your ' + KIND_WORDS[v.kind] + ' is done' + (set.signed ? ', received by ' + set.signed : '') + '. Thank you!'
      : 'Bamboo Products: we could not do your ' + KIND_WORDS[v.kind] + ' today. We will call you to find another day.';
    told = await tellCustomer(v, status === 'failed' ? 'We will come another day' : 'Your ' + KIND_WORDS[v.kind], words, 'bpl_visit', v.id);
  }
  if (status === 'failed' && v.shop_order_id) told = told.concat(await tellCustomer(v, 'We will come another day', 'Bamboo Products: we could not deliver your order today. We will call you to find another day.', 'bpl_visit', v.id));
  if (told.length) await pool.query('UPDATE bpl_visits SET texted = texted || $2::jsonb WHERE id = $1', [v.id, JSON.stringify([{ what: status, by: told, at: new Date().toISOString() }])]);
  if (status === 'done' && v.sales_order_id && v.kind !== 'repair') {
    await pool.query("UPDATE sales_orders SET status = 'delivered', delivered_at = coalesce(delivered_at, now()) WHERE id = $1 AND status IN ('pending', 'processing')", [v.sales_order_id]);
  }
  if (v.service_id && status === 'done') await pool.query("UPDATE bpl_service_requests SET status = 'fixed', updated_at = now() WHERE id = $1 AND status IN ('new', 'visit')", [v.service_id]);
  if (v.service_id && (status === 'failed' || status === 'cancelled')) await pool.query("UPDATE bpl_service_requests SET status = 'new', updated_at = now() WHERE id = $1 AND status = 'visit'", [v.service_id]);
  return Object.assign((await visitsOut([(await pool.query(VISIT_SELECT + 'WHERE v.id = $1', [v.id])).rows[0]]))[0], { told: told });
}

// GET /api/visits/:id/photos/:n — a photo taken when it was done.
async function photoKey(ctx, id, n) {
  var v = (await pool.query('SELECT crew, photos FROM bpl_visits WHERE id = $1', [id])).rows[0];
  if (!v) fail('notfound', 'No such photo.');
  if (!canRead(ctx) && !(ctx.employee && (v.crew || []).indexOf(ctx.employee.id) >= 0)) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  var ph = (v.photos || [])[Number(n)];
  if (!ph) fail('notfound', 'No such photo.');
  return { key: ph.key, name: 'visit-' + (Number(n) + 1) + (ph.type === 'image/png' ? '.png' : '.jpg') };
}

// PUT /api/visits/settings
async function saveSettings(ctx, p) {
  if (!canManage(ctx)) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  var s = cleanSettings(p || {});
  await pool.query('UPDATE settings SET visits = $1 WHERE id = 1', [s]);
  await audit(pool, ctx, 'visit.settings', 'settings', null, 'Deliveries and repairs: warranty ' + s.warrantyMonths + ' months; windows ' + s.windows.join(', ') + (s.repairs ? '; customers ask for repairs from their order.' : '.'));
  return s;
}

// ── repairs and warranty ──

var askedBy = new Map();
function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (askedBy.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= 5) fail('ratelimited', 'Too many requests from here in the last hour. Call us instead.');
  list.push(now); askedBy.set(key, list);
  if (askedBy.size > 5000) askedBy.clear();
}

// POST /api/shop/orders/:token/service (multipart: item, problem, photos) —
// the customer asks for a repair from their order's page.
async function ask(orderToken, p, files, ip) {
  p = p || {};
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(orderToken || ''))) fail('notfound', 'We cannot find that order.');
  var o = (await pool.query('SELECT * FROM shop_orders WHERE token = $1', [orderToken])).rows[0];
  if (!o) fail('notfound', 'We cannot find that order.');
  var s = await settingsOf();
  if (!s.repairs) fail('conflict', 'Call us about a repair: we will sort it out.');
  if (['out', 'done'].indexOf(o.status) < 0) fail('conflict', 'Your order is not with you yet: a repair is asked for once it has arrived.');
  var problem = text(p.problem, 1000);
  if (problem.length < 10) fail('invalid', 'Tell us what is wrong: a few words at least.');
  var item = text(p.item, 160);
  var kept = [];
  for (var f of (files || []).slice(0, MAX_PHOTOS)) {
    if (f.buffer.length > MAX_PHOTO_BYTES) fail('invalid', 'A photo is too big.');
    var t = require('./shopQuotes.service').photoType(f.buffer);
    if (!t) fail('invalid', 'Add photos (JPG, PNG or WebP).');
    kept.push({ key: await fileStore.put('repair-request.' + t.ext, f.buffer, t.type), type: t.type });
  }
  throttle(ip);
  var row = null;
  for (var i = 0; i < 5 && !row; i++) {
    try {
      row = (await pool.query(
        'INSERT INTO bpl_service_requests (number, token, shop_order_id, customer_id, name, phone, email, address, item, problem, photos, ip) ' +
        'VALUES ((SELECT coalesce(max(number), 1000) + 1 FROM bpl_service_requests), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
        [crypto.randomBytes(18).toString('base64url'), o.id, o.customer_id, o.name, o.phone, o.email, o.address, item, problem, JSON.stringify(kept), String(ip || '').slice(0, 60)])).rows[0];
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  if (!row) fail('conflict', 'Could not number the request. Try again.');
  var label = sref(row.number);
  await audit(pool, SYSTEM, 'service.asked', 'bpl_service_request', row.id, label + ' from ' + o.name + ' (order ' + o.order_no + '): ' + (item ? item + ': ' : '') + problem.slice(0, 120) + (kept.length ? ' (' + kept.length + ' photos)' : '') + '.');
  var holders = await require('./staffAlerts.service').holdersOf(['invoice.manage']);
  for (var h = 0; h < holders.length; h++) {
    await notify(pool, holders[h].employee_id, '🛠️ Repair request ' + label, o.name + ' · ' + (item || o.order_no), '/bplvisits?repairs=1&open=' + row.id);
  }
  var told = await tellCustomer(o, 'Your repair request ' + label, 'Bamboo Products: we have your repair request ' + label + '. We will look at it and call you. Follow it here: ' + serviceUrl(row.token), 'bpl_service', row.id);
  return { ref: label, token: row.token, told: told };
}

// GET /api/shop/service/:token — the customer's own page of their request.
async function serviceView(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) fail('notfound', 'We cannot find that request.');
  var r = (await pool.query(SERVICE_SELECT + 'WHERE r.token = $1', [token])).rows[0];
  if (!r) fail('notfound', 'We cannot find that request.');
  var s = await settingsOf();
  var v = (await pool.query("SELECT * FROM bpl_visits WHERE service_id = $1 AND status <> 'cancelled' ORDER BY day DESC, created_at DESC LIMIT 1", [r.id])).rows[0];
  return Object.assign(serviceOut(r, s, false), {
    orderToken: r.order_token || null,
    visit: v ? { day: dayText(v.day), from: v.time_from, to: v.time_to, status: v.status, signedName: v.signed_name || null, doneAt: (v.steps || {}).done || null } : null
  });
}

// PUT /api/visits/services/:id { warranty, answer, status }
async function serviceUpdate(ctx, id, p) {
  if (!canManage(ctx)) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  p = p || {};
  var r = (await pool.query('SELECT * FROM bpl_service_requests WHERE id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'That request is gone.');
  var status = p.status === undefined ? r.status : SERVICE_STATUSES.indexOf(p.status) >= 0 ? p.status : fail('invalid', 'Unknown status.');
  var warranty = p.warranty === undefined ? r.warranty : p.warranty === null ? null : !!p.warranty;
  var answer = p.answer === undefined ? r.answer : text(p.answer, 800);
  var up = (await pool.query('UPDATE bpl_service_requests SET status = $2, warranty = $3, answer = $4, updated_at = now() WHERE id = $1 RETURNING *', [id, status, warranty, answer])).rows[0];
  await audit(pool, ctx, 'service.updated', 'bpl_service_request', id, sref(r.number) + ': ' + status + (warranty === true ? ', under warranty' : warranty === false ? ', not under warranty' : '') + (answer && answer !== r.answer ? ', answered' : '') + '.');
  var told = [];
  if ((answer && answer !== r.answer) || (status === 'closed' && r.status !== 'closed')) {
    told = await tellCustomer(r, 'Your repair request ' + sref(r.number), 'Bamboo Products, about your repair request ' + sref(r.number) + ': ' + (answer && answer !== r.answer ? answer + ' ' : status === 'closed' ? 'it is closed. ' : '') + serviceUrl(r.token), 'bpl_service', r.id);
  }
  var full = (await pool.query(SERVICE_SELECT + 'WHERE r.id = $1', [up.id])).rows[0];
  return Object.assign(serviceOut(full, await settingsOf(), true), { told: told });
}
// GET /api/visits/services/:id/photos/:n
async function servicePhotoKey(ctx, id, n) {
  if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  var r = (await pool.query('SELECT photos FROM bpl_service_requests WHERE id = $1', [id])).rows[0];
  var ph = r && (r.photos || [])[Number(n)];
  if (!ph) fail('notfound', 'No such photo.');
  return { key: ph.key, name: 'repair-' + (Number(n) + 1) + (ph.type === 'image/png' ? '.png' : '.jpg') };
}

// For the order's own page (shop.track): its delivery or fitting, its
// repair requests, the warranty, and whether a repair can be asked for.
async function forOrder(o) {
  var s = await settingsOf();
  var v = (await pool.query("SELECT * FROM bpl_visits WHERE shop_order_id = $1 AND status <> 'cancelled' ORDER BY day DESC, created_at DESC LIMIT 1", [o.id])).rows[0];
  var names = v ? await namesOf([v.crew || []]) : new Map();
  var services = (await pool.query('SELECT number, token, status, item, created_at FROM bpl_service_requests WHERE shop_order_id = $1 ORDER BY created_at DESC', [o.id])).rows;
  var until = warrantyUntil(o.steps, s.warrantyMonths);
  return {
    visit: v ? { kind: v.kind, day: dayText(v.day), from: v.time_from, to: v.time_to, status: v.status, crew: (v.crew || []).map(function (id) { return (names.get(id) || '').split(' ')[0]; }).filter(Boolean),
      signedName: v.signed_name || null, doneAt: (v.steps || {}).done || null, photos: (v.photos || []).length } : null,
    services: services.map(function (r) { return { ref: sref(r.number), token: r.token, status: r.status, item: r.item, at: r.created_at }; }),
    warrantyUntil: until, canAskRepair: s.repairs && ['out', 'done'].indexOf(o.status) >= 0
  };
}

module.exports = { KINDS: KINDS, settingsOf: settingsOf, saveSettings: saveSettings, board: board, save: save, act: act, photoKey: photoKey, ask: ask, serviceView: serviceView, serviceUpdate: serviceUpdate,
  servicePhotoKey: servicePhotoKey, forOrder: forOrder, MAX_PHOTOS: MAX_PHOTOS, MAX_PHOTO_BYTES: MAX_PHOTO_BYTES, _askedBy: askedBy };
