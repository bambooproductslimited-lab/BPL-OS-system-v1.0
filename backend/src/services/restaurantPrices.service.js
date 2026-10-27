var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { notify } = require('../utils/notify');

// Supplier price watch (migration 0197), on a restaurant's till: what each
// ingredient and supply cost every time it came in (a purchase order
// received, or stock entered as come in, with its price), how that moved —
// the last against the one before, the lowest and highest of 90 days —
// which supplier sold it for less, and which dishes it goes into. When a
// purchase order comes in dearer than before by more than the restaurant's
// share (settings 'prices', 5% unless changed), the managers are told.

var DEFAULTS = { alertPercent: 5 };
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function round4(n) { return Math.round(Number(n || 0) * 10000) / 10000; }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function pct(a, b) { return b > 0 ? Math.round((a - b) / b * 1000) / 10 : null; }
var TABLE = { ingredient: 'restaurant_ingredients', supply: 'restaurant_supplies' };

async function settingsOf(companyId, db) {
  var r = (await (db || pool).query("SELECT value FROM restaurant_more_settings WHERE company_id = $1 AND name = 'prices'", [companyId])).rows[0];
  var v = (r && r.value) || {};
  return { alertPercent: Number(v.alertPercent) >= 0 && Number(v.alertPercent) <= 100 ? Number(v.alertPercent) : DEFAULTS.alertPercent };
}

// A purchase order's lines dearer than before: the managers are told, once
// for the order. rises: [{ name, unit, before, after }].
async function tellRises(db, companyId, ref, supplier, rises) {
  var s = await settingsOf(companyId, db);
  var up = (rises || []).filter(function (x) { return x.before > 0 && x.after > x.before && pct(x.after, x.before) >= s.alertPercent; });
  if (!up.length) return 0;
  up.sort(function (a, b) { return pct(b.after, b.before) - pct(a.after, a.before); });
  var co = (await db.query('SELECT code, name FROM companies WHERE id = $1', [companyId])).rows[0];
  var title = up.length === 1 ? '📈 ' + up[0].name + ' costs ' + pct(up[0].after, up[0].before) + '% more' : '📈 ' + up.length + ' things cost more on ' + ref;
  var body = up.slice(0, 5).map(function (x) { return x.name + ': ' + round2(x.before).toFixed(2) + ' → ' + round2(x.after).toFixed(2) + ' (+' + pct(x.after, x.before) + '%)'; }).join(' · ') +
    (supplier ? ' — ' + supplier : '') + ' (' + co.name + ')';
  var ids = await require('./restaurantPurchasing.service').managersOf(db, companyId);
  for (var i = 0; i < ids.length; i++) await notify(db, ids[i], title, body, '/restaurant?restaurant=' + encodeURIComponent(co.code) + '&view=stock');
  return up.length;
}

// Everything the restaurant buys with its price history.
async function view(companyId) {
  var s = await settingsOf(companyId);
  var items = (await pool.query(
    "SELECT 'ingredient' AS type, i.id, i.name, i.unit, i.unit_cost, i.stock_qty, s.name AS supplier FROM restaurant_ingredients i LEFT JOIN restaurant_suppliers s ON s.id = i.supplier_id WHERE i.company_id = $1 AND i.active " +
    "UNION ALL SELECT 'supply', u.id, u.name, u.unit, u.unit_cost, u.stock_qty, s.name FROM restaurant_supplies u LEFT JOIN restaurant_suppliers s ON s.id = u.supplier_id WHERE u.company_id = $1 AND u.active ORDER BY 3", [companyId])).rows;
  var moves = (await pool.query(
    "SELECT item_type, item_id, unit_cost, delta, note, created_at FROM restaurant_stock_moves WHERE company_id = $1 AND kind = 'received' AND unit_cost > 0 AND created_at > now() - interval '400 days' ORDER BY created_at", [companyId])).rows;
  var bySupplier = (await pool.query(
    "SELECT l.item_type, l.item_id, coalesce(nullif(o.supplier_name, ''), 'No supplier') AS supplier, count(*)::int AS n, sum(l.received_qty * l.unit_cost) / nullif(sum(l.received_qty), 0) AS avg_cost, max(o.received_at) AS last_at, " +
    "(array_agg(l.unit_cost ORDER BY o.received_at DESC))[1] AS last_cost FROM restaurant_purchase_order_lines l JOIN restaurant_purchase_orders o ON o.id = l.po_id " +
    "WHERE o.company_id = $1 AND o.status = 'received' AND l.received_qty > 0 AND l.unit_cost > 0 AND o.received_at > now() - interval '365 days' AND l.item_type IN ('ingredient', 'supply') " +
    'GROUP BY 1, 2, 3', [companyId])).rows;
  var dishes = (await pool.query(
    'SELECT r.ingredient_id, m.name FROM restaurant_recipes r JOIN restaurant_menu_items m ON m.id = r.menu_item_id WHERE r.company_id = $1 AND m.active ORDER BY m.name', [companyId])).rows;
  var since90 = Date.now() - 90 * 86400000, since30 = Date.now() - 30 * 86400000;
  var spent30 = 0;
  var out = items.map(function (it) {
    var pts = moves.filter(function (m) { return m.item_type === it.type && m.item_id === it.id; }).map(function (m) {
      return { at: m.created_at, day: dayText(m.created_at), cost: round4(m.unit_cost), qty: Number(m.delta), note: m.note || '' };
    });
    pts.forEach(function (p) { if (new Date(p.at).getTime() >= since30) spent30 += p.qty * p.cost; });
    var last = pts[pts.length - 1] || null;
    var prev = null;
    for (var k = pts.length - 2; k >= 0; k--) { if (pts[k].cost !== (last && last.cost)) { prev = pts[k]; break; } }
    var in90 = pts.filter(function (p) { return new Date(p.at).getTime() >= since90; });
    var costs90 = in90.map(function (p) { return p.cost; });
    var sups = bySupplier.filter(function (b) { return b.item_type === it.type && b.item_id === it.id; }).map(function (b) {
      return { name: b.supplier, n: b.n, avg: round4(b.avg_cost), last: round4(b.last_cost), lastAt: b.last_at };
    }).sort(function (a, b) { return a.avg - b.avg; });
    if (sups.length > 1) sups[0].cheapest = true;
    var change = last && prev ? pct(last.cost, prev.cost) : null;
    return {
      type: it.type, id: it.id, name: it.name, unit: it.unit, cost: round4(it.unit_cost), supplier: it.supplier || '',
      last: last ? { day: last.day, cost: last.cost, note: last.note } : null, prev: prev ? { day: prev.day, cost: prev.cost } : null, change: change,
      rose: change != null && change >= s.alertPercent, fell: change != null && change < 0,
      min90: costs90.length ? Math.min.apply(null, costs90) : null, max90: costs90.length ? Math.max.apply(null, costs90) : null,
      avg90: costs90.length ? round4(costs90.reduce(function (a, c) { return a + c; }, 0) / costs90.length) : null,
      points: pts.slice(-12).map(function (p) { return { day: p.day, cost: p.cost }; }), suppliers: sups,
      dishes: it.type === 'ingredient' ? dishes.filter(function (d) { return d.ingredient_id === it.id; }).map(function (d) { return d.name; }) : []
    };
  });
  var withChange = out.filter(function (x) { return x.change != null; });
  var rises = out.filter(function (x) { return x.rose; }).sort(function (a, b) { return b.change - a.change; });
  var savings = out.filter(function (x) { return x.last && x.suppliers.length > 1 && x.suppliers[0].avg < x.last.cost; });
  return {
    items: out, settings: s,
    summary: {
      tracked: out.filter(function (x) { return x.points.length; }).length, rises: rises.length, falls: out.filter(function (x) { return x.fell; }).length,
      biggest: rises[0] ? { name: rises[0].name, change: rises[0].change } : null,
      average: withChange.length ? Math.round(withChange.reduce(function (a, x) { return a + x.change; }, 0) / withChange.length * 10) / 10 : null,
      spent30: round2(spent30), cheaperElsewhere: savings.length
    }
  };
}

// POST /api/pos/settings/prices { managerPin, action: 'list' | 'settings', alertPercent }
async function tab(token, p, ip) {
  p = p || {};
  var m = await require('./restaurantTillAccess.service').settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  if (p.action === 'settings') {
    var v = Number(p.alertPercent);
    if (!(v >= 0 && v <= 100)) fail('invalid', 'Tell the managers when a price goes up by how much? 0 to 100%.');
    await pool.query("INSERT INTO restaurant_more_settings (company_id, name, value) VALUES ($1, 'prices', $2) ON CONFLICT (company_id, name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [company, { alertPercent: Math.round(v * 10) / 10 }]);
  }
  return view(company);
}

// For the owner's view: what went up lately, by restaurant.
async function risesOf(companyId) {
  var v = await view(companyId);
  return v.items.filter(function (x) { return x.rose && x.last && Date.parse(x.last.day) > Date.now() - 14 * 86400000; }).length;
}

module.exports = { tab: tab, view: view, tellRises: tellRises, settingsOf: settingsOf, risesOf: risesOf, TABLE: TABLE };
