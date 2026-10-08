/*
 * A restaurant's guest CRM (restaurantCrm.service.js): the order sheet
 * customer service keeps (Bamboo Garden's BG ORDER RECORD layout, with what
 * the spreadsheet does to it), the order log linked to the sales on the
 * till, guests from Square, feedback and follow-ups, and the overview.
 * A made-up restaurant (ZRC), made-up guests (Zrc …), 020 555 numbers.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var ExcelJS = require('exceljs');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var crm = require('../src/services/restaurantCrm.service');
var squareImport = require('../src/services/restaurantSquareImport.service');
var { todayISO } = require('../src/utils/documents');

var admin, co, n = 0;
function day(offset) { var d = new Date(todayISO() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); }
function utc(iso) { return new Date(iso + 'T00:00:00Z'); }

async function cleanup() {
  var ids = (await pool.query("SELECT id FROM companies WHERE code IN ('ZRC', 'ZRS')")).rows.map(function (r) { return r.id; });
  if (!ids.length) return;
  await pool.query('DELETE FROM restaurant_guest_orders WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))', [ids]);
  await pool.query('DELETE FROM restaurant_orders WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM restaurant_guests WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', [ids]);
  await pool.query("DELETE FROM employees WHERE code = 'ZRC-SQIMPORT'");
  await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [ids]);
  await pool.query("DELETE FROM audit_logs WHERE (action LIKE 'restaurant.guest%' OR action LIKE 'restaurant.square_import%') AND (summary LIKE '%Zrc%' OR entity_id = ANY($1::text[]))", [ids]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
}

test.before(async function () {
  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  co = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZRC', 'Zrc Garden') RETURNING *")).rows[0];
  await pool.query("INSERT INTO departments (code, name, company_id, status) VALUES ('ZRC-K', 'Zrc Kitchen', $1, 'active')", [co.id]);
  await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price) VALUES ($1, 'Z01 Zrc Assorted Fried Rice', 'Zrc', 79), ($1, 'Z02 Zrc Beef Noodles', 'Zrc', 90), ($1, 'Z03 Zrc Spring Rolls', 'Zrc', 40)", [co.id]);
});
test.after(async function () { await cleanup(); await pool.end(); });

// A sale on the till, as the Square import leaves it.
async function sale(on, items, extra) {
  n++;
  extra = extra || {};
  var total = items.reduce(function (a, it) { return a + it[1]; }, 0);
  var id = (await pool.query(
    "INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, payment_method, status, created_at, source, source_name, fulfillment, customer_name, customer_phone, guest_id) " +
    "VALUES ($1,$2,$3,$4,$4,'cash','completed',$5,'square',$6,$7,$8,$9,$10) RETURNING id",
    [co.id, 'ZRC-' + n + '-' + Date.now(), admin.employee.id, total, on + 'T12:' + String(10 + n % 50).padStart(2, '0') + ':00Z',
      extra.source || '', extra.fulfillment || '', extra.customer || '', extra.phone || '', extra.guestId || null])).rows[0].id;
  for (var it of items) await pool.query('INSERT INTO restaurant_order_items (order_id, name, qty, unit_price, line_total) VALUES ($1,$2,1,$3,$3)', [id, it[0], it[1]]);
  return id;
}

async function sheet(rows) {
  var wb = new ExcelJS.Workbook();
  var ws = wb.addWorksheet('BG ORDER RECORD');
  ws.addRow(['MONTH/DATE', 'Month', 'CUSTOMER NAME', 'ORDER DETAILS', 'MODE OF COMMUNICATION', 'MODE OF DELIVERY', 'FEEDBACK', 'Phone Number']);
  rows.forEach(function (r) { ws.addRow([utc(r[0]), Number(r[0].slice(5, 7)), r[1], r[2], r[3], r[4], r[5] === undefined ? null : r[5], r[6] || null]); });
  wb.addWorksheet('Management Dashboard').addRow(['BG ORDERS — MANAGEMENT DASHBOARD']);
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), originalname: 'Zrc orders.xlsx' };
}

test('what the guest said, numbers and names, dishes and menu codes', function () {
  assert.deepEqual(['024 123 4567', '+233 24 123 4567', '241234567', '00233241234567'].map(crm.phoneKey), ['233241234567', '233241234567', '233241234567', '233241234567']);
  assert.equal(crm.nameKey('Madam  Zrc Linda'), crm.nameKey('zrc linda'));
  assert.equal(crm.nameKey('Mr. Zrc Kofi'), 'zrc kofi');

  var portion = crm.feedbackOf('The food was good but the protein was small');
  assert.deepEqual([portion.complaint, portion.themes, portion.praise], [true, ['portion'], false]);
  var wrong = crm.feedbackOf("I asked for spicy noodles but didn't get that");
  assert.ok(wrong.complaint && wrong.themes.indexOf('order') >= 0);
  assert.deepEqual(crm.feedbackOf('Small chops were lovely').themes, [], '"small chops" is a dish, not a small portion');
  assert.equal(crm.feedbackOf('Great service, thank you').complaint, false, 'service praised is not a complaint');
  assert.equal(crm.feedbackOf('', 2).complaint, true, 'a low rating is a complaint');
  assert.equal(crm.feedbackOf('', 5).praise, true);

  // 3/5 typed in the sheet became 5 March; "4 Guests. Table 10 reserved" is a booking.
  assert.equal(crm.feedbackCell(utc('2026-03-05')).rating, 3);
  assert.equal(crm.feedbackCell(utc('2026-08-17')).rating, null, 'a real date is not a rating');
  var booking = crm.feedbackCell('4 Guests. Table 10 reserved ');
  assert.deepEqual([booking.partySize, booking.tableNote, booking.reserved, booking.feedback], [4, 'Table 10', true, '']);
  assert.deepEqual([crm.feedbackCell('4/5 nice').rating, crm.feedbackCell('4/5 nice').feedback], [4, 'nice']);

  var dishes = crm.dishesOf('Z01, 2x Zrc beef noodles, Red bull', { Z01: 'Zrc Assorted Fried Rice' });
  assert.deepEqual(dishes.map(function (d) { return d.key; }), ['zrc assorted fried rice', 'zrc beef noodles', 'red bull']);
  assert.deepEqual(crm.dishesOf('Jollof and chicken, Banku & okro', {}).map(function (d) { return d.key; }), ['jollof and chicken', 'banku okro'], 'a dish with "and" in its name stays one dish');
});

test('the order sheet: read as the sheet means it, guests found, nothing twice', async function () {
  var rows = [
    // newest first, as the sheet is kept
    [day(-2), 'Zrc Kwame', 'Z02, Z03', 'Bolt', 'Delivery', 'The protein was very small', null],
    [day(-3), 'Madam Zrc Ama', 'Zrc assorted fried rice', 'Phone call', 'Pick-up', utc('2026-03-05'), '0205550301'],
    [day(-40), 'Zrc Ama', 'Zrc Assorted Fried Rice, beef sauce', 'Phone call', 'Pick-up', null, null],
    [day(-60), 'Zrc Ama', 'Zrc Assorted Fried Rice', 'WhatsApp', 'Pick-up', 'The protiens were very few', null],
    [day(-61), 'Zrc Efua', 'Reservation', 'WhatsApp', 'Dine-in', '4 Guests. Table 10 reserved ', '205550302'],
    [day(-90), 'Zrc Efua', 'Crazy tuna roll', 'Phone call', 'Dine-in', 'Lovely, thank you', '020 555 0302']
  ];
  var file = await sheet(rows);
  var pv = await crm.importPreview(admin, co.id, file);
  assert.deepEqual([pv.sheet, pv.rows, pv.newOrders, pv.guests, pv.repeatGuests, pv.withPhone], ['BG ORDER RECORD', 6, 6, 3, 2, 2]);
  assert.deepEqual([pv.ratingsFromDates, pv.reservations, pv.partySizes, pv.complaints], [1, 1, 1, 3]);
  assert.deepEqual(pv.channels.map(function (c) { return c.key + ':' + c.orders; }), ['phone:3', 'whatsapp:2', 'bolt:1']);
  await assert.rejects(crm.importPreview(Object.assign({}, admin, { can: function (p) { return p === 'restaurant.read'; } }), co.id, file), /restaurant\.manage/);

  var r = await crm.importRun(admin, co.id, file);
  assert.deepEqual([r.added, r.already, r.newGuests], [6, 0, 3]);
  assert.equal(r.openFollowUps, 2, 'the recent complaint and the recent 3 out of 5 open a follow-up; a months-old complaint is history');
  var ama = (await pool.query("SELECT * FROM restaurant_guests WHERE company_id = $1 AND name_key = 'zrc ama'", [co.id])).rows;
  assert.equal(ama.length, 1, '"Madam Zrc Ama" with a number and "Zrc Ama" without are one guest');
  assert.equal(ama[0].phone, '0205550301');
  var booking = (await pool.query("SELECT * FROM restaurant_guest_orders WHERE company_id = $1 AND service = 'reservation'", [co.id])).rows[0];
  assert.deepEqual([booking.party_size, booking.table_note, booking.items, booking.feedback], [4, 'Table 10', '', '']);
  var rated = (await pool.query('SELECT rating FROM restaurant_guest_orders WHERE company_id = $1 AND rating IS NOT NULL', [co.id])).rows;
  assert.deepEqual(rated.map(function (x) { return x.rating; }), [3]);

  // The same sheet next week, with a new order on top: only that one comes in.
  rows.unshift([day(-1), 'Zrc Ama', 'Z02', 'Phone call', 'Pick-up', null, '0205550301']);
  var again = await crm.importRun(admin, co.id, await sheet(rows));
  assert.deepEqual([again.added, again.already, again.newGuests], [1, 6, 0]);
  await assert.rejects(crm.importPreview(admin, co.id, { buffer: Buffer.from('not a workbook') }), /could not be read/);
});

test('the order log is linked to its sale on the till, and counted once', async function () {
  var on = day(-5);
  var bolt = await sale(on, [['Z02 Zrc Beef Noodles', 90], ['Z03 Zrc Spring Rolls', 40]], { source: 'Bolt Food', fulfillment: 'delivery', customer: 'Zrc Yaw' });
  await sale(on, [['Z02 Zrc Beef Noodles', 90]], { fulfillment: 'pickup' });
  var o = await crm.createOrder(admin, { companyId: co.id, guest: { name: 'Zrc Yaw', phone: '020 555 0303' }, orderedOn: on, channel: 'bolt', service: 'delivery', items: 'Beef noodles, spring rolls' });
  assert.equal(o.till && o.till.id, bolt, 'the Bolt sale of that day, not the pick-up with the same noodles');
  assert.deepEqual([o.amount, o.amountFromTill, o.till.link], [130, true, 'auto']);
  assert.equal((await pool.query('SELECT guest_id FROM restaurant_orders WHERE id = $1', [bolt])).rows[0].guest_id, o.guest.id, 'the sale is now on the guest');

  // Two sales that fit as well as each other: left for staff to choose.
  var on2 = day(-6);
  var s1 = await sale(on2, [['Z01 Zrc Assorted Fried Rice', 79]]);
  var s2 = await sale(on2, [['Z01 Zrc Assorted Fried Rice', 79]]);
  var o2 = await crm.createOrder(admin, { companyId: co.id, guest: { name: 'Zrc Esi' }, orderedOn: on2, channel: 'phone', service: 'pickup', items: 'Z01' });
  assert.equal(o2.till, null);
  var choices = await crm.tillCandidates(admin, o2.id);
  assert.deepEqual(choices.slice(0, 2).map(function (c) { return c.id; }).sort(), [s1, s2].sort());
  var linked = await crm.linkTill(admin, o2.id, { tillOrderId: s2 });
  assert.deepEqual([linked.till.id, linked.till.link], [s2, 'staff']);
  await assert.rejects(crm.linkTill(admin, o.id, { tillOrderId: s2 }), /already linked/);
  var none = await crm.linkTill(admin, o2.id, { tillOrderId: null });
  assert.deepEqual([none.till, none.tillLink], [null, 'none']);
  assert.equal(await crm.autoLink(co.id, { ids: [o2.id] }), 0, 'staff said there is no sale: the OS does not link it again');

  // In the figures: the linked Bolt sale once, with its amount; a sale with a
  // guest and no logged order counts on its own.
  var yaw = o.guest.id;
  await sale(day(-4), [['Z01 Zrc Assorted Fried Rice', 79]], { guestId: yaw });
  var g = await crm.getGuest(admin, yaw);
  assert.equal(g.orders, 2);
  assert.equal(g.amount, 209);
  assert.deepEqual(g.timeline.map(function (t) { return t.kind; }).sort(), ['log', 'till']);
});

test('feedback, follow-ups and the overview', async function () {
  var open = (await crm.listOrders(admin, { companyId: co.id, followUp: 'open' })).orders;
  assert.equal(open.length, 2);
  assert.deepEqual(open.map(function (x) { return x.rating || x.themes[0]; }), ['portion', 3]);
  await assert.rejects(crm.setFollowUp(admin, open[0].id, { status: 'done' }), /Write what was done/);
  var done = await crm.setFollowUp(admin, open[0].id, { status: 'done', note: 'Zrc called him; extra protein next time' });
  assert.deepEqual([done.followUp, done.followedUpByName !== null], ['done', true]);

  // A new complaint by hand opens one; correcting it closes it again.
  var c = await crm.createOrder(admin, { companyId: co.id, guest: { name: 'Zrc Kwame' }, orderedOn: day(0), channel: 'whatsapp', service: 'pickup', items: 'Z01', feedback: 'Came cold and too late' });
  assert.deepEqual([c.followUp, c.themes.sort()], ['open', ['taste', 'wait']]);
  var fixed = await crm.updateOrder(admin, c.id, { feedback: 'Lovely, thanks' });
  assert.equal(fixed.followUp, 'none');
  await assert.rejects(crm.createOrder(admin, { companyId: co.id, guest: { name: 'Zrc X' }, orderedOn: day(1), items: 'Z01' }), /future/);
  await assert.rejects(crm.createOrder(admin, { companyId: co.id, orderedOn: day(0), items: 'Z01' }), /Choose the guest/);
  await assert.rejects(crm.createOrder(admin, { companyId: co.id, guest: { name: 'Zrc X' }, items: 'Z01', rating: 7 }), /1 to 5/);

  var ov = await crm.overview(admin, { companyId: co.id, range: '365' });
  var t = ov.totals;
  assert.equal(t.orders, 11, '7 from the sheet, 2 logged by hand, 1 more by hand and 1 sale with a guest — the linked Bolt sale once');
  assert.equal(t.guests, 5, 'Kwame, Ama, Efua, Yaw and Esi — Kwame typed again is the same guest');
  assert.ok(t.repeatGuests >= 3);
  assert.equal(t.linkedToTill, 1);
  assert.equal(t.amount, 209);
  assert.equal(t.openFollowUps, 1, 'the 3 out of 5 is still to call back');
  assert.ok(ov.channels.some(function (x) { return x.key === 'bolt' && x.orders === 2; }));
  assert.ok(ov.dishes[0].orders >= 4 && /fried rice/i.test(ov.dishes[0].name), 'Z01 and "assorted fried rice" are one dish');
  assert.ok(ov.themes.some(function (x) { return x.key === 'portion' && x.count === 2; }));
  assert.equal(ov.months.reduce(function (a, m) { return a + m.orders; }, 0), t.orders);
  var month = await crm.overview(admin, { companyId: co.id, range: '30' });
  assert.ok(month.totals.orders < t.orders && month.totals.newGuests <= month.totals.guests);
  await assert.rejects(crm.overview(Object.assign({}, admin, { can: function () { return false; } }), { companyId: co.id }), /restaurant\.read/);
});

test('guests: where each stands, the same guest twice put together', async function () {
  // A regular who stopped: 4 orders a week apart, the last 50 days ago.
  for (var i = 0; i < 4; i++) await crm.createOrder(admin, { companyId: co.id, guest: { name: 'Zrc Nana', phone: '0205550309' }, orderedOn: day(-50 - 7 * i), channel: 'phone', service: 'pickup', items: 'Z02' });
  var list = await crm.listGuests(admin, { companyId: co.id });
  var nana = list.guests.find(function (g) { return g.name === 'Zrc Nana'; });
  assert.deepEqual([nana.segment, nana.orders, nana.avgGap, nana.favourite], ['quiet', 4, 7, 'Zrc Beef Noodles']);
  assert.equal(list.counts.quiet, 1);
  var ov = await crm.overview(admin, { companyId: co.id });
  assert.equal(ov.quiet[0].name, 'Zrc Nana', 'on the list to invite back');

  // Typed in again on the till under another form of her number and name.
  var twin = (await pool.query("INSERT INTO restaurant_guests (company_id, name, phone) VALUES ($1, 'Auntie Zrc Nana', '+233 20 555 0309') RETURNING id", [co.id])).rows[0].id;
  await sale(day(-2), [['Z03 Zrc Spring Rolls', 40]], { guestId: twin });
  var d = await crm.duplicates(admin, { companyId: co.id });
  var pair = d.find(function (x) { return x.a.id === twin || x.b.id === twin; });
  assert.equal(pair.reason, 'phone');
  var kept = await crm.mergeGuests(admin, { keepId: nana.id, dropId: twin });
  assert.equal(kept.orders, 5);
  assert.equal(kept.segment, 'regular', 'ordering again: no longer quiet');
  assert.equal((await pool.query('SELECT 1 FROM restaurant_guests WHERE id = $1', [twin])).rows.length, 0);
  await assert.rejects(crm.mergeGuests(admin, { keepId: nana.id, dropId: nana.id }), /Choose the two guests/);
});

test('Square: the customer on a sale becomes the guest; a number on a delivery finds them', async function () {
  var cashier = await squareImport.ensureImportCashier(co);
  var customers = { 'sq-zrc-1': { id: 'sq-zrc-1', given_name: 'Zrc', family_name: 'Abena', phone_number: '+233205550311' } };
  var cache = {};
  function order(id, extra) {
    return Object.assign({ id: id, created_at: day(-1) + 'T13:00:00Z', total_money: { amount: 7900, currency: 'GHS' }, line_items: [{ name: 'Z01 Zrc Assorted Fried Rice', quantity: '1', total_money: { amount: 7900 } }] }, extra);
  }
  var o1 = order('zrc-sq-1', { customer_id: 'sq-zrc-1', source: { name: 'Bolt Food' }, fulfillments: [{ type: 'DELIVERY', delivery_details: { recipient: { display_name: 'Abena Z.' } } }] });
  var meta = squareImport.orderMeta(o1);
  assert.deepEqual([meta.sourceName, meta.fulfillment, meta.customerName, meta.squareCustomerId], ['Bolt Food', 'delivery', 'Abena Z.', 'sq-zrc-1']);
  var g1 = await squareImport.guestForOrder(co, meta, customers, cache);
  var id1 = await squareImport.upsertOrder(admin, co, o1, cashier, {}, {}, true, g1);
  var g2 = await squareImport.guestForOrder(co, squareImport.orderMeta(order('zrc-sq-2', { customer_id: 'sq-zrc-1' })), customers, {});
  assert.equal(g2, g1, 'the same Square customer is the same guest');
  var guest = (await pool.query('SELECT * FROM restaurant_guests WHERE id = $1', [g1])).rows[0];
  assert.deepEqual([guest.name, guest.source, guest.square_customer_id], ['Zrc Abena', 'square', 'sq-zrc-1']);
  var saved = (await pool.query('SELECT source_name, fulfillment, guest_id FROM restaurant_orders WHERE id = $1', [id1])).rows[0];
  assert.deepEqual([saved.source_name, saved.fulfillment, saved.guest_id], ['Bolt Food', 'delivery', g1]);

  // No customer, but the pick-up has Zrc Ama's number in another form.
  var ama = (await pool.query("SELECT id FROM restaurant_guests WHERE company_id = $1 AND name_key = 'zrc ama'", [co.id])).rows[0].id;
  var o3 = order('zrc-sq-3', { fulfillments: [{ type: 'PICKUP', pickup_details: { recipient: { display_name: 'Ama', phone_number: '+233 20 555 0301' } } }] });
  assert.equal(await squareImport.guestForOrder(co, squareImport.orderMeta(o3), customers, {}), ama);
  // A name alone is not enough.
  var o4 = order('zrc-sq-4', { fulfillments: [{ type: 'PICKUP', pickup_details: { recipient: { display_name: 'Zrc Ama' } } }] });
  assert.equal(await squareImport.guestForOrder(co, squareImport.orderMeta(o4), customers, {}), null);

  // Imported again: a guest already set on the sale stays.
  await pool.query('UPDATE restaurant_orders SET guest_id = $2 WHERE id = $1', [id1, ama]);
  await squareImport.upsertOrder(admin, co, o1, cashier, {}, {}, true, g1);
  assert.equal((await pool.query('SELECT guest_id FROM restaurant_orders WHERE id = $1', [id1])).rows[0].guest_id, ama);
});

test('another restaurant (a Star Bar): its own sheet layout, its own guests', async function () {
  var star = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZRS', 'Zrs Star Bar') RETURNING *")).rows[0];
  var wb = new ExcelJS.Workbook();
  var ws = wb.addWorksheet('Zrs orders');
  ws.addRow(['Zrs Star Bar — orders']);
  ws.addRow(['Date', 'Client Name', 'Order', 'Channel', 'Type', 'Comment', 'Contact']);
  ws.addRow([utc(day(-3)), 'Zrs Kojo', 'Grilled tilapia, 2x Club beer', 'WhatsApp', 'Dine in', '5 people, table 3 booked', '0205550501']);
  ws.addRow([day(-2).split('-').reverse().join('/'), 'Zrs Kojo', 'Jollof and chicken', 'Phone', 'Takeaway', 'Too salty', '+233 20 555 0501']);
  ws.addRow([utc(day(-1)), 'Zrc Ama', 'Fried yam', 'Walk-in', 'Dine in', null, '0205550301']);
  var r = await crm.importRun(admin, star.id, { buffer: Buffer.from(await wb.xlsx.writeBuffer()) });
  assert.deepEqual([r.added, r.newGuests], [3, 2], 'headings in another order and words; a date typed as day/month/year');
  var kojo = (await crm.listGuests(admin, { companyId: star.id, q: 'Zrs Kojo' })).guests[0];
  assert.equal(kojo.orders, 2, 'his two orders, the number typed two ways');
  var rows = (await pool.query("SELECT service, party_size, table_note, feedback FROM restaurant_guest_orders WHERE company_id = $1 ORDER BY ordered_on", [star.id])).rows;
  assert.deepEqual(rows.map(function (x) { return x.service; }), ['reservation', 'pickup', 'dine_in']);
  assert.deepEqual([rows[0].party_size, rows[0].table_note, rows[1].feedback], [5, 'Table 3', 'Too salty']);
  // Zrc Ama of the other restaurant is not this one's guest: each restaurant keeps its own.
  var ama = (await pool.query("SELECT company_id FROM restaurant_guests WHERE phone_key = '233205550301' ORDER BY created_at")).rows;
  assert.deepEqual(ama.map(function (x) { return x.company_id; }).sort(), [co.id, star.id].sort());
  var ov = await crm.overview(admin, { companyId: star.id, range: '30' });
  assert.deepEqual([ov.totals.orders, ov.totals.guests, ov.totals.complaints], [3, 2, 1]);
  assert.equal((await crm.listOrders(admin, { companyId: co.id, q: 'tilapia' })).total, 0, 'nothing of it at the other restaurant');
});
