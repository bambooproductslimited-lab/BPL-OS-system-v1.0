var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// Stock sent from one restaurant to another (migration 0194): Star Bar
// runs out of rice, Bamboo Garden sends ten kilos. The sender picks the
// restaurant and the ingredients and supplies with how many: it comes off
// their stock at once, at what it cost them. The other restaurant's till
// shows it coming; whoever counts it in says how many arrived of each and
// which of their own items it is (matched by name, or added as new): it
// goes onto their stock at the sender's cost. Less than sent is noted on
// both sides. The sender may take it back while it is on its way.

var TABLES = { ingredient: 'restaurant_ingredients', supply: 'restaurant_supplies' };
var MAX_LINES = 40;
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function ref(n) { return 'T-' + String(n).padStart(4, '0'); }
function nameOf(e) { return e ? (e.first_name + ' ' + (e.last_name || '')).trim() : ''; }
function tm() { return require('./restaurantTillMenu.service'); }

// Who may: anyone with the stock permission, or with a manager's PIN.
async function stockPerson(token, managerPin, ip) {
  var session = await access.need(token, ['till', 'stock', 'kds', 'delivery']).catch(function () { return null; });
  if (session && (session.access.can.stock || session.access.role === 'manager')) {
    return { by: (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [session.posEmployeeId])).rows[0], company: session.posCompanyId };
  }
  var m = await access.settingsManager(token, managerPin, ip);
  return { by: m.manager, company: m.session.posCompanyId };
}
// The other restaurants (those with a till or a menu).
async function restaurants(companyId) {
  return (await pool.query(
    "SELECT c.id, c.code, c.name FROM companies c WHERE c.id <> $1 AND c.status = 'active' AND (EXISTS (SELECT 1 FROM restaurant_till_settings t WHERE t.company_id = c.id) " +
    'OR EXISTS (SELECT 1 FROM restaurant_menu_items m WHERE m.company_id = c.id)) ORDER BY c.name', [companyId])).rows;
}
function transferOut(t, me) {
  var lines = t.lines || [];
  return {
    id: t.id, ref: ref(t.number), status: t.status, direction: t.from_company === me ? 'out' : 'in',
    from: { id: t.from_company, name: t.from_name }, to: { id: t.to_company, name: t.to_name },
    lines: lines, value: round2(t.value), note: t.note, receivedNote: t.received_note,
    sentBy: t.sent_name || '', sentAt: t.sent_at, receivedBy: t.received_name || '', receivedAt: t.received_at,
    short: t.status === 'received' ? lines.filter(function (l) { return Number(l.receivedQty) < Number(l.qty); }).length : 0
  };
}
var SELECT = "SELECT t.*, fc.name AS from_name, tc.name AS to_name, se.first_name || ' ' || coalesce(se.last_name, '') AS sent_name, re.first_name || ' ' || coalesce(re.last_name, '') AS received_name " +
  'FROM restaurant_stock_transfers t JOIN companies fc ON fc.id = t.from_company JOIN companies tc ON tc.id = t.to_company ' +
  'LEFT JOIN employees se ON se.id = t.sent_by LEFT JOIN employees re ON re.id = t.received_by ';

// What this restaurant may send, the restaurants, what is coming in (with
// each line's match among its own items) and the last 60 days both ways.
async function view(companyId) {
  var items = [];
  for (var type of ['ingredient', 'supply']) {
    (await pool.query('SELECT id, name, unit, stock_qty, unit_cost FROM ' + TABLES[type] + ' WHERE company_id = $1 AND active ORDER BY name', [companyId])).rows.forEach(function (r) {
      items.push({ type: type, id: r.id, name: r.name, unit: r.unit || 'each', stock: round2(r.stock_qty), unitCost: round2(r.unit_cost || 0) });
    });
  }
  var list = (await pool.query(SELECT + "WHERE (t.from_company = $1 OR t.to_company = $1) AND (t.status = 'sent' OR t.sent_at > now() - interval '60 days') ORDER BY t.sent_at DESC LIMIT 60", [companyId])).rows
    .map(function (t) { return transferOut(t, companyId); });
  list.filter(function (t) { return t.direction === 'in' && t.status === 'sent'; }).forEach(function (t) {
    t.lines.forEach(function (l) {
      var same = items.filter(function (i) { return i.type === l.type && i.name.toLowerCase() === String(l.name).toLowerCase(); });
      l.match = same.length ? { id: same[0].id, name: same[0].name, unit: same[0].unit } : null;
    });
  });
  return {
    restaurants: (await restaurants(companyId)).map(function (r) { return { id: r.id, name: r.name }; }),
    items: items, incoming: list.filter(function (t) { return t.direction === 'in' && t.status === 'sent'; }),
    list: list, waiting: list.filter(function (t) { return t.direction === 'in' && t.status === 'sent'; }).length
  };
}

// Sent: { to, lines: [{ type, id, qty }], note } — off this restaurant's stock now.
async function send(company, by, p) {
  var to = (await restaurants(company)).find(function (r) { return r.id === p.to; });
  if (!to) fail('invalid', 'Pick the restaurant to send to.');
  var raw = Array.isArray(p.lines) ? p.lines.filter(function (l) { return l && Number(l.qty) > 0; }) : [];
  if (!raw.length) fail('invalid', 'Put at least one thing to send, with how many.');
  if (raw.length > MAX_LINES) fail('invalid', 'Up to ' + MAX_LINES + ' things in one transfer.');
  var note = text(p.note, 200);
  var from = (await pool.query('SELECT name FROM companies WHERE id = $1', [company])).rows[0];
  return withTransaction(async function (client) {
    var lines = [], value = 0, seen = new Set();
    var number = (await client.query('SELECT coalesce(max(number), 0) + 1 AS n FROM restaurant_stock_transfers WHERE from_company = $1', [company])).rows[0].n;
    for (var l of raw) {
      var table = TABLES[l.type];
      if (!table) fail('invalid', 'Only ingredients and supplies are sent between restaurants.');
      if (seen.has(l.type + l.id)) fail('invalid', 'Each thing once in a transfer.');
      seen.add(l.type + l.id);
      var cur = (await client.query('SELECT * FROM ' + table + ' WHERE id = $1 AND company_id = $2 AND active FOR UPDATE', [l.id, company])).rows[0];
      if (!cur) fail('notfound', 'That is not in this restaurant\'s stock.');
      var qty = round2(l.qty);
      if (!(qty > 0 && qty <= 100000)) fail('invalid', 'How many of ' + cur.name + '? More than 0.');
      if (qty > Number(cur.stock_qty)) fail('invalid', 'Only ' + round2(cur.stock_qty) + ' ' + (cur.unit || 'each') + ' of ' + cur.name + ' in stock.');
      var after = round2(Number(cur.stock_qty) - qty);
      await client.query('UPDATE ' + table + ' SET stock_qty = $2, updated_at = now() WHERE id = $1', [cur.id, after]);
      await tm().logMove(client, { companyId: company, type: l.type, id: cur.id, kind: 'transfer_out', delta: -qty, after: after, unitCost: cur.unit_cost || 0, note: 'Sent to ' + to.name + ' (' + ref(number) + ')', by: by.id });
      lines.push({ type: l.type, id: cur.id, name: cur.name, unit: cur.unit || 'each', qty: qty, unitCost: round2(cur.unit_cost || 0) });
      value += qty * Number(cur.unit_cost || 0);
    }
    var t = (await client.query('INSERT INTO restaurant_stock_transfers (number, from_company, to_company, lines, value, note, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [number, company, to.id, JSON.stringify(lines), round2(value), note, by.id])).rows[0];
    var words = lines.map(function (x) { return x.qty + ' ' + (x.unit === 'each' ? '' : x.unit + ' ') + x.name; }).join(', ');
    await activity.log(client, { companyId: company, employeeId: by.id, app: 'settings', action: 'stock.transfer_out', summary: ref(number) + ' sent to ' + to.name + ': ' + words + '.', amount: round2(value) });
    await activity.log(client, { companyId: to.id, employeeId: null, app: 'settings', action: 'stock.transfer_coming', summary: from.name + ' sent ' + ref(number) + ': ' + words + '. Count it in on the till (More → Stock coming in).', amount: round2(value) });
    return t.id;
  });
}

// Counted in: { id, lines: [{ qty (arrived), toId (this restaurant's item,
// or 'new') }], note } — onto this restaurant's stock at the sender's cost.
async function receive(company, by, p) {
  return withTransaction(async function (client) {
    var t = (await client.query('SELECT t.*, fc.name AS from_name FROM restaurant_stock_transfers t JOIN companies fc ON fc.id = t.from_company WHERE t.id = $1 AND t.to_company = $2 FOR UPDATE', [p.id, company])).rows[0];
    if (!t) fail('notfound', 'That transfer is not for this restaurant.');
    if (t.status !== 'sent') fail('conflict', t.status === 'received' ? 'It was counted in already.' : 'The sender took it back.');
    var given = Array.isArray(p.lines) ? p.lines : [];
    var lines = t.lines || [];
    if (given.length !== lines.length) fail('invalid', 'Say how many arrived of each thing sent.');
    var short = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i], g = given[i] || {};
      var got = round2(g.qty);
      if (!(got >= 0 && got <= Number(l.qty) * 2)) fail('invalid', 'How many of ' + l.name + ' arrived? From 0 to ' + Number(l.qty) * 2 + '.');
      var table = TABLES[l.type], cur;
      if (g.toId && g.toId !== 'new') {
        cur = (await client.query('SELECT * FROM ' + table + ' WHERE id = $1 AND company_id = $2 AND active FOR UPDATE', [g.toId, company])).rows[0];
        if (!cur) fail('invalid', 'Pick which of this restaurant\'s items ' + l.name + ' is, or add it as new.');
      } else if (got > 0) {
        // Added as new: its name, unit and cost as the sender has them.
        cur = (await client.query(l.type === 'supply'
          ? "INSERT INTO restaurant_supplies (company_id, name, category, unit, stock_qty, reorder_level, unit_cost, active) VALUES ($1,$2,'General',$3,0,0,$4,true) RETURNING *"
          : 'INSERT INTO restaurant_ingredients (company_id, name, unit, stock_qty, reorder_level, unit_cost, active) VALUES ($1,$2,$3,0,0,$4,true) RETURNING *', [company, l.name, l.unit, l.unitCost])).rows[0];
      }
      if (cur && got > 0) {
        var after = round2(Number(cur.stock_qty) + got);
        await client.query('UPDATE ' + table + ' SET stock_qty = $2, unit_cost = CASE WHEN unit_cost > 0 THEN unit_cost ELSE $3 END, updated_at = now() WHERE id = $1', [cur.id, after, l.unitCost]);
        await tm().logMove(client, { companyId: company, type: l.type, id: cur.id, kind: 'transfer_in', delta: got, after: after, unitCost: l.unitCost, note: 'From ' + t.from_name + ' (' + ref(t.number) + ')', by: by.id });
      }
      l.receivedQty = got; l.toId = cur ? cur.id : null;
      if (got < Number(l.qty)) short.push(round2(Number(l.qty) - got) + ' ' + (l.unit === 'each' ? '' : l.unit + ' ') + l.name);
    }
    var note = text(p.note, 200);
    await client.query("UPDATE restaurant_stock_transfers SET status = 'received', lines = $2, received_by = $3, received_at = now(), received_note = $4 WHERE id = $1", [t.id, JSON.stringify(lines), by.id, note]);
    var me = (await client.query('SELECT name FROM companies WHERE id = $1', [company])).rows[0];
    var words = short.length ? ', short: ' + short.join(', ') : ', all of it';
    await activity.log(client, { companyId: company, employeeId: by.id, app: 'settings', action: 'stock.transfer_in', summary: ref(t.number) + ' from ' + t.from_name + ' counted in' + words + (note ? ' (' + note + ')' : '') + '.', amount: round2(t.value) });
    await activity.log(client, { companyId: t.from_company, employeeId: null, app: 'settings', action: 'stock.transfer_received', summary: me.name + ' counted in ' + ref(t.number) + words + (note ? ' (' + note + ')' : '') + '.', amount: round2(t.value) });
  });
}

// Taken back while on its way: onto the sender's stock again.
async function cancel(company, by, p) {
  return withTransaction(async function (client) {
    var t = (await client.query('SELECT t.*, tc.name AS to_name FROM restaurant_stock_transfers t JOIN companies tc ON tc.id = t.to_company WHERE t.id = $1 AND t.from_company = $2 FOR UPDATE', [p.id, company])).rows[0];
    if (!t) fail('notfound', 'That transfer is not this restaurant\'s.');
    if (t.status !== 'sent') fail('conflict', 'Only a transfer on its way can be taken back.');
    for (var l of t.lines || []) {
      var cur = (await client.query('SELECT * FROM ' + TABLES[l.type] + ' WHERE id = $1 AND company_id = $2 FOR UPDATE', [l.id, company])).rows[0];
      if (!cur) continue;
      var after = round2(Number(cur.stock_qty) + Number(l.qty));
      await client.query('UPDATE ' + TABLES[l.type] + ' SET stock_qty = $2, updated_at = now() WHERE id = $1', [cur.id, after]);
      await tm().logMove(client, { companyId: company, type: l.type, id: cur.id, kind: 'transfer_in', delta: Number(l.qty), after: after, unitCost: l.unitCost, note: ref(t.number) + ' taken back', by: by.id });
    }
    await client.query("UPDATE restaurant_stock_transfers SET status = 'cancelled' WHERE id = $1", [t.id]);
    await activity.log(client, { companyId: company, employeeId: by.id, app: 'settings', action: 'stock.transfer_cancelled', summary: ref(t.number) + ' to ' + t.to_name + ' taken back.' });
    await activity.log(client, { companyId: t.to_company, employeeId: null, app: 'settings', action: 'stock.transfer_cancelled', summary: ref(t.number) + ' was taken back by the sender.' });
  });
}

// POST /api/pos/transfers { action: view|send|receive|cancel, …, managerPin }
async function transfers(token, p, ip) {
  p = p || {};
  var who = await stockPerson(token, p.managerPin, ip);
  if (p.action === 'send') await send(who.company, who.by, p);
  else if (p.action === 'receive') await receive(who.company, who.by, p);
  else if (p.action === 'cancel') await cancel(who.company, who.by, p);
  var out = await view(who.company);
  out.byName = nameOf(who.by);
  return out;
}
// GET /api/pos/transfers/waiting — how many are on their way here (the till's More menu).
async function waiting(token) {
  var s = await access.need(token, ['till', 'stock', 'kds', 'delivery']);
  var n = (await pool.query("SELECT count(*)::int AS n FROM restaurant_stock_transfers WHERE to_company = $1 AND status = 'sent'", [s.posCompanyId])).rows[0].n;
  return { waiting: n, can: !!(s.access.can.stock || s.access.role === 'manager') };
}

module.exports = { transfers: transfers, waiting: waiting, view: view };
