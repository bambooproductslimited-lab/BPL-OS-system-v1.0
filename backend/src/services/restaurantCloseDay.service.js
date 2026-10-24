var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var activity = require('./restaurantActivity.service');

// Closing the day (migration 0183): the day's summary as a manager reads
// it at closing time — what was sold and how it was paid, refunds and
// voids, discounts and deals, tips, the drawers counted (short or over),
// orders still open, IOUs not paid, what is running low, and how the day
// compares with the same day last week. A manager closes it on the till's
// back office (it is kept as it was then), or it closes by itself at the
// set time (till settings closeDay: { auto, at, emails, whatsapp }) — at a
// time before noon it closes the day before (a late night). Closed, the
// managers are told, it is emailed to the addresses set, and the till
// offers it on WhatsApp to the owner's number.

var DAY = /^\d{4}-\d{2}-\d{2}$/;
var TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function money(n) { return 'GHS ' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function waNumber(v) { return require('./crmProductSheets.service').waNumber(v); }
function mail() { return require('./mail.service'); }
function access() { return require('./restaurantTillAccess.service'); }
var METHOD_WORDS = { cash: 'Cash', mobile_money: 'Mobile Money', card: 'Card', vip: 'VIP account', iou: 'IOU', gift_card: 'Gift card', alipay: 'Alipay', wechat: 'WeChat Pay', paystack: 'Paystack', app: 'Delivery app' };
function methodWords(m) { return METHOD_WORDS[m] || String(m || '').replace(/_/g, ' '); }

// ── settings (restaurantTillAccess) ──

var DEFAULTS = { auto: false, at: '23:30', emails: [], whatsapp: '' };
function merge(s) {
  var c = (s && s.closeDay) || {};
  return {
    auto: typeof c.auto === 'boolean' ? c.auto : DEFAULTS.auto, at: TIME.test(c.at || '') ? c.at : DEFAULTS.at,
    emails: Array.isArray(c.emails) ? c.emails.filter(function (e) { return mail().isEmail(e); }).slice(0, 5) : [], whatsapp: typeof c.whatsapp === 'string' ? c.whatsapp : ''
  };
}
function clean(p) {
  p = p || {};
  if (p.at && !TIME.test(p.at)) fail('invalid', 'Closing the day: give the time as HH:MM, e.g. 23:30.');
  var emails = Array.isArray(p.emails) ? p.emails : mail().addressList(p.emails || '', 'Closing the day: email');
  emails = emails.map(function (e) { return String(e).trim(); }).filter(Boolean);
  emails.forEach(function (e) { if (!mail().isEmail(e)) fail('invalid', 'Closing the day: "' + e.slice(0, 80) + '" is not an email address.'); });
  if (emails.length > 5) fail('invalid', 'Closing the day: five email addresses at most.');
  var wa = String(p.whatsapp || '').trim().slice(0, 30);
  if (wa && !waNumber(wa)) fail('invalid', 'Closing the day: that WhatsApp number does not look right.');
  return { auto: !!p.auto, at: p.at || DEFAULTS.at, emails: emails, whatsapp: wa };
}

// ── the summary ──

async function summary(companyId, day) {
  if (!DAY.test(day || '')) fail('invalid', 'Pick the day to close.');
  var sales = require('./restaurantTillSales.service');
  var r = await sales.report(companyId, { from: day, to: day, limit: 1 });
  var week = await sales.report(companyId, { from: addDays(day, -7), to: addDays(day, -7), limit: 1 });
  var drawers = await require('./restaurantPos.service').drawerHistory(companyId, { from: day, to: day });
  var open = (await pool.query('SELECT count(*)::int AS n FROM restaurant_open_tabs WHERE company_id = $1', [companyId])).rows[0].n;
  var openTabs = open ? (await require('./restaurantPos.service').tabRows(companyId, '', [])) : [];
  var low = await require('./restaurantPurchasing.service').lowStock(companyId);
  var co = (await pool.query('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0];
  var t = r.totals;
  var lastNet = round2(week.totals.net);
  return {
    day: day, restaurant: co ? co.name : '',
    sales: {
      count: t.sales, gross: t.gross, refunds: t.refunds, refunded: t.refunded, net: t.net, average: t.average, dishes: t.dishes,
      voided: t.voided, voidedAmount: t.voidedAmount, discounts: t.discounts, discounted: t.discounted, tips: t.tips, serviceCharge: t.serviceCharge,
      taxAdded: t.taxAdded, guests: t.guests, perGuest: t.perGuest, iouOpen: t.iouOpen, iouOwed: t.iouOwed
    },
    lastWeek: { day: addDays(day, -7), net: lastNet, sales: week.totals.sales, change: lastNet > 0 ? Math.round((t.net - lastNet) / lastNet * 1000) / 10 : null },
    byMethod: r.byMethod.map(function (m) { return { method: m.method, name: methodWords(m.method), sales: m.sales, amount: m.amount, refunded: m.refunded, net: m.net }; }),
    byFulfillment: r.byFulfillment, byHour: r.byHour, byCashier: r.byCashier,
    topItems: r.topItems.slice(0, 5), discountsBy: r.discountsBy.slice(0, 5), comps: r.comps.slice(0, 5), taxes: r.taxes, foreign: r.foreign,
    drawers: drawers.drawers.map(function (d) {
      return { cashier: d.cashierName, status: d.session.status, openedAt: d.session.openedAt || d.session.opened_at || null, expected: d.expected, actual: d.actual, difference: d.difference };
    }),
    drawerTotals: drawers.totals,
    openOrders: { count: openTabs.length, amount: round2(openTabs.reduce(function (a, x) { return a + Number(x.total || 0); }, 0)) },
    lowStock: { count: low.length, items: low.slice(0, 6).map(function (x) { return { name: x.name, stock: x.stock, unit: x.unit, out: x.out }; }) }
  };
}

// The day in words, for WhatsApp and the email.
function words(s, by) {
  var L = [];
  L.push('📊 ' + s.restaurant + ' — day closed ' + s.day);
  L.push('');
  L.push('Net sales: ' + money(s.sales.net) + ' from ' + s.sales.count + ' sale' + (s.sales.count === 1 ? '' : 's') + (s.sales.count ? ' (average ' + money(s.sales.average) + ')' : ''));
  if (s.lastWeek.change !== null) L.push('Same day last week: ' + money(s.lastWeek.net) + ' (' + (s.lastWeek.change >= 0 ? '+' : '') + s.lastWeek.change + '%)');
  if (s.sales.refunds) L.push('Refunds: ' + s.sales.refunds + ', ' + money(s.sales.refunded));
  if (s.sales.voided) L.push('Voided: ' + s.sales.voided + ', ' + money(s.sales.voidedAmount));
  if (s.sales.discounts) L.push('Discounts and deals: ' + money(s.sales.discounts));
  if (s.sales.tips) L.push('Tips: ' + money(s.sales.tips));
  if (s.sales.guests) L.push('Guests seated: ' + s.sales.guests + ' (' + money(s.sales.perGuest) + ' each)');
  if (s.byMethod.length) {
    L.push('');
    L.push('Paid by:');
    s.byMethod.forEach(function (m) { L.push('• ' + m.name + ': ' + money(m.net)); });
  }
  if (s.topItems.length) {
    L.push('');
    L.push('Sold most:');
    s.topItems.forEach(function (i) { L.push('• ' + i.qty + ' × ' + i.name); });
  }
  if (s.drawers.length) {
    L.push('');
    L.push('Drawers:');
    s.drawers.forEach(function (d) {
      L.push('• ' + d.cashier + ': ' + (d.status === 'open' ? 'still open' : d.difference === 0 ? 'counted right' : d.difference < 0 ? money(-d.difference) + ' short' : money(d.difference) + ' over'));
    });
  }
  if (s.openOrders.count) L.push('Orders still open: ' + s.openOrders.count + ', ' + money(s.openOrders.amount));
  if (s.sales.iouOpen) L.push('IOUs not paid: ' + s.sales.iouOpen + ', ' + money(s.sales.iouOwed));
  if (s.lowStock.count) L.push('Running low: ' + s.lowStock.items.map(function (x) { return x.name; }).join(', ') + (s.lowStock.count > s.lowStock.items.length ? ' and ' + (s.lowStock.count - s.lowStock.items.length) + ' more' : ''));
  L.push('');
  L.push(by ? 'Closed by ' + by + '.' : 'Closed by itself at the set time.');
  return L.join('\n');
}

function closeOut(r) {
  return { id: r.id, day: String(r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day).slice(0, 10), closedAt: r.closed_at, closedBy: r.closed_by_name || null, auto: r.auto, note: r.note, summary: r.summary, sent: r.sent || {} };
}
async function closeOf(companyId, day) {
  var r = (await pool.query("SELECT c.*, e.first_name || ' ' || e.last_name AS closed_by_name FROM restaurant_day_closes c LEFT JOIN employees e ON e.id = c.closed_by WHERE c.company_id = $1 AND c.day = $2", [companyId, day])).rows[0];
  return r ? closeOut(r) : null;
}
async function history(companyId) {
  return (await pool.query(
    "SELECT c.*, e.first_name || ' ' || e.last_name AS closed_by_name FROM restaurant_day_closes c LEFT JOIN employees e ON e.id = c.closed_by WHERE c.company_id = $1 ORDER BY c.day DESC LIMIT 31", [companyId])).rows
    .map(function (r) { var c = closeOut(r); return { id: c.id, day: c.day, closedAt: c.closedAt, closedBy: c.closedBy, auto: c.auto, net: c.summary.sales.net, sales: c.summary.sales.count }; });
}

// Closed: { day, note, again } — by a manager (by), or by itself (by null).
// A day closed already is closed again only when asked (again), with the
// summary as it is now.
async function close(companyId, by, p) {
  p = p || {};
  var day = DAY.test(p.day || '') ? p.day : today();
  if (day > today()) fail('invalid', 'That day has not come yet.');
  var had = await closeOf(companyId, day);
  if (had && !p.again) fail('conflict', day + ' was closed already' + (had.closedBy ? ' by ' + had.closedBy : '') + '. Close it again to bring it up to date.');
  var s = await summary(companyId, day);
  var byName = by ? (by.first_name + ' ' + by.last_name).trim() : '';
  var text = words(s, byName);
  var note = String(p.note || '').trim().slice(0, 400);
  var settings = merge(await access().settingsOf(companyId));
  var row = await withTransaction(async function (db) {
    var r = (await db.query(
      'INSERT INTO restaurant_day_closes (company_id, day, closed_by, auto, note, summary) VALUES ($1,$2,$3,$4,$5,$6) ' +
      'ON CONFLICT (company_id, day) DO UPDATE SET closed_at = now(), closed_by = EXCLUDED.closed_by, auto = EXCLUDED.auto, note = EXCLUDED.note, summary = EXCLUDED.summary RETURNING *',
      [companyId, day, by ? by.id : null, !by, note, JSON.stringify(s)])).rows[0];
    var line = 'Day ' + day + ' closed' + (by ? '' : ' by itself') + ': ' + money(s.sales.net) + ' net from ' + s.sales.count + ' sales.';
    if (by) await audit(db, { user: { id: null }, employee: { first_name: by.first_name, last_name: by.last_name } }, 'restaurant.day.close', 'restaurant_day_close', r.id, line);
    await activity.log(db, { companyId: companyId, employeeId: by ? by.id : null, app: 'settings', action: 'settings.closeday', summary: line, amount: s.sales.net, refType: 'day_close', refId: r.id });
    var ids = await require('./restaurantPurchasing.service').managersOf(db, companyId);
    var co = (await db.query('SELECT code FROM companies WHERE id = $1', [companyId])).rows[0];
    for (var i = 0; i < ids.length; i++) {
      if (by && ids[i] === by.id) continue;
      await notify(db, ids[i], s.restaurant + ': day closed, ' + money(s.sales.net), s.sales.count + ' sales' + (s.drawerTotals.short ? ' · drawers ' + money(-s.drawerTotals.short) + ' short' : '') + (s.openOrders.count ? ' · ' + s.openOrders.count + ' orders still open' : ''),
        '/restaurant?restaurant=' + encodeURIComponent(co.code) + '&view=report');
    }
    return r;
  });
  // Emailed to the addresses set (not stopping the close if it cannot be).
  var sent = {};
  if (settings.emails.length && mail().configured()) {
    var esc = mail().escapeHtml;
    var ok = [], failed = [];
    for (var j = 0; j < settings.emails.length; j++) {
      try {
        await mail().send({ to: settings.emails[j], subject: s.restaurant + ' — day closed ' + day + ': ' + money(s.sales.net), fromName: s.restaurant, text: text,
          html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2937">' + esc(text).replace(/\n/g, '<br>') + '</div>' });
        ok.push(settings.emails[j]);
      } catch (e) { failed.push(settings.emails[j]); }
    }
    sent.email = { to: ok, failed: failed, at: new Date().toISOString() };
    await pool.query('UPDATE restaurant_day_closes SET sent = $2 WHERE id = $1', [row.id, JSON.stringify(sent)]);
  }
  var wa = waNumber(settings.whatsapp);
  return { close: await closeOf(companyId, day), message: text, whatsappUrl: 'https://wa.me/' + (wa || '') + '?text=' + encodeURIComponent(text), hasNumber: !!wa };
}

// The back office's Close the day: { action: 'preview' | 'close' | 'open', day, note, again }.
async function tab(companyId, by, p) {
  p = p || {};
  var day = DAY.test(p.day || '') ? p.day : today();
  var done = null;
  if (p.action === 'close') done = await close(companyId, by, Object.assign({}, p, { day: day }));
  var kept = await closeOf(companyId, day);
  var settings = merge(await access().settingsOf(companyId));
  return {
    day: day, closed: kept, live: p.action === 'open' && kept ? kept.summary : await summary(companyId, day), history: await history(companyId),
    settings: { auto: settings.auto, at: settings.at, emails: settings.emails.length, whatsapp: !!waNumber(settings.whatsapp) },
    message: done ? done.message : kept ? words(kept.summary, kept.closedBy) : null,
    whatsappUrl: done ? done.whatsappUrl : kept ? 'https://wa.me/' + (waNumber(settings.whatsapp) || '') + '?text=' + encodeURIComponent(words(kept.summary, kept.closedBy)) : null,
    done: done ? { sent: done.close.sent } : null
  };
}

// The day a restaurant closing at `at` closes last, by now: at a time
// after noon, that day's evening; before noon, the night before's.
function dueDay(at, now) {
  now = now || new Date();
  var hm = now.toISOString().slice(11, 16), d = now.toISOString().slice(0, 10);
  if (at >= '12:00') return hm >= at ? d : addDays(d, -1);
  return hm >= at ? addDays(d, -1) : addDays(d, -2);
}
// The job (jobs/closeDay.js): each restaurant closing by itself whose day
// has ended and is not closed, if anything happened on it.
async function runDue(now) {
  var rows = (await pool.query("SELECT company_id, settings FROM restaurant_till_settings WHERE (settings->'closeDay'->>'auto') = 'true'")).rows;
  var closed = 0;
  for (var i = 0; i < rows.length; i++) {
    var c = merge(rows[i].settings);
    var day = dueDay(c.at, now);
    if (await closeOf(rows[i].company_id, day)) continue;
    var busy = (await pool.query(
      "SELECT (SELECT count(*) FROM restaurant_orders WHERE company_id = $1 AND created_at >= $2::date AND created_at < $2::date + interval '1 day') + " +
      "(SELECT count(*) FROM restaurant_drawer_sessions WHERE company_id = $1 AND opened_at >= $2::date AND opened_at < $2::date + interval '1 day') AS n", [rows[i].company_id, day])).rows[0];
    if (!Number(busy.n)) continue;
    try { await close(rows[i].company_id, null, { day: day }); closed++; } catch (e) { console.error('[close day] ' + day + ' not closed:', e.message); }
  }
  return closed;
}

module.exports = { DEFAULTS: DEFAULTS, merge: merge, clean: clean, summary: summary, close: close, tab: tab, history: history, runDue: runDue, dueDay: dueDay, _words: words };
