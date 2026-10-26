var { pool } = require('../db/pool');

// "Goes well with" (migration 0193) — Square's upsells on the kiosk and
// online: when a customer adds a dish on the website, the self-order kiosk
// or their table's QR page, up to three others are offered with it (a
// drink with a main, a side with the grill). The dishes a manager picked
// for it in the till's menu, or else the till's own: what was most often
// on the same bill in the last 60 days, from another section of the menu.
// A suggestion taken is marked on its order line ({ suggested: true }), so
// the till's settings show how often they were taken and what they added.

var DAYS = 60, MIN_TOGETHER = 2, MAX = 3, TTL_MS = 10 * 60000;
var cache = new Map(); // company → { at, pairs: Map(dish → [dish, …]) }

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// What is most often on the same bill as each dish: Map(dish → [dish, …]),
// best first, only dishes from another section of the menu.
async function together(companyId) {
  var hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.pairs;
  var rows = (await pool.query(
    'SELECT a.menu_item_id AS a, b.menu_item_id AS b, count(DISTINCT a.order_id)::int AS n ' +
    'FROM restaurant_orders o JOIN restaurant_order_items a ON a.order_id = o.id ' +
    'JOIN restaurant_order_items b ON b.order_id = o.id AND b.menu_item_id <> a.menu_item_id ' +
    'JOIN restaurant_menu_items ma ON ma.id = a.menu_item_id JOIN restaurant_menu_items mb ON mb.id = b.menu_item_id ' +
    "WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at > now() - make_interval(days => $2) " +
    "AND coalesce(ma.category, '') <> coalesce(mb.category, '') AND mb.active " +
    'GROUP BY 1, 2 HAVING count(DISTINCT a.order_id) >= $3 ORDER BY 1, 3 DESC, 2', [companyId, DAYS, MIN_TOGETHER])).rows;
  var pairs = new Map();
  rows.forEach(function (r) {
    var list = pairs.get(r.a) || [];
    if (list.length < MAX * 2) list.push(r.b);
    pairs.set(r.a, list);
  });
  cache.set(companyId, { at: Date.now(), pairs: pairs });
  return pairs;
}

// Each dish of a menu gets goesWith: [dish ids on that menu] (picked: the
// manager chose them) — restaurantOnline menuItems, for every channel.
async function forMenu(companyId, items) {
  if (!items.length) return;
  var on = new Set(items.map(function (i) { return i.id; }));
  var picked = new Map((await pool.query('SELECT id, goes_with FROM restaurant_menu_items WHERE id = ANY($1::uuid[])', [Array.from(on)])).rows
    .map(function (r) { return [r.id, r.goes_with || []]; }));
  var auto = await together(companyId);
  items.forEach(function (i) {
    var mine = (picked.get(i.id) || []).filter(function (id) { return on.has(id) && id !== i.id; });
    i.goesWithPicked = mine.length > 0;
    if (!mine.length) mine = (auto.get(i.id) || []).filter(function (id) { return on.has(id); });
    i.goesWith = mine.slice(0, MAX);
  });
}

// A manager's picks for a dish: up to three of the company's other dishes.
async function cleanPicks(db, companyId, dishId, ids) {
  var want = (Array.isArray(ids) ? ids : []).map(String).filter(function (id, k, all) { return /^[0-9a-f-]{36}$/i.test(id) && id !== dishId && all.indexOf(id) === k; }).slice(0, MAX);
  if (!want.length) return [];
  var ok = new Set((await db.query('SELECT id FROM restaurant_menu_items WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, want])).rows.map(function (r) { return r.id; }));
  return want.filter(function (id) { return ok.has(id); });
}
function forget(companyId) { cache.delete(companyId); }

// How the suggestions did in the last `days` days: taken how often, what
// they added, on which channel, and the dishes taken most.
async function report(companyId, days) {
  days = Math.min(365, Math.max(1, Math.round(Number(days) || 30)));
  var rows = (await pool.query(
    "SELECT 'online' AS channel, l FROM restaurant_online_orders o, jsonb_array_elements(o.items) l " +
    "WHERE o.company_id = $1 AND o.created_at > now() - make_interval(days => $2) AND o.status NOT IN ('rejected', 'cancelled', 'unpaid') AND (l->>'suggested') = 'true' " +
    "UNION ALL SELECT CASE WHEN t.kind = 'kiosk' THEN 'kiosk' ELSE 'table' END, l FROM restaurant_table_orders t, jsonb_array_elements(t.items) l " +
    "WHERE t.company_id = $1 AND t.created_at > now() - make_interval(days => $2) AND t.status NOT IN ('rejected', 'cancelled', 'unpaid') AND (l->>'suggested') = 'true'", [companyId, days])).rows;
  var by = { online: { taken: 0, added: 0 }, kiosk: { taken: 0, added: 0 }, table: { taken: 0, added: 0 } };
  var dishes = new Map();
  rows.forEach(function (r) {
    var l = r.l || {}, qty = Number(l.qty) || 1, value = Number(l.lineTotal != null ? l.lineTotal : (Number(l.unitPrice) || 0) * qty) || 0;
    by[r.channel].taken += qty; by[r.channel].added += value;
    var d = dishes.get(l.menuItemId) || { name: l.name || '', taken: 0, added: 0 };
    d.taken += qty; d.added += value;
    dishes.set(l.menuItemId, d);
  });
  Object.keys(by).forEach(function (k) { by[k].added = round2(by[k].added); });
  var top = Array.from(dishes.values()).sort(function (a, b) { return b.taken - a.taken || b.added - a.added; }).slice(0, 8)
    .map(function (d) { return { name: d.name, taken: d.taken, added: round2(d.added) }; });
  return {
    days: days, taken: by.online.taken + by.kiosk.taken + by.table.taken, added: round2(by.online.added + by.kiosk.added + by.table.added),
    byChannel: by, top: top
  };
}

module.exports = { forMenu: forMenu, cleanPicks: cleanPicks, together: together, forget: forget, report: report, MAX: MAX };
