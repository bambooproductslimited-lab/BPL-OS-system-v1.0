var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Uniforms and PPE (Operations → Uniforms and PPE; migration 0200). What the
// company hands out — boots, gloves, helmets, overalls, chef jackets — with
// its sizes, how long it lasts and what it costs, and the departments that
// must have it. The store's stock by size; what each person holds and when
// it is due for replacing; who in a department that needs something has not
// got it; requests from My space (new, worn out, damaged, lost, wrong size).
// Each person keeps their sizes in My space so the right one is picked. A
// leaver hands back what they hold (onboarding.service.js); replacements due
// and stock running low are chased (jobs/dailyAlerts.js).

var REASONS = ['new', 'worn', 'damaged', 'lost', 'size'];
var CONDITIONS = ['good', 'worn', 'damaged'];

function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function round2(n) { return Math.round(n * 100) / 100; }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function can(ctx) { return ctx.can('ppe.manage'); }
function need(ctx) { if (!can(ctx)) fail('forbidden', 'Your role does not allow this action (ppe.manage).'); }
function addMonths(day, n) { var d = new Date(day + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
function daysTo(day) { return Math.round((Date.parse(day + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000); }

function itemOut(i, stock) {
  var mine = stock.filter(function (s) { return s.item_id === i.id; });
  var sizes = (i.sizes || []).length ? i.sizes : [''];
  var bySize = sizes.map(function (sz) {
    var s = mine.find(function (x) { return x.size === sz; }) || { qty: 0, min_qty: 0 };
    return { size: sz, qty: s.qty, min: s.min_qty, low: s.min_qty > 0 && s.qty <= s.min_qty };
  });
  return {
    id: i.id, name: i.name, kind: i.kind, sizes: i.sizes || [], lifeMonths: i.life_months, unitCost: Number(i.unit_cost), requiredFor: i.required_for || [], perPerson: i.per_person, active: i.active,
    stock: bySize, total: bySize.reduce(function (a, s) { return a + s.qty; }, 0), low: bySize.filter(function (s) { return s.low; }).length,
    out: Number(i.out || 0)
  };
}
var ISSEL = 'SELECT s.*, i.name AS item, i.kind AS item_kind, e.first_name, e.last_name, e.position_title, d.name AS department, b.first_name AS b_first, b.last_name AS b_last ' +
  'FROM ppe_issues s JOIN ppe_items i ON i.id = s.item_id JOIN employees e ON e.id = s.employee_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN employees b ON b.id = s.issued_by ';
function issueOut(s) {
  var due = dayText(s.due_on);
  return {
    id: s.id, itemId: s.item_id, item: s.item, kind: s.item_kind, size: s.size, qty: s.qty, issuedOn: dayText(s.issued_on), dueOn: due,
    dueIn: s.status === 'out' && due ? daysTo(due) : null, status: s.status, endedOn: dayText(s.ended_on), condition: s.condition, cost: Number(s.cost), note: s.note,
    person: { id: s.employee_id, name: nameOf(s.first_name, s.last_name), position: s.position_title || '', department: s.department || '' },
    issuedBy: nameOf(s.b_first, s.b_last)
  };
}
var RQSEL = 'SELECT r.*, i.name AS item, e.first_name, e.last_name, d.name AS department FROM ppe_requests r JOIN ppe_items i ON i.id = r.item_id JOIN employees e ON e.id = r.employee_id LEFT JOIN departments d ON d.id = e.department_id ';
function requestOut(r) {
  return { id: r.id, itemId: r.item_id, item: r.item, size: r.size, reason: r.reason, note: r.note, status: r.status, declineNote: r.decline_note, createdAt: r.created_at, decidedAt: r.decided_at,
    person: { id: r.employee_id, name: nameOf(r.first_name, r.last_name), department: r.department || '' } };
}

async function itemsWithStock(activeOnly) {
  var items = (await pool.query("SELECT i.*, (SELECT coalesce(sum(qty), 0) FROM ppe_issues s WHERE s.item_id = i.id AND s.status = 'out') AS out FROM ppe_items i" + (activeOnly ? ' WHERE i.active' : '') + ' ORDER BY i.kind, i.name')).rows;
  var stock = (await pool.query('SELECT * FROM ppe_stock')).rows;
  return items.map(function (i) { return itemOut(i, stock); });
}

// Who in a department that needs an item does not hold one.
async function gapsOf() {
  var items = (await pool.query("SELECT * FROM ppe_items WHERE active AND jsonb_array_length(required_for) > 0")).rows;
  var out = [];
  for (var k = 0; k < items.length; k++) {
    var depts = items[k].required_for.filter(uuidOr);
    if (!depts.length) continue;
    var rows = (await pool.query(
      "SELECT e.id, e.first_name, e.last_name, d.name AS department, z.sizes FROM employees e JOIN departments d ON d.id = e.department_id LEFT JOIN ppe_sizes z ON z.employee_id = e.id " +
      "WHERE e.status = 'active' AND e.department_id = ANY($1) AND NOT EXISTS (SELECT 1 FROM ppe_issues s WHERE s.employee_id = e.id AND s.item_id = $2 AND s.status = 'out') ORDER BY d.name, e.first_name", [depts, items[k].id])).rows;
    rows.forEach(function (r) { out.push({ itemId: items[k].id, item: items[k].name, person: { id: r.id, name: nameOf(r.first_name, r.last_name), department: r.department }, size: ((r.sizes || {})[items[k].id]) || '' }); });
  }
  return out;
}

// GET /api/ppe
async function overview(ctx) {
  need(ctx);
  var items = await itemsWithStock(false);
  var due = (await pool.query(ISSEL + "WHERE s.status = 'out' AND s.due_on <= current_date + 30 AND e.status = 'active' ORDER BY s.due_on LIMIT 80")).rows.map(issueOut);
  var recent = (await pool.query(ISSEL + 'ORDER BY s.created_at DESC LIMIT 30')).rows.map(issueOut);
  var requests = (await pool.query(RQSEL + "WHERE r.status = 'requested' ORDER BY r.created_at")).rows.map(requestOut);
  var gaps = await gapsOf();
  var month = (await pool.query("SELECT coalesce(sum(qty), 0)::int AS n, coalesce(sum(cost), 0) AS cost FROM ppe_issues WHERE issued_on >= date_trunc('month', current_date)")).rows[0];
  var year = (await pool.query("SELECT i.name, coalesce(sum(s.cost), 0) AS cost, coalesce(sum(s.qty), 0)::int AS qty FROM ppe_issues s JOIN ppe_items i ON i.id = s.item_id WHERE s.issued_on >= date_trunc('year', current_date) GROUP BY 1 ORDER BY 2 DESC")).rows
    .map(function (r) { return { item: r.name, cost: round2(Number(r.cost)), qty: r.qty }; });
  var people = (await pool.query("SELECT e.id, e.first_name, e.last_name, d.name AS department, z.sizes FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN ppe_sizes z ON z.employee_id = e.id WHERE e.status = 'active' ORDER BY e.first_name, e.last_name")).rows
    .map(function (p) { return { id: p.id, name: nameOf(p.first_name, p.last_name), department: p.department || '', sizes: p.sizes || {} }; });
  var departments = (await pool.query('SELECT d.id, d.name, c.name AS company FROM departments d LEFT JOIN companies c ON c.id = d.company_id ORDER BY c.name, d.name')).rows;
  return {
    items: items, due: due, recent: recent, requests: requests, gaps: gaps, people: people, departments: departments, spendYear: year, reasons: REASONS,
    summary: {
      issuedMonth: month.n, costMonth: round2(Number(month.cost)), costYear: round2(year.reduce(function (a, r) { return a + r.cost; }, 0)),
      overdue: due.filter(function (d) { return d.dueIn < 0; }).length, dueSoon: due.filter(function (d) { return d.dueIn >= 0; }).length,
      requests: requests.length, gaps: gaps.length, lowStock: items.reduce(function (a, i) { return a + (i.active ? i.low : 0); }, 0),
      out: items.reduce(function (a, i) { return a + i.out; }, 0)
    }
  };
}

// GET /api/ppe/person/:id — what they hold, what they had, their sizes.
async function person(ctx, id) {
  need(ctx);
  var e = (await pool.query('SELECT e.id, e.first_name, e.last_name, e.position_title, d.name AS department, z.sizes FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN ppe_sizes z ON z.employee_id = e.id WHERE e.id = $1', [uuidOr(id)])).rows[0];
  if (!e) fail('notfound', 'No such person.');
  var issues = (await pool.query(ISSEL + 'WHERE s.employee_id = $1 ORDER BY s.status = \'out\' DESC, s.issued_on DESC', [e.id])).rows.map(issueOut);
  var requests = (await pool.query(RQSEL + 'WHERE r.employee_id = $1 ORDER BY r.created_at DESC LIMIT 10', [e.id])).rows.map(requestOut);
  return { id: e.id, name: nameOf(e.first_name, e.last_name), position: e.position_title || '', department: e.department || '', sizes: e.sizes || {}, issues: issues, requests: requests,
    cost: round2(issues.reduce(function (a, s) { return a + s.cost; }, 0)) };
}

// POST /api/ppe/items, PUT /api/ppe/items/:id { name, kind, sizes, lifeMonths,
// unitCost, requiredFor, perPerson, active, minQty: { size: n } }
async function saveItem(ctx, id, p) {
  need(ctx);
  p = p || {};
  var name = text(p.name, 80);
  if (name.length < 2) fail('invalid', 'What is it called?');
  var sizes = (Array.isArray(p.sizes) ? p.sizes : String(p.sizes || '').split(',')).map(function (s) { return text(s, 12); }).filter(Boolean).filter(function (s, n, a) { return a.indexOf(s) === n; }).slice(0, 20);
  var life = Math.max(0, Math.min(120, Math.round(Number(p.lifeMonths) || 0)));
  var cost = Math.max(0, round2(Number(p.unitCost) || 0));
  var required = (Array.isArray(p.requiredFor) ? p.requiredFor : []).map(uuidOr).filter(Boolean);
  var per = Math.max(1, Math.min(10, Math.round(Number(p.perPerson) || 1)));
  var row;
  if (id) {
    var cur = (await pool.query('SELECT * FROM ppe_items WHERE id = $1', [uuidOr(id)])).rows[0];
    if (!cur) fail('notfound', 'That item is gone.');
    row = (await pool.query('UPDATE ppe_items SET name = $2, kind = $3, sizes = $4, life_months = $5, unit_cost = $6, required_for = $7, per_person = $8, active = $9 WHERE id = $1 RETURNING *',
      [cur.id, name, p.kind === 'uniform' ? 'uniform' : 'ppe', JSON.stringify(sizes), life, cost, JSON.stringify(required), per, p.active !== false])).rows[0];
  } else {
    row = (await pool.query('INSERT INTO ppe_items (name, kind, sizes, life_months, unit_cost, required_for, per_person) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [name, p.kind === 'uniform' ? 'uniform' : 'ppe', JSON.stringify(sizes), life, cost, JSON.stringify(required), per])).rows[0];
  }
  var mins = p.minQty || {};
  var all = sizes.length ? sizes : [''];
  for (var i = 0; i < all.length; i++) {
    var m = Math.max(0, Math.round(Number(mins[all[i]]) || 0));
    await pool.query('INSERT INTO ppe_stock (item_id, size, qty, min_qty) VALUES ($1,$2,0,$3) ON CONFLICT (item_id, size) DO UPDATE SET min_qty = EXCLUDED.min_qty', [row.id, all[i], m]);
  }
  await audit(pool, ctx, 'ppe.item', 'ppe_item', row.id, '"' + name + '" saved.');
  return overview(ctx);
}

// POST /api/ppe/stock { itemId, size, qty, note } — delivered to the store
// (a negative qty takes some out: counted short, thrown away).
async function receive(ctx, p) {
  need(ctx);
  p = p || {};
  var item = (await pool.query('SELECT * FROM ppe_items WHERE id = $1', [uuidOr(p.itemId)])).rows[0];
  if (!item) fail('invalid', 'Which item?');
  var size = text(p.size, 12);
  if ((item.sizes || []).length && item.sizes.indexOf(size) < 0) fail('invalid', 'Which size?');
  var qty = Math.round(Number(p.qty) || 0);
  if (!qty || Math.abs(qty) > 10000) fail('invalid', 'How many?');
  var row = (await pool.query('INSERT INTO ppe_stock (item_id, size, qty) VALUES ($1,$2,$3) ON CONFLICT (item_id, size) DO UPDATE SET qty = ppe_stock.qty + EXCLUDED.qty RETURNING qty', [item.id, size, Math.max(0, qty)])).rows[0];
  if (qty < 0) {
    var after = (await pool.query('UPDATE ppe_stock SET qty = qty + $3 WHERE item_id = $1 AND size = $2 AND qty + $3 >= 0 RETURNING qty', [item.id, size, qty])).rows[0];
    if (!after) fail('invalid', 'There are only ' + row.qty + ' in the store.');
  }
  await audit(pool, ctx, 'ppe.stock', 'ppe_item', item.id, (qty > 0 ? '+' : '') + qty + ' ' + item.name + (size ? ' (' + size + ')' : '') + (p.note ? ': ' + text(p.note, 200) : '') + '.');
  return overview(ctx);
}

// POST /api/ppe/issue { employeeId, itemId, size, qty, note, requestId, replaces }
async function issue(ctx, p) {
  need(ctx);
  p = p || {};
  var emp = (await pool.query("SELECT id, first_name FROM employees WHERE id = $1 AND status = 'active'", [uuidOr(p.employeeId)])).rows[0];
  if (!emp) fail('invalid', 'Who is it for?');
  var item = (await pool.query('SELECT * FROM ppe_items WHERE id = $1 AND active', [uuidOr(p.itemId)])).rows[0];
  if (!item) fail('invalid', 'Which item?');
  var size = text(p.size, 12);
  if ((item.sizes || []).length && item.sizes.indexOf(size) < 0) fail('invalid', 'Which size?');
  var qty = Math.max(1, Math.min(20, Math.round(Number(p.qty) || 1)));
  var request = uuidOr(p.requestId) ? (await pool.query("SELECT * FROM ppe_requests WHERE id = $1 AND status = 'requested'", [p.requestId])).rows[0] : null;
  if (p.requestId && !request) fail('conflict', 'That request has been dealt with.');
  var replaces = uuidOr(p.replaces);
  var row = await withTransaction(async function (db) {
    var left = (await db.query('UPDATE ppe_stock SET qty = qty - $3 WHERE item_id = $1 AND size = $2 AND qty >= $3 RETURNING qty', [item.id, size, qty])).rows[0];
    if (!left) {
      var have = (await db.query('SELECT qty FROM ppe_stock WHERE item_id = $1 AND size = $2', [item.id, size])).rows[0];
      fail('conflict', 'Not enough in the store: ' + (have ? have.qty : 0) + ' ' + item.name + (size ? ' in ' + size : '') + '.');
    }
    var due = item.life_months ? addMonths(today(), item.life_months) : null;
    var s = (await db.query('INSERT INTO ppe_issues (item_id, size, qty, employee_id, due_on, cost, note, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [item.id, size, qty, emp.id, due, round2(Number(item.unit_cost) * qty), text(p.note, 300), me(ctx)])).rows[0];
    if (replaces) await db.query("UPDATE ppe_issues SET status = 'replaced', ended_on = current_date WHERE id = $1 AND employee_id = $2 AND status = 'out'", [replaces, emp.id]);
    else if (request && request.reason !== 'new') {
      // Asked for because the old one is worn, damaged, lost or the wrong size: that one ends.
      await db.query("UPDATE ppe_issues SET status = $3, ended_on = current_date WHERE id = (SELECT id FROM ppe_issues WHERE employee_id = $1 AND item_id = $2 AND status = 'out' ORDER BY issued_on LIMIT 1)",
        [emp.id, item.id, request.reason === 'lost' ? 'lost' : 'replaced']);
    }
    if (request) await db.query("UPDATE ppe_requests SET status = 'issued', decided_by = $2, decided_at = now(), issue_id = $3 WHERE id = $1", [request.id, me(ctx), s.id]);
    return s;
  });
  if (emp.id !== me(ctx)) await notify(pool, emp.id, '🦺 ' + item.name + (size ? ' (' + size + ')' : '') + ' for you', request ? 'Your request is ready: collect it from the store.' : 'Handed to you' + (row.due_on ? '; due for a new one on ' + dayText(row.due_on) : '') + '.', '/myspace');
  await audit(pool, ctx, 'ppe.issue', 'employee', emp.id, qty + ' × ' + item.name + (size ? ' (' + size + ')' : '') + ' issued.');
  return issueOut((await pool.query(ISSEL + 'WHERE s.id = $1', [row.id])).rows[0]);
}

// POST /api/ppe/issues/:id/return { status: returned|lost, condition, restock }
async function giveBack(ctx, id, p, opts) {
  if (!(opts && opts.system)) need(ctx);
  p = p || {};
  var s = (await pool.query("SELECT * FROM ppe_issues WHERE id = $1", [uuidOr(id)])).rows[0];
  if (!s) fail('notfound', 'That is not on record.');
  if (s.status !== 'out') fail('conflict', 'It is back already.');
  var status = p.status === 'lost' ? 'lost' : 'returned';
  var condition = status === 'returned' && CONDITIONS.indexOf(p.condition) >= 0 ? p.condition : '';
  await pool.query('UPDATE ppe_issues SET status = $2, condition = $3, ended_on = current_date WHERE id = $1', [s.id, status, condition]);
  // Back in good condition: it goes back on the shelf.
  if (status === 'returned' && condition === 'good' && p.restock) await pool.query('INSERT INTO ppe_stock (item_id, size, qty) VALUES ($1,$2,$3) ON CONFLICT (item_id, size) DO UPDATE SET qty = ppe_stock.qty + EXCLUDED.qty', [s.item_id, s.size, s.qty]);
  await audit(pool, ctx, 'ppe.return', 'employee', s.employee_id, 'PPE ' + status + (condition ? ' (' + condition + ')' : '') + '.');
  return { ok: true };
}

// POST /api/ppe/requests { itemId, size, reason, note } — anyone, from My space.
async function request(ctx, p) {
  if (!me(ctx)) fail('forbidden', 'Only staff ask here.');
  p = p || {};
  var item = (await pool.query('SELECT * FROM ppe_items WHERE id = $1 AND active', [uuidOr(p.itemId)])).rows[0];
  if (!item) fail('invalid', 'What do you need?');
  var size = text(p.size, 12);
  if ((item.sizes || []).length && item.sizes.indexOf(size) < 0) fail('invalid', 'Which size?');
  if ((await pool.query("SELECT 1 FROM ppe_requests WHERE employee_id = $1 AND item_id = $2 AND status = 'requested'", [me(ctx), item.id])).rows[0]) fail('conflict', 'You have asked for that already.');
  var reason = REASONS.indexOf(p.reason) >= 0 ? p.reason : 'new';
  var row = (await pool.query('INSERT INTO ppe_requests (employee_id, item_id, size, reason, note) VALUES ($1,$2,$3,$4,$5) RETURNING id', [me(ctx), item.id, size, reason, text(p.note, 300)])).rows[0];
  // Remember the size they asked for.
  await pool.query("INSERT INTO ppe_sizes (employee_id, sizes) VALUES ($1, jsonb_build_object($2::text, $3::text)) ON CONFLICT (employee_id) DO UPDATE SET sizes = ppe_sizes.sizes || EXCLUDED.sizes, updated_at = now()", [me(ctx), item.id, size]);
  var holders = await require('./staffAlerts.service').holdersOf(['ppe.manage']);
  var who = nameOf(ctx.employee.first_name, ctx.employee.last_name);
  for (var i = 0; i < holders.length; i++) if (holders[i].employee_id !== me(ctx)) await notify(pool, holders[i].employee_id, '🦺 ' + who + ' needs ' + item.name + (size ? ' (' + size + ')' : ''), { new: 'New', worn: 'Worn out', damaged: 'Damaged', lost: 'Lost', size: 'Wrong size' }[reason] + (p.note ? ': ' + text(p.note, 120) : '.'), '/ppe?tab=requests');
  await audit(pool, ctx, 'ppe.request', 'ppe_item', item.id, 'Asked for ' + item.name + (size ? ' (' + size + ')' : '') + ': ' + reason + '.');
  return { id: row.id };
}

// POST /api/ppe/requests/:id/decline { note } — or /cancel by whoever asked.
async function closeRequest(ctx, id, to, p) {
  var r = (await pool.query("SELECT * FROM ppe_requests WHERE id = $1", [uuidOr(id)])).rows[0];
  if (!r) fail('notfound', 'That request is gone.');
  if (r.status !== 'requested') fail('conflict', 'It has been dealt with.');
  if (to === 'cancelled') { if (r.employee_id !== me(ctx)) fail('forbidden', 'Not your request.'); }
  else need(ctx);
  var note = text(p && p.note, 300);
  if (to === 'declined' && note.length < 3) fail('invalid', 'Tell them why.');
  await pool.query('UPDATE ppe_requests SET status = $2, decided_by = $3, decided_at = now(), decline_note = $4 WHERE id = $1', [r.id, to, me(ctx), note]);
  if (to === 'declined') await notify(pool, r.employee_id, '🦺 Your request was declined', note, '/myspace');
  return { ok: true };
}

// GET /api/ppe/mine — My space: what I hold, my sizes, my requests.
async function mine(ctx) {
  if (!me(ctx)) return { held: [], sizes: {}, items: [], requests: [] };
  var held = (await pool.query(ISSEL + "WHERE s.employee_id = $1 AND s.status = 'out' ORDER BY s.due_on NULLS LAST", [me(ctx)])).rows.map(issueOut);
  var sizes = ((await pool.query('SELECT sizes FROM ppe_sizes WHERE employee_id = $1', [me(ctx)])).rows[0] || {}).sizes || {};
  var items = (await pool.query('SELECT id, name, kind, sizes FROM ppe_items WHERE active ORDER BY kind, name')).rows.map(function (i) { return { id: i.id, name: i.name, kind: i.kind, sizes: i.sizes || [] }; });
  var requests = (await pool.query(RQSEL + "WHERE r.employee_id = $1 AND (r.status = 'requested' OR r.decided_at > now() - interval '14 days') ORDER BY r.created_at DESC", [me(ctx)])).rows.map(requestOut);
  // What their department must have that they do not hold.
  var dept = ((await pool.query('SELECT department_id FROM employees WHERE id = $1', [me(ctx)])).rows[0] || {}).department_id;
  var missing = dept ? (await pool.query("SELECT id, name FROM ppe_items WHERE active AND required_for ? $1 AND NOT EXISTS (SELECT 1 FROM ppe_issues s WHERE s.item_id = ppe_items.id AND s.employee_id = $2 AND s.status = 'out')", [dept, me(ctx)])).rows : [];
  return { held: held, sizes: sizes, items: items, requests: requests, missing: missing.map(function (m) { return { id: m.id, name: m.name }; }), reasons: REASONS };
}

// PUT /api/ppe/mine/sizes { sizes: { itemId: size } }
async function saveSizes(ctx, p) {
  if (!me(ctx)) fail('forbidden', 'Only staff keep sizes here.');
  var given = (p && p.sizes) || {};
  var items = (await pool.query('SELECT id, sizes FROM ppe_items WHERE active')).rows;
  var clean = {};
  items.forEach(function (i) { var v = text(given[i.id], 12); if (v && (i.sizes || []).indexOf(v) >= 0) clean[i.id] = v; });
  await pool.query('INSERT INTO ppe_sizes (employee_id, sizes) VALUES ($1,$2) ON CONFLICT (employee_id) DO UPDATE SET sizes = EXCLUDED.sizes, updated_at = now()', [me(ctx), JSON.stringify(clean)]);
  return mine(ctx);
}

// For a leaver's checklist: what they hold.
async function heldBy(employeeId) {
  return (await pool.query("SELECT s.id, s.qty, s.size, i.name FROM ppe_issues s JOIN ppe_items i ON i.id = s.item_id WHERE s.employee_id = $1 AND s.status = 'out' ORDER BY i.name", [employeeId])).rows
    .map(function (r) { return { id: r.id, label: (r.qty > 1 ? r.qty + ' × ' : '') + r.name + (r.size ? ' (' + r.size + ')' : '') }; });
}
// For the daily round: replacements due within a week; sizes running low.
async function dueSoon() {
  return (await pool.query("SELECT s.id, s.employee_id, s.due_on, s.size, i.name FROM ppe_issues s JOIN ppe_items i ON i.id = s.item_id JOIN employees e ON e.id = s.employee_id WHERE s.status = 'out' AND e.status = 'active' AND s.due_on <= current_date + 7")).rows;
}
async function lowStock() {
  return (await pool.query("SELECT i.id, i.name, array_agg(CASE WHEN st.size = '' THEN st.qty::text ELSE st.size || ': ' || st.qty END ORDER BY st.size) AS sizes FROM ppe_stock st JOIN ppe_items i ON i.id = st.item_id WHERE i.active AND st.min_qty > 0 AND st.qty <= st.min_qty GROUP BY i.id, i.name")).rows;
}

module.exports = {
  overview: overview, person: person, saveItem: saveItem, receive: receive, issue: issue, giveBack: giveBack, request: request, closeRequest: closeRequest,
  mine: mine, saveSizes: saveSizes, heldBy: heldBy, dueSoon: dueSoon, lowStock: lowStock
};
