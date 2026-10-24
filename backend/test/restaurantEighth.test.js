// The eighth batch on the restaurant side (migration 0187): the time clock
// on the till's PIN screen (in, breaks, out), the manager's timecards
// against the rota with corrections, shifts swapped between staff with a
// manager's approval, and gift cards bought on the restaurant's website
// through Paystack. Fake Zqe data only; nothing goes out: Paystack is
// stubbed, email goes to a test transport, texts are not set up.
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var timecards = require('../src/services/restaurantTimecards.service');
var gifts = require('../src/services/restaurantGiftCards.service');
var paystack = require('../src/services/restaurantPaystack.service');
var online = require('../src/services/restaurantOnline.service');
var mail = require('../src/services/mail.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7661', kojo: '7662', yaw: '7663', esi: '7664' };
var IP = '10.9.8.31';
var company, other, dept, people = {}, tok = {};
var realKey = config.paystack.secretKey;
var sent = [];

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code IN ('ZQE', 'ZQEX')")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_paystack_payments WHERE company_id = ANY($1)', 'DELETE FROM restaurant_gift_card_entries WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_gift_cards WHERE company_id = ANY($1)', 'DELETE FROM restaurant_shift_swaps WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_rota_shifts WHERE company_id = ANY($1)', 'DELETE FROM restaurant_delivery_settings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM audit_logs WHERE entity = 'attendance' AND entity_id IN (SELECT a.id::text FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE e.code LIKE 'ZQE-%')");
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQE-%')");
  await pool.query("DELETE FROM notifications WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQE-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQE-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, role, rate, deptId) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash, hourly_rate) VALUES ($1, $2, 'Zqe', $3, $4, current_date, 'active', 'permanent', $5, $6) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', deptId || dept, pinAuth.hashPin(PINS[key]), rate])).rows[0].id;
  if (role) await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [company.id, people[key], role]);
}
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function manager(p) { return Object.assign({ managerPin: PINS.kojo }, p); }
async function shift(key, d, starts, ends, published) {
  return (await pool.query('INSERT INTO restaurant_rota_shifts (company_id, employee_id, day, starts, ends, role, published) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [company.id, people[key], d, starts, ends, 'Cashier', published !== false])).rows[0].id;
}

// Paystack, as its API answers (no request leaves the machine).
var paystackState = {};
function stubPaystack() {
  config.paystack.secretKey = 'zqe-fake-paystack-key-for-tests';
  paystack.setFetchForTests(async function (url, opts) {
    var body = opts.body ? JSON.parse(opts.body) : null;
    var data;
    if (/\/transaction\/initialize$/.test(url)) {
      paystackState[body.reference] = { status: 'ongoing', amount: body.amount, sent: body };
      data = { authorization_url: 'https://checkout.paystack.com/zqe' + body.reference.slice(-6).toLowerCase(), reference: body.reference };
    } else {
      var ref = decodeURIComponent(url.split('/').pop());
      var st = paystackState[ref] || { status: 'ongoing', amount: 0 };
      data = { reference: ref, status: st.status, amount: st.paidAmount || st.amount, channel: st.channel || 'card', fees: st.status === 'success' ? 100 : null, authorization: {} };
    }
    return { ok: true, status: 200, json: async function () { return { status: true, message: 'ok', data: data }; } };
  });
}
async function paid(ref, extra) {
  Object.assign(paystackState[ref], { status: 'success' }, extra || {});
  await pool.query('UPDATE restaurant_paystack_payments SET checked_at = NULL WHERE reference = $1', [ref]);
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQE', 'Zqe Kitchen') RETURNING *")).rows[0];
  other = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQEX', 'Zqe Office') RETURNING *")).rows[0];
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQEF', 'Zqe Floor', $1) RETURNING id", [company.id])).rows[0].id;
  var officeDept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQEO', 'Zqe Desk', $1) RETURNING id", [other.id])).rows[0].id;
  await person('ama', 'ZQE-1', 'Ama', 'cashier', 20);
  await person('kojo', 'ZQE-2', 'Kojo', 'manager', 40);
  await person('yaw', 'ZQE-3', 'Yaw', 'waiter', 15);
  await person('esi', 'ZQE-4', 'Esi', null, null, officeDept);
  for (var k of ['ama', 'kojo', 'yaw']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  mail.setTransportForTests({ sendMail: async function (m) { sent.push(m); return { messageId: 'zqe-' + sent.length }; } });
});
test.after(async function () {
  paystack.setFetchForTests(null);
  config.paystack.secretKey = realKey;
  mail.setTransportForTests(null);
  await cleanup(); await pool.end();
});

test('the time clock: a PIN clocks in, takes a break, comes back and clocks out; only restaurant staff', async function () {
  await assert.rejects(timecards.timeclock('9999', 'status', '10.9.8.32'), /Incorrect PIN/);
  await assert.rejects(timecards.timeclock(PINS.esi, 'status', '10.9.8.32'), /restaurant's staff only/);
  var s = await timecards.timeclock(PINS.ama, 'status', IP);
  assert.equal(s.state, 'out');
  assert.equal(s.name, 'Ama Zqe');
  assert.equal(s.planned, null);
  await assert.rejects(timecards.timeclock(PINS.ama, 'out', IP), /not clocked in/);
  await assert.rejects(timecards.timeclock(PINS.ama, 'break', IP), /not clocked in/);

  s = await timecards.timeclock(PINS.ama, 'in', IP);
  assert.equal(s.state, 'in');
  assert.ok(s.since);
  // Asking again leaves the shift open (an open shift is not closed early).
  s = await timecards.timeclock(PINS.ama, 'status', IP);
  assert.equal(s.state, 'in');
  await assert.rejects(timecards.timeclock(PINS.ama, 'in', IP), /clocked in already/);
  var row = (await pool.query('SELECT * FROM attendance WHERE employee_id = $1', [people.ama])).rows[0];
  assert.equal(row.source, 'till');
  assert.equal(row.clock_out, null);

  s = await timecards.timeclock(PINS.ama, 'break', IP);
  assert.equal(s.state, 'break');
  await assert.rejects(timecards.timeclock(PINS.ama, 'break', IP), /on a break already/);
  // A break of 15 minutes, as if it started earlier.
  await pool.query("UPDATE attendance_breaks SET starts_at = now() - interval '15 minutes' WHERE attendance_id = $1", [row.id]);
  s = await timecards.timeclock(PINS.ama, 'back', IP);
  assert.equal(s.state, 'in');
  assert.equal(s.breakMinutes, 15);
  await assert.rejects(timecards.timeclock(PINS.ama, 'back', IP), /not on a break/);

  // Clocking out while on a break ends the break first.
  await timecards.timeclock(PINS.ama, 'break', IP);
  s = await timecards.timeclock(PINS.ama, 'out', IP);
  assert.equal(s.state, 'out');
  var open = (await pool.query('SELECT count(*)::int AS n FROM attendance_breaks WHERE attendance_id = $1 AND ends_at IS NULL', [row.id])).rows[0].n;
  assert.equal(open, 0);
  row = (await pool.query('SELECT * FROM attendance WHERE id = $1', [row.id])).rows[0];
  assert.ok(row.clock_out);
  await assert.rejects(timecards.timeclock(PINS.ama, 'dance', IP), /Clock in, a break/);

  var log = (await pool.query("SELECT action FROM restaurant_activity WHERE company_id = $1 AND action LIKE 'till.clock_%' ORDER BY at", [company.id])).rows.map(function (r) { return r.action; });
  assert.deepEqual(log, ['till.clock_in', 'till.clock_break', 'till.clock_back', 'till.clock_break', 'till.clock_out']);
});

test('timecards: the week against the rota (late, not planned, missed), what it cost; a manager corrects a card with a reason', async function () {
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQE-%')");
  var monday = require('../src/services/restaurantRota.service').mondayOf(day(0));
  var d1 = monday, d2 = (function () { var d = new Date(monday + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  // A Monday shift Yaw came 20 minutes late to (8 h planned, 8 h worked less 30 min break),
  // a Tuesday shift of Ama's she missed (when that day is past), and a day Kojo worked off the rota.
  await shift('yaw', d1, '08:00', '16:00');
  await shift('ama', d1, '09:00', '17:00');
  var yawCard = (await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, status, source, shift_no) VALUES ($1, $2, '08:20', '16:20', 'present', 'till', 1) RETURNING id", [people.yaw, d1])).rows[0].id;
  await pool.query("INSERT INTO attendance_breaks (attendance_id, starts_at, ends_at) VALUES ($1, $2::date + time '12:00', $2::date + time '12:30')", [yawCard, d1]);
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, status, source, shift_no) VALUES ($1, $2, '10:00', '14:00', 'present', 'till', 1)", [people.kojo, d1]);

  await assert.rejects(access.timecards(tok.ama, { action: 'week' }, IP), /manager/i);
  var w = await access.timecards(tok.ama, manager({ action: 'week', weekOf: d2 }), IP);
  assert.equal(w.weekStart, monday);
  var yaw = w.cards.find(function (c) { return c.employeeId === people.yaw; });
  assert.equal(yaw.name, 'Yaw Zqe');
  assert.equal(yaw.in, '08:20');
  assert.equal(yaw.lateMinutes, 20);
  assert.ok(yaw.flags.indexOf('late') >= 0);
  assert.equal(yaw.breakMinutes, 30);
  assert.equal(yaw.workedMinutes, 450);
  assert.deepEqual(yaw.planned, { starts: '08:00', ends: '16:00' });
  var kojo = w.cards.find(function (c) { return c.employeeId === people.kojo; });
  assert.ok(kojo.flags.indexOf('unplanned') >= 0);
  var amaMissed = w.missed.filter(function (m) { return m.employeeId === people.ama; });
  if (d1 < day(0)) assert.equal(amaMissed.length, 1);
  var staffYaw = w.staff.find(function (p) { return p.id === people.yaw; });
  assert.equal(staffYaw.hours, 7.5);
  assert.equal(staffYaw.plannedHours, 8);
  assert.equal(staffYaw.cost, 7.5 * 15);
  assert.equal(staffYaw.late, 1);

  // Corrected: came at 08:00 as agreed, a 45-minute break.
  var correct = function (card, reason) { return access.timecards(tok.ama, manager({ action: 'correct', weekOf: d2, card: card, reason: reason }), IP); };
  await assert.rejects(correct({ id: yawCard, in: '08:00', out: '16:20' }, ''), /Say why/);
  await assert.rejects(correct({ id: yawCard, in: '8:00', out: '16:20' }, 'Zqe agreed'), /like 08:00/);
  w = await correct({ id: yawCard, in: '08:00', out: '16:20', breakMinutes: 45 }, 'Zqe: came at 8 as agreed');
  yaw = w.cards.find(function (c) { return c.id === yawCard; });
  assert.equal(yaw.in, '08:00');
  assert.equal(yaw.lateMinutes, 0);
  assert.equal(yaw.breakMinutes, 45);
  assert.equal(yaw.workedMinutes, 455);
  assert.ok(yaw.edited);
  assert.match(yaw.note, /Corrected 08:20–16:20 → 08:00–16:20 by Kojo Zqe: Zqe: came at 8 as agreed/);
  var audited = (await pool.query("SELECT summary FROM audit_logs WHERE action = 'restaurant.timecard_correct' AND entity_id = $1::text", [yawCard])).rows;
  assert.equal(audited.length, 1);
  // Out the next morning: a night shift.
  w = await correct({ id: yawCard, in: '20:00', out: '02:00', breakMinutes: 0 }, 'Zqe: the night shift');
  yaw = w.cards.find(function (c) { return c.id === yawCard; });
  assert.equal(yaw.workedMinutes, 360);
  assert.ok(yaw.outDay > yaw.day);

  // Not this restaurant's: someone else's timecard.
  var esiCard = (await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status, source, shift_no) VALUES ($1, $2, '09:00', 'present', 'kiosk', 1) RETURNING id", [people.esi, d1])).rows[0].id;
  await assert.rejects(correct({ id: esiCard, in: '08:00', out: '12:00' }, 'Zqe sneaky'), /does not work at this restaurant/);
});

test('shift swaps: offered on the till, taken by a colleague, approved by a manager; checked for clashes and owners', async function () {
  var mine = await shift('ama', day(2), '09:00', '17:00');
  var draft = await shift('ama', day(3), '09:00', '17:00', false);
  var yawSame = await shift('yaw', day(2), '12:00', '20:00');

  var r = await access.rotaSwaps(tok.ama, { action: 'mine' });
  assert.ok(r.mine.some(function (s) { return s.id === mine && !s.swap; }));
  assert.ok(!r.mine.some(function (s) { return s.id === draft; }), 'drafts are not on the till');
  await assert.rejects(access.rotaSwaps(tok.yaw, { action: 'offer', shiftId: mine }), /Only your own shifts/);
  await assert.rejects(access.rotaSwaps(tok.ama, { action: 'offer', shiftId: draft }), /not on the published rota/);
  r = await access.rotaSwaps(tok.ama, { action: 'offer', shiftId: mine, note: 'Zqe: a wedding' });
  var swap = r.mine.find(function (s) { return s.id === mine; }).swap;
  assert.equal(swap.status, 'open');
  await assert.rejects(access.rotaSwaps(tok.ama, { action: 'offer', shiftId: mine }), /offered already/);
  await assert.rejects(access.rotaSwaps(tok.ama, { action: 'take', swapId: swap.id }), /your own shift/);

  // Yaw works 12:00–20:00 that day already: a clash.
  r = await access.rotaSwaps(tok.yaw, { action: 'mine' });
  assert.equal(r.open.length, 1);
  assert.equal(r.open[0].offeredBy.name, 'Ama Zqe');
  await assert.rejects(access.rotaSwaps(tok.yaw, { action: 'take', swapId: swap.id }), /already work 12:00–20:00/);
  await pool.query('DELETE FROM restaurant_rota_shifts WHERE id = $1', [yawSame]);
  r = await access.rotaSwaps(tok.yaw, { action: 'take', swapId: swap.id });
  assert.equal(r.waiting.length, 1);
  assert.equal(r.open.length, 0);
  await assert.rejects(access.rotaSwaps(tok.kojo, { action: 'take', swapId: swap.id }), /took it first/);
  var told = (await pool.query("SELECT employee_id, title FROM notifications WHERE employee_id = ANY($1) AND title LIKE '%would take%'", [[people.kojo, people.ama]])).rows;
  assert.equal(told.length, 2);

  // The manager sees it on the rota and approves it: the shift is Yaw's.
  await assert.rejects(access.rota(tok.yaw, { action: 'decide', swapId: swap.id, approve: true }, IP), /manager/i);
  var w = await access.rota(tok.ama, manager({ action: 'week', weekOf: day(2) }), IP);
  assert.equal(w.swaps.length, 1);
  assert.equal(w.swaps[0].takenBy.name, 'Yaw Zqe');
  w = await access.rota(tok.ama, manager({ action: 'decide', swapId: swap.id, approve: true, weekOf: day(2) }), IP);
  assert.equal(w.swaps.length, 0);
  var owner = (await pool.query('SELECT employee_id FROM restaurant_rota_shifts WHERE id = $1', [mine])).rows[0].employee_id;
  assert.equal(owner, people.yaw);
  await assert.rejects(access.rota(tok.ama, manager({ action: 'decide', swapId: swap.id, approve: false }), IP), /decided already/);
  told = (await pool.query("SELECT title FROM notifications WHERE employee_id = ANY($1) AND title LIKE '✅%'", [[people.ama, people.yaw]])).rows;
  assert.equal(told.length, 2);

  // Offered and taken back.
  var later = await shift('ama', day(5), '09:00', '13:00');
  r = await access.rotaSwaps(tok.ama, { action: 'offer', shiftId: later });
  var s2 = r.mine.find(function (s) { return s.id === later; }).swap;
  await assert.rejects(access.rotaSwaps(tok.yaw, { action: 'cancel', swapId: s2.id }), /Only who offered it/);
  r = await access.rotaSwaps(tok.ama, { action: 'cancel', swapId: s2.id });
  assert.equal(r.mine.find(function (s) { return s.id === later; }).swap, null);
});

test('gift cards on the website: only when on, paid through Paystack first, one card made whoever asks first, sent to whoever it is for', async function () {
  stubPaystack();
  await pool.query("INSERT INTO restaurant_delivery_settings (company_id, settings) VALUES ($1, '{}')", [company.id]);
  var buy = { amount: 150, toName: 'Zqe Abena', toEmail: 'zqe.abena@example.com', fromName: 'Zqe Kwesi', message: 'Zqe: happy birthday!', buyerEmail: 'zqe.kwesi@example.com', back: 'https://evil.example.com/x' };
  await assert.rejects(gifts.buyOnline('ZQE', buy, '10.9.8.40'), /does not sell gift cards/);
  assert.equal((await online.menu('ZQE')).restaurant.gift, null);
  await access.saveSettings(tok.kojo, { settings: { giftCards: { on: true, online: true, amounts: [50, 100, 200] } } }, IP);
  assert.deepEqual((await online.menu('ZQE')).restaurant.gift, { amounts: [50, 100, 200] });

  await assert.rejects(gifts.buyOnline('ZQE', Object.assign({}, buy, { amount: 5 }), '10.9.8.40'), /GHS 10 to GHS 5,000/);
  await assert.rejects(gifts.buyOnline('ZQE', Object.assign({}, buy, { toEmail: '' }), '10.9.8.40'), /phone number or email/);
  await assert.rejects(gifts.buyOnline('ZQE', Object.assign({}, buy, { toPhone: '12' }), '10.9.8.40'), /phone number does not look right/);
  var started = await gifts.buyOnline('ZQE', buy, '10.9.8.40');
  assert.match(started.url, /^https:\/\/checkout\.paystack\.com\//);
  assert.match(started.secret, /^[A-Za-z0-9_-]{24}$/);
  var sentToPaystack = paystackState[started.reference].sent;
  assert.equal(sentToPaystack.amount, 15000);
  assert.ok(sentToPaystack.callback_url.endsWith('/gp/' + started.secret), 'back to the restaurant\'s own site, not the address asked for');
  assert.ok(sentToPaystack.callback_url.indexOf('evil') < 0);

  var b = await gifts.bought(started.secret);
  assert.equal(b.status, 'pending');
  assert.equal(b.card, null);
  await assert.rejects(gifts.bought('zqe-not-a-real-secret-000'), /cannot find/);
  // A gift card payment does not pay for a sale at the till.
  await paid(started.reference);
  await assert.rejects(paystack.claimFor(pool, company.id, [started.reference]), /bought a gift card/);

  // The buyer back on the site and Paystack's webhook at once: one card.
  var row = await paystack.check((await pool.query('SELECT * FROM restaurant_paystack_payments WHERE reference = $1', [started.reference])).rows[0], true);
  var made = await Promise.all([gifts.settleOnline(row), gifts.settleOnline(row), gifts.bought(started.secret)]);
  assert.equal(made[0].id, made[1].id);
  var cards = (await pool.query('SELECT * FROM restaurant_gift_cards WHERE company_id = $1', [company.id])).rows;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].sold_method, 'online');
  assert.equal(cards[0].sold_by, null);
  assert.equal(cards[0].to_email, 'zqe.abena@example.com');
  assert.equal(cards[0].buyer_email, 'zqe.kwesi@example.com');
  var entries = (await pool.query('SELECT kind, amount, method FROM restaurant_gift_card_entries WHERE card_id = $1', [cards[0].id])).rows;
  assert.deepEqual(entries.map(function (e) { return [e.kind, Number(e.amount), e.method]; }), [['sold', 150, 'online']]);
  b = made[2];
  assert.equal(b.status, 'success');
  assert.ok(b.card.link.endsWith('/g/' + cards[0].token));
  assert.match(b.card.whatsapp, /^https:\/\/wa\.me\/\?text=/);
  var page = await gifts.publicCard(cards[0].token);
  assert.equal(page.balance, 150);
  assert.equal(page.toName, 'Zqe Abena');
  // Sent once: to Abena, and a copy to Kwesi.
  var mails = sent.filter(function (m) { return /zqe\.(abena|kwesi)/.test(m.to); });
  assert.equal(mails.length, 2);
  assert.match(mails.find(function (m) { return m.to === 'zqe.abena@example.com'; }).subject, /Zqe Kwesi sent you a gift card/);
  var report = await access.settingsManager(tok.kojo, PINS.kojo, IP).then(function (m) { return gifts.report(m.session.posCompanyId, {}); });
  assert.equal(report.totals.sold, 150);
  assert.equal(report.cards[0].soldMethod, 'online');
  // Not money in any drawer.
  assert.deepEqual(await gifts.drawerCash(pool, people.ama, company.id, new Date(Date.now() - 86400000), new Date()), { sold: 0, voided: 0 });

  // By Paystack's webhook alone (the buyer closed the page): the card is made.
  var second = await gifts.buyOnline('ZQE', Object.assign({}, buy, { toEmail: '', toPhone: '024 412 3456', amount: 60 }), '10.9.8.41');
  await paid(second.reference);
  var body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: second.reference, status: 'success', amount: 6000, channel: 'mobile_money' } }));
  var sig = crypto.createHmac('sha512', config.paystack.secretKey).update(body).digest('hex');
  await assert.rejects(paystack.webhook(body, 'bad'), /Not signed/);
  await paystack.webhook(body, sig);
  var viaHook = (await pool.query('SELECT gift_card_id FROM restaurant_paystack_payments WHERE reference = $1', [second.reference])).rows[0].gift_card_id;
  assert.ok(viaHook);
  b = await gifts.bought(second.secret);
  assert.equal(b.toPhone, true);
  assert.match(b.card.whatsapp, /^https:\/\/wa\.me\/233244123456\?text=/);

  // Paid less than asked: no card.
  var third = await gifts.buyOnline('ZQE', Object.assign({}, buy, { amount: 80 }), '10.9.8.42');
  await paid(third.reference, { paidAmount: 100 });
  b = await gifts.bought(third.secret);
  assert.equal(b.status, 'failed');
  assert.equal(b.card, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM restaurant_gift_cards WHERE company_id = $1', [company.id])).rows[0].n, 2);

  // Turned off on the website again.
  await access.saveSettings(tok.kojo, { settings: { giftCards: { on: true, online: false, amounts: [50, 100, 200] } } }, IP);
  await assert.rejects(gifts.buyOnline('ZQE', buy, '10.9.8.43'), /does not sell gift cards/);
});
