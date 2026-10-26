var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');
var displays = require('./restaurantDisplays.service');

// Menu boards (migration 0195): a TV in the restaurant, opened at
// /menu-board on the till's website. It says hello with a key it keeps and
// shows a 6-digit code; a manager types the code in the back office (Menu
// boards) with what it shows — the categories, a title, a grid or a list,
// photos, how long a page stays — and it shows the menu as the till sells
// it now: happy-hour prices while they are on, dishes sold out greyed, a
// menu's dishes outside its hours dimmed, and beside it, if asked, the
// ready-for-pickup orders (restaurantBoard).

var LAYOUTS = ['grid', 'list'];
var THEMES = ['night', 'bamboo', 'light'];
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function online() { return require('./restaurantOnline.service'); }

function cleanOptions(o) {
  o = o || {};
  return {
    categories: (Array.isArray(o.categories) ? o.categories : []).map(function (c) { return text(c, 60); }).filter(Boolean).slice(0, 30),
    title: text(o.title, 60), layout: LAYOUTS.indexOf(o.layout) >= 0 ? o.layout : 'grid', theme: THEMES.indexOf(o.theme) >= 0 ? o.theme : 'night',
    rotate: Math.max(6, Math.min(120, Math.round(Number(o.rotate)) || 12)), photos: o.photos !== false, ready: !!o.ready, prices: o.prices !== false
  };
}

async function boardOf(key) {
  var d = await displays.byKey(key);
  if (!d || d.kind !== 'menu') fail('auth', 'This menu board was taken off the till. It shows a new code.');
  return d;
}

// POST /api/pos/menu-board/hello { key }
function hello(key, ip, ua) { return displays.hello(key, ip, ua, 'menu'); }

// The menu as the board shows it: sections of the categories chosen (all
// if none), each dish with its price now.
async function menuOf(companyId, o) {
  var m = await online().menuItems(companyId, false);
  var want = o.categories.map(function (c) { return c.toLowerCase(); });
  var cats = m.categories.filter(function (c) { return !want.length || want.indexOf(String(c).toLowerCase()) >= 0; });
  if (want.length) cats.sort(function (a, b) { return want.indexOf(a.toLowerCase()) - want.indexOf(b.toLowerCase()); });
  var happy = {};
  var sections = cats.map(function (c) {
    return {
      category: c || 'Other',
      items: m.items.filter(function (i) { return i.category === c; }).map(function (i) {
        var off = i.happy ? i.happy.percent : 0;
        if (i.happy) happy[i.happy.id] = { name: i.happy.name, percent: i.happy.percent, to: i.happy.to };
        return {
          id: i.id, name: i.name, price: i.price, happyPrice: off ? round2(i.price * (1 - off / 100)) : null,
          variations: (i.variations || []).map(function (v) { return { name: v.name, price: v.price, happyPrice: off ? round2(v.price * (1 - off / 100)) : null }; }),
          photo: o.photos ? i.photoFull || i.photoUrl || null : null, soldOut: !!i.soldOut, notNow: !!i.notNow, hours: i.hours || null, allergens: i.allergens || []
        };
      })
    };
  }).filter(function (s) { return s.items.length; });
  return { sections: sections, happy: Object.keys(happy).map(function (k) { return happy[k]; }) };
}

// GET /api/pos/menu-board — its code while it waits; then the menu.
async function view(key) {
  var d = await boardOf(key);
  if (!d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > 15000) await pool.query('UPDATE restaurant_displays SET last_seen_at = now() WHERE id = $1', [d.id]);
  if (!d.company_id) return displays.viewOf(d);
  var o = cleanOptions(d.options);
  var out = Object.assign({ paired: true, name: d.name, restaurant: { code: d.company_code, name: d.company_name }, options: o, now: new Date().toISOString() }, await menuOf(d.company_id, o));
  if (o.ready) out.ready = await require('./restaurantBoard.service').ordersOf(d.company_id);
  return out;
}

function boardOut(d) {
  return { id: d.id, name: d.name || 'Menu board', options: cleanOptions(d.options), pairedAt: d.paired_at,
    online: !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < 45000, lastSeenAt: d.last_seen_at };
}

// POST /api/pos/settings/menu-boards { action: list|pair|save|remove, code,
// id, name, options, managerPin } — the back office's Menu boards.
async function manage(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  if (p.action === 'pair') {
    var code = String(p.code || '').replace(/\D/g, '');
    if (code.length !== 6) fail('invalid', 'Type the 6 numbers the menu board shows.');
    var d = (await pool.query("SELECT * FROM restaurant_displays WHERE pair_code = $1 AND company_id IS NULL AND code_expires > now() AND kind = 'menu'", [code])).rows[0];
    if (!d) fail('notfound', 'No menu board shows that code. Check the numbers, or reload the board for a new code.');
    var name = text(p.name, 40) || 'Menu board';
    await pool.query('UPDATE restaurant_displays SET company_id = $2, name = $3, options = $4, paired_by = $5, paired_at = now(), pair_code = NULL, code_expires = NULL WHERE id = $1',
      [d.id, company, name, cleanOptions(p.options), m.manager.id]);
    await activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'settings', action: 'menuboard.paired', summary: 'A menu board (' + name + ') now shows this restaurant\'s menu.', refType: 'display', refId: d.id });
  } else if (p.action === 'save') {
    var up = (await pool.query("UPDATE restaurant_displays SET name = $3, options = $4 WHERE id = $1 AND company_id = $2 AND kind = 'menu' RETURNING id", [p.id, company, text(p.name, 40) || 'Menu board', cleanOptions(p.options)])).rows[0];
    if (!up) fail('notfound', 'That menu board is not this restaurant\'s.');
  } else if (p.action === 'remove') {
    var gone = (await pool.query("DELETE FROM restaurant_displays WHERE id = $1 AND company_id = $2 AND kind = 'menu' RETURNING name", [p.id, company])).rows[0];
    if (!gone) fail('notfound', 'That menu board is not this restaurant\'s.');
    await activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'settings', action: 'menuboard.removed', summary: 'A menu board (' + gone.name + ') was taken off.', refType: 'display', refId: p.id });
  }
  var rows = (await pool.query("SELECT * FROM restaurant_displays WHERE company_id = $1 AND kind = 'menu' ORDER BY paired_at", [company])).rows;
  var cats = (await pool.query("SELECT DISTINCT coalesce(nullif(category, ''), 'Other') AS c FROM restaurant_menu_items WHERE company_id = $1 AND active ORDER BY 1", [company])).rows.map(function (r) { return r.c; });
  return { boards: rows.map(boardOut), categories: cats, themes: THEMES };
}

module.exports = { hello: hello, view: view, manage: manage, cleanOptions: cleanOptions, menuOf: menuOf };
