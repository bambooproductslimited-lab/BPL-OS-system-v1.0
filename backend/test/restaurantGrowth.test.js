// The fourth five from the Square list (migrations 0175–0177): texts and
// emails to guests (campaigns and the automatic ones), orders from delivery
// apps rung up on the till, the self-order kiosk, the reports Square has
// (categories, areas, times of day, voids, labour, comparisons, the owner's
// phone), and card payments (the bank's terminal, or Paystack). Fake Zqk
// data only; nothing goes out: texts, emails and Paystack are stubbed.
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var money = require('../src/services/restaurantTillMoney.service');
var campaigns = require('../src/services/restaurantCampaigns.service');
var apps = require('../src/services/restaurantApps.service');
var kiosk = require('../src/services/restaurantKiosk.service');
var paystack = require('../src/services/restaurantPaystack.service');
var tableOrders = require('../src/services/restaurantTableOrders.service');
var insights = require('../src/services/restaurantTillInsights.service');
var exp = require('../src/services/restaurantSquareExport.service');
var sms = require('../src/services/sms.service');
var mail = require('../src/services/mail.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7591', kojo: '7592' };
var IP = '10.9.8.1';
var company, dept, people = {}, tok = {}, rice, juice, t1;
var texts = [], mails = [];
var realSms = { configured: sms.configured, send: sms.send };
var realKey = config.paystack.secretKey;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQK'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_campaign_sends WHERE company_id = ANY($1)', 'DELETE FROM restaurant_campaigns WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_paystack_payments WHERE company_id = ANY($1)', 'DELETE FROM restaurant_table_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_displays WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_refund_items WHERE refund_id IN (SELECT id FROM restaurant_refunds WHERE company_id = ANY($1))', 'DELETE FROM restaurant_refunds WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_payments WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_orders WHERE company_id = ANY($1)', 'DELETE FROM restaurant_app_payouts WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_tables WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_loyalty_entries WHERE company_id = ANY($1)', 'DELETE FROM restaurant_guests WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM restaurant_displays WHERE company_id IS NULL AND ip LIKE '10.9.8.%'");
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQK-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQK-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, pay) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash, hourly_rate) VALUES ($1, $2, 'Zqk', $3, $4, current_date, 'active', 'permanent', $5, $6) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key]), pay])).rows[0].id;
}
async function settings(s) { await access.saveSettings(tok.kojo, { settings: s }, IP); }
function cash(total) { return [{ method: 'cash', currency: 'GHS', tendered: total }]; }
function today() { return new Date().toISOString().slice(0, 10); }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }
async function guestRow(name, phone, extra) {
  extra = extra || {};
  return (await pool.query(
    "INSERT INTO restaurant_guests (company_id, name, phone, source, email, birthday, marketing) VALUES ($1, $2, $3, 'till', $4, $5, $6) RETURNING id",
    [company.id, name, phone || '', extra.email || '', extra.birthday || null, extra.marketing || 'unknown'])).rows[0].id;
}
async function sale(guestId, total, at) {
  var s = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', guestId: guestId, items: [{ menuItemId: rice, qty: total / 50 }], payments: cash(total) });
  if (at) await pool.query('UPDATE restaurant_orders SET created_at = $2 WHERE id = $1', [s.id, at]);
  return s;
}

// Paystack, as its API answers (no request leaves the machine).
var paystackState = {};
function stubPaystack() {
  config.paystack.secretKey = 'zqk-fake-paystack-key-for-tests';
  paystack.setFetchForTests(async function (url, opts) {
    var body = opts.body ? JSON.parse(opts.body) : null;
    var data;
    if (/\/transaction\/initialize$/.test(url)) {
      paystackState[body.reference] = { status: 'ongoing', amount: body.amount, sent: body };
      data = { authorization_url: 'https://checkout.paystack.com/zqk' + body.reference.slice(-6).toLowerCase(), reference: body.reference };
    } else {
      var ref = decodeURIComponent(url.split('/').pop());
      var st = paystackState[ref] || { status: 'ongoing', amount: 0 };
      data = { reference: ref, status: st.status, amount: st.paidAmount || st.amount, channel: st.channel || '', fees: st.status === 'success' ? 150 : null,
        authorization: st.status === 'success' ? { card_type: st.cardType || 'visa ', last4: st.last4 || '4081' } : {} };
    }
    return { ok: true, status: 200, json: async function () { return { status: true, message: 'ok', data: data }; } };
  });
}
// What the till sends to charge an open order: its dishes, as it shows them.
function chargeOf(tab) {
  return { tabId: tab.id, fulfillment: tab.fulfillment, items: tab.lines.map(function (l) { return { menuItemId: l.menuItemId, variationId: l.variationId || undefined, qty: l.qty }; }) };
}
// Paid (or not) on Paystack's side; the till asks again at once (not waiting the 3 seconds between checks).
async function paid(ref, extra) {
  Object.assign(paystackState[ref], { status: 'success' }, extra || {});
  await pool.query('UPDATE restaurant_paystack_payments SET checked_at = NULL WHERE reference = $1', [ref]);
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQK', 'Zqk Grill') RETURNING *")).rows[0];
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQKF', 'Zqk Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQK-1', 'Ama', 20);
  await person('kojo', 'ZQK-2', 'Kojo', 30);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager')", [company.id, people.kojo]);
  rice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqk jollof', 'Zqk Mains', 50, true) RETURNING id", [company.id])).rows[0].id;
  juice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqk sobolo', 'Zqk Drinks', 20, true) RETURNING id", [company.id])).rows[0].id;
  t1 = (await pool.query("INSERT INTO restaurant_tables (company_id, name, seats, area) VALUES ($1, 'Zqk T1', 4, 'Zqk Patio') RETURNING id", [company.id])).rows[0].id;
  await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zqk Kitchen', '{}', true)", [company.id]);
  for (var k of ['ama', 'kojo']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
  // Texts "sent" through a stand-in for mNotify; emails through a stand-in transport.
  sms.configured = function () { return true; };
  sms.send = async function (o) { texts.push(o); return { ok: true }; };
  mail.setTransportForTests({ sendMail: async function (m) { mails.push(m); return { messageId: 'zqk-' + mails.length }; } });
});
test.after(async function () {
  sms.configured = realSms.configured; sms.send = realSms.send;
  mail.setTransportForTests(null);
  paystack.setFetchForTests(null);
  config.paystack.secretKey = realKey;
  await cleanup(); await pool.end();
});

test('a guest\'s email, birthday and yes or no to messages, kept from the till', async function () {
  var g = await pos.createGuestForSession(tok.ama, { name: 'Zqk Abena', phone: '0200000871', email: 'zqk.abena@example.com', birthday: '1990-03-14', marketing: 'yes' });
  assert.equal(g.email, 'zqk.abena@example.com');
  assert.equal(g.marketing, 'yes');
  assert.match(String(g.birthday), /^1990-03-14/);
  var changed = await pos.guestContact(tok.ama, g.id, { marketing: 'no' });
  assert.equal(changed.marketing, 'no');
  assert.equal(changed.email, 'zqk.abena@example.com');
  await assert.rejects(pos.guestContact(tok.ama, g.id, { email: 'not an email' }), /email/i);
  var acts = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'till.customer'", [company.id])).rows.map(function (r) { return r.summary; });
  assert.ok(acts.some(function (s) { return /Zqk Abena wants no texts or emails/.test(s); }));
  await pool.query('DELETE FROM restaurant_guests WHERE id = $1', [g.id]);
});

test('campaigns: an audience, who is left out and why, sent within the limits, the stop link', async function () {
  await settings({ campaigns: { from: '00:00', to: '24:00', perGuestDays: 7, dailyMax: 300 } });
  var ama = await guestRow('Zqk Ama', '0200000861', { email: 'zqk.ama@example.com', marketing: 'yes' });
  var kofi = await guestRow('Zqk Kofi', '0200000862', { marketing: 'no' });
  var esi = await guestRow('Zqk Esi', '', { email: 'zqk.esi@example.com' });
  var yaa = await guestRow('Zqk Yaa', '');
  await sale(ama, 100, new Date(Date.now() - 50 * 86400000));
  await sale(kofi, 50, new Date(Date.now() - 45 * 86400000));
  await sale(esi, 150);
  // Only a manager, with their PIN.
  await assert.rejects(campaigns.tab(tok.ama, { managerPin: PINS.ama }, IP), /manager/i);
  var list = await campaigns.tab(tok.ama, { managerPin: PINS.kojo }, IP);
  assert.equal(list.guests.guests, 4);
  assert.equal(list.guests.said_no, 1);
  assert.equal(list.smsOn, true);
  // Everyone, by text or else email: Ama by text, Esi by email; Kofi said no, Yaa has neither.
  var pv = await campaigns.tab(tok.ama, { managerPin: PINS.kojo, action: 'preview', campaign: { name: 'Zqk weekend', channel: 'both', message: 'Hi {name}, {restaurant} has a new jollof this weekend!', audience: { kind: 'all' } } }, IP);
  assert.equal(pv.matching, 4);
  assert.equal(pv.bySms, 1);
  assert.equal(pv.byEmail, 1);
  assert.deepEqual(pv.left, { 'said no': 1, 'no phone or email': 1 });
  assert.match(pv.sample.text, /^Hi Zqk, Zqk Grill has a new jollof/);
  assert.equal(pv.sample.segments, 1);
  // Not back for 30 days: Ama and Kofi (who said no).
  var lapsed = await campaigns.tab(tok.ama, { managerPin: PINS.kojo, action: 'preview', campaign: { name: 'Zqk back', channel: 'sms', message: 'We miss you, {name}! Come back soon.', audience: { kind: 'lapsed', days: 30 } } }, IP);
  assert.equal(lapsed.matching, 2);
  assert.equal(lapsed.reach, 1);
  await assert.rejects(campaigns.tab(tok.ama, { managerPin: PINS.kojo, action: 'save', campaign: { name: 'Zqk', channel: 'fax', message: 'Hello there everyone' } }, IP), /text, by email or both/);
  // Sent now: the job sends it (in the background on the server; here by hand).
  var sent = await campaigns.tab(tok.ama, { managerPin: PINS.kojo, action: 'send', campaign: { name: 'Zqk weekend', channel: 'both', subject: 'Zqk news', message: 'Hi {name}, {restaurant} has a new jollof this weekend!', audience: { kind: 'all' } } }, IP);
  var c = sent.campaigns.find(function (x) { return x.name === 'Zqk weekend'; });
  assert.equal(c.status, 'scheduled');
  await campaigns.runDue();
  var after = await campaigns.tab(tok.ama, { managerPin: PINS.kojo }, IP);
  c = after.campaigns.find(function (x) { return x.name === 'Zqk weekend'; });
  assert.equal(c.status, 'sent');
  assert.equal(c.counts.sent, 2);
  assert.equal(c.counts.sms, 1);
  assert.equal(c.counts.email, 1);
  assert.equal(after.sentToday, 2);
  var text = texts.find(function (t) { return t.to === '0200000861'; });
  assert.equal(text.purpose, 'marketing');
  assert.match(text.message, /^Hi Zqk, Zqk Grill has a new jollof this weekend! Stop: https?:\/\/.+\/u\/[A-Za-z0-9_-]{12}$/);
  assert.ok(!texts.some(function (t) { return t.to === '0200000862'; }), 'never to a guest who said no');
  var email = mails.find(function (m) { return m.to === 'zqk.esi@example.com'; });
  assert.equal(email.subject, 'Zqk news');
  assert.match(email.html, /Stop these emails/);
  // The same week again: nobody, they were messaged lately.
  var again = await campaigns.tab(tok.ama, { managerPin: PINS.kojo, action: 'preview', campaign: { name: 'Zqk again', channel: 'both', message: 'Another message for you all.', audience: { kind: 'all' } } }, IP);
  assert.equal(again.reach, 0);
  assert.equal(again.left['messaged lately'], 2);
  // The stop link: who and where, then no more.
  var token = text.message.split('/u/')[1];
  var look = await campaigns.unsubscribe(token, false);
  assert.deepEqual(look, { restaurant: { code: 'ZQK', name: 'Zqk Grill' }, name: 'Zqk', stopped: false });
  assert.equal((await campaigns.unsubscribe(token, true)).stopped, true);
  assert.equal((await pool.query('SELECT marketing FROM restaurant_guests WHERE id = $1', [ama])).rows[0].marketing, 'no');
  await assert.rejects(campaigns.unsubscribe('nope', true), /not right/);
  // Ama came back after the message: the campaign shows it.
  await pool.query("UPDATE restaurant_guests SET marketing = 'yes' WHERE id = $1", [ama]);
  await sale(ama, 100);
  c = (await campaigns.tab(tok.ama, { managerPin: PINS.kojo }, IP)).campaigns.find(function (x) { return x.name === 'Zqk weekend'; });
  assert.deepEqual(c.results, { guests: 1, orders: 1, spent: 100 });
  // Set for later, then cancelled; once sent it cannot be.
  var later = new Date(Date.now() + 2 * 86400000).toISOString();
  var res = await campaigns.tab(tok.ama, { managerPin: PINS.kojo, action: 'send', sendAt: later, campaign: { name: 'Zqk later', channel: 'sms', message: 'Something for later on.', audience: { kind: 'regulars', visits: 2 } } }, IP);
  var l = res.campaigns.find(function (x) { return x.name === 'Zqk later'; });
  assert.equal(l.status, 'scheduled');
  assert.equal((await campaigns.runDue()).campaigns, 0);
  res = await campaigns.tab(tok.ama, { managerPin: PINS.kojo, action: 'cancel', id: l.id }, IP);
  assert.equal(res.campaigns.find(function (x) { return x.id === l.id; }).status, 'cancelled');
  await assert.rejects(campaigns.tab(tok.ama, { managerPin: PINS.kojo, action: 'cancel', id: c.id }, IP), /gone out already/);
  await pool.query('DELETE FROM restaurant_campaign_sends WHERE company_id = $1', [company.id]);
  await pool.query('DELETE FROM restaurant_campaigns WHERE company_id = $1', [company.id]);
  await pool.query('UPDATE restaurant_orders SET guest_id = NULL WHERE company_id = $1', [company.id]);
  await pool.query('DELETE FROM restaurant_guests WHERE id = ANY($1)', [[ama, kofi, esi, yaa]]);
});

test('the automatic messages: happy birthday on the day, thank you after a first visit, we miss you once', async function () {
  texts.length = 0;
  var now = new Date();
  var bday = '1992-' + String(now.getUTCMonth() + 1).padStart(2, '0') + '-' + String(now.getUTCDate()).padStart(2, '0');
  var b = await guestRow('Zqk Akua', '0200000881', { birthday: bday });
  var w = await guestRow('Zqk Kwesi', '0200000882');
  var m = await guestRow('Zqk Afia', '0200000883');
  await sale(w, 50, new Date(Date.now() - 20 * 3600000));
  await sale(m, 50, new Date(Date.now() - 40 * 86400000));
  // Off: nothing.
  assert.equal(await campaigns.runAuto(company.id), 0);
  await assert.rejects(settings({ campaigns: { lapsed: { on: true, channel: 'sms', days: 3, message: 'We miss you {name}!' } } }), /7 to 365 days/);
  await settings({ campaigns: { perGuestDays: 0, birthday: { on: true, channel: 'sms', message: 'Happy birthday {name}! A treat waits at {restaurant}.' },
    welcome: { on: true, channel: 'sms', message: 'Thank you for coming, {name}!' }, lapsed: { on: true, channel: 'sms', days: 30, message: 'We miss you {name}, come back soon!' } } });
  assert.equal(await campaigns.runAuto(company.id), 3);
  assert.match(texts.find(function (t) { return t.to === '0200000881'; }).message, /^Happy birthday Zqk! A treat waits at Zqk Grill\./);
  assert.match(texts.find(function (t) { return t.to === '0200000882'; }).message, /^Thank you for coming, Zqk!/);
  assert.match(texts.find(function (t) { return t.to === '0200000883'; }).message, /^We miss you Zqk, come back soon!/);
  // Once each: the next round sends nothing.
  assert.equal(await campaigns.runAuto(company.id), 0);
  var list = await campaigns.tab(tok.ama, { managerPin: PINS.kojo }, IP);
  var autos = list.campaigns.filter(function (c) { return c.kind !== 'manual'; });
  assert.equal(autos.length, 3);
  assert.ok(autos.every(function (c) { return c.status === 'auto' && c.counts.sent === 1; }));
  // Without mNotify on the server: kept as not sent, saying why.
  sms.configured = function () { return false; };
  await pool.query('DELETE FROM restaurant_campaign_sends WHERE company_id = $1', [company.id]);
  await campaigns.runAuto(company.id);
  var skipped = (await pool.query("SELECT status, error FROM restaurant_campaign_sends WHERE company_id = $1", [company.id])).rows;
  assert.ok(skipped.length >= 1 && skipped.every(function (s) { return s.status === 'skipped' && /mNotify/.test(s.error); }));
  sms.configured = function () { return true; };
  await settings({ campaigns: { birthday: { on: false, channel: 'sms', message: 'Happy birthday {name}!!' }, welcome: { on: false, channel: 'sms', message: 'Thank you for coming!' },
    lapsed: { on: false, channel: 'sms', days: 30, message: 'We miss you {name}!' } } });
  await pool.query('DELETE FROM restaurant_campaign_sends WHERE company_id = $1', [company.id]);
  await pool.query('DELETE FROM restaurant_campaigns WHERE company_id = $1', [company.id]);
  await pool.query('UPDATE restaurant_orders SET guest_id = NULL WHERE company_id = $1', [company.id]);
  await pool.query('DELETE FROM restaurant_guests WHERE id = ANY($1)', [[b, w, m]]);
});

test('delivery apps: rung up at the app\'s prices, paid on the app, its commission, its payout', async function () {
  var p = { app: { key: 'bolt', ref: 'ZQ4471', customer: 'Zqk Rider' }, items: [{ menuItemId: rice, qty: 2 }], payments: [{ method: 'app' }] };
  await assert.rejects(pos.createOrder(tok.ama, p), /Bolt Food is turned off/);
  await assert.rejects(settings({ apps: { list: [{ key: 'bolt', name: 'Bolt Food', on: true, markup: 10, commission: 90 }] } }), /from 0% to 60%/);
  await settings({ apps: { list: [{ key: 'bolt', name: 'Bolt Food', on: true, markup: 10, commission: 20 }, { key: 'glovo', name: 'Glovo', on: false, markup: 0, commission: 25 }] } });
  await assert.rejects(pos.createOrder(tok.ama, Object.assign({}, p, { app: { key: 'bolt', ref: '' } })), /Bolt Food order code/);
  await assert.rejects(pos.createOrder(tok.ama, Object.assign({}, p, { payments: cash(110) })), /paid on the app/);
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqk Esi', customerPhone: '0200000891', items: [{ menuItemId: rice, qty: 1 }], payments: [{ method: 'app' }] }), /Only a delivery app/);
  var s = await pos.createOrder(tok.ama, p);
  assert.equal(s.total, 110);
  assert.equal(s.channel, 'app');
  assert.deepEqual(s.app, { key: 'bolt', ref: 'ZQ4471', commission: 22 });
  assert.equal(s.paymentMethod, 'app');
  assert.equal(s.fulfillment, 'pickup');
  // Nothing in the drawer from it.
  var drawer = await pos.getOpenDrawerSession(tok.ama);
  assert.equal(drawer.session ? drawer.session.cashSales || 0 : 0, 0);
  // To the kitchen with the app's name.
  var ticket = (await pool.query('SELECT label FROM restaurant_kitchen_tickets WHERE order_id = $1', [s.id])).rows[0];
  if (ticket) assert.match(ticket.label, /^Bolt Food #ZQ4471 · Zqk Rider/);
  // Refunded in the app, not at the till.
  var line = (await pool.query('SELECT id FROM restaurant_order_items WHERE order_id = $1', [s.id])).rows[0];
  await assert.rejects(money.refundSale(tok.ama, s.id, { items: [{ id: line.id, qty: 1 }], reason: 'Zqk cold', method: 'cash', managerPin: PINS.kojo }, IP), /app/i);
  // What Bolt owes: 110 less 22; its payout against the orders up to today.
  var tab = await apps.settingsTab(tok.ama, { managerPin: PINS.kojo }, IP);
  var bolt = tab.apps.find(function (a) { return a.key === 'bolt'; });
  assert.deepEqual([bolt.unpaid.orders, bolt.unpaid.sales, bolt.unpaid.commission, bolt.unpaid.owed], [1, 110, 22, 88]);
  assert.equal(tab.recent[0].ref, 'ZQ4471');
  await assert.rejects(apps.settingsTab(tok.ama, { managerPin: PINS.kojo, action: 'payout', app: 'glovo', through: today(), amount: 10, method: 'mobile_money' }, IP), /No Glovo orders/);
  tab = await apps.settingsTab(tok.ama, { managerPin: PINS.kojo, action: 'payout', app: 'bolt', through: today(), amount: 85, method: 'bank_transfer', note: 'Zqk week' }, IP);
  assert.equal(tab.payouts[0].expected, 88);
  assert.equal(tab.payouts[0].difference, -3);
  assert.equal(tab.apps.find(function (a) { return a.key === 'bolt'; }).unpaid.orders, 0);
  assert.equal(tab.recent[0].paidOut, true);
  // In Square's item sales download: the app as the channel, its code in the fulfillment note.
  var rows = (await exp.itemSalesRows([company.id], { from: today(), to: today() })).rows;
  var head = rows[0];
  var r = rows.find(function (x) { return x[head.indexOf('Fulfillment Note')] === 'Bolt Food #ZQ4471'; });
  assert.ok(r);
  assert.equal(r[head.indexOf('Channel')], 'Bolt Food');
  assert.equal(r[head.indexOf('Dining Option')], 'Delivery');
  assert.match(r[head.indexOf('Gross Sales')], /110\.00$/);
});

test('cards: the bank\'s terminal recorded (brand, last 4, tap), and in the Square download', async function () {
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqk Ato', customerPhone: '0200000892', items: [{ menuItemId: juice, qty: 1 }], payments: [{ method: 'card' }] }), /turned off/);
  var s0 = (await access.settingsOf(company.id));
  await settings({ paymentMethods: s0.paymentMethods.concat(['card']), card: { terminals: ['Zqk GCB terminal'], paystack: false } });
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqk Ato', customerPhone: '0200000892', items: [{ menuItemId: juice, qty: 1 }], payments: [{ method: 'card', card: { last4: '12' } }] }), /last 4 digits/);
  var s = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqk Ato', customerPhone: '0200000892', items: [{ menuItemId: juice, qty: 2 }],
    payments: [{ method: 'card', card: { brand: 'Visa', last4: '4242', entry: 'tap', ref: 'A1B2', terminal: 'Zqk GCB terminal' } }] });
  assert.equal(s.paymentMethod, 'card');
  var pay = (await pool.query('SELECT * FROM restaurant_order_payments WHERE order_id = $1', [s.id])).rows[0];
  assert.deepEqual([pay.card_brand, pay.card_last4, pay.card_entry, pay.card_ref, pay.provider], ['Visa', '4242', 'tap', 'Zqk GCB terminal · A1B2', 'terminal']);
  var rows = (await exp.itemSalesRows([company.id], { from: today(), to: today() })).rows;
  var head = rows[0];
  var r = rows.find(function (x) { return x[head.indexOf('Transaction ID')] === s.orderNo; });
  assert.equal(r[head.indexOf('Card Brand')], 'Visa');
  assert.equal(r[head.indexOf('PAN Suffix')], '4242');
  // A card sale is refunded to the card or in cash.
  var line = (await pool.query('SELECT id FROM restaurant_order_items WHERE order_id = $1', [s.id])).rows[0];
  await money.refundSale(tok.ama, s.id, { items: [{ id: line.id, qty: 1 }], reason: 'Zqk spilt', method: 'card', managerPin: PINS.kojo }, IP);
  assert.equal(Number((await pool.query('SELECT refunded_total FROM restaurant_orders WHERE id = $1', [s.id])).rows[0].refunded_total), 20);
});

test('Paystack: a QR code on the till, paid on the customer\'s phone, used by one sale only; its webhook', async function () {
  config.paystack.secretKey = '';
  await assert.rejects(paystack.start(tok.ama, { amount: 50 }), /not on/);
  stubPaystack();
  await assert.rejects(paystack.start(tok.ama, { amount: 50 }), /not on for this restaurant/);
  var s0 = await access.settingsOf(company.id);
  await settings({ card: { terminals: s0.card.terminals, paystack: true } });
  await assert.rejects(paystack.start(tok.ama, { amount: 0.5 }), /GHS 1/);
  var pay = await paystack.start(tok.ama, { amount: 70 });
  assert.match(pay.reference, /^BOS-ZQK-/);
  assert.match(pay.url, /^https:\/\/checkout\.paystack\.com\//);
  assert.equal(pay.status, 'pending');
  var sent = paystackState[pay.reference].sent;
  assert.equal(sent.amount, 7000);
  assert.equal(sent.currency, 'GHS');
  assert.deepEqual(sent.channels, ['card', 'mobile_money']);
  var order = { fulfillment: 'pickup', customerName: 'Zqk Ato', customerPhone: '0200000892', items: [{ menuItemId: rice, qty: 1 }, { menuItemId: juice, qty: 1 }] };
  await assert.rejects(pos.createOrder(tok.ama, Object.assign({ payments: [{ paystackRef: pay.reference }] }, order)), /not paid yet/);
  await paid(pay.reference, { channel: 'card', cardType: 'mastercard', last4: '5555' });
  var st = await paystack.status(tok.ama, pay.reference);
  assert.equal(st.status, 'success');
  assert.deepEqual([st.cardBrand, st.cardLast4], ['Mastercard', '5555']);
  var s = await pos.createOrder(tok.ama, Object.assign({ payments: [{ paystackRef: pay.reference }] }, order));
  assert.equal(s.paymentMethod, 'card');
  var row = (await pool.query('SELECT * FROM restaurant_order_payments WHERE order_id = $1', [s.id])).rows[0];
  assert.deepEqual([row.provider, row.provider_ref, row.card_brand, row.card_last4, row.card_entry], ['paystack', pay.reference, 'Mastercard', '5555', 'online']);
  await assert.rejects(pos.createOrder(tok.ama, Object.assign({ payments: [{ paystackRef: pay.reference }] }, order)), /paid for a sale already/);
  // Mobile Money through Paystack is Mobile Money; the amount must match the bill.
  var momo = await paystack.start(tok.ama, { amount: 50 });
  await paid(momo.reference, { channel: 'mobile_money' });
  await assert.rejects(pos.createOrder(tok.ama, Object.assign({ payments: [{ paystackRef: momo.reference }] }, order)), /add up to 50.00; the bill is 70.00/);
  await assert.rejects(pos.createOrder(tok.ama, Object.assign({ payments: [{ paystackRef: momo.reference, amount: 70 }] }, order)), /was for 50.00, not 70.00/);
  var s2 = await pos.createOrder(tok.ama, Object.assign({}, order, { items: [{ menuItemId: rice, qty: 1 }], payments: [{ paystackRef: momo.reference }] }));
  assert.equal(s2.paymentMethod, 'mobile_money');
  // Paid less than asked: no good.
  var short = await paystack.start(tok.ama, { amount: 40 });
  await paid(short.reference, { paidAmount: 100 });
  assert.equal((await paystack.status(tok.ama, short.reference)).status, 'failed');
  // The webhook: signed with the secret key, or nothing.
  var hooked = await paystack.start(tok.ama, { amount: 20 });
  var body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: hooked.reference, status: 'success', amount: 2000, channel: 'card', fees: 30, authorization: { card_type: 'verve', last4: '0001' } } }));
  await assert.rejects(paystack.webhook(body, 'deadbeef'), /Not signed/);
  var sig = crypto.createHmac('sha512', config.paystack.secretKey).update(body).digest('hex');
  assert.deepEqual(await paystack.webhook(body, sig), { ok: true });
  var h = await paystack.rowOf(company.id, hooked.reference);
  assert.deepEqual([h.status, h.card_brand, h.card_last4, h.fees], ['success', 'Verve', '0001', '0.30']);
  // The manager's reconciliation: what came in, with Paystack's fees and the sale it paid.
  var rep = await paystack.report(company.id, today(), today());
  assert.equal(rep.length, 3);
  assert.equal(rep.find(function (x) { return x.reference === pay.reference; }).orderNo, s.orderNo);
});

test('the self-order kiosk: paired with a code, orders waiting at the counter, straight to the kitchen, paid on the kiosk', async function () {
  var hi = await kiosk.hello(null, '10.9.8.2', 'zqk-tablet');
  assert.equal(hi.kind, 'kiosk');
  var v = await kiosk.view(hi.key);
  assert.equal(v.paired, false);
  assert.match(v.code, /^\d{6}$/);
  await assert.rejects(kiosk.menu(hi.key), /not on a till/);
  // A customer screen's code does not pair a kiosk, nor the other way round.
  await assert.rejects(kiosk.pair(tok.ama, { code: '12' }), /6 numbers/);
  var listed = await kiosk.pair(tok.ama, { code: v.code, name: 'Zqk Door' });
  assert.equal(listed.kiosks.length, 1);
  assert.equal(listed.kiosks[0].name, 'Zqk Door');
  v = await kiosk.view(hi.key);
  assert.deepEqual([v.paired, v.name, v.restaurant.code, v.on], [true, 'Zqk Door', 'ZQK', false]);
  var menu = await kiosk.menu(hi.key);
  assert.ok(menu.items.some(function (i) { return i.id === rice; }));
  var order = { items: [{ menuItemId: rice, qty: 1 }, { menuItemId: juice, qty: 2 }], dining: 'away', name: 'Zqk Kwame', pay: 'counter' };
  await assert.rejects(kiosk.place(hi.key, order, '10.9.8.3'), /not taking orders/);
  await assert.rejects(settings({ kiosk: { on: true, idleSeconds: 5 } }), /30 to 600 seconds/);
  await settings({ kiosk: { on: true, straightToKitchen: false, payHere: false, idleSeconds: 90, welcome: 'Zqk: order here!' } });
  await assert.rejects(kiosk.place(hi.key, Object.assign({}, order, { dining: '' }), '10.9.8.3'), /Eat here or take away/);
  await assert.rejects(kiosk.place(hi.key, Object.assign({}, order, { pay: 'here' }), '10.9.8.3'), /pay at the counter/);
  // Pay at the counter: it waits on the till with the QR orders.
  var placed = await kiosk.place(hi.key, order, '10.9.8.3');
  assert.match(placed.ref, /^K-\d{4}$/);
  assert.deepEqual([placed.total, placed.status, placed.dining], [90, 'pending', 'away']);
  var inbox = await tableOrders.inbox(tok.ama);
  var o = inbox.orders.find(function (x) { return x.kind === 'kiosk'; });
  assert.deepEqual([o.ref, o.kioskName, o.dining, o.name], [placed.ref, 'Zqk Door', 'away', 'Zqk Kwame']);
  var took = await tableOrders.accept(tok.ama, o.id, {});
  assert.ok(took.tab.id);
  var tab = (await pos.listTabs(tok.ama)).find(function (t) { return t.id === took.tab.id; });
  assert.equal(tab.fulfillment, 'pickup');
  assert.match(tab.label, /^K-\d{4} · Zqk Kwame$/);
  var sold = await pos.createOrder(tok.ama, Object.assign(chargeOf(tab), { payments: cash(90) }));
  assert.equal(sold.channel, 'kiosk');
  // Straight to the kitchen: eaten here, no table needed.
  await settings({ kiosk: { on: true, straightToKitchen: true, payHere: false, idleSeconds: 90 } });
  var straight = await kiosk.place(hi.key, Object.assign({}, order, { dining: 'here' }), '10.9.8.4');
  assert.equal(straight.status, 'accepted');
  assert.ok(straight.kitchen);
  // Paid on the kiosk, through Paystack: unpaid until it is, then to the kitchen and the till.
  await settings({ kiosk: { on: true, straightToKitchen: false, payHere: true, idleSeconds: 90 } });
  assert.equal((await kiosk.view(hi.key)).payHere, true);
  var payNow = await kiosk.place(hi.key, Object.assign({}, order, { pay: 'here', back: 'https://evil.example.com/self-order' }), '10.9.8.5');
  assert.equal(payNow.status, 'unpaid');
  assert.match(payNow.pay.url, /^https:\/\/checkout\.paystack\.com\//);
  assert.equal(paystackState[payNow.pay.reference].sent.amount, 9000);
  assert.ok(!/evil/.test(paystackState[payNow.pay.reference].sent.callback_url), 'back only to our own sites');
  assert.ok(!(await tableOrders.inbox(tok.ama)).orders.some(function (x) { return x.ref === payNow.ref; }), 'not on the till until paid');
  assert.equal((await kiosk.payStatus(hi.key, payNow.pay.reference)).status, 'unpaid');
  await paid(payNow.pay.reference, { channel: 'mobile_money' });
  var done = await kiosk.payStatus(hi.key, payNow.pay.reference);
  assert.deepEqual([done.paid, done.status], [true, 'accepted']);
  var paidTab = (await pos.listTabs(tok.ama)).find(function (t) { return t.paidOnKiosk && t.paidOnKiosk.ref === payNow.pay.reference; });
  assert.equal(paidTab.paidOnKiosk.amount, 90);
  assert.equal(paidTab.fromKiosk, true);
  var sale2 = await pos.createOrder(tok.ama, Object.assign(chargeOf(paidTab), { payments: [{ paystackRef: payNow.pay.reference }] }));
  assert.equal(sale2.paymentMethod, 'mobile_money');
  assert.equal(sale2.channel, 'kiosk');
  // An abandoned payment: the order is cancelled.
  var gone = await kiosk.place(hi.key, Object.assign({}, order, { pay: 'here' }), '10.9.8.6');
  paystackState[gone.pay.reference].status = 'abandoned';
  assert.equal((await kiosk.payStatus(hi.key, gone.pay.reference)).status, 'cancelled');
  // In the Square download: the kiosk is its own channel.
  var rows = (await exp.itemSalesRows([company.id], { from: today(), to: today() })).rows;
  var head = rows[0];
  assert.ok(rows.some(function (x) { return x[head.indexOf('Transaction ID')] === sold.orderNo && x[head.indexOf('Channel')] === 'Zqk Grill Kiosk'; }));
  // Off the till: the kiosk shows a new code.
  await kiosk.unpair(tok.ama, listed.kiosks[0].id);
  await assert.rejects(kiosk.view(hi.key), /taken off the till/);
});

test('reports: categories, areas, times of day, voids, labour, against the period before; the owner\'s phone', async function () {
  var dine = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 2 }], payments: cash(100) });
  var lastWeek = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 1 }], payments: cash(50) });
  await pool.query("UPDATE restaurant_orders SET created_at = now() - interval '7 days' WHERE id = $1", [lastWeek.id]);
  var v = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqk Ato', customerPhone: '0200000892', items: [{ menuItemId: juice, qty: 1 }], payments: cash(20) });
  await pos.voidOrder(tok.kojo, v.id, { reason: 'Zqk wrong order', managerPin: PINS.kojo }).catch(function () { return pool.query("UPDATE restaurant_orders SET status = 'voided' WHERE id = $1", [v.id]); });
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, status, source, note) VALUES ($1, current_date, '08:00', '16:00', 'present', 'manual', ''), ($2, current_date, '10:00', '14:00', 'present', 'manual', '')",
    [people.ama, people.kojo]);
  var s = await access.settingsOf(company.id);
  var r = await insights.report(company.id, { from: today(), to: today(), compare: 'previous' }, s);
  assert.deepEqual(r.period, { from: today(), to: today(), days: 1 });
  assert.deepEqual([r.compare.from, r.compare.to], [daysAgo(1), daysAgo(1)]);
  assert.ok(r.totals.orders >= 5);
  assert.ok(r.categories.some(function (c) { return c.name === 'Zqk Mains'; }));
  var areas = {};
  r.areas.forEach(function (a) { areas[a.name] = a; });
  assert.equal(areas['Bolt Food'].kind, 'app');
  assert.equal(areas.Kiosk.kind, 'kiosk');
  assert.equal(areas['Zqk Patio'].kind, 'floor');
  assert.ok(areas['Zqk Patio'].amount >= 100);
  assert.ok(areas.Takeaway.orders >= 1);
  assert.equal(r.time.grid.length, 7);
  assert.equal(r.time.grid[0].length, 24);
  var hour = new Date().getUTCHours(), dow = new Date().getUTCDay();
  assert.ok(r.time.grid[dow][hour].orders >= 5);
  assert.equal(r.time.dayparts.length, 5);
  assert.equal(r.voids.sales.count, 1);
  assert.equal(r.voids.sales.amount, 20);
  assert.deepEqual([r.labour.people, r.labour.hours, r.labour.cost], [2, 12, 280]);
  assert.equal(r.labour.share, Math.round(280 / r.totals.net * 10000) / 100);
  var yesterday = (await pool.query("SELECT count(*)::int AS n FROM restaurant_orders WHERE company_id = $1 AND status = 'completed' AND created_at::date = $2", [company.id, daysAgo(1)])).rows[0].n;
  assert.equal(r.before.totals.orders, yesterday);
  assert.equal(r.before.dayparts.length, 5);
  var yr = await insights.report(company.id, { from: today(), to: today(), compare: 'year' }, s);
  assert.equal(yr.compare.kind, 'year');
  assert.equal((await insights.report(company.id, { compare: 'none' }, s)).before, undefined);
  await assert.rejects(insights.report(company.id, { from: '2024-01-01', to: '2025-06-01' }, s), /a year at most/);
  // The owner's phone: today against the same weekday last week, and now.
  var o = await insights.owner([company.id]);
  var me = o.restaurants.find(function (x) { return x.code === 'ZQK'; });
  assert.equal(me.lastWeek.orders, 1);
  assert.equal(me.lastWeek.net, 50);
  assert.ok(me.today.orders >= 5);
  assert.equal(me.week.length, 7);
  assert.equal(me.top[0].name.indexOf('Zqk'), 0);
  assert.ok(me.now.drawers >= 1);
  assert.ok(dine.id);
});
