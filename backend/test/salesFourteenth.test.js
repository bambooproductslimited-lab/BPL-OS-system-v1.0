// Bamboo Products' deliveries, fitting and repairs (migration 0195): a shop
// order waiting for its delivery, planned for a day and a window with a
// crew (the customer told, the crew notified); the crew on their phone —
// on the way, done with a signature and a photo — the order following; the
// customer's page; a repair asked for from it with photos, under warranty,
// answered, a repair visit that could not be done. Fake Zqv data.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var visits = require('../src/services/bplVisits.service');
var shop = require('../src/services/shop.service');
var mail = require('../src/services/mail.service');
var sms = require('../src/services/sms.service');

var boss, crewA, crewB, stranger, order, sent = [], texts = [];
var real = { configured: sms.configured, send: sms.send };
var PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
var PNG = 'data:image/png;base64,' + PNG_BYTES.toString('base64');
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function cleanup() {
  await pool.query("DELETE FROM bpl_visits WHERE name LIKE 'Zqv %'");
  await pool.query("DELETE FROM bpl_service_requests WHERE name LIKE 'Zqv %'");
  await pool.query("DELETE FROM shop_orders WHERE name LIKE 'Zqv %'");
  await pool.query("DELETE FROM customer_identities WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqv %')").catch(function () {});
  await pool.query("DELETE FROM customers WHERE name LIKE 'Zqv %'");
  await pool.query("DELETE FROM notifications WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQV-%')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqv.%@example.com'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQV-%'");
  await pool.query("UPDATE settings SET visits = '{}' WHERE id = 1");
}
async function staff(code, first) {
  var dept = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' ORDER BY d.code LIMIT 1")).rows[0].id;
  var emp = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type) VALUES ($1, $2, 'Zqv', $3, $4, current_date, 'active', 'permanent') RETURNING id",
    [code, first, 'zqv.' + first.toLowerCase() + '@example.com', dept])).rows[0].id;
  var user = (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, $2, 'x', 'active') RETURNING id", [emp, 'zqv.' + first.toLowerCase() + '@example.com'])).rows[0].id;
  return buildContext(user);
}

test.before(async function () {
  await cleanup();
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  crewA = await staff('ZQV-1', 'Kwesi');
  crewB = await staff('ZQV-2', 'Yaw');
  stranger = await staff('ZQV-3', 'Efua');
  var cust = await require('../src/services/customers.service').create(boss, { name: 'Zqv Ama Owusu', phone: '0240000881', email: 'zqv.ama@example.com', category: 'active' });
  order = (await pool.query(
    "INSERT INTO shop_orders (order_no, customer_id, name, phone, email, fulfilment, address, area, lines, total, status, token, steps) VALUES ('ZQV-1001', $2, 'Zqv Ama Owusu', '+233240000881', 'zqv.ama@example.com', 'delivery', 'Zqv 12 Palm Lane', 'Zqv East', $1, 2400, 'ready', 'zqv-order-token-00000000001', '{}') RETURNING *",
    [JSON.stringify([{ description: 'Zqv Bamboo daybed, natural', qty: 1, unitPrice: 2400 }]), cust.id])).rows[0];
  mail.setTransportForTests({ sendMail: async function (m) { sent.push(m); return { messageId: 'zqv-' + sent.length }; } });
  sms.configured = function () { return true; };
  sms.send = async function (o) { texts.push(o); return { id: 'zqv-' + texts.length, to: o.to }; };
});
test.after(async function () {
  sms.configured = real.configured; sms.send = real.send;
  mail.setTransportForTests(null);
  await cleanup();
  await pool.end();
});

var v;
test('a delivery planned for a day and a window with a crew: the customer told, the crew notified; the crew see only theirs', async function () {
  var b = await visits.board(boss, { from: day(0) });
  assert.ok(b.waiting.shop.some(function (o) { return o.orderNo === 'ZQV-1001' && o.items[0].description === 'Zqv Bamboo daybed, natural'; }), 'the order waits for its delivery');
  assert.ok(b.crew.some(function (c) { return c.name === 'Kwesi Zqv'; }), 'Bamboo Products\' staff to pick from');
  var plan = { kind: 'delivery', shopOrderId: order.id, day: day(1), from: '08:00', to: '12:00', crew: [crewA.employee.id, crewB.employee.id], vehicle: 'Zqv van 1', note: 'Zqv: call at the gate' };
  await assert.rejects(visits.save(boss, Object.assign({}, plan, { crew: [] })), /Pick the crew/);
  await assert.rejects(visits.save(boss, Object.assign({}, plan, { day: day(-1) })), /That day is past/);
  await assert.rejects(visits.save(boss, Object.assign({}, plan, { to: '07:00' })), /time window/);
  await assert.rejects(visits.save(crewA, plan), /invoice\.manage/);
  texts.length = 0; sent.length = 0;
  v = await visits.save(boss, plan);
  assert.deepEqual([v.ref.slice(0, 2), v.status, v.name, v.address, v.items[0].description, v.crew.map(function (c) { return c.name; }).join(', ')],
    ['V-', 'planned', 'Zqv Ama Owusu', 'Zqv 12 Palm Lane', 'Zqv Bamboo daybed, natural', 'Kwesi Zqv, Yaw Zqv']);
  assert.deepEqual(v.told.sort(), ['email', 'sms']);
  assert.match(texts[0].message, /we will come for your delivery \(order ZQV-1001\) on .* between 08:00 and 12:00\..*\/o\/zqv-order-token/);
  var n = (await pool.query('SELECT title, link FROM notifications WHERE employee_id = $1', [crewA.employee.id])).rows;
  assert.equal(n.length, 1);
  assert.match(n[0].title, /^🚚 V-\d{4} · /);
  assert.equal(n[0].link, '/bplvisits?mine=1');
  b = await visits.board(boss, { from: day(0) });
  assert.ok(!b.waiting.shop.some(function (o) { return o.orderNo === 'ZQV-1001'; }), 'planned: no longer waiting');
  // The crew see theirs, nothing else; someone else sees nothing.
  var mine = await visits.board(crewA, {});
  assert.deepEqual([mine.canRead, mine.mine.length, mine.visits], [false, 1, undefined]);
  await assert.rejects(visits.board(stranger, {}), /invoice\.read/);
  // Moved to another window: told again.
  texts.length = 0;
  v = await visits.save(boss, Object.assign({}, plan, { id: v.id, from: '12:00', to: '16:00' }));
  assert.match(texts[0].message, /we moved your delivery .* to .* between 12:00 and 16:00/);
});

test('the crew on the way and done: signed for, a photo; the order goes out then done; the customer\'s page says so', async function () {
  await assert.rejects(visits.act(stranger, v.id, 'on-way', {}), /Only its crew or a manager/);
  texts.length = 0;
  var r = await visits.act(crewA, v.id, 'on-way', {});
  assert.equal(r.status, 'on_way');
  assert.equal((await pool.query('SELECT status FROM shop_orders WHERE id = $1', [order.id])).rows[0].status, 'out');
  assert.match(texts[0].message, /is on its way to you/);
  await assert.rejects(visits.act(crewA, v.id, 'cancel', {}), /Only its crew or a manager/);
  await assert.rejects(visits.act(crewA, v.id, 'done', { signature: [[[1, 2], [3, 4]]] }), /Who received it/);
  await assert.rejects(visits.act(crewA, v.id, 'done', { signedName: 'Zqv Ama' }), /sign, or take a photo/);
  r = await visits.act(crewB, v.id, 'done', { signedName: 'Zqv Ama Owusu', signature: [[[10, 20], [30, 40], [50, 25]]], photos: [PNG], outcome: 'Zqv: set up in the living room' });
  assert.deepEqual([r.status, r.signedName, r.hasSignature, r.photos], ['done', 'Zqv Ama Owusu', true, 1]);
  assert.equal((await pool.query('SELECT status FROM shop_orders WHERE id = $1', [order.id])).rows[0].status, 'done');
  await assert.rejects(visits.act(crewA, v.id, 'failed', { outcome: 'Zqv: too late' }), /done already/);
  var ph = await visits.photoKey(crewA, v.id, 0);
  assert.equal(ph.name, 'visit-1.png');
  await assert.rejects(visits.photoKey(stranger, v.id, 0), /invoice\.read/);
  var t = await shop.track(order.token);
  assert.deepEqual([t.after.visit.status, t.after.visit.signedName, t.after.visit.crew.join(' '), t.after.canAskRepair], ['done', 'Zqv Ama Owusu', 'Kwesi Yaw', true]);
  var until = new Date(); until.setUTCMonth(until.getUTCMonth() + 12);
  assert.equal(t.after.warrantyUntil, until.toISOString().slice(0, 10));
  assert.equal(JSON.stringify(t).indexOf('+233240000881'), -1, 'no phone number on the customer\'s page');
});

test('a repair asked for from the order\'s page with a photo: under warranty, answered; a repair visit that could not be done', async function () {
  visits._askedBy.clear();
  await assert.rejects(visits.ask('zqv-no-such-order-token-0000', { problem: 'Zqv: the leg is loose and wobbles' }, [], '10.15.0.1'), /cannot find that order/);
  await assert.rejects(visits.ask(order.token, { problem: 'loose' }, [], '10.15.0.1'), /a few words at least/);
  await assert.rejects(visits.ask(order.token, { problem: 'Zqv: the leg is loose and wobbles' }, [{ buffer: Buffer.from('not a photo') }], '10.15.0.1'), /JPG, PNG or WebP/);
  texts.length = 0;
  var a = await visits.ask(order.token, { item: 'Zqv Bamboo daybed, natural', problem: 'Zqv: one leg is loose and the daybed wobbles.' }, [{ buffer: PNG_BYTES }], '10.15.0.1');
  assert.match(a.ref, /^S-\d{4}$/);
  assert.match(texts[0].message, /we have your repair request S-\d{4}.*\/s\//);
  var held = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE title LIKE '🛠️ Repair request ' || $1", [a.ref])).rows[0].n;
  assert.ok(held >= 1, 'staff who manage invoices are told');
  var page = await visits.serviceView(a.token);
  assert.deepEqual([page.status, page.name, page.photos, page.underWarranty, page.orderNo, page.phone], ['new', 'Zqv', 1, true, 'ZQV-1001', undefined]);
  var b = await visits.board(boss, {});
  var s = b.services.find(function (x) { return x.ref === a.ref; });
  assert.deepEqual([s.status, s.underWarranty, s.photos], ['new', true, 1]);
  await assert.rejects(visits.serviceUpdate(crewA, s.id, { warranty: true }), /invoice\.manage/);
  texts.length = 0;
  var u = await visits.serviceUpdate(boss, s.id, { warranty: true, answer: 'Zqv: under warranty, free. We will come to fix it.' });
  assert.deepEqual([u.warranty, u.answer], [true, 'Zqv: under warranty, free. We will come to fix it.']);
  assert.match(texts[0].message, /about your repair request S-\d{4}: Zqv: under warranty, free/);
  // A repair visit: the request waits on it; could not be done, it waits again.
  var rv = await visits.save(boss, { kind: 'repair', serviceId: s.id, day: day(2), from: '12:00', to: '16:00', crew: [crewA.employee.id] });
  assert.deepEqual([rv.kind, rv.service.ref, rv.name], ['repair', a.ref, 'Zqv Ama Owusu']);
  assert.equal((await visits.serviceView(a.token)).status, 'visit');
  assert.equal((await visits.serviceView(a.token)).visit.from, '12:00');
  await assert.rejects(visits.act(crewA, rv.id, 'failed', {}), /Why could it not be done/);
  await visits.act(crewA, rv.id, 'failed', { outcome: 'Zqv: nobody home' });
  assert.equal((await visits.serviceView(a.token)).status, 'new');
  // The warranty from the settings.
  await visits.saveSettings(boss, { warrantyMonths: 6, windows: ['09:00-13:00', 'bad', '14:00-18:00'], repairs: false });
  var st = await visits.settingsOf();
  assert.deepEqual([st.warrantyMonths, st.windows, st.repairs], [6, ['09:00-13:00', '14:00-18:00'], false]);
  await assert.rejects(visits.ask(order.token, { problem: 'Zqv: another thing is wrong here' }, [], '10.15.0.2'), /Call us about a repair/);
});
