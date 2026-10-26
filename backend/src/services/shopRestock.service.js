var config = require('../config');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { internationalNumber } = require('../utils/phone');

// "Tell me when it's back" on the online shop (migration 0194). An item is
// sold out when staff say so (the Sold out switch), or when every one of its
// choices is a stock item and none is left — an item made to order never
// runs out of itself. A sold-out item cannot be bought; instead it takes a
// phone number or an email address. Once it is back (staff switch it on
// again, or stock comes in) each person waiting is told, once, by text or
// email, with a link to it (the hourly job, and at once when staff switch).

var PER_IP_HOUR = 10;
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function mail() { return require('./mail.service'); }
function sms() { return require('./sms.service'); }
function itemUrl(id) { return config.bplSiteUrl + '/?item=' + id; }

// Marks each shop item ({ id, make_days_max, shop_sold_out, variations:
// [{ id, productId }] }) and its choices soldOut, from the stock items they
// are linked to.
async function markSoldOut(items) {
  var ids = [];
  items.forEach(function (it) { it.variations.forEach(function (v) { if (v.productId) ids.push(v.productId); }); });
  var stock = new Map(ids.length ? (await pool.query('SELECT id, current_stock FROM products WHERE id = ANY($1::uuid[])', [Array.from(new Set(ids))])).rows.map(function (r) { return [r.id, Number(r.current_stock)]; }) : []);
  items.forEach(function (it) {
    var made = it.make_days_max != null && Number(it.make_days_max) > 0;
    it.variations.forEach(function (v) { v.soldOut = !!it.shop_sold_out || (!made && !!v.productId && stock.has(v.productId) && stock.get(v.productId) <= 0); });
    it.soldOut = !!it.shop_sold_out || (it.variations.length > 0 && it.variations.every(function (v) { return v.soldOut; }));
  });
  return items;
}
async function shopItem(id) {
  var shop = require('./shop.service');
  var s = await shop.settingsOf();
  if (!s.on) fail('notfound', 'The online shop is closed for now.');
  var items = await markSoldOut(await shop.visibleItems(s));
  return items.find(function (i) { return i.id === id; }) || null;
}

var asked = new Map();
function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (asked.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Too many requests from here in the last hour. Try again later.');
  list.push(now);
  asked.set(key, list);
  if (asked.size > 5000) asked.clear();
}
// POST /api/shop/items/:id/alert { name, phone, email } — told when it is back.
async function ask(id, p, ip) {
  p = p || {};
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('notfound', 'That item is not on the shop.');
  var it = await shopItem(id);
  if (!it) fail('notfound', 'That item is not on the shop.');
  if (!it.soldOut) fail('conflict', it.name + ' is in stock: you can buy it now.');
  var phone = text(p.phone, 30), email = text(p.email, 120).toLowerCase();
  if (!phone && !email) fail('invalid', 'Give a phone number or an email address to tell you on.');
  if (phone && !internationalNumber(phone)) fail('invalid', 'Type a phone number we can text, e.g. 024 412 3456.');
  if (email && !mail().isEmail(email)) fail('invalid', 'That email address does not look right.');
  throttle(ip);
  var norm = phone ? '+' + internationalNumber(phone) : '';
  // Asked already (the same number or address): once is enough.
  var have = (await pool.query("SELECT id FROM shop_stock_alerts WHERE item_id = $1 AND notified_at IS NULL AND ((phone <> '' AND phone = $2) OR (email <> '' AND email = $3))", [it.id, norm, email])).rows[0];
  if (!have) {
    await pool.query('INSERT INTO shop_stock_alerts (item_id, name, phone, email, ip) VALUES ($1,$2,$3,$4,$5)', [it.id, text(p.name, 80), norm, email, String(ip || '').slice(0, 60)]);
  }
  return { ok: true, item: it.name, by: phone && email ? 'both' : phone ? 'phone' : 'email' };
}

// Tells everyone waiting for an item that is back (or for every such item):
// { told, items }. Each once; one not reachable (no email or texts set up)
// waits for the next round.
async function notifyBack(itemId) {
  var shop = require('./shop.service');
  var s = await shop.settingsOf();
  if (!s.on) return { told: 0, items: 0 };
  var waiting = (await pool.query('SELECT DISTINCT item_id FROM shop_stock_alerts WHERE notified_at IS NULL' + (itemId ? ' AND item_id = $1' : ''), itemId ? [itemId] : [])).rows.map(function (r) { return r.item_id; });
  if (!waiting.length) return { told: 0, items: 0 };
  var items = await markSoldOut((await shop.visibleItems(s)).filter(function (i) { return waiting.indexOf(i.id) >= 0; }));
  var back = items.filter(function (i) { return !i.soldOut; });
  var told = 0;
  for (var it of back) {
    var rows = (await pool.query('SELECT * FROM shop_stock_alerts WHERE item_id = $1 AND notified_at IS NULL ORDER BY created_at LIMIT 200', [it.id])).rows;
    var url = itemUrl(it.id);
    for (var a of rows) {
      var words = 'Good news' + (a.name ? ', ' + a.name.split(' ')[0] : '') + ': ' + it.name + ' is back at Bamboo Products. Order it here before it runs out: ' + url;
      var by = [];
      if (a.email && mail().configured()) {
        try {
          await mail().send({ to: a.email, subject: it.name + ' is back in stock', fromName: 'Bamboo Products', text: words,
            html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937"><p>' + mail().escapeHtml(words.replace(' Order it here before it runs out: ' + url, '')) + '</p>' +
              '<p style="margin:18px 0"><a href="' + mail().escapeHtml(url) + '" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#2f6b2c;color:#fff;text-decoration:none;font-weight:700">See it on the shop</a></p></div>' });
          by.push('email');
        } catch (e) { /* the next round */ }
      }
      if (a.phone && sms().configured()) {
        try { await sms().send({ to: a.phone, message: words, purpose: 'shop_restock', refId: a.id }); by.push('sms'); } catch (e) { /* the next round */ }
      }
      if (by.length) {
        await pool.query('UPDATE shop_stock_alerts SET notified_at = now(), notified_by = $2 WHERE id = $1', [a.id, by.join('+')]);
        told++;
      }
    }
  }
  return { told: told, items: back.length };
}

// GET /api/shop/restock — staff: the shop's items, sold out or not, with
// who is waiting for each, and those told in the last 30 days.
async function list(ctx) {
  if (!ctx.can('catalog.read')) fail('forbidden', 'Your role does not allow this action (catalog.read).');
  var shop = require('./shop.service');
  var s = await shop.settingsOf();
  var items = await markSoldOut(await shop.visibleItems(s));
  var waits = (await pool.query(
    "SELECT item_id, count(*) FILTER (WHERE notified_at IS NULL)::int AS waiting, count(*) FILTER (WHERE notified_at > now() - interval '30 days')::int AS told, max(created_at) AS last_at " +
    'FROM shop_stock_alerts GROUP BY item_id')).rows;
  var people = (await pool.query("SELECT item_id, name, phone, email, created_at FROM shop_stock_alerts WHERE notified_at IS NULL ORDER BY created_at DESC LIMIT 500")).rows;
  var canSend = { email: mail().configured(), sms: sms().configured() };
  var out = items.map(function (it) {
    var w = waits.find(function (x) { return x.item_id === it.id; }) || {};
    return {
      id: it.id, name: it.name, category: it.category_name || 'More', soldOut: it.soldOut, byHand: !!it.shop_sold_out,
      ranOut: !it.shop_sold_out && it.soldOut, madeToOrder: it.make_days_max != null && Number(it.make_days_max) > 0,
      waiting: w.waiting || 0, told: w.told || 0, lastAskedAt: w.last_at || null,
      people: people.filter(function (x) { return x.item_id === it.id; }).slice(0, 20).map(function (x) { return { name: x.name, phone: x.phone, email: x.email, at: x.created_at }; })
    };
  }).sort(function (x, y) { return (y.waiting - x.waiting) || (y.soldOut - x.soldOut) || x.name.localeCompare(y.name); });
  return { items: out, waiting: out.reduce(function (a, i) { return a + i.waiting; }, 0), soldOut: out.filter(function (i) { return i.soldOut; }).length, canSend: canSend };
}

// PUT /api/shop/restock/:id { soldOut } — staff switch an item sold out, or
// back; back, those waiting are told at once.
async function setSoldOut(ctx, id, soldOut) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var r = (await pool.query('UPDATE catalog_items SET shop_sold_out = $2 WHERE id = $1 RETURNING name', [id, !!soldOut])).rows[0];
  if (!r) fail('notfound', 'That item is gone.');
  await audit(pool, ctx, 'shop.sold_out', 'catalog_item', id, r.name + (soldOut ? ' marked sold out on the online shop.' : ' back on sale on the online shop.'));
  var told = soldOut ? { told: 0 } : await notifyBack(id);
  return Object.assign(await list(ctx), { told: told.told });
}

module.exports = { markSoldOut: markSoldOut, ask: ask, notifyBack: notifyBack, list: list, setSoldOut: setSoldOut, _asked: asked };
