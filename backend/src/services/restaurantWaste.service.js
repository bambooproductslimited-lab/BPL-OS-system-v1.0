var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// Waste and stock takes (migration 0193) — Square's inventory adjustments
// with a reason, and its inventory counts.
//
// Waste: anyone on the till says what was thrown away and why (dropped,
// gone off, made wrong, sent back…). It comes off the stock: a dish that
// counts its stock, and the ingredients of its recipe; an ingredient or a
// supply itself. Its cost is what it cost to make (the recipe, or the cost
// set by hand) or to buy. Taken back within WASTE_UNDO_MIN by whoever
// logged it (or a manager), everything goes back. The back office shows
// the waste by reason, by item and by day, and against the sales.
//
// Stock take: a manager (or a stock keeper) counts everything in one go —
// every dish that counts its stock, the supplies and the ingredients, with
// what the till expects of each. Counted figures are kept as they are typed
// (a stock take may take an hour, on two phones); finished, each counted
// figure becomes the stock, and the difference from what the till held then
// (sales go on meanwhile) is kept with its value: missing or found.

var REASONS = ['dropped', 'expired', 'spoiled', 'made_wrong', 'sent_back', 'staff_meal', 'other'];
var REASON_WORDS = { dropped: 'dropped', expired: 'gone past its date', spoiled: 'gone off', made_wrong: 'made wrong', sent_back: 'sent back', staff_meal: 'staff meal', other: 'other' };
var TABLES = { menu: 'restaurant_menu_items', supply: 'restaurant_supplies', ingredient: 'restaurant_ingredients' };
var WASTE_UNDO_MIN = 15;

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function round4(n) { return Math.round(Number(n) * 10000) / 10000; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function tm() { return require('./restaurantTillMenu.service'); }
function costs() { return require('./restaurantCosts.service'); }
function nameOf(e) { return e ? (e.first_name + ' ' + (e.last_name || '')).trim() : ''; }
function auditor(e) { return { user: { id: null }, employee: { first_name: e.first_name, last_name: e.last_name } }; }

async function staffOn(token) {
  var session = await access.need(token, ['till', 'stock', 'kds']);
  var e = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [session.posEmployeeId])).rows[0];
  return { session: session, by: e, company: session.posCompanyId, manager: session.access.role === 'manager' || !!session.access.can.stock };
}

function wasteOut(r) {
  return {
    id: r.id, type: r.item_type, itemId: r.item_id, name: r.name, unit: r.unit, qty: Number(r.qty), reason: r.reason, cost: Number(r.cost), note: r.note,
    by: r.by_name || '', byId: r.created_by, at: r.created_at, undone: !!r.undone_at,
    canUndo: !r.undone_at && Date.now() - new Date(r.created_at).getTime() < WASTE_UNDO_MIN * 60000
  };
}
var WASTE_SELECT = "SELECT w.*, e.first_name || ' ' || coalesce(e.last_name, '') AS by_name FROM restaurant_waste w LEFT JOIN employees e ON e.id = w.created_by ";

// Something thrown away: { type: menu|supply|ingredient, id, variationId,
// qty, reason, note }.
async function logWaste(company, by, p) {
  p = p || {};
  var table = TABLES[p.type];
  if (!table) fail('invalid', 'Pick what was thrown away.');
  var reason = REASONS.indexOf(p.reason) >= 0 ? p.reason : fail('invalid', 'Say why it was thrown away.');
  var qty = round2(p.qty);
  if (!(qty > 0 && qty <= 9999)) fail('invalid', 'Type how many, more than 0.');
  var note = text(p.note, 200);
  return withTransaction(async function (client) {
    var cur = (await client.query('SELECT * FROM ' + table + ' WHERE id = $1 AND company_id = $2 FOR UPDATE', [p.id, company])).rows[0];
    if (!cur) fail('notfound', 'That is not on this restaurant\'s menu or stock.');
    var moves = [], cost = 0, name = cur.name, unit = cur.unit || 'each', variationId = null;
    var why = 'Thrown away (' + REASON_WORDS[reason] + ')' + (note ? ': ' + note : '');
    if (p.type === 'menu') {
      if (p.variationId) {
        var v = (await client.query('SELECT id, name FROM restaurant_menu_item_variations WHERE id = $1 AND menu_item_id = $2', [p.variationId, cur.id])).rows[0];
        if (!v) fail('invalid', 'Pick one of ' + cur.name + '\'s sizes.');
        variationId = v.id; name = cur.name + ' — ' + v.name;
      }
      unit = 'each';
      var c = (await costs().forLines(client, company, [{ menuItemId: cur.id, variationId: variationId, qty: qty, modifiers: [] }]))[0];
      cost = c.unitCost == null ? 0 : round2(c.unitCost * qty);
      if (cur.track_stock) {
        var after = round2(Number(cur.stock_qty) - qty);
        await client.query('UPDATE restaurant_menu_items SET stock_qty = $2, updated_at = now() WHERE id = $1', [cur.id, after]);
        await tm().logMove(client, { companyId: company, type: 'menu', id: cur.id, kind: 'wasted', delta: -qty, after: after, unitCost: c.unitCost || 0, note: why, by: by.id });
        moves.push({ type: 'menu', id: cur.id, qty: qty });
      }
      // The ingredients its recipe takes.
      var use = {};
      (c.lines || []).forEach(function (r) { use[r.ingredientId] = (use[r.ingredientId] || 0) + r.qty * qty; });
      for (var ing of Object.keys(use)) {
        var q = round4(use[ing]);
        var ir = (await client.query('UPDATE restaurant_ingredients SET stock_qty = stock_qty - $2, updated_at = now() WHERE id = $1 AND company_id = $3 RETURNING stock_qty, unit_cost', [ing, q, company])).rows[0];
        if (!ir) continue;
        await tm().logMove(client, { companyId: company, type: 'ingredient', id: ing, kind: 'wasted', delta: -q, after: ir.stock_qty, unitCost: ir.unit_cost, note: name + ': ' + why, by: by.id });
        moves.push({ type: 'ingredient', id: ing, qty: q });
      }
    } else {
      if (Number(cur.stock_qty) < qty) fail('invalid', 'Only ' + Number(cur.stock_qty) + ' ' + unit + ' of ' + cur.name + ' in stock.');
      var left = round2(Number(cur.stock_qty) - qty);
      await client.query('UPDATE ' + table + ' SET stock_qty = $2, updated_at = now() WHERE id = $1', [cur.id, left]);
      await tm().logMove(client, { companyId: company, type: p.type, id: cur.id, kind: 'wasted', delta: -qty, after: left, unitCost: cur.unit_cost, note: why, by: by.id });
      moves.push({ type: p.type, id: cur.id, qty: qty });
      cost = round2(qty * Number(cur.unit_cost || 0));
    }
    var row = (await client.query(
      'INSERT INTO restaurant_waste (company_id, item_type, item_id, variation_id, name, unit, qty, reason, cost, note, moves, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [company, p.type, cur.id, variationId, name, unit, qty, reason, cost, note, JSON.stringify(moves), by.id])).rows[0];
    var summary = 'Thrown away: ' + qty + (unit === 'each' ? '× ' : ' ' + unit + ' of ') + name + ' (' + REASON_WORDS[reason] + ')' + (cost ? ', costing ' + cost.toFixed(2) : '') + (note ? ' · ' + note : '') + '.';
    await audit(client, auditor(by), 'restaurant.waste', 'restaurant_waste', row.id, summary);
    await activity.log(client, { companyId: company, employeeId: by.id, app: 'till', action: 'till.waste', summary: summary, amount: cost, refType: 'waste', refId: row.id });
    return row;
  });
}

// Taken back: what came off the stock goes back.
async function undoWaste(company, by, manager, id) {
  return withTransaction(async function (client) {
    var w = (await client.query('SELECT * FROM restaurant_waste WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, company])).rows[0];
    if (!w) fail('notfound', 'That is gone.');
    if (w.undone_at) fail('conflict', 'It was taken back already.');
    if (w.created_by !== by.id && !manager) fail('forbidden', 'Only whoever wrote it, or a manager, takes it back.');
    if (!manager && Date.now() - new Date(w.created_at).getTime() > WASTE_UNDO_MIN * 60000) fail('conflict', 'It is too late to take it back: ask a manager.');
    for (var m of (w.moves || [])) {
      var r = (await client.query('UPDATE ' + TABLES[m.type] + ' SET stock_qty = stock_qty + $2, updated_at = now() WHERE id = $1 RETURNING stock_qty, ' + (m.type === 'menu' ? '0' : 'unit_cost') + ' AS unit_cost', [m.id, m.qty])).rows[0];
      if (r) await tm().logMove(client, { companyId: company, type: m.type, id: m.id, kind: 'count', delta: m.qty, after: r.stock_qty, unitCost: r.unit_cost, note: 'Taken back: ' + w.name + ' was not thrown away', by: by.id });
    }
    await client.query('UPDATE restaurant_waste SET undone_at = now() WHERE id = $1', [id]);
    var summary = 'Taken back: ' + Number(w.qty) + '× ' + w.name + ' was not thrown away.';
    await activity.log(client, { companyId: company, employeeId: by.id, app: 'till', action: 'till.waste_undo', summary: summary, refType: 'waste', refId: id });
    return w;
  });
}

// What can be thrown away: the menu's dishes (with their sizes), the
// supplies and the ingredients.
async function choices(company) {
  var dishes = (await pool.query('SELECT id, name, category FROM restaurant_menu_items WHERE company_id = $1 AND active ORDER BY category, name', [company])).rows;
  var vars = dishes.length ? (await pool.query('SELECT id, menu_item_id, name FROM restaurant_menu_item_variations WHERE menu_item_id = ANY($1::uuid[]) ORDER BY sort_order', [dishes.map(function (d) { return d.id; })])).rows : [];
  var supplies = (await pool.query('SELECT id, name, unit, stock_qty FROM restaurant_supplies WHERE company_id = $1 AND active ORDER BY name', [company])).rows;
  var ingredients = (await pool.query('SELECT id, name, unit, stock_qty FROM restaurant_ingredients WHERE company_id = $1 AND active ORDER BY name', [company])).rows;
  return {
    dishes: dishes.map(function (d) { return { id: d.id, name: d.name, category: d.category || '', sizes: vars.filter(function (v) { return v.menu_item_id === d.id; }).map(function (v) { return { id: v.id, name: v.name }; }) }; }),
    supplies: supplies.map(function (s) { return { id: s.id, name: s.name, unit: s.unit, left: Number(s.stock_qty) }; }),
    ingredients: ingredients.map(function (s) { return { id: s.id, name: s.name, unit: s.unit, left: Number(s.stock_qty) }; }),
    reasons: REASONS
  };
}
async function today(company) {
  var rows = (await pool.query(WASTE_SELECT + "WHERE w.company_id = $1 AND w.created_at >= date_trunc('day', now()) ORDER BY w.created_at DESC LIMIT 60", [company])).rows.map(wasteOut);
  return { list: rows, cost: round2(rows.filter(function (r) { return !r.undone; }).reduce(function (a, r) { return a + r.cost; }, 0)) };
}

// POST /api/pos/waste { action: choices | log | undo | today } — the till.
async function till(token, p) {
  p = p || {};
  var s = await staffOn(token);
  if (p.action === 'choices') return choices(s.company);
  var done = null;
  if (p.action === 'log') done = wasteOut(await logWaste(s.company, s.by, p));
  if (p.action === 'undo') { await undoWaste(s.company, s.by, s.manager, p.id); }
  return Object.assign({ logged: done }, await today(s.company));
}

// The back office: waste from..to (days, inclusive), by reason, by item, by
// day, and against what was sold then.
async function report(company, q) {
  q = q || {};
  var to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : new Date().toISOString().slice(0, 10);
  var from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : new Date(Date.parse(to + 'T00:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
  var where = 'w.company_id = $1 AND w.undone_at IS NULL AND w.created_at >= $2::date AND w.created_at < $3::date + 1';
  var args = [company, from, to];
  var rows = (await pool.query(WASTE_SELECT + 'WHERE ' + where + ' ORDER BY w.created_at DESC LIMIT 300', args)).rows.map(wasteOut);
  var byReason = (await pool.query('SELECT w.reason, count(*)::int AS n, coalesce(sum(w.cost), 0) AS cost FROM restaurant_waste w WHERE ' + where + ' GROUP BY 1 ORDER BY 3 DESC', args)).rows
    .map(function (r) { return { reason: r.reason, count: r.n, cost: round2(r.cost) }; });
  var byItem = (await pool.query('SELECT w.name, w.unit, sum(w.qty) AS qty, coalesce(sum(w.cost), 0) AS cost, count(*)::int AS n FROM restaurant_waste w WHERE ' + where + ' GROUP BY 1, 2 ORDER BY 4 DESC, 3 DESC LIMIT 10', args)).rows
    .map(function (r) { return { name: r.name, unit: r.unit, qty: Number(r.qty), cost: round2(r.cost), count: r.n }; });
  var byDay = (await pool.query("SELECT to_char(w.created_at, 'YYYY-MM-DD') AS day, coalesce(sum(w.cost), 0) AS cost, count(*)::int AS n FROM restaurant_waste w WHERE " + where + ' GROUP BY 1 ORDER BY 1', args)).rows
    .map(function (r) { return { day: r.day, cost: round2(r.cost), count: r.n }; });
  var sales = Number((await pool.query("SELECT coalesce(sum(total), 0) AS t FROM restaurant_orders WHERE company_id = $1 AND status = 'completed' AND created_at >= $2::date AND created_at < $3::date + 1", args)).rows[0].t);
  var cost = round2(byReason.reduce(function (a, r) { return a + r.cost; }, 0));
  return { from: from, to: to, cost: cost, count: rows.length, sales: round2(sales), ofSales: sales > 0 ? Math.round(cost / sales * 1000) / 10 : null, byReason: byReason, byItem: byItem, byDay: byDay, list: rows.slice(0, 60) };
}

// ── stock takes ──

function takeOut(t, names) {
  var lines = t.lines || [];
  var counted = lines.filter(function (l) { return l.counted !== null && l.counted !== undefined; });
  var value = function (l) { return l.variance == null ? 0 : round2(l.variance * (l.unitCost || 0)); };
  return {
    id: t.id, status: t.status, note: t.note, lines: lines, counted: counted.length, total: lines.length,
    missing: round2(lines.reduce(function (a, l) { var v = value(l); return a + (v < 0 ? -v : 0); }, 0)),
    found: round2(lines.reduce(function (a, l) { var v = value(l); return a + (v > 0 ? v : 0); }, 0)),
    startedBy: names[t.started_by] || '', finishedBy: names[t.finished_by] || '', createdAt: t.created_at, updatedAt: t.updated_at, finishedAt: t.finished_at
  };
}
async function names(ids) {
  ids = ids.filter(Boolean);
  if (!ids.length) return {};
  var out = {};
  (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = ANY($1::uuid[])', [ids])).rows.forEach(function (e) { out[e.id] = nameOf(e); });
  return out;
}
async function takes(company) {
  var rows = (await pool.query("SELECT * FROM restaurant_stock_takes WHERE company_id = $1 AND (status = 'open' OR finished_at > now() - interval '120 days') ORDER BY (status = 'open') DESC, created_at DESC LIMIT 12", [company])).rows;
  var n = await names([].concat.apply([], rows.map(function (r) { return [r.started_by, r.finished_by]; })));
  var open = rows.find(function (r) { return r.status === 'open'; });
  return { open: open ? takeOut(open, n) : null, past: rows.filter(function (r) { return r.status !== 'open'; }).map(function (r) { var o = takeOut(r, n); delete o.lines; return o; }) };
}
// Everything counted on the till, with what it expects now.
async function snapshot(company) {
  var st = await tm().stock(company);
  var menuCost = await costs().costsOf(pool, company, st.menu.map(function (m) { return m.id; }));
  var line = function (type, i) {
    var unitCost = type === 'menu' ? ((menuCost[i.id + '|'] || {}).cost) : i.unitCost;
    return { type: type, id: i.id, name: i.name, category: i.category || '', unit: i.unit, expected: i.qty, counted: null, unitCost: unitCost == null ? 0 : round4(unitCost) };
  };
  return [].concat(st.menu.map(function (i) { return line('menu', i); }), st.ingredients.map(function (i) { return line('ingredient', i); }), st.supplies.map(function (i) { return line('supply', i); }));
}

// POST /api/pos/stock-take { action: list | start | save | finish | drop,
// lines: [{ type, id, counted }], note } — a manager or a stock keeper.
async function stockTake(token, p, ip) {
  p = p || {};
  var session = await access.need(token, ['till', 'stock', 'kds']).catch(function () { return null; });
  var by, company;
  if (session && session.access.can.stock) {
    by = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [session.posEmployeeId])).rows[0];
    company = session.posCompanyId;
  } else {
    var m = await access.settingsManager(token, p.managerPin, ip);
    by = m.manager; company = m.session.posCompanyId;
  }
  if (p.action === 'start') {
    var lines = await snapshot(company);
    if (!lines.length) fail('invalid', 'Nothing counts its stock yet: turn on counting for dishes, or add ingredients and supplies.');
    try {
      await pool.query('INSERT INTO restaurant_stock_takes (company_id, lines, started_by) VALUES ($1, $2, $3)', [company, JSON.stringify(lines), by.id]);
    } catch (e) { if (e.code === '23505') fail('conflict', 'A stock take is open already: carry on with it.'); throw e; }
    await activity.log(pool, { companyId: company, employeeId: by.id, app: 'settings', action: 'stock.take_start', summary: 'Stock take started: ' + lines.length + ' items to count.' });
  } else if (p.action === 'save' || p.action === 'finish' || p.action === 'drop') {
    await withTransaction(async function (client) {
      var t = (await client.query("SELECT * FROM restaurant_stock_takes WHERE company_id = $1 AND status = 'open' FOR UPDATE", [company])).rows[0];
      if (!t) fail('conflict', 'There is no stock take open.');
      var lines = t.lines || [];
      (Array.isArray(p.lines) ? p.lines : []).forEach(function (u) {
        var l = lines.find(function (x) { return x.type === u.type && x.id === u.id; });
        if (!l) return;
        if (u.counted === null || u.counted === '' || u.counted === undefined) { l.counted = null; return; }
        var n = round2(u.counted);
        if (!(n >= 0 && n < 1e9)) fail('invalid', 'Type how many of ' + l.name + ' there are, 0 or more.');
        l.counted = n;
      });
      if (p.action === 'drop') {
        await client.query("UPDATE restaurant_stock_takes SET status = 'dropped', lines = $2, finished_by = $3, finished_at = now(), updated_at = now() WHERE id = $1", [t.id, JSON.stringify(lines), by.id]);
        return;
      }
      if (p.action === 'finish') {
        var counted = lines.filter(function (l) { return l.counted !== null && l.counted !== undefined; });
        if (!counted.length) fail('invalid', 'Count something first.');
        for (var l of counted) {
          var table = TABLES[l.type];
          var cur = (await client.query('SELECT * FROM ' + table + ' WHERE id = $1 AND company_id = $2 FOR UPDATE', [l.id, company])).rows[0];
          if (!cur) { l.variance = null; continue; }
          l.before = Number(cur.stock_qty);
          l.variance = round2(l.counted - l.before);
          if (l.variance !== 0) {
            await client.query('UPDATE ' + table + ' SET stock_qty = $2, updated_at = now() WHERE id = $1', [cur.id, l.counted]);
            await tm().logMove(client, { companyId: company, type: l.type, id: cur.id, kind: 'count', delta: l.variance, after: l.counted, unitCost: l.unitCost, note: 'Stock take', by: by.id });
          }
        }
        var out = takeOut(Object.assign({}, t, { lines: lines }), {});
        await client.query("UPDATE restaurant_stock_takes SET status = 'done', lines = $2, note = $3, finished_by = $4, finished_at = now(), updated_at = now() WHERE id = $1",
          [t.id, JSON.stringify(lines), text(p.note, 300), by.id]);
        var summary = 'Stock take finished: ' + counted.length + ' counted' + (out.missing ? ', ' + out.missing.toFixed(2) + ' missing' : '') + (out.found ? ', ' + out.found.toFixed(2) + ' more than expected' : '') + '.';
        await audit(client, auditor(by), 'restaurant.stock_take', 'restaurant_stock_take', t.id, summary);
        await activity.log(client, { companyId: company, employeeId: by.id, app: 'settings', action: 'stock.take_done', summary: summary, amount: -out.missing + out.found });
        return;
      }
      await client.query('UPDATE restaurant_stock_takes SET lines = $2, updated_at = now() WHERE id = $1', [t.id, JSON.stringify(lines)]);
    });
  }
  return Object.assign(await takes(company), { by: nameOf(by) });
}

// The back office's waste report, by a manager.
async function wasteReport(token, p, ip) {
  var m = await access.settingsManager(token, (p || {}).managerPin, ip);
  return report(m.session.posCompanyId, p);
}

module.exports = { till: till, report: report, wasteReport: wasteReport, stockTake: stockTake, logWaste: logWaste, undoWaste: undoWaste, REASONS: REASONS, WASTE_UNDO_MIN: WASTE_UNDO_MIN };
