var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// Item options and bulk edit for Products & Services (migration 0184) —
// Square's "options" and "bulk edit". An item's options (Size: Small,
// Medium, Large; Finish: Natural, Dark) make its variations: one for each
// combination, named by its values ("Large / Dark") and coded from the
// item's own code. Changing the options adds the combinations that are new
// and puts away (never deletes: invoices name their codes) those no longer
// offered; a variation kept keeps its price, cost, stock, photos and links.
//
// Bulk edit: many variations' prices, costs, stock and on/off at once, from
// one table; a change of stock is kept like any stock change, as before and
// after with a reason.

var MAX_OPTIONS = 3, MAX_CHOICES = 20, MAX_COMBOS = 100;

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function nameOf(values, options) { return options.map(function (o) { return values[o.name]; }).join(' / '); }
function sameValues(a, b) {
  var ka = Object.keys(a || {}), kb = Object.keys(b || {});
  return ka.length === kb.length && ka.every(function (k) { return String(a[k]).toLowerCase() === String((b || {})[k] || '').toLowerCase(); });
}
// Every combination of the options' choices, in order.
function combos(options) {
  var out = [{}];
  options.forEach(function (o) {
    var next = [];
    out.forEach(function (c) { o.choices.forEach(function (ch) { var x = Object.assign({}, c); x[o.name] = ch; next.push(x); }); });
    out = next;
  });
  return out;
}
function codePart(s) { return String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 4) || 'X'; }

function clean(raw) {
  var seen = {};
  var options = (Array.isArray(raw) ? raw : []).map(function (o) {
    var name = text(o && o.name, 30);
    var choices = [];
    (Array.isArray(o && o.choices) ? o.choices : []).forEach(function (c) {
      var t = text(c, 30);
      if (t && choices.map(function (x) { return x.toLowerCase(); }).indexOf(t.toLowerCase()) < 0) choices.push(t);
    });
    return { name: name, choices: choices };
  }).filter(function (o) { return o.name || o.choices.length; });
  if (options.length > MAX_OPTIONS) fail('invalid', 'At most ' + MAX_OPTIONS + ' options on an item.');
  options.forEach(function (o) {
    if (!o.name) fail('invalid', 'Name each option (Size, Colour…).');
    if (seen[o.name.toLowerCase()]) fail('invalid', 'Two options are called ' + o.name + '.');
    seen[o.name.toLowerCase()] = true;
    if (!o.choices.length) fail('invalid', 'Give ' + o.name + ' at least one choice.');
    if (o.choices.length > MAX_CHOICES) fail('invalid', 'At most ' + MAX_CHOICES + ' choices for ' + o.name + '.');
  });
  return options;
}

// GET /api/catalog/items/:id/options
async function get(ctx, itemId) {
  if (!ctx.can('catalog.read')) fail('forbidden', 'Your role does not allow this action (catalog.read).');
  return (await pool.query('SELECT name, choices FROM catalog_item_options WHERE item_id = $1 ORDER BY sort_order', [itemId])).rows
    .map(function (r) { return { name: r.name, choices: r.choices }; });
}

// PUT /api/catalog/items/:id/options { options: [{ name, choices }], unitPrice, costPrice }
// — the price and cost of variations it adds (else the item's first one's).
async function set(ctx, itemId, p) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  p = p || {};
  var options = clean(p.options);
  var all = options.length ? combos(options) : [];
  if (all.length > MAX_COMBOS) fail('invalid', 'That makes ' + all.length + ' variations; ' + MAX_COMBOS + ' at most.');
  return withTransaction(async function (db) {
    var item = (await db.query('SELECT * FROM catalog_items WHERE id = $1 FOR UPDATE', [itemId])).rows[0];
    if (!item) fail('notfound', 'Item not found.');
    var vars = (await db.query('SELECT * FROM catalog_item_variations WHERE item_id = $1 ORDER BY active DESC, position, name', [itemId])).rows;
    var first = vars[0] || {};
    // The item's own code: the first variation's, less the parts its options added.
    var made = Object.keys(first.option_values || {}).length;
    var base = String(first.code || codePart(item.name)).toUpperCase();
    if (made) base = base.replace(/-\d+$/, '').split('-').slice(0, -made).join('-') || base;
    var price = p.unitPrice != null ? Math.max(0, Number(p.unitPrice) || 0) : Number(first.unit_price || 0);
    var cost = p.costPrice != null ? Math.max(0, Number(p.costPrice) || 0) : Number(first.cost_price || 0);

    await db.query('DELETE FROM catalog_item_options WHERE item_id = $1', [itemId]);
    for (var i = 0; i < options.length; i++) {
      await db.query('INSERT INTO catalog_item_options (item_id, name, choices, sort_order) VALUES ($1,$2,$3,$4)', [itemId, options[i].name, JSON.stringify(options[i].choices), i]);
    }
    var added = 0, kept = 0, away = 0, used = [];
    for (var c = 0; c < all.length; c++) {
      var values = all[c], name = nameOf(values, options);
      // The same combination, or a variation already called by its name.
      var match = vars.find(function (v) { return used.indexOf(v.id) < 0 && sameValues(v.option_values, values); }) ||
        vars.find(function (v) { return used.indexOf(v.id) < 0 && String(v.name).toLowerCase() === name.toLowerCase(); });
      if (match) {
        used.push(match.id);
        await db.query('UPDATE catalog_item_variations SET name = $2, option_values = $3, active = true, position = $4 WHERE id = $1', [match.id, name, JSON.stringify(values), c + 1]);
        kept++;
        continue;
      }
      var wanted = base + '-' + options.map(function (o) { return codePart(values[o.name]); }).join('-'), code = wanted;
      for (var n = 2; (await db.query('SELECT 1 FROM catalog_item_variations WHERE code = $1', [code])).rows[0]; n++) code = wanted + '-' + n;
      await db.query(
        'INSERT INTO catalog_item_variations (item_id, name, code, unit, default_qty, unit_price, cost_price, stock_qty, active, option_values, position) VALUES ($1,$2,$3,$4,1,$5,$6,0,true,$7,$8)',
        [itemId, name, code, first.unit || 'each', price, cost, JSON.stringify(values), c + 1]);
      added++;
    }
    // No longer offered: put away. Without options, the item's variations
    // stay as they are.
    if (all.length) {
      for (var k = 0; k < vars.length; k++) {
        if (used.indexOf(vars[k].id) < 0 && vars[k].active) {
          await db.query("UPDATE catalog_item_variations SET active = false, option_values = '{}' WHERE id = $1", [vars[k].id]);
          away++;
        }
      }
    }
    await audit(db, ctx, 'catalog.options', 'catalog_item', itemId,
      'Options of ' + item.name + ': ' + (options.map(function (o) { return o.name + ' (' + o.choices.join(', ') + ')'; }).join('; ') || 'none') + '. ' + added + ' added, ' + kept + ' kept, ' + away + ' put away.');
    return { options: options, added: added, kept: kept, putAway: away };
  });
}

// POST /api/catalog/bulk { changes: [{ id, unitPrice, costPrice, stockQty, active }], note }
async function bulk(ctx, p) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  p = p || {};
  var changes = Array.isArray(p.changes) ? p.changes : [];
  if (!changes.length) fail('invalid', 'Nothing was changed.');
  if (changes.length > 500) fail('invalid', 'At most 500 at a time.');
  var note = text(p.note, 200) || 'Bulk edit';
  return withTransaction(async function (db) {
    var done = 0, stockMoves = 0;
    for (var i = 0; i < changes.length; i++) {
      var ch = changes[i] || {};
      var v = (await db.query('SELECT * FROM catalog_item_variations WHERE id = $1 FOR UPDATE', [ch.id])).rows[0];
      if (!v) fail('notfound', 'A variation in the list no longer exists.');
      function num(x, what) {
        if (x === undefined || x === null || x === '') return null;
        var n = Number(x);
        if (!Number.isFinite(n) || n < 0) fail('invalid', what + ' of ' + v.name + ' must be zero or more.');
        return Math.round(n * 100) / 100;
      }
      var price = num(ch.unitPrice, 'The price'), cost = num(ch.costPrice, 'The cost'), stock = num(ch.stockQty, 'The stock');
      var active = typeof ch.active === 'boolean' ? ch.active : null;
      var row = (await db.query(
        'UPDATE catalog_item_variations SET unit_price = coalesce($2, unit_price), cost_price = coalesce($3, cost_price), stock_qty = coalesce($4, stock_qty), active = coalesce($5, active) WHERE id = $1 RETURNING *',
        [v.id, price, cost, stock, active])).rows[0];
      var said = [];
      if (price != null && price !== Number(v.unit_price)) said.push('price ' + Number(v.unit_price) + ' → ' + price);
      if (cost != null && cost !== Number(v.cost_price)) said.push('cost ' + Number(v.cost_price) + ' → ' + cost);
      if (stock != null && stock !== Number(v.stock_qty)) { said.push('stock ' + Number(v.stock_qty) + ' → ' + stock); stockMoves++; }
      if (active != null && active !== v.active) said.push(active ? 'on sale' : 'put away');
      if (said.length) {
        await audit(db, ctx, stock != null && stock !== Number(v.stock_qty) ? 'catalog.variation.stock' : 'catalog.variation.update', 'catalog_item_variation', row.id, row.name + ' (' + row.code + '): ' + said.join(', ') + '. ' + note + '.');
        done++;
      }
    }
    return { changed: done, stockChanges: stockMoves };
  });
}

module.exports = { get: get, set: set, bulk: bulk, combos: combos };
