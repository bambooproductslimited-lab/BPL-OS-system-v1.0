var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// The kitchen's prep list (migration 0194): what to have ready for a day.
// Each dish: the usual for that weekday (what sold on it, on average, over
// the last `weeks` weeks, with `buffer` per cent more to be safe), and what
// is ordered ahead for it on the website — orders for later, and catering.
// From the recipes, the ingredients that takes, against what is in stock:
// what is short. Cooks tick each dish off as it is made (on the till or the
// kitchen screen); a manager sets the weeks and the buffer.

var MAX_DAYS_AHEAD = 7;
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function dayOf(d) { return d.toISOString().slice(0, 10); }
function addDays(day, n) { return dayOf(new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000)); }
function nameOf(e) { return e ? (e.first_name + ' ' + (e.last_name || '')).trim() : ''; }

async function settingsOf(companyId) {
  var r = (await pool.query('SELECT weeks, buffer FROM restaurant_prep_settings WHERE company_id = $1', [companyId])).rows[0];
  return { weeks: r ? r.weeks : 4, buffer: r ? r.buffer : 10 };
}
// 'today', 'tomorrow' or YYYY-MM-DD (yesterday to a week ahead): the day (Ghana: UTC).
function dayFrom(v) {
  var today = dayOf(new Date());
  if (!v || v === 'today') return today;
  if (v === 'tomorrow') return addDays(today, 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || isNaN(Date.parse(v + 'T00:00:00Z'))) fail('invalid', 'Pick the day of the prep list.');
  if (v < addDays(today, -1) || v > addDays(today, MAX_DAYS_AHEAD)) fail('invalid', 'The prep list goes from yesterday to a week ahead.');
  return v;
}

// The plan for a day: { day, weeks, buffer, dishes, ingredients, ahead, bookings }.
async function plan(companyId, day) {
  var s = await settingsOf(companyId);
  var past = [];
  for (var w = 1; w <= s.weeks; w++) past.push(addDays(day, -7 * w));
  var usual = new Map();
  (await pool.query(
    'SELECT oi.menu_item_id AS id, sum(oi.qty)::numeric AS qty FROM restaurant_order_items oi JOIN restaurant_orders o ON o.id = oi.order_id ' +
    "WHERE o.company_id = $1 AND o.status = 'completed' AND oi.menu_item_id IS NOT NULL AND (o.created_at AT TIME ZONE 'UTC')::date = ANY($2::date[]) GROUP BY 1",
    [companyId, past])).rows.forEach(function (r) { usual.set(r.id, Number(r.qty) / s.weeks); });
  // Ordered ahead on the website for the day (not turned down, cancelled or unpaid).
  var orders = (await pool.query(
    "SELECT id, number, customer_name, scheduled_for, status, items, catering, guests, fulfillment FROM restaurant_online_orders WHERE company_id = $1 AND scheduled_for >= $2::date AND scheduled_for < $2::date + 1 " +
    "AND status IN ('pending', 'accepted', 'done') ORDER BY scheduled_for", [companyId, day])).rows;
  var ahead = new Map(), catering = new Map();
  orders.forEach(function (o) {
    (o.items || []).forEach(function (l) {
      var m = o.catering ? catering : ahead;
      m.set(l.menuItemId, (m.get(l.menuItemId) || 0) + Number(l.qty || 0));
    });
  });
  // Private events booked that day (migration 0195): so many portions a guest.
  var ev = await require('./restaurantEvents.service').forPrep(companyId, day);
  var ids = Array.from(new Set(Array.from(usual.keys()).concat(Array.from(ahead.keys()), Array.from(catering.keys()), Array.from(ev.dishes.keys()))));
  var menu = ids.length ? (await pool.query('SELECT id, name, category, serves FROM restaurant_menu_items WHERE company_id = $1 AND id = ANY($2::uuid[]) AND active', [companyId, ids])).rows : [];
  var ticks = new Map((await pool.query(
    "SELECT t.item_key, t.qty, t.done_at, e.first_name, e.last_name FROM restaurant_prep_ticks t LEFT JOIN employees e ON e.id = t.done_by WHERE t.company_id = $1 AND t.day = $2", [companyId, day])).rows
    .map(function (r) { return [r.item_key, { qty: r.qty == null ? null : Number(r.qty), at: r.done_at, by: nameOf(r) }]; }));
  var dishes = menu.map(function (m) {
    var u = usual.get(m.id) || 0, a = ahead.get(m.id) || 0, c = catering.get(m.id) || 0, e = ev.dishes.get(m.id) || 0;
    var fromUsual = u > 0 ? Math.ceil(u * (1 + s.buffer / 100) - 1e-9) : 0;
    return { id: m.id, key: 'menu:' + m.id, name: m.name, category: m.category || '', serves: m.serves || 0, usual: round2(u), fromUsual: fromUsual, ahead: a, catering: c, event: e,
      total: fromUsual + a + c + e, done: ticks.get('menu:' + m.id) || null };
  }).filter(function (d) { return d.total > 0; })
    .sort(function (x, y) { return (y.catering + y.event - x.catering - x.event) || (y.ahead - x.ahead) || (y.total - x.total) || x.name.localeCompare(y.name); });
  // The ingredients those take (the dish's own recipe; a dish with sizes only: its first size's).
  var need = new Map();
  if (dishes.length) {
    var recipes = (await pool.query(
      'SELECT r.menu_item_id, r.variation_id, r.ingredient_id, r.qty FROM restaurant_recipes r LEFT JOIN restaurant_menu_item_variations v ON v.id = r.variation_id ' +
      'WHERE r.company_id = $1 AND r.menu_item_id = ANY($2::uuid[]) ORDER BY r.menu_item_id, r.variation_id NULLS FIRST, v.sort_order', [companyId, dishes.map(function (d) { return d.id; })])).rows;
    dishes.forEach(function (d) {
      var mine = recipes.filter(function (r) { return r.menu_item_id === d.id; });
      if (!mine.length) return;
      var pick = mine[0].variation_id;
      mine.filter(function (r) { return r.variation_id === pick; }).forEach(function (r) {
        need.set(r.ingredient_id, (need.get(r.ingredient_id) || 0) + d.total * Number(r.qty));
      });
      d.hasRecipe = true;
    });
  }
  var ingredients = need.size ? (await pool.query('SELECT id, name, unit, stock_qty, unit_cost FROM restaurant_ingredients WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, Array.from(need.keys())])).rows.map(function (g) {
    var n = round2(need.get(g.id)), have = Number(g.stock_qty);
    return { id: g.id, name: g.name, unit: g.unit || 'each', need: n, stock: round2(have), short: round2(Math.max(0, n - have)), cost: round2(n * Number(g.unit_cost || 0)) };
  }).sort(function (x, y) { return (y.short > 0) - (x.short > 0) || x.name.localeCompare(y.name); }) : [];
  var booked = (await pool.query(
    "SELECT count(*)::int AS n, coalesce(sum(party), 0)::int AS guests FROM restaurant_bookings WHERE company_id = $1 AND kind = 'booking' AND status NOT IN ('cancelled', 'no_show', 'declined') AND at >= $2::date AND at < $2::date + 1",
    [companyId, day])).rows[0];
  return {
    day: day, weekday: new Date(day + 'T12:00:00Z').getUTCDay(), weeks: s.weeks, buffer: s.buffer,
    dishes: dishes, ingredients: ingredients, short: ingredients.filter(function (g) { return g.short > 0; }).length,
    done: dishes.filter(function (d) { return d.done; }).length,
    ahead: orders.map(function (o) {
      return { id: o.id, ref: 'W-' + String(o.number).padStart(4, '0'), name: o.customer_name, at: o.scheduled_for, status: o.status, fulfillment: o.fulfillment,
        catering: o.catering ? { guests: o.guests } : null, dishes: (o.items || []).reduce(function (a, l) { return a + Number(l.qty || 0); }, 0) };
    }),
    bookings: { count: booked.n, guests: booked.guests },
    events: ev.events
  };
}

// POST /api/pos/prep { action: view|tick|settings, day, key, done, qty,
// weeks, buffer, managerPin } — anyone on the till or the kitchen screen
// sees it and ticks; a manager sets the weeks and the buffer.
async function prep(token, p, ip) {
  p = p || {};
  var session = await access.need(token, ['till', 'kds', 'stock', 'delivery']);
  var company = session.posCompanyId;
  var day = dayFrom(p.day);
  if (p.action === 'tick') {
    var key = String(p.key || '');
    var m = /^menu:([0-9a-f-]{36})$/i.exec(key);
    if (!m) fail('invalid', 'Pick a dish on the prep list.');
    var dish = (await pool.query('SELECT name FROM restaurant_menu_items WHERE id = $1 AND company_id = $2', [m[1], company])).rows[0];
    if (!dish) fail('notfound', 'That dish is not on this restaurant\'s menu.');
    if (p.done === false) {
      await pool.query('DELETE FROM restaurant_prep_ticks WHERE company_id = $1 AND day = $2 AND item_key = $3', [company, day, key]);
    } else {
      var qty = p.qty === undefined || p.qty === null || p.qty === '' ? null : round2(p.qty);
      if (qty !== null && !(qty >= 0 && qty <= 100000)) fail('invalid', 'How many were made? A number, 0 or more.');
      await pool.query(
        'INSERT INTO restaurant_prep_ticks (company_id, day, item_key, qty, done_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (company_id, day, item_key) DO UPDATE SET qty = EXCLUDED.qty, done_by = EXCLUDED.done_by, done_at = now()',
        [company, day, key, qty, session.posEmployeeId]);
    }
  } else if (p.action === 'settings') {
    var mgr = await access.settingsManager(token, p.managerPin, ip);
    var weeks = Math.round(Number(p.weeks)), buffer = Math.round(Number(p.buffer));
    if (!(weeks >= 1 && weeks <= 12)) fail('invalid', 'Weeks to average: from 1 to 12.');
    if (!(buffer >= 0 && buffer <= 100)) fail('invalid', 'Extra to be safe: from 0 to 100%.');
    await pool.query('INSERT INTO restaurant_prep_settings (company_id, weeks, buffer) VALUES ($1,$2,$3) ON CONFLICT (company_id) DO UPDATE SET weeks = EXCLUDED.weeks, buffer = EXCLUDED.buffer, updated_at = now()',
      [company, weeks, buffer]);
    await activity.log(pool, { companyId: company, employeeId: mgr.manager.id, app: 'till', action: 'till.prep_settings', summary: 'Prep list: the usual of the last ' + weeks + ' weeks, ' + buffer + '% extra.' });
  }
  var out = await plan(company, day);
  out.canSet = session.access.role === 'manager';
  return out;
}

module.exports = { prep: prep, plan: plan, dayFrom: dayFrom };
